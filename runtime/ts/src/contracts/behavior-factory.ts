/**
 * BehaviorFactory — R1 ontology.
 *
 * Runtime-kind-specific factory for creating AgentBehavior objects.
 * Replaces the old AgentNode interface. The factory does not own
 * shell semantics — it only supplies the behavior object.
 *
 * Realizations:
 *   - ManagedBehaviorFactory: creates ManagedBehavior (zone executor)
 *   - CustomBehaviorFactory: wraps a user-supplied AgentBehavior
 *   - GateBehaviorFactory: creates gate-backed proxy behaviors
 *   - PythonBehaviorFactory: bridges to the Python runtime subprocess
 */

import type { RoleIR, IRGraph } from "./types.js";
import type { AgentBehavior } from "./agent-behavior.js";

export interface BehaviorFactory {
  readonly runtimeName: string;

  createBehavior(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    extras?: Record<string, unknown>,
  ): AgentBehavior;

  destroyBehavior?(behavior: AgentBehavior): Promise<void>;
}
