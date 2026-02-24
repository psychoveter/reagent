/**
 * Reagent versioning — M8a
 *
 * Manages reagent.lock I/O and auto-semver version bumping.
 * The lock file is committed to VCS for deterministic versioning across CI/developers.
 */
import type { ProtocolFingerprint, RoleFingerprint } from "./ir.js";
export type ReagentLockEntry = {
    version: string;
    fingerprints: ProtocolFingerprint;
};
export type ReagentLockRoleEntry = {
    version: string;
    fingerprints: RoleFingerprint;
};
export type ReagentLock = {
    protocols: Record<string, ReagentLockEntry>;
    roles: Record<string, ReagentLockRoleEntry>;
};
export declare function readLock(lockPath: string): ReagentLock | null;
export declare function writeLock(lockPath: string, lock: ReagentLock): void;
export type ChangeLevel = "major" | "minor" | "patch" | "none";
export declare function bumpVersion(prev: string, change: ChangeLevel): string;
/**
 * Determines the change level between two protocol fingerprints.
 * - structure change → MAJOR (ABI break)
 * - schema change → MINOR (message shape changed)
 * - impl change → PATCH (zone bodies changed)
 * - no change → NONE
 */
export declare function classifyProtocolChange(prev: ProtocolFingerprint, next: ProtocolFingerprint): ChangeLevel;
export declare function classifyRoleChange(prev: RoleFingerprint, next: RoleFingerprint): ChangeLevel;
export declare function computeProtocolVersion(name: string, newFP: ProtocolFingerprint, lock: ReagentLock | null): {
    version: string;
    change: ChangeLevel;
};
export declare function computeRoleVersion(name: string, newFP: RoleFingerprint, lock: ReagentLock | null): {
    version: string;
    change: ChangeLevel;
};
