/**
 * PythonBehaviorFactory — R1 ontology stub.
 *
 * Thin factory for Python-backed agents. The actual Python subprocess
 * management is deferred (per backlog). This provides the interface
 * so that the RC can register it.
 */

import type { RoleIR, IRGraph } from "../contracts/types.js";
import type { AgentBehavior } from "../contracts/agent-behavior.js";
import type { BehaviorFactory } from "../contracts/behavior-factory.js";
import type { ProtocolEvent, AgentResponse } from "../core/protocol-engine.js";

export class PythonBehaviorFactory implements BehaviorFactory {
  readonly runtimeName = "python";

  createBehavior(
    agentName: string,
    _roleIR: RoleIR,
    _graphs: Map<string, IRGraph>,
    _extras?: Record<string, unknown>,
  ): AgentBehavior {
    return {
      async handle(event: ProtocolEvent): Promise<AgentResponse> {
        throw new Error(`PythonBehaviorFactory: not yet implemented (agent: ${agentName})`);
      },
    };
  }

  async destroyBehavior(_behavior: AgentBehavior): Promise<void> {}
}
