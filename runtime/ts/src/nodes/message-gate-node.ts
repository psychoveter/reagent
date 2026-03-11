/**
 * MessageGateNode — AgentNode that bridges external agents via GateTransport.
 *
 * External agents implement the ProtocolEvent/AgentResponse wire protocol
 * over WebSocket, stdio, or HTTP. The MessageGateNode manages GateSessions
 * and routes messages through the transport.
 */

import type { RoleIR, IRGraph, MessageEnvelope, ProtocolTrigger } from "../contracts/types.js";
import type { ReagentTransport } from "../contracts/transport.js";
import type { AgentNode, AgentHandle } from "../contracts/agent-node.js";
import type { GateTransport } from "../gate/gate-transport.js";
import { GateSession, type GateSessionConfig } from "../gate/gate-session.js";
import type { AgentResponse } from "../core/protocol-engine.js";

export interface MessageGateNodeConfig {
  roleToAgent: Record<string, string>;
  transportFactory: (agentName: string) => GateTransport;
}

export class MessageGateHandle implements AgentHandle {
  readonly agentName: string;
  private transport: GateTransport;
  private roleToAgent: Record<string, string>;
  private sessions: Map<string, GateSession> = new Map();
  private selfState: Record<string, unknown> = {};
  private completionCount = 0;
  private completionWaiters: Array<{ target: number; resolve: () => void }> = [];

  constructor(
    agentName: string,
    transport: GateTransport,
    roleToAgent: Record<string, string>,
  ) {
    this.agentName = agentName;
    this.transport = transport;
    this.roleToAgent = roleToAgent;
  }

  async start(): Promise<void> {
    console.log(`[${this.agentName}] Message Gate agent started`);
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.transport.close();
    console.log(`[${this.agentName}] Message Gate agent stopped`);
  }

  getSelf(): Record<string, unknown> {
    return this.selfState;
  }

  waitForCompletion(expectedCount: number, timeoutMs = 10000): Promise<void> {
    if (this.completionCount >= expectedCount) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${expectedCount} completions`)), timeoutMs);
      this.completionWaiters.push({
        target: expectedCount,
        resolve: () => { clearTimeout(timer); resolve(); },
      });
    });
  }

  triggerProtocol(trigger: ProtocolTrigger): void {
    const session = new GateSession({
      sessionId: trigger.instanceId,
      agentName: this.agentName,
      protocolName: trigger.protocolName,
      transport: this.transport,
    });
    this.sessions.set(trigger.instanceId, session);

    session.sendNotification({
      type: "protocol_started",
      protocolName: trigger.protocolName,
    });
  }

  dispatchMessage(env: MessageEnvelope): void {
    const session = this.sessions.get(env.instanceId);
    if (!session) {
      console.warn(`[${this.agentName}] No gate session for ${env.instanceId}`);
      return;
    }
    session.sendNotification({
      type: "receive_required",
      stateId: "",
      from: env.from.agent,
      messageName: env.messageName,
    });
  }

  private onInstanceComplete(instanceId: string): void {
    this.completionCount++;
    for (const w of this.completionWaiters) {
      if (this.completionCount >= w.target) w.resolve();
    }
    this.completionWaiters = this.completionWaiters.filter(w => this.completionCount < w.target);
  }
}

export class MessageGateNode implements AgentNode {
  readonly runtimeName = "gate";
  private transportFactory: (agentName: string) => GateTransport;
  private roleToAgent: Record<string, string>;

  constructor(config: MessageGateNodeConfig) {
    this.transportFactory = config.transportFactory;
    this.roleToAgent = config.roleToAgent;
  }

  createAgent(
    agentName: string,
    _roleIR: RoleIR,
    _graphs: Map<string, IRGraph>,
    _transport: ReagentTransport,
  ): AgentHandle {
    const gateTransport = this.transportFactory(agentName);
    return new MessageGateHandle(agentName, gateTransport, this.roleToAgent);
  }

  async destroyAgent(handle: AgentHandle): Promise<void> {
    await handle.stop();
  }
}
