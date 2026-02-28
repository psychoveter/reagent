/**
 * Reagent IR — v0.0.14
 *
 * Four levels of IR:
 *
 * 1. Protocol IR (IRGraph) — per-role state machine representation.
 *    Each role in a protocol gets its own IRGraph — the local view of the global choreography.
 *    The IR is a directed graph: states (nodes) connected by transitions (edges).
 *
 * 2. Role IR (RoleIR) — per-role behavioral contract with lifecycle.
 *    Rich representation of the role: plays, init, handlers, inheritance chain.
 *
 * 3. Agent IR (AgentIR) — per-agent deployment binding with optional metadata.
 *    References the role it runs; the runtime resolves behavioral details from RoleIR.
 *
 * 4. Agent Registration IR (AgentRegistrationIR) — agent metadata for resolve policies.
 */
export {};
