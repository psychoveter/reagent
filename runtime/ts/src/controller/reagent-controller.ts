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

import type {
  MessageEnvelope,
  IRGraph,
  RoleIR,
  ProtocolTrigger,
  TraceEvent,
  AgentTemplate,
  AgentRecord,
  ProtocolArtifacts,
  AgentRuntimeLifecycle,
} from "../contracts/types.js";
import { createMessageEnvelope, createTraceEvent } from "../contracts/types.js";
import { isAddressableAgentRecord } from "../contracts/types.js";
import type { NodeRef, AgentRef, ReagentTransport, NodeLink } from "../contracts/transport.js";
import type { BehaviorFactory } from "../contracts/behavior-factory.js";
import type { InterceptorFn, InterceptorContext, MessageDirection, TraceHook, AddressPage } from "../contracts/interceptor.js";
import { AgentShellImpl, type AgentShellConfig } from "../core/agent-shell-impl.js";
import type { AgentShellStatus } from "../contracts/agent-shell.js";
import type { AdvanceHookContext } from "../core/role-run.js";
import { ProtocolRegistry, type ProtocolEntry, type CompatibilityReport } from "./protocol-registry.js";
import { LocalEventBus } from "./local-event-bus.js";
import { CronAgent } from "../triggers/cron-agent.js";
import type { LeaderElection } from "../cluster/leader-election.js";
import { TriggerMatcher } from "../triggers/trigger-matcher.js";
import type { TriggerPolicy } from "../triggers/trigger-policy.js";
import type { StateStore } from "../cluster/state-store.js";
import { InMemoryStateStore } from "../cluster/state-store.js";
import { StateStoreAgentRegistry, type AgentRegistration } from "../cluster/state-store-agent-registry.js";
import { ResolvePolicyEvaluator } from "../triggers/resolve-policy-evaluator.js";
import { EtcdMembership } from "../cluster/etcd-membership.js";
import { randomUUID } from "node:crypto";
import type { RoleBindingMap } from "./role-bindings.js";
import { setRoleBinding } from "./role-bindings.js";

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
  /** Single BehaviorFactory — treated as the "ts" backend. */
  behaviorFactory?: BehaviorFactory;
  /** Multiple BehaviorFactory backends keyed by language tag ("ts", "py", …). */
  behaviorFactories?: Record<string, BehaviorFactory>;
  interceptors?: InterceptorFn[];
  /** Trigger policies keyed by trigger ID (e.g. "trigger:cron:MyProto:0 * * * *") */
  triggerPolicies?: Record<string, TriggerPolicy>;
  /** Trace callback for system-level trigger events (TriggerMatched, TriggerSuppressed). */
  traceCallback?: (event: TraceEvent) => void;
  /** Trace hook for protocol-level events. */
  traceHook?: TraceHook;
  /** Cron tick interval in ms (default 15000). Set to 0 to disable auto-cron. */
  cronIntervalMs?: number;
  /** External StateStore (default: InMemoryStateStore). */
  stateStore?: StateStore;
  /** Leader election for CronAgent (cluster mode). When provided, only the leader runs cron ticks. */
  cronLeaderElection?: LeaderElection;
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
  private agentPresenceLeaseId?: string;

  /** lang → BehaviorFactory backend */
  private behaviorFactories: Record<string, BehaviorFactory>;
  private interceptors: InterceptorFn[];
  private cronIntervalMs: number;
  private traceCallback?: (event: TraceEvent) => void;
  private traceHook?: TraceHook;
  private debugResolveHook?: DebugResolveHookFn;

  /** agentName → AgentShellImpl (local agents on this node) */
  private shells = new Map<string, AgentShellImpl>();
  /** agentName → logical runtime identity */
  private agentRecords = new Map<string, AgentRecord>();
  /** agentName → deployed create spec */
  private agentTemplates = new Map<string, AgentTemplate>();
  /** protocolName → deployed protocol artifacts */
  private protocolArtifacts = new Map<string, ProtocolArtifacts>();
  /** agentName → attached runtime lifecycle */
  private agentRuntimeStates = new Map<string, AgentRuntimeLifecycle>();
  /** agentName → lang key of the factory that created the behavior */
  private shellFactoryLangs = new Map<string, string>();
  /** agentName → message handler registered via transport.onMessage() */
  private messageHandlers = new Map<string, (env: MessageEnvelope) => void>();
  /** agentName → NodeRef (routing table: local → loopbackRef, remote → link-backed NodeRef) */
  private routingTable = new Map<string, NodeRef>();
  /** remoteNodeId → NodeRef wrapping the NodeLink */
  private nodeRefs = new Map<string, NodeRef>();
  /** NodeLinks managed by this controller */
  private links: NodeLink[] = [];
  private membership: EtcdMembership | null = null;
  private started = false;

  private loopbackRef: NodeRef;

  constructor(config: ReagentControllerConfig) {
    this.nodeId = config.nodeId;

    if (config.behaviorFactories) {
      this.behaviorFactories = { ...config.behaviorFactories };
    } else if (config.behaviorFactory) {
      this.behaviorFactories = { ts: config.behaviorFactory };
    } else {
      throw new Error("ReagentControllerConfig must provide behaviorFactory or behaviorFactories");
    }

    this.interceptors = [...(config.interceptors ?? [])];
    this.traceCallback = config.traceCallback;
    this.traceHook = config.traceHook;
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
    this.cronAgent = new CronAgent(this.eventBus, config.cronLeaderElection);
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
      stateStore: this.stateStore,
      nodeId: this.nodeId,
    });

    if (config.triggerPolicies) {
      this.triggerMatcher.setPolicies(config.triggerPolicies);
    }
  }

  // ── Agent registry ──────────────────────────────────────────────

  deployProtocolArtifacts(graphs: Map<string, IRGraph>): void {
    const grouped = new Map<string, Map<string, IRGraph>>();
    for (const [key, graph] of graphs) {
      let protocolGraphs = grouped.get(graph.protocolName);
      if (!protocolGraphs) {
        protocolGraphs = new Map<string, IRGraph>();
        grouped.set(graph.protocolName, protocolGraphs);
      }
      protocolGraphs.set(key, graph);
    }

    for (const [protocolName, protocolGraphs] of grouped) {
      const firstGraph = protocolGraphs.values().next().value as IRGraph | undefined;
      if (!firstGraph) continue;

      this.protocolArtifacts.set(protocolName, {
        protocolName,
        version: firstGraph.version,
        graphs: protocolGraphs,
      });

      if (!this.registry.get(protocolName)) {
        const triggers = firstGraph.triggers ?? [];
        this.registry.register({
          name: protocolName,
          version: firstGraph.version ?? "0.0.0",
          fingerprints: firstGraph.fingerprints ?? { structureHash: "", schemaHash: "", implHash: "" },
          dependencies: firstGraph.dependencies ?? [],
          irGraphs: protocolGraphs,
          triggers,
          invocable: firstGraph.invocable ?? triggers.some(t => t.kind === "invoke"),
          registeredAt: Date.now(),
        });
      }
    }
  }

  deployAgentTemplate(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    extras?: Record<string, unknown>,
  ): AgentTemplate {
    this.deployProtocolArtifacts(graphs);
    const template: AgentTemplate = {
      templateId: `${agentName}:${roleIR.roleName}`,
      agentName,
      roleIR,
      graphs,
      extras,
    };
    this.agentTemplates.set(agentName, template);
    return template;
  }

  createAgentRecord(
    agentName: string,
    roleIR: RoleIR,
    templateId?: string,
    extras?: Record<string, unknown>,
  ): AgentRecord {
    const existing = this.agentRecords.get(agentName);
    if (existing) {
      return existing;
    }

    const record: AgentRecord = {
      name: agentName,
      role: roleIR.roleName,
      nodeId: this.nodeId,
      templateId,
      lifecycle: "declared",
      tags: (extras?.tags as string[]) ?? [],
      capabilities: (extras?.capabilities as string[]) ?? [],
      labels: (extras?.labels as Record<string, string>) ?? {},
      metadata: {
        ...(extras ?? {}),
        protocolRoles: roleIR.plays.map((binding) => this.getProtocolRoleKey(binding.protocolName, binding.roleName)),
      },
    };
    this.agentRecords.set(agentName, record);
    return record;
  }

  attachAgentRuntime(
    agentName: string,
    shell: AgentShellImpl,
    lang: string,
    lifecycle: AgentRuntimeLifecycle = "attached",
  ): AgentRecord {
    const template = this.agentTemplates.get(agentName);
    if (!template) {
      throw new Error(`[RC ${this.nodeId}] No AgentTemplate deployed for ${agentName}`);
    }
    const record = this.createAgentRecord(agentName, template.roleIR, template.templateId, template.extras);

    this.shells.set(agentName, shell);
    this.shellFactoryLangs.set(agentName, lang);
    this.agentRuntimeStates.set(agentName, lifecycle);
    this.routingTable.set(agentName, this.loopbackRef);

    shell.setStatusChangeCallback((name, newStatus) => {
      this.handleShellStatusChange(name, newStatus);
    });

    const factory = this.behaviorFactories[lang];
    record.lifecycle = lifecycle === "ready" ? "ready" : "runtime_attached";
    record.runtime = {
      runtimeName: factory?.runtimeName ?? lang,
      lifecycle,
      nodeId: this.nodeId,
      attachedAt: Date.now(),
      readyAt: lifecycle === "ready" ? Date.now() : undefined,
    };
    this.agentRecords.set(agentName, record);
    this.agentRegistry.register(record, { lease: this.agentPresenceLeaseId }).catch(() => {});

    for (const graph of template.graphs.values()) {
      this.registry.bindAgent(graph.protocolName, agentName);
    }

    for (const protocolName of new Set([...template.graphs.values()].map((graph) => graph.protocolName))) {
      const protoEntry = this.registry.get(protocolName);
      if (protoEntry && protoEntry.triggers.length > 0) {
        this.triggerMatcher.registerProtocolTriggers(protoEntry);
      }
    }

    return record;
  }

  markAgentRuntimeReady(agentName: string): void {
    const record = this.agentRecords.get(agentName);
    if (!record) return;
    this.agentRuntimeStates.set(agentName, "ready");
    record.lifecycle = "ready";
    record.runtime = {
      runtimeName: record.runtime?.runtimeName ?? this.shellLang(agentName),
      lifecycle: "ready",
      nodeId: this.nodeId,
      attachedAt: record.runtime?.attachedAt ?? Date.now(),
      readyAt: Date.now(),
    };
    this.agentRegistry.register(record, { lease: this.agentPresenceLeaseId }).catch(() => {});
  }

  detachAgentRuntime(agentName: string): void {
    const record = this.agentRecords.get(agentName);
    if (!record) return;
    const shell = this.shells.get(agentName);
    shell?.setStatusChangeCallback(undefined);
    this.shells.delete(agentName);
    this.shellFactoryLangs.delete(agentName);
    this.messageHandlers.delete(agentName);
    this.routingTable.delete(agentName);
    this.agentRuntimeStates.set(agentName, "detached");
    record.lifecycle = "detached";
    record.runtime = record.runtime
      ? { ...record.runtime, lifecycle: "detached" }
      : undefined;
    this.agentRegistry.deregister(agentName).catch(() => false);
  }

  private handleShellStatusChange(agentName: string, newStatus: AgentShellStatus): void {
    const record = this.agentRecords.get(agentName);
    if (!record) return;

    if (newStatus === "attached") {
      if (record.lifecycle === "detached" || record.lifecycle === "declared") {
        record.lifecycle = "runtime_attached";
        this.agentRuntimeStates.set(agentName, "attached");
        if (record.runtime) {
          record.runtime = { ...record.runtime, lifecycle: "attached", attachedAt: Date.now() };
        }
      }
    } else if (newStatus === "detached") {
      if (record.lifecycle !== "destroyed") {
        record.lifecycle = "detached";
        this.agentRuntimeStates.set(agentName, "detached");
        if (record.runtime) {
          record.runtime = { ...record.runtime, lifecycle: "detached" };
        }
      }
    }

    this.publishAgentPresence(agentName);
  }

  createAgentFromTemplate(agentName: string, opts?: { start?: boolean }): AgentRecord {
    const template = this.agentTemplates.get(agentName);
    if (!template) {
      throw new Error(`[RC ${this.nodeId}] No AgentTemplate found for ${agentName}`);
    }
    const lang = (template.roleIR.lang ?? "ts") as string;
    const factory = this.behaviorFactories[lang];
    if (!factory) {
      throw new Error(
        `[RC ${this.nodeId}] No BehaviorFactory registered for lang "${lang}" (agent ${agentName}). ` +
        `Available: ${Object.keys(this.behaviorFactories).join(", ")}`,
      );
    }

    const transport = this.createTransport(agentName);
    const agentIR = {
      agentName,
      lang: (template.roleIR.lang ?? "ts") as any,
      roleName: template.roleIR.roleName,
      plays: template.roleIR.plays,
      initAction: template.roleIR.initAction,
      lifecycleHandlers: template.roleIR.lifecycleHandlers,
    };

    const roleToAgent = this.resolveRoleToAgentMap(
      template.roleIR.plays[0]?.protocolName ?? "",
    );

    const shellConfig: AgentShellConfig = {
      agentName,
      roleName: template.roleIR.roleName,
      agentIR,
      graphs: template.graphs,
      transport,
      roleToAgent,
      traceHook: this.traceHook,
      extras: template.extras,
      emitBusCallback: (topic, payload, source) => this.emitEvent(topic, payload, source),
      roleSpawnCallback: (request) => this.spawnRoleInstance(
        request.roleName,
        request.config ?? {},
        request.instanceId,
        request.bindAs,
        request.persistent,
      ),
    };

    const shell = new AgentShellImpl(shellConfig);
    const behavior = factory.createBehavior(agentName, template.roleIR, template.graphs, template.extras);
    shell.attachBehavior(behavior);

    const record = this.attachAgentRuntime(agentName, shell, lang);
    if (opts?.start ?? this.started) {
      void shell.start().then(() => {
        this.markAgentRuntimeReady(agentName);
      });
    }
    return record;
  }

  async destroyAgentRecord(agentName: string): Promise<void> {
    const record = this.agentRecords.get(agentName);
    if (!record) return;

    this.agentTemplates.delete(agentName);
    this.agentRecords.delete(agentName);
    this.agentRuntimeStates.delete(agentName);

    const protocolRoles = Array.isArray(record.metadata?.protocolRoles)
      ? record.metadata.protocolRoles as string[]
      : [];
    for (const key of protocolRoles) {
      const [protocolName] = key.split(".");
      if (protocolName) {
        this.registry.unbindAgent(protocolName, agentName);
      }
    }

    record.lifecycle = "destroyed";
    record.runtime = record.runtime
      ? { ...record.runtime, lifecycle: "detached" }
      : undefined;
    await this.agentRegistry.deregister(agentName).catch(() => false);
  }

  registerAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    extras?: Record<string, unknown>,
  ): void {
    this.deployAgentTemplate(agentName, roleIR, graphs, extras);
    this.createAgentFromTemplate(agentName);
  }

  spawnAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    extras?: Record<string, unknown>,
  ): void {
    this.registerAgent(agentName, roleIR, graphs, extras);
    const shell = this.shells.get(agentName)!;
    shell.start();
    this.markAgentRuntimeReady(agentName);
  }

  async destroyAgent(agentName: string): Promise<void> {
    const shell = this.shells.get(agentName);
    if (!shell) {
      if (this.agentRecords.has(agentName)) {
        await this.destroyAgentRecord(agentName);
      }
      return;
    }
    await shell.stop();
    shell.detachBehavior();
    this.detachAgentRuntime(agentName);
    await this.destroyAgentRecord(agentName);
  }

  hasAgent(agentName: string): boolean {
    return this.shells.has(agentName);
  }

  private getProtocolRoleKey(protocolName: string, roleName: string): string {
    return `${protocolName}.${roleName}`;
  }

  private findAgentsForProtocolRole(protocolName: string, roleName: string): AgentRegistration[] {
    const key = this.getProtocolRoleKey(protocolName, roleName);
    return this.agentRegistry.addressable().filter((agent) => {
      const protocolRoles = Array.isArray(agent.metadata?.protocolRoles)
        ? agent.metadata.protocolRoles as string[]
        : [];
      return protocolRoles.includes(key);
    });
  }

  resolveRoleBinding(protocolName: string, roleName: string): string | undefined {
    const exact = this.findAgentsForProtocolRole(protocolName, roleName)[0];
    if (exact) return exact.name;

    const byRole = this.agentRegistry.findAddressableByRole(roleName)[0];
    return byRole?.name;
  }

  getAgentRecord(agentName: string): AgentRecord | undefined {
    return this.agentRecords.get(agentName);
  }

  getAgentRecords(): Map<string, AgentRecord> {
    return this.agentRecords;
  }

  getAgent(agentName: string): AgentShellImpl | undefined {
    return this.shells.get(agentName);
  }

  getRegisteredAgents(): Map<string, AgentShellImpl> {
    return this.shells;
  }

  publishAgentPresence(agentName: string): void {
    const record = this.agentRecords.get(agentName);
    if (!record) return;
    if (isAddressableAgentRecord(record)) {
      this.agentRegistry.register(record, { lease: this.agentPresenceLeaseId }).catch(() => {});
    } else {
      this.agentRegistry.deregister(agentName).catch(() => false);
    }
  }

  // ── Protocol registry convenience ──────────────────────────────

  listProtocols(): ProtocolEntry[] {
    return this.registry.list();
  }

  canDeploy(entry: ProtocolEntry): CompatibilityReport {
    return this.registry.canDeploy(entry);
  }

  /** Set advance hook on all shells (for cluster debug). */
  setAdvanceHook(hook: ((ctx: AdvanceHookContext) => Promise<void>) | undefined): void {
    for (const shell of this.shells.values()) {
      shell.setAdvanceHook(hook);
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
    behaviorFactories: string[];
  } {
    const agentsList: Array<{ name: string; lang: string; route: string }> = [];
    for (const [name, record] of this.agentRecords) {
      const routeEntry = this.routingTable.get(name);
      agentsList.push({
        name,
        lang: record.runtime?.runtimeName ?? this.shellLang(name),
        route: record.runtime ? (routeEntry?.nodeId ?? this.nodeId) : "declared",
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
      behaviorFactories: Object.keys(this.behaviorFactories),
    };
  }

  private shellLang(agentName: string): string {
    return this.shellFactoryLangs.get(agentName) ?? "unknown";
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

  // ── Membership ─────────────────────────────────────────────────

  /**
   * Start etcd-based membership: registers this node, watches for remote agents,
   * and auto-populates the routing table when agents appear on other nodes.
   */
  async startMembership(opts?: { leaseTtlSeconds?: number }): Promise<void> {
    this.membership = new EtcdMembership({
      stateStore: this.stateStore,
      nodeId: this.nodeId,
      leaseTtlSeconds: opts?.leaseTtlSeconds,
      onRemoteAgent: (agentName, remoteNodeId) => {
        const nodeRef = this.nodeRefs.get(remoteNodeId);
        if (nodeRef) {
          this.routingTable.set(agentName, nodeRef);
        }
      },
      onRemoteAgentRemoved: (agentName) => {
        this.routingTable.delete(agentName);
      },
    });
    await this.membership.start();
    this.setAgentPresenceLease(this.membership.getLeaseId());
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    this.started = true;
    await this.agentRegistry.loadFromStore();
    for (const link of this.links) {
      await link.connect();
    }
    for (const [agentName, shell] of this.shells) {
      await shell.start();
      this.markAgentRuntimeReady(agentName);
    }
    if (this.cronIntervalMs > 0) {
      await this.cronAgent.start(this.cronIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.triggerMatcher.destroy();
    this.eventBus.clear();
    await this.cronAgent.stop();
    if (this.membership) {
      await this.membership.stop();
      this.membership = null;
    }
    for (const [agentName, shell] of this.shells) {
      await shell.stop();
      const record = this.agentRecords.get(agentName);
      if (record?.runtime) {
        record.lifecycle = "detached";
        record.runtime = { ...record.runtime, lifecycle: "stopped" };
        this.agentRegistry.deregister(agentName).catch(() => false);
      }
    }
    this.agentPresenceLeaseId = undefined;
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
    const shell = this.shells.get(agentName);
    if (!shell) {
      console.warn(`[RC ${this.nodeId}] triggerProtocol: no local agent ${agentName}`);
      return;
    }
    shell.triggerProtocol(trigger);
  }

  invokeProtocol(
    protocolName: string,
    input: Record<string, unknown> = {},
    opts?: {
      agentName?: string;
      instanceId?: string;
      roleToAgent?: RoleBindingMap;
    },
  ): { instanceId: string; agentName: string; roleToAgent: RoleBindingMap } | null {
    const agentName = opts?.agentName ?? this.resolveInitiatorAgent(protocolName);
    if (!agentName) {
      console.warn(`[RC ${this.nodeId}] invokeProtocol: no initiator for ${protocolName}`);
      return null;
    }
    if (!this.shells.has(agentName)) {
      console.warn(`[RC ${this.nodeId}] invokeProtocol: initiator ${agentName} is not local`);
      return null;
    }

    const instanceId = opts?.instanceId ?? randomUUID();
    const roleToAgent = opts?.roleToAgent ?? this.resolveRoleToAgentMap(protocolName);

    this.triggerProtocol(agentName, {
      instanceId,
      protocolName,
      input,
      roleToAgent,
    });

    return { instanceId, agentName, roleToAgent };
  }

  // ── Event publishing (zone-level reagent.emit → bus) ────────────

  /**
   * Publish an event to the local event bus.
   * Called by AgentShellImpl.handleEmit() to propagate zone-level reagent.emit() calls
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
      const candidates = this.findAgentsForProtocolRole(protocolName, initiatorRole);
      for (const candidate of candidates) {
        if (this.shells.has(candidate.name)) return candidate.name;
      }
    }

    for (const agentName of agents) {
      if (this.shells.has(agentName)) return agentName;
    }
    return null;
  }

  /**
   * Build roleToAgent map from protocol registry bindings.
   */
  private resolveRoleToAgentMap(protocolName: string): RoleBindingMap {
    const result: RoleBindingMap = {};
    const protoEntry = this.registry.get(protocolName);
    if (!protoEntry) return result;

    for (const graph of protoEntry.irGraphs.values()) {
      if (graph.protocolName !== protocolName) continue;
      const role = graph.role;
      const agentName = this.resolveRoleBinding(protocolName, role);
      if (agentName) {
        setRoleBinding(result, protocolName, role, agentName, "single");
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
      const shell = this.shells.get(envelope.to.agent);
      if (shell) {
        shell.dispatchMessage(envelope);
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

  spawnAgentRecord(
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
      nodeId: this.nodeId,
      lifecycle: "declared",
      tags: (config.tags as string[]) ?? [],
      capabilities: (config.capabilities as string[]) ?? [],
      labels: (config.labels as Record<string, string>) ?? {},
      metadata: { ...config, _spawned: true, _instanceId: instanceId, _parentInstanceId: instanceId, _persistent: persistent === true },
    };
    this.agentRecords.set(spawnedName, registration);
    Promise.resolve().then(() => {
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

  setAgentPresenceLease(leaseId?: string): void {
    this.agentPresenceLeaseId = leaseId;
    for (const [agentName, record] of this.agentRecords) {
      if (isAddressableAgentRecord(record)) {
        this.agentRegistry.register(record, { lease: this.agentPresenceLeaseId }).catch(() => {});
      } else {
        this.agentRegistry.deregister(agentName).catch(() => false);
      }
    }
  }

  /**
   * Spawn a live agent runtime for the requested role.
   * This is the high-level spawn path used by runtime flows that expect the
   * spawned agent to become addressable immediately after creation.
   */
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

    const baseTemplate = this.findTemplateForRole(roleName);
    if (!baseTemplate) {
      this.traceCallback?.(createTraceEvent(instanceId, "SpawnFailed", spawnedName, {
        role: roleName,
        data: { roleName, error: `No AgentTemplate available for role ${roleName}` },
      }));
      throw new Error(`[RC ${this.nodeId}] Cannot spawn role ${roleName}: no AgentTemplate available`);
    }

    const extras = {
      ...(baseTemplate.extras ?? {}),
      ...config,
      _spawned: true,
      _instanceId: instanceId,
      _parentInstanceId: instanceId,
      _persistent: persistent === true,
      ...(bindAs ? { _bindAs: bindAs } : {}),
    };

    this.deployAgentTemplate(spawnedName, baseTemplate.roleIR, baseTemplate.graphs, extras);
    this.createAgentRecord(spawnedName, baseTemplate.roleIR, `${spawnedName}:${baseTemplate.roleIR.roleName}`, extras);
    this.createAgentFromTemplate(spawnedName, { start: true });

    if (!persistent) {
      let set = this.spawnedAgents.get(instanceId);
      if (!set) {
        set = new Set();
        this.spawnedAgents.set(instanceId, set);
      }
      set.add(spawnedName);
    }

    this.traceCallback?.(createTraceEvent(instanceId, "SpawnCompleted", spawnedName, {
      role: roleName,
      data: { roleName, agentName: spawnedName, persistent: persistent === true, bindAs },
    }));

    return spawnedName;
  }

  private findTemplateForRole(roleName: string): AgentTemplate | undefined {
    for (const template of this.agentTemplates.values()) {
      if (template.roleIR.roleName === roleName) {
        return template;
      }
    }
    return undefined;
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
