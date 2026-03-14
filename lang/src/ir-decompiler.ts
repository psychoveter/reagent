/**
 * IR Decompiler — reconstructs .rg source from compiled IR JSON.
 *
 * Two modes:
 * 1. Single-role view: walks one IRGraph via BFS, emits pseudo-.rg for that role's perspective.
 * 2. Multi-role merge: loads all role graphs for a protocol, correlates send/receive pairs.
 *
 * CLI entry point: cmdDecompile(path) — accepts a directory or single .ir.json file.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename, dirname, extname } from "node:path";
import type { IRGraph, IRState, IRTransition, IRStateKind, IRTransitionLabel, TriggerIR, ParticipantIR, ResolvePolicyIR, ResolvePipelineStepIR } from "./ir.js";

// ── Types ────────────────────────────────────────────────────────────

interface DecompileContext {
  graph: IRGraph;
  stateMap: Map<string, IRState>;
  transMap: Map<string, IRTransition[]>;
  visited: Set<string>;
  indent: number;
}

// ── CLI entry point ──────────────────────────────────────────────────

export function cmdDecompile(target: string): void {
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat) {
    console.error(`Not found: ${target}`);
    process.exit(1);
  }

  if (stat.isDirectory()) {
    decompileDirectory(target);
  } else if (target.endsWith(".ir.json")) {
    const graph = loadGraph(target);
    const output = decompileSingleRole(graph);
    process.stdout.write(output);
  } else {
    console.error(`Expected a directory or .ir.json file: ${target}`);
    process.exit(1);
  }
}

function decompileDirectory(dir: string): void {
  const files = readdirSync(dir).filter(f => f.endsWith(".ir.json")).sort();
  if (files.length === 0) {
    console.error(`No .ir.json files found in ${dir}`);
    process.exit(1);
  }

  const byProtocol = new Map<string, IRGraph[]>();
  for (const f of files) {
    const graph = loadGraph(join(dir, f));
    const list = byProtocol.get(graph.protocolName) ?? [];
    list.push(graph);
    byProtocol.set(graph.protocolName, list);
  }

  for (const [protoName, graphs] of byProtocol) {
    console.log(`\n// === ${protoName} ===\n`);
    if (graphs.length > 1) {
      console.log(decompileMultiRole(graphs));
    } else {
      console.log(decompileSingleRole(graphs[0]));
    }
  }
}

function loadGraph(path: string): IRGraph {
  return JSON.parse(readFileSync(path, "utf8")) as IRGraph;
}

// ── Single-role decompiler ──────────────────────────────────────────

export function decompileSingleRole(graph: IRGraph): string {
  const ctx = createContext(graph);
  const lines: string[] = [];

  lines.push(`// Single-role view: ${graph.role} in ${graph.protocolName}`);
  if (graph.version) lines.push(`// version: ${graph.version}`);
  lines.push("");

  const body = decompileFromState(ctx, graph.initialStateId, 0);
  lines.push(...body);

  return lines.join("\n") + "\n";
}

// ── Multi-role merge decompiler ─────────────────────────────────────

export function decompileMultiRole(graphs: IRGraph[]): string {
  if (graphs.length === 0) return "";

  const protoName = graphs[0].protocolName;
  const lines: string[] = [];

  const participantIRs = graphs[0].participants;
  const participantLines: string[] = [];
  if (participantIRs) {
    for (const p of participantIRs) {
      const langTag = p.lang && p.lang !== "*" ? ` [${p.lang}]` : "";
      const mods: string[] = [];
      if (p.binding !== "static") mods.push(p.binding);
      if (p.cardinality !== "single") mods.push(p.cardinality);
      if (p.initiator) mods.push("initiator");
      const modStr = mods.length > 0 ? " " + mods.join(" ") : "";
      participantLines.push(`    ${p.name}${langTag}${modStr}`);
    }
  } else {
    for (const g of graphs) {
      const langTag = g.lang && g.lang !== "*" ? ` [${g.lang}]` : "";
      participantLines.push(`    ${g.role}${langTag}`);
    }
  }

  lines.push(`protocol ${protoName} {`);
  lines.push(`  participants:`);
  lines.push(...participantLines.map(p => p + ","));

  const supervisionStrategy = graphs[0].supervisionStrategy;
  if (supervisionStrategy) {
    lines.push(`  supervision: ${supervisionStrategy}`);
  }

  const triggers = graphs[0].triggers;
  if (triggers && triggers.length > 0) {
    lines.push("");
    for (const t of triggers) {
      lines.push(...decompileTrigger(t).map(l => `  ${l}`));
    }
  }

  lines.push("");

  const initiator = participantIRs?.find(p => p.initiator)?.name ?? graphs[0].role;
  const sendReceivePairs = buildSendReceivePairs(graphs);
  const initiatorGraph = graphs.find(g => g.role === initiator) ?? graphs[0];
  const ctx = createContext(initiatorGraph);
  const body = decompileFromState(ctx, initiatorGraph.initialStateId, 1);
  lines.push(...body);

  lines.push("}");

  return lines.join("\n") + "\n";
}

// ── Core decompilation engine ───────────────────────────────────────

function createContext(graph: IRGraph): DecompileContext {
  const stateMap = new Map<string, IRState>();
  for (const s of graph.states) stateMap.set(s.id, s);

  const transMap = new Map<string, IRTransition[]>();
  for (const t of graph.transitions) {
    const list = transMap.get(t.from) ?? [];
    list.push(t);
    transMap.set(t.from, list);
  }

  return { graph, stateMap, transMap, visited: new Set(), indent: 0 };
}

function decompileFromState(ctx: DecompileContext, stateId: string, indent: number): string[] {
  const lines: string[] = [];
  let currentId: string | null = stateId;

  while (currentId) {
    if (ctx.visited.has(currentId)) break;

    const state = ctx.stateMap.get(currentId);
    if (!state) break;

    ctx.visited.add(currentId);
    const transitions = ctx.transMap.get(currentId) ?? [];
    const pad = "  ".repeat(indent);

    switch (state.data.kind) {
      case "initial":
        currentId = followDefault(transitions);
        break;

      case "send": {
        const d = state.data;
        lines.push(`${pad}${ctx.graph.role} --> ${d.to}: ${d.messageName}`);
        if (d.preSendZone) {
          lines.push(`${pad}  onSend { ${d.preSendZone.trim()} }`);
        }
        currentId = followDefault(transitions);
        break;
      }

      case "receive": {
        const d = state.data;
        lines.push(`${pad}${d.from} --> ${ctx.graph.role}: ${d.messageName}`);
        if (d.postReceiveZone) {
          lines.push(`${pad}  onReceive { ${d.postReceiveZone.trim()} }`);
        }
        currentId = followDefault(transitions);
        break;
      }

      case "action": {
        const d = state.data;
        const body = d.body.trim();
        lines.push(`${pad}${ctx.graph.role} {`);
        for (const line of body.split("\n")) {
          lines.push(`${pad}  ${line}`);
        }
        lines.push(`${pad}}`);
        currentId = followDefault(transitions);
        break;
      }

      case "guard": {
        const d = state.data;
        const nonDefault = transitions.filter(t => t.label.kind !== "default");
        const isPassthrough = nonDefault.length === 0 && transitions.length <= 1;
        if (isPassthrough) {
          currentId = followDefault(transitions);
        } else if (d.guardType === "expression" && hasBackEdge(ctx, currentId)) {
          const result = decompileLoop(ctx, state, transitions, indent);
          lines.push(...result.lines);
          currentId = result.nextId;
        } else if (d.guardType === "xor" || d.guardType === "expression" || d.guardType === "timeout") {
          const result = decompileAlt(ctx, state, transitions, indent);
          lines.push(...result.lines);
          currentId = result.nextId;
        } else {
          currentId = followDefault(transitions);
        }
        break;
      }

      case "fork": {
        const result = decompilePar(ctx, state, transitions, indent);
        lines.push(...result.lines);
        currentId = result.nextId;
        break;
      }

      case "join":
        currentId = followDefault(transitions);
        break;

      case "timer": {
        const d = state.data;
        lines.push(`${pad}wait ${d.duration.value}${d.duration.unit}`);
        currentId = followDefault(transitions);
        break;
      }

      case "invoke": {
        const d = state.data;
        const argsStr = d.input ? `(${d.input})` : "";
        const resultStr = d.resultTarget ? ` -> ${d.resultTarget}` : "";
        lines.push(`${pad}${ctx.graph.role} invokes ${d.protocolName}${argsStr}${resultStr}`);
        currentId = followDefault(transitions);
        break;
      }

      case "async_invoke": {
        const d = state.data;
        const argsStr = d.input ? `(${d.input})` : "";
        lines.push(`${pad}${ctx.graph.role} async invokes ${d.protocolName}${argsStr}`);
        currentId = followDefault(transitions);
        break;
      }

      case "spawn": {
        const d = state.data;
        const argsStr = d.config ? `(${d.config})` : "()";
        const bindStr = d.bindAs ? ` as ${d.bindAs}` : "";
        const persistStr = d.persistent ? " persistent" : "";
        const resultStr = d.resultTarget ? ` -> ${d.resultTarget}` : "";
        lines.push(`${pad}${ctx.graph.role} spawns ${d.roleName}${argsStr}${bindStr}${persistStr}${resultStr}`);
        currentId = followDefault(transitions);
        break;
      }

      case "scatter": {
        const d = state.data;
        const pad2 = "  ".repeat(indent + 1);
        lines.push(`${pad}scatter (${d.collection} as ${d.itemRole}) {`);
        for (const branchStartId of d.branchStartIds) {
          const branchLines = decompileFromState(ctx, branchStartId, indent + 1);
          lines.push(...branchLines);
        }
        lines.push(`${pad}}`);
        currentId = followDefault(transitions);
        break;
      }

      case "error": {
        const d = state.data;
        lines.push(`${pad}// error: ${d.label}`);
        currentId = followDefault(transitions);
        break;
      }

      case "terminal":
        currentId = null;
        break;

      default:
        currentId = followDefault(transitions);
        break;
    }
  }

  return lines;
}

// ── Pattern detectors ───────────────────────────────────────────────

function hasBackEdge(ctx: DecompileContext, guardId: string): boolean {
  const transitions = ctx.transMap.get(guardId) ?? [];
  for (const t of transitions) {
    if (ctx.visited.has(t.to)) return true;
    const targetTransitions = ctx.transMap.get(t.to) ?? [];
    for (const tt of targetTransitions) {
      if (tt.to === guardId) return true;
    }
  }
  return false;
}

function decompileLoop(
  ctx: DecompileContext, state: IRState, transitions: IRTransition[], indent: number,
): { lines: string[]; nextId: string | null } {
  const d = state.data as { kind: "guard"; expr?: string };
  const pad = "  ".repeat(indent);
  const lines: string[] = [];

  const exprBranch = transitions.find(t => t.label.kind === "expression");
  const elseBranch = transitions.find(t => t.label.kind === "else" || t.label.kind === "default");

  const expr = d.expr ?? (exprBranch?.label as { expr?: string })?.expr ?? "true";
  lines.push(`${pad}loop (${expr}) {`);

  if (exprBranch) {
    const bodyLines = decompileFromState(ctx, exprBranch.to, indent + 1);
    lines.push(...bodyLines);
  }

  lines.push(`${pad}}`);

  const nextId = elseBranch?.to ?? null;
  return { lines, nextId };
}

function decompileAlt(
  ctx: DecompileContext, state: IRState, transitions: IRTransition[], indent: number,
): { lines: string[]; nextId: string | null } {
  const d = state.data as { kind: "guard"; guardType: string; expr?: string };
  const pad = "  ".repeat(indent);
  const lines: string[] = [];

  const exprOrMsg = transitions.filter(t => t.label.kind !== "else" && t.label.kind !== "default");
  const elseBranch = transitions.find(t => t.label.kind === "else");
  const defaultBranch = transitions.find(t => t.label.kind === "default");

  const expr = d.expr ?? "";
  lines.push(`${pad}alt (${expr}) {`);

  for (const branch of exprOrMsg) {
    const branchCtx: DecompileContext = { ...ctx, visited: new Set(ctx.visited) };
    const branchLines = decompileFromState(branchCtx, branch.to, indent + 1);
    lines.push(...branchLines);
  }

  if (elseBranch) {
    lines.push(`${pad}} else {`);
    const elseCtx: DecompileContext = { ...ctx, visited: new Set(ctx.visited) };
    const elseLines = decompileFromState(elseCtx, elseBranch.to, indent + 1);
    lines.push(...elseLines);
  }

  lines.push(`${pad}}`);

  const mergeId = findMergePoint(ctx, transitions);
  return { lines, nextId: mergeId ?? (defaultBranch?.to ?? null) };
}

function decompilePar(
  ctx: DecompileContext, state: IRState, transitions: IRTransition[], indent: number,
): { lines: string[]; nextId: string | null } {
  const d = state.data as { kind: "fork"; branchStartIds: string[] };
  const pad = "  ".repeat(indent);
  const lines: string[] = [];

  const joinId = findJoinAfterFork(ctx, d.branchStartIds);

  lines.push(`${pad}par {`);
  for (let i = 0; i < d.branchStartIds.length; i++) {
    if (i > 0) lines.push(`${pad}} and {`);
    const branchCtx: DecompileContext = { ...ctx, visited: new Set() };
    if (joinId) branchCtx.visited.add(joinId);
    const branchLines = decompileFromState(branchCtx, d.branchStartIds[i], indent + 1);
    lines.push(...branchLines);
  }
  lines.push(`${pad}}`);

  if (joinId) ctx.visited.add(joinId);
  const nextId = joinId ? followDefaultFromId(ctx, joinId) : null;
  return { lines, nextId };
}

// ── Helpers ─────────────────────────────────────────────────────────

function followDefault(transitions: IRTransition[]): string | null {
  const def = transitions.find(t => t.label.kind === "default");
  return def?.to ?? transitions[0]?.to ?? null;
}

function followDefaultFromId(ctx: DecompileContext, stateId: string): string | null {
  const transitions = ctx.transMap.get(stateId) ?? [];
  return followDefault(transitions);
}

function findMergePoint(ctx: DecompileContext, transitions: IRTransition[]): string | null {
  const targets = new Set<string>();
  for (const t of transitions) {
    collectTerminals(ctx, t.to, targets, new Set());
  }
  if (targets.size === 1) return [...targets][0];
  return null;
}

function collectTerminals(
  ctx: DecompileContext, stateId: string, terminals: Set<string>, visited: Set<string>,
): void {
  if (visited.has(stateId)) return;
  visited.add(stateId);
  const state = ctx.stateMap.get(stateId);
  if (!state) return;
  if (state.data.kind === "terminal") { terminals.add(stateId); return; }
  const transitions = ctx.transMap.get(stateId) ?? [];
  if (transitions.length === 0) { terminals.add(stateId); return; }
  for (const t of transitions) {
    collectTerminals(ctx, t.to, terminals, visited);
  }
}

function findJoinAfterFork(ctx: DecompileContext, branchStartIds: string[]): string | null {
  for (const state of ctx.graph.states) {
    if (state.data.kind === "join") return state.id;
  }
  return null;
}

function decompileTrigger(t: TriggerIR): string[] {
  const lines: string[] = [];
  let header: string;
  switch (t.kind) {
    case "invoke": header = `trigger on invoke with ${t.withType}`; break;
    case "cron":   header = `trigger on cron "${t.cron}"`; break;
    case "event":  header = `trigger on event "${t.topic}" with ${t.withType}`; break;
  }

  const hasBody = t.inputExpr != null || (t.resolveMap != null && Object.keys(t.resolveMap).length > 0);
  if (!hasBody) {
    lines.push(header);
    return lines;
  }

  lines.push(`${header} {`);
  if (t.inputExpr != null) {
    lines.push(`    $ctx.input = ${t.inputExpr}`);
  }
  if (t.resolveMap) {
    for (const [role, pipeline] of Object.entries(t.resolveMap)) {
      lines.push(`    resolve ${role} = ${decompileResolvePipeline(pipeline)}`);
    }
  }
  lines.push(`  }`);
  return lines;
}

function decompileResolvePipeline(pipeline: ResolvePolicyIR): string {
  return pipeline.map(decompileResolveStep).join(" | ");
}

function decompileResolveStep(step: ResolvePipelineStepIR): string {
  switch (step.step) {
    case "all":         return "all";
    case "single":      return "single";
    case "from":        return `from(${step.expr})`;
    case "filter":      return `filter(${step.predicate})`;
    case "roundRobin":  return "roundRobin";
    case "leastLoaded": return "leastLoaded";
    case "random":      return "random";
    case "sample":      return `sample(${step.count})`;
    case "first":       return "first";
    case "fallback":    return `fallback(${decompileResolvePipeline(step.chain)})`;
    case "custom":      return `custom("${step.name}")`;
  }
}

function buildSendReceivePairs(graphs: IRGraph[]): Map<string, { sender: string; receiver: string }> {
  const pairs = new Map<string, { sender: string; receiver: string }>();
  for (const g of graphs) {
    for (const s of g.states) {
      if (s.data.kind === "send") {
        const d = s.data;
        pairs.set(d.messageName, { sender: g.role, receiver: d.to });
      }
    }
  }
  return pairs;
}
