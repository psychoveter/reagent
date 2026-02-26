/**
 * RegistryView — aggregated actual state of protocols across RC cluster.
 *
 * Built by querying all connected RCs via ListProtocols RAP,
 * then merging into a unified view for the reconciler.
 */

import type { ProtocolFingerprint, ProtocolDependency } from "./types.js";

// ── Actual state ────────────────────────────────────────────────────

export interface RegistryView {
  /** Map of RC node IDs that contributed to this view */
  nodes: RegistryNodeInfo[];
  /** All known protocol instances across the cluster */
  protocols: RegistryProtocolEntry[];
  /** All running agents */
  agents: RegistryAgentEntry[];
  /** Timestamp when this view was built */
  timestamp: number;
}

export interface RegistryNodeInfo {
  nodeId: string;
  status: "connected" | "disconnected" | "unknown";
  lastSeen: number;
}

export interface RegistryProtocolEntry {
  name: string;
  version: string;
  fingerprints: ProtocolFingerprint;
  dependencies: ProtocolDependency[];
  /** Which RC node hosts this protocol */
  nodeId: string;
  /** Agents bound to this protocol on this node */
  boundAgents: string[];
}

export interface RegistryAgentEntry {
  agentName: string;
  roleName: string;
  protocolName: string;
  nodeId: string;
  status: "running" | "stopped" | "error" | "deploying";
}

// ── Builder ─────────────────────────────────────────────────────────

export function createEmptyView(): RegistryView {
  return {
    nodes: [],
    protocols: [],
    agents: [],
    timestamp: Date.now(),
  };
}

/**
 * Merge a single RC's protocol list into the view.
 * Called once per connected RC during view collection.
 */
export function mergeNodeProtocols(
  view: RegistryView,
  nodeId: string,
  protocols: Array<{
    name: string;
    version: string;
    fingerprints: ProtocolFingerprint;
    dependencies: ProtocolDependency[];
    boundAgents: string[];
  }>,
): void {
  const existingNode = view.nodes.find(n => n.nodeId === nodeId);
  if (existingNode) {
    existingNode.status = "connected";
    existingNode.lastSeen = Date.now();
  } else {
    view.nodes.push({ nodeId, status: "connected", lastSeen: Date.now() });
  }

  for (const proto of protocols) {
    const existing = view.protocols.find(
      p => p.name === proto.name && p.nodeId === nodeId
    );
    if (existing) {
      existing.version = proto.version;
      existing.fingerprints = proto.fingerprints;
      existing.dependencies = proto.dependencies;
      existing.boundAgents = proto.boundAgents;
    } else {
      view.protocols.push({
        ...proto,
        nodeId,
      });
    }
  }
}

/**
 * Find all entries for a given protocol across the cluster.
 */
export function findProtocol(view: RegistryView, name: string): RegistryProtocolEntry[] {
  return view.protocols.filter(p => p.name === name);
}

/**
 * Find all agents for a given protocol/role combination.
 */
export function findAgents(
  view: RegistryView,
  protocolName: string,
  roleName?: string,
): RegistryAgentEntry[] {
  return view.agents.filter(a =>
    a.protocolName === protocolName && (!roleName || a.roleName === roleName),
  );
}
