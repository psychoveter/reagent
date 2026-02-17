/**
 * AgentRunner — the top-level runtime for a Reagent agent.
 *
 * One OS process per agent. Manages:
 * - Agent-level $self state
 * - Lifecycle handlers (on protocolCompleted, etc.)
 * - Protocol instances (one per active protocol run)
 * - Message routing from NATS to correct ProtocolInstance
 */

import type { AgentIR, IRGraph, MessageEnvelope, ProtocolTrigger } from "./types.js";
import { msgSubscribePattern, triggerSubject } from "./types.js";
import { NatsTransport } from "./nats-transport.js";
import { ProtocolInstance, type InstanceConfig, type InstanceStatus } from "./protocol-instance.js";
import { executeZone, createReagentStub } from "./zone-executor.js";

export type AgentRunnerConfig = {
  agentIR: AgentIR;
  graphs: Map<string, IRGraph>;
  natsUrl: string;
  roleToAgent: Record<string, string>;
};

export class AgentRunner {
  readonly agentName: string;

  private agentIR: AgentIR;
  private graphs: Map<string, IRGraph>;
  private transport: NatsTransport;
  private roleToAgent: Record<string, string>;

  private self: Record<string, unknown> = {};
  private instances: Map<string, ProtocolInstance> = new Map();
  private completedCount = 0;
  private onAllDone: (() => void) | null = null;

  constructor(config: AgentRunnerConfig) {
    this.agentName = config.agentIR.agentName;
    this.agentIR = config.agentIR;
    this.graphs = config.graphs;
    this.transport = new NatsTransport(config.natsUrl);
    this.roleToAgent = config.roleToAgent;
  }

  async start(): Promise<void> {
    await this.transport.connect();

    if (this.agentIR.initAction) {
      const reagent = createReagentStub();
      executeZone(this.agentIR.initAction.body, {}, this.self, reagent);
    }

    this.transport.subscribe(
      msgSubscribePattern(this.agentName),
      (data, _subject) => this.handleMessage(data as MessageEnvelope, _subject),
    );

    this.transport.subscribe(
      triggerSubject(this.agentName),
      (data) => this.handleTrigger(data as ProtocolTrigger),
    );

    console.log(`[${this.agentName}] Agent started, subscribed to messages`);
  }

  async stop(): Promise<void> {
    await this.transport.close();
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

  getTransport(): NatsTransport {
    return this.transport;
  }

  private handleMessage(env: MessageEnvelope, _subject: string): void {
    const instance = this.instances.get(env.instanceId);
    if (!instance) {
      console.warn(`[${this.agentName}] No instance for ${env.instanceId}, ignoring message ${env.messageName}`);
      return;
    }
    instance.dispatchMessage(env);
  }

  private handleTrigger(trigger: ProtocolTrigger): void {
    this.startProtocolInstance(
      trigger.instanceId,
      trigger.protocolName,
      trigger.input,
      trigger.roleToAgent,
    );
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
    };

    const instance = new ProtocolInstance(graph, this.transport, this.self, instanceConfig);
    this.instances.set(instanceId, instance);

    instance.setOnComplete((status) => {
      this.handleInstanceComplete(instanceId, protocolName, status);
    });

    instance.run();

    return instance;
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
