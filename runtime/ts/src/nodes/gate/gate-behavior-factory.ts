/**
 * GateBehaviorFactory — R1 ontology.
 *
 * Creates gate-backed proxy behaviors for external agents connected
 * via WebSocket, stdio, or HTTP. Replaces MessageGateNode.
 *
 * The behavior proxies ProtocolEvents to the gate transport and
 * collects AgentResponses back.
 */

import type { RoleIR, IRGraph } from "../../contracts/types.js";
import type { AgentBehavior } from "../../contracts/agent-behavior.js";
import type { BehaviorFactory } from "../../contracts/behavior-factory.js";
import type { GateTransport } from "./gate-transport.js";
import type { ProtocolEvent, AgentResponse } from "../../core/protocol-engine.js";

export interface GateBehaviorFactoryConfig {
  transportFactory: (agentName: string) => GateTransport;
}

class GateBehavior implements AgentBehavior {
  private transport: GateTransport;
  private pendingResolvers: Array<(response: AgentResponse) => void> = [];

  constructor(transport: GateTransport) {
    this.transport = transport;
    this.transport.onResponse((response) => {
      const resolve = this.pendingResolvers.shift();
      if (resolve) resolve(response);
    });
  }

  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    return new Promise<AgentResponse>((resolve) => {
      this.pendingResolvers.push(resolve);
      this.transport.send(event);
    });
  }
}

export class GateBehaviorFactory implements BehaviorFactory {
  readonly runtimeName = "gate";
  private transportFactory: (agentName: string) => GateTransport;

  constructor(config: GateBehaviorFactoryConfig) {
    this.transportFactory = config.transportFactory;
  }

  createBehavior(
    agentName: string,
    _roleIR: RoleIR,
    _graphs: Map<string, IRGraph>,
    _extras?: Record<string, unknown>,
  ): AgentBehavior {
    const transport = this.transportFactory(agentName);
    return new GateBehavior(transport);
  }

  async destroyBehavior(_behavior: AgentBehavior): Promise<void> {}
}
