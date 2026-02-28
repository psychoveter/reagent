"""
Protocol Registry — M8a (Python mirror)

Tracks deployed protocols, their versions, fingerprints, and agent bindings.
Mirrors the TS ProtocolRegistry class.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .ir_fingerprint import ProtocolFingerprint, ProtocolDependency


@dataclass
class ProtocolEntry:
    name: str
    version: str
    fingerprints: ProtocolFingerprint
    dependencies: list[ProtocolDependency]
    ir_graphs: dict[str, dict[str, Any]]
    triggers: list[dict[str, Any]] = field(default_factory=list)
    invocable: bool = False
    registered_at: float = field(default_factory=time.time)


@dataclass
class DependencyConflict:
    dep_name: str
    expected_hash: str
    actual_hash: str


@dataclass
class CompatibilityReport:
    compatible: bool
    change_level: str  # "none" | "patch" | "minor" | "major"
    details: list[str]
    requires_agent_restart: bool
    affected_agents: list[str]
    dependency_conflicts: list[DependencyConflict]


class ProtocolRegistry:
    def __init__(self) -> None:
        self._protocols: dict[str, ProtocolEntry] = {}
        self._protocol_to_agents: dict[str, set[str]] = {}

    def register(self, entry: ProtocolEntry) -> None:
        self._protocols[entry.name] = entry

    def get(self, name: str) -> Optional[ProtocolEntry]:
        return self._protocols.get(name)

    def list(self) -> list[ProtocolEntry]:
        return list(self._protocols.values())

    def bind_agent(self, protocol_name: str, agent_name: str) -> None:
        agents = self._protocol_to_agents.setdefault(protocol_name, set())
        agents.add(agent_name)

    def agents_for_protocol(self, name: str) -> list[str]:
        return list(self._protocol_to_agents.get(name, set()))

    def can_deploy(self, new_entry: ProtocolEntry) -> CompatibilityReport:
        existing = self._protocols.get(new_entry.name)
        details: list[str] = []
        conflicts: list[DependencyConflict] = []

        if existing is None:
            return CompatibilityReport(
                compatible=True,
                change_level="none",
                details=["New protocol — no existing version"],
                requires_agent_restart=False,
                affected_agents=[],
                dependency_conflicts=[],
            )

        old_fp = existing.fingerprints
        new_fp = new_entry.fingerprints

        change_level = "none"
        if old_fp["structureHash"] != new_fp["structureHash"]:
            change_level = "major"
            details.append("Structure changed (choreography topology)")
        elif old_fp["schemaHash"] != new_fp["schemaHash"]:
            change_level = "minor"
            details.append("Schema changed (message types)")
        elif old_fp["implHash"] != new_fp["implHash"]:
            change_level = "patch"
            details.append("Implementation changed (zone bodies)")
        else:
            details.append("No changes detected")

        for dep in new_entry.dependencies:
            dep_entry = self._protocols.get(dep["protocolName"])
            if dep_entry and dep["structureHash"] and dep_entry.fingerprints["structureHash"] != dep["structureHash"]:
                conflicts.append(DependencyConflict(
                    dep_name=dep["protocolName"],
                    expected_hash=dep["structureHash"],
                    actual_hash=dep_entry.fingerprints["structureHash"],
                ))
                details.append(f"Dependency {dep['protocolName']}: structure hash mismatch")

        affected = self.agents_for_protocol(new_entry.name)
        requires_restart = change_level == "major" or len(conflicts) > 0
        compatible = change_level != "major" and len(conflicts) == 0

        return CompatibilityReport(
            compatible=compatible,
            change_level=change_level,
            details=details,
            requires_agent_restart=requires_restart,
            affected_agents=affected,
            dependency_conflicts=conflicts,
        )
