"""
AgentInterface — contract between ProtocolEngine events and agent implementations.

Three integration modes:
  1. ManagedAgentAdapter — RC executes zones (default)
  2. CustomAgent — user implements handle() in-process
  3. MessageGate — AgentInterface over network (WS/stdio/HTTP)
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable, Optional

from .zone_executor import execute_zone, execute_zone_async, BreakRequest, ReturnValue


class AgentInterface(ABC):
    """Generic agent interface for handling ProtocolEvents."""

    @abstractmethod
    async def handle(self, event: dict[str, Any]) -> dict[str, Any]:
        """Handle a ProtocolEvent and return an AgentResponse."""
        ...


class ManagedAgentAdapter(AgentInterface):
    """Executes zone code on behalf of the engine (default mode)."""

    def __init__(
        self,
        *,
        extras: Optional[dict[str, Any]] = None,
        invoke_callback: Optional[Callable] = None,
        spawn_callback: Optional[Callable] = None,
        emit_callback: Optional[Callable] = None,
    ) -> None:
        self._extras = extras
        self._invoke_callback = invoke_callback
        self._spawn_callback = spawn_callback
        self._emit_callback = emit_callback

    def set_invoke_callback(self, cb: Callable) -> None:
        self._invoke_callback = cb

    def set_spawn_callback(self, cb: Callable) -> None:
        self._spawn_callback = cb

    def set_emit_callback(self, cb: Callable) -> None:
        self._emit_callback = cb

    def _zone_extras(self) -> Optional[dict[str, Any]]:
        if not self._extras:
            return None
        return {"$agent": self._extras}

    def _make_reagent(self) -> Any:
        from .protocol_instance import ReagentStub
        stub = ReagentStub()
        stub.spawn = lambda proto=None, args=None: (
            self._spawn_callback(str(proto), args) if self._spawn_callback else None
        )
        stub.emit = lambda event_name="", data=None: (
            self._emit_callback(event_name, data) if self._emit_callback else None
        )
        return stub

    async def handle(self, event: dict[str, Any]) -> dict[str, Any]:
        event_type = event.get("type", "")

        if event_type == "action":
            return await self._handle_action(event)
        elif event_type in ("pre_send_action", "post_receive_action"):
            return await self._handle_zone_exec(event)

        return {"type": "noop"}

    async def _handle_action(self, event: dict[str, Any]) -> dict[str, Any]:
        body = event["body"]
        is_async = event.get("isAsync", False)
        ctx = event["ctx"]
        self_ref = event["self"]
        reagent = self._make_reagent()
        extras = self._zone_extras()

        try:
            if is_async:
                await execute_zone_async(body, ctx, self_ref, reagent, extras)
            else:
                execute_zone(body, ctx, self_ref, reagent, extras)
            return {"type": "ctx_update", "ctx": ctx}
        except ReturnValue as rv:
            return {"type": "return_value", "value": rv.value}
        except BreakRequest:
            return {"type": "break_requested"}
        except Exception as err:
            return {"type": "error_thrown", "error": str(err)}

    async def _handle_zone_exec(self, event: dict[str, Any]) -> dict[str, Any]:
        body = event["body"]
        is_async = event.get("isAsync", False)
        ctx = event["ctx"]
        self_ref = event["self"]
        reagent = self._make_reagent()
        extras = self._zone_extras()

        try:
            if is_async:
                await execute_zone_async(body, ctx, self_ref, reagent, extras)
            else:
                execute_zone(body, ctx, self_ref, reagent, extras)
            return {"type": "ctx_update", "ctx": ctx}
        except ReturnValue as rv:
            return {"type": "return_value", "value": rv.value}
        except BreakRequest:
            return {"type": "break_requested"}
        except Exception as err:
            return {"type": "error_thrown", "error": str(err)}
