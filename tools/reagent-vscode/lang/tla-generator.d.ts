/**
 * TLA+ specification generator from Reagent IR.
 *
 * Reads compiled per-role IRGraphs and produces a TLA+ module
 * that models the protocol as concurrent PlusCal processes
 * communicating via message channels.
 *
 * Properties checked:
 * - Deadlock freedom (no stuck states)
 * - Protocol completion (all roles reach terminal)
 */
import type { IRGraph } from "./ir.js";
export declare function generateTLAPlus(protocolName: string, graphs: Map<string, IRGraph>): string;
/**
 * Generate a TLC config file for the TLA+ module.
 */
export declare function generateTLCConfig(protocolName: string, roles: string[]): string;
