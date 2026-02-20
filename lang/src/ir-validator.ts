/**
 * Reagent IR Validator — v0.0.8
 *
 * Static checks on an IRGraph:
 *   - Well-formed: all transition refs point to existing states.
 *   - Reachable: all states are reachable from initial.
 *   - Terminal: at least one terminal state exists and is reachable.
 *   - No dangling: no unreferenced states (except initial).
 *   - Fork/join consistency: fork branchStartIds exist; join branchCount > 0.
 */

import type { IRGraph } from "./ir.js";

export type ValidationError = {
  code: string;
  message: string;
  stateId?: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: ValidationError[];
  stats: {
    stateCount: number;
    transitionCount: number;
    reachableCount: number;
    terminalCount: number;
  };
};

export function validateIRGraph(graph: IRGraph): ValidationResult {
  const errors: ValidationError[] = [];
  const stateIds = new Set(graph.states.map(s => s.id));

  // 1. Check all transition refs point to existing states
  for (const t of graph.transitions) {
    if (!stateIds.has(t.from)) {
      errors.push({
        code: "E_DANGLING_FROM",
        message: `Transition from non-existent state '${t.from}'`,
        stateId: t.from,
      });
    }
    if (!stateIds.has(t.to)) {
      errors.push({
        code: "E_DANGLING_TO",
        message: `Transition to non-existent state '${t.to}'`,
        stateId: t.to,
      });
    }
  }

  // 2. Check initial state exists
  if (!stateIds.has(graph.initialStateId)) {
    errors.push({
      code: "E_NO_INITIAL",
      message: `Initial state '${graph.initialStateId}' does not exist`,
    });
  }

  // 3. Check terminal states exist
  for (const tid of graph.terminalStateIds) {
    if (!stateIds.has(tid)) {
      errors.push({
        code: "E_NO_TERMINAL",
        message: `Terminal state '${tid}' does not exist`,
        stateId: tid,
      });
    }
  }

  if (graph.terminalStateIds.length === 0) {
    errors.push({
      code: "E_NO_TERMINAL",
      message: "Graph has no terminal states",
    });
  }

  // 4. Reachability analysis (BFS from initial)
  const reachable = new Set<string>();
  const queue = [graph.initialStateId];
  while (queue.length > 0) {
    const sid = queue.shift()!;
    if (reachable.has(sid)) continue;
    reachable.add(sid);
    for (const t of graph.transitions) {
      if (t.from === sid && !reachable.has(t.to)) {
        queue.push(t.to);
      }
    }
  }

  // Check unreachable states
  for (const s of graph.states) {
    if (!reachable.has(s.id)) {
      errors.push({
        code: "W_UNREACHABLE",
        message: `State '${s.id}' is unreachable from initial`,
        stateId: s.id,
      });
    }
  }

  // Check terminal reachability
  const terminalReachable = graph.terminalStateIds.filter(tid => reachable.has(tid));
  if (terminalReachable.length === 0 && graph.terminalStateIds.length > 0) {
    errors.push({
      code: "E_TERMINAL_UNREACHABLE",
      message: "No terminal state is reachable from initial",
    });
  }

  // 5. Fork/join/scatter consistency
  for (const s of graph.states) {
    if (s.data.kind === "fork") {
      for (const bid of s.data.branchStartIds) {
        if (!stateIds.has(bid)) {
          errors.push({
            code: "E_FORK_DANGLING",
            message: `Fork state '${s.id}' references non-existent branch start '${bid}'`,
            stateId: s.id,
          });
        }
      }
    }
    if (s.data.kind === "scatter") {
      for (const bid of s.data.branchStartIds) {
        if (!stateIds.has(bid)) {
          errors.push({
            code: "E_SCATTER_DANGLING",
            message: `Scatter state '${s.id}' references non-existent branch start '${bid}'`,
            stateId: s.id,
          });
        }
      }
      if (!s.data.collection) {
        errors.push({
          code: "E_SCATTER_NO_COLLECTION",
          message: `Scatter state '${s.id}' has no collection expression`,
          stateId: s.id,
        });
      }
    }
    if (s.data.kind === "join") {
      if (s.data.branchCount < 1) {
        errors.push({
          code: "E_JOIN_EMPTY",
          message: `Join state '${s.id}' has branchCount < 1`,
          stateId: s.id,
        });
      }
    }
    if (s.data.kind === "invoke") {
      if (!s.data.protocolName) {
        errors.push({
          code: "E_INVOKE_NO_PROTOCOL",
          message: `Invoke state '${s.id}' has no protocol name`,
          stateId: s.id,
        });
      }
    }
  }

  return {
    ok: errors.filter(e => e.code.startsWith("E_")).length === 0,
    errors,
    stats: {
      stateCount: graph.states.length,
      transitionCount: graph.transitions.length,
      reachableCount: reachable.size,
      terminalCount: terminalReachable.length,
    },
  };
}
