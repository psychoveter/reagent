"""
InprocAgentNode — runs agents in the same process via AgentRunner.

Mirrors the TS NativeAgentNode.  Each call to create_agent() builds an AgentIR
from the supplied RoleIR, creates an AgentRunner wired to the given transport,
and wraps it in an InprocAgentHandle.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from typing import Callable

from .agent_runner import AgentRunner
from .protocol_instance import ProtocolInstance

EmitBusCallback = Callable[..., None]


class InprocAgentNode:
    """Factory for in-process Python agents."""

    def __init__(
        self,
        role_to_agent: dict[str, str],
        advance_hook: Optional[Any] = None,
        emit_bus_callback: Optional[EmitBusCallback] = None,
    ) -> None:
        self._role_to_agent = role_to_agent
        self._advance_hook = advance_hook
        self._emit_bus_cb: Optional[EmitBusCallback] = emit_bus_callback
        self._handles: list["InprocAgentHandle"] = []

    @property
    def runtime_name(self) -> str:
        return "inproc-py"

    def create_agent(
        self,
        name: str,
        role_ir: dict[str, Any],
        graphs: dict[str, dict[str, Any]],
        transport: Any,
        extras: Optional[dict[str, Any]] = None,
    ) -> "InprocAgentHandle":
        agent_ir: dict[str, Any] = {
            "agentName": name,
            "lang": role_ir.get("lang", "py"),
            "roleName": role_ir["roleName"],
            "plays": role_ir["plays"],
            "initAction": role_ir.get("initAction"),
            "lifecycleHandlers": role_ir.get("lifecycleHandlers", []),
        }

        config: dict[str, Any] = {
            "agentIR": agent_ir,
            "graphs": graphs,
            "roleToAgent": self._role_to_agent,
            "transport": transport,
        }
        if self._advance_hook is not None:
            config["advanceHook"] = self._advance_hook
        if extras is not None:
            config["extras"] = extras
        if self._emit_bus_cb is not None:
            config["emitBusCallback"] = self._emit_bus_cb

        runner = AgentRunner(config)
        handle = InprocAgentHandle(name, runner)
        self._handles.append(handle)
        return handle

    def set_advance_hook(self, hook: Optional[Any]) -> None:
        self._advance_hook = hook
        for h in self._handles:
            h.runner.set_advance_hook(hook)

    def set_emit_bus_callback(self, cb: Optional[EmitBusCallback]) -> None:
        self._emit_bus_cb = cb

    async def destroy_agent(self, handle: "InprocAgentHandle") -> None:
        await handle.stop()


class InprocAgentHandle:
    """Wraps an in-process AgentRunner as an AgentHandle."""

    def __init__(self, name: str, runner: AgentRunner) -> None:
        self._name = name
        self._runner = runner

    @property
    def agent_name(self) -> str:
        return self._name

    async def start(self) -> None:
        await self._runner.start()

    async def stop(self) -> None:
        await self._runner.stop()

    def get_self(self) -> dict[str, Any]:
        return self._runner.self_state

    def trigger_protocol(self, trigger: dict[str, Any]) -> None:
        asyncio.ensure_future(
            self._runner.trigger_protocol(
                trigger["instanceId"],
                trigger["protocolName"],
                trigger.get("input"),
                trigger.get("roleToAgent"),
            )
        )

    def dispatch_message(self, env: dict[str, Any]) -> None:
        self._runner.dispatch_message(env)

    # ── Test introspection helpers ────────────────────────────────

    async def wait_for_completion(self, expected_count: int, timeout_s: float = 30.0) -> None:
        await self._runner.wait_for_completion(expected_count, timeout_s)

    @property
    def instances(self) -> dict[str, ProtocolInstance]:
        return self._runner.instances

    @property
    def runner(self) -> AgentRunner:
        return self._runner
