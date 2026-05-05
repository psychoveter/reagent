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
  ProtocolFault,
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
import type {
  ProcessRelationKind,
  ProtocolCancellationState,
  ParticipantLossRecord,
  ProtocolRunStatus,
  ProtocolRunRecord,
  ProtocolRunRef,
  ProtocolRunSnapshot,
  RoleRunStatus,
  SpawnOwnershipRecord,
  SupervisionStrategy,
} from "../contracts/protocol-run.js";
import { isTerminalProtocolRunStatus, isTerminalRoleRunStatus } from "../contracts/protocol-run.js";
import type { NodeRef, AgentRef, ReagentTransport, NodeLink } from "../contracts/transport.js";
import type { BehaviorFactory } from "../contracts/behavior-factory.js";
import type { InterceptorFn, InterceptorContext, MessageDirection, TraceHook, AddressPage } from "../contracts/interceptor.js";
import { AgentShellImpl, type AgentShellConfig, type AgentShellRunLifecycleEvent } from "../core/agent-shell-impl.js";
import type { AgentShellStatus } from "../contracts/agent-shell.js";
import type { AdvanceHookContext } from "../core/role-run.js";
import { ProtocolRegistry, type ProtocolEntry, type CompatibilityReport } from "./protocol-registry.js";
import { LocalEventBus } from "./local-event-bus.js";
import { CronAgent } from "../triggers/cron-agent.js";
import type { LeaderElection } from "../cluster/leader-election.js";
import { TriggerMatcher } from "../triggers/trigger-matcher.js";
import type { TriggerPolicy } from "../triggers/trigger-policy.js";
import type { Disposable, StateStore, WatchEvent } from "../cluster/state-store.js";
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
  /** Maximum retained local finished runs/results per AgentShell. Durable protocol-run records are not evicted. */
  finishedRunRetentionLimit?: number;
}

const PROTOCOL_RUNS_PREFIX = "/protocol-runs/";

class ProtocolRunMutationError extends Error {
  constructor(instanceId: string, retries: number) {
    super(`Failed to persist protocol-run mutation for ${instanceId} after ${retries} CAS retries`);
    this.name = "ProtocolRunMutationError";
  }
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
  private finishedRunRetentionLimit: number;
  private activeTryScopeFaults = new Map<string, ProtocolFault>();

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
  /** protocol instanceId -> durable process record owned by this RC */
  private protocolRuns = new Map<string, ProtocolRunRecord>();
  /** protocol instanceId -> lightweight tracker snapshot */
  private protocolRunSnapshots = new Map<string, ProtocolRunSnapshot>();
  /** agentName → message handler registered via transport.onMessage() */
  private messageHandlers = new Map<string, (env: MessageEnvelope) => void>();
  /** agentName → NodeRef (routing table: local → loopbackRef, remote → link-backed NodeRef) */
  private routingTable = new Map<string, NodeRef>();
  /** remoteNodeId → NodeRef wrapping the NodeLink */
  private nodeRefs = new Map<string, NodeRef>();
  /** NodeLinks managed by this controller */
  private links: NodeLink[] = [];
  private membership: EtcdMembership | null = null;
  private protocolRunWatch?: Disposable;
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
    this.finishedRunRetentionLimit = Math.max(0, config.finishedRunRetentionLimit ?? 100);
    this.registry = new ProtocolRegistry();
    this.stateStore = config.stateStore ?? new InMemoryStateStore();
    this.agentRegistry = new StateStoreAgentRegistry(this.stateStore);
    this.resolvePolicyEvaluator = new ResolvePolicyEvaluator(this.agentRegistry, config.traceCallback);
    this.protocolRunWatch = this.stateStore.watch(PROTOCOL_RUNS_PREFIX, (event) => {
      void this.handleProtocolRunWatchEvent(event);
    });

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
    void this.handleAgentUnavailable(agentName, `local runtime for ${agentName} detached`);
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
      void this.handleAgentUnavailable(agentName, `local runtime for ${agentName} detached`);
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
      onRunLifecycleEvent: (event) => this.handleShellRunLifecycleEvent(event),
      reportTryScopeFault: (fault) => this.reportTryScopeFault(fault),
      finishedRunRetentionLimit: this.finishedRunRetentionLimit,
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
    protocolRuns: ProtocolRunRecord[];
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
      protocolRuns: [...this.protocolRuns.values()],
    };
  }

  getRun(ref: ProtocolRunRef): ProtocolRunSnapshot | undefined {
    return this.protocolRunSnapshots.get(ref.instanceId);
  }

  async getRunRecord(ref: ProtocolRunRef): Promise<ProtocolRunRecord | undefined> {
    return this.loadProtocolRunRecord(ref.instanceId);
  }

  async listRuns(): Promise<ProtocolRunRecord[]> {
    return this.listProtocolRuns();
  }

  async listProtocolRuns(): Promise<ProtocolRunRecord[]> {
    const entries = await this.stateStore.list(PROTOCOL_RUNS_PREFIX);
    const records: ProtocolRunRecord[] = [];
    for (const entry of entries) {
      const record = this.parseProtocolRunRecord(entry.value);
      if (!record) continue;
      this.cacheProtocolRunRecord(record);
      records.push(record);
    }
    return records.sort((a, b) => b.startedAt - a.startedAt);
  }

  async inspectProtocolRun(instanceId: string): Promise<{
    record?: ProtocolRunRecord;
    parent?: ProtocolRunRecord;
    children: ProtocolRunRecord[];
  }> {
    const record = await this.loadProtocolRunRecord(instanceId);
    if (!record) {
      return { children: [] };
    }
    const parent = record.parentInstanceId
      ? await this.loadProtocolRunRecord(record.parentInstanceId)
      : undefined;
    const children = await Promise.all(record.childInstanceIds.map((childId) => this.loadProtocolRunRecord(childId)));
    return {
      record,
      parent,
      children: children.filter((value): value is ProtocolRunRecord => value != null),
    };
  }

  async cancelRun(ref: ProtocolRunRef): Promise<void> {
    await this.cancelProtocolRun(ref.instanceId);
  }

  async cancelProtocolRun(instanceId: string, reason = "cancelled by control plane"): Promise<boolean> {
    const record = await this.loadProtocolRunRecord(instanceId);
    if (!record) return false;
    if (isTerminalProtocolRunStatus(record.status)) return true;

    const nextRecord = await this.mutateProtocolRunRecord(instanceId, (current) => {
      if (!current || isTerminalProtocolRunStatus(current.status)) return current;
      const now = Date.now();
      return {
        ...current,
        status: "cancelling",
        updatedAt: now,
        failureReason: reason,
        cancellation: this.mergeCancellationState(current, {
          reason,
          requestedByNodeId: this.nodeId,
        }),
      };
    });
    if (!nextRecord) return false;

    await this.handleCancellationConvergence(nextRecord);
    const finalRecord = await this.loadProtocolRunRecord(instanceId, { fresh: true });
    if (finalRecord && isTerminalProtocolRunStatus(finalRecord.status)) {
      this.cleanupSpawnedAgents(instanceId);
    }
    return true;
  }

  async handleNodeDeparture(nodeId: string): Promise<void> {
    const runs = await this.listProtocolRuns();
    const candidates = runs.filter((record) =>
      record.homeNodeId === nodeId && !isTerminalProtocolRunStatus(record.status),
    );
    for (const record of candidates) {
      const fresh = await this.loadProtocolRunRecord(record.instanceId);
      if (!fresh || fresh.homeNodeId !== nodeId || isTerminalProtocolRunStatus(fresh.status)) {
        continue;
      }
      await this.adoptProtocolRunAfterHomeLoss(fresh, nodeId);
    }

    const impactedParticipants = runs.filter((record) =>
      this.isHomeRcSupervisor(record)
      && record.homeNodeId !== nodeId
      && !isTerminalProtocolRunStatus(record.status)
      && record.status !== "cancelling"
      && Object.values(record.roles).some((role) => role.nodeId === nodeId),
    );
    for (const record of impactedParticipants) {
      for (const [roleName, role] of Object.entries(record.roles)) {
        if (role.nodeId !== nodeId) continue;
        await this.handleParticipantLoss(record.instanceId, roleName, role.agentName, `participant node ${nodeId} left cluster`);
      }
    }
  }

  private async adoptProtocolRunAfterHomeLoss(record: ProtocolRunRecord, lostNodeId: string): Promise<void> {
    const orphanedAt = Date.now();
    const adoptingRecord: ProtocolRunRecord = {
      ...record,
      status: "adopting",
      orphanedAt,
      adoptedByNodeId: this.nodeId,
      homeNodeId: this.nodeId,
      updatedAt: orphanedAt,
      failureReason: `home node ${lostNodeId} left cluster`,
    };
    const acquired = await this.compareAndSwapProtocolRun(record, adoptingRecord);
    if (!acquired) {
      return;
    }

    const impactedRoles = Object.entries(adoptingRecord.roles)
      .filter(([, role]) => role.nodeId === lostNodeId)
      .map(([roleName, role]) => ({ roleName, agentName: role.agentName }));

    if (adoptingRecord.supervisionStrategy === "one-for-one" || adoptingRecord.supervisionStrategy === "all-for-one") {
      for (const impactedRole of impactedRoles) {
        await this.handleParticipantLoss(
          adoptingRecord.instanceId,
          impactedRole.roleName,
          impactedRole.agentName,
          `home node ${lostNodeId} left cluster`,
        );
      }
      const reconciled = await this.loadProtocolRunRecord(adoptingRecord.instanceId, { fresh: true });
      if (!reconciled || isTerminalProtocolRunStatus(reconciled.status)) {
        return;
      }
      const stillMissingOwner = Object.values(reconciled.roles).some((role) => role.nodeId === lostNodeId);
      if (!stillMissingOwner) {
        await this.persistProtocolRun({
          ...reconciled,
          status: "running",
          updatedAt: Date.now(),
          completedAt: undefined,
        });
        return;
      }
    }

    const finalizedAt = Date.now();
    const finalStatus: ProtocolRunStatus =
      adoptingRecord.supervisionStrategy === "scoped" ? "cancelled" : "failed";
    await this.persistProtocolRun({
      ...adoptingRecord,
      status: finalStatus,
      updatedAt: finalizedAt,
      completedAt: finalizedAt,
      failureReason: adoptingRecord.failureReason,
      roles: Object.fromEntries(
        Object.entries(adoptingRecord.roles).map(([roleName, role]) => [
          roleName,
          {
            ...role,
            status: isTerminalRoleRunStatus(role.status)
              ? role.status
              : (finalStatus === "cancelled" ? "cancelled" : "failed"),
            updatedAt: finalizedAt,
            lossDetectedAt: role.nodeId === lostNodeId ? finalizedAt : role.lossDetectedAt,
          },
        ]),
      ),
    });
    for (const shell of this.shells.values()) {
      shell.cancelRun(adoptingRecord.instanceId, adoptingRecord.failureReason ?? "home node departed");
    }
    this.cleanupSpawnedAgents(adoptingRecord.instanceId, adoptingRecord);
  }

  private protocolRunKey(instanceId: string): string {
    return `${PROTOCOL_RUNS_PREFIX}${instanceId}`;
  }

  private cacheProtocolRunRecord(record: ProtocolRunRecord): void {
    this.protocolRuns.set(record.instanceId, record);
    this.protocolRunSnapshots.set(record.instanceId, this.buildProtocolRunSnapshot(record));
  }

  private evictProtocolRunRecord(instanceId: string): void {
    this.protocolRuns.delete(instanceId);
    this.protocolRunSnapshots.delete(instanceId);
  }

  private parseProtocolRunRecord(raw: unknown): ProtocolRunRecord | undefined {
    if (raw == null) return undefined;
    try {
      return JSON.parse(typeof raw === "string" ? raw : (raw as Buffer).toString("utf8")) as ProtocolRunRecord;
    } catch {
      return undefined;
    }
  }

  private async loadProtocolRunRecord(
    instanceId: string,
    opts?: { fresh?: boolean },
  ): Promise<ProtocolRunRecord | undefined> {
    if (!opts?.fresh) {
      const cached = this.protocolRuns.get(instanceId);
      if (cached) return cached;
    }
    const raw = await this.stateStore.get(this.protocolRunKey(instanceId));
    const record = this.parseProtocolRunRecord(raw);
    if (!record) {
      this.evictProtocolRunRecord(instanceId);
      return undefined;
    }
    this.cacheProtocolRunRecord(record);
    return record;
  }

  private async persistProtocolRun(record: ProtocolRunRecord): Promise<void> {
    await this.stateStore.put(this.protocolRunKey(record.instanceId), JSON.stringify(record));
    this.cacheProtocolRunRecord(record);
  }

  private async compareAndSwapProtocolRun(
    expectedRecord: ProtocolRunRecord | null,
    nextRecord: ProtocolRunRecord,
  ): Promise<boolean> {
    const key = this.protocolRunKey(nextRecord.instanceId);
    const succeeded = await this.stateStore.compareAndSwap(
      key,
      expectedRecord ? JSON.stringify(expectedRecord) : null,
      JSON.stringify(nextRecord),
    );
    if (succeeded) {
      this.cacheProtocolRunRecord(nextRecord);
    } else {
      this.evictProtocolRunRecord(nextRecord.instanceId);
    }
    return succeeded;
  }

  private async mutateProtocolRunRecord(
    instanceId: string,
    mutate: (record: ProtocolRunRecord | undefined) => ProtocolRunRecord | undefined,
    opts?: { retries?: number },
  ): Promise<ProtocolRunRecord | undefined> {
    const retries = opts?.retries ?? 6;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const current = await this.loadProtocolRunRecord(instanceId, { fresh: true });
      const next = mutate(current);
      if (!next) {
        return current;
      }
      const currentJson = current ? JSON.stringify(current) : null;
      const nextJson = JSON.stringify(next);
      if (currentJson === nextJson) {
        this.cacheProtocolRunRecord(next);
        return next;
      }
      const swapped = await this.compareAndSwapProtocolRun(current ?? null, next);
      if (swapped) {
        return next;
      }
    }
    throw new ProtocolRunMutationError(instanceId, retries);
  }

  private buildProtocolRunSnapshot(record: ProtocolRunRecord): ProtocolRunSnapshot {
    return {
      ref: { instanceId: record.instanceId, protocolName: record.protocolName },
      roles: new Map(
        Object.entries(record.roles).map(([roleName, role]) => [
          roleName,
          { agentName: role.agentName, status: role.status },
        ]),
      ),
      startedAt: record.startedAt,
      completedAt: record.completedAt,
    };
  }

  private async ensureProtocolRunRecord(args: {
    instanceId: string;
    protocolName: string;
    agentName: string;
    roleName: string;
    relationKind: ProcessRelationKind;
    parentInstanceId?: string;
    parentProtocolName?: string;
    createIfMissing: boolean;
    supervisionStrategy?: SupervisionStrategy;
  }): Promise<ProtocolRunRecord | undefined> {
    let rootInstanceId = args.instanceId;
    if (args.parentInstanceId) {
      const parent = await this.loadProtocolRunRecord(args.parentInstanceId);
      rootInstanceId = parent?.rootInstanceId ?? args.parentInstanceId;
    }

    const merged = await this.mutateProtocolRunRecord(args.instanceId, (existing) => {
      const now = Date.now();
      if (!existing && !args.createIfMissing) {
        return undefined;
      }
      const next: ProtocolRunRecord = existing ?? {
        instanceId: args.instanceId,
        protocolName: args.protocolName,
        status: "running",
        homeNodeId: this.nodeId,
        relationKind: args.relationKind,
        supervisionStrategy: args.supervisionStrategy ?? "scoped",
        rootInstanceId,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        parentInstanceId: args.parentInstanceId,
        parentProtocolName: args.parentProtocolName,
        ownerAgentName: args.agentName,
        ownerRoleName: args.roleName,
        roles: {},
        childInstanceIds: [],
        spawnedAgents: [],
        participantLosses: [],
      };

      return {
        ...next,
        protocolName: args.protocolName,
        relationKind: args.relationKind,
        parentInstanceId: args.parentInstanceId ?? next.parentInstanceId,
        parentProtocolName: args.parentProtocolName ?? next.parentProtocolName,
        ownerAgentName: next.ownerAgentName ?? args.agentName,
        ownerRoleName: next.ownerRoleName ?? args.roleName,
        updatedAt: now,
        status: isTerminalProtocolRunStatus(next.status) ? next.status : (next.status === "cancelling" ? "cancelling" : "running"),
        roles: {
          ...next.roles,
          [args.roleName]: {
            agentName: args.agentName,
            roleName: args.roleName,
            nodeId: this.nodeId,
            status: "running",
            updatedAt: now,
          },
        },
      };
    });
    if (args.parentInstanceId) {
      await this.appendChildToParent(args.parentInstanceId, args.instanceId);
    }
    return merged;
  }

  private async appendChildToParent(parentInstanceId: string, childInstanceId: string): Promise<void> {
    await this.mutateProtocolRunRecord(parentInstanceId, (parent) => {
      if (!parent || parent.childInstanceIds.includes(childInstanceId)) return parent;
      return {
        ...parent,
        updatedAt: Date.now(),
        childInstanceIds: [...parent.childInstanceIds, childInstanceId],
      };
    });
  }

  private async appendSpawnOwnership(instanceId: string, spawn: SpawnOwnershipRecord): Promise<void> {
    await this.mutateProtocolRunRecord(instanceId, (record) => {
      if (!record || record.spawnedAgents.some((entry) => entry.agentName === spawn.agentName)) {
        return record;
      }
      return {
        ...record,
        updatedAt: Date.now(),
        spawnedAgents: [...record.spawnedAgents, spawn],
      };
    });
  }

  private async updateProtocolRunStatus(
    instanceId: string,
    status: ProtocolRunStatus,
    opts?: { failureReason?: string },
  ): Promise<void> {
    await this.mutateProtocolRunRecord(instanceId, (record) => {
      if (!record) return record;
      const now = Date.now();
      return {
        ...record,
        status,
        updatedAt: now,
        completedAt: isTerminalProtocolRunStatus(status) ? (record.completedAt ?? now) : record.completedAt,
        failureReason: opts?.failureReason ?? record.failureReason,
      };
    });
  }

  private isHomeRcSupervisor(record: ProtocolRunRecord): boolean {
    return record.homeNodeId === this.nodeId;
  }

  private deriveProtocolRunStatusFromRoles(record: ProtocolRunRecord): ProtocolRunStatus {
    const roleStates = Object.values(record.roles);
    if (record.status === "adopting") {
      return "adopting";
    }
    if (record.status === "cancelling") {
      return roleStates.length > 0 && roleStates.every((role) => isTerminalRoleRunStatus(role.status))
        ? "cancelled"
        : "cancelling";
    }
    if (roleStates.some((role) => role.status === "failed")) {
      return "failed";
    }
    if (roleStates.some((role) => !isTerminalRoleRunStatus(role.status))) {
      return "running";
    }
    if (roleStates.some((role) => role.status === "cancelled")) {
      return "cancelled";
    }
    return roleStates.length > 0 ? "completed" : record.status;
  }

  private mergeCancellationState(
    record: ProtocolRunRecord,
    args: {
      reason?: string;
      requestedByNodeId?: string;
      ackRoleNames?: string[];
      ackNodeIds?: string[];
    },
  ): ProtocolCancellationState {
    const existing = record.cancellation;
    const acknowledgedRoleNames = new Set(existing?.acknowledgedRoleNames ?? []);
    const acknowledgedNodeIds = new Set(existing?.acknowledgedNodeIds ?? []);
    for (const roleName of args.ackRoleNames ?? []) {
      acknowledgedRoleNames.add(roleName);
    }
    for (const nodeId of args.ackNodeIds ?? []) {
      acknowledgedNodeIds.add(nodeId);
    }
    return {
      requestedAt: existing?.requestedAt ?? Date.now(),
      requestedByNodeId: existing?.requestedByNodeId ?? args.requestedByNodeId ?? this.nodeId,
      reason: args.reason ?? existing?.reason,
      acknowledgedRoleNames: [...acknowledgedRoleNames].sort(),
      acknowledgedNodeIds: [...acknowledgedNodeIds].sort(),
    };
  }

  private buildParticipantLossRecord(
    roleName: string,
    previousAgentName: string,
    reason: string,
    replacementAgentName?: string,
  ): ParticipantLossRecord {
    return {
      roleName,
      previousAgentName,
      detectedByNodeId: this.nodeId,
      detectedAt: Date.now(),
      reason,
      replacementAgentName,
    };
  }

  private async acknowledgeCancellationForNode(record: ProtocolRunRecord): Promise<void> {
    const localTerminalRoles = Object.values(record.roles)
      .filter((role) => role.nodeId === this.nodeId && isTerminalRoleRunStatus(role.status))
      .map((role) => role.roleName);
    if (localTerminalRoles.length === 0 && !(record.cancellation?.acknowledgedNodeIds ?? []).includes(this.nodeId)) {
      return;
    }
    await this.mutateProtocolRunRecord(record.instanceId, (current) => {
      if (!current || current.status !== "cancelling") return current;
      return {
        ...current,
        updatedAt: Date.now(),
        cancellation: this.mergeCancellationState(current, {
          ackRoleNames: localTerminalRoles,
          ackNodeIds: [this.nodeId],
        }),
      };
    });
  }

  private async finalizeCancellationIfConverged(instanceId: string): Promise<void> {
    await this.mutateProtocolRunRecord(instanceId, (record) => {
      if (!record || record.status !== "cancelling") return record;
      const expectedRoleNames = Object.keys(record.roles).sort();
      const ackedRoleNames = new Set(record.cancellation?.acknowledgedRoleNames ?? []);
      const allRolesAcked = expectedRoleNames.every((roleName) => ackedRoleNames.has(roleName));
      const allRolesTerminal = expectedRoleNames.every((roleName) => {
        const role = record.roles[roleName];
        return role ? isTerminalRoleRunStatus(role.status) : false;
      });
      if (!allRolesAcked && !allRolesTerminal) {
        return record;
      }
      const now = Date.now();
      return {
        ...record,
        status: "cancelled",
        updatedAt: now,
        completedAt: record.completedAt ?? now,
      };
    });
  }

  private async handleCancellationConvergence(record: ProtocolRunRecord): Promise<void> {
    if (record.status !== "cancelling") return;

    const reason = record.cancellation?.reason ?? "cancelled by control plane";
    for (const shell of this.shells.values()) {
      shell.cancelRun(record.instanceId, reason);
    }

    await this.acknowledgeCancellationForNode(record);
    if (this.isHomeRcSupervisor(record)) {
      await this.finalizeCancellationIfConverged(record.instanceId);
    }
  }

  private async handleProtocolRunWatchEvent(event: WatchEvent): Promise<void> {
    if (!event.key.startsWith(PROTOCOL_RUNS_PREFIX)) return;
    const instanceId = event.key.slice(PROTOCOL_RUNS_PREFIX.length);
    if (event.kind === "delete") {
      this.evictProtocolRunRecord(instanceId);
      return;
    }
    const record = this.parseProtocolRunRecord(event.value);
    if (!record) {
      this.evictProtocolRunRecord(instanceId);
      return;
    }
    this.cacheProtocolRunRecord(record);
    if (record.status === "cancelling") {
      await this.handleCancellationConvergence(record);
    }
  }

  private async handleAgentUnavailable(agentName: string, reason: string): Promise<void> {
    const runs = await this.listProtocolRuns();
    const impacted = runs.filter((record) =>
      this.isHomeRcSupervisor(record)
      && !isTerminalProtocolRunStatus(record.status)
      && record.status !== "cancelling"
      && Object.values(record.roles).some((role) => role.agentName === agentName),
    );
    for (const record of impacted) {
      for (const [roleName, roleStatus] of Object.entries(record.roles)) {
        if (roleStatus.agentName !== agentName) continue;
        await this.handleParticipantLoss(record.instanceId, roleName, agentName, reason);
      }
    }
  }

  private async handleParticipantLoss(
    instanceId: string,
    roleName: string,
    lostAgentName: string,
    reason: string,
  ): Promise<ProtocolRunRecord | undefined> {
    const replacementAgentName = this.resolveRoleBinding(
      (await this.loadProtocolRunRecord(instanceId))?.protocolName ?? "",
      roleName,
    );
    const replacementRecord = replacementAgentName ? this.getAgentRecord(replacementAgentName) : undefined;

    const nextRecord = await this.mutateProtocolRunRecord(instanceId, (record) => {
      if (!record || !this.isHomeRcSupervisor(record) || isTerminalProtocolRunStatus(record.status)) {
        return record;
      }
      if (record.status === "cancelling") {
        return record;
      }
      const role = record.roles[roleName];
      if (!role || role.agentName !== lostAgentName) {
        return record;
      }

      const losses = [
        ...(record.participantLosses ?? []),
        this.buildParticipantLossRecord(roleName, lostAgentName, reason, replacementAgentName && replacementAgentName !== lostAgentName ? replacementAgentName : undefined),
      ];

      if (replacementAgentName && replacementAgentName !== lostAgentName) {
        return {
          ...record,
          updatedAt: Date.now(),
          participantLosses: losses,
          roles: {
            ...record.roles,
            [roleName]: {
              agentName: replacementAgentName,
              roleName,
              nodeId: replacementRecord?.nodeId,
              status: "running",
              updatedAt: Date.now(),
              lossDetectedAt: Date.now(),
            },
          },
        };
      }

      const now = Date.now();
      return {
        ...record,
        status: "failed",
        updatedAt: now,
        completedAt: record.completedAt ?? now,
        failureReason: reason,
        participantLosses: losses,
        roles: {
          ...record.roles,
          [roleName]: {
            ...role,
            status: "failed",
            updatedAt: now,
            lossDetectedAt: now,
          },
        },
      };
    });

    if (nextRecord && isTerminalProtocolRunStatus(nextRecord.status)) {
      this.cleanupSpawnedAgents(instanceId, nextRecord);
      if (nextRecord.status === "failed") {
        for (const shell of this.shells.values()) {
          shell.cancelRun(instanceId, reason);
        }
      }
    }
    if (
      nextRecord
      && !isTerminalProtocolRunStatus(nextRecord.status)
      && replacementAgentName
      && replacementAgentName !== lostAgentName
      && nextRecord.roles[roleName]?.agentName === replacementAgentName
    ) {
      this.rebindLiveRole(instanceId, nextRecord.protocolName, roleName, replacementAgentName);
    }
    return nextRecord;
  }

  private async handleShellRunLifecycleEvent(event: AgentShellRunLifecycleEvent): Promise<void> {
    switch (event.type) {
      case "run_created": {
        await this.ensureProtocolRunRecord({
          instanceId: event.instanceId,
          protocolName: event.protocolName,
          agentName: event.agentName,
          roleName: event.roleName,
          relationKind: event.relationKind,
          parentInstanceId: event.parentInstanceId,
          parentProtocolName: event.parentProtocolName,
          createIfMissing: event.origin !== "receive_materialized",
          supervisionStrategy: event.supervisionStrategy,
        });
        break;
      }
      case "run_completed": {
        const nextRecord = await this.mutateProtocolRunRecord(event.instanceId, (record) => {
          if (!record) return record;
          const now = Date.now();
          const updatedRecord: ProtocolRunRecord = {
            ...record,
            updatedAt: now,
            failureReason: event.status === "failed" && typeof event.returnValue === "string"
              ? event.returnValue
              : record.failureReason,
            roles: {
              ...record.roles,
              [event.roleName]: {
                agentName: event.agentName,
                roleName: event.roleName,
                nodeId: this.nodeId,
                status: event.status,
                updatedAt: now,
              },
            },
          };
          const nextStatus = this.deriveProtocolRunStatusFromRoles(updatedRecord);
          return {
            ...updatedRecord,
            status: nextStatus,
            completedAt: isTerminalProtocolRunStatus(nextStatus)
              ? (updatedRecord.completedAt ?? now)
              : updatedRecord.completedAt,
            cancellation: record.status === "cancelling" || nextStatus === "cancelling" || nextStatus === "cancelled"
              ? this.mergeCancellationState(updatedRecord, {
                  ackRoleNames: event.status === "cancelled" || isTerminalRoleRunStatus(event.status) ? [event.roleName] : [],
                  ackNodeIds: isTerminalRoleRunStatus(event.status) ? [this.nodeId] : [],
                })
              : record.cancellation,
          };
        });
        if (!nextRecord) break;
        if (nextRecord.status === "cancelling") {
          await this.finalizeCancellationIfConverged(event.instanceId);
        }
        if (isTerminalProtocolRunStatus(nextRecord.status)) {
          for (const key of this.activeTryScopeFaults.keys()) {
            if (key.includes(`:${event.instanceId}:`)) {
              this.activeTryScopeFaults.delete(key);
            }
          }
          this.cleanupSpawnedAgents(event.instanceId);
        }
        break;
      }
      case "spawn_recorded": {
        await this.appendSpawnOwnership(event.instanceId, {
          agentName: event.agentName,
          roleName: event.roleName,
          bindAs: event.bindAs,
          persistent: event.persistent,
          createdAt: Date.now(),
        });
        break;
      }
    }
  }

  private async reportTryScopeFault(fault: ProtocolFault): Promise<ProtocolFault> {
    const scopeId = fault.scopeId;
    const instanceId = fault.instanceId;
    if (!scopeId || !instanceId) {
      return fault;
    }
    const key = `${fault.protocolName ?? ""}:${instanceId}:${scopeId}`;
    const canonical = this.activeTryScopeFaults.get(key) ?? fault;
    if (!this.activeTryScopeFaults.has(key)) {
      this.activeTryScopeFaults.set(key, canonical);
      for (const shell of this.shells.values()) {
        shell.notifyTryScopeFault(instanceId, canonical);
      }
    }
    return canonical;
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
        void this.handleAgentUnavailable(agentName, `remote agent ${agentName} disappeared`);
      },
      onNodeLeave: (leftNodeId) => {
        void this.handleNodeDeparture(leftNodeId);
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
    this.reconcileSpawnedAgentCleanup().catch((err) => {
      console.warn(`[RC ${this.nodeId}] spawned-agent reconciliation failed: ${String(err)}`);
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.protocolRunWatch?.dispose();
    this.protocolRunWatch = undefined;
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
      void this.handleUndeliverableParticipantMessage(
        envelope,
        `no route for participant agent ${targetAgent}`,
      );
      return;
    }

    const isLocal = targetNodeRef === this.loopbackRef;
    const direction: MessageDirection = isLocal ? "loopback" : "outbound";

    this.runInterceptors(envelope, direction, () => {
      targetNodeRef.send(envelope);
    });
  }

  private async handleUndeliverableParticipantMessage(
    envelope: MessageEnvelope,
    reason: string,
  ): Promise<void> {
    const updatedRecord = await this.handleParticipantLoss(
      envelope.instanceId,
      envelope.to.role,
      envelope.to.agent,
      reason,
    );
    const replacementAgentName = updatedRecord?.roles[envelope.to.role]?.agentName;
    if (!updatedRecord || !replacementAgentName || replacementAgentName === envelope.to.agent) {
      return;
    }
    const redirectedEnvelope: MessageEnvelope = {
      ...envelope,
      to: {
        ...envelope.to,
        agent: replacementAgentName,
      },
    };
    this.routeEnvelope(redirectedEnvelope, envelope.from.agent);
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

  private rebindLiveRole(
    instanceId: string,
    protocolName: string,
    roleName: string,
    agentName: string,
  ): void {
    for (const shell of this.shells.values()) {
      shell.rebindRunRole(instanceId, roleName, agentName);
    }
    const run = this.protocolRuns.get(instanceId);
    if (run && run.protocolName === protocolName) {
      this.protocolRunSnapshots.set(instanceId, this.buildProtocolRunSnapshot(run));
    }
  }

  private async reconcileSpawnedAgentCleanup(): Promise<void> {
    const runs = await this.listProtocolRuns();
    for (const record of runs) {
      if (record.homeNodeId !== this.nodeId || !isTerminalProtocolRunStatus(record.status)) {
        continue;
      }
      this.cleanupSpawnedAgents(record.instanceId, record);
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

  cleanupSpawnedAgents(instanceId: string, record?: ProtocolRunRecord): void {
    const agents = new Set(this.spawnedAgents.get(instanceId) ?? []);
    for (const entry of (record ?? this.protocolRuns.get(instanceId))?.spawnedAgents ?? []) {
      if (!entry.persistent) {
        agents.add(entry.agentName);
      }
    }
    if (agents.size === 0) return;
    for (const name of agents) {
      this.destroyAgent(name).catch(() => {});
    }
    this.spawnedAgents.delete(instanceId);
  }

  registerResolvePolicy(name: string, impl: (candidates: AgentRegistration[], ctx: unknown) => AgentRegistration[]): void {
    this.resolvePolicyEvaluator.registerCustomPolicy(name, impl as any);
  }
}
