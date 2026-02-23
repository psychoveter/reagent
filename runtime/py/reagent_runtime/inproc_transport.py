"""
InprocTransport — in-process transport that routes envelopes via a callback.

Drop-in replacement for NatsTransport / LocalTransport.  Used by the Python
ReagentController when running agents in the same process (no NATS, no IPC).

Outbound messages are routed through the RC's routing table via *route_callback*.
Trace events go to *trace_callback*.  Inbound messages bypass subscriptions — the
RC calls AgentRunner.dispatch_message() directly.
"""

from __future__ import annotations

from typing import Any, Callable, Optional


class InprocTransport:
    """Per-agent transport backed by the ReagentController's routing table."""

    def __init__(
        self,
        agent_name: str,
        route_callback: Callable[[dict[str, Any]], None],
        trace_callback: Optional[Callable[[dict[str, Any]], None]] = None,
    ) -> None:
        self._agent_name = agent_name
        self._route = route_callback
        self._trace = trace_callback

    async def connect(self) -> None:
        pass

    async def close(self) -> None:
        pass

    def publish(self, subject: str, data: Any) -> None:
        if subject.startswith("reagent.trace."):
            if self._trace:
                self._trace(data)
        else:
            self._route(data)

    async def publish_async(self, subject: str, data: Any) -> None:
        self.publish(subject, data)

    async def subscribe(self, subject: str, handler: Any) -> None:
        pass
