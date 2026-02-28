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
from .zone_executor import execute_zone, execute_zone_async, ReagentStub, InvokeRequest, ReturnValue, BreakRequest, AttrDict


class ProtocolInstance:
    def __init__(
        self,
        graph: dict[str, Any],
        transport: Any,
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
        self._message_resolvers: dict[str, list[asyncio.Future]] = {}
        self._xor_resolvers: dict[str, list[dict[str, Any]]] = {}
        self._message_inbox: list[dict[str, Any]] = []
        self._on_complete: Optional[Callable[[str], None]] = None
        self._traces: list[dict[str, Any]] = []

        # Try/catch: map try-entry state ID → catch target state ID
        self._try_catch_map: dict[str, str] = {}
        for t in graph["transitions"]:
            if t["label"]["kind"] == "error":
                self._try_catch_map[t["from"]] = t["to"]
        self._catch_stack: list[str] = []

        # Invoke/return/spawn/emit support
        self._invoke_callback: Optional[Callable] = None
        self._spawn_callback: Optional[Callable] = None
        self._emit_callback: Optional[Callable] = None
        self._return_value: Any = None
        self._has_return_value: bool = False

        # Native module extras ($agent binding)
        self._extras: Optional[dict[str, Any]] = config.get("extras")

        # Debug advance hook: optional async callable invoked before each state
        self._advance_hook: Optional[Callable] = config.get("advanceHook")

    @property
    def status(self) -> str:
        return self._status

    @property
    def traces(self) -> list[dict[str, Any]]:
        return self._traces

    def _zone_extras(self) -> Optional[dict[str, Any]]:
        if not self._extras:
            return None
        agent_obj = AttrDict(self._extras) if isinstance(self._extras, dict) else self._extras
        return {"agent": agent_obj}

    def set_on_complete(self, cb: Callable[[str], None]) -> None:
        self._on_complete = cb

    def set_invoke_callback(self, cb: Callable) -> None:
        self._invoke_callback = cb

    def set_spawn_callback(self, cb: Callable) -> None:
        self._spawn_callback = cb
        self._reagent.spawn = lambda proto=None, args=None: self._handle_spawn(proto, args)

    def set_emit_callback(self, cb: Callable) -> None:
        self._emit_callback = cb
        self._reagent.emit = lambda event_name, data=None: self._handle_emit(event_name, data)

    def _handle_spawn(self, proto: Any, args: Any) -> None:
        if self._spawn_callback:
            self._spawn_callback(str(proto), args)
        self._emit_trace("Spawned", {"protoName": str(proto)})

    def _handle_emit(self, event_name: str, data: Any) -> None:
        if self._emit_callback:
            self._emit_callback(event_name, data)
        self._emit_trace("EventEmitted", {"eventName": event_name, "data": data})

    def get_return_value(self) -> tuple[Any, bool]:
        return (self._return_value, self._has_return_value)

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

        # Check single-message resolvers (queue of futures per message name)
        queue = self._message_resolvers.get(msg_name)
        if queue:
            fut = queue.pop(0)
            if not queue:
                del self._message_resolvers[msg_name]
            if not fut.done():
                fut.set_result(env)
                return

        # Buffer for later — the receive state may not have registered yet
        self._message_inbox.append(env)

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

            if self._advance_hook:
                await self._advance_hook({
                    "instanceId": self.instance_id,
                    "agentName": self.agent_name,
                    "stateId": state["id"],
                    "stateKind": kind,
                    "protocolName": self.protocol_name,
                    "roleName": self.role_name,
                    "ctx": dict(self._ctx),
                    "self": dict(self._self_ref),
                })

            # Track try/catch scopes
            catch_target = self._try_catch_map.get(state["id"])
            if catch_target:
                self._catch_stack.append(catch_target)
            if kind == "error":
                if self._catch_stack:
                    self._catch_stack.pop()

            try:
                if kind == "initial":
                    self._current_state_id = self._follow_default()
                elif kind == "send":
                    await self._handle_send(state)
                    self._current_state_id = self._follow_default()
                elif kind == "receive":
                    error_recv = self._find_alternate_error_receive(state)
                    if error_recv:
                        await self._handle_receive_with_error_fallback(state, error_recv)
                    else:
                        await self._handle_receive(state)
                        self._current_state_id = self._follow_default()
                elif kind == "action":
                    await self._handle_action(state)
                    self._current_state_id = self._follow_default()
                elif kind == "guard":
                    await self._handle_guard(state)
                elif kind == "timer":
                    await self._handle_timer(state)
                    self._current_state_id = self._follow_default()
                elif kind == "fork":
                    await self._handle_fork(state)
                elif kind == "join":
                    self._current_state_id = self._follow_default()
                elif kind == "error":
                    self._current_state_id = self._follow_default()
                elif kind == "invoke":
                    await self._handle_invoke(state)
                    self._current_state_id = self._follow_default()
                elif kind == "async_invoke":
                    await self._handle_async_invoke_state(state)
                    self._current_state_id = self._follow_default()
                elif kind == "spawn":
                    await self._handle_spawn_state(state)
                    self._current_state_id = self._follow_default()
                elif kind == "scatter":
                    await self._handle_scatter(state)
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
            except BreakRequest:
                self._emit_trace("ActionFinished", {"stateId": state["id"], "breakRequested": True})
                exit_id = self._find_loop_exit(state["id"])
                if exit_id:
                    self._current_state_id = exit_id
                    continue
                raise RuntimeError("reagent.break() called outside of a loop")
            except ReturnValue as rv:
                self._return_value = rv.value
                self._has_return_value = True
                self._status = "completed"
                self._emit_trace("ProtocolCompleted", {"protocolName": self.protocol_name, "returned": True})
                if self._on_complete:
                    self._on_complete("completed")
                return
            except Exception as err:
                if self._catch_stack:
                    catch_id = self._catch_stack.pop()
                    self._emit_trace("ErrorCaught", {
                        "stateId": state["id"],
                        "error": str(err),
                        "catchStateId": catch_id,
                    })
                    self._ctx["error"] = str(err)
                    self._current_state_id = catch_id
                else:
                    raise

    async def _handle_send(self, state: dict[str, Any]) -> None:
        data = state["data"]
        self._ctx["msg"] = {}

        if data.get("preSendZone"):
            self._emit_trace("ActionStarted", {"stateId": state["id"], "zone": "preSend"})
            if data.get("preSendAsync"):
                await execute_zone_async(data["preSendZone"], self._ctx, self._self_ref, self._reagent, self._zone_extras())
            else:
                execute_zone(data["preSendZone"], self._ctx, self._self_ref, self._reagent, self._zone_extras())
            self._emit_trace("ActionFinished", {"stateId": state["id"], "zone": "preSend"})

        payload = self._ctx.get("msg", {})

        to_key = f"{self.protocol_name}.{data['to']}"
        scatter_item = self._ctx.get("_scatterItem")
        if scatter_item is not None and isinstance(scatter_item, str) and scatter_item != self.agent_name:
            to_agent = scatter_item
        else:
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
            if data.get("postReceiveAsync"):
                await execute_zone_async(data["postReceiveZone"], self._ctx, self._self_ref, self._reagent, self._zone_extras())
            else:
                execute_zone(data["postReceiveZone"], self._ctx, self._self_ref, self._reagent, self._zone_extras())
            self._emit_trace("ActionFinished", {"stateId": state["id"], "zone": "postReceive"})

        self._ctx.pop("msg", None)

    async def _handle_action(self, state: dict[str, Any]) -> None:
        data = state["data"]
        self._emit_trace("ActionStarted", {"stateId": state["id"]})
        try:
            if data.get("async"):
                await execute_zone_async(data["body"], self._ctx, self._self_ref, self._reagent, self._zone_extras())
            else:
                execute_zone(data["body"], self._ctx, self._self_ref, self._reagent, self._zone_extras())
        except ReturnValue as rv:
            self._return_value = rv.value
            self._has_return_value = True
            self._emit_trace("ActionFinished", {"stateId": state["id"], "returnValue": True})
            return
        except BreakRequest:
            raise
        except InvokeRequest as ir:
            if not self._invoke_callback:
                raise RuntimeError("reagent.invoke() called but no invoke_callback set")
            result = await self._invoke_callback(ir.proto_name, ir.input_data)
            cached_reagent = ReagentStub()
            cached_reagent.invoke = lambda proto=None, args=None: result
            execute_zone(data["body"], self._ctx, self._self_ref, cached_reagent, self._zone_extras())
            self._emit_trace("ActionFinished", {"stateId": state["id"], "invoked": ir.proto_name})
            return
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

                    env = result["env"]
                    self._emit_trace("MessageReceived", {
                        "messageName": env["messageName"],
                        "from": env["from"]["agent"],
                        "fromRole": env["from"]["role"],
                    })

                    self._ctx["msg"] = result["env"]["payload"]

                    recv_state = self._state_map.get(result["targetStateId"])
                    if recv_state and recv_state["data"]["kind"] == "receive":
                        post_zone = recv_state["data"].get("postReceiveZone")
                        if post_zone:
                            self._emit_trace("ActionStarted", {"stateId": result["targetStateId"], "zone": "postReceive"})
                            execute_zone(post_zone, self._ctx, self._self_ref, self._reagent, self._zone_extras())
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
            default_t = next(
                (t for t in transitions if t["label"]["kind"] in ("default", "expression")),
                None,
            )
            else_t = next((t for t in transitions if t["label"]["kind"] == "else"), None)

            eval_succeeded = False
            can_decide = _expression_vars_are_defined(data["expr"], self._ctx, self._self_ref)

            if can_decide:
                try:
                    result = self._eval_expr(data["expr"])
                    eval_succeeded = True
                    if result:
                        if default_t:
                            self._current_state_id = default_t["to"]
                            return
                    else:
                        if else_t:
                            self._current_state_id = else_t["to"]
                            return
                except Exception:
                    pass

            if not eval_succeeded and default_t and else_t:
                recv_expectations = []
                for branch in [
                    {"id": "body", "startId": default_t["to"]},
                    {"id": "exit", "startId": else_t["to"]},
                ]:
                    recv_id = self._find_first_receive_in_branch(branch["startId"])
                    if recv_id:
                        recv_state = self._state_map.get(recv_id)
                        if recv_state and recv_state["data"]["kind"] == "receive":
                            recv_expectations.append({
                                "messageName": recv_state["data"]["messageName"],
                                "targetStateId": recv_id,
                            })

                if recv_expectations:
                    self._emit_trace("GuardEvaluated", {"mode": "loop-message-wait-fallback", "expr": data["expr"]})
                    result = await self._wait_for_any_message(state["id"], recv_expectations)

                    env = result["env"]
                    self._emit_trace("MessageReceived", {
                        "messageName": env["messageName"],
                        "from": env["from"]["agent"],
                        "fromRole": env["from"]["role"],
                    })

                    self._ctx["msg"] = result["env"]["payload"]

                    recv_state = self._state_map.get(result["targetStateId"])
                    if recv_state and recv_state["data"]["kind"] == "receive":
                        post_zone = recv_state["data"].get("postReceiveZone")
                        if post_zone:
                            self._emit_trace("ActionStarted", {"stateId": result["targetStateId"], "zone": "postReceive"})
                            execute_zone(post_zone, self._ctx, self._self_ref, self._reagent, self._zone_extras())
                            self._emit_trace("ActionFinished", {"stateId": result["targetStateId"], "zone": "postReceive"})
                    self._ctx.pop("msg", None)

                    self._current_state_id = result["targetStateId"]
                    self._current_state_id = self._follow_default()
                    await self._advance()
                    return

            if else_t:
                self._current_state_id = else_t["to"]
                return

        self._current_state_id = self._follow_default()

    def _find_alternate_error_receive(self, current_recv_state: dict[str, Any]) -> dict[str, Any] | None:
        if not self._catch_stack:
            return None
        for try_entry_id, catch_target_id in self._try_catch_map.items():
            try_default_recv_id = self._find_first_receive_in_branch(try_entry_id)
            if try_default_recv_id != current_recv_state["id"]:
                continue
            error_recv_id = self._find_first_receive_in_branch(catch_target_id)
            if error_recv_id:
                error_recv_state = self._state_map.get(error_recv_id)
                if error_recv_state and error_recv_state["data"]["kind"] == "receive":
                    return {"stateId": error_recv_id, "messageName": error_recv_state["data"]["messageName"]}
        return None

    async def _handle_receive_with_error_fallback(
        self, normal_recv_state: dict[str, Any], error_recv: dict[str, Any]
    ) -> None:
        normal_data = normal_recv_state["data"]
        expectations = [
            {"messageName": normal_data["messageName"], "targetStateId": normal_recv_state["id"]},
            {"messageName": error_recv["messageName"], "targetStateId": error_recv["stateId"]},
        ]
        self._emit_trace("GuardEvaluated", {"mode": "try-catch-message-wait"})
        result = await self._wait_for_any_message(f"trycatch_{normal_recv_state['id']}", expectations)

        env = result["env"]
        self._emit_trace("MessageReceived", {
            "messageName": env["messageName"],
            "from": env["from"]["agent"],
            "fromRole": env["from"]["role"],
        })

        self._ctx["msg"] = env["payload"]
        matched_state = self._state_map.get(result["targetStateId"])
        if matched_state and matched_state["data"]["kind"] == "receive":
            post_zone = matched_state["data"].get("postReceiveZone")
            if post_zone:
                self._emit_trace("ActionStarted", {"stateId": result["targetStateId"], "zone": "postReceive"})
                execute_zone(post_zone, self._ctx, self._self_ref, self._reagent, self._zone_extras())
                self._emit_trace("ActionFinished", {"stateId": result["targetStateId"], "zone": "postReceive"})
        self._ctx.pop("msg", None)

        self._current_state_id = result["targetStateId"]
        self._current_state_id = self._follow_default()

    async def _handle_invoke(self, state: dict[str, Any]) -> None:
        data = state["data"]
        self._emit_trace("InvokeStarted", {"stateId": state["id"], "protocolName": data["protocolName"]})
        if not self._invoke_callback:
            raise RuntimeError(f"invoke for protocol '{data['protocolName']}' but no invoke_callback set")
        import re
        input_expr = data.get("input", "{}")
        translated = re.sub(r'\$ctx\b', 'ctx', input_expr)
        translated = re.sub(r'\$self\b', 'self_state', translated)
        try:
            input_value = eval(translated, {"__builtins__": {}}, {
                "ctx": self._ctx, "self_state": self._self_ref,
            })
        except Exception:
            input_value = {}
        result = await self._invoke_callback(data["protocolName"], input_value)
        if data.get("resultTarget"):
            self._assign_target(data["resultTarget"], result)
        self._emit_trace("InvokeCompleted", {"stateId": state["id"], "protocolName": data["protocolName"]})

    async def _handle_async_invoke_state(self, state: dict[str, Any]) -> None:
        data = state["data"]
        self._emit_trace("AsyncInvokeStarted", {"stateId": state["id"], "protocolName": data["protocolName"]})
        if not self._spawn_callback:
            return
        import re
        input_expr = data.get("input", "{}")
        translated = re.sub(r'\$ctx\b', 'ctx', input_expr)
        translated = re.sub(r'\$self\b', 'self_state', translated)
        try:
            input_value = eval(translated, {"__builtins__": {}}, {
                "ctx": self._ctx, "self_state": self._self_ref,
            })
        except Exception:
            input_value = {}
        self._spawn_callback(data["protocolName"], input_value)

    async def _handle_spawn_state(self, state: dict[str, Any]) -> None:
        """Legacy handler for 'spawn' IR states — routes through async_invoke."""
        data = state["data"]
        self._emit_trace("AsyncInvokeStarted", {"stateId": state["id"], "protocolName": data["protocolName"]})
        if not self._spawn_callback:
            return
        import re
        input_expr = data.get("input", "{}")
        translated = re.sub(r'\$ctx\b', 'ctx', input_expr)
        translated = re.sub(r'\$self\b', 'self_state', translated)
        try:
            input_value = eval(translated, {"__builtins__": {}}, {
                "ctx": self._ctx, "self_state": self._self_ref,
            })
        except Exception:
            input_value = {}
        self._spawn_callback(data["protocolName"], input_value)

    async def _handle_scatter(self, state: dict[str, Any]) -> None:
        data = state["data"]
        self._emit_trace("ScatterStarted", {"stateId": state["id"], "collection": data["collection"], "itemRole": data["itemRole"]})
        import re
        coll_expr = data["collection"]
        translated = re.sub(r'\$ctx\b', 'ctx', coll_expr)
        translated = re.sub(r'\$self\b', 'self_state', translated)
        try:
            coll = eval(translated, {"__builtins__": {}}, {
                "ctx": AttrDict(self._ctx), "self_state": AttrDict(self._self_ref),
            })
        except Exception:
            coll = []
        if not isinstance(coll, list) or len(coll) == 0:
            self._emit_trace("ScatterCompleted", {"stateId": state["id"], "count": 0})
            join_id = self._find_join_for_fork(state["id"])
            if join_id:
                self._current_state_id = join_id
                self._current_state_id = self._follow_default()
            else:
                self._current_state_id = self._follow_default()
            return
        join_id = self._find_join_for_fork(state["id"])
        branch_start_id = data["branchStartIds"][0]

        async def run_branch(item: Any, idx: int) -> None:
            saved_ctx = self._ctx
            branch_ctx = dict(self._ctx)
            branch_ctx["_scatterItem"] = item
            branch_ctx["_scatterIdx"] = idx
            self._ctx = branch_ctx
            try:
                current = branch_start_id
                while True:
                    if join_id and current == join_id:
                        return
                    st = self._state_map.get(current)
                    if not st:
                        raise RuntimeError(f"State {current} not found in scatter branch")
                    k = st["data"]["kind"]
                    if k == "send":
                        await self._handle_send(st)
                        current = self._follow_default_from(current)
                    elif k == "receive":
                        await self._handle_receive(st)
                        current = self._follow_default_from(current)
                    elif k == "action":
                        await self._handle_action(st)
                        current = self._follow_default_from(current)
                    elif k == "timer":
                        await self._handle_timer(st)
                        current = self._follow_default_from(current)
                    else:
                        current = self._follow_default_from(current)
            finally:
                self._ctx = saved_ctx

        for idx, item in enumerate(coll):
            await run_branch(item, idx)
        self._emit_trace("ScatterCompleted", {"stateId": state["id"], "count": len(coll)})
        if join_id:
            self._current_state_id = join_id
            self._current_state_id = self._follow_default()
        else:
            self._current_state_id = self._follow_default()

    def _assign_target(self, target: str, value: Any) -> None:
        if target.startswith("$ctx."):
            key = target[5:]
            self._ctx[key] = value

    def _find_loop_exit(self, from_state_id: str) -> str | None:
        visited: set[str] = set()
        queue = [from_state_id]
        while queue:
            sid = queue.pop(0)
            if sid in visited:
                continue
            visited.add(sid)
            for t in self._graph["transitions"]:
                if t["to"] == sid:
                    source = self._state_map.get(t["from"])
                    if source and source["data"]["kind"] == "guard" and source["data"].get("guardType") == "expression":
                        from_trans = self._transitions_from.get(t["from"], [])
                        else_t = next((tr for tr in from_trans if tr["label"]["kind"] == "else"), None)
                        if else_t:
                            return else_t["to"]
                    queue.append(t["from"])
        return None

    async def _handle_timer(self, state: dict[str, Any]) -> None:
        data = state["data"]
        ms = _duration_to_ms(data["duration"])
        self._emit_trace("TimerStarted", {"stateId": state["id"], "durationMs": ms})
        await asyncio.sleep(ms / 1000.0)
        self._emit_trace("TimerFired", {"stateId": state["id"]})

    async def _handle_fork(self, state: dict[str, Any]) -> None:
        transitions = self._transitions_from.get(state["id"], [])
        branch_transitions = [t for t in transitions if t["label"]["kind"] == "branch"]

        self._emit_trace("ForkStarted", {"stateId": state["id"], "branchCount": len(branch_transitions)})

        join_id = self._find_join_for_fork(state["id"])

        async def run_branch(start_id: str) -> None:
            current = start_id
            while True:
                if join_id and current == join_id:
                    return
                st = self._state_map.get(current)
                if not st:
                    raise RuntimeError(f"State {current} not found in branch")
                kind = st["data"]["kind"]

                if kind == "send":
                    await self._handle_send(st)
                    current = self._follow_default_from(current)
                elif kind == "receive":
                    await self._handle_receive(st)
                    current = self._follow_default_from(current)
                elif kind == "action":
                    self._handle_action(st)
                    current = self._follow_default_from(current)
                elif kind == "timer":
                    await self._handle_timer(st)
                    current = self._follow_default_from(current)
                else:
                    current = self._follow_default_from(current)

        tasks = [run_branch(bt["to"]) for bt in branch_transitions]
        await asyncio.gather(*tasks)

        self._emit_trace("JoinCompleted", {"stateId": join_id or state["id"]})

        if join_id:
            self._current_state_id = join_id
            self._current_state_id = self._follow_default()
        else:
            self._current_state_id = self._follow_default()

    def _find_join_for_fork(self, fork_id: str) -> str | None:
        transitions = self._transitions_from.get(fork_id, [])
        branch_starts = [t["to"] for t in transitions if t["label"]["kind"] == "branch"]

        for start_id in branch_starts:
            current = start_id
            visited: set[str] = set()
            while current not in visited:
                visited.add(current)
                st = self._state_map.get(current)
                if not st:
                    break
                if st["data"]["kind"] == "join":
                    return current
                trans = self._transitions_from.get(current, [])
                default = next((t for t in trans if t["label"]["kind"] == "default"), None)
                if default:
                    current = default["to"]
                else:
                    break
        return None

    def _follow_default_from(self, state_id: str) -> str:
        transitions = self._transitions_from.get(state_id, [])
        default = next((t for t in transitions if t["label"]["kind"] == "default"), None)
        if default:
            return default["to"]
        if transitions:
            return transitions[0]["to"]
        raise RuntimeError(f"No outgoing transition from state {state_id}")

    def _eval_expr(self, expr: str) -> Any:
        """Evaluate a guard expression with $ctx, $self in scope."""
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
        for i, env in enumerate(self._message_inbox):
            if env["messageName"] == message_name:
                self._message_inbox.pop(i)
                fut_done: asyncio.Future = asyncio.get_event_loop().create_future()
                fut_done.set_result(env)
                return fut_done

        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self._message_resolvers.setdefault(message_name, []).append(fut)
        return fut

    def _wait_for_any_message(
        self, guard_id: str, expectations: list[dict[str, Any]]
    ) -> asyncio.Future:
        loop = asyncio.get_event_loop()

        for e in expectations:
            for i, env in enumerate(self._message_inbox):
                if env["messageName"] == e["messageName"]:
                    self._message_inbox.pop(i)
                    result_imm: asyncio.Future = loop.create_future()
                    result_imm.set_result({"env": env, "targetStateId": e["targetStateId"]})
                    return result_imm

        result_fut: asyncio.Future = loop.create_future()
        resolvers = []
        for e in expectations:
            per_msg_fut: asyncio.Future = loop.create_future()

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


def _expression_vars_are_defined(
    expr: str, ctx: dict[str, Any], self_state: dict[str, Any],
) -> bool:
    import re
    ctx_refs = re.findall(r'\$ctx\.(\w+)', expr)
    self_refs = re.findall(r'\$self\.(\w+)', expr)
    for prop in ctx_refs:
        if prop not in ctx:
            return False
    for prop in self_refs:
        if prop not in self_state:
            return False
    return True


def _duration_to_ms(duration: dict[str, Any]) -> int:
    value = duration["value"]
    unit = duration.get("unit", "ms")
    if unit == "ms":
        return value
    elif unit == "s":
        return value * 1000
    elif unit == "m":
        return value * 60_000
    elif unit == "h":
        return value * 3_600_000
    return value
