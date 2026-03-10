/**
 * EtcdMembership — node presence and agent-to-node routing via StateStore.
 *
 * Manages:
 * - Node presence: lease-based key at /nodes/{nodeId}
 * - Agent routing: watches /agents/ prefix, resolves nodeId from AgentRegistration,
 *   and calls back so the RC can update its routing table.
 */

import type { StateStore, Lease, Disposable } from "./state-store.js";
import type { AgentRegistration } from "./state-store-agent-registry.js";

export interface EtcdMembershipConfig {
  stateStore: StateStore;
  nodeId: string;
  /** Lease TTL for node presence in seconds. Default: 15 */
  leaseTtlSeconds?: number;
  /** Keepalive interval in ms. Default: leaseTtl / 3 */
  keepAliveIntervalMs?: number;
  /** Called when a remote agent is discovered/updated (nodeId !== local). */
  onRemoteAgent?: (agentName: string, nodeId: string) => void;
  /** Called when a remote agent is removed. */
  onRemoteAgentRemoved?: (agentName: string) => void;
  /** Called when a remote node joins. */
  onNodeJoin?: (nodeId: string) => void;
  /** Called when a remote node leaves. */
  onNodeLeave?: (nodeId: string) => void;
}

const NODES_PREFIX = "/nodes/";
const AGENTS_PREFIX = "/agents/";

export class EtcdMembership {
  private store: StateStore;
  private nodeId: string;
  private leaseTtlSeconds: number;
  private keepAliveIntervalMs: number;
  private onRemoteAgent?: (agentName: string, nodeId: string) => void;
  private onRemoteAgentRemoved?: (agentName: string) => void;
  private onNodeJoin?: (nodeId: string) => void;
  private onNodeLeave?: (nodeId: string) => void;

  private lease: Lease | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private nodeWatcher: Disposable | null = null;
  private agentWatcher: Disposable | null = null;
  private knownNodes = new Set<string>();
  private stopped = false;

  constructor(config: EtcdMembershipConfig) {
    this.store = config.stateStore;
    this.nodeId = config.nodeId;
    this.leaseTtlSeconds = config.leaseTtlSeconds ?? 15;
    this.keepAliveIntervalMs = config.keepAliveIntervalMs ?? Math.floor((this.leaseTtlSeconds * 1000) / 3);
    this.onRemoteAgent = config.onRemoteAgent;
    this.onRemoteAgentRemoved = config.onRemoteAgentRemoved;
    this.onNodeJoin = config.onNodeJoin;
    this.onNodeLeave = config.onNodeLeave;
  }

  async start(): Promise<void> {
    this.stopped = false;

    // Register this node with a lease
    this.lease = await this.store.createLease(this.leaseTtlSeconds);
    await this.store.put(NODES_PREFIX + this.nodeId, JSON.stringify({
      nodeId: this.nodeId,
      startedAt: new Date().toISOString(),
    }), { lease: this.lease.id });

    // Keepalive loop
    this.keepAliveTimer = setInterval(() => {
      if (this.lease && !this.stopped) {
        this.lease.keepAlive().catch((err) => {
          console.warn(`[EtcdMembership] keepAlive failed for node ${this.nodeId}:`, err);
        });
      }
    }, this.keepAliveIntervalMs);

    // Load existing nodes
    const existingNodes = await this.store.list(NODES_PREFIX);
    for (const entry of existingNodes) {
      const id = entry.key.slice(NODES_PREFIX.length);
      if (id && id !== this.nodeId) {
        this.knownNodes.add(id);
        this.onNodeJoin?.(id);
      }
    }

    // Watch for node changes
    this.nodeWatcher = this.store.watch(NODES_PREFIX, (event) => {
      const id = event.key.slice(NODES_PREFIX.length);
      if (!id || id === this.nodeId) return;

      if (event.kind === "put") {
        if (!this.knownNodes.has(id)) {
          this.knownNodes.add(id);
          this.onNodeJoin?.(id);
        }
      } else if (event.kind === "delete") {
        if (this.knownNodes.has(id)) {
          this.knownNodes.delete(id);
          this.onNodeLeave?.(id);
        }
      }
    });

    // Load existing agents and set up routing for remote ones
    const existingAgents = await this.store.list(AGENTS_PREFIX);
    for (const entry of existingAgents) {
      const val = typeof entry.value === "string" ? entry.value : entry.value.toString("utf8");
      try {
        const reg = JSON.parse(val) as AgentRegistration;
        if (reg.nodeId && reg.nodeId !== this.nodeId) {
          this.onRemoteAgent?.(reg.name, reg.nodeId);
        }
      } catch { /* skip corrupt */ }
    }

    // Watch agent changes for routing updates
    this.agentWatcher = this.store.watch(AGENTS_PREFIX, (event) => {
      const agentName = event.key.slice(AGENTS_PREFIX.length);
      if (!agentName) return;

      if (event.kind === "put" && event.value != null) {
        const val = typeof event.value === "string" ? event.value : event.value.toString("utf8");
        try {
          const reg = JSON.parse(val) as AgentRegistration;
          if (reg.nodeId && reg.nodeId !== this.nodeId) {
            this.onRemoteAgent?.(reg.name, reg.nodeId);
          }
        } catch { /* ignore */ }
      } else if (event.kind === "delete") {
        this.onRemoteAgentRemoved?.(agentName);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    this.nodeWatcher?.dispose();
    this.nodeWatcher = null;

    this.agentWatcher?.dispose();
    this.agentWatcher = null;

    if (this.lease) {
      try { await this.lease.revoke(); } catch { /* best effort */ }
      this.lease = null;
    }
  }

  getKnownNodes(): string[] {
    return Array.from(this.knownNodes);
  }
}
