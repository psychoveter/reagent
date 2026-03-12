/**
 * ManagedBehaviorFactory — creates ManagedAgentBehavior instances
 * that execute .rg zone code.
 */

import type { RoleIR, IRGraph } from "../contracts/types.js";
import type { AgentBehavior } from "../contracts/agent-behavior.js";
import type { BehaviorFactory } from "../contracts/behavior-factory.js";
import { ManagedAgentBehavior, type ManagedBehaviorConfig } from "../core/agent-interface.js";

export class ManagedBehaviorFactory implements BehaviorFactory {
  readonly runtimeName = "managed-ts";

  createBehavior(
    _agentName: string,
    _roleIR: RoleIR,
    _graphs: Map<string, IRGraph>,
    extras?: Record<string, unknown>,
  ): AgentBehavior {
    const config: ManagedBehaviorConfig = { extras };
    return new ManagedAgentBehavior(config);
  }

  async destroyBehavior(_behavior: AgentBehavior): Promise<void> {}
}
