"""
CustomAgentNode — AgentNode for user-implemented agents (Python mirror).

Instead of executing zones from .rg files, the user provides an object
implementing the AgentInterface.handle() method.
"""
from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional

from .agent_node import AgentNode, AgentHandle
from .agent_interface import AgentInterface
from .protocol_engine import ProtocolEngine, duration_to_ms


class CustomAgentHandle(AgentHandle):
    """Handle for a custom-implemented agent."""

    def __init__(
        self,
        agent_name: str,
        agent: AgentInterface,
        graphs: dict[str, Any],
        role_to_agent: dict[str, str],
    ) -> None:
        self._agent_name = agent_name
        self._agent = agent
        self._graphs = graphs
        self._role_to_agent = role_to_agent
        self._self_state: dict[str, Any] = {}
        self._instances: dict[str, ProtocolEngine] = {}
        self._completion_count = 0
        self._completion_events: list[asyncio.Event] = []

    @property
    def agent_name(self) -> str:
        return self._agent_name

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    def get_self(self) -> dict[str, Any]:
        return self._self_state

    def trigger_protocol(self, trigger: dict[str, Any]) -> None:
        protocol_name = trigger["protocolName"]
        instance_id = trigger["instanceId"]

        role = None
        for key in self._graphs:
            if key.startswith(f"{protocol_name}."):
                role = key.split(".")[1]
                break

        if role is None:
            return

        graph_key = f"{protocol_name}.{role}"
        graph = self._graphs.get(graph_key)
        if graph is None:
            return

        engine = ProtocolEngine(
            graph,
            instance_id=instance_id,
            protocol_name=protocol_name,
            agent_name=self._agent_name,
            role_name=role,
            self_ref=self._self_state,
            input_data=trigger.get("input"),
        )
        self._instances[instance_id] = engine

        rta = trigger.get("roleToAgent", self._role_to_agent)
        asyncio.ensure_future(self._run_engine(engine, rta))

    def dispatch_message(self, env: dict[str, Any]) -> None:
        instance_id = env.get("instanceId", "")
        engine = self._instances.get(instance_id)
        if engine is None:
            return
        inbox = getattr(engine, "_message_inbox", [])
        inbox.append(env)
        engine._message_inbox = inbox  # type: ignore[attr-defined]

    async def _run_engine(self, engine: ProtocolEngine, role_to_agent: dict[str, str]) -> None:
        engine.status = "running"
        inbox: list[dict[str, Any]] = getattr(engine, "_message_inbox", [])
        engine._message_inbox = inbox  # type: ignore[attr-defined]

        try:
            while engine.status == "running":
                state = engine.state_map.get(engine.current_state_id)
                if state is None:
                    raise RuntimeError(f"State {engine.current_state_id} not found")

                kind = state["data"]["kind"]

                if kind == "initial":
                    engine.current_state_id = engine.follow_default()
                elif kind == "terminal":
                    status_val = state["data"].get("status", "completed")
                    engine.status = "completed" if status_val == "completed" else "failed"
                    self._on_complete(engine.instance_id)
                    return
                elif kind == "action":
                    resp = await self._agent.handle({
                        "type": "action",
                        "stateId": state["id"],
                        "body": state["data"]["body"],
                        "lang": state["data"].get("lang", "*"),
                        "isAsync": state["data"].get("async", False),
                        "ctx": engine.ctx,
                        "self": engine.self_ref,
                    })
                    if resp.get("type") == "ctx_update":
                        engine.ctx = resp["ctx"]
                    elif resp.get("type") == "return_value":
                        engine.set_return_value(resp["value"])
                        self._on_complete(engine.instance_id)
                        return
                    elif resp.get("type") == "break_requested":
                        exit_id = engine.find_loop_exit(state["id"])
                        if exit_id:
                            engine.current_state_id = exit_id
                            continue
                    engine.current_state_id = engine.follow_default()
                elif kind == "send":
                    engine.current_state_id = engine.follow_default()
                elif kind == "receive":
                    engine.current_state_id = engine.follow_default()
                elif kind == "timer":
                    ms = duration_to_ms(state["data"]["duration"])
                    await asyncio.sleep(ms / 1000.0)
                    engine.current_state_id = engine.follow_default()
                else:
                    engine.current_state_id = engine.follow_default()

        except Exception as err:
            engine.status = "failed"
            self._on_complete(engine.instance_id)

    def _on_complete(self, instance_id: str) -> None:
        self._completion_count += 1
        for evt in self._completion_events:
            evt.set()


class CustomAgentNode(AgentNode):
    """AgentNode that creates CustomAgentHandles from a factory function."""

    runtime_name = "custom"

    def __init__(
        self,
        *,
        role_to_agent: dict[str, str],
        agent_factory: Callable[[str, Any], AgentInterface],
    ) -> None:
        self._role_to_agent = role_to_agent
        self._agent_factory = agent_factory

    def create_agent(
        self,
        agent_name: str,
        role_ir: Any,
        graphs: dict[str, Any],
        transport: Any,
        extras: Optional[dict[str, Any]] = None,
    ) -> AgentHandle:
        agent = self._agent_factory(agent_name, role_ir)
        return CustomAgentHandle(agent_name, agent, graphs, self._role_to_agent)

    async def destroy_agent(self, handle: AgentHandle) -> None:
        await handle.stop()
