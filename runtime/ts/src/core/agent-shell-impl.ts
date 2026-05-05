/**
 * AgentShellImpl — R1 ontology. Concrete implementation.
 *
 * The primary runtime object for one agent identity. Owns persistent $self,
 * active/completed run registries, and an optional attached AgentBehavior.
 */

import type { AgentIR, IRGraph, MessageEnvelope, ProtocolFault, ProtocolTrigger, TraceEvent } from "../contracts/types.js";
import type { ReagentTransport } from "../contracts/transport.js";
import type { AgentBehavior } from "../contracts/agent-behavior.js";
import type { TraceHook } from "../contracts/interceptor.js";
import type {
  AgentShell,
  AgentShellStatus,
  AgentRecordDTO,
  RoleRunHandle,
  RoleRunResult,
  ShellStatusChangeCallback,
} from "../contracts/agent-shell.js";
import type { ProcessRelationKind, RoleRunStatus, SupervisionStrategy } from "../contracts/protocol-run.js";
import { isTerminalRoleRunStatus } from "../contracts/protocol-run.js";
import { RoleRun, type RoleRunConfig, type RoleSpawnRequest } from "./role-run.js";
import { executeZone, createReagentStub } from "./zone-executor.js";
import type { RoleBindingMap, RoleBindingResolver, LegacyRoleBindingMap } from "../controller/role-bindings.js";
import { mergeRoleBindings, normalizeRoleBindingMap, resolveRoleBinding, setRoleBinding } from "../controller/role-bindings.js";
import type { AdvanceHookContext } from "./role-run.js";

export type EmitBusCallback = (topic: string, payload: Record<string, unknown>, source: { agent: string; instanceId: string }) => void;

export type AgentShellRunLifecycleEvent =
  | {
      type: "run_created";
      instanceId: string;
      protocolName: string;
      roleName: string;
      agentName: string;
      relationKind: ProcessRelationKind;
      supervisionStrategy?: SupervisionStrategy;
      origin: "trigger" | "receive_materialized" | "invoke" | "async_invoke";
      parentInstanceId?: string;
      parentProtocolName?: string;
    }
  | {
      type: "run_completed";
      instanceId: string;
      protocolName: string;
      roleName: string;
      agentName: string;
      status: RoleRunStatus;
      returnValue?: unknown;
    }
  | {
      type: "spawn_recorded";
      instanceId: string;
      roleName: string;
      agentName: string;
      bindAs?: string;
      persistent: boolean;
    };

export interface AgentShellConfig {
  agentName: string;
  roleName: string;
  agentIR?: AgentIR;
  graphs: Map<string, IRGraph>;
  transport: ReagentTransport;
  roleToAgent: RoleBindingMap | RoleBindingResolver;
  traceHook?: TraceHook;
  advanceHook?: (ctx: AdvanceHookContext) => Promise<void>;
  extras?: Record<string, unknown>;
  emitBusCallback?: EmitBusCallback;
  roleSpawnCallback?: (request: RoleSpawnRequest) => string;
  reportTryScopeFault?: (fault: ProtocolFault) => Promise<ProtocolFault>;
  onStatusChange?: ShellStatusChangeCallback;
  onRunLifecycleEvent?: (event: AgentShellRunLifecycleEvent) => void | Promise<void>;
  finishedRunRetentionLimit?: number;
}

export class AgentShellImpl implements AgentShell {
  readonly name: string;
  readonly role: string;

  get agentName(): string { return this.name; }

  private _status: AgentShellStatus = "detached";
  private behavior: AgentBehavior | null = null;
  private selfState: Record<string, unknown> = {};
  private activeRuns = new Map<string, RoleRun>();
  private finishedRuns = new Map<string, RoleRun>();
  private completedRunResults: RoleRunResult[] = [];
  private finishedRunOrder: string[] = [];
  private onRunCompletedCallbacks: Array<(run: RoleRunHandle, status: RoleRunStatus) => void> = [];

  private graphs: Map<string, IRGraph>;
  private transport: ReagentTransport;
  private roleToAgent: RoleBindingMap | RoleBindingResolver;
  private traceHook?: TraceHook;
  private advanceHook?: (ctx: AdvanceHookContext) => Promise<void>;
  private extras?: Record<string, unknown>;
  private agentIR?: AgentIR;
  private emitBusCb?: EmitBusCallback;
  private roleSpawnCb?: (request: RoleSpawnRequest) => string;
  private reportTryScopeFaultCb?: (fault: ProtocolFault) => Promise<ProtocolFault>;
  private statusChangeCb?: ShellStatusChangeCallback;
  private runLifecycleCb?: (event: AgentShellRunLifecycleEvent) => void | Promise<void>;
  private runLifecycleChain: Promise<void> = Promise.resolve();
  private finishedRunRetentionLimit: number;

  private completionCount = 0;
  private completionWaiters: Array<{ target: number; resolve: () => void }> = [];

  constructor(config: AgentShellConfig) {
    this.name = config.agentName;
    this.role = config.roleName;
    this.graphs = config.graphs;
    this.transport = config.transport;
    this.roleToAgent = config.roleToAgent;
    this.traceHook = config.traceHook;
    this.advanceHook = config.advanceHook;
    this.extras = config.extras;
    this.agentIR = config.agentIR;
    this.emitBusCb = config.emitBusCallback;
    this.roleSpawnCb = config.roleSpawnCallback;
    this.reportTryScopeFaultCb = config.reportTryScopeFault;
    this.statusChangeCb = config.onStatusChange;
    this.runLifecycleCb = config.onRunLifecycleEvent;
    this.finishedRunRetentionLimit = Math.max(0, config.finishedRunRetentionLimit ?? 100);
  }

  get status(): AgentShellStatus { return this._status; }

  attachBehavior(behavior: AgentBehavior): void {
    this.behavior = behavior;
    this._status = "attached";
    this.statusChangeCb?.(this.name, "attached");
  }

  detachBehavior(): void {
    this.behavior = null;
    this._status = "detached";
    this.statusChangeCb?.(this.name, "detached");
  }

  setStatusChangeCallback(cb: ShellStatusChangeCallback | undefined): void {
    this.statusChangeCb = cb;
  }

  hasBehavior(): boolean { return this.behavior !== null; }

  async start(): Promise<void> {
    if (this.agentIR?.initAction) {
      const reagent = createReagentStub();
      executeZone(this.agentIR.initAction.body, {}, this.selfState, reagent, this.extras ? { $agent: this.extras } : undefined);
    }

    this.transport.onMessage((env) => this.dispatchMessage(env));
    console.log(`[${this.name}] AgentShell started`);
  }

  async stop(): Promise<void> {
    const active = [...this.activeRuns.values()];
    for (const run of active) {
      run.cancel("agent shell stopped");
    }
    await Promise.allSettled(active.map((run) => this.waitForRunStop(run)));
    console.log(`[${this.name}] AgentShell stopped`);
  }

  getSelf(): Record<string, unknown> { return this.selfState; }

  getActiveRuns(): Map<string, RoleRunHandle> { return this.activeRuns as unknown as Map<string, RoleRunHandle>; }

  getCompletedRuns(): RoleRunResult[] { return this.completedRunResults; }

  triggerProtocol(trigger: ProtocolTrigger): void {
    if (!this.behavior) {
      console.warn(`[${this.name}] triggerProtocol but no behavior attached`);
      return;
    }

    const binding = this.agentIR?.plays.find(p => p.protocolName === trigger.protocolName);
    const roleName = binding?.roleName ?? this.findRoleForProtocol(trigger.protocolName);
    if (!roleName) {
      console.warn(`[${this.name}] No role for protocol ${trigger.protocolName}`);
      return;
    }

    const graphKey = `${trigger.protocolName}.${roleName}`;
    const graph = this.graphs.get(graphKey);
    if (!graph) {
      console.warn(`[${this.name}] No graph for ${graphKey}`);
      return;
    }

    const rta = this.buildRoleBindings(trigger.protocolName, trigger.roleToAgent as any);

    const runConfig: RoleRunConfig = {
      instanceId: trigger.instanceId,
      protocolName: trigger.protocolName,
      agentName: this.name,
      roleName,
      roleToAgent: rta,
      input: trigger.input as Record<string, unknown>,
      traceHook: this.traceHook,
      advanceHook: this.advanceHook,
      roleSpawnCallback: (request) => this.performRoleSpawn(request),
      invokeCallback: (protoName, input, roleMapping) =>
        this.invokeChildProtocol(trigger.instanceId, trigger.protocolName, protoName, input, roleMapping, rta),
      spawnCallback: (protoName, input, roleMapping) =>
        this.spawnChildProtocol(trigger.instanceId, trigger.protocolName, protoName, input, roleMapping, rta),
      emitCallback: (eventName, data) =>
        this.handleEmit(trigger.protocolName, trigger.instanceId, eventName, data),
      reportTryScopeFault: (fault) => this.reportTryScopeFault(fault),
    };

    const run = new RoleRun(graph, this.behavior, this.transport, this.selfState, runConfig);
    this.emitRunLifecycle({
      type: "run_created",
      instanceId: trigger.instanceId,
      protocolName: trigger.protocolName,
      roleName,
      agentName: this.name,
      relationKind: "root",
      supervisionStrategy: graph.supervisionStrategy,
      origin: "trigger",
    });
    this.activeRuns.set(trigger.instanceId, run);

    run.onComplete((status) => {
      this.handleRunComplete(run, status);
    });

    run.run().catch(err => {
      console.error(`[${this.name}] Run error:`, err);
    });
  }

  dispatchMessage(env: MessageEnvelope): void {
    let run = this.activeRuns.get(env.instanceId);
    if (!run) {
      run = this.materializeReceiveSideRun(env) ?? undefined;
    }
    if (!run) {
      console.warn(`[${this.name}] No run for ${env.instanceId}, ignoring message ${env.messageName}`);
      return;
    }
    run.dispatchMessage(env);
  }

  onRunCompleted(cb: (run: RoleRunHandle, status: RoleRunStatus) => void): void {
    this.onRunCompletedCallbacks.push(cb);
  }

  cancelRun(instanceId: string, reason = "cancelled"): boolean {
    const run = this.activeRuns.get(instanceId);
    if (!run) return false;
    run.cancel(reason);
    return true;
  }

  notifyTryScopeFault(instanceId: string, fault: ProtocolFault): boolean {
    const run = this.activeRuns.get(instanceId);
    if (!run) return false;
    run.notifyTryScopeFault(fault);
    return true;
  }

  rebindRunRole(instanceId: string, roleName: string, agentName: string): boolean {
    const run = this.activeRuns.get(instanceId);
    if (!run) return false;
    run.rebindRole(roleName, agentName);
    return true;
  }

  toRecord(nodeId: string): AgentRecordDTO {
    return {
      name: this.name,
      role: this.role,
      nodeId,
      status: this._status,
      capabilities: [],
      metadata: { protocolRoles: this.agentIR?.plays.map(p => `${p.protocolName}.${p.roleName}`) ?? [] },
    };
  }

  // ── Legacy compat: waitForCompletion ─────────────────────────────

  waitForCompletion(expectedCount: number, timeoutMs = 30000): Promise<void> {
    if (this.completionCount >= expectedCount) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout: ${this.name} completed ${this.completionCount}/${expectedCount} instances`));
      }, timeoutMs);
      this.completionWaiters.push({
        target: expectedCount,
        resolve: () => { clearTimeout(timer); resolve(); },
      });
    });
  }

  getInstances(): Map<string, RoleRun> {
    const all = new Map(this.activeRuns);
    for (const [id, run] of this.finishedRuns) all.set(id, run);
    return all;
  }

  setAdvanceHook(hook: ((ctx: AdvanceHookContext) => Promise<void>) | undefined): void {
    this.advanceHook = hook;
  }

  setRoleSpawnCallback(cb: ((request: RoleSpawnRequest) => string) | undefined): void {
    this.roleSpawnCb = cb;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private findRoleForProtocol(protocolName: string): string | undefined {
    for (const [key] of this.graphs) {
      if (key.startsWith(`${protocolName}.`)) return key.split(".")[1];
    }
    return undefined;
  }

  private materializeReceiveSideRun(env: MessageEnvelope): RoleRun | null {
    if (!this.behavior) return null;

    const graphKey = `${env.protocolName}.${env.to.role}`;
    const graph = this.graphs.get(graphKey);
    if (!graph) return null;

    const roleBindings = this.buildRoleBindingsMap(env.protocolName);
    setRoleBinding(roleBindings, env.protocolName, env.from.role, env.from.agent);
    setRoleBinding(roleBindings, env.protocolName, env.to.role, env.to.agent);

    const runConfig: RoleRunConfig = {
      instanceId: env.instanceId,
      protocolName: env.protocolName,
      agentName: this.name,
      roleName: env.to.role,
      roleToAgent: roleBindings,
      traceHook: this.traceHook,
      advanceHook: this.advanceHook,
      roleSpawnCallback: (request) => this.performRoleSpawn(request),
      invokeCallback: (protoName, input, roleMapping) =>
        this.invokeChildProtocol(env.instanceId, env.protocolName, protoName, input, roleMapping, roleBindings),
      spawnCallback: (protoName, input, roleMapping) =>
        this.spawnChildProtocol(env.instanceId, env.protocolName, protoName, input, roleMapping, roleBindings),
      emitCallback: (eventName, data) =>
        this.handleEmit(env.protocolName, env.instanceId, eventName, data),
      reportTryScopeFault: (fault) => this.reportTryScopeFault(fault),
    };

    const run = new RoleRun(graph, this.behavior, this.transport, this.selfState, runConfig);
    this.emitRunLifecycle({
      type: "run_created",
      instanceId: env.instanceId,
      protocolName: env.protocolName,
      roleName: env.to.role,
      agentName: this.name,
      relationKind: "root",
      supervisionStrategy: graph.supervisionStrategy,
      origin: "receive_materialized",
    });
    this.activeRuns.set(env.instanceId, run);

    run.onComplete((status) => {
      this.handleRunComplete(run, status);
    });

    run.run().catch(err => {
      console.error(`[${this.name}] Run error:`, err);
    });

    return run;
  }

  private waitForRunStop(run: RoleRun): Promise<void> {
    if (isTerminalRoleRunStatus(run.status)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      run.onComplete(() => finish());
      if (isTerminalRoleRunStatus(run.status)) {
        finish();
      }
    });
  }

  private handleRunComplete(run: RoleRun, status: "completed" | "failed" | "cancelled"): void {
    const instanceId = run.identity.instanceId;
    this.activeRuns.delete(instanceId);
    this.finishedRuns.set(instanceId, run);
    this.finishedRunOrder.push(instanceId);
    this.completedRunResults.push({
      instanceId,
      protocolName: run.identity.protocolName,
      roleName: run.identity.roleName,
      status,
      returnValue: run.getReturnValue().has ? run.getReturnValue().value : undefined,
    });
    this.pruneFinishedRuns();
    this.completionCount++;

    if (this.agentIR) {
      for (const handler of this.agentIR.lifecycleHandlers) {
        let shouldFire = false;
        if (handler.event === "protocolCompleted" && status === "completed") shouldFire = true;
        if (handler.event === "protocolFailed" && (status === "failed" || status === "cancelled")) shouldFire = true;
        if (shouldFire && handler.protocolFilter) {
          shouldFire = handler.protocolFilter === run.identity.protocolName;
        }
        if (shouldFire) {
          const reagent = createReagentStub();
          executeZone(handler.action.body, {}, this.selfState, reagent);
        }
      }
    }

    const runHandle: RoleRunHandle = {
      instanceId: run.identity.instanceId,
      protocolName: run.identity.protocolName,
      roleName: run.identity.roleName,
      agentName: run.identity.agentName,
      status: run.status,
      dispatchMessage: (env) => run.dispatchMessage(env),
      run: () => run.run(),
      cancel: (reason?: string) => run.cancel(reason),
      getReturnValue: () => run.getReturnValue(),
    };
    this.emitRunLifecycle({
      type: "run_completed",
      instanceId: run.identity.instanceId,
      protocolName: run.identity.protocolName,
      roleName: run.identity.roleName,
      agentName: run.identity.agentName,
      status,
      returnValue: run.getReturnValue().has ? run.getReturnValue().value : undefined,
    });
    for (const cb of this.onRunCompletedCallbacks) cb(runHandle, status);
    for (const w of this.completionWaiters) {
      if (this.completionCount >= w.target) w.resolve();
    }
    this.completionWaiters = this.completionWaiters.filter(w => this.completionCount < w.target);
  }

  /** Clean up a child (invoke/spawn) run without counting toward top-level completion. */
  private handleChildRunComplete(run: RoleRun, status: "completed" | "failed" | "cancelled"): void {
    const instanceId = run.identity.instanceId;
    this.activeRuns.delete(instanceId);
    this.finishedRuns.set(instanceId, run);
    this.finishedRunOrder.push(instanceId);
    this.pruneFinishedRuns();
    this.emitRunLifecycle({
      type: "run_completed",
      instanceId: run.identity.instanceId,
      protocolName: run.identity.protocolName,
      roleName: run.identity.roleName,
      agentName: run.identity.agentName,
      status,
      returnValue: run.getReturnValue().has ? run.getReturnValue().value : undefined,
    });
  }

  private pruneFinishedRuns(): void {
    if (this.finishedRunRetentionLimit < 0) {
      return;
    }
    while (this.finishedRunOrder.length > this.finishedRunRetentionLimit) {
      const evictedInstanceId = this.finishedRunOrder.shift();
      if (!evictedInstanceId) break;
      this.finishedRuns.delete(evictedInstanceId);
      const resultIdx = this.completedRunResults.findIndex((result) => result.instanceId === evictedInstanceId);
      if (resultIdx >= 0) {
        this.completedRunResults.splice(resultIdx, 1);
      }
    }
  }

  private buildRoleBindings(
    protocolName: string,
    override?: LegacyRoleBindingMap,
  ): RoleBindingMap | RoleBindingResolver {
    if (typeof this.roleToAgent === "function") {
      if (!override) return this.roleToAgent;
      const fallback = this.roleToAgent;
      const normalizedOverride = normalizeRoleBindingMap(override);
      return (protoName: string, roleName: string) =>
        resolveRoleBinding(normalizedOverride, protoName, roleName) ?? fallback(protoName, roleName);
    }
    const merged: RoleBindingMap = { ...this.roleToAgent };
    mergeRoleBindings(protocolName, merged, override);
    return merged;
  }

  private buildRoleBindingsMap(protocolName: string): RoleBindingMap {
    const bindings = this.buildRoleBindings(protocolName);
    if (typeof bindings !== "function") return bindings;
    const mapped: RoleBindingMap = {};
    const plays = this.agentIR?.plays ?? [];
    for (const play of plays) {
      if (play.protocolName !== protocolName) continue;
      const resolved = bindings(protocolName, play.roleName);
      if (resolved) setRoleBinding(mapped, protocolName, play.roleName, resolved, resolved.cardinality);
    }
    return mapped;
  }

  private async invokeChildProtocol(
    parentInstanceId: string,
    parentProtoName: string,
    childProtoName: string,
    childInput?: Record<string, unknown>,
    roleMapping?: Record<string, string>,
    parentBindings?: RoleBindingMap | RoleBindingResolver,
  ): Promise<unknown> {
    if (!this.behavior) throw new Error("No behavior attached for invoke");

    const binding = this.agentIR?.plays.find(p => p.protocolName === childProtoName);
    if (!binding) throw new Error(`No plays binding for child protocol ${childProtoName}`);

    const graphKey = `${childProtoName}.${binding.roleName}`;
    const graph = this.graphs.get(graphKey);
    if (!graph) throw new Error(`No IRGraph for child ${graphKey}`);

    const childInstanceId = `${Date.now()}-child-${Math.random().toString(36).slice(2, 8)}`;
    const childRoleToAgent = this.buildChildRoleBindings(parentProtoName, childProtoName, roleMapping, parentBindings);

    const childConfig: RoleRunConfig = {
      instanceId: childInstanceId,
      protocolName: childProtoName,
      agentName: this.name,
      roleName: binding.roleName,
      roleToAgent: childRoleToAgent,
      input: childInput,
      traceHook: this.traceHook,
      advanceHook: this.advanceHook,
      roleSpawnCallback: (request) => this.performRoleSpawn(request),
      invokeCallback: (nestedProto, nestedInput, nestedRoleMapping) =>
        this.invokeChildProtocol(childInstanceId, childProtoName, nestedProto, nestedInput, nestedRoleMapping, childRoleToAgent),
      spawnCallback: (nestedProto, nestedInput, nestedRoleMapping) =>
        this.spawnChildProtocol(childInstanceId, childProtoName, nestedProto, nestedInput, nestedRoleMapping, childRoleToAgent),
      emitCallback: (eventName, data) =>
        this.handleEmit(childProtoName, childInstanceId, eventName, data),
      reportTryScopeFault: (fault) => this.reportTryScopeFault(fault),
    };

    const childRun = new RoleRun(graph, this.behavior, this.transport, this.selfState, childConfig);
    this.emitRunLifecycle({
      type: "run_created",
      instanceId: childInstanceId,
      protocolName: childProtoName,
      roleName: binding.roleName,
      agentName: this.name,
      relationKind: "invoke",
      supervisionStrategy: graph.supervisionStrategy,
      origin: "invoke",
      parentInstanceId,
      parentProtocolName: parentProtoName,
    });
    this.activeRuns.set(childInstanceId, childRun);

    return new Promise<unknown>((resolve, reject) => {
      childRun.onComplete((status) => {
        this.handleChildRunComplete(childRun, status);
        if (status === "completed") {
          const ret = childRun.getReturnValue();
          resolve(ret.has ? ret.value : undefined);
        } else {
          reject(childRun.getFailure() ?? new Error(`Child protocol ${childProtoName} failed`));
        }
      });
      childRun.run();
    });
  }

  private spawnChildProtocol(
    parentInstanceId: string,
    parentProtoName: string,
    childProtoName: string,
    childInput?: Record<string, unknown>,
    roleMapping?: Record<string, string>,
    parentBindings?: RoleBindingMap | RoleBindingResolver,
  ): void {
    const childInstanceId = `${Date.now()}-spawn-${Math.random().toString(36).slice(2, 8)}`;
    const override = this.buildChildRoleBindings(parentProtoName, childProtoName, roleMapping, parentBindings);

    if (!this.behavior) return;
    const binding = this.agentIR?.plays.find(p => p.protocolName === childProtoName);
    if (!binding) return;
    const graphKey = `${childProtoName}.${binding.roleName}`;
    const graph = this.graphs.get(graphKey);
    if (!graph) return;

    const childConfig: RoleRunConfig = {
      instanceId: childInstanceId,
      protocolName: childProtoName,
      agentName: this.name,
      roleName: binding.roleName,
      roleToAgent: override,
      input: childInput,
      traceHook: this.traceHook,
      advanceHook: this.advanceHook,
      roleSpawnCallback: (request) => this.performRoleSpawn(request),
      invokeCallback: (nestedProto, nestedInput, nestedRoleMapping) =>
        this.invokeChildProtocol(childInstanceId, childProtoName, nestedProto, nestedInput, nestedRoleMapping, override),
      spawnCallback: (nestedProto, nestedInput, nestedRoleMapping) =>
        this.spawnChildProtocol(childInstanceId, childProtoName, nestedProto, nestedInput, nestedRoleMapping, override),
      emitCallback: (eventName, data) =>
        this.handleEmit(childProtoName, childInstanceId, eventName, data),
      reportTryScopeFault: (fault) => this.reportTryScopeFault(fault),
    };

    const childRun = new RoleRun(graph, this.behavior, this.transport, this.selfState, childConfig);
    this.emitRunLifecycle({
      type: "run_created",
      instanceId: childInstanceId,
      protocolName: childProtoName,
      roleName: binding.roleName,
      agentName: this.name,
      relationKind: "async_invoke",
      supervisionStrategy: graph.supervisionStrategy,
      origin: "async_invoke",
      parentInstanceId,
      parentProtocolName: parentProtoName,
    });
    this.activeRuns.set(childInstanceId, childRun);

    childRun.onComplete((status) => {
      this.handleChildRunComplete(childRun, status);
    });

    childRun.run().catch(err => {
      console.error(`[${this.name}] Spawn error:`, err);
    });
  }

  private buildChildRoleBindings(
    parentProtocolName: string,
    childProtocolName: string,
    roleMapping?: Record<string, string>,
    parentBindings?: RoleBindingMap | RoleBindingResolver,
  ): RoleBindingMap {
    const childBindings = this.buildRoleBindingsMap(childProtocolName);
    if (!roleMapping) return childBindings;

    const source = parentBindings ?? this.buildRoleBindings(parentProtocolName);
    for (const [childRole, parentRole] of Object.entries(roleMapping)) {
      const resolved = resolveRoleBinding(source, parentProtocolName, parentRole);
      if (resolved) setRoleBinding(childBindings, childProtocolName, childRole, resolved, resolved.cardinality);
    }
    return childBindings;
  }

  private handleEmit(
    protocolName: string,
    instanceId: string,
    eventName: string,
    data?: Record<string, unknown>,
  ): void {
    if (this.agentIR) {
      for (const handler of this.agentIR.lifecycleHandlers) {
        if (handler.event === "protocolEvent" && handler.protocolFilter === eventName) {
          const reagent = createReagentStub();
          executeZone(handler.action.body, { eventName, data }, this.selfState, reagent, this.extras ? { $agent: this.extras } : undefined);
        }
      }
    }
    if (this.emitBusCb) {
      this.emitBusCb(eventName, data ?? {}, { agent: this.name, instanceId });
    }
  }

  private async reportTryScopeFault(fault: ProtocolFault): Promise<ProtocolFault> {
    if (!this.reportTryScopeFaultCb) {
      return fault;
    }
    return this.reportTryScopeFaultCb(fault);
  }

  private emitRunLifecycle(event: AgentShellRunLifecycleEvent): void {
    this.runLifecycleChain = this.runLifecycleChain
      .then(async () => {
        await this.runLifecycleCb?.(event);
      })
      .catch(() => {
        // Keep the chain alive even if bookkeeping fails.
      });
  }

  private performRoleSpawn(request: RoleSpawnRequest): string {
    if (!this.roleSpawnCb) {
      throw new Error(`role spawn for "${request.roleName}" but no roleSpawnCallback set`);
    }
    const agentName = this.roleSpawnCb(request);
    this.emitRunLifecycle({
      type: "spawn_recorded",
      instanceId: request.instanceId,
      roleName: request.roleName,
      agentName,
      bindAs: request.bindAs,
      persistent: request.persistent,
    });
    return agentName;
  }
}
