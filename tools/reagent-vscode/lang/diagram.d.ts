/**
 * diagram.ts — IR to diagram data model.
 *
 * Converts compiled IRGraphs (per-role state machines) into a unified
 * diagram model suitable for sequence diagram and state machine rendering.
 * Shared between VSCode extension and CLI.
 */
import type { IRGraph, IRStateKind } from "./ir.js";
export type Participant = {
    name: string;
    lang?: string;
    isInitiator: boolean;
    binding?: "static" | "dynamic";
    cardinality?: "single" | "many";
};
export type SeqElementKind = "message" | "action" | "timer" | "loop_start" | "loop_end" | "alt_start" | "alt_branch" | "alt_end" | "scatter_start" | "scatter_end" | "invoke" | "async_invoke" | "spawn" | "par_start" | "par_end" | "trigger";
export type SeqElement = {
    kind: SeqElementKind;
    /** Source role this element belongs to */
    role: string;
    /** State ID in IR (for sourceMap linking) */
    stateId?: string;
    /** Sending participant (messages) */
    from?: string;
    /** Receiving participant (messages) */
    to?: string;
    /** Message name, action body summary, or control label */
    label: string;
    /** For alt branches: the condition expression */
    condition?: string;
    /** For scatter: the collection expression */
    collection?: string;
    /** For scatter: the item role */
    itemRole?: string;
    /** For invoke/spawn: the protocol name */
    protocolName?: string;
    /** For timer: duration */
    duration?: {
        value: number;
        unit: string;
    };
    /** Whether zone is async */
    async?: boolean;
};
export type SequenceDiagram = {
    protocolName: string;
    version?: string;
    participants: Participant[];
    elements: SeqElement[];
};
export type SmNodeShape = "circle" | "rect" | "diamond" | "hexagon" | "double-rect" | "pill";
export type SmNode = {
    id: string;
    kind: IRStateKind;
    label: string;
    shape: SmNodeShape;
    stateId: string;
};
export type SmEdge = {
    from: string;
    to: string;
    label?: string;
};
export type StateMachineDiagram = {
    protocolName: string;
    role: string;
    nodes: SmNode[];
    edges: SmEdge[];
};
/**
 * Build a sequence diagram from multiple per-role IRGraphs of the same protocol.
 * Walks the initiator's graph as the primary timeline, cross-referencing
 * other roles for receive-side information.
 */
export declare function buildSequenceDiagram(graphs: Map<string, IRGraph>, protocolName: string): SequenceDiagram;
/**
 * Build a state machine diagram for a single role's IRGraph.
 */
export declare function buildStateMachineDiagram(graph: IRGraph): StateMachineDiagram;
