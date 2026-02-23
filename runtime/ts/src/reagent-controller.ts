/**
 * ReagentController — routing and interception core.
 *
 * One RC per node process. Manages:
 * - Agent registry (which agents live on this node)
 * - Routing table (agentName → NodeRef)
 * - Transport factory (per-agent ReagentTransport)
 * - Interceptor chain (message-level)
 * - NodeLink management
 */

import type { MessageEnvelope, IRGraph, RoleIR, ProtocolTrigger } from "./types.js";
import { createMessageEnvelope } from "./types.js";
import type { NodeRef, AgentRef, ReagentTransport, NodeLink } from "./transport.js";
import type { AgentNode, AgentHandle } from "./agent-node.js";
import type { InterceptorFn, InterceptorContext, MessageDirection, AddressPage } from "./interceptor.js";
import { ProtocolRegistry, type ProtocolEntry, type CompatibilityReport } from "./protocol-registry.js";

// ── Configuration ───────────────────────────────────────────────────

export interface ReagentControllerConfig {
  nodeId: string;
  /** Single AgentNode (backward compat) — treated as the "ts" backend. */
  agentNode?: AgentNode;
  /** Multiple AgentNode backends keyed by language tag ("ts", "py", …). */
  agentNodes?: Record<string, AgentNode>;
  interceptors?: InterceptorFn[];
}

// ── Controller ──────────────────────────────────────────────────────

export class ReagentController {
  readonly nodeId: string;
  readonly registry: ProtocolRegistry;

  /** lang → AgentNode backend */
  private agentNodes: Record<string, AgentNode>;
  private interceptors: InterceptorFn[];

  /** agentName → AgentHandle (local agents on this node) */
  private agents = new Map<string, AgentHandle>();
  /** agentName → AgentNode that created the handle (for destroyAgent) */
  private agentOwners = new Map<string, AgentNode>();
  /** agentName → message handler registered via transport.onMessage() */
  private messageHandlers = new Map<string, (env: MessageEnvelope) => void>();
  /** agentName → NodeRef (routing table: local → loopbackRef, remote → link-backed NodeRef) */
  private routingTable = new Map<string, NodeRef>();
  /** remoteNodeId → NodeRef wrapping the NodeLink */
  private nodeRefs = new Map<string, NodeRef>();
  /** NodeLinks managed by this controller */
  private links: NodeLink[] = [];

  private loopbackRef: NodeRef;

  constructor(config: ReagentControllerConfig) {
    this.nodeId = config.nodeId;

    if (config.agentNodes) {
      this.agentNodes = { ...config.agentNodes };
    } else if (config.agentNode) {
      this.agentNodes = { ts: config.agentNode };
    } else {
      throw new Error("ReagentControllerConfig must provide agentNode or agentNodes");
    }

    this.interceptors = [...(config.interceptors ?? [])];
    this.registry = new ProtocolRegistry();

    this.loopbackRef = {
      nodeId: this.nodeId,
      send: (envelope) => this.loopbackDeliver(envelope),
    };
  }

  // ── Agent registry ──────────────────────────────────────────────

  registerAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    extras?: Record<string, unknown>,
  ): void {
    const lang = (roleIR.lang ?? "ts") as string;
    const node = this.agentNodes[lang];
    if (!node) {
      throw new Error(
        `[RC ${this.nodeId}] No AgentNode registered for lang "${lang}" (agent ${agentName}). ` +
        `Available: ${Object.keys(this.agentNodes).join(", ")}`,
      );
    }

    const transport = this.createTransport(agentName);
    const handle = node.createAgent(agentName, roleIR, graphs, transport, extras);
    this.agents.set(agentName, handle);
    this.agentOwners.set(agentName, node);
    this.routingTable.set(agentName, this.loopbackRef);

    // Populate protocol registry from agent's graphs
    const registeredProtos = new Set<string>();
    for (const graph of graphs.values()) {
      const protoName = graph.protocolName;
      if (registeredProtos.has(protoName)) continue;
      registeredProtos.add(protoName);

      if (!this.registry.get(protoName)) {
        const protoGraphs = new Map<string, IRGraph>();
        for (const [key, g] of graphs) {
          if (g.protocolName === protoName) protoGraphs.set(key, g);
        }
        this.registry.register({
          name: protoName,
          version: graph.version ?? "0.0.0",
          fingerprints: graph.fingerprints ?? { structureHash: "", schemaHash: "", implHash: "" },
          dependencies: graph.dependencies ?? [],
          irGraphs: protoGraphs,
          registeredAt: Date.now(),
        });
      }
      this.registry.bindAgent(protoName, agentName);
    }
  }

  spawnAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    extras?: Record<string, unknown>,
  ): void {
    this.registerAgent(agentName, roleIR, graphs, extras);
    const handle = this.agents.get(agentName)!;
    handle.start();
  }

  async destroyAgent(agentName: string): Promise<void> {
    const handle = this.agents.get(agentName);
    if (!handle) return;
    const owner = this.agentOwners.get(agentName);
    if (owner) {
      await owner.destroyAgent(handle);
    } else {
      await handle.stop();
    }
    this.agents.delete(agentName);
    this.agentOwners.delete(agentName);
    this.messageHandlers.delete(agentName);
    this.routingTable.delete(agentName);
  }

  hasAgent(agentName: string): boolean {
    return this.agents.has(agentName);
  }

  getAgent(agentName: string): AgentHandle | undefined {
    return this.agents.get(agentName);
  }

  // ── Protocol registry convenience ──────────────────────────────

  listProtocols(): ProtocolEntry[] {
    return this.registry.list();
  }

  canDeploy(entry: ProtocolEntry): CompatibilityReport {
    return this.registry.canDeploy(entry);
  }

  // ── Interceptor chain ───────────────────────────────────────────

  addInterceptor(interceptor: InterceptorFn): void {
    this.interceptors.push(interceptor);
  }

  // ── NodeLink management ─────────────────────────────────────────

  addNodeLink(link: NodeLink): void {
    this.links.push(link);

    const remoteRef: NodeRef = {
      nodeId: link.remoteNodeId,
      send: (envelope) => link.send(envelope),
    };
    this.nodeRefs.set(link.remoteNodeId, remoteRef);

    link.onEnvelope((envelope) => {
      this.runInterceptors(envelope, "inbound", () => {
        this.dispatchLocal(envelope);
      });
    });
  }

  registerRemoteAgent(agentName: string, remoteNodeId: string): void {
    const nodeRef = this.nodeRefs.get(remoteNodeId);
    if (!nodeRef) {
      throw new Error(`No NodeLink to ${remoteNodeId} — cannot route to ${agentName}`);
    }
    this.routingTable.set(agentName, nodeRef);
  }

  applyAddressPage(page: AddressPage): void {
    for (const entry of page.agents) {
      if (entry.nodeId === this.nodeId) continue;
      const nodeRef = this.nodeRefs.get(entry.nodeId);
      if (nodeRef) {
        this.routingTable.set(entry.agentName, nodeRef);
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    for (const link of this.links) {
      await link.connect();
    }
    for (const handle of this.agents.values()) {
      await handle.start();
    }
  }

  async stop(): Promise<void> {
    for (const handle of this.agents.values()) {
      await handle.stop();
    }
    for (const link of this.links) {
      await link.close();
    }
  }

  // ── Transport factory ───────────────────────────────────────────

  createTransport(agentName: string): ReagentTransport {
    const rc = this;

    const transport: ReagentTransport = {
      agentName,

      ref(targetAgent: string): AgentRef {
        return rc.createAgentRef(agentName, targetAgent);
      },

      onMessage(handler: (envelope: MessageEnvelope) => void): void {
        rc.messageHandlers.set(agentName, handler);
        if (!rc.routingTable.has(agentName)) {
          rc.routingTable.set(agentName, rc.loopbackRef);
        }
      },
    };

    return transport;
  }

  // ── External trigger ────────────────────────────────────────────

  triggerProtocol(agentName: string, trigger: ProtocolTrigger): void {
    const handle = this.agents.get(agentName);
    if (!handle) {
      console.warn(`[RC ${this.nodeId}] triggerProtocol: no local agent ${agentName}`);
      return;
    }
    handle.triggerProtocol(trigger);
  }

  // ── Internal routing ────────────────────────────────────────────

  private createAgentRef(sourceAgent: string, targetAgent: string): AgentRef {
    const rc = this;

    const ref: AgentRef = {
      agentName: targetAgent,

      get nodeRef(): NodeRef {
        return rc.routingTable.get(targetAgent) ?? rc.loopbackRef;
      },

      send(messageName: string, payload: Record<string, unknown>): void {
        const envelope = createMessageEnvelope(
          "",  // instanceId must be set by caller context
          "",  // protocolName must be set by caller context
          sourceAgent,
          "",  // fromRole
          targetAgent,
          "",  // toRole
          messageName,
          payload,
        );
        rc.routeEnvelope(envelope, sourceAgent);
      },

      sendEnvelope(envelope: MessageEnvelope): void {
        rc.routeEnvelope(envelope, sourceAgent);
      },
    };

    return ref;
  }

  private routeEnvelope(envelope: MessageEnvelope, _sourceAgent: string): void {
    const targetAgent = envelope.to.agent;
    const targetNodeRef = this.routingTable.get(targetAgent);

    if (!targetNodeRef) {
      console.warn(`[RC ${this.nodeId}] No route for agent ${targetAgent}`);
      return;
    }

    const isLocal = targetNodeRef === this.loopbackRef;
    const direction: MessageDirection = isLocal ? "loopback" : "outbound";

    this.runInterceptors(envelope, direction, () => {
      targetNodeRef.send(envelope);
    });
  }

  private loopbackDeliver(envelope: MessageEnvelope): void {
    this.dispatchLocal(envelope);
  }

  private dispatchLocal(envelope: MessageEnvelope): void {
    const handler = this.messageHandlers.get(envelope.to.agent);
    if (handler) {
      handler(envelope);
    } else {
      const handle = this.agents.get(envelope.to.agent);
      if (handle) {
        handle.dispatchMessage(envelope);
      } else {
        console.warn(`[RC ${this.nodeId}] No handler/agent for ${envelope.to.agent}`);
      }
    }
  }

  private runInterceptors(
    envelope: MessageEnvelope,
    direction: MessageDirection,
    deliver: () => void,
  ): void {
    if (this.interceptors.length === 0) {
      deliver();
      return;
    }

    const ctx: InterceptorContext = {
      envelope,
      direction,
      nodeId: this.nodeId,
    };

    let index = 0;
    const next = (): void => {
      if (index < this.interceptors.length) {
        const interceptor = this.interceptors[index++];
        interceptor(ctx, next);
      } else {
        deliver();
      }
    };

    next();
  }
}
