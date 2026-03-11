/**
 * AgentRunner — the top-level runtime for a Reagent agent.
 *
 * Manages:
 * - Agent-level $self state
 * - Lifecycle handlers (on protocolCompleted, etc.)
 * - Protocol instances (one per active protocol run)
 * - Message routing from ReagentTransport to correct ProtocolInstance
 */

import type { AgentIR, IRGraph, MessageEnvelope, ProtocolTrigger } from "../contracts/types.js";
import { ProtocolInstance, type InstanceConfig, type InstanceStatus, type AdvanceHook, type RoleSpawnRequest } from "./protocol-instance.js";
import { executeZone, createReagentStub } from "./zone-executor.js";
import type { ReagentTransport } from "../contracts/transport.js";
import type { TraceHook } from "../contracts/interceptor.js";
import type { LegacyRoleBindingMap, RoleBindingMap, RoleBindingResolver } from "../controller/role-bindings.js";
import { mergeRoleBindings, normalizeRoleBindingMap, resolveRoleBinding, setRoleBinding } from "../controller/role-bindings.js";

export type EmitBusCallback = (topic: string, payload: Record<string, unknown>, source: { agent: string; instanceId: string }) => void;

export type AgentRunnerConfig = {
  agentIR: AgentIR;
  graphs: Map<string, IRGraph>;
  transport: ReagentTransport;
  roleToAgent: RoleBindingMap | RoleBindingResolver;
  traceHook?: TraceHook;
  advanceHook?: AdvanceHook;
  extras?: Record<string, unknown>;
  emitBusCallback?: EmitBusCallback;
  roleSpawnCallback?: (request: RoleSpawnRequest) => string;
};

export class AgentRunner {
  readonly agentName: string;

  private agentIR: AgentIR;
  private graphs: Map<string, IRGraph>;
  private transport: ReagentTransport;
  private roleToAgent: RoleBindingMap | RoleBindingResolver;
  private traceHook?: TraceHook;

  private advanceHook?: AdvanceHook;
  private extras?: Record<string, unknown>;
  private emitBusCb?: EmitBusCallback;
  private roleSpawnCb?: (request: RoleSpawnRequest) => string;
  private self: Record<string, unknown> = {};
  private instances: Map<string, ProtocolInstance> = new Map();
  private completedCount = 0;
  private onAllDone: (() => void) | null = null;

  constructor(config: AgentRunnerConfig) {
    this.agentName = config.agentIR.agentName;
    this.agentIR = config.agentIR;
    this.graphs = config.graphs;
    this.transport = config.transport;
    this.roleToAgent = config.roleToAgent;
    this.traceHook = config.traceHook;
    this.advanceHook = config.advanceHook;
    this.extras = config.extras;
    this.emitBusCb = config.emitBusCallback;
    this.roleSpawnCb = config.roleSpawnCallback;
  }

  setAdvanceHook(hook: AdvanceHook | undefined): void {
    this.advanceHook = hook;
  }

  setRoleSpawnCallback(cb: ((request: RoleSpawnRequest) => string) | undefined): void {
    this.roleSpawnCb = cb;
  }

  async start(): Promise<void> {
    if (this.agentIR.initAction) {
      const reagent = createReagentStub();
      executeZone(this.agentIR.initAction.body, {}, this.self, reagent, this.extras ? { $agent: this.extras } : undefined);
    }

    this.transport.onMessage((env) => this.handleMessage(env));

    console.log(`[${this.agentName}] Agent started`);
  }

  async stop(): Promise<void> {
    console.log(`[${this.agentName}] Agent stopped`);
  }

  waitForCompletion(expectedCount: number, timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.completedCount >= expectedCount) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`Timeout: ${this.agentName} completed ${this.completedCount}/${expectedCount} instances`));
      }, timeoutMs);

      this.onAllDone = () => {
        if (this.completedCount >= expectedCount) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  getSelf(): Record<string, unknown> {
    return this.self;
  }

  getInstances(): Map<string, ProtocolInstance> {
    return this.instances;
  }

  getTransport(): ReagentTransport {
    return this.transport;
  }

  /** Dispatch an inbound message to the appropriate ProtocolInstance by instanceId. */
  dispatchMessage(env: MessageEnvelope): void {
    this.handleMessage(env);
  }

  /** Trigger a protocol instance (external entry point, e.g. from RC). */
  triggerProtocol(trigger: ProtocolTrigger): void {
    this.startProtocolInstance(
      trigger.instanceId,
      trigger.protocolName,
      trigger.input,
      trigger.roleToAgent,
    );
  }

  private handleMessage(env: MessageEnvelope): void {
    let instance: ProtocolInstance | null | undefined = this.instances.get(env.instanceId);
    if (!instance) {
      instance = this.materializeReceiveSideInstance(env);
    }
    if (!instance) {
      console.warn(`[${this.agentName}] No instance for ${env.instanceId}, ignoring message ${env.messageName}`);
      return;
    }
    instance.dispatchMessage(env);
  }

  startProtocolInstance(
    instanceId: string,
    protocolName: string,
    input?: Record<string, unknown>,
    roleToAgentOverride?: LegacyRoleBindingMap,
  ): ProtocolInstance | null {
    const binding = this.agentIR.plays.find(p => p.protocolName === protocolName);
    if (!binding) {
      console.warn(`[${this.agentName}] No plays binding for protocol ${protocolName}`);
      return null;
    }

    const graphKey = `${protocolName}.${binding.roleName}`;
    const graph = this.graphs.get(graphKey);
    if (!graph) {
      console.warn(`[${this.agentName}] No IRGraph for ${graphKey}`);
      return null;
    }

    const rta = this.buildRoleBindings(protocolName, roleToAgentOverride);

    const instanceConfig: InstanceConfig = {
      instanceId,
      protocolName,
      agentName: this.agentName,
      roleName: binding.roleName,
      roleToAgent: rta,
      input,
      traceHook: this.traceHook,
      advanceHook: this.advanceHook,
      extras: this.extras,
    };

    const instance = new ProtocolInstance(graph, this.transport, this.self, instanceConfig);
    this.instances.set(instanceId, instance);

    instance.setOnComplete((status) => {
      this.handleInstanceComplete(instanceId, protocolName, status);
    });

    instance.setInvokeCallback(async (childProtoName, childInput, roleMapping) => {
      return this.invokeChildProtocol(protocolName, childProtoName, childInput, roleMapping, rta);
    });

    instance.setSpawnCallback((childProtoName, childInput, roleMapping) => {
      this.spawnChildProtocol(protocolName, childProtoName, childInput, roleMapping, rta);
    });
    if (this.roleSpawnCb) {
      instance.setRoleSpawnCallback((request) => this.roleSpawnCb!(request));
    }

    instance.setEmitCallback((eventName, data) => {
      this.handleEmit(protocolName, instanceId, eventName, data);
    });

    instance.run();

    return instance;
  }

  private materializeReceiveSideInstance(env: MessageEnvelope): ProtocolInstance | null {
    const graphKey = `${env.protocolName}.${env.to.role}`;
    const graph = this.graphs.get(graphKey);
    if (!graph) {
      return null;
    }

    const roleBindings = this.buildRoleBindingsMap(env.protocolName);
    setRoleBinding(roleBindings, env.protocolName, env.from.role, env.from.agent);
    setRoleBinding(roleBindings, env.protocolName, env.to.role, env.to.agent);

    const instanceConfig: InstanceConfig = {
      instanceId: env.instanceId,
      protocolName: env.protocolName,
      agentName: this.agentName,
      roleName: env.to.role,
      roleToAgent: roleBindings,
      input: undefined,
      traceHook: this.traceHook,
      advanceHook: this.advanceHook,
      extras: this.extras,
    };

    const instance = new ProtocolInstance(graph, this.transport, this.self, instanceConfig);
    this.instances.set(env.instanceId, instance);

    instance.setOnComplete((status) => {
      this.handleInstanceComplete(env.instanceId, env.protocolName, status);
    });

    instance.setInvokeCallback(async (childProtoName, childInput, roleMapping) => {
      return this.invokeChildProtocol(env.protocolName, childProtoName, childInput, roleMapping, roleBindings);
    });

    instance.setSpawnCallback((childProtoName, childInput, roleMapping) => {
      this.spawnChildProtocol(env.protocolName, childProtoName, childInput, roleMapping, roleBindings);
    });
    if (this.roleSpawnCb) {
      instance.setRoleSpawnCallback((request) => this.roleSpawnCb!(request));
    }

    instance.setEmitCallback((eventName, data) => {
      this.handleEmit(env.protocolName, env.instanceId, eventName, data);
    });

    instance.run();
    return instance;
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

  private buildRoleBindingsMap(protocolName: string, override?: LegacyRoleBindingMap): RoleBindingMap {
    const bindings = this.buildRoleBindings(protocolName, override);
    if (typeof bindings !== "function") {
      return bindings;
    }

    const mapped: RoleBindingMap = {};
    for (const play of this.agentIR.plays) {
      if (play.protocolName !== protocolName) continue;
      const resolved = bindings(protocolName, play.roleName);
      if (resolved) {
        setRoleBinding(mapped, protocolName, play.roleName, resolved, resolved.cardinality);
      }
    }
    return mapped;
  }

  private buildChildRoleBindings(
    parentProtocolName: string,
    childProtocolName: string,
    roleMapping?: Record<string, string>,
    parentBindings?: RoleBindingMap | RoleBindingResolver,
  ): RoleBindingMap {
    const childBindings = this.buildRoleBindingsMap(childProtocolName);
    if (!roleMapping) {
      return childBindings;
    }

    const source = parentBindings ?? this.buildRoleBindings(parentProtocolName);
    for (const [childRole, parentRole] of Object.entries(roleMapping)) {
      const resolved = resolveRoleBinding(source, parentProtocolName, parentRole);
      if (resolved) {
        setRoleBinding(childBindings, childProtocolName, childRole, resolved, resolved.cardinality);
      }
    }
    return childBindings;
  }

  private spawnChildProtocol(
    parentProtocolName: string,
    childProtoName: string,
    childInput?: Record<string, unknown>,
    roleMapping?: Record<string, string>,
    parentBindings?: RoleBindingMap | RoleBindingResolver,
  ): void {
    const childInstanceId = `${Date.now()}-spawn-${Math.random().toString(36).slice(2, 8)}`;
    const override = this.buildChildRoleBindings(parentProtocolName, childProtoName, roleMapping, parentBindings);
    const instance = this.startProtocolInstance(childInstanceId, childProtoName, childInput, override);
    if (!instance) {
      console.warn(`[${this.agentName}] Failed to spawn child protocol ${childProtoName}`);
    }
  }

  private handleEmit(
    protocolName: string,
    instanceId: string,
    eventName: string,
    data?: Record<string, unknown>,
  ): void {
    for (const handler of this.agentIR.lifecycleHandlers) {
      if (handler.event === "protocolEvent" && handler.protocolFilter === eventName) {
        const reagent = createReagentStub();
        executeZone(handler.action.body, { eventName, data }, this.self, reagent, this.extras ? { $agent: this.extras } : undefined);
      }
    }

    // Propagate to event bus for trigger matching
    if (this.emitBusCb) {
      this.emitBusCb(eventName, data ?? {}, { agent: this.agentName, instanceId });
    }
  }

  private async invokeChildProtocol(
    parentProtocolName: string,
    childProtoName: string,
    childInput?: Record<string, unknown>,
    roleMapping?: Record<string, string>,
    parentBindings?: RoleBindingMap | RoleBindingResolver,
  ): Promise<unknown> {
    const binding = this.agentIR.plays.find(p => p.protocolName === childProtoName);
    if (!binding) {
      throw new Error(`[${this.agentName}] No plays binding for child protocol ${childProtoName}`);
    }

    const graphKey = `${childProtoName}.${binding.roleName}`;
    const graph = this.graphs.get(graphKey);
    if (!graph) {
      throw new Error(`[${this.agentName}] No IRGraph for child ${graphKey}`);
    }

    const childInstanceId = `${Date.now()}-child-${Math.random().toString(36).slice(2, 8)}`;

    const childConfig: InstanceConfig = {
      instanceId: childInstanceId,
      protocolName: childProtoName,
      agentName: this.agentName,
      roleName: binding.roleName,
      roleToAgent: this.buildChildRoleBindings(parentProtocolName, childProtoName, roleMapping, parentBindings),
      input: childInput,
      traceHook: this.traceHook,
      extras: this.extras,
    };

    const childInstance = new ProtocolInstance(graph, this.transport, this.self, childConfig);

    childInstance.setInvokeCallback(async (nestedProto, nestedInput, nestedRoleMapping) => {
      return this.invokeChildProtocol(childProtoName, nestedProto, nestedInput, nestedRoleMapping, childConfig.roleToAgent);
    });
    if (this.roleSpawnCb) {
      childInstance.setRoleSpawnCallback((request) => this.roleSpawnCb!(request));
    }

    return new Promise<unknown>((resolve, reject) => {
      childInstance.setOnComplete((status) => {
        if (status === "completed") {
          const ret = childInstance.getReturnValue();
          resolve(ret.has ? ret.value : undefined);
        } else {
          reject(new Error(`Child protocol ${childProtoName} failed`));
        }
      });
      childInstance.run();
    });
  }

  private handleInstanceComplete(instanceId: string, protocolName: string, status: InstanceStatus): void {
    this.completedCount++;
    console.log(`[${this.agentName}] Instance ${instanceId} completed with status: ${status}`);

    for (const handler of this.agentIR.lifecycleHandlers) {
      let shouldFire = false;
      if (handler.event === "protocolCompleted" && status === "completed") shouldFire = true;
      if (handler.event === "protocolFailed" && status === "failed") shouldFire = true;

      if (shouldFire && handler.protocolFilter) {
        shouldFire = handler.protocolFilter === protocolName;
      }

      if (shouldFire) {
        const reagent = createReagentStub();
        executeZone(handler.action.body, {}, this.self, reagent);
      }
    }

    this.onAllDone?.();
  }
}
