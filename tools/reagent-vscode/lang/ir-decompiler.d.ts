/**
 * IR Decompiler — reconstructs .rg source from compiled IR JSON.
 *
 * Two modes:
 * 1. Single-role view: walks one IRGraph via BFS, emits pseudo-.rg for that role's perspective.
 * 2. Multi-role merge: loads all role graphs for a protocol, correlates send/receive pairs.
 *
 * CLI entry point: cmdDecompile(path) — accepts a directory or single .ir.json file.
 */
import type { IRGraph } from "./ir.js";
export declare function cmdDecompile(target: string): void;
export declare function decompileSingleRole(graph: IRGraph): string;
export declare function decompileMultiRole(graphs: IRGraph[]): string;
