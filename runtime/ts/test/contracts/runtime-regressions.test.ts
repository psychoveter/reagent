/**
 * Regression tests for R1 runtime fixes (findings F1, F2, F3, F4, F5).
 *
 * RF1a: Pre-send zone error propagates to try/catch
 * RF1b: Post-receive zone error propagates to try/catch
 * RF1c: Pre-send zone error propagates in fork/branch
 * RF1d: Return value from post-receive zone terminates run
 * RF2a: Invoked child protocol receives inbound messages
 * RF2b: Spawned child protocol is routable and gets full callbacks
 * RF3:  Concurrent gate events resolve in FIFO order
 * RF4a: External detachBehavior updates AgentRecord via RC callback
 * RF4b: External re-attachBehavior restores AgentRecord via RC callback
 * RF4c: detachAgentRuntime clears status callback (no stale updates)
 * RF5:  Completed runs leave activeRuns, getInstances() has both
 *
 * Run: npx tsx runtime/ts/test/contracts/runtime-regressions.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { RoleRun } from "../../src/core/role-run.js";
import type { RoleRunConfig } from "../../src/core/role-run.js";
import { AgentShellImpl } from "../../src/core/agent-shell-impl.js";
import type { AgentShellConfig } from "../../src/core/agent-shell-impl.js";
import { GateBehaviorFactory } from "../../src/nodes/gate-behavior-factory.js";
import type { AgentBehavior } from "../../src/contracts/agent-behavior.js";
import type { ProtocolEvent, AgentResponse } from "../../src/core/protocol-engine.js";
import type { IRGraph, MessageEnvelope, RoleIR, ThinAgentIR } from "../../src/contracts/types.js";
import { createMessageEnvelope } from "../../src/contracts/types.js";
import type { ReagentTransport, AgentRef, NodeRef } from "../../src/contracts/transport.js";
import type { GateTransport } from "../../src/gate/gate-transport.js";
import { ReagentController } from "../../src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../../src/nodes/managed-behavior-factory.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Helpers ─────────────────────────────────────────────────────────

function makeTransport(
  agentName: string,
  sent: MessageEnvelope[],
  onMessage?: (env: MessageEnvelope) => void,
): ReagentTransport {
  let handler: ((env: MessageEnvelope) => void) | null = null;
  return {
    agentName,
    ref(target: string): AgentRef {
      const nodeRef: NodeRef = {
        nodeId: "test-node",
        send(env: MessageEnvelope) { sent.push(env); onMessage?.(env); },
      };
      return {
        agentName: target,
        nodeRef,
        send() {},
        sendEnvelope(env: MessageEnvelope) { sent.push(env); onMessage?.(env); },
      };
    },
    onMessage(h: (env: MessageEnvelope) => void) { handler = h; },
  };
}

function makeBindings(map: Record<string, string>) {
  const result: Record<string, { cardinality: string; agents: string[] }> = {};
  for (const [k, v] of Object.entries(map)) result[k] = { cardinality: "single", agents: [v] };
  return result;
}

/**
 * Build a minimal IRGraph from a list of state descriptors.
 * Transitions chain linearly by default; use `transitions` for branching.
 */
function buildGraph(opts: {
  protocolName: string;
  role: string;
  states: Array<{ id: string; data: Record<string, unknown> }>;
  transitions?: Array<{ from: string; to: string; label?: Record<string, unknown> }>;
  participants?: Array<{ name: string; cardinality?: string }>;
}): IRGraph {
  const transitions = opts.transitions ?? opts.states.slice(0, -1).map((s, i) => ({
    from: s.id,
    to: opts.states[i + 1].id,
    label: { kind: "default" },
  }));
  const initialState = opts.states.find(s => (s.data as any).kind === "initial");
  const terminalStates = opts.states.filter(s => (s.data as any).kind === "terminal");
  return {
    protocolName: opts.protocolName,
    role: opts.role,
    lang: "*",
    states: opts.states.map(s => ({ id: s.id, data: s.data })),
    transitions,
    initialStateId: initialState?.id ?? opts.states[0].id,
    terminalStateIds: terminalStates.map(s => s.id),
    participants: opts.participants ?? [{ name: opts.role, cardinality: "single" }],
  } as IRGraph;
}

// ── RF1a: Pre-send zone error propagates to try/catch ────────────────

describe("RF1: zone error propagation", () => {
  test("RF1a: pre-send zone error_thrown propagates to catch", async () => {
    const behavior: AgentBehavior = {
      async handle(event: ProtocolEvent): Promise<AgentResponse> {
        if (event.type === "pre_send_action") {
          return { type: "error_thrown", error: new Error("preSend boom") };
        }
        if (event.type === "action") {
          return { type: "ctx_update", ctx: event.ctx };
        }
        return { type: "noop" };
      },
    };

    // init → send(with preSendZone) → terminal(ok)
    //         ↳ catch → action(mark) → terminal(ok)
    const graph = buildGraph({
      protocolName: "TestProto",
      role: "sender",
      states: [
        { id: "init", data: { kind: "initial" } },
        { id: "send1", data: { kind: "send", to: "receiver", messageName: "Msg", preSendZone: "$ctx.msg.x = 1", preSendAsync: false } },
        { id: "end_ok", data: { kind: "terminal", status: "completed" } },
        { id: "catch1", data: { kind: "error", label: "error" } },
        { id: "mark", data: { kind: "action", body: "$ctx.caught = true", lang: "ts" } },
        { id: "end_caught", data: { kind: "terminal", status: "completed" } },
      ],
      transitions: [
        { from: "init", to: "send1", label: { kind: "default" } },
        { from: "send1", to: "end_ok", label: { kind: "default" } },
        { from: "catch1", to: "mark", label: { kind: "default" } },
        { from: "mark", to: "end_caught", label: { kind: "default" } },
        { from: "send1", to: "catch1", label: { kind: "error" } },
      ],
    });

    const sent: MessageEnvelope[] = [];
    const transport = makeTransport("A", sent);
    const run = new RoleRun(graph, behavior, transport, {}, {
      instanceId: "rf1a-1",
      protocolName: "TestProto",
      agentName: "A",
      roleName: "sender",
      roleToAgent: makeBindings({ "TestProto.receiver": "B" }),
    });

    await run.run();
    assert.equal(run.status, "completed");
    assert.equal(sent.length, 0, "message should NOT be sent when preSend zone throws");
    const traces = run.getTraces();
    assert.ok(traces.some(t => t.kind === "ErrorCaught"), "should have ErrorCaught trace");
  });

  test("RF1b: post-receive zone error_thrown propagates to catch", async () => {
    const behavior: AgentBehavior = {
      async handle(event: ProtocolEvent): Promise<AgentResponse> {
        if (event.type === "post_receive_action") {
          return { type: "error_thrown", error: new Error("postRecv boom") };
        }
        if (event.type === "action") {
          return { type: "ctx_update", ctx: event.ctx };
        }
        return { type: "noop" };
      },
    };

    const graph = buildGraph({
      protocolName: "TestProto",
      role: "receiver",
      states: [
        { id: "init", data: { kind: "initial" } },
        { id: "recv1", data: { kind: "receive", from: "sender", messageName: "Msg", postReceiveZone: "$ctx.x = $ctx.msg.x", postReceiveAsync: false } },
        { id: "end_ok", data: { kind: "terminal", status: "completed" } },
        { id: "catch1", data: { kind: "error", label: "error" } },
        { id: "mark", data: { kind: "action", body: "$ctx.caught = true", lang: "ts" } },
        { id: "end_caught", data: { kind: "terminal", status: "completed" } },
      ],
      transitions: [
        { from: "init", to: "recv1", label: { kind: "default" } },
        { from: "recv1", to: "end_ok", label: { kind: "default" } },
        { from: "catch1", to: "mark", label: { kind: "default" } },
        { from: "mark", to: "end_caught", label: { kind: "default" } },
        { from: "recv1", to: "catch1", label: { kind: "error" } },
      ],
    });

    const sent: MessageEnvelope[] = [];
    const transport = makeTransport("B", sent);
    const run = new RoleRun(graph, behavior, transport, {}, {
      instanceId: "rf1b-1",
      protocolName: "TestProto",
      agentName: "B",
      roleName: "receiver",
      roleToAgent: makeBindings({ "TestProto.sender": "A" }),
    });

    const runPromise = run.run();

    await new Promise(r => setTimeout(r, 20));
    run.dispatchMessage(createMessageEnvelope(
      "rf1b-1", "TestProto", "A", "sender", "B", "receiver", "Msg", { x: 42 },
    ));

    await runPromise;
    assert.equal(run.status, "completed");
    const traces = run.getTraces();
    assert.ok(traces.some(t => t.kind === "ErrorCaught"), "should have ErrorCaught trace");
  });

  test("RF1c: pre-send zone error in fork branch propagates", async () => {
    let branchErrorSeen = false;
    const behavior: AgentBehavior = {
      async handle(event: ProtocolEvent): Promise<AgentResponse> {
        if (event.type === "pre_send_action") {
          return { type: "error_thrown", error: new Error("branch preSend boom") };
        }
        return { type: "noop" };
      },
    };

    // init → fork → [branch: send(with preSendZone)] → join → terminal
    const graph = buildGraph({
      protocolName: "TestProto",
      role: "sender",
      states: [
        { id: "init", data: { kind: "initial" } },
        { id: "fork1", data: { kind: "fork" } },
        { id: "send_b", data: { kind: "send", to: "other", messageName: "Msg", preSendZone: "$ctx.msg.y = 1" } },
        { id: "join1", data: { kind: "join" } },
        { id: "end", data: { kind: "terminal", status: "completed" } },
      ],
      transitions: [
        { from: "init", to: "fork1", label: { kind: "default" } },
        { from: "fork1", to: "send_b", label: { kind: "branch" } },
        { from: "send_b", to: "join1", label: { kind: "default" } },
        { from: "join1", to: "end", label: { kind: "default" } },
      ],
    });

    const sent: MessageEnvelope[] = [];
    const transport = makeTransport("A", sent);
    const run = new RoleRun(graph, behavior, transport, {}, {
      instanceId: "rf1c-1",
      protocolName: "TestProto",
      agentName: "A",
      roleName: "sender",
      roleToAgent: makeBindings({ "TestProto.other": "B" }),
    });

    await run.run();
    // error in branch should fail the run (no catch target)
    assert.equal(run.status, "failed");
    assert.equal(sent.length, 0, "message should NOT be sent");
  });

  test("RF1d: return_value from post-receive zone terminates run", async () => {
    const behavior: AgentBehavior = {
      async handle(event: ProtocolEvent): Promise<AgentResponse> {
        if (event.type === "post_receive_action") {
          return { type: "return_value", value: "early_exit" };
        }
        return { type: "noop" };
      },
    };

    const graph = buildGraph({
      protocolName: "TestProto",
      role: "receiver",
      states: [
        { id: "init", data: { kind: "initial" } },
        { id: "recv1", data: { kind: "receive", from: "sender", messageName: "Msg", postReceiveZone: "/* zone */", postReceiveAsync: false } },
        { id: "end", data: { kind: "terminal", status: "completed" } },
      ],
      transitions: [
        { from: "init", to: "recv1", label: { kind: "default" } },
        { from: "recv1", to: "end", label: { kind: "default" } },
      ],
    });

    const sent: MessageEnvelope[] = [];
    const transport = makeTransport("B", sent);
    const run = new RoleRun(graph, behavior, transport, {}, {
      instanceId: "rf1d-1",
      protocolName: "TestProto",
      agentName: "B",
      roleName: "receiver",
      roleToAgent: makeBindings({ "TestProto.sender": "A" }),
    });

    const runPromise = run.run();

    await new Promise(r => setTimeout(r, 20));
    run.dispatchMessage(createMessageEnvelope(
      "rf1d-1", "TestProto", "A", "sender", "B", "receiver", "Msg", {},
    ));

    await runPromise;
    assert.equal(run.status, "completed");
    const rv = run.getReturnValue();
    assert.equal(rv.has, true);
    assert.equal(rv.value, "early_exit");
  });
});

// ── RF3: Gate behavior FIFO concurrency ─────────────────────────────

describe("RF3: gate concurrency", () => {
  test("RF3: concurrent gate handle() calls resolve in FIFO order", async () => {
    const sentEvents: ProtocolEvent[] = [];
    let responseHandler: ((resp: AgentResponse) => void) | null = null;

    const fakeTransport: GateTransport = {
      send(event: ProtocolEvent) { sentEvents.push(event); },
      onResponse(handler: (resp: AgentResponse) => void) { responseHandler = handler; },
      close() {},
    };

    const factory = new GateBehaviorFactory({
      transportFactory: () => fakeTransport,
    });

    const behavior = factory.createBehavior("agent", {} as any, new Map());

    // Fire two handle() calls concurrently
    const p1 = behavior.handle({
      type: "action", stateId: "s1", body: "zone1", lang: "ts",
      isAsync: false, ctx: {}, self: {},
    });
    const p2 = behavior.handle({
      type: "action", stateId: "s2", body: "zone2", lang: "ts",
      isAsync: false, ctx: {}, self: {},
    });

    assert.equal(sentEvents.length, 2, "both events should be sent");

    // Respond in order — first response should go to first handle()
    responseHandler!({ type: "ctx_update", ctx: { from: "resp1" } });
    responseHandler!({ type: "ctx_update", ctx: { from: "resp2" } });

    const r1 = await p1;
    const r2 = await p2;

    assert.equal(r1.type, "ctx_update");
    assert.equal((r1 as any).ctx.from, "resp1", "first handle() gets first response");
    assert.equal(r2.type, "ctx_update");
    assert.equal((r2 as any).ctx.from, "resp2", "second handle() gets second response");
  });
});

// ── RF5: completed runs leave activeRuns ─────────────────────────────

describe("RF5: activeRuns cleanup", () => {
  test("RF5: completed run moves from activeRuns to finished", async () => {
    const behavior: AgentBehavior = {
      async handle(event: ProtocolEvent): Promise<AgentResponse> {
        if (event.type === "action") {
          return { type: "ctx_update", ctx: event.ctx };
        }
        return { type: "noop" };
      },
    };

    const graph = buildGraph({
      protocolName: "SimpleProto",
      role: "worker",
      states: [
        { id: "init", data: { kind: "initial" } },
        { id: "act1", data: { kind: "action", body: "$ctx.done = true", lang: "ts" } },
        { id: "end", data: { kind: "terminal", status: "completed" } },
      ],
    });

    const sent: MessageEnvelope[] = [];
    const transport = makeTransport("WorkerAgent", sent);

    const shellConfig: AgentShellConfig = {
      agentName: "WorkerAgent",
      roleName: "worker",
      graphs: new Map([["SimpleProto.worker", graph]]),
      transport,
      roleToAgent: makeBindings({ "SimpleProto.worker": "WorkerAgent" }),
    };

    const shell = new AgentShellImpl(shellConfig);
    shell.attachBehavior(behavior);
    await shell.start();

    shell.triggerProtocol({
      instanceId: "rf5-1",
      protocolName: "SimpleProto",
      input: {},
      roleToAgent: {},
    });

    await shell.waitForCompletion(1, 3000);

    // getActiveRuns should be empty (run completed)
    assert.equal(shell.getActiveRuns().size, 0, "no active runs after completion");

    // getInstances should still find the completed run
    const instances = shell.getInstances();
    assert.equal(instances.size, 1, "getInstances() returns completed run");
    assert.equal(instances.get("rf5-1")!.getStatus(), "completed");

    // getCompletedRuns should have the result
    const completed = shell.getCompletedRuns();
    assert.equal(completed.length, 1);
    assert.equal(completed[0].instanceId, "rf5-1");

    await shell.stop();
  });

  test("RF5b: finished-run retention evicts oldest local history predictably", async () => {
    const behavior: AgentBehavior = {
      async handle(event: ProtocolEvent): Promise<AgentResponse> {
        if (event.type === "action") {
          return { type: "ctx_update", ctx: event.ctx };
        }
        return { type: "noop" };
      },
    };

    const graph = buildGraph({
      protocolName: "SimpleProto",
      role: "worker",
      states: [
        { id: "init", data: { kind: "initial" } },
        { id: "act1", data: { kind: "action", body: "$ctx.done = true", lang: "ts" } },
        { id: "end", data: { kind: "terminal", status: "completed" } },
      ],
    });

    const sent: MessageEnvelope[] = [];
    const transport = makeTransport("WorkerAgent", sent);

    const shell = new AgentShellImpl({
      agentName: "WorkerAgent",
      roleName: "worker",
      graphs: new Map([["SimpleProto.worker", graph]]),
      transport,
      roleToAgent: makeBindings({ "SimpleProto.worker": "WorkerAgent" }),
      finishedRunRetentionLimit: 1,
    });
    shell.attachBehavior(behavior);
    await shell.start();

    shell.triggerProtocol({
      instanceId: "rf5b-1",
      protocolName: "SimpleProto",
      input: {},
      roleToAgent: {},
    });
    shell.triggerProtocol({
      instanceId: "rf5b-2",
      protocolName: "SimpleProto",
      input: {},
      roleToAgent: {},
    });

    await shell.waitForCompletion(2, 3000);

    const instances = shell.getInstances();
    assert.equal(instances.has("rf5b-1"), false, "oldest completed run should be evicted from local history");
    assert.equal(instances.get("rf5b-2")?.getStatus(), "completed");

    const completed = shell.getCompletedRuns();
    assert.equal(completed.length, 1, "completed results should respect the same retention limit");
    assert.equal(completed[0].instanceId, "rf5b-2");

    await shell.stop();
  });

  test("RF5c: shell.stop resolves even when a run is already terminal before onComplete subscription", async () => {
    const transport = makeTransport("WorkerAgent", []);
    const shell = new AgentShellImpl({
      agentName: "WorkerAgent",
      roleName: "worker",
      graphs: new Map(),
      transport,
      roleToAgent: {},
    });

    const fakeRun = {
      status: "cancelled",
      cancel() {},
      onComplete() {},
    };
    (shell as any).activeRuns.set("rf5c-1", fakeRun);

    const startedAt = Date.now();
    await shell.stop();
    assert.ok(Date.now() - startedAt < 25, "stop should resolve from terminal status instead of waiting on a timeout");
  });
});

// ── RF2: child protocol runs are routable ────────────────────────────

describe("RF2: child run registration", () => {
  test("RF2a: invoked child receives inbound messages via shell dispatch", async () => {
    // Parent protocol: init → invoke(ChildProto) → terminal
    // Child protocol:  init → send(Ping) → recv(Pong) → terminal
    //
    // The child's recv(Pong) should be routable via AgentShellImpl.dispatchMessage

    const parentGraph = buildGraph({
      protocolName: "ParentProto",
      role: "orchestrator",
      states: [
        { id: "init", data: { kind: "initial" } },
        { id: "inv1", data: { kind: "invoke", protocolName: "ChildProto", input: "{}", resultTarget: "$ctx.childResult" } },
        { id: "end", data: { kind: "terminal", status: "completed" } },
      ],
    });

    const childGraph = buildGraph({
      protocolName: "ChildProto",
      role: "caller",
      states: [
        { id: "init", data: { kind: "initial" } },
        { id: "send1", data: { kind: "send", to: "responder", messageName: "Ping" } },
        { id: "recv1", data: { kind: "receive", from: "responder", messageName: "Pong" } },
        { id: "end", data: { kind: "terminal", status: "completed" } },
      ],
      participants: [
        { name: "caller", cardinality: "single" },
        { name: "responder", cardinality: "single" },
      ],
    });

    const behavior: AgentBehavior = {
      async handle(event: ProtocolEvent): Promise<AgentResponse> {
        if (event.type === "pre_send_action" || event.type === "post_receive_action") {
          return { type: "ctx_update", ctx: event.ctx };
        }
        if (event.type === "action") {
          return { type: "ctx_update", ctx: event.ctx };
        }
        return { type: "noop" };
      },
    };

    const sent: MessageEnvelope[] = [];
    const transport = makeTransport("OrcAgent", sent);

    const agentIR = {
      name: "OrcAgent",
      plays: [
        { protocolName: "ParentProto", roleName: "orchestrator" },
        { protocolName: "ChildProto", roleName: "caller" },
      ],
      lifecycleHandlers: [],
      initAction: undefined,
    };

    const shellConfig: AgentShellConfig = {
      agentName: "OrcAgent",
      roleName: "orchestrator",
      agentIR,
      graphs: new Map([
        ["ParentProto.orchestrator", parentGraph],
        ["ChildProto.caller", childGraph],
      ]),
      transport,
      roleToAgent: makeBindings({
        "ParentProto.orchestrator": "OrcAgent",
        "ChildProto.caller": "OrcAgent",
        "ChildProto.responder": "ExtAgent",
      }),
    };

    const shell = new AgentShellImpl(shellConfig);
    shell.attachBehavior(behavior);
    await shell.start();

    shell.triggerProtocol({
      instanceId: "rf2a-parent",
      protocolName: "ParentProto",
      input: {},
      roleToAgent: {},
    });

    // Wait for child to send Ping
    await new Promise(r => setTimeout(r, 100));

    const ping = sent.find(e => e.messageName === "Ping");
    assert.ok(ping, "child should have sent Ping");

    // Reply Pong to the child's instanceId (should be routable)
    const childInstanceId = ping!.instanceId;
    shell.dispatchMessage(createMessageEnvelope(
      childInstanceId, "ChildProto",
      "ExtAgent", "responder",
      "OrcAgent", "caller",
      "Pong", { result: "ok" },
    ));

    await shell.waitForCompletion(1, 3000);

    assert.equal(shell.getInstances().get("rf2a-parent")!.getStatus(), "completed",
      "parent should complete after child invoke finishes");

    await shell.stop();
  });
});

// ── F4: Shell attach/detach → RC publication model ────────────────────

const __dirname_f4 = dirname(fileURLToPath(import.meta.url));
const F4_FIXTURES = join(__dirname_f4, "..", "..", "..", "..", "examples", "out", "14-ts-only-demo");

function loadRoleIR_f4(dir: string, agentName: string): RoleIR {
  const thin: ThinAgentIR = JSON.parse(readFileSync(join(dir, `${agentName}.agent.json`), "utf8"));
  return JSON.parse(readFileSync(join(dir, thin.roleFile), "utf8"));
}

function loadGraph_f4(dir: string, proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(dir, `${proto}.${role}.ir.json`), "utf8"));
}

function createRcWithAgent(): { rc: ReagentController; shell: AgentShellImpl } {
  const factory = new ManagedBehaviorFactory();
  const rc = new ReagentController({ nodeId: "f4-node", behaviorFactory: factory });
  const roleIR = loadRoleIR_f4(F4_FIXTURES, "ClientAgent");
  const graphs = new Map<string, IRGraph>([
    ["TsDemo.client", loadGraph_f4(F4_FIXTURES, "TsDemo", "client")],
  ]);
  rc.deployAgentTemplate("ClientAgent", roleIR, graphs);
  rc.createAgentFromTemplate("ClientAgent");
  const shell = rc.getAgent("ClientAgent")!;
  return { rc, shell };
}

describe("F4: Shell status → RC publication", () => {
  test("RF4a: detachBehavior on a live shell updates AgentRecord to detached", async () => {
    const { rc, shell } = createRcWithAgent();

    const before = rc.getAgentRecord("ClientAgent")!;
    assert.equal(before.lifecycle, "runtime_attached");
    assert.ok(before.runtime);

    shell.detachBehavior();

    const after = rc.getAgentRecord("ClientAgent")!;
    assert.equal(after.lifecycle, "detached", "record should reflect detached status");
    assert.equal(after.runtime?.lifecycle, "detached", "runtime ref should be detached");
    assert.equal(shell.status, "detached");
    assert.equal(shell.hasBehavior(), false);

    await rc.stop();
  });

  test("RF4b: re-attach after detach restores runtime_attached", async () => {
    const { rc, shell } = createRcWithAgent();

    shell.detachBehavior();
    assert.equal(rc.getAgentRecord("ClientAgent")!.lifecycle, "detached");

    const newBehavior: AgentBehavior = {
      async handle() { return { type: "ctx_update", updates: {} }; },
    };
    shell.attachBehavior(newBehavior);

    const after = rc.getAgentRecord("ClientAgent")!;
    assert.equal(after.lifecycle, "runtime_attached",
      "record should return to runtime_attached after re-attach");
    assert.equal(after.runtime?.lifecycle, "attached");
    assert.equal(shell.status, "attached");
    assert.ok(shell.hasBehavior());

    await rc.stop();
  });

  test("RF4c: detachAgentRuntime clears status callback — no stale updates", async () => {
    const { rc, shell } = createRcWithAgent();

    rc.detachAgentRuntime("ClientAgent");
    const recordAfterDetach = rc.getAgentRecord("ClientAgent")!;
    assert.equal(recordAfterDetach.lifecycle, "detached");

    const newBehavior: AgentBehavior = {
      async handle() { return { type: "ctx_update", updates: {} }; },
    };
    shell.attachBehavior(newBehavior);

    const recordStillDetached = rc.getAgentRecord("ClientAgent")!;
    assert.equal(recordStillDetached.lifecycle, "detached",
      "callback was cleared — shell attach should NOT update the orphaned record");

    await rc.stop();
  });
});
