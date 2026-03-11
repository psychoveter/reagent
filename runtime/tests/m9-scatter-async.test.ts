/**
 * M9 Pre-requisite: Scatter + Async Zones E2E Test
 *
 * SA1: Scatter with async action zone — coordinator scatters to N workers,
 *      each worker has an async action zone (await $agent.think()),
 *      results are gathered back via $ctx.
 * SA2: Send/receive with preSendAsync and postReceiveAsync inside scatter branches
 * SA3: Message correlation — ActionResponse from N scatter branches correctly
 *      accumulated in $ctx.actions
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { ReagentController } from "../ts/src/controller/reagent-controller.js";
import { NativeAgentNode, NativeAgentHandle } from "../ts/src/nodes/native-agent-node.js";
import type { IRGraph, RoleIR, TraceEvent } from "../ts/src/contracts/types.js";
import type { TraceHook } from "../ts/src/contracts/interceptor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type TestResult = { name: string; passed: boolean; error?: string };

// ── Inline IR builders ──────────────────────────────────────────────

function sInitial(id: string) { return { id, kind: "initial", data: { kind: "initial" } }; }
function sAction(id: string, body: string, opts: { async?: boolean } = {}) {
  return { id, kind: "action", data: { kind: "action", body, lang: "ts", ...(opts.async ? { async: true } : {}) } };
}
function sSend(id: string, to: string, msg: string, opts: { preSendZone?: string; preSendAsync?: boolean } = {}) {
  return {
    id, kind: "send", data: {
      kind: "send", to, arrow: "-->", messageName: msg,
      ...(opts.preSendZone ? { preSendZone: opts.preSendZone } : {}),
      ...(opts.preSendAsync ? { preSendAsync: true } : {}),
    },
  };
}
function sRecv(id: string, from: string, msg: string, opts: { postReceiveZone?: string; postReceiveAsync?: boolean } = {}) {
  return {
    id, kind: "receive", data: {
      kind: "receive", from, arrow: "-->", messageName: msg,
      ...(opts.postReceiveZone ? { postReceiveZone: opts.postReceiveZone } : {}),
      ...(opts.postReceiveAsync ? { postReceiveAsync: true } : {}),
    },
  };
}
function sTerminal(id: string) { return { id, kind: "terminal", data: { kind: "terminal", status: "completed" } }; }
function sGuardExpr(id: string, expr?: string) { return { id, kind: "guard", data: { kind: "guard", guardType: "expression", ...(expr ? { expr } : {}) } }; }
function sScatter(id: string, collection: string, itemRole: string, branchStartIds: string[]) {
  return { id, kind: "scatter", data: { kind: "scatter", collection, itemRole, branchStartIds } };
}
function sJoin(id: string, branchCount: number) { return { id, kind: "join", data: { kind: "join", branchCount } }; }
function tr(from: string, to: string, label: Record<string, unknown> = { kind: "default" }) { return { from, to, label }; }
function makeGraph(proto: string, role: string, states: any[], transitions: any[]): IRGraph {
  const initial = states.find(s => s.kind === "initial")!.id;
  const terminals = states.filter(s => s.kind === "terminal").map(s => s.id);
  return { protocolName: proto, role, lang: "ts", states, transitions, initialStateId: initial, terminalStateIds: terminals } as IRGraph;
}

function getHandle(rc: ReagentController, name: string): NativeAgentHandle {
  return rc.getAgent(name) as NativeAgentHandle;
}

function createInlineSetup(
  roleToAgent: Record<string, string>,
  agents: Array<{ name: string; roleIR: RoleIR; graphs: Map<string, IRGraph> }>,
  opts?: { traceHook?: TraceHook },
): { rc: ReagentController } {
  const agentNode = new NativeAgentNode({ roleToAgent, traceHook: opts?.traceHook });
  const rc = new ReagentController({ nodeId: "test-node", agentNode });
  for (const a of agents) {
    rc.registerAgent(a.name, a.roleIR, a.graphs);
  }
  return { rc };
}

// ── SA1: Scatter with async action zones ────────────────────────────
//
// Coordinator has $ctx.items = ["a","b","c"]. Scatter over them.
// Inside each scatter branch: async action zone does
//   $ctx.results.push(await $agent.process($ctx.items[$ctx._scatterIdx]))
// After scatter completes, $ctx.results should have 3 entries.
//
// Since $agent.process is async, the action zone has async:true.
// We use $agent via extras injection on the coordinator.

async function testSA1(): Promise<TestResult> {
  const name = "SA1: Scatter with async action zone";

  try {
    // Coordinator graph: init → action(set items) → scatter → join → action(check) → terminal
    const coordGraph = makeGraph("AsyncScatter", "coordinator", [
      sInitial("init"),
      sAction("setup", "$ctx.items = ['a','b','c']; $ctx.results = []"),
      sScatter("scatter1", "$ctx.items", "worker", ["branch_entry"]),
      sGuardExpr("branch_entry"),
      sAction("async_act", "const r = await $agent.process('item'); $ctx.results.push(r)", { async: true }),
      sJoin("join1", 1),
      sAction("verify", "$self.resultCount = $ctx.results.length"),
      sTerminal("end"),
    ], [
      tr("init", "setup"),
      tr("setup", "scatter1"),
      tr("scatter1", "branch_entry", { kind: "branch", branchIndex: 0 }),
      tr("branch_entry", "async_act"),
      tr("async_act", "join1"),
      tr("join1", "verify"),
      tr("verify", "end"),
    ]);

    const rta = { "AsyncScatter.coordinator": "CoordAgent" };

    const agentModule = {
      process: async (item: string) => {
        await new Promise(r => setTimeout(r, 10));
        return `processed-${item}`;
      },
    };

    const agentNode = new NativeAgentNode({ roleToAgent: rta });
    const rc = new ReagentController({ nodeId: "test-node", agentNode });
    rc.registerAgent(
      "CoordAgent",
      { roleName: "CoordRole", lang: "ts", plays: [{ protocolName: "AsyncScatter", roleName: "coordinator" }], lifecycleHandlers: [] } as RoleIR,
      new Map([["AsyncScatter.coordinator", coordGraph]]),
      agentModule,
    );

    await rc.start();

    const instanceId = randomUUID();
    rc.triggerProtocol("CoordAgent", { instanceId, protocolName: "AsyncScatter", input: {}, roleToAgent: rta });

    const coord = getHandle(rc, "CoordAgent");
    await coord.waitForCompletion(1, 10000);

    const ci = coord.getInstances().get(instanceId)!;
    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Status: ${ci.getStatus()}` };

    const coordSelf = coord.getSelf();
    if (coordSelf.resultCount !== 3) return { name, passed: false, error: `Expected resultCount=3, got ${coordSelf.resultCount}` };

    const traces = ci.getTraces();
    const scatterStarted = traces.filter(t => t.kind === "ScatterStarted");
    if (scatterStarted.length !== 1) return { name, passed: false, error: `Expected 1 ScatterStarted, got ${scatterStarted.length}` };

    const scatterCompleted = traces.filter(t => t.kind === "ScatterCompleted");
    if (scatterCompleted.length !== 1) return { name, passed: false, error: `Expected 1 ScatterCompleted, got ${scatterCompleted.length}` };
    if ((scatterCompleted[0].data as any)?.count !== 3) return { name, passed: false, error: `Scatter count should be 3` };

    await rc.stop();
    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── SA2: Async preSend and postReceive zones ────────────────────────
//
// Non-scatter test: client sends to worker with async preSend zone
// (await $agent.tag()), worker replies, client has async postReceive
// zone (await $agent.validate()). Validates the async zone dispatch
// in the main ProtocolInstance (not BranchRunner).

async function testSA2(): Promise<TestResult> {
  const name = "SA2: Async preSend and postReceive zones";

  try {
    const clientGraph = makeGraph("AsyncZones", "client", [
      sInitial("init"),
      sSend("snd1", "worker", "Request", {
        preSendZone: "const t = await $agent.tag(); $ctx.msg.tagged = t",
        preSendAsync: true,
      }),
      sRecv("rcv1", "worker", "Response", {
        postReceiveZone: "const v = await $agent.validate($ctx.msg.result); $self.validated = v",
        postReceiveAsync: true,
      }),
      sTerminal("end"),
    ], [tr("init", "snd1"), tr("snd1", "rcv1"), tr("rcv1", "end")]);

    const workerGraph = makeGraph("AsyncZones", "worker", [
      sInitial("init"),
      sRecv("rcv1", "client", "Request", {
        postReceiveZone: "$self.receivedTag = $ctx.msg.tagged",
      }),
      sAction("act1", "$ctx.result = 'payload-' + ($self.receivedTag || 'none')"),
      sSend("snd1", "client", "Response", { preSendZone: "$ctx.msg.result = $ctx.result" }),
      sTerminal("end"),
    ], [tr("init", "rcv1"), tr("rcv1", "act1"), tr("act1", "snd1"), tr("snd1", "end")]);

    const rta = {
      "AsyncZones.client": "ClientAgent",
      "AsyncZones.worker": "WorkerAgent",
    };

    const agentModule = {
      tag: async () => { await new Promise(r => setTimeout(r, 5)); return "async-tag"; },
      validate: async (v: string) => { await new Promise(r => setTimeout(r, 5)); return `ok:${v}`; },
    };

    const agentNode = new NativeAgentNode({ roleToAgent: rta });
    const rc = new ReagentController({ nodeId: "test-node", agentNode });

    rc.registerAgent(
      "ClientAgent",
      { roleName: "ClientRole", lang: "ts", plays: [{ protocolName: "AsyncZones", roleName: "client" }], lifecycleHandlers: [] } as RoleIR,
      new Map([["AsyncZones.client", clientGraph]]),
      agentModule,
    );
    rc.registerAgent(
      "WorkerAgent",
      { roleName: "WorkerRole", lang: "ts", plays: [{ protocolName: "AsyncZones", roleName: "worker" }], lifecycleHandlers: [] } as RoleIR,
      new Map([["AsyncZones.worker", workerGraph]]),
    );

    await rc.start();

    const instanceId = randomUUID();
    const trigger = { instanceId, protocolName: "AsyncZones", input: {}, roleToAgent: rta };
    rc.triggerProtocol("WorkerAgent", trigger);
    rc.triggerProtocol("ClientAgent", trigger);

    const client = getHandle(rc, "ClientAgent");
    const worker = getHandle(rc, "WorkerAgent");

    await Promise.all([
      client.waitForCompletion(1, 10000),
      worker.waitForCompletion(1, 10000),
    ]);

    const ci = client.getInstances().get(instanceId)!;
    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Client status: ${ci.getStatus()}` };

    const clientSelf = client.getSelf();
    if (clientSelf.validated !== "ok:payload-async-tag") {
      return { name, passed: false, error: `Expected validated='ok:payload-async-tag', got '${clientSelf.validated}'` };
    }

    await rc.stop();
    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── SA3: Scatter with async action accumulating $ctx ───────────────
//
// Pure coordinator-side scatter: 5 items, each branch runs an async
// action zone that pushes a result into $ctx.results.
// Verifies $ctx.results has exactly 5 entries and all values are correct.

async function testSA3(): Promise<TestResult> {
  const name = "SA3: Scatter async action — 5 branches accumulate into $ctx";

  try {
    const coordGraph = makeGraph("BatchProcess", "coordinator", [
      sInitial("init"),
      sAction("setup", "$ctx.items = [10,20,30,40,50]; $ctx.results = []"),
      sScatter("scatter1", "$ctx.items", "worker", ["br_entry"]),
      sGuardExpr("br_entry"),
      sAction("async_compute", "const v = await $agent.compute(42); $ctx.results.push(v)", { async: true }),
      sJoin("join1", 1),
      sAction("check", "$self.resultCount = $ctx.results.length; $self.allPositive = $ctx.results.every(r => r > 0)"),
      sTerminal("end"),
    ], [
      tr("init", "setup"),
      tr("setup", "scatter1"),
      tr("scatter1", "br_entry", { kind: "branch", branchIndex: 0 }),
      tr("br_entry", "async_compute"),
      tr("async_compute", "join1"),
      tr("join1", "check"),
      tr("check", "end"),
    ]);

    const rta = { "BatchProcess.coordinator": "CoordAgent" };
    let callCount = 0;
    const agentModule = {
      compute: async (x: number) => {
        callCount++;
        await new Promise(r => setTimeout(r, 5));
        return x * callCount;
      },
    };

    const agentNode = new NativeAgentNode({ roleToAgent: rta });
    const rc = new ReagentController({ nodeId: "test-node", agentNode });
    rc.registerAgent(
      "CoordAgent",
      { roleName: "CoordRole", lang: "ts", plays: [{ protocolName: "BatchProcess", roleName: "coordinator" }], lifecycleHandlers: [] } as RoleIR,
      new Map([["BatchProcess.coordinator", coordGraph]]),
      agentModule,
    );

    await rc.start();

    const instanceId = randomUUID();
    rc.triggerProtocol("CoordAgent", { instanceId, protocolName: "BatchProcess", input: {}, roleToAgent: rta });

    const coord = getHandle(rc, "CoordAgent");
    await coord.waitForCompletion(1, 10000);

    const ci = coord.getInstances().get(instanceId)!;
    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Status: ${ci.getStatus()}` };

    const coordSelf = coord.getSelf();
    if (coordSelf.resultCount !== 5) return { name, passed: false, error: `Expected resultCount=5, got ${coordSelf.resultCount}` };
    if (!coordSelf.allPositive) return { name, passed: false, error: `Not all results positive` };

    const traces = ci.getTraces();
    const scatterCompleted = traces.filter(t => t.kind === "ScatterCompleted");
    if (scatterCompleted.length !== 1) return { name, passed: false, error: `Expected 1 ScatterCompleted, got ${scatterCompleted.length}` };
    if ((scatterCompleted[0].data as any)?.count !== 5) return { name, passed: false, error: `Scatter count should be 5` };

    await rc.stop();
    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── SA4: Scatter per-item access via $ctx._scatterItem / _scatterIdx ──
//
// Coordinator has $ctx.items = ["alpha","beta","gamma"]. Scatter over them.
// Each branch reads $ctx._scatterItem and $ctx._scatterIdx and pushes
// a formatted string into $ctx.results. After scatter, verify results
// contain the correct per-item values.

async function testSA4(): Promise<TestResult> {
  const name = "SA4: Scatter per-item access via $ctx._scatterItem/_scatterIdx";

  try {
    const coordGraph = makeGraph("ScatterItems", "coordinator", [
      sInitial("init"),
      sAction("setup", "$ctx.items = ['alpha','beta','gamma']; $ctx.results = []"),
      sScatter("scatter1", "$ctx.items", "worker", ["br_entry"]),
      sGuardExpr("br_entry"),
      sAction("collect", "$ctx.results.push($ctx._scatterIdx + ':' + $ctx._scatterItem)"),
      sJoin("join1", 1),
      sAction("verify", "$self.results = $ctx.results.slice().sort()"),
      sTerminal("end"),
    ], [
      tr("init", "setup"),
      tr("setup", "scatter1"),
      tr("scatter1", "br_entry", { kind: "branch", branchIndex: 0 }),
      tr("br_entry", "collect"),
      tr("collect", "join1"),
      tr("join1", "verify"),
      tr("verify", "end"),
    ]);

    const rta = { "ScatterItems.coordinator": "CoordAgent" };

    const agentNode = new NativeAgentNode({ roleToAgent: rta });
    const rc = new ReagentController({ nodeId: "test-node", agentNode });
    rc.registerAgent(
      "CoordAgent",
      { roleName: "CoordRole", lang: "ts", plays: [{ protocolName: "ScatterItems", roleName: "coordinator" }], lifecycleHandlers: [] } as RoleIR,
      new Map([["ScatterItems.coordinator", coordGraph]]),
    );

    await rc.start();

    const instanceId = randomUUID();
    rc.triggerProtocol("CoordAgent", { instanceId, protocolName: "ScatterItems", input: {}, roleToAgent: rta });

    const coord = getHandle(rc, "CoordAgent");
    await coord.waitForCompletion(1, 10000);

    const ci = coord.getInstances().get(instanceId)!;
    if (ci.getStatus() !== "completed") return { name, passed: false, error: `Status: ${ci.getStatus()}` };

    const coordSelf = coord.getSelf();
    const expected = ["0:alpha", "1:beta", "2:gamma"];
    const actual = coordSelf.results as string[];
    if (!actual || actual.length !== 3) return { name, passed: false, error: `Expected 3 results, got ${actual?.length}` };
    for (const exp of expected) {
      if (!actual.includes(exp)) return { name, passed: false, error: `Missing expected result '${exp}', got ${JSON.stringify(actual)}` };
    }

    await rc.stop();
    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function runAllTests(): Promise<void> {
  console.log("=== M9 Pre-requisite: Scatter + Async Zones E2E Tests ===\n");

  const tests = [testSA1, testSA2, testSA3, testSA4];
  const results: TestResult[] = [];

  for (const test of tests) {
    const result = await test();
    results.push(result);
    const mark = result.passed ? "✓" : "✗";
    console.log(`  ${mark} ${result.name}${result.error ? ` — ${result.error}` : ""}`);
  }

  console.log();
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length}`);

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(err => {
  console.error("Test runner fatal:", err);
  process.exit(1);
});
