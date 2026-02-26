/**
 * Reagent project — reagent.json loader, glob resolution, import path resolution.
 *
 * A Reagent project is the unit of organization (analogous to npm package / Rust crate).
 * The manifest (reagent.json) declares protocols, agents, dependencies, and metadata.
 */
export interface ReagentManifest {
    name: string;
    version: string;
    protocols: string[];
    agents?: string[];
    outDir?: string;
    dependencies?: Record<string, string>;
    main?: string;
}
/**
 * Walk up from `startDir` looking for a directory containing `reagent.json`.
 * Returns the absolute path of the project root, or null if not found.
 */
export declare function findProjectRoot(startDir: string): string | null;
export declare function loadManifest(projectDir: string): ReagentManifest;
/**
 * Resolve an array of simple glob patterns relative to `baseDir`.
 * Supports `*` (any filename chars) and `**\/` (recursive directory).
 * Returns sorted, deduplicated absolute paths.
 */
export declare function resolveGlobs(baseDir: string, patterns: string[]): string[];
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
export declare function resolveImport(specifier: string, importingFile: string, projectDir: string, dependencies?: Record<string, string>): ResolvedImport;
export declare function scaffoldProject(projectDir: string, name?: string): void;
