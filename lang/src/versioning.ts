/**
 * Reagent versioning — M8a
 *
 * Manages reagent.lock I/O and auto-semver version bumping.
 * The lock file is committed to VCS for deterministic versioning across CI/developers.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ProtocolFingerprint, RoleFingerprint } from "./ir.js";

// ── Lock file types ─────────────────────────────────────────────────

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

// ── Lock file I/O ───────────────────────────────────────────────────

export function readLock(lockPath: string): ReagentLock | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    return JSON.parse(raw) as ReagentLock;
  } catch {
    return null;
  }
}

export function writeLock(lockPath: string, lock: ReagentLock): void {
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

// ── Semver arithmetic ───────────────────────────────────────────────

export type ChangeLevel = "major" | "minor" | "patch" | "none";

export function bumpVersion(prev: string, change: ChangeLevel): string {
  if (change === "none") return prev;
  const [major, minor, patch] = prev.split(".").map(Number);
  switch (change) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * Determines the change level between two protocol fingerprints.
 * - structure change → MAJOR (ABI break)
 * - schema change → MINOR (message shape changed)
 * - impl change → PATCH (zone bodies changed)
 * - no change → NONE
 */
export function classifyProtocolChange(
  prev: ProtocolFingerprint,
  next: ProtocolFingerprint,
): ChangeLevel {
  if (prev.structureHash !== next.structureHash) return "major";
  if (prev.schemaHash !== next.schemaHash) return "minor";
  if (prev.implHash !== next.implHash) return "patch";
  return "none";
}

export function classifyRoleChange(
  prev: RoleFingerprint,
  next: RoleFingerprint,
): ChangeLevel {
  if (prev.playsHash !== next.playsHash) return "major";
  if (prev.behaviorHash !== next.behaviorHash) return "patch";
  return "none";
}

// ── Version computation ─────────────────────────────────────────────

const INITIAL_VERSION = "0.1.0";

export function computeProtocolVersion(
  name: string,
  newFP: ProtocolFingerprint,
  lock: ReagentLock | null,
): { version: string; change: ChangeLevel } {
  const entry = lock?.protocols[name];
  if (!entry) return { version: INITIAL_VERSION, change: "minor" };

  const change = classifyProtocolChange(entry.fingerprints, newFP);
  return {
    version: bumpVersion(entry.version, change),
    change,
  };
}

export function computeRoleVersion(
  name: string,
  newFP: RoleFingerprint,
  lock: ReagentLock | null,
): { version: string; change: ChangeLevel } {
  const entry = lock?.roles[name];
  if (!entry) return { version: INITIAL_VERSION, change: "minor" };

  const change = classifyRoleChange(entry.fingerprints, newFP);
  return {
    version: bumpVersion(entry.version, change),
    change,
  };
}
