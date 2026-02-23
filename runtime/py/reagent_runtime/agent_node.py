"""
AgentNode / AgentHandle — platform abstraction protocols.

AgentNode is a factory that creates AgentHandle instances for a given runtime
(inproc Python, IPC subprocess, etc.).

AgentHandle is the opaque per-agent interface used by the ReagentController.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class AgentHandle(Protocol):
    """Opaque handle to a single agent, used by the ReagentController."""

    @property
    def agent_name(self) -> str: ...

    async def start(self) -> None: ...
    async def stop(self) -> None: ...

    def get_self(self) -> dict[str, Any]: ...
    def trigger_protocol(self, trigger: dict[str, Any]) -> None: ...
    def dispatch_message(self, env: dict[str, Any]) -> None: ...


@runtime_checkable
class AgentNode(Protocol):
    """Factory that creates AgentHandle instances for a specific runtime."""

    @property
    def runtime_name(self) -> str: ...

    def create_agent(
        self,
        name: str,
        role_ir: dict[str, Any],
        graphs: dict[str, dict[str, Any]],
        transport: Any,
    ) -> AgentHandle: ...

    async def destroy_agent(self, handle: AgentHandle) -> None: ...
