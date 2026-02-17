"""
ProtocolInstance — interprets one IRGraph state machine for a single protocol instance.

Each instance has its own ctx and walks the state machine by:
  - Executing zone code at action/send/receive states
  - Publishing messages via NATS
  - Waiting for incoming messages (dispatched by AgentRunner)
"""

from __future__ import annotations
import asyncio
from typing import Any, Callable, Optional

from .types import (
    create_message_envelope,
    create_trace_event,
    msg_subject,
    trace_subject,
)
from .zone_executor import execute_zone, ReagentStub
from .nats_transport import NatsTransport


class ProtocolInstance:
    def __init__(
        self,
        graph: dict[str, Any],
        transport: NatsTransport,
        self_state: dict[str, Any],
        config: dict[str, Any],
    ) -> None:
        self.instance_id: str = config["instanceId"]
        self.protocol_name: str = config["protocolName"]
        self.agent_name: str = config["agentName"]
        self.role_name: str = config["roleName"]
        self.role_to_agent: dict[str, str] = config["roleToAgent"]

        self._graph = graph
        self._transport = transport
        self._self_ref = self_state
        self._config = config

        self._ctx: dict[str, Any] = {}
        if "input" in config and config["input"]:
            self._ctx["input"] = config["input"]

        self._reagent = ReagentStub()
        self._current_state_id: str = graph["initialStateId"]

        self._state_map: dict[str, dict[str, Any]] = {}
        for s in graph["states"]:
            self._state_map[s["id"]] = s

        self._transitions_from: dict[str, list[dict[str, Any]]] = {}
        for t in graph["transitions"]:
            self._transitions_from.setdefault(t["from"], []).append(t)

        self._status: str = "running"
        self._message_resolvers: dict[str, asyncio.Future] = {}
        self._xor_resolvers: dict[str, list[dict[str, Any]]] = {}
        self._on_complete: Optional[Callable[[str], None]] = None
        self._traces: list[dict[str, Any]] = []

    @property
    def status(self) -> str:
        return self._status

    @property
    def traces(self) -> list[dict[str, Any]]:
        return self._traces

    def set_on_complete(self, cb: Callable[[str], None]) -> None:
        self._on_complete = cb

    def dispatch_message(self, env: dict[str, Any]) -> None:
        """Called by AgentRunner when a message arrives for this instance."""
        msg_name = env["messageName"]

        # Check XOR resolvers
        for guard_id, resolvers in list(self._xor_resolvers.items()):
            for r in resolvers:
                if r["messageName"] == msg_name:
                    del self._xor_resolvers[guard_id]
                    r["future"].set_result(env)
                    return

        # Check single-message resolvers
        fut = self._message_resolvers.pop(msg_name, None)
        if fut and not fut.done():
            fut.set_result(env)

    async def run(self) -> None:
        """Start walking the state machine."""
        try:
            self._emit_trace("ProtocolStarted", {"protocolName": self.protocol_name})
            await self._advance()
        except Exception as e:
            print(f"[instance {self.instance_id}] Fatal error: {e}")
            self._status = "failed"
            self._emit_trace("ProtocolFailed", {"error": str(e)})
            if self._on_complete:
                self._on_complete("failed")

    async def _advance(self) -> None:
        while self._status == "running":
            state = self._state_map.get(self._current_state_id)
            if not state:
                raise RuntimeError(f"State {self._current_state_id} not found")

            kind = state["data"]["kind"]

            if kind == "initial":
                self._current_state_id = self._follow_default()
            elif kind == "send":
                await self._handle_send(state)
                self._current_state_id = self._follow_default()
            elif kind == "receive":
                await self._handle_receive(state)
                self._current_state_id = self._follow_default()
            elif kind == "action":
                self._handle_action(state)
                self._current_state_id = self._follow_default()
            elif kind == "guard":
                await self._handle_guard(state)
            elif kind == "terminal":
                status_val = state["data"].get("status", "completed")
                self._status = "completed" if status_val == "completed" else "failed"
                trace_kind = "ProtocolCompleted" if self._status == "completed" else "ProtocolFailed"
                self._emit_trace(trace_kind, {"protocolName": self.protocol_name})
                if self._on_complete:
                    self._on_complete(self._status)
                return
            else:
                print(f"[instance] Unsupported state kind: {kind}, skipping")
                self._current_state_id = self._follow_default()

    async def _handle_send(self, state: dict[str, Any]) -> None:
        data = state["data"]
        self._ctx["msg"] = {}

        if data.get("preSendZone"):
            self._emit_trace("ActionStarted", {"stateId": state["id"], "zone": "preSend"})
            execute_zone(data["preSendZone"], self._ctx, self._self_ref, self._reagent)
            self._emit_trace("ActionFinished", {"stateId": state["id"], "zone": "preSend"})

        payload = self._ctx.get("msg", {})

        to_key = f"{self.protocol_name}.{data['to']}"
        to_agent = self.role_to_agent.get(to_key)
        if not to_agent:
            raise RuntimeError(f"Cannot resolve agent for role {data['to']} in protocol {self.protocol_name}")

        env = create_message_envelope(
            self.instance_id,
            self.protocol_name,
            self.agent_name,
            self.role_name,
            to_agent,
            data["to"],
            data["messageName"],
            payload,
        )

        self._emit_trace("MessageSent", {
            "messageName": data["messageName"],
            "to": to_agent,
            "toRole": data["to"],
        })

        await self._transport.publish_async(
            msg_subject(self.instance_id, to_agent, data["messageName"]),
            env,
        )

        self._ctx.pop("msg", None)

    async def _handle_receive(self, state: dict[str, Any]) -> None:
        data = state["data"]
        env = await self._wait_for_message(data["messageName"])

        self._emit_trace("MessageReceived", {
            "messageName": data["messageName"],
            "from": env["from"]["agent"],
            "fromRole": env["from"]["role"],
        })

        self._ctx["msg"] = env["payload"]

        if data.get("postReceiveZone"):
            self._emit_trace("ActionStarted", {"stateId": state["id"], "zone": "postReceive"})
            execute_zone(data["postReceiveZone"], self._ctx, self._self_ref, self._reagent)
            self._emit_trace("ActionFinished", {"stateId": state["id"], "zone": "postReceive"})

        self._ctx.pop("msg", None)

    def _handle_action(self, state: dict[str, Any]) -> None:
        data = state["data"]
        self._emit_trace("ActionStarted", {"stateId": state["id"]})
        execute_zone(data["body"], self._ctx, self._self_ref, self._reagent)
        self._emit_trace("ActionFinished", {"stateId": state["id"]})

    async def _handle_guard(self, state: dict[str, Any]) -> None:
        data = state["data"]
        transitions = self._transitions_from.get(state["id"], [])

        if data.get("guardType") == "xor":
            expr_trans = [t for t in transitions if t["label"]["kind"] == "expression"]
            else_trans = next((t for t in transitions if t["label"]["kind"] == "else"), None)
            msg_trans = [t for t in transitions if t["label"]["kind"] == "message"]

            if expr_trans:
                any_eval_succeeded = False
                for t in expr_trans:
                    expr = t["label"]["expr"]
                    try:
                        result = self._eval_expr(expr)
                        any_eval_succeeded = True
                        if result:
                            self._emit_trace("GuardEvaluated", {"expr": expr, "result": True})
                            self._current_state_id = t["to"]
                            await self._advance()
                            return
                    except Exception:
                        pass

                if any_eval_succeeded:
                    if else_trans:
                        self._emit_trace("GuardEvaluated", {"branch": "else"})
                        self._current_state_id = else_trans["to"]
                        await self._advance()
                        return
                    raise RuntimeError(f"No matching branch in XOR guard {state['id']}")

                # Expressions ALL failed (non-deciding agent).
                # Fall through to message-based waiting.
                recv_expectations = []
                all_branch_starts = [t["to"] for t in expr_trans]
                if else_trans:
                    all_branch_starts.append(else_trans["to"])

                for branch_start_id in all_branch_starts:
                    recv_id = self._find_first_receive_in_branch(branch_start_id)
                    if recv_id:
                        recv_state = self._state_map.get(recv_id)
                        if recv_state and recv_state["data"]["kind"] == "receive":
                            recv_expectations.append({
                                "messageName": recv_state["data"]["messageName"],
                                "targetStateId": recv_id,
                            })

                if recv_expectations:
                    self._emit_trace("GuardEvaluated", {"mode": "message-wait-fallback"})
                    result = await self._wait_for_any_message(state["id"], recv_expectations)
                    self._ctx["msg"] = result["env"]["payload"]

                    recv_state = self._state_map.get(result["targetStateId"])
                    if recv_state and recv_state["data"]["kind"] == "receive":
                        post_zone = recv_state["data"].get("postReceiveZone")
                        if post_zone:
                            self._emit_trace("ActionStarted", {"stateId": result["targetStateId"], "zone": "postReceive"})
                            execute_zone(post_zone, self._ctx, self._self_ref, self._reagent)
                            self._emit_trace("ActionFinished", {"stateId": result["targetStateId"], "zone": "postReceive"})
                    self._ctx.pop("msg", None)
                    self._current_state_id = result["targetStateId"]
                    self._current_state_id = self._follow_default()
                    await self._advance()
                    return

                raise RuntimeError(f"No matching branch in XOR guard {state['id']}")

            if msg_trans:
                result = await self._wait_for_any_message(
                    state["id"],
                    [{"messageName": t["label"]["messageName"], "targetStateId": t["to"]} for t in msg_trans],
                )
                self._ctx["msg"] = result["env"]["payload"]
                self._current_state_id = result["targetStateId"]
                await self._advance()
                return

            if transitions:
                self._current_state_id = transitions[0]["to"]
            await self._advance()
            return

        if data.get("guardType") == "expression" and data.get("expr"):
            try:
                result = self._eval_expr(data["expr"])
                if result:
                    default_t = next(
                        (t for t in transitions if t["label"]["kind"] in ("default", "expression")),
                        None,
                    )
                    if default_t:
                        self._current_state_id = default_t["to"]
                        return
            except Exception:
                pass
            else_t = next((t for t in transitions if t["label"]["kind"] == "else"), None)
            if else_t:
                self._current_state_id = else_t["to"]
                return

        self._current_state_id = self._follow_default()

    def _eval_expr(self, expr: str) -> Any:
        """Evaluate a guard expression with $ctx and $self in scope."""
        import re
        translated = re.sub(r'\$ctx\b', 'ctx', expr)
        translated = re.sub(r'\$self\b', 'self_state', translated)
        return eval(translated, {"__builtins__": {}}, {
            "ctx": self._ctx,
            "self_state": self._self_ref,
        })

    def _find_first_receive_in_branch(self, state_id: str) -> str | None:
        """Walk from a branch start state looking for the first receive state."""
        current = state_id
        visited: set[str] = set()
        while current not in visited:
            visited.add(current)
            st = self._state_map.get(current)
            if not st:
                return None
            if st["data"]["kind"] == "receive":
                return current
            trans = self._transitions_from.get(current, [])
            default = next((t for t in trans if t["label"]["kind"] == "default"), None)
            if default:
                current = default["to"]
            else:
                return None
        return None

    def _follow_default(self) -> str:
        transitions = self._transitions_from.get(self._current_state_id, [])
        default = next((t for t in transitions if t["label"]["kind"] == "default"), None)
        if default:
            return default["to"]
        if transitions:
            return transitions[0]["to"]
        raise RuntimeError(f"No outgoing transition from state {self._current_state_id}")

    def _wait_for_message(self, message_name: str) -> asyncio.Future:
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self._message_resolvers[message_name] = fut
        return fut

    def _wait_for_any_message(
        self, guard_id: str, expectations: list[dict[str, Any]]
    ) -> asyncio.Future:
        loop = asyncio.get_event_loop()
        result_fut: asyncio.Future = loop.create_future()
        resolvers = []
        for e in expectations:
            per_msg_fut: asyncio.Future = loop.create_future()

            def _make_cb(target_id: str, f: asyncio.Future) -> Callable:
                def _cb(env: dict[str, Any]) -> None:
                    if not result_fut.done():
                        result_fut.set_result({"env": env, "targetStateId": target_id})
                return _cb

            per_msg_fut.add_done_callback(
                lambda f, tid=e["targetStateId"]: (
                    result_fut.set_result({"env": f.result(), "targetStateId": tid})
                    if not result_fut.done() else None
                )
            )
            resolvers.append({
                "messageName": e["messageName"],
                "future": per_msg_fut,
            })
        self._xor_resolvers[guard_id] = resolvers
        return result_fut

    def _emit_trace(self, kind: str, data: dict[str, Any] | None = None) -> None:
        te = create_trace_event(
            self.instance_id,
            kind,
            self.agent_name,
            role=self.role_name,
            protocol_name=self.protocol_name,
            data=data,
        )
        self._traces.append(te)
        self._transport.publish(trace_subject(self.instance_id), te)
