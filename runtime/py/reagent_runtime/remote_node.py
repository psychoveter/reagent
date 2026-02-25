"""
RemoteNode — a standalone Python agent node that connects to ROS via WebSocket.

Mirrors the TS RemoteNode (runtime/ts/src/remote-node.ts).  Creates its own
ReagentController + InprocAgentNode, registers with ROS, and receives
Deploy/TriggerProtocol commands over WS.

Usage::

    python -m reagent_runtime.remote_node \\
        --ros-url ws://127.0.0.1:18789 \\
        --node-id node-py-1 \\
        --agents-dir ./agents

Or programmatically::

    node = RemoteNode(node_id="node-py-1", ros_url="ws://127.0.0.1:18789")
    await node.connect()
    # ... node receives Deploy / TriggerProtocol from ROS ...
    await node.close()
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Optional

from .controller import ReagentController
from .inproc_agent_node import InprocAgentNode
from .agent_manifest import load_agent_manifest, load_agent_module

log = logging.getLogger(__name__)


class _DebugAdvanceHook:
    """Python equivalent of TS DebugAdvanceHook — gate-based pause/resume."""

    def __init__(self, session_id: str, on_stopped: Any) -> None:
        self._session_id = session_id
        self._on_stopped = on_stopped
        self._state_breakpoints: set[str] = set()
        self._step_mode: str = "stepState"  # "none" | "stepState" | "stepOver"
        self._enabled = True
        self._gate: Optional[asyncio.Event] = None

    def set_state_breakpoints(self, state_ids: list[str]) -> None:
        self._state_breakpoints = set(state_ids)
        if state_ids:
            self._enabled = True

    def set_step_mode(self, mode: str) -> None:
        self._step_mode = mode

    def step_state(self) -> None:
        self._step_mode = "stepState"
        self._enabled = True
        self._release()

    def step_over(self) -> None:
        self._step_mode = "stepOver"
        self._enabled = True
        self._release()

    def do_continue(self) -> None:
        self._step_mode = "none"
        self._enabled = bool(self._state_breakpoints)
        self._release()

    def stop(self) -> None:
        self._step_mode = "none"
        self._enabled = False
        self._release()

    def _release(self) -> None:
        if self._gate is not None:
            self._gate.set()
            self._gate = None

    def _should_pause(self, ctx: dict[str, Any]) -> bool:
        state_id = ctx.get("stateId", "")
        kind = ctx.get("stateKind", "")
        if state_id in self._state_breakpoints:
            return True
        if self._step_mode == "stepState":
            return True
        if self._step_mode == "stepOver":
            return kind in ("send", "receive", "terminal", "action")
        return False

    async def hook(self, ctx: dict[str, Any]) -> None:
        if not self._enabled:
            return
        if not self._should_pause(ctx):
            return

        state_id = ctx.get("stateId", "")
        reason = "breakpoint" if state_id in self._state_breakpoints else "step"

        self._on_stopped({
            "sessionId": self._session_id,
            "level": "state",
            "agentName": ctx.get("agentName", ""),
            "stateId": state_id,
            "stateKind": ctx.get("stateKind", ""),
            "instanceId": ctx.get("instanceId", ""),
            "protocolName": ctx.get("protocolName", ""),
            "roleName": ctx.get("roleName", ""),
            "ctx": ctx.get("ctx", {}),
            "self": ctx.get("self", {}),
            "reason": reason,
        })

        self._gate = asyncio.Event()
        await self._gate.wait()


class RemoteNode:
    """A remote Python agent node that connects to the ROS via WebSocket."""

    def __init__(
        self,
        node_id: str,
        ros_url: str,
        agents_dir: Optional[str] = None,
        supported_langs: Optional[list[str]] = None,
    ) -> None:
        self.node_id = node_id
        self._ros_url = ros_url
        self._agents_dir = agents_dir
        self._supported_langs = supported_langs or ["py"]
        self._ws: Any = None
        self._role_to_agent: dict[str, str] = {}
        self._running = False
        self._debug_hooks: dict[str, _DebugAdvanceHook] = {}

        node = InprocAgentNode(role_to_agent=self._role_to_agent)
        self.rc = ReagentController(
            node_id=node_id,
            agent_node=node,
        )
        self.rc._handle_trace = self._forward_trace
        self.rc._route_envelope_remote = self._forward_envelope

    async def connect(self) -> None:
        try:
            import websockets
        except ImportError:
            raise ImportError(
                "The 'websockets' package is required for RemoteNode. "
                "Install it with: pip install websockets"
            )

        log.info("[RemoteNode %s] Connecting to %s", self.node_id, self._ros_url)
        self._ws = await websockets.connect(self._ros_url)
        self._running = True

        await self._send_control("Register", {
            "nodeId": self.node_id,
            "supportedLangs": self._supported_langs,
        })

        self._listen_task = asyncio.ensure_future(self._listen_loop())
        log.info("[RemoteNode %s] Connected and registered", self.node_id)

    async def close(self) -> None:
        self._running = False
        await self.rc.stop()
        if self._ws:
            await self._ws.close()
            self._ws = None

    async def _listen_loop(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if "rap" in msg:
                    await self._handle_control(msg)
                elif "from" in msg and "to" in msg:
                    target = msg["to"].get("agent")
                    handle = self.rc.get_agent(target) if target else None
                    if handle:
                        handle.dispatch_message(msg)
                    else:
                        log.warning("[RemoteNode %s] No local agent %s for envelope", self.node_id, target)
        except Exception as exc:
            if self._running:
                log.error("[RemoteNode %s] WS listen error: %s", self.node_id, exc)
            self._running = False

    async def _handle_control(self, msg: dict[str, Any]) -> None:
        rap = msg.get("rap", "")
        payload = msg.get("payload", {})

        if rap == "Accepted":
            log.info("[RemoteNode %s] Registration accepted", self.node_id)
        elif rap == "Rejected":
            log.error("[RemoteNode %s] Registration rejected: %s", self.node_id, payload.get("reason"))
        elif rap == "Deploy":
            await self._handle_deploy(payload)
        elif rap == "TriggerProtocol":
            self._handle_trigger(payload)
        elif rap == "DebugCommand":
            self._handle_debug_command(payload)
        elif rap == "NodeInspect":
            await self._handle_inspect(msg.get("id"))
        else:
            log.debug("[RemoteNode %s] Unhandled RAP: %s", self.node_id, rap)

    async def _handle_deploy(self, payload: dict[str, Any]) -> None:
        agent_name = payload.get("agentName", "")
        role_ir = payload.get("roleIR", {})
        graphs_obj = payload.get("graphs", {})
        rta = payload.get("roleToAgent", {})
        role_name = payload.get("roleName", "")
        protocol_name = payload.get("protocolName", "")

        if rta:
            self._role_to_agent.update(rta)

        graphs: dict[str, Any] = {}
        for key, graph in graphs_obj.items():
            graphs[key] = graph
            if not protocol_name:
                protocol_name = graph.get("protocolName", "")

        extras: Optional[dict[str, Any]] = None
        if self._agents_dir:
            extras = self._resolve_agent_module(agent_name)

        self.rc.register_agent(agent_name, role_ir, graphs, extras)
        await self.rc.get_agent(agent_name).start()

        await self._send_control("Deployed", {
            "agentName": agent_name,
            "nodeId": self.node_id,
            "roleName": role_name,
            "protocolName": protocol_name,
        })
        log.info("[RemoteNode %s] Deployed agent %s (role=%s, protocol=%s)", self.node_id, agent_name, role_name, protocol_name)

    def _resolve_agent_module(self, agent_name: str) -> Optional[dict[str, Any]]:
        """Resolve agent.json + native module from the local agents directory."""
        if not self._agents_dir or not os.path.isdir(self._agents_dir):
            return None

        name_lower = agent_name.lower()
        base_lower = name_lower.rstrip("0123456789")
        candidates = [
            os.path.join(self._agents_dir, name_lower, "agent.json"),
            os.path.join(self._agents_dir, base_lower, "agent.json"),
        ]
        for path in candidates:
            if os.path.exists(path):
                manifest = load_agent_manifest(path)
                module_obj = load_agent_module(path, manifest)
                return module_obj
        return None

    async def _handle_inspect(self, request_id: Optional[str] = None) -> None:
        """Respond to NodeInspect RAP with the RC's internal state."""
        data = self.rc.dump()
        await self._send_control("NodeInspectResult", {
            "requestId": request_id or "",
            **data,
        })

    def _handle_trigger(self, payload: dict[str, Any]) -> None:
        agent_name = payload.get("agentName", "")
        instance_id = payload.get("instanceId", "")
        protocol_name = payload.get("protocolName", "")
        input_data = payload.get("input", {})
        rta = payload.get("roleToAgent") or self._role_to_agent
        mode = payload.get("mode")
        session_id = payload.get("sessionId")

        if mode == "debug" and session_id:
            breakpoints = payload.get("breakpoints") or []
            self._install_debug_hook(session_id, breakpoints)

        self.rc.trigger_protocol(agent_name, {
            "instanceId": instance_id,
            "protocolName": protocol_name,
            "input": input_data,
            "roleToAgent": rta,
        })

    def _install_debug_hook(self, session_id: str, breakpoints: list[str]) -> None:
        if session_id in self._debug_hooks:
            return

        def on_stopped(event: dict[str, Any]) -> None:
            if self._ws and self._running:
                asyncio.ensure_future(self._send_control("DebugStopped", event))

        hook = _DebugAdvanceHook(session_id, on_stopped)
        if breakpoints:
            hook.set_state_breakpoints(breakpoints)
            hook.set_step_mode("none")
        else:
            hook.set_step_mode("stepState")

        self._debug_hooks[session_id] = hook
        self.rc.set_advance_hook(hook.hook)

    def _handle_debug_command(self, payload: dict[str, Any]) -> None:
        session_id = payload.get("sessionId", "")
        command = payload.get("command", "")
        hook = self._debug_hooks.get(session_id)
        if not hook:
            return

        if command == "continue":
            hook.do_continue()
        elif command in ("stepState", "stepIntoScatter", "stepIntoInvoke"):
            hook.step_state()
        elif command in ("stepOver", "stepOverScatter", "stepOverInvoke"):
            hook.step_over()
        elif command in ("stepOutScatter", "stepOutInvoke"):
            hook.do_continue()
        elif command == "stop":
            hook.stop()
            del self._debug_hooks[session_id]
            self.rc.set_advance_hook(None)
        elif command == "setBreakpoints":
            bps = payload.get("breakpoints") or []
            hook.set_state_breakpoints(bps)

    def _forward_trace(self, event: dict[str, Any]) -> None:
        """Forward trace events to ROS over WS."""
        if self._ws and self._running:
            asyncio.ensure_future(self._send_control("TraceEvent", event))

    def _forward_envelope(self, envelope: dict[str, Any]) -> None:
        """Forward unroutable envelopes to ROS for cross-node relay."""
        if self._ws and self._running:
            asyncio.ensure_future(self._send_raw(envelope))

    async def _send_control(self, rap: str, payload: dict[str, Any]) -> None:
        if self._ws:
            await self._ws.send(json.dumps({
                "rap": rap,
                "payload": payload,
                "nodeId": self.node_id,
            }))

    async def _send_raw(self, data: dict[str, Any]) -> None:
        if self._ws:
            await self._ws.send(json.dumps(data))

    # ── Interactive REPL ─────────────────────────────────────────

    async def repl(self) -> None:
        """Run an interactive stdin REPL for introspecting the node."""
        loop = asyncio.get_event_loop()
        print(f"\n[RemoteNode {self.node_id}] REPL ready. Commands: agents, protocols, routing, dump, help, quit")

        while self._running:
            try:
                line = await loop.run_in_executor(None, lambda: input("rc> "))
            except (EOFError, KeyboardInterrupt):
                break

            cmd = line.strip().lower()
            if not cmd:
                continue

            if cmd in ("q", "quit", "exit"):
                break
            elif cmd == "help":
                print("  agents     – list registered agents")
                print("  protocols  – list deployed protocols")
                print("  routing    – show routing table")
                print("  dump       – full JSON dump")
                print("  pretty     – human-readable summary")
                print("  quit       – stop the node")
            elif cmd == "agents":
                d = self.rc.dump()
                if not d["agents"]:
                    print("  (no agents)")
                for a in d["agents"]:
                    print(f"  {a['name']:20s}  lang={a['lang']}  route={a['route']}")
            elif cmd == "protocols":
                d = self.rc.dump()
                if not d["protocols"]:
                    print("  (no protocols)")
                for p in d["protocols"]:
                    agents_str = ", ".join(p["agents"])
                    print(f"  {p['name']} v{p['version']}  agents=[{agents_str}]")
            elif cmd == "routing":
                d = self.rc.dump()
                if not d["routing"]:
                    print("  (empty)")
                for agent, route in d["routing"].items():
                    print(f"  {agent:20s} → {route}")
            elif cmd == "dump":
                print(json.dumps(self.rc.dump(), indent=2))
            elif cmd == "pretty":
                print(self.rc.dump_pretty())
            else:
                print(f"  Unknown command: {cmd}. Type 'help' for available commands.")
