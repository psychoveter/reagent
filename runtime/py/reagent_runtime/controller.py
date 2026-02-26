"""
ReagentController — Python-native routing and agent orchestration core.

Mirrors the TS ReagentController.  One RC per process.  Manages:
- Agent registry (which agents live on this node)
- Routing table (agentName → "local"; extensible to remote NodeRefs)
- Transport factory (per-agent InprocTransport)
- Interceptor chain (message-level middleware)
- Lifecycle (start / stop all agents)

Usage::

    rc = ReagentController(node_id="sim")
    rc.add_agent_node("py", InprocAgentNode(role_to_agent=rta))
    rc.register_agent("A", role_ir_a, graphs_a)
    rc.register_agent("B", role_ir_b, graphs_b)
    await rc.start()
    rc.trigger_protocol("A", trigger)
    ...
    await rc.stop()
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Callable, Optional

from .agent_node import AgentHandle, AgentNode
from .inproc_transport import InprocTransport
from .protocol_registry import ProtocolRegistry, ProtocolEntry
from .ir_fingerprint import read_protocol_fingerprint, read_protocol_version, read_protocol_dependencies
from .agent_manifest import load_agent_manifest, load_agent_module

log = logging.getLogger(__name__)

MessageDirection = str  # "loopback" | "outbound" | "inbound"


class InterceptorContext:
    __slots__ = ("envelope", "direction", "node_id")

    def __init__(self, envelope: dict[str, Any], direction: MessageDirection, node_id: str) -> None:
        self.envelope = envelope
        self.direction = direction
        self.node_id = node_id


InterceptorFn = Callable[[InterceptorContext, Callable[[], None]], None]


class ReagentController:
    """Python-native multi-agent orchestrator."""

    def __init__(
        self,
        node_id: str = "py-node",
        agent_node: Optional[AgentNode] = None,
        agent_nodes: Optional[dict[str, AgentNode]] = None,
        interceptors: Optional[list[InterceptorFn]] = None,
    ) -> None:
        self.node_id = node_id

        self._agent_nodes: dict[str, AgentNode] = {}
        if agent_nodes:
            self._agent_nodes.update(agent_nodes)
        if agent_node:
            self._agent_nodes.setdefault("py", agent_node)

        self._interceptors: list[InterceptorFn] = list(interceptors or [])

        self.registry = ProtocolRegistry()

        self._agents: dict[str, AgentHandle] = {}
        self._agent_owners: dict[str, AgentNode] = {}
        self._routing_table: dict[str, str] = {}  # agent_name → "local"

    # ── Agent node management ─────────────────────────────────────

    def add_agent_node(self, lang: str, node: AgentNode) -> None:
        self._agent_nodes[lang] = node

    # ── Agent registry ────────────────────────────────────────────

    def register_agent(
        self,
        agent_name: str,
        role_ir: dict[str, Any],
        graphs: dict[str, dict[str, Any]],
        extras: Optional[dict[str, Any]] = None,
        protocol_version: Optional[str] = None,
    ) -> None:
        lang = role_ir.get("lang") or "py"
        node = self._agent_nodes.get(lang) or self._agent_nodes.get("*")
        if not node:
            raise RuntimeError(
                f"[RC {self.node_id}] No AgentNode for lang '{lang}' (agent {agent_name}). "
                f"Available: {list(self._agent_nodes.keys())}"
            )

        transport = self._create_transport(agent_name)
        handle = node.create_agent(agent_name, role_ir, graphs, transport, extras)
        self._agents[agent_name] = handle
        self._agent_owners[agent_name] = node
        self._routing_table[agent_name] = "local"

        registered_protos: set[str] = set()
        for graph in graphs.values():
            proto_name = graph.get("protocolName", "")
            if proto_name in registered_protos:
                continue
            registered_protos.add(proto_name)

            proto_graphs = {k: g for k, g in graphs.items() if g.get("protocolName") == proto_name}
            fp = read_protocol_fingerprint(graph)
            version = protocol_version or read_protocol_version(graph) or "0.0.0"
            self.registry.register(ProtocolEntry(
                name=proto_name,
                version=version,
                fingerprints=fp or {"structureHash": "", "schemaHash": "", "implHash": ""},
                dependencies=read_protocol_dependencies(graph),
                ir_graphs=proto_graphs,
            ))
            self.registry.bind_agent(proto_name, agent_name)

    def load(self, ir_dir: str) -> dict[str, str]:
        """Load all agents from a compiled IR directory.

        Reads deployment.json, loads role IRs and protocol graphs for each
        agent, resolves agent.json manifests (injecting $agent native modules),
        and registers everything.

        Returns the roleToAgent mapping from deployment.json.
        """
        deployment_path = os.path.join(ir_dir, "deployment.json")
        if not os.path.exists(deployment_path):
            raise FileNotFoundError(f"deployment.json not found in {ir_dir}")

        with open(deployment_path) as f:
            deployment = json.load(f)

        role_to_agent: dict[str, str] = deployment.get("roleToAgent", {})

        for node in self._agent_nodes.values():
            if hasattr(node, "_role_to_agent"):
                node._role_to_agent.update(role_to_agent)

        for agent_entry in deployment.get("agents", []):
            agent_name = agent_entry["agentName"]
            if self.has_agent(agent_name):
                continue

            role_ir_file = agent_entry["roleIRFile"]
            with open(os.path.join(ir_dir, role_ir_file)) as f:
                role_ir = json.load(f)

            graphs: dict[str, Any] = {}
            for role_entry in agent_entry.get("roles", []):
                graph_key = f"{role_entry['protocolName']}.{role_entry['roleName']}"
                with open(os.path.join(ir_dir, role_entry["irGraphFile"])) as f:
                    graphs[graph_key] = json.load(f)

            extras: Optional[dict[str, Any]] = None
            role_name_lower = agent_entry.get("roleName", "").lower()
            agent_name_lower = agent_name.lower()
            agent_base_lower = agent_name_lower.rstrip("0123456789")
            agents_dir = os.path.join(ir_dir, "..", "agents")
            manifest_candidates = [
                os.path.join(ir_dir, f"{agent_name}.manifest.json"),
                os.path.join(agents_dir, agent_name_lower, "agent.json"),
                os.path.join(agents_dir, agent_base_lower, "agent.json"),
                os.path.join(agents_dir, role_name_lower, "agent.json"),
                os.path.join(agents_dir, f"{agent_name_lower}.agent.json"),
            ]
            for mp in manifest_candidates:
                if os.path.exists(mp):
                    manifest = load_agent_manifest(mp)
                    module_obj = load_agent_module(mp, manifest)
                    if module_obj is not None:
                        extras = module_obj
                    break

            self.register_agent(agent_name, role_ir, graphs, extras)

        return role_to_agent

    async def destroy_agent(self, agent_name: str) -> None:
        handle = self._agents.get(agent_name)
        if not handle:
            return
        owner = self._agent_owners.get(agent_name)
        if owner:
            await owner.destroy_agent(handle)
        else:
            await handle.stop()
        self._agents.pop(agent_name, None)
        self._agent_owners.pop(agent_name, None)
        self._routing_table.pop(agent_name, None)

    def has_agent(self, agent_name: str) -> bool:
        return agent_name in self._agents

    def get_agent(self, agent_name: str) -> Optional[AgentHandle]:
        return self._agents.get(agent_name)

    # ── Protocol registry convenience ──────────────────────────────

    def list_protocols(self) -> list[ProtocolEntry]:
        return self.registry.list()

    def handle_list_protocols_rap(self, request_id: str) -> dict[str, Any]:
        """Handle RAP ListProtocols request and return response payload."""
        entries = self.registry.list()
        return {
            "requestId": request_id,
            "nodeId": self.node_id,
            "protocols": [
                {
                    "name": e.name,
                    "version": e.version,
                    "fingerprints": e.fingerprints,
                    "dependencies": e.dependencies,
                    "boundAgents": self.registry.agents_for_protocol(e.name),
                }
                for e in entries
            ],
        }

    # ── Introspection ──────────────────────────────────────────────

    def dump(self) -> dict[str, Any]:
        """Return a structured snapshot of the controller's internal tables."""
        agents_info = []
        for name, handle in self._agents.items():
            owner = self._agent_owners.get(name)
            owner_lang = "?"
            for lang, node in self._agent_nodes.items():
                if node is owner:
                    owner_lang = lang
                    break
            agents_info.append({
                "name": name,
                "lang": owner_lang,
                "route": self._routing_table.get(name, "?"),
            })

        protocols_info = []
        for entry in self.registry.list():
            protocols_info.append({
                "name": entry.name,
                "version": entry.version,
                "agents": self.registry.agents_for_protocol(entry.name),
                "graphs": list(entry.ir_graphs.keys()),
            })

        routing = dict(self._routing_table)

        return {
            "nodeId": self.node_id,
            "agents": agents_info,
            "protocols": protocols_info,
            "routing": routing,
            "agentNodes": list(self._agent_nodes.keys()),
        }

    def dump_pretty(self) -> str:
        """Return a human-readable summary of the controller's state."""
        d = self.dump()
        lines = [f"=== RC [{d['nodeId']}] ==="]

        lines.append(f"\nAgent nodes: {', '.join(d['agentNodes']) or '(none)'}")

        lines.append(f"\nAgents ({len(d['agents'])}):")
        for a in d["agents"]:
            lines.append(f"  {a['name']:20s}  lang={a['lang']}  route={a['route']}")

        lines.append(f"\nProtocols ({len(d['protocols'])}):")
        for p in d["protocols"]:
            lines.append(f"  {p['name']} v{p['version']}")
            lines.append(f"    agents: {', '.join(p['agents'])}")
            lines.append(f"    graphs: {', '.join(p['graphs'])}")

        lines.append(f"\nRouting table ({len(d['routing'])}):")
        for agent, route in d["routing"].items():
            lines.append(f"  {agent:20s} → {route}")

        return "\n".join(lines)

    # ── Interceptor chain ─────────────────────────────────────────

    def add_interceptor(self, fn: InterceptorFn) -> None:
        self._interceptors.append(fn)

    # ── Lifecycle ─────────────────────────────────────────────────

    async def start(self) -> None:
        for handle in self._agents.values():
            await handle.start()

    async def stop(self) -> None:
        for handle in self._agents.values():
            await handle.stop()

    def set_advance_hook(self, hook: Any) -> None:
        """Propagate advance hook to all agent node backends."""
        for node in self._agent_nodes.values():
            if hasattr(node, "set_advance_hook"):
                node.set_advance_hook(hook)

    # ── External trigger ──────────────────────────────────────────

    def trigger_protocol(self, agent_name: str, trigger: dict[str, Any]) -> None:
        handle = self._agents.get(agent_name)
        if not handle:
            log.warning("[RC %s] triggerProtocol: no local agent %s", self.node_id, agent_name)
            return
        handle.trigger_protocol(trigger)

    # ── Transport factory ─────────────────────────────────────────

    def _create_transport(self, agent_name: str) -> InprocTransport:
        return InprocTransport(
            agent_name=agent_name,
            route_callback=self._route_envelope,
            trace_callback=self._handle_trace,
        )

    # ── Internal routing ──────────────────────────────────────────

    def _route_envelope(self, envelope: dict[str, Any]) -> None:
        target_agent = envelope.get("to", {}).get("agent")
        if not target_agent:
            log.warning("[RC %s] Envelope missing to.agent", self.node_id)
            return

        route = self._routing_table.get(target_agent)
        if not route:
            if hasattr(self, "_route_envelope_remote"):
                self._route_envelope_remote(envelope)
            else:
                log.warning("[RC %s] No route for agent %s", self.node_id, target_agent)
            return

        direction: MessageDirection = "loopback" if route == "local" else "outbound"

        self._run_interceptors(envelope, direction, lambda: self._dispatch_local(envelope))

    def _dispatch_local(self, envelope: dict[str, Any]) -> None:
        target_agent = envelope["to"]["agent"]
        handle = self._agents.get(target_agent)
        if handle:
            handle.dispatch_message(envelope)
        else:
            log.warning("[RC %s] No agent for %s", self.node_id, target_agent)

    def _handle_trace(self, event: dict[str, Any]) -> None:
        pass

    def _run_interceptors(
        self,
        envelope: dict[str, Any],
        direction: MessageDirection,
        deliver: Callable[[], None],
    ) -> None:
        if not self._interceptors:
            deliver()
            return

        ctx = InterceptorContext(envelope, direction, self.node_id)
        idx = 0

        def next_fn() -> None:
            nonlocal idx
            if idx < len(self._interceptors):
                fn = self._interceptors[idx]
                idx += 1
                fn(ctx, next_fn)
            else:
                deliver()

        next_fn()
