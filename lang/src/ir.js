/**
 * Reagent IR — v0.0.5
 *
 * Two levels of IR:
 *
 * 1. Protocol IR (IRGraph) — per-role state machine representation.
 *    Each role in a protocol gets its own IRGraph — the local view of the global choreography.
 *    The IR is a directed graph: states (nodes) connected by transitions (edges).
 *
 * 2. Agent IR (AgentIR) — per-agent metadata that ties protocols together.
 *    Each agent gets an AgentIR describing which protocols it plays,
 *    its init action, and lifecycle event handlers.
 */
export {};
