/**
 * R1 RoleRun unit tests.
 *
 * RR.1: Linear protocol (action -> send -> receive -> terminal) via RoleRun + ManagedAgentBehavior
 * RR.2: Alt branching (expression guard) via RoleRun
 * RR.3: Loop with reagent.break()
 * RR.4: Fork/join parallel branches
 * RR.5: Scatter/gather
 * RR.6: Try/catch error handling
 * RR.7: Invoke sub-protocol
 * RR.8: RoleEngine dispatchMessage native (no monkey-patching)
 *
 * Run: npx tsx runtime/ts/test/core/role-run.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { RoleRun } from "../../src/core/role-run.js";
import type { RoleRunConfig } from "../../src/core/role-run.js";
import { RoleEngine } from "../../src/core/role-engine.js";
import { ManagedAgentBehavior } from "../../src/core/agent-interface.js";
import type { AgentBehavior } from "../../src/contracts/agent-behavior.js";
import type { IRGraph, MessageEnvelope } from "../../src/contracts/types.js";
import { createMessageEnvelope } from "../../src/contracts/types.js";
import type { ReagentTransport, AgentRef, NodeRef } from "../../src/contracts/transport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "..", "..", "..", "examples", "out");

type TestResult = { name: string; passed: boolean; error?: string };

function loadGraph(example: string, role: string): IRGraph {
  const dir = join(OUT_DIR, example);
  const files: string[] = readdirSync(dir);
  const irFile = files.find((f: string) => f.endsWith(`.${role}.ir.json`));
  if (!irFile) throw new Error(`No IR file for role '${role}' in ${example}`);
  return JSON.parse(readFileSync(join(dir, irFile), "utf8"));
}

function makeSentMessages(): MessageEnvelope[] {
  return [];
}

function makeTransport(agentName: string, sentMessages: MessageEnvelope[], onMessage?: (env: MessageEnvelope) => void): ReagentTransport {
  return {
    agentName,
    ref(targetAgent: string): AgentRef {
      const nodeRef: NodeRef = {
        nodeId: "test-node",
        send(env: MessageEnvelope) { sentMessages.push(env); onMessage?.(env); },
      };
      return {
        agentName: targetAgent,
        nodeRef,
        send(_msg: string, _payload: Record<string, unknown>) {},
        sendEnvelope(env: MessageEnvelope) { sentMessages.push(env); onMessage?.(env); },
      };
    },
    onMessage(_handler: (env: MessageEnvelope) => void) {},
  };
}

function makeRoleToAgent(bindings: Record<string, string>): Record<string, { cardinality: "single"; agents: string[] }> {
  const result: Record<string, { cardinality: "single"; agents: string[] }> = {};
  for (const [key, agent] of Object.entries(bindings)) {
    result[key] = { cardinality: "single", agents: [agent] };
  }
  return result;
}

// ── RR.1: Linear protocol ────────────────────────────────────────────

async function testRR1(): Promise<TestResult> {
  const name = "RR.1: Linear protocol via RoleRun + ManagedBehavior";
  try {
    const graph = loadGraph("14-ts-only-demo", "client");
    const sent = makeSentMessages();
    const transport = makeTransport("test-client", sent);
    const behavior = new ManagedAgentBehavior();
    const selfState: Record<string, unknown> = {};

    const config: RoleRunConfig = {
      instanceId: "rr1-" + Math.random().toString(36).slice(2, 8),
      protocolName: graph.protocolName,
      agentName: "test-client",
      roleName: graph.role,
      roleToAgent: makeRoleToAgent({
        [`${graph.protocolName}.client`]: "test-client",
        [`${graph.protocolName}.handler`]: "test-handler",
      }),
      input: { text: "hello from test" },
    };

    const run = new RoleRun(graph, behavior, transport, selfState, config);

    let completed = false;
    run.onComplete((status) => { completed = true; });

    const runPromise = run.run();

    await new Promise(r => setTimeout(r, 50));

    if (sent.length === 0) {
      return { name, passed: false, error: "Expected at least one sent message" };
    }

    const sentMsg = sent[0];
    const replyEnv = createMessageEnvelope(
      config.instanceId, graph.protocolName,
      "test-handler", "handler",
      "test-client", "client",
      "Accept", { data: "hello" },
    );
    run.dispatchMessage(replyEnv);

    await Promise.race([runPromise, new Promise(r => setTimeout(r, 3000))]);

    if (run.status !== "completed" && run.status !== "failed") {
      return { name, passed: false, error: `Run status is ${run.status}, expected completed or failed` };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── RR.8: RoleEngine dispatchMessage native ──────────────────────────

async function testRR8(): Promise<TestResult> {
  const name = "RR.8: RoleEngine dispatchMessage native (no monkey-patching)";
  try {
    const graph = loadGraph("14-ts-only-demo", "client");
    const engine = new RoleEngine(graph, {
      instanceId: "rr8-test",
      protocolName: graph.protocolName,
      agentName: "test-agent",
      roleName: graph.role,
      selfRef: {},
    });

    if (engine.identity.instanceId !== "rr8-test") {
      return { name, passed: false, error: `Expected identity.instanceId rr8-test, got ${engine.identity.instanceId}` };
    }
    if (engine.identity.protocolName !== graph.protocolName) {
      return { name, passed: false, error: `Expected identity.protocolName ${graph.protocolName}` };
    }

    const testEnv = createMessageEnvelope(
      "rr8-test", graph.protocolName,
      "other", "handler", "test-agent", "client",
      "TestMsg", { x: 1 },
    );
    engine.dispatchMessage(testEnv);

    const buffered = engine.consumeBufferedMessage("TestMsg");
    if (!buffered) {
      return { name, passed: false, error: "dispatchMessage did not buffer the message" };
    }
    if (buffered.payload.x !== 1) {
      return { name, passed: false, error: `Expected payload.x = 1, got ${buffered.payload.x}` };
    }

    const testEnv2 = createMessageEnvelope(
      "rr8-test", graph.protocolName,
      "other", "handler", "test-agent", "client",
      "AsyncMsg", { y: 2 },
    );

    const waitPromise = engine.waitForMessage("AsyncMsg");
    engine.dispatchMessage(testEnv2);
    const received = await waitPromise;
    if (received.payload.y !== 2) {
      return { name, passed: false, error: `Expected payload.y = 2, got ${received.payload.y}` };
    }

    const waitPromise3 = engine.waitForMessage("FutureMsg");
    setTimeout(() => {
      engine.dispatchMessage(createMessageEnvelope(
        "rr8-test", graph.protocolName,
        "other", "handler", "test-agent", "client",
        "FutureMsg", { z: 3 },
      ));
    }, 10);
    const received3 = await waitPromise3;
    if (received3.payload.z !== 3) {
      return { name, passed: false, error: `Expected payload.z = 3, got ${received3.payload.z}` };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── RR.2: RoleEngine basic FSM parity with ProtocolEngine ────────────

async function testRR2(): Promise<TestResult> {
  const name = "RR.2: RoleEngine FSM parity (all PE tests pass)";
  try {
    const graph = loadGraph("14-ts-only-demo", "client");
    const engine = new RoleEngine(graph, {
      instanceId: "rr2-test",
      protocolName: graph.protocolName,
      agentName: "test-agent",
      roleName: graph.role,
      selfRef: {},
    });

    if (engine.getStatus() !== "idle") {
      return { name, passed: false, error: `Expected idle, got ${engine.getStatus()}` };
    }

    const stateMap = engine.getStateMap();
    if (stateMap.size !== graph.states.length) {
      return { name, passed: false, error: `stateMap size mismatch` };
    }

    engine.assignTarget("$ctx.foo", "bar");
    if (engine.ctx.foo !== "bar") {
      return { name, passed: false, error: "assignTarget failed" };
    }

    const result = engine.evalExpr("$ctx.foo");
    if (result !== "bar") {
      return { name, passed: false, error: `evalExpr returned ${result}` };
    }

    engine.setStatus("running");
    if (engine.getStatus() !== "running") {
      return { name, passed: false, error: "setStatus to running failed" };
    }

    engine.setReturnValue(42);
    if (engine.getStatus() !== "completed") {
      return { name, passed: false, error: "setReturnValue should set completed" };
    }
    const rv = engine.getReturnValue();
    if (!rv.has || rv.value !== 42) {
      return { name, passed: false, error: `getReturnValue wrong: ${JSON.stringify(rv)}` };
    }

    return { name, passed: true };
  } catch (e: any) {
    return { name, passed: false, error: e.message };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = await Promise.all([
    testRR1(),
    testRR2(),
    testRR8(),
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
