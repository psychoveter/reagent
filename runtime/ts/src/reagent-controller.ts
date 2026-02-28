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

import type { MessageEnvelope, IRGraph, RoleIR, ProtocolTrigger, TraceEvent } from "./types.js";
import { createMessageEnvelope, createTraceEvent } from "./types.js";
import type { NodeRef, AgentRef, ReagentTransport, NodeLink } from "./transport.js";
import type { AgentNode, AgentHandle } from "./agent-node.js";
import type { InterceptorFn, InterceptorContext, MessageDirection, AddressPage } from "./interceptor.js";
import type { AdvanceHook } from "./protocol-instance.js";
import { ProtocolRegistry, type ProtocolEntry, type CompatibilityReport } from "./protocol-registry.js";
import { LocalEventBus } from "./local-event-bus.js";
import { CronAgent } from "./cron-agent.js";
import { TriggerMatcher } from "./trigger-matcher.js";
import type { TriggerPolicy } from "./trigger-policy.js";
import type { StateStore } from "./state-store.js";
import { InMemoryStateStore } from "./state-store.js";
import { StateStoreAgentRegistry, type AgentRegistration } from "./state-store-agent-registry.js";
import { ResolvePolicyEvaluator } from "./resolve-policy-evaluator.js";

// ── Configuration ───────────────────────────────────────────────────

export type DebugResolveHookFn = (data: {
  role: string;
  candidates: string[];
  selected: string[];
  pipelineSummary: string;
  triggerId?: string;
  instanceId?: string;
}) => Promise<void>;

export interface ReagentControllerConfig {
  nodeId: string;
  /** Single AgentNode (backward compat) — treated as the "ts" backend. */
  agentNode?: AgentNode;
  /** Multiple AgentNode backends keyed by language tag ("ts", "py", …). */
  agentNodes?: Record<string, AgentNode>;
  interceptors?: InterceptorFn[];
  /** Trigger policies keyed by trigger ID (e.g. "trigger:cron:MyProto:0 * * * *") */
  triggerPolicies?: Record<string, TriggerPolicy>;
  /** Trace callback for system-level trigger events (TriggerMatched, TriggerSuppressed). */
  traceCallback?: (event: TraceEvent) => void;
  /** Cron tick interval in ms (default 15000). Set to 0 to disable auto-cron. */
  cronIntervalMs?: number;
  /** External StateStore (default: InMemoryStateStore). */
  stateStore?: StateStore;
  /** Debug hook that fires after resolve pipeline evaluation, before protocol instantiation. */
  debugResolveHook?: DebugResolveHookFn;
}

// ── Controller ──────────────────────────────────────────────────────

export class ReagentController {
  readonly nodeId: string;
  readonly registry: ProtocolRegistry;
  readonly eventBus: LocalEventBus;
  readonly cronAgent: CronAgent;
  readonly triggerMatcher: TriggerMatcher;
  readonly stateStore: StateStore;
  readonly agentRegistry: StateStoreAgentRegistry;
  readonly resolvePolicyEvaluator: ResolvePolicyEvaluator;

  /** lang → AgentNode backend */
  private agentNodes: Record<string, AgentNode>;
  private interceptors: InterceptorFn[];
  private cronIntervalMs: number;
  private traceCallback?: (event: TraceEvent) => void;
  private debugResolveHook?: DebugResolveHookFn;

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
    this.traceCallback = config.traceCallback;
    this.registry = new ProtocolRegistry();
    this.stateStore = config.stateStore ?? new InMemoryStateStore();
    this.agentRegistry = new StateStoreAgentRegistry(this.stateStore);
    this.resolvePolicyEvaluator = new ResolvePolicyEvaluator(this.agentRegistry, config.traceCallback);

    if (config.debugResolveHook) {
      this.debugResolveHook = config.debugResolveHook;
      this.applyDebugResolveHook(config.debugResolveHook);
    }

    this.loopbackRef = {
      nodeId: this.nodeId,
      send: (envelope) => this.loopbackDeliver(envelope),
    };

    this.eventBus = new LocalEventBus();
    this.cronAgent = new CronAgent(this.eventBus);
    this.cronIntervalMs = config.cronIntervalMs ?? 15_000;

    this.triggerMatcher = new TriggerMatcher({
      registry: this.registry,
      bus: this.eventBus,
      cron: this.cronAgent,
      triggerCallback: (agentName, trigger) => this.triggerProtocol(agentName, trigger),
      traceCallback: config.traceCallback,
      resolveInitiator: (protoName) => this.resolveInitiatorAgent(protoName),
      resolveRoleToAgent: (protoName) => this.resolveRoleToAgentMap(protoName),
      resolvePolicyEvaluator: this.resolvePolicyEvaluator,
    });

    if (config.triggerPolicies) {
      this.triggerMatcher.setPolicies(config.triggerPolicies);
    }

    // Wire event bus callback into agent nodes that support it
    const busCb = (topic: string, payload: Record<string, unknown>, source: { agent: string; instanceId: string }) => {
      this.emitEvent(topic, payload, source);
    };
    for (const node of Object.values(this.agentNodes)) {
      if (typeof (node as any).setEmitBusCallback === "function") {
        (node as any).setEmitBusCallback(busCb);
      }
    }
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
        const triggers = graph.triggers ?? [];
        this.registry.register({
          name: protoName,
          version: graph.version ?? "0.0.0",
          fingerprints: graph.fingerprints ?? { structureHash: "", schemaHash: "", implHash: "" },
          dependencies: graph.dependencies ?? [],
          irGraphs: protoGraphs,
          triggers,
          invocable: graph.invocable ?? triggers.some(t => t.kind === "invoke"),
          registeredAt: Date.now(),
        });
      }
      this.registry.bindAgent(protoName, agentName);
    }

    // Incrementally register triggers for newly deployed protocols
    for (const protoName of registeredProtos) {
      const protoEntry = this.registry.get(protoName);
      if (protoEntry && protoEntry.triggers.length > 0) {
        this.triggerMatcher.registerProtocolTriggers(protoEntry);
      }
    }

    // Write to state store agent registry
    const registration: AgentRegistration = {
      name: agentName,
      role: roleIR.roleName,
      tags: (extras?.tags as string[]) ?? [],
      capabilities: (extras?.capabilities as string[]) ?? [],
      labels: (extras?.labels as Record<string, string>) ?? {},
      metadata: extras ?? {},
    };
    this.agentRegistry.register(registration).catch(() => {});
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
    this.agentRegistry.deregister(agentName).catch(() => {});
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

  /** Set advance hook on all agent node backends (for cluster debug). */
  setAdvanceHook(hook: AdvanceHook | undefined): void {
    for (const node of Object.values(this.agentNodes)) {
      if (typeof (node as any).setAdvanceHook === 'function') {
        (node as any).setAdvanceHook(hook);
      }
    }
  }

  /** Set debug resolve hook — fires after resolve pipeline, before protocol instantiation. */
  setDebugResolveHook(hook: DebugResolveHookFn | undefined): void {
    this.debugResolveHook = hook;
    this.applyDebugResolveHook(hook);
  }

  private applyDebugResolveHook(hook: DebugResolveHookFn | undefined): void {
    if (!hook) {
      this.resolvePolicyEvaluator.setDebugHook(undefined);
      return;
    }
    this.resolvePolicyEvaluator.setDebugHook(async (data) => {
      await hook({
        role: data.role,
        candidates: data.candidates,
        selected: data.selected,
        pipelineSummary: data.pipeline.join(" → "),
      });
    });
  }

  /** Return introspection snapshot for NodeInspect responses. */
  inspect(): {
    nodeId: string;
    agents: Array<{ name: string; lang: string; route: string }>;
    protocols: Array<{ name: string; version: string; agents: string[]; graphs: string[] }>;
    routing: Record<string, string>;
    agentNodes: string[];
  } {
    const agentsList: Array<{ name: string; lang: string; route: string }> = [];
    for (const [name, _handle] of this.agents) {
      const routeEntry = this.routingTable.get(name);
      agentsList.push({
        name,
        lang: this.agentOwnerLang(name),
        route: routeEntry?.nodeId ?? this.nodeId,
      });
    }

    const protoList: Array<{ name: string; version: string; agents: string[]; graphs: string[] }> = [];
    for (const entry of this.registry.list()) {
      protoList.push({
        name: entry.name,
        version: entry.version,
        agents: this.registry.agentsForProtocol(entry.name),
        graphs: entry.irGraphs ? [...entry.irGraphs.keys()] : [],
      });
    }

    const routing: Record<string, string> = {};
    for (const [agent, ref] of this.routingTable) {
      routing[agent] = ref.nodeId;
    }

    return {
      nodeId: this.nodeId,
      agents: agentsList,
      protocols: protoList,
      routing,
      agentNodes: Object.keys(this.agentNodes),
    };
  }

  private agentOwnerLang(agentName: string): string {
    const owner = this.agentOwners.get(agentName);
    if (!owner) return "unknown";
    for (const [lang, node] of Object.entries(this.agentNodes)) {
      if (node === owner) return lang;
    }
    return "unknown";
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
    if (this.cronIntervalMs > 0) {
      this.cronAgent.start(this.cronIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.triggerMatcher.destroy();
    this.eventBus.clear();
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

  // ── Event publishing (zone-level reagent.emit → bus) ────────────

  /**
   * Publish an event to the local event bus.
   * Called by AgentRunner.handleEmit() to propagate zone-level reagent.emit() calls
   * into the trigger system.
   */
  emitEvent(topic: string, payload: Record<string, unknown>, source?: { agent: string; instanceId: string }): void {
    this.eventBus.publish(topic, {
      topic,
      payload,
      source,
      ts: Date.now(),
    });
  }

  // ── Initiator resolution ──────────────────────────────────────────

  /**
   * Find the initiator agent for a protocol — the first local agent that
   * has a plays binding with the protocol's initiator role.
   */
  private resolveInitiatorAgent(protocolName: string): string | null {
    const protoEntry = this.registry.get(protocolName);
    if (!protoEntry) return null;

    // Find initiator role from ParticipantIR
    let initiatorRole: string | null = null;
    for (const graph of protoEntry.irGraphs.values()) {
      const initiator = graph.participants?.find(p => p.initiator);
      if (initiator) {
        initiatorRole = initiator.name;
        break;
      }
    }

    const agents = this.registry.agentsForProtocol(protocolName);
    if (agents.length === 0) return null;

    if (initiatorRole) {
      // Check state store agent registry first
      const candidates = this.agentRegistry.findByRole(initiatorRole);
      for (const candidate of candidates) {
        if (this.agents.has(candidate.name)) return candidate.name;
      }

      // Fallback to plays binding
      for (const agentName of agents) {
        if (!this.agents.has(agentName)) continue;
        const handle = this.agents.get(agentName)!;
        if (typeof (handle as any).getRunner === "function") {
          const runner = (handle as any).getRunner();
          const ir = runner?.agentIR ?? runner?._agentIR;
          if (ir?.plays?.some((p: any) => p.protocolName === protocolName && p.roleName === initiatorRole)) {
            return agentName;
          }
        }
      }
    }

    for (const agentName of agents) {
      if (this.agents.has(agentName)) return agentName;
    }
    return null;
  }

  /**
   * Build roleToAgent map from protocol registry bindings.
   */
  private resolveRoleToAgentMap(protocolName: string): Record<string, string> {
    const result: Record<string, string> = {};
    const protoEntry = this.registry.get(protocolName);
    if (!protoEntry) return result;

    for (const graph of protoEntry.irGraphs.values()) {
      if (graph.protocolName !== protocolName) continue;
      const role = graph.role;
      const agents = this.registry.agentsForProtocol(protocolName);
      for (const agentName of agents) {
        const handle = this.agents.get(agentName);
        if (!handle) continue;
        if (typeof (handle as any).getRunner === "function") {
          const runner = (handle as any).getRunner();
          const ir = runner?.agentIR ?? runner?._agentIR;
          if (ir?.plays?.some((p: any) => p.protocolName === protocolName && p.roleName === role)) {
            result[role] = agentName;
          }
        }
      }
    }
    return result;
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

  // ── Spawn lifecycle ──────────────────────────────────────────────

  /** Protocol-scoped spawned agents, keyed by instanceId */
  private spawnedAgents = new Map<string, Set<string>>();

  spawnRoleInstance(
    roleName: string,
    config: Record<string, unknown>,
    instanceId: string,
    bindAs?: string,
    persistent?: boolean,
  ): string {
    const spawnedName = `${roleName}_${crypto.randomUUID().slice(0, 8)}`;

    this.traceCallback?.(createTraceEvent(instanceId, "SpawnStarted", spawnedName, {
      role: roleName,
      data: { roleName, bindAs, persistent: persistent === true, parentInstanceId: instanceId },
    }));

    const registration: AgentRegistration = {
      name: spawnedName,
      role: roleName,
      tags: (config.tags as string[]) ?? [],
      capabilities: (config.capabilities as string[]) ?? [],
      labels: (config.labels as Record<string, string>) ?? {},
      metadata: { ...config, _spawned: true, _instanceId: instanceId, _parentInstanceId: instanceId, _persistent: persistent === true },
    };
    this.agentRegistry.register(registration).then(() => {
      this.traceCallback?.(createTraceEvent(instanceId, "SpawnCompleted", spawnedName, {
        role: roleName,
        data: { roleName, agentName: spawnedName, persistent: persistent === true },
      }));
    }).catch((err) => {
      this.traceCallback?.(createTraceEvent(instanceId, "SpawnFailed", spawnedName, {
        role: roleName,
        data: { roleName, error: String(err) },
      }));
    });

    if (!persistent) {
      let set = this.spawnedAgents.get(instanceId);
      if (!set) {
        set = new Set();
        this.spawnedAgents.set(instanceId, set);
      }
      set.add(spawnedName);
    }

    return spawnedName;
  }

  cleanupSpawnedAgents(instanceId: string): void {
    const agents = this.spawnedAgents.get(instanceId);
    if (!agents) return;
    for (const name of agents) {
      this.destroyAgent(name).catch(() => {});
    }
    this.spawnedAgents.delete(instanceId);
  }

  registerResolvePolicy(name: string, impl: (candidates: AgentRegistration[], ctx: unknown) => AgentRegistration[]): void {
    this.resolvePolicyEvaluator.registerCustomPolicy(name, impl as any);
  }
}
