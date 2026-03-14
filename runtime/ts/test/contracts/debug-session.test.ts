/**
 * M13 Phase 7: Debug unit tests.
 *
 * DB.1: DebugController session lifecycle (create, destroy, idempotent create)
 * DB.2: Breakpoint resolution (message, stateId, stateKind, sourceLine + snapping)
 * DB.3: Step commands dispatch without error
 * DB.4: Resolve gate — continue releases pending gates
 *
 * Run: npx tsx runtime/ts/test/contracts/debug-session.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { DebugController } from "../../src/admin/debug-controller.js";
import type { DebugStoppedEvent, Breakpoint } from "../../src/admin/debug-controller.js";
import type { SourceMap } from "../../src/admin/session.js";

const SESSION = "test-session";

const SAMPLE_SOURCE_MAP: SourceMap = {
  entries: [
    { stateId: "send_3", file: "auction.rg", line: 10, column: 0 },
    { stateId: "recv_5", file: "auction.rg", line: 15, column: 0 },
    { stateId: "act_7", file: "auction.rg", line: 20, column: 0 },
    { stateId: "send_8", file: "other.rg", line: 5, column: 0 },
  ],
};

// ── DB.1: Session lifecycle ─────────────────────────────────────────

describe("DB.1: Session lifecycle", () => {
  it("createSession returns interceptorFn, advanceHook, resolveHook", () => {
    const dc = new DebugController();
    const result = dc.createSession(SESSION);
    assert.ok(typeof result.interceptorFn === "function");
    assert.ok(typeof result.advanceHook === "function");
    assert.ok(typeof result.resolveHook === "function");
  });

  it("createSession is idempotent — second call also returns instruments", () => {
    const dc = new DebugController();
    const r1 = dc.createSession(SESSION);
    const r2 = dc.createSession(SESSION);
    assert.ok(typeof r2.interceptorFn === "function");
    assert.ok(typeof r2.advanceHook === "function");
    assert.ok(typeof r2.resolveHook === "function");
  });

  it("destroySession cleans up, subsequent calls return empty", () => {
    const dc = new DebugController();
    dc.createSession(SESSION);
    dc.destroySession(SESSION);
    const held = dc.getHeldMessages(SESSION);
    assert.deepEqual(held, []);
  });

  it("destroySession on non-existent session does not throw", () => {
    const dc = new DebugController();
    dc.destroySession("nonexistent");
  });

  it("updateSourceMap lazily creates session", () => {
    const dc = new DebugController();
    dc.updateSourceMap(SESSION, SAMPLE_SOURCE_MAP);
    const resolved = dc.setBreakpoints(SESSION, [
      { type: "sourceLine", value: "", file: "auction.rg", line: 10 },
    ]);
    assert.ok(resolved[0].resolved);
    dc.destroySession(SESSION);
  });
});

// ── DB.2: Breakpoint resolution ─────────────────────────────────────

describe("DB.2: Breakpoint resolution", () => {
  let dc: DebugController;

  beforeEach(() => {
    dc = new DebugController();
    dc.createSession(SESSION, SAMPLE_SOURCE_MAP);
  });

  it("resolves message breakpoint", () => {
    const bps: Breakpoint[] = [{ type: "message", value: "TaskRequest" }];
    const resolved = dc.setBreakpoints(SESSION, bps);
    assert.equal(resolved.length, 1);
    assert.ok(resolved[0].resolved);
  });

  it("resolves stateId breakpoint with resolvedStateIds", () => {
    const bps: Breakpoint[] = [{ type: "stateId", value: "send_3" }];
    const resolved = dc.setBreakpoints(SESSION, bps);
    assert.equal(resolved.length, 1);
    assert.ok(resolved[0].resolved);
    assert.deepEqual(resolved[0].resolvedStateIds, ["send_3"]);
  });

  it("resolves stateKind breakpoint", () => {
    const bps: Breakpoint[] = [{ type: "stateKind", value: "send" }];
    const resolved = dc.setBreakpoints(SESSION, bps);
    assert.equal(resolved.length, 1);
    assert.ok(resolved[0].resolved);
  });

  it("resolves exact sourceLine breakpoint", () => {
    const bps: Breakpoint[] = [
      { type: "sourceLine", value: "", file: "auction.rg", line: 10 },
    ];
    const resolved = dc.setBreakpoints(SESSION, bps);
    assert.equal(resolved.length, 1);
    assert.ok(resolved[0].resolved);
    assert.deepEqual(resolved[0].resolvedStateIds, ["send_3"]);
  });

  it("resolves sourceLine with nearest-line snapping (±5)", () => {
    const bps: Breakpoint[] = [
      { type: "sourceLine", value: "", file: "auction.rg", line: 12 },
    ];
    const resolved = dc.setBreakpoints(SESSION, bps);
    assert.equal(resolved.length, 1);
    assert.ok(resolved[0].resolved, "Should snap to nearest line within ±5");
    assert.ok(resolved[0].resolvedStateIds!.length > 0);
  });

  it("sourceLine too far from any entry is unresolved", () => {
    const bps: Breakpoint[] = [
      { type: "sourceLine", value: "", file: "auction.rg", line: 100 },
    ];
    const resolved = dc.setBreakpoints(SESSION, bps);
    assert.equal(resolved.length, 1);
    assert.ok(!resolved[0].resolved);
  });

  it("sourceLine without sourceMap is unresolved", () => {
    const dc2 = new DebugController();
    dc2.createSession("no-map");
    const bps: Breakpoint[] = [
      { type: "sourceLine", value: "", file: "auction.rg", line: 10 },
    ];
    const resolved = dc2.setBreakpoints("no-map", bps);
    assert.ok(!resolved[0].resolved);
    dc2.destroySession("no-map");
  });

  it("resolves multiple breakpoints at once", () => {
    const bps: Breakpoint[] = [
      { type: "message", value: "Bid" },
      { type: "stateId", value: "recv_5" },
      { type: "sourceLine", value: "", file: "auction.rg", line: 20 },
    ];
    const resolved = dc.setBreakpoints(SESSION, bps);
    assert.equal(resolved.length, 3);
    assert.ok(resolved.every(r => r.resolved));
  });
});

// ── DB.3: Step commands ─────────────────────────────────────────────

describe("DB.3: Step commands dispatch", () => {
  it("stepMessage, stepState, stepOver, continue don't throw", () => {
    const dc = new DebugController();
    dc.createSession(SESSION);
    dc.stepMessage(SESSION);
    dc.stepState(SESSION);
    dc.stepOver(SESSION);
    dc.continue(SESSION);
    dc.destroySession(SESSION);
  });

  it("step commands on non-existent session don't throw", () => {
    const dc = new DebugController();
    dc.stepMessage("none");
    dc.stepState("none");
    dc.stepOver("none");
    dc.continue("none");
  });
});

// ── DB.4: Resolve gate ──────────────────────────────────────────────

describe("DB.4: Resolve gate — continue releases pending gates", () => {
  it("resolveHook blocks until continue is called", async () => {
    const dc = new DebugController();
    const stoppedEvents: DebugStoppedEvent[] = [];
    dc.setOnStopped((event) => stoppedEvents.push(event));

    const { resolveHook } = dc.createSession(SESSION);

    let resolved = false;
    const hookPromise = resolveHook({
      role: "buyer",
      candidates: ["a1", "a2"],
      selected: ["a1"],
      pipelineSummary: "test",
    }).then(() => { resolved = true; });

    await new Promise(r => setTimeout(r, 50));

    assert.ok(!resolved, "resolveHook should still be blocking");
    assert.equal(stoppedEvents.length, 1);
    assert.equal(stoppedEvents[0].level, "resolve");
    assert.equal(stoppedEvents[0].sessionId, SESSION);

    dc.continue(SESSION);
    await hookPromise;
    assert.ok(resolved, "resolveHook should be released after continue");

    dc.destroySession(SESSION);
  });

  it("destroySession releases pending resolve gates", async () => {
    const dc = new DebugController();
    const { resolveHook } = dc.createSession(SESSION);

    let resolved = false;
    const hookPromise = resolveHook({
      role: "seller",
      candidates: ["a1"],
      selected: ["a1"],
      pipelineSummary: "test",
    }).then(() => { resolved = true; });

    await new Promise(r => setTimeout(r, 50));
    assert.ok(!resolved);

    dc.destroySession(SESSION);
    await hookPromise;
    assert.ok(resolved, "destroySession should release gates");
  });
});
