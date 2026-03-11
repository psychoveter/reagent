/**
 * M13 Phase 2: ProtocolEngine unit tests.
 *
 * PE.1: Linear state navigation (followDefault, setCurrentState)
 * PE.2: Alt branching (guard evaluation, expression vars check)
 * PE.3: Loop — findLoopExit
 * PE.4: $ctx propagation (assignTarget, evalExpr)
 * PE.5: Scatter — state map, branch start IDs
 * PE.6: Invoke — state detection
 * PE.7: Engine status transitions
 *
 * Run: npx tsx runtime/tests/m13-engine.test.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ProtocolEngine, durationToMs } from "../ts/src/core/protocol-engine.js";
import type { IRGraph } from "../ts/src/contracts/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "..", "examples", "out");

type TestResult = { name: string; passed: boolean; error?: string };

function loadGraph(example: string, role: string): IRGraph {
  const { readdirSync } = require("node:fs");
  const dir = join(OUT_DIR, example);
  const files: string[] = readdirSync(dir);
  const irFile = files.find((f: string) => f.endsWith(`.${role}.ir.json`));
  if (!irFile) throw new Error(`No IR file for role '${role}' in ${example}. Available: ${files.filter((f: string) => f.endsWith(".ir.json")).join(", ")}`);
  return JSON.parse(readFileSync(join(dir, irFile), "utf8"));
}

function makeEngine(graph: IRGraph, overrides?: Partial<{ agentName: string; roleName: string }>): ProtocolEngine {
  return new ProtocolEngine(graph, {
    instanceId: "test-" + Math.random().toString(36).slice(2, 8),
    protocolName: graph.protocolName,
    agentName: overrides?.agentName ?? "test-agent",
    roleName: overrides?.roleName ?? graph.role,
    selfRef: {},
  });
}

// ── PE.1: Linear state navigation ───────────────────────────────────

async function testPE1(): Promise<TestResult> {
  const name = "PE.1: Linear state navigation";
  try {
    const graph = loadGraph("14-ts-only-demo", "client");
    const engine = makeEngine(graph);

    if (engine.status !== "idle") {
      return { name, passed: false, error: `Expected idle, got ${engine.status}` };
    }

    if (engine.getCurrentStateId() !== graph.initialStateId) {
      return { name, passed: false, error: "Engine should start at initialStateId" };
    }

    const stateMap = engine.getStateMap();
    if (stateMap.size === 0) {
      return { name, passed: false, error: "stateMap is empty" };
    }
    if (stateMap.size !== graph.states.length) {
      return { name, passed: false, error: `stateMap size ${stateMap.size} != graph.states.length ${graph.states.length}` };
    }

    const nextState = engine.followDefault();
    engine.setCurrentState(nextState);

    if (engine.getCurrentStateId() !== nextState) {
      return { name, passed: false, error: "setCurrentState did not update" };
    }

    let steps = 0;
    const visited = new Set<string>();
    visited.add(engine.getCurrentStateId());
    while (steps < 50) {
      try {
        const next = engine.followDefault();
        if (visited.has(next)) break;
        engine.setCurrentState(next);
        visited.add(next);
        steps++;
      } catch {
        break;
      }
    }

    if (visited.size < 3) {
      return { name, passed: false, error: `Only ${visited.size} states visited — expected at least 3 for a protocol` };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── PE.2: Alt branching — guard evaluation ──────────────────────────

async function testPE2(): Promise<TestResult> {
  const name = "PE.2: Alt branching — guard evaluation";
  try {
    const graph = loadGraph("02-await-timeout-and-alt", "comma");
    const engine = makeEngine(graph);

    const guardStates = [...engine.getStateMap().values()].filter(
      s => s.data.kind === "guard",
    );

    if (guardStates.length === 0) {
      return { name, passed: false, error: "No guard states found in alt protocol" };
    }

    engine.ctx = { approved: true };
    const result1 = engine.evalExpr("$ctx.approved === true");
    if (result1 !== true) {
      return { name, passed: false, error: `evalExpr($ctx.approved === true) returned ${result1}` };
    }

    engine.ctx = { approved: false };
    const result2 = engine.evalExpr("$ctx.approved === true");
    if (result2 !== false) {
      return { name, passed: false, error: `evalExpr returned ${result2} when $ctx.approved is false` };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── PE.3: Loop — findLoopExit ───────────────────────────────────────

async function testPE3(): Promise<TestResult> {
  const name = "PE.3: Loop — findLoopExit";
  try {
    const graph = loadGraph("03-loop-retry-backoff", "comma");
    const engine = makeEngine(graph);

    const guardStates = [...engine.getStateMap().values()].filter(
      s => s.data.kind === "guard" && (s.data as any).guardType === "expression",
    );

    if (guardStates.length === 0) {
      return { name, passed: false, error: "No expression guard states (loop guard) found" };
    }

    const guard = guardStates[0];
    const trans = engine.getTransitionsFrom().get(guard.id) ?? [];
    const bodyTrans = trans.find(t => t.label.kind === "default" || t.label.kind === "then");
    if (!bodyTrans) {
      return { name, passed: false, error: `No body transition from guard. Labels: ${trans.map(t => t.label.kind).join(", ")}` };
    }

    const loopExit = engine.findLoopExit(bodyTrans.to);
    if (!loopExit) {
      return { name, passed: false, error: "findLoopExit returned null — could not find loop exit state" };
    }

    if (!engine.getStateMap().has(loopExit)) {
      return { name, passed: false, error: `findLoopExit returned ${loopExit} which is not in stateMap` };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── PE.4: $ctx propagation ──────────────────────────────────────────

async function testPE4(): Promise<TestResult> {
  const name = "PE.4: $ctx propagation — assignTarget + evalExpr";
  try {
    const graph = loadGraph("14-ts-only-demo", "client");
    const engine = makeEngine(graph);

    engine.assignTarget("$ctx.foo", "bar");
    if (engine.ctx.foo !== "bar") {
      return { name, passed: false, error: "assignTarget $ctx.foo did not set" };
    }

    engine.assignTarget("$ctx.count", 42);
    if (engine.ctx.count !== 42) {
      return { name, passed: false, error: "assignTarget $ctx.count did not set" };
    }

    const result = engine.evalExpr("$ctx.count + 8");
    if (result !== 50) {
      return { name, passed: false, error: `evalExpr($ctx.count + 8) = ${result}, expected 50` };
    }

    if (!engine.expressionVarsAreDefined("$ctx.foo")) {
      return { name, passed: false, error: "expressionVarsAreDefined should return true for defined var" };
    }
    if (engine.expressionVarsAreDefined("$ctx.undefinedVar")) {
      return { name, passed: false, error: "expressionVarsAreDefined should return false for undefined var" };
    }

    engine.ctx = { fresh: true };
    if (engine.ctx.foo !== undefined) {
      return { name, passed: false, error: "ctx setter should replace entire ctx object" };
    }
    if (engine.ctx.fresh !== true) {
      return { name, passed: false, error: "ctx setter did not set new value" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── PE.5: Scatter states ────────────────────────────────────────────

async function testPE5(): Promise<TestResult> {
  const name = "PE.5: Scatter — state map has scatter/join";
  try {
    const graph = loadGraph("23-scatter-gather", "coordinator");
    const engine = makeEngine(graph);

    const scatterStates = [...engine.getStateMap().values()].filter(
      s => s.data.kind === "scatter",
    );
    if (scatterStates.length === 0) {
      return { name, passed: false, error: "No scatter states found" };
    }

    const scatter = scatterStates[0];
    const data = scatter.data as any;
    if (!data.collection) {
      return { name, passed: false, error: "scatter state has no collection expression" };
    }
    if (!data.branchStartIds || data.branchStartIds.length === 0) {
      return { name, passed: false, error: "scatter state has no branchStartIds" };
    }

    for (const branchId of data.branchStartIds) {
      if (!engine.getStateMap().has(branchId)) {
        return { name, passed: false, error: `scatter branchStartId ${branchId} not in stateMap` };
      }
    }

    const joinStates = [...engine.getStateMap().values()].filter(
      s => s.data.kind === "join",
    );
    if (joinStates.length === 0) {
      return { name, passed: false, error: "No join states found (scatter should have a join)" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── PE.6: Invoke state detection ────────────────────────────────────

async function testPE6(): Promise<TestResult> {
  const name = "PE.6: Invoke state detection";
  try {
    const graph = loadGraph("18-invoke-demo", "responder");
    const engine = makeEngine(graph);

    const invokeStates = [...engine.getStateMap().values()].filter(
      s => s.data.kind === "invoke",
    );
    if (invokeStates.length === 0) {
      return { name, passed: false, error: "No invoke states found" };
    }

    const inv = invokeStates[0];
    const data = inv.data as any;
    if (!data.protocolName) {
      return { name, passed: false, error: "invoke state has no protocolName" };
    }

    const transitions = engine.getTransitionsFrom().get(inv.id) ?? [];
    if (transitions.length === 0) {
      return { name, passed: false, error: "invoke state has no outgoing transitions" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── PE.7: Engine status transitions ─────────────────────────────────

async function testPE7(): Promise<TestResult> {
  const name = "PE.7: Engine status transitions";
  try {
    const graph = loadGraph("14-ts-only-demo", "client");
    const engine = makeEngine(graph);

    if (engine.status !== "idle") {
      return { name, passed: false, error: `Initial status should be idle, got ${engine.status}` };
    }

    engine.setStatus("running");
    if (engine.status !== "running") {
      return { name, passed: false, error: "setStatus to running failed" };
    }

    engine.setStatus("completed");
    if (engine.status !== "completed") {
      return { name, passed: false, error: "setStatus to completed failed" };
    }

    const engine2 = makeEngine(graph);
    engine2.setReturnValue({ result: "ok" });
    if (engine2.status !== "completed") {
      return { name, passed: false, error: "setReturnValue should set status to completed" };
    }
    const rv = engine2.getReturnValue();
    if (!rv.has || (rv.value as any)?.result !== "ok") {
      return { name, passed: false, error: `getReturnValue returned ${JSON.stringify(rv)}` };
    }

    const engine3 = makeEngine(graph);
    engine3.setStatus("failed");
    if (engine3.status !== "failed") {
      return { name, passed: false, error: "setStatus to failed did not work" };
    }

    // durationToMs utility
    if (durationToMs({ value: 1, unit: "s" }) !== 1000) {
      return { name, passed: false, error: "durationToMs 1s != 1000" };
    }
    if (durationToMs({ value: 500, unit: "ms" }) !== 500) {
      return { name, passed: false, error: "durationToMs 500ms != 500" };
    }
    if (durationToMs({ value: 2, unit: "m" }) !== 120_000) {
      return { name, passed: false, error: "durationToMs 2m != 120000" };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = await Promise.all([
    testPE1(), testPE2(), testPE3(), testPE4(),
    testPE5(), testPE6(), testPE7(),
  ]);
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
    if (!r.passed) allPassed = false;
  }
  if (!allPassed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
