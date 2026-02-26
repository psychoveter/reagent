/**
 * Reagent IR Fingerprinting — M8a
 *
 * Computes deterministic SHA-256 fingerprints for protocols and roles.
 * All functions are pure (no I/O, no side effects).
 */
import type { IRGraph, IRMessageSchema, RoleIR, ProtocolFingerprint, RoleFingerprint, ProtocolDependency } from "./ir.js";
/**
 * Computes the structure hash — captures choreography topology.
 * Roles sorted alphabetically, state IDs replaced with BFS indices.
 */
export declare function computeStructureHash(graphs: Map<string, IRGraph>): string;
/**
 * Computes the schema hash — captures message type definitions.
 * Only schemas whose names appear in send/receive states are included.
 */
export declare function computeSchemaHash(schemas: IRMessageSchema[], usedNames: Set<string>): string;
/**
 * Computes the implementation hash — captures zone bodies and guard expressions.
 * Whitespace-normalized, ordered by BFS traversal, roles sorted alphabetically.
 */
export declare function computeImplHash(graphs: Map<string, IRGraph>): string;
/**
 * Extracts all message names used in send/receive states across all role graphs.
 */
export declare function extractUsedMessageNames(graphs: Map<string, IRGraph>): Set<string>;
/**
 * Extracts protocol dependencies from invoke/spawn states.
 * Version and structureHash are left empty — filled by the caller from the lock file.
 */
export declare function extractDependencies(graphs: Map<string, IRGraph>): ProtocolDependency[];
/**
 * Computes the full protocol fingerprint (three hashes).
 */
export declare function computeProtocolFingerprint(graphs: Map<string, IRGraph>, schemas: IRMessageSchema[], usedMessageNames: Set<string>): ProtocolFingerprint;
/**
 * Computes the role fingerprint (two hashes).
 * `protocolVersions` maps protocol names to their resolved versions —
 * ensures role version bumps when a referenced protocol changes.
 */
export declare function computeRoleFingerprint(roleIR: RoleIR, protocolVersions?: Map<string, string>): RoleFingerprint;
