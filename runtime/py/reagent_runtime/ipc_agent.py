"""
IPC Agent — stdin/stdout JSON-line bridge for PythonAgentNode.

The TS parent process (PythonAgentHandle) spawns this script and communicates
via newline-delimited JSON on stdin (commands) and stdout (events).

Protocol:
  stdin  → {"type": "init", "agentName": "…", "agentIR": {…}, "graphs": {…}, "roleToAgent": {…}}
  stdout ← {"type": "ready"}
  stdin  → {"type": "start"}
  stdin  → {"type": "dispatchMessage", "envelope": {…}}
  stdin  → {"type": "triggerProtocol", "trigger": {…}}
  stdin  → {"type": "getSelf"}
  stdout ← {"type": "selfState", "state": {…}}
  stdin  → {"type": "stop"}
  stdout ← {"type": "stopped"}

Agent-initiated output:
  stdout ← {"type": "sendEnvelope", "envelope": {…}}  (routed by TS RC)
  stdout ← {"type": "trace", "event": {…}}
  stdout ← {"type": "instanceCompleted", "instanceId": "…", "status": "…"}
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, Optional

from .agent_runner import AgentRunner
from .local_transport import LocalTransport


def _send(msg: dict[str, Any]) -> None:
    line = json.dumps(msg, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


async def _read_stdin_lines() -> asyncio.Queue:
    """Read lines from stdin in a background thread, push them into a queue."""
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def _reader() -> None:
        try:
            for raw_line in sys.stdin:
                line = raw_line.strip()
                if line:
                    loop.call_soon_threadsafe(queue.put_nowait, line)
        except Exception:
            pass
        loop.call_soon_threadsafe(queue.put_nowait, None)

    loop.run_in_executor(None, _reader)
    return queue


async def run_ipc_agent() -> None:
    queue = await _read_stdin_lines()

    runner: Optional[AgentRunner] = None
    transport: Optional[LocalTransport] = None

    # Debug state-level pause support
    pause_gate: Optional[asyncio.Event] = None
    state_breakpoints: set[str] = set()

    async def _advance_hook(ctx: dict[str, Any]) -> None:
        nonlocal pause_gate
        if ctx["stateId"] in state_breakpoints:
            _send({"type": "debugStopped", "stateId": ctx["stateId"], "stateKind": ctx["stateKind"],
                    "agentName": ctx["agentName"], "instanceId": ctx["instanceId"]})
            pause_gate = asyncio.Event()
            await pause_gate.wait()

    while True:
        raw = await queue.get()
        if raw is None:
            break

        try:
            cmd = json.loads(raw)
        except json.JSONDecodeError:
            continue

        cmd_type = cmd.get("type")

        if cmd_type == "init":
            transport = LocalTransport()

            config: dict[str, Any] = {
                "agentIR": cmd["agentIR"],
                "graphs": cmd["graphs"],
                "roleToAgent": cmd["roleToAgent"],
                "transport": transport,
                "advanceHook": _advance_hook,
            }
            runner = AgentRunner(config)

            def _on_instance_complete(instance_id: str, status: str) -> None:
                _send({"type": "instanceCompleted", "instanceId": instance_id, "status": status})

            runner.set_on_complete_callback(_on_instance_complete)
            _send({"type": "ready"})

        elif cmd_type == "start":
            if runner:
                await runner.start()

        elif cmd_type == "dispatchMessage":
            if runner:
                runner.dispatch_message(cmd["envelope"])

        elif cmd_type == "triggerProtocol":
            if runner:
                trigger = cmd["trigger"]
                await runner.trigger_protocol(
                    trigger["instanceId"],
                    trigger["protocolName"],
                    trigger.get("input"),
                    trigger.get("roleToAgent"),
                )

        elif cmd_type == "getSelf":
            if runner:
                _send({"type": "selfState", "state": runner.self_state})

        elif cmd_type == "pauseBeforeState":
            state_ids = cmd.get("stateIds", [])
            state_breakpoints.clear()
            state_breakpoints.update(state_ids)
            _send({"type": "pauseConfigured", "stateIds": list(state_breakpoints)})

        elif cmd_type == "resume":
            if pause_gate:
                pause_gate.set()
                pause_gate = None
            _send({"type": "resumed"})

        elif cmd_type == "stop":
            if runner:
                await runner.stop()
            _send({"type": "stopped"})
            break

    if runner:
        await runner.stop()


def main() -> None:
    asyncio.run(run_ipc_agent())


if __name__ == "__main__":
    main()
