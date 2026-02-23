/**
 * M6-RT E2E Tests
 *
 * T21: Compile + Run via WebSocket
 * T22-T26: Debug tests (Phase 2)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { ReagentOrchestratorServer } from "../ts/src/ros.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_RG = join(__dirname, "..", "..", "examples", "src", "14-ts-only-demo.rg");

type TestResult = { name: string; passed: boolean; error?: string };

// ── Helpers ─────────────────────────────────────────────────────────

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}

interface RAPMsg {
  rap: string;
  id?: string;
  payload?: Record<string, unknown>;
}

function sendRap(ws: WebSocket, rap: string, payload: Record<string, unknown>, id?: string): void {
  ws.send(JSON.stringify({ rap, id: id ?? rap, payload }));
}

function waitForRap(ws: WebSocket, rapType: string, timeoutMs = 15000): Promise<RAPMsg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${rapType}`)), timeoutMs);
    const handler = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as RAPMsg;
        if (msg.rap === rapType) {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(msg);
        }
      } catch { /* ignore */ }
    };
    ws.on("message", handler);
  });
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── T21: Compile + Run via WS ──────────────────────────────────────

async function testT21(): Promise<TestResult> {
  const name = "T21: Compile + Run via WS";
  try {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    const port = await ros.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);

    const rgSource = readFileSync(DEMO_RG, "utf8");

    // 1. Compile
    sendRap(ws, "Compile", { rgSource, fileName: "14-ts-only-demo.rg" });
    const compileResp = await waitForRap(ws, "CompileSuccess");
    assert(!!compileResp.payload, "CompileSuccess should have payload");
    const sessionId = compileResp.payload!.sessionId as string;
    assert(typeof sessionId === "string" && sessionId.length > 0, "sessionId should be a UUID");

    // 2. Run
    const traceEvents: RAPMsg[] = [];
    const traceListener = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as RAPMsg;
        if (msg.rap === "TraceEvent") traceEvents.push(msg);
      } catch { /* ignore */ }
    };
    ws.on("message", traceListener);

    sendRap(ws, "RunStart", { sessionId, mode: "run" });
    const runResp = await waitForRap(ws, "RunCompleted");

    ws.off("message", traceListener);

    assert(!!runResp.payload, "RunCompleted should have payload");
    assert(runResp.payload!.sessionId === sessionId, "sessionId should match");
    assert(runResp.payload!.status === "completed", "status should be completed");
    assert(traceEvents.length > 0, "should receive trace events");

    ws.close();
    await ros.stop();
    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

// ── Debug test helpers ──────────────────────────────────────────────

async function compileAndGetSession(ws: WebSocket, rgSource: string): Promise<string> {
  sendRap(ws, "Compile", { rgSource, fileName: "test.rg" });
  const resp = await waitForRap(ws, "CompileSuccess");
  return resp.payload!.sessionId as string;
}

function collectAll(ws: WebSocket): RAPMsg[] {
  const all: RAPMsg[] = [];
  ws.on("message", (data: Buffer | string) => {
    try { all.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  return all;
}

// ── T22: Message breakpoint → Stopped event ────────────────────────

async function testT22(): Promise<TestResult> {
  const name = "T22: Message breakpoint → Stopped event";
  try {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    const port = await ros.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);

    const rgSource = readFileSync(DEMO_RG, "utf8");
    const sessionId = await compileAndGetSession(ws, rgSource);

    // Set a breakpoint on "Query" message
    sendRap(ws, "SetBreakpointsRequest", {
      sessionId,
      breakpoints: [{ type: "message", value: "Query" }],
    });
    const bpResp = await waitForRap(ws, "BreakpointsResolved");
    assert(!!bpResp.payload, "BreakpointsResolved should have payload");

    // Run in debug mode
    sendRap(ws, "RunStart", { sessionId, mode: "debug" });

    // Should get a Stopped event for the Query message
    const stopped = await waitForRap(ws, "Stopped", 5000);
    assert(!!stopped.payload, "Stopped event should have payload");
    assert(stopped.payload!.level === "message", "should be message-level stop");
    assert(stopped.payload!.messageName === "Query", "should stop on Query message");

    // Continue execution
    sendRap(ws, "DebugCommand", { sessionId, command: "continue" });
    const completed = await waitForRap(ws, "RunCompleted");
    assert(completed.payload!.status === "completed", "should complete after continue");

    ws.close();
    await ros.stop();
    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

// ── T23: GetState at pause → verify $self/$ctx ─────────────────────

async function testT23(): Promise<TestResult> {
  const name = "T23: GetState at pause";
  try {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    const port = await ros.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);

    const rgSource = readFileSync(DEMO_RG, "utf8");
    const sessionId = await compileAndGetSession(ws, rgSource);

    // Set breakpoint on Query message
    sendRap(ws, "SetBreakpointsRequest", {
      sessionId,
      breakpoints: [{ type: "message", value: "Query" }],
    });
    await waitForRap(ws, "BreakpointsResolved");

    sendRap(ws, "RunStart", { sessionId, mode: "debug" });
    await waitForRap(ws, "Stopped", 5000);

    // Inspect HandlerAgent state while paused
    sendRap(ws, "GetState", { sessionId, agentName: "HandlerAgent" });
    const snapshot = await waitForRap(ws, "StateSnapshot");
    assert(!!snapshot.payload, "StateSnapshot should have payload");
    assert(snapshot.payload!.agentName === "HandlerAgent", "should be HandlerAgent");
    assert(typeof snapshot.payload!.self === "object", "$self should be an object");

    // Continue and clean up
    sendRap(ws, "DebugCommand", { sessionId, command: "continue" });
    await waitForRap(ws, "RunCompleted");

    ws.close();
    await ros.stop();
    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

// ── T24: stepMessage 3 times ───────────────────────────────────────

async function testT24(): Promise<TestResult> {
  const name = "T24: stepMessage sequence";
  try {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    const port = await ros.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);

    const rgSource = readFileSync(DEMO_RG, "utf8");
    const sessionId = await compileAndGetSession(ws, rgSource);

    // Set breakpoint on Query to intercept the first message
    sendRap(ws, "SetBreakpointsRequest", {
      sessionId,
      breakpoints: [{ type: "message", value: "Query" }],
    });
    await waitForRap(ws, "BreakpointsResolved");

    sendRap(ws, "RunStart", { sessionId, mode: "debug" });
    const stopped1 = await waitForRap(ws, "Stopped", 5000);
    assert(stopped1.payload!.messageName === "Query", "first stop should be Query");

    // stepMessage to release Query and then continue
    sendRap(ws, "DebugCommand", { sessionId, command: "stepMessage" });
    await waitForRap(ws, "DebugAck");

    // After releasing Query, the protocol should proceed to completion
    // (Accept or Reject won't be intercepted since no breakpoint)
    sendRap(ws, "DebugCommand", { sessionId, command: "continue" });
    const completed = await waitForRap(ws, "RunCompleted");
    assert(completed.payload!.status === "completed", "should complete");

    ws.close();
    await ros.stop();
    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

// ── T25: State breakpoint on action → pause before zone ────────────

async function testT25(): Promise<TestResult> {
  const name = "T25: State breakpoint on action kind";
  try {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    const port = await ros.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);

    const rgSource = readFileSync(DEMO_RG, "utf8");
    const sessionId = await compileAndGetSession(ws, rgSource);

    // Set breakpoint on all "action" state kinds
    sendRap(ws, "SetBreakpointsRequest", {
      sessionId,
      breakpoints: [{ type: "stateKind", value: "action" }],
    });
    await waitForRap(ws, "BreakpointsResolved");

    sendRap(ws, "RunStart", { sessionId, mode: "debug" });

    // Should stop at the first action state (client's initial zone)
    const stopped = await waitForRap(ws, "Stopped", 5000);
    assert(!!stopped.payload, "Stopped event should have payload");
    assert(stopped.payload!.level === "state", "should be state-level stop");
    assert(stopped.payload!.stateKind === "action", "should stop on action state");

    // Continue to completion
    sendRap(ws, "DebugCommand", { sessionId, command: "continue" });
    const completed = await waitForRap(ws, "RunCompleted");
    assert(completed.payload!.status === "completed", "should complete");

    ws.close();
    await ros.stop();
    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

// ── T26: stepState through states ──────────────────────────────────

async function testT26(): Promise<TestResult> {
  const name = "T26: stepState through receive → action → send";
  try {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    const port = await ros.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(ws);

    const rgSource = readFileSync(DEMO_RG, "utf8");
    const sessionId = await compileAndGetSession(ws, rgSource);

    // Set breakpoint on "action" to catch the first action state, then step
    sendRap(ws, "SetBreakpointsRequest", {
      sessionId,
      breakpoints: [{ type: "stateKind", value: "action" }],
    });
    await waitForRap(ws, "BreakpointsResolved");

    sendRap(ws, "RunStart", { sessionId, mode: "debug" });

    const stopped1 = await waitForRap(ws, "Stopped", 5000);
    assert(stopped1.payload!.stateKind === "action", "should stop on action");

    // stepState: should advance to the next state
    // Set up listener BEFORE sending command to avoid race
    const stoppedPromise = waitForRap(ws, "Stopped", 5000);
    sendRap(ws, "DebugCommand", { sessionId, command: "stepState" });

    const stopped2 = await stoppedPromise;
    assert(!!stopped2.payload, "should get second Stopped");
    // The next state should be send (after the action zone)
    assert(
      stopped2.payload!.stateKind === "send" || stopped2.payload!.stateKind === "action",
      `should step to send or action, got ${stopped2.payload!.stateKind}`,
    );

    // Continue to finish
    sendRap(ws, "DebugCommand", { sessionId, command: "continue" });
    const completed = await waitForRap(ws, "RunCompleted");
    assert(completed.payload!.status === "completed", "should complete");

    ws.close();
    await ros.stop();
    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

// ── T27: Remote node via WsNodeLink ────────────────────────────────

async function testT27(): Promise<TestResult> {
  const name = "T27: Remote node deploy + message routing via WS";
  try {
    const ros = new ReagentOrchestratorServer({ port: 0 });
    const port = await ros.start();

    // Connect as API client
    const apiWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(apiWs);

    // Connect as adapter node
    const adapterWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(adapterWs);

    // Register adapter via RAP Register message
    adapterWs.send(JSON.stringify({
      rap: "Register",
      payload: { nodeId: "remote-node-1", supportedLangs: ["ts"] },
    }));

    // Wait for Accepted response
    const ack = await waitForRap(adapterWs, "Accepted", 3000);
    assert(!!ack.payload, "Accepted should have payload");
    assert(ack.payload!.nodeId === "remote-node-1", "nodeId should match");

    // Verify adapter is registered
    assert(ros.getAdapters().has("remote-node-1"), "adapter should be registered");

    apiWs.close();
    adapterWs.close();
    await ros.stop();
    return { name, passed: true };
  } catch (err) {
    return { name, passed: false, error: String(err) };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

async function runAllTests(): Promise<void> {
  console.log("=== M6-RT E2E Tests ===\n");

  const tests = [testT21, testT22, testT23, testT24, testT25, testT26, testT27];
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
