"""
LocalTransport — IPC-based transport that sends envelopes via stdout JSON lines.

Drop-in replacement for NatsTransport when an agent is driven by a parent
process over stdin/stdout (the PythonAgentNode bridge in TS).

Publishing writes a JSON line to stdout; subscribing is a no-op because
inbound messages are dispatched directly by the IPC driver (ipc_agent.py).
"""

from __future__ import annotations

import json
import sys
from typing import Any


class LocalTransport:
    """Transport that emits envelopes/traces as JSON lines on stdout."""

    def __init__(self) -> None:
        self._connected = False

    async def connect(self) -> None:
        self._connected = True

    async def close(self) -> None:
        self._connected = False

    # ── Publishing ────────────────────────────────────────────────

    def publish(self, subject: str, data: Any) -> None:
        """Fire-and-forget publish — writes a JSON line to stdout."""
        self._emit(subject, data)

    async def publish_async(self, subject: str, data: Any) -> None:
        """Awaitable publish — same as publish (stdout is non-blocking)."""
        self._emit(subject, data)

    # ── Subscribing (no-op for IPC mode) ─────────────────────────

    async def subscribe(self, subject: str, handler: Any) -> None:
        pass

    # ── Internal ─────────────────────────────────────────────────

    def _emit(self, subject: str, data: Any) -> None:
        if subject.startswith("reagent.trace."):
            msg = {"type": "trace", "event": data}
        else:
            msg = {"type": "sendEnvelope", "envelope": data}
        line = json.dumps(msg, separators=(",", ":"))
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
