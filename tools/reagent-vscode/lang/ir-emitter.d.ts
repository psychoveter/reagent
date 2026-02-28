/**
 * Reagent IR Emitter — v0.0.14
 *
 * Transforms AST nodes into IR:
 * - ProtocolDef → set of IRGraphs (one per role)
 * - RoleDef → RoleIR (rich behavioral contract with lifecycle)
 * - AgentDef → AgentIR (deployment binding referencing a role, with metadata)
 */
import type { AgentDef, MessageDef, ProtocolDef, RoleDef } from "./ast.js";
import type { AgentIR, AgentRegistrationIR, IRGraph, IRMessageSchema, RoleIR } from "./ir.js";
export type SourceMapEntry = {
    stateId: string;
    protocolName: string;
    role: string;
    file: string;
    line: number;
    column: number;
};
export type EmitResult = {
    ok: boolean;
    graphs: Map<string, IRGraph>;
    errors: string[];
    sourceMap: SourceMapEntry[];
};
export declare function emitIR(protocol: ProtocolDef): EmitResult;
export type RoleEmitResult = {
    ok: boolean;
    roleIR: RoleIR;
    errors: string[];
};
/**
 * Flatten a role's `extends` chain and produce a resolved RoleIR.
 * Plays are merged (parent first, deduped). Init bodies are chained (parent first).
 * Handlers from parent and child both fire.
 */
export declare function emitRoleIR(role: RoleDef, roleMap?: Map<string, RoleDef>): RoleEmitResult;
export type AgentEmitResult = {
    ok: boolean;
    agentIR: AgentIR;
    errors: string[];
};
/**
 * Produce a thin AgentIR that just references the role it runs.
 * Validates the role exists and lang tags are compatible.
 */
export declare function emitAgentIR(agent: AgentDef, roleMap: Map<string, RoleDef>): AgentEmitResult;
export declare function emitAgentRegistrationIR(agent: AgentDef): AgentRegistrationIR;
export declare function emitMessageSchema(msg: MessageDef): IRMessageSchema;
/**
 * Reset the global ID counter (useful for deterministic tests).
 */
export declare function resetIdCounter(): void;
