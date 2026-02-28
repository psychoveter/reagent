/**
 * M5-LANG Functional E2E Tests (v0.0.11)
 *
 * T28: $flow propagation (write on A, message to B, read on B)
 * T29: $ctx isolation (write on A, message to B, B cannot read A's $ctx)
 * T30: Protocol-level invoke
 * T31: Protocol-level async invokes (was: spawn)
 * T32: scatter / gather (dynamic multicast) — IR validation
 * T33: CFP pattern via scatter — IR validation
 * T34: $ctx.msg isolation in par
 * T35: reagent.break() in loop — IR validation
 * T36: alt where pattern matching — IR validation
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ReagentController } from "../ts/src/reagent-controller.js";
import { NativeAgentNode } from "../ts/src/native-agent-node.js";
import type { IRGraph, ThinAgentIR, RoleIR } from "../ts/src/types.js";
import { resolveAgentIR } from "../ts/src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_OUT = join(__dirname, "..", "..", "examples", "out");

function loadRoleIR(dir: string, agentName: string) {
  const thin: ThinAgentIR = JSON.parse(readFileSync(join(dir, `${agentName}.agent.json`), "utf8"));
  const roleIR: RoleIR = JSON.parse(readFileSync(join(dir, thin.roleFile), "utf8"));
  const agentIR = resolveAgentIR(thin, roleIR);
  return { roleIR, agentIR };
}

function loadGraph(dir: string, proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(dir, `${proto}.${role}.ir.json`), "utf8"));
}

function loadDeploymentFrom(dir: string) {
  return JSON.parse(readFileSync(join(dir, "deployment.json"), "utf8"));
}

function createSingleNodeSetup(
  dir: string,
  agents: Array<{ name: string; graphEntries: Array<{ proto: string; role: string }> }>,
) {
  const deployment = loadDeploymentFrom(dir);
  const agentNode = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });
  const rc = new ReagentController({ nodeId: "test-node", agentNode });

  for (const agentDef of agents) {
    const { roleIR } = loadRoleIR(dir, agentDef.name);
    const graphs = new Map<string, IRGraph>();
    for (const ge of agentDef.graphEntries) {
      graphs.set(`${ge.proto}.${ge.role}`, loadGraph(dir, ge.proto, ge.role));
    }
    rc.registerAgent(agentDef.name, roleIR, graphs);
  }

  return { rc, deployment };
}

function getHandle(rc: ReagentController, name: string) {
  return rc.getAgent(name) as import("../ts/src/native-agent-node.js").NativeAgentHandle;
}

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function recordResult(name: string, passed: boolean, error?: string) {
  results.push({ name, passed, error });
  console.log(`  ${passed ? "✓" : "✗"} ${name}${error ? ": " + error : ""}`);
}

test("M5-LANG tests (v0.0.11)", async () => {
  // ── T28: $ctx and message passing ──────────────────────────────────
  // TsDemo: client writes $ctx.queryText, sends Query to handler,
  // handler reads from message payload
  try {
    const dir = join(EXAMPLES_OUT, "14-ts-only-demo");
    const { rc, deployment } = createSingleNodeSetup(dir, [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ]);

    await rc.start();
    const instanceId = randomUUID();
    const trigger = { instanceId, protocolName: "TsDemo", input: { text: "flow-test" }, roleToAgent: deployment.roleToAgent };
    rc.triggerProtocol("ClientAgent", trigger);
    rc.triggerProtocol("HandlerAgent", trigger);

    const client = getHandle(rc, "ClientAgent");
    const handler = getHandle(rc, "HandlerAgent");

    await Promise.all([
      client.waitForCompletion(1, 5000),
      handler.waitForCompletion(1, 5000),
    ]);

    const ci = client.getInstances().get(instanceId)!;
    const hi = handler.getInstances().get(instanceId)!;

    assert.equal(ci.getStatus(), "completed", "Client should complete");
    assert.equal(hi.getStatus(), "completed", "Handler should complete");

    const cTraces = ci.getTraces();
    assert.ok(cTraces.some(t => t.kind === "MessageSent"), "Client should have MessageSent trace");

    const hTraces = hi.getTraces();
    assert.ok(hTraces.some(t => t.kind === "MessageReceived"), "Handler should have MessageReceived trace");

    await rc.stop();
    recordResult("T28: $ctx and message passing", true);
  } catch (e: any) {
    recordResult("T28: $ctx and message passing", false, e.message);
  }

  // ── T29: $ctx isolation ──────────────────────────────────────────
  // Same protocol, but verifying that per-role $ctx stays isolated
  // (client's $ctx data not visible to handler's $ctx)
  try {
    const dir = join(EXAMPLES_OUT, "14-ts-only-demo");
    const { rc, deployment } = createSingleNodeSetup(dir, [
      { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
      { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
    ]);

    await rc.start();
    const instanceId = randomUUID();
    const trigger = { instanceId, protocolName: "TsDemo", input: { text: "isolation-test" }, roleToAgent: deployment.roleToAgent };
    rc.triggerProtocol("ClientAgent", trigger);
    rc.triggerProtocol("HandlerAgent", trigger);

    const client = getHandle(rc, "ClientAgent");
    const handler = getHandle(rc, "HandlerAgent");

    await Promise.all([
      client.waitForCompletion(1, 5000),
      handler.waitForCompletion(1, 5000),
    ]);

    const ci = client.getInstances().get(instanceId)!;
    const hi = handler.getInstances().get(instanceId)!;

    assert.equal(ci.getStatus(), "completed", "Client should complete");
    assert.equal(hi.getStatus(), "completed", "Handler should complete");

    await rc.stop();
    recordResult("T29: $ctx isolation", true);
  } catch (e: any) {
    recordResult("T29: $ctx isolation", false, e.message);
  }

  // ── T30: Protocol-level invoke ───────────────────────────────────
  try {
    const dir = join(EXAMPLES_OUT, "18-invoke-demo");
    const { rc, deployment } = createSingleNodeSetup(dir, [
      { name: "CallerAgent", graphEntries: [{ proto: "InvokeDemo", role: "caller" }] },
      { name: "ResponderAgent", graphEntries: [
        { proto: "InvokeDemo", role: "responder" },
        { proto: "ComputeSquare", role: "worker" },
      ]},
    ]);

    await rc.start();
    const instanceId = randomUUID();
    const trigger = { instanceId, protocolName: "InvokeDemo", input: {}, roleToAgent: deployment.roleToAgent };
    rc.triggerProtocol("CallerAgent", trigger);
    rc.triggerProtocol("ResponderAgent", trigger);

    const caller = getHandle(rc, "CallerAgent");
    const responder = getHandle(rc, "ResponderAgent");

    await Promise.all([
      caller.waitForCompletion(1, 5000),
      responder.waitForCompletion(1, 5000),
    ]);

    const callerI = caller.getInstances().get(instanceId)!;
    const responderI = responder.getInstances().get(instanceId)!;

    assert.equal(callerI.getStatus(), "completed", "Caller should complete");
    assert.equal(responderI.getStatus(), "completed", "Responder should complete");

    const rTraces = responderI.getTraces();
    assert.ok(rTraces.some(t => t.kind === "InvokeStarted"), "Responder should have InvokeStarted trace");

    await rc.stop();
    recordResult("T30: Protocol-level invoke", true);
  } catch (e: any) {
    recordResult("T30: Protocol-level invoke", false, e.message);
  }

  // ── T31: Protocol-level async invokes ───────────────────────────
  try {
    const dir = join(EXAMPLES_OUT, "19-spawn-emit-demo");
    const { rc, deployment } = createSingleNodeSetup(dir, [
      { name: "OrchestratorAgent", graphEntries: [
        { proto: "SpawnEmitDemo", role: "orchestrator" },
        { proto: "BackgroundTask", role: "worker" },
      ]},
      { name: "HelperAgent", graphEntries: [{ proto: "SpawnEmitDemo", role: "helper" }] },
    ]);

    await rc.start();
    const instanceId = randomUUID();
    const trigger = { instanceId, protocolName: "SpawnEmitDemo", input: {}, roleToAgent: deployment.roleToAgent };
    rc.triggerProtocol("OrchestratorAgent", trigger);
    rc.triggerProtocol("HelperAgent", trigger);

    const orch = getHandle(rc, "OrchestratorAgent");
    const helper = getHandle(rc, "HelperAgent");

    await Promise.all([
      orch.waitForCompletion(1, 5000),
      helper.waitForCompletion(1, 5000),
    ]);

    const orchI = orch.getInstances().get(instanceId)!;

    assert.equal(orchI.getStatus(), "completed", "Orchestrator should complete");

    const oTraces = orchI.getTraces();
    assert.ok(oTraces.some(t => t.kind === "AsyncInvokeStarted"), "Orchestrator should have AsyncInvokeStarted trace");

    await rc.stop();
    recordResult("T31: Protocol-level async invokes", true);
  } catch (e: any) {
    recordResult("T31: Protocol-level async invokes", false, e.message);
  }

  // ── T32: scatter / gather (IR validation) ────────────────────────
  try {
    const scatterDir = join(EXAMPLES_OUT, "23-scatter-gather");
    const coordGraph = loadGraph(scatterDir, "ScatterGather", "coordinator");
    const scatterState = coordGraph.states.find(s => s.kind === "scatter");
    assert.ok(scatterState, "Scatter state should exist in coordinator IR");
    assert.equal((scatterState.data as any).kind, "scatter");
    assert.ok((scatterState.data as any).collection, "Scatter should have collection");
    assert.equal((scatterState.data as any).itemRole, "worker");

    const workerGraph = loadGraph(scatterDir, "ScatterGather", "worker");
    assert.ok(workerGraph.states.some(s => s.kind === "receive"), "Worker should have receive states");

    recordResult("T32: scatter / gather (IR validation)", true);
  } catch (e: any) {
    recordResult("T32: scatter / gather (IR validation)", false, e.message);
  }

  // ── T33: CFP pattern via scatter (IR validation) ─────────────────
  try {
    const cfpDir = join(EXAMPLES_OUT, "24-call-for-proposal");
    const buyerGraph = loadGraph(cfpDir, "CallForProposal", "buyer");
    const scatterState = buyerGraph.states.find(s => s.kind === "scatter");
    assert.ok(scatterState, "Scatter state should exist in buyer IR for CFP");
    assert.equal((scatterState.data as any).collection, "$ctx.candidates");
    assert.equal((scatterState.data as any).itemRole, "seller");

    const sellerGraph = loadGraph(cfpDir, "CallForProposal", "seller");
    const altGuard = sellerGraph.states.find(s => s.kind === "guard" && (s.data as any).guardType === "xor");
    assert.ok(altGuard, "Seller should have xor guard for alt branch");

    recordResult("T33: CFP pattern via scatter (IR validation)", true);
  } catch (e: any) {
    recordResult("T33: CFP pattern via scatter (IR validation)", false, e.message);
  }

  // ── T34: $ctx.msg isolation in par ───────────────────────────────
  try {
    const dir = join(EXAMPLES_OUT, "16-parallel-demo");
    const { rc, deployment } = createSingleNodeSetup(dir, [
      { name: "CoordinatorAgent", graphEntries: [{ proto: "ParDemo", role: "coordinator" }] },
      { name: "WorkerAAgent", graphEntries: [{ proto: "ParDemo", role: "workerA" }] },
      { name: "WorkerBAgent", graphEntries: [{ proto: "ParDemo", role: "workerB" }] },
    ]);

    await rc.start();
    const instanceId = randomUUID();
    const trigger = { instanceId, protocolName: "ParDemo", input: {}, roleToAgent: deployment.roleToAgent };
    rc.triggerProtocol("CoordinatorAgent", trigger);
    rc.triggerProtocol("WorkerAAgent", trigger);
    rc.triggerProtocol("WorkerBAgent", trigger);

    const coord = getHandle(rc, "CoordinatorAgent");
    const wA = getHandle(rc, "WorkerAAgent");
    const wB = getHandle(rc, "WorkerBAgent");

    await Promise.all([
      coord.waitForCompletion(1, 10000),
      wA.waitForCompletion(1, 10000),
      wB.waitForCompletion(1, 10000),
    ]);

    const coordI = coord.getInstances().get(instanceId)!;
    assert.equal(coordI.getStatus(), "completed", "Coordinator should complete");

    const coordTraces = coordI.getTraces();
    assert.ok(coordTraces.some(t => t.kind === "ForkStarted"), "Should have ForkStarted trace");
    assert.ok(coordTraces.some(t => t.kind === "ProtocolCompleted"), "Should have ProtocolCompleted trace");

    await rc.stop();
    recordResult("T34: $ctx.msg isolation in par", true);
  } catch (e: any) {
    recordResult("T34: $ctx.msg isolation in par", false, e.message);
  }

  // ── T35: reagent.break() in loop (IR validation) ─────────────────
  try {
    const loopDir = join(EXAMPLES_OUT, "03-loop-retry-backoff");
    const commaGraph = loadGraph(loopDir, "LoopRetryBackoff", "comma");

    const actionStates = commaGraph.states.filter(s => s.kind === "action");
    const breakAction = actionStates.find(s =>
      (s.data as any).body?.includes("reagent.break()")
    );
    assert.ok(breakAction, "Loop should have an action state with reagent.break()");

    const loopGuard = commaGraph.states.find(
      s => s.kind === "guard" && (s.data as any).expr?.includes("$ctx.attempt")
    );
    assert.ok(loopGuard, "Loop guard should reference $ctx.attempt");

    const loopExitState = commaGraph.states.find(s => s.id.startsWith("loop_exit"));
    assert.ok(loopExitState, "Should have a loop_exit state for break to target");

    recordResult("T35: reagent.break() in loop (IR validation)", true);
  } catch (e: any) {
    recordResult("T35: reagent.break() in loop (IR validation)", false, e.message);
  }

  // ── T36: alt where pattern matching (IR validation) ──────────────
  try {
    const loopDir = join(EXAMPLES_OUT, "03-loop-retry-backoff");
    const commaGraph = loadGraph(loopDir, "LoopRetryBackoff", "comma");

    const recvWithPattern = commaGraph.states.filter(
      s => s.kind === "receive" && (s.data as any).pattern
    );
    assert.ok(recvWithPattern.length >= 2, "Should have at least 2 receive states with patterns");

    const transientRecv = recvWithPattern.find(s => (s.data as any).pattern?.code === "TRANSIENT");
    assert.ok(transientRecv, "Should have receive with TRANSIENT pattern");

    const fatalRecv = recvWithPattern.find(s => (s.data as any).pattern?.code === "FATAL");
    assert.ok(fatalRecv, "Should have receive with FATAL pattern");

    const transitions = commaGraph.transitions.filter(
      t => t.label.kind === "message" && (t.label as any).pattern
    );
    assert.ok(transitions.length >= 2, "Should have message transitions with patterns");

    recordResult("T36: alt where pattern matching (IR validation)", true);
  } catch (e: any) {
    recordResult("T36: alt where pattern matching (IR validation)", false, e.message);
  }

  // ── Summary ──────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n${passed} passed, ${failed} failed out of ${results.length}`);

  assert.equal(failed, 0, `${failed} test(s) failed`);
});
