"""
IpcAgentNode — runs agents in a child subprocess via ipc_agent.py.

Communication is newline-delimited JSON on stdin/stdout, same protocol as the
TS PythonAgentNode.  Useful for process-level isolation, separate memory, or
mixed-language setups where the Python RC drives a subprocess agent.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

_STOP_TIMEOUT_S = 5.0


class IpcAgentNode:
    """Factory for subprocess-based Python agents."""

    def __init__(self, role_to_agent: dict[str, str]) -> None:
        self._role_to_agent = role_to_agent

    @property
    def runtime_name(self) -> str:
        return "ipc-py"

    def create_agent(
        self,
        name: str,
        role_ir: dict[str, Any],
        graphs: dict[str, dict[str, Any]],
        transport: Any,
        extras: Optional[dict[str, Any]] = None,
    ) -> "IpcAgentHandle":
        agent_ir: dict[str, Any] = {
            "agentName": name,
            "lang": role_ir.get("lang", "py"),
            "roleName": role_ir["roleName"],
            "plays": role_ir["plays"],
            "initAction": role_ir.get("initAction"),
            "lifecycleHandlers": role_ir.get("lifecycleHandlers", []),
        }
        return IpcAgentHandle(
            name=name,
            agent_ir=agent_ir,
            graphs=graphs,
            role_to_agent=self._role_to_agent,
            route_callback=transport._route if hasattr(transport, "_route") else lambda env: None,
        )

    async def destroy_agent(self, handle: "IpcAgentHandle") -> None:
        await handle.stop()


class IpcAgentHandle:
    """Wraps a subprocess running ipc_agent.py."""

    def __init__(
        self,
        name: str,
        agent_ir: dict[str, Any],
        graphs: dict[str, dict[str, Any]],
        role_to_agent: dict[str, str],
        route_callback: Callable[[dict[str, Any]], None],
    ) -> None:
        self._name = name
        self._agent_ir = agent_ir
        self._graphs = graphs
        self._role_to_agent = role_to_agent
        self._route = route_callback

        self._proc: Optional[asyncio.subprocess.Process] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._stopped_event = asyncio.Event()
        self._completed_count = 0
        self._expected_count = 0
        self._completion_event = asyncio.Event()

    @property
    def agent_name(self) -> str:
        return self._name

    async def start(self) -> None:
        env = os.environ.copy()
        pkg_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env["PYTHONPATH"] = pkg_dir + os.pathsep + env.get("PYTHONPATH", "")

        self._proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "reagent_runtime.ipc_agent",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        self._reader_task = asyncio.ensure_future(self._read_stdout())

        await self._send_cmd({
            "type": "init",
            "agentName": self._name,
            "agentIR": self._agent_ir,
            "graphs": self._graphs,
            "roleToAgent": self._role_to_agent,
        })

        await self._wait_for_type("ready", timeout=10.0)

        await self._send_cmd({"type": "start"})

    async def stop(self) -> None:
        if not self._proc or self._proc.returncode is not None:
            return

        await self._send_cmd({"type": "stop"})

        try:
            await asyncio.wait_for(self._stopped_event.wait(), timeout=_STOP_TIMEOUT_S)
        except asyncio.TimeoutError:
            log.warning("[IPC %s] Stop timeout, killing subprocess", self._name)
            self._proc.kill()

        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()

    def get_self(self) -> dict[str, Any]:
        return {}

    def trigger_protocol(self, trigger: dict[str, Any]) -> None:
        asyncio.ensure_future(self._send_cmd({"type": "triggerProtocol", "trigger": trigger}))

    def dispatch_message(self, env: dict[str, Any]) -> None:
        asyncio.ensure_future(self._send_cmd({"type": "dispatchMessage", "envelope": env}))

    async def wait_for_completion(self, expected_count: int, timeout_s: float = 30.0) -> None:
        self._expected_count = expected_count
        if self._completed_count >= expected_count:
            return
        try:
            await asyncio.wait_for(self._completion_event.wait(), timeout=timeout_s)
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"Timeout: IPC {self._name} completed {self._completed_count}/{expected_count}"
            )

    # ── Internal ──────────────────────────────────────────────────

    async def _send_cmd(self, cmd: dict[str, Any]) -> None:
        if not self._proc or not self._proc.stdin:
            return
        line = json.dumps(cmd, separators=(",", ":")) + "\n"
        self._proc.stdin.write(line.encode())
        await self._proc.stdin.drain()

    async def _read_stdout(self) -> None:
        assert self._proc and self._proc.stdout
        while True:
            raw = await self._proc.stdout.readline()
            if not raw:
                break
            line = raw.decode().strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "sendEnvelope":
                self._route(msg["envelope"])
            elif msg_type == "trace":
                pass
            elif msg_type == "instanceCompleted":
                self._completed_count += 1
                if self._completed_count >= self._expected_count:
                    self._completion_event.set()
            elif msg_type == "stopped":
                self._stopped_event.set()
            elif msg_type == "ready":
                self._ready_event.set()

    _ready_event: asyncio.Event

    async def _wait_for_type(self, type_name: str, timeout: float = 10.0) -> None:
        if type_name == "ready":
            self._ready_event = asyncio.Event()
            await asyncio.wait_for(self._ready_event.wait(), timeout=timeout)
