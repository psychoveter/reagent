/**
 * CustomBehaviorFactory — R1 ontology.
 *
 * Wraps a user-supplied AgentBehavior factory function.
 * Replaces CustomAgentNode.
 */

import type { RoleIR, IRGraph } from "../contracts/types.js";
import type { AgentBehavior } from "../contracts/agent-behavior.js";
import type { BehaviorFactory } from "../contracts/behavior-factory.js";

export interface CustomBehaviorFactoryConfig {
  behaviorFactory: (agentName: string, roleIR: RoleIR) => AgentBehavior;
}

export class CustomBehaviorFactory implements BehaviorFactory {
  readonly runtimeName = "custom";
  private factory: (agentName: string, roleIR: RoleIR) => AgentBehavior;

  constructor(config: CustomBehaviorFactoryConfig) {
    this.factory = config.behaviorFactory;
  }

  createBehavior(
    agentName: string,
    roleIR: RoleIR,
    _graphs: Map<string, IRGraph>,
    _extras?: Record<string, unknown>,
  ): AgentBehavior {
    return this.factory(agentName, roleIR);
  }

  async destroyBehavior(_behavior: AgentBehavior): Promise<void> {}
}
