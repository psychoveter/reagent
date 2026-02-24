/**
 * Reagent versioning — M8a
 *
 * Manages reagent.lock I/O and auto-semver version bumping.
 * The lock file is committed to VCS for deterministic versioning across CI/developers.
 */
import { readFileSync, writeFileSync } from "node:fs";
// ── Lock file I/O ───────────────────────────────────────────────────
export function readLock(lockPath) {
    try {
        const raw = readFileSync(lockPath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function writeLock(lockPath, lock) {
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
}
export function bumpVersion(prev, change) {
    if (change === "none")
        return prev;
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
export function classifyProtocolChange(prev, next) {
    if (prev.structureHash !== next.structureHash)
        return "major";
    if (prev.schemaHash !== next.schemaHash)
        return "minor";
    if (prev.implHash !== next.implHash)
        return "patch";
    return "none";
}
export function classifyRoleChange(prev, next) {
    if (prev.playsHash !== next.playsHash)
        return "major";
    if (prev.behaviorHash !== next.behaviorHash)
        return "patch";
    return "none";
}
// ── Version computation ─────────────────────────────────────────────
const INITIAL_VERSION = "0.1.0";
export function computeProtocolVersion(name, newFP, lock) {
    const entry = lock?.protocols[name];
    if (!entry)
        return { version: INITIAL_VERSION, change: "minor" };
    const change = classifyProtocolChange(entry.fingerprints, newFP);
    return {
        version: bumpVersion(entry.version, change),
        change,
    };
}
export function computeRoleVersion(name, newFP, lock) {
    const entry = lock?.roles[name];
    if (!entry)
        return { version: INITIAL_VERSION, change: "minor" };
    const change = classifyRoleChange(entry.fingerprints, newFP);
    return {
        version: bumpVersion(entry.version, change),
        change,
    };
}
