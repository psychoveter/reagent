/**
 * Reconciler — desired-state convergence engine.
 *
 * Compares a DeploySpec (desired) against a RegistryView (actual)
 * and produces a ReconciliationPlan of ordered actions to converge.
 */

import type { DeploySpec } from "./deploy-spec.js";
import type { RegistryView } from "./registry-view.js";

export type ReconciliationAction =
  | DeployProtocolAction
  | UpgradeProtocolAction
  | CreateAgentAction
  | StopAgentAction
  | MoveAgentAction;

export interface DeployProtocolAction {
  kind: "deploy-protocol";
  protocolName: string;
  version: string;
  targetNode: string;
  artifactsPath?: string;
}

export interface UpgradeProtocolAction {
  kind: "upgrade-protocol";
  protocolName: string;
  fromVersion: string;
  toVersion: string;
  targetNode: string;
  artifactsPath?: string;
}

export interface CreateAgentAction {
  kind: "create-agent";
  agentName: string;
  roleName: string;
  protocolName: string;
  targetNode: string;
  manifest?: string;
  extras?: Record<string, unknown>;
}

export interface StopAgentAction {
  kind: "stop-agent";
  agentName: string;
  nodeId: string;
}

export interface MoveAgentAction {
  kind: "move-agent";
  agentName: string;
  roleName: string;
  protocolName: string;
  fromNode: string;
  toNode: string;
}

export interface ReconciliationPlan {
  deploymentId: string;
  actions: ReconciliationAction[];
  conflicts: ReconciliationConflict[];
  timestamp: number;
}

export interface ReconciliationConflict {
  kind: "incompatible-upgrade" | "missing-dependency" | "no-available-node";
  message: string;
  protocolName?: string;
  details?: Record<string, unknown>;
}

export function reconcile(spec: DeploySpec, view: RegistryView): ReconciliationPlan {
  const actions: ReconciliationAction[] = [];
  const conflicts: ReconciliationConflict[] = [];

  const defaultNode = view.nodes.find(n => n.status === "connected")?.nodeId ?? "local";

  for (const protoSpec of spec.protocols) {
    const existing = view.protocols.filter(p => p.name === protoSpec.name);

    if (existing.length === 0) {
      actions.push({
        kind: "deploy-protocol",
        protocolName: protoSpec.name,
        version: protoSpec.version,
        targetNode: defaultNode,
        artifactsPath: protoSpec.artifactsPath,
      });
    } else {
      for (const entry of existing) {
        if (entry.version !== protoSpec.version) {
          if (entry.fingerprints.structureHash === protoSpec.fingerprints.structureHash) {
            actions.push({
              kind: "upgrade-protocol",
              protocolName: protoSpec.name,
              fromVersion: entry.version,
              toVersion: protoSpec.version,
              targetNode: entry.nodeId,
              artifactsPath: protoSpec.artifactsPath,
            });
          } else {
            conflicts.push({
              kind: "incompatible-upgrade",
              message: `Protocol "${protoSpec.name}" structure changed (${entry.version} → ${protoSpec.version}). Manual migration required.`,
              protocolName: protoSpec.name,
              details: {
                existingStructureHash: entry.fingerprints.structureHash,
                desiredStructureHash: protoSpec.fingerprints.structureHash,
              },
            });
          }
        }
      }
    }
  }

  const specAgentNames = new Set(spec.agents.map(a => a.agentName));

  for (const agentSpec of spec.agents) {
    const existing = view.agents.find(
      a => a.agentName === agentSpec.agentName && a.protocolName === agentSpec.protocolName,
    );

    if (!existing) {
      const targetNode = agentSpec.targetNode ?? defaultNode;
      actions.push({
        kind: "create-agent",
        agentName: agentSpec.agentName,
        roleName: agentSpec.roleName,
        protocolName: agentSpec.protocolName,
        targetNode,
        manifest: agentSpec.manifest,
        extras: agentSpec.extras,
      });
    } else if (agentSpec.targetNode && existing.nodeId !== agentSpec.targetNode) {
      actions.push({
        kind: "move-agent",
        agentName: agentSpec.agentName,
        roleName: agentSpec.roleName,
        protocolName: agentSpec.protocolName,
        fromNode: existing.nodeId,
        toNode: agentSpec.targetNode,
      });
    }
  }

  for (const agent of view.agents) {
    if (agent.status === "running" && !specAgentNames.has(agent.agentName)) {
      actions.push({
        kind: "stop-agent",
        agentName: agent.agentName,
        nodeId: agent.nodeId,
      });
    }
  }

  for (const protoSpec of spec.protocols) {
    if (!protoSpec.dependencies) continue;
    for (const dep of protoSpec.dependencies) {
      const depInSpec = spec.protocols.find(p => p.name === dep.protocolName);
      const depInView = view.protocols.find(p => p.name === dep.protocolName);
      if (!depInSpec && !depInView) {
        conflicts.push({
          kind: "missing-dependency",
          message: `Protocol "${protoSpec.name}" depends on "${dep.protocolName}" which is neither in spec nor deployed.`,
          protocolName: protoSpec.name,
        });
      }
    }
  }

  const sorted = topologicalSort(actions, spec);

  return {
    deploymentId: spec.deploymentId,
    actions: sorted,
    conflicts,
    timestamp: Date.now(),
  };
}

function topologicalSort(actions: ReconciliationAction[], spec: DeploySpec): ReconciliationAction[] {
  const deployProtocols = actions.filter(a => a.kind === "deploy-protocol" || a.kind === "upgrade-protocol");
  const createAgents = actions.filter(a => a.kind === "create-agent");
  const stopAgents = actions.filter(a => a.kind === "stop-agent");
  const moveAgents = actions.filter(a => a.kind === "move-agent");

  const depGraph = new Map<string, string[]>();
  for (const ps of spec.protocols) {
    depGraph.set(ps.name, (ps.dependencies ?? []).map(d => d.protocolName));
  }

  const sortedProtocols = topoSortByDeps(
    deployProtocols,
    (a) => {
      if (a.kind === "deploy-protocol") return a.protocolName;
      if (a.kind === "upgrade-protocol") return a.protocolName;
      return "";
    },
    depGraph,
  );

  return [...stopAgents, ...sortedProtocols, ...createAgents, ...moveAgents];
}

function topoSortByDeps<T>(
  items: T[],
  getName: (item: T) => string,
  depGraph: Map<string, string[]>,
): T[] {
  const sorted: T[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byName = new Map<string, T>();

  for (const item of items) {
    byName.set(getName(item), item);
  }

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) return;
    visiting.add(name);
    const deps = depGraph.get(name) ?? [];
    for (const dep of deps) {
      if (byName.has(dep)) visit(dep);
    }
    visited.add(name);
    visiting.delete(name);
    const item = byName.get(name);
    if (item) sorted.push(item);
  }

  for (const item of items) {
    visit(getName(item));
  }

  return sorted;
}

export function planSummary(plan: ReconciliationPlan): string {
  const lines: string[] = [`Reconciliation plan for "${plan.deploymentId}":`];
  for (const action of plan.actions) {
    switch (action.kind) {
      case "deploy-protocol":
        lines.push(`  + Deploy ${action.protocolName} v${action.version} → ${action.targetNode}`);
        break;
      case "upgrade-protocol":
        lines.push(`  ↑ Upgrade ${action.protocolName} ${action.fromVersion} → ${action.toVersion} on ${action.targetNode}`);
        break;
      case "create-agent":
        lines.push(`  + Create agent ${action.agentName} (${action.roleName}) → ${action.targetNode}`);
        break;
      case "stop-agent":
        lines.push(`  - Stop agent ${action.agentName} on ${action.nodeId}`);
        break;
      case "move-agent":
        lines.push(`  → Move agent ${action.agentName} from ${action.fromNode} → ${action.toNode}`);
        break;
    }
  }
  if (plan.conflicts.length > 0) {
    lines.push("  Conflicts:");
    for (const c of plan.conflicts) {
      lines.push(`    ✗ ${c.message}`);
    }
  }
  return lines.join("\n");
}
