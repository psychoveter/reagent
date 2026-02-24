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
export declare function validateIRGraph(graph: IRGraph): ValidationResult;
