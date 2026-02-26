/**
 * Reagent project — reagent.json loader, glob resolution, import path resolution.
 *
 * A Reagent project is the unit of organization (analogous to npm package / Rust crate).
 * The manifest (reagent.json) declares protocols, agents, dependencies, and metadata.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, relative, basename, extname } from "node:path";

// ── Manifest types ──────────────────────────────────────────────────

export interface ReagentManifest {
  name: string;
  version: string;
  protocols: string[];
  agents?: string[];
  outDir?: string;
  dependencies?: Record<string, string>;
  main?: string;
}

// ── Project root discovery ───────────────────────────────────────────

/**
 * Walk up from `startDir` looking for a directory containing `reagent.json`.
 * Returns the absolute path of the project root, or null if not found.
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, "reagent.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── Load / validate ─────────────────────────────────────────────────

export function loadManifest(projectDir: string): ReagentManifest {
  const manifestPath = join(projectDir, "reagent.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No reagent.json found in ${projectDir}`);
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(raw, manifestPath);
  return raw as ReagentManifest;
}

function validateManifest(raw: unknown, path: string): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path}: expected JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name) {
    throw new Error(`${path}: "name" is required (string)`);
  }
  if (typeof obj.version !== "string" || !obj.version) {
    throw new Error(`${path}: "version" is required (string)`);
  }
  if (!Array.isArray(obj.protocols) || obj.protocols.length === 0) {
    throw new Error(`${path}: "protocols" is required (non-empty string[])`);
  }
  for (const p of obj.protocols) {
    if (typeof p !== "string") {
      throw new Error(`${path}: "protocols" entries must be strings`);
    }
  }
}

// ── Glob resolution ─────────────────────────────────────────────────

/**
 * Resolve an array of simple glob patterns relative to `baseDir`.
 * Supports `*` (any filename chars) and `**\/` (recursive directory).
 * Returns sorted, deduplicated absolute paths.
 */
export function resolveGlobs(baseDir: string, patterns: string[]): string[] {
  const results = new Set<string>();
  for (const pattern of patterns) {
    for (const f of matchGlob(baseDir, pattern)) {
      results.add(f);
    }
  }
  return [...results].sort();
}

function matchGlob(baseDir: string, pattern: string): string[] {
  const parts = pattern.split("/");
  return walkGlob(baseDir, parts, 0);
}

function walkGlob(dir: string, parts: string[], idx: number): string[] {
  if (idx >= parts.length) return [];

  const part = parts[idx];
  const isLast = idx === parts.length - 1;

  if (part === "**") {
    const results: string[] = [];
    results.push(...walkGlob(dir, parts, idx + 1));
    for (const entry of safeReaddir(dir)) {
      const full = join(dir, entry);
      if (safeStat(full)?.isDirectory()) {
        results.push(...walkGlob(full, parts, idx));
      }
    }
    return results;
  }

  const regex = globPartToRegex(part);
  const results: string[] = [];

  for (const entry of safeReaddir(dir)) {
    if (!regex.test(entry)) continue;
    const full = join(dir, entry);
    const st = safeStat(full);
    if (!st) continue;

    if (isLast) {
      if (st.isFile()) results.push(full);
    } else {
      if (st.isDirectory()) results.push(...walkGlob(full, parts, idx + 1));
    }
  }

  return results;
}

function globPartToRegex(part: string): RegExp {
  const escaped = part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

// ── Import resolution ───────────────────────────────────────────────

export interface ResolvedImport {
  kind: "relative" | "package" | "bare";
  resolvedPath: string;
}

/**
 * Resolve an import specifier from a `.rg` file.
 *
 * Three tiers:
 * 1. Relative (`./auth.rg`, `../common/types.rg`) — resolved relative to importing file.
 * 2. Package (`@company/auth-protocol/greet.rg`) — look in `reagent_packages/<pkg>/`.
 * 3. Bare (`auth-protocol`) — resolve to package main entry point.
 */
export function resolveImport(
  specifier: string,
  importingFile: string,
  projectDir: string,
  dependencies?: Record<string, string>,
): ResolvedImport {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return {
      kind: "relative",
      resolvedPath: resolve(dirname(importingFile), specifier),
    };
  }

  const pkgDir = join(projectDir, "reagent_packages");

  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2) {
      throw new Error(`Invalid scoped package import: ${specifier}`);
    }
    const pkgName = `${parts[0]}/${parts[1]}`;
    const remainder = parts.slice(2).join("/");
    const pkgRoot = join(pkgDir, pkgName);

    if (!existsSync(pkgRoot)) {
      throw new Error(`Package "${pkgName}" not found in reagent_packages/. Run "reagent install" or create a symlink.`);
    }

    if (remainder) {
      return {
        kind: "package",
        resolvedPath: join(pkgRoot, remainder),
      };
    }
    return {
      kind: "bare",
      resolvedPath: resolvePackageMain(pkgRoot, pkgName),
    };
  }

  const slashIdx = specifier.indexOf("/");
  if (slashIdx > 0) {
    const pkgName = specifier.substring(0, slashIdx);
    const remainder = specifier.substring(slashIdx + 1);
    const pkgRoot = join(pkgDir, pkgName);
    if (!existsSync(pkgRoot)) {
      throw new Error(`Package "${pkgName}" not found in reagent_packages/.`);
    }
    return {
      kind: "package",
      resolvedPath: join(pkgRoot, remainder),
    };
  }

  const pkgRoot = join(pkgDir, specifier);
  if (!existsSync(pkgRoot)) {
    throw new Error(`Package "${specifier}" not found in reagent_packages/.`);
  }
  return {
    kind: "bare",
    resolvedPath: resolvePackageMain(pkgRoot, specifier),
  };
}

function resolvePackageMain(pkgRoot: string, pkgName: string): string {
  const pkgManifestPath = join(pkgRoot, "reagent.json");
  if (existsSync(pkgManifestPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgManifestPath, "utf8"));
      if (typeof pkg.main === "string") {
        return join(pkgRoot, pkg.main);
      }
    } catch { /* fall through to default */ }
  }
  return join(pkgRoot, "protocols", "index.rg");
}

// ── Scaffold (reagent init) ─────────────────────────────────────────

export function scaffoldProject(projectDir: string, name?: string): void {
  const projectName = name ?? basename(projectDir);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, "protocols"), { recursive: true });
  mkdirSync(join(projectDir, "agents"), { recursive: true });

  const manifest: ReagentManifest = {
    name: projectName,
    version: "0.1.0",
    protocols: ["protocols/*.rg"],
  };
  writeFileSync(
    join(projectDir, "reagent.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  const gitignore = "out/\nreagent_packages/\n";
  const gitignorePath = join(projectDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, gitignore);
  }

  console.log(`Initialized Reagent project "${projectName}" in ${projectDir}`);
  console.log("  reagent.json");
  console.log("  protocols/");
  console.log("  agents/");
  console.log("  .gitignore");
}
