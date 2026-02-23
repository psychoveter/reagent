/**
 * AgentRunner — the top-level runtime for a Reagent agent.
 *
 * Manages:
 * - Agent-level $self state
 * - Lifecycle handlers (on protocolCompleted, etc.)
 * - Protocol instances (one per active protocol run)
 * - Message routing from ReagentTransport to correct ProtocolInstance
 */

import type { AgentIR, IRGraph, MessageEnvelope, ProtocolTrigger } from "./types.js";
import { ProtocolInstance, type InstanceConfig, type InstanceStatus, type AdvanceHook } from "./protocol-instance.js";
import { executeZone, createReagentStub } from "./zone-executor.js";
import type { ReagentTransport } from "./transport.js";
import type { TraceHook } from "./interceptor.js";

export type AgentRunnerConfig = {
  agentIR: AgentIR;
  graphs: Map<string, IRGraph>;
  transport: ReagentTransport;
  roleToAgent: Record<string, string>;
  traceHook?: TraceHook;
  advanceHook?: AdvanceHook;
  extras?: Record<string, unknown>;
};

export class AgentRunner {
  readonly agentName: string;

  private agentIR: AgentIR;
  private graphs: Map<string, IRGraph>;
  private transport: ReagentTransport;
  private roleToAgent: Record<string, string>;
  private traceHook?: TraceHook;

  private advanceHook?: AdvanceHook;
  private extras?: Record<string, unknown>;
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
  }

  async start(): Promise<void> {
    if (this.agentIR.initAction) {
      const reagent = createReagentStub();
      executeZone(this.agentIR.initAction.body, {}, this.self, reagent, undefined, this.extras ? { $agent: this.extras } : undefined);
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
    const instance = this.instances.get(env.instanceId);
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
    roleToAgentOverride?: Record<string, string>,
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

    const rta = roleToAgentOverride ?? this.roleToAgent;

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

    instance.setInvokeCallback(async (childProtoName, childInput) => {
      return this.invokeChildProtocol(childProtoName, childInput);
    });

    instance.setSpawnCallback((childProtoName, childInput) => {
      this.spawnChildProtocol(childProtoName, childInput);
    });

    instance.setEmitCallback((eventName, data) => {
      this.handleEmit(protocolName, instanceId, eventName, data);
    });

    instance.run();

    return instance;
  }

  private spawnChildProtocol(childProtoName: string, childInput?: Record<string, unknown>): void {
    const childInstanceId = `${Date.now()}-spawn-${Math.random().toString(36).slice(2, 8)}`;
    const instance = this.startProtocolInstance(childInstanceId, childProtoName, childInput);
    if (!instance) {
      console.warn(`[${this.agentName}] Failed to spawn child protocol ${childProtoName}`);
    }
  }

  private handleEmit(
    protocolName: string,
    _instanceId: string,
    eventName: string,
    data?: Record<string, unknown>,
  ): void {
    for (const handler of this.agentIR.lifecycleHandlers) {
      if (handler.event === "protocolEvent" && handler.protocolFilter === eventName) {
        const reagent = createReagentStub();
        executeZone(handler.action.body, { eventName, data }, this.self, reagent, undefined, this.extras ? { $agent: this.extras } : undefined);
      }
    }
  }

  private async invokeChildProtocol(
    childProtoName: string,
    childInput?: Record<string, unknown>,
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
      roleToAgent: this.roleToAgent,
      input: childInput,
      traceHook: this.traceHook,
      extras: this.extras,
    };

    const childInstance = new ProtocolInstance(graph, this.transport, this.self, childConfig);

    childInstance.setInvokeCallback(async (nestedProto, nestedInput) => {
      return this.invokeChildProtocol(nestedProto, nestedInput);
    });

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
