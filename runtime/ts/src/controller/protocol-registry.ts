/**
 * Protocol Registry — M8a
 *
 * Tracks deployed protocols, their versions, fingerprints, and agent bindings.
 * Provides compatibility checking for protocol upgrades.
 */

import type { IRGraph, TriggerIR, ProtocolFingerprint, ProtocolDependency } from "../contracts/types.js";

// ── Types ───────────────────────────────────────────────────────────

export interface ProtocolEntry {
  name: string;
  version: string;
  fingerprints: ProtocolFingerprint;
  dependencies: ProtocolDependency[];
  irGraphs: Map<string, IRGraph>;
  triggers: TriggerIR[];
  invocable: boolean;
  registeredAt: number;
}

export interface CompatibilityReport {
  compatible: boolean;
  changeLevel: "none" | "patch" | "minor" | "major";
  details: string[];
  requiresAgentRestart: boolean;
  affectedAgents: string[];
  dependencyConflicts: Array<{
    depName: string;
    expectedHash: string;
    actualHash: string;
  }>;
}

// ── Registry ────────────────────────────────────────────────────────

export class ProtocolRegistry {
  private protocols = new Map<string, ProtocolEntry>();
  private protocolToAgents = new Map<string, Set<string>>();

  register(entry: ProtocolEntry): void {
    this.protocols.set(entry.name, entry);
  }

  get(name: string): ProtocolEntry | undefined {
    return this.protocols.get(name);
  }

  list(): ProtocolEntry[] {
    return [...this.protocols.values()];
  }

  bindAgent(protocolName: string, agentName: string): void {
    let agents = this.protocolToAgents.get(protocolName);
    if (!agents) {
      agents = new Set();
      this.protocolToAgents.set(protocolName, agents);
    }
    agents.add(agentName);
  }

  unbindAgent(protocolName: string, agentName: string): void {
    const agents = this.protocolToAgents.get(protocolName);
    if (!agents) return;
    agents.delete(agentName);
    if (agents.size === 0) {
      this.protocolToAgents.delete(protocolName);
    }
  }

  agentsForProtocol(name: string): string[] {
    return [...(this.protocolToAgents.get(name) ?? [])];
  }

  canDeploy(newEntry: ProtocolEntry): CompatibilityReport {
    const existing = this.protocols.get(newEntry.name);
    const details: string[] = [];
    const dependencyConflicts: CompatibilityReport["dependencyConflicts"] = [];

    if (!existing) {
      return {
        compatible: true,
        changeLevel: "none",
        details: ["New protocol — no existing version"],
        requiresAgentRestart: false,
        affectedAgents: [],
        dependencyConflicts: [],
      };
    }

    const oldFP = existing.fingerprints;
    const newFP = newEntry.fingerprints;

    let changeLevel: CompatibilityReport["changeLevel"] = "none";

    if (oldFP.structureHash !== newFP.structureHash) {
      changeLevel = "major";
      details.push("Structure changed (choreography topology)");
    } else if (oldFP.schemaHash !== newFP.schemaHash) {
      changeLevel = "minor";
      details.push("Schema changed (message types)");
    } else if (oldFP.implHash !== newFP.implHash) {
      changeLevel = "patch";
      details.push("Implementation changed (zone bodies)");
    } else {
      details.push("No changes detected");
    }

    // Check dependency compatibility
    for (const dep of newEntry.dependencies) {
      const depEntry = this.protocols.get(dep.protocolName);
      if (depEntry && dep.structureHash && depEntry.fingerprints.structureHash !== dep.structureHash) {
        dependencyConflicts.push({
          depName: dep.protocolName,
          expectedHash: dep.structureHash,
          actualHash: depEntry.fingerprints.structureHash,
        });
        details.push(`Dependency ${dep.protocolName}: structure hash mismatch`);
      }
    }

    const affected = this.agentsForProtocol(newEntry.name);
    const requiresRestart = changeLevel === "major" || dependencyConflicts.length > 0;
    const compatible = changeLevel !== "major" && dependencyConflicts.length === 0;

    return {
      compatible,
      changeLevel,
      details,
      requiresAgentRestart: requiresRestart,
      affectedAgents: affected,
      dependencyConflicts,
    };
  }
}
