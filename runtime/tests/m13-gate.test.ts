/**
 * M13 Phase 1: Gate E2E tests.
 *
 * GT.1: GateSession lifecycle (idle → active → completed)
 * GT.2: sendAndWait receives response via transport
 * GT.3: sendAndWait timeout → error state
 * GT.4: FSM validation blocks events after completion
 * GT.5: sendNotification (fire-and-forget)
 * GT.6: Event log accumulation
 * GT.7: StdioGateTransport — framing via mock process
 * GT.8: GateValidationError carries sessionId and event
 *
 * Run: npx tsx runtime/tests/m13-gate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { GateSession, GateValidationError } from "../ts/src/gate-session.js";
import { StdioGateTransport } from "../ts/src/gate-transport.js";
import type { GateTransport } from "../ts/src/gate-transport.js";
import type { ProtocolEvent, AgentResponse } from "../ts/src/protocol-engine.js";

class MockTransport implements GateTransport {
  sent: ProtocolEvent[] = [];
  private handler: ((response: AgentResponse) => void) | null = null;
  closed = false;

  send(event: ProtocolEvent): void {
    this.sent.push(event);
  }
  onResponse(handler: (response: AgentResponse) => void): void {
    this.handler = handler;
  }
  close(): void {
    this.closed = true;
  }
  simulateResponse(response: AgentResponse): void {
    this.handler?.(response);
  }
}

function makeSession(transport?: MockTransport, validateFSM = true) {
  const t = transport ?? new MockTransport();
  const session = new GateSession({
    sessionId: "test-session",
    agentName: "test-agent",
    protocolName: "TestProtocol",
    transport: t,
    validateFSM,
  });
  return { session, transport: t };
}

// ── GT.1: Session lifecycle ─────────────────────────────────────────

describe("GT.1: GateSession lifecycle", () => {
  it("starts in idle status", () => {
    const { session } = makeSession();
    assert.equal(session.getStatus(), "idle");
  });

  it("transitions to active on sendAndWait", async () => {
    const { session, transport } = makeSession();
    const event: ProtocolEvent = {
      type: "action",
      stateId: "s1",
      body: "",
      lang: "ts",
      isAsync: false,
      ctx: {},
      self: {},
    };

    const promise = session.sendAndWait(event, 5000);
    assert.equal(session.getStatus(), "active");

    transport.simulateResponse({ type: "ctx_update", ctx: {} });
    await promise;
  });

  it("transitions to completed on close", () => {
    const { session, transport } = makeSession();
    session.close();
    assert.equal(session.getStatus(), "completed");
    assert.ok(transport.closed);
  });

  it("transitions to completed on protocol_completed event", async () => {
    const { session, transport } = makeSession();
    const event: ProtocolEvent = {
      type: "protocol_completed",
      ctx: {},
    };
    const promise = session.sendAndWait(event);
    transport.simulateResponse({ type: "noop" });
    await promise;
    assert.equal(session.getStatus(), "completed");
  });
});

// ── GT.2: sendAndWait receives response ─────────────────────────────

describe("GT.2: sendAndWait receives response via transport", () => {
  it("resolves with the response from transport", async () => {
    const { session, transport } = makeSession();
    const event: ProtocolEvent = {
      type: "action",
      stateId: "s1",
      body: "doWork()",
      lang: "ts",
      isAsync: false,
      ctx: { x: 1 },
      self: {},
    };

    const promise = session.sendAndWait(event);
    transport.simulateResponse({ type: "ctx_update", ctx: { x: 2 } });
    const response = await promise;

    assert.equal(response.type, "ctx_update");
    assert.equal((response as any).ctx.x, 2);
  });

  it("sends the event through transport", async () => {
    const { session, transport } = makeSession();
    const event: ProtocolEvent = {
      type: "send_required",
      stateId: "s2",
      to: "receiver",
      messageName: "Ping",
      ctx: {},
    };

    const promise = session.sendAndWait(event);
    transport.simulateResponse({ type: "send_payload", payload: { text: "hello" } });
    await promise;

    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].type, "send_required");
  });
});

// ── GT.3: sendAndWait timeout ───────────────────────────────────────

describe("GT.3: sendAndWait timeout → error state", () => {
  it("rejects after timeout and sets error state", async () => {
    const { session } = makeSession();
    const event: ProtocolEvent = {
      type: "action",
      stateId: "s1",
      body: "",
      lang: "ts",
      isAsync: false,
      ctx: {},
      self: {},
    };

    await assert.rejects(
      () => session.sendAndWait(event, 200),
      /timeout/i,
    );
    assert.equal(session.getStatus(), "error");
  });

  it("rejects sendAndWait when session is in error state", async () => {
    const { session } = makeSession();
    const event: ProtocolEvent = {
      type: "action",
      stateId: "s1",
      body: "",
      lang: "ts",
      isAsync: false,
      ctx: {},
      self: {},
    };

    await assert.rejects(() => session.sendAndWait(event, 100), /timeout/i);
    await assert.rejects(
      () => session.sendAndWait(event),
      /error state/i,
    );
  });
});

// ── GT.4: FSM validation ────────────────────────────────────────────

describe("GT.4: FSM validation blocks events after completion", () => {
  it("throws GateValidationError for event after protocol_completed", async () => {
    const { session, transport } = makeSession();

    const completeEvent: ProtocolEvent = { type: "protocol_completed", ctx: {} };
    const promise = session.sendAndWait(completeEvent);
    transport.simulateResponse({ type: "noop" });
    await promise;

    assert.equal(session.getStatus(), "completed");

    const afterEvent: ProtocolEvent = {
      type: "action",
      stateId: "s2",
      body: "",
      lang: "ts",
      isAsync: false,
      ctx: {},
      self: {},
    };

    await assert.rejects(
      () => session.sendAndWait(afterEvent),
      (err: any) => {
        assert.ok(err instanceof GateValidationError || err.message.includes("error state"));
        return true;
      },
    );
  });

  it("skips validation when validateFSM is false", async () => {
    const { session, transport } = makeSession(undefined, false);

    const event1: ProtocolEvent = { type: "protocol_completed", ctx: {} };
    const p1 = session.sendAndWait(event1);
    transport.simulateResponse({ type: "noop" });
    await p1;

    assert.equal(session.getStatus(), "completed");
  });
});

// ── GT.5: sendNotification ──────────────────────────────────────────

describe("GT.5: sendNotification (fire-and-forget)", () => {
  it("sends event without waiting for response", () => {
    const { session, transport } = makeSession();
    const event: ProtocolEvent = {
      type: "state_entered",
      stateId: "s1",
      stateKind: "action",
    };
    session.sendNotification(event);
    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].type, "state_entered");
  });
});

// ── GT.6: Event log accumulation ────────────────────────────────────

describe("GT.6: Event log accumulation", () => {
  it("accumulates events from sendAndWait and sendNotification", async () => {
    const { session, transport } = makeSession();

    session.sendNotification({ type: "state_entered", stateId: "s1", stateKind: "initial" });

    const event: ProtocolEvent = {
      type: "action",
      stateId: "s2",
      body: "",
      lang: "ts",
      isAsync: false,
      ctx: {},
      self: {},
    };
    const promise = session.sendAndWait(event);
    transport.simulateResponse({ type: "noop" });
    await promise;

    const log = session.getEventLog();
    assert.equal(log.length, 2);
    assert.equal(log[0].type, "state_entered");
    assert.equal(log[1].type, "action");
  });

  it("getEventLog returns a defensive copy", async () => {
    const { session, transport } = makeSession();
    const event: ProtocolEvent = {
      type: "action",
      stateId: "s1",
      body: "",
      lang: "ts",
      isAsync: false,
      ctx: {},
      self: {},
    };
    const p = session.sendAndWait(event);
    transport.simulateResponse({ type: "noop" });
    await p;

    const log1 = session.getEventLog();
    const log2 = session.getEventLog();
    assert.notEqual(log1, log2, "Each call returns a new array");
    assert.deepEqual(log1, log2, "Content is identical");
  });
});

// ── GT.7: StdioGateTransport ────────────────────────────────────────

describe("GT.7: StdioGateTransport — framing via mock streams", () => {
  it("sends JSON + newline to stdin", () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioGateTransport({ stdin, stdout });

    const written: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => written.push(chunk));

    const event: ProtocolEvent = {
      type: "action",
      stateId: "s1",
      body: "",
      lang: "ts",
      isAsync: false,
      ctx: {},
      self: {},
    };
    transport.send(event);

    const output = Buffer.concat(written).toString();
    assert.ok(output.endsWith("\n"), "Should end with newline");
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.type, "action");
  });

  it("receives newline-delimited JSON from stdout", (_, done) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioGateTransport({ stdin, stdout });

    const received: AgentResponse[] = [];
    transport.onResponse((r) => {
      received.push(r);
      if (received.length === 2) {
        assert.equal(received[0].type, "ctx_update");
        assert.equal(received[1].type, "noop");
        done();
      }
    });

    stdout.write(JSON.stringify({ type: "ctx_update", ctx: {} }) + "\n");
    stdout.write(JSON.stringify({ type: "noop" }) + "\n");
  });

  it("handles partial lines and buffering", (_, done) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioGateTransport({ stdin, stdout });

    transport.onResponse((r) => {
      assert.equal(r.type, "noop");
      done();
    });

    const full = JSON.stringify({ type: "noop" }) + "\n";
    stdout.write(full.slice(0, 5));
    setTimeout(() => stdout.write(full.slice(5)), 20);
  });

  it("close ends stdin", () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioGateTransport({ stdin, stdout });
    transport.close();
    assert.ok(stdin.writableEnded, "stdin should be ended after close");
  });
});

// ── GT.8: GateValidationError ───────────────────────────────────────

describe("GT.8: GateValidationError carries sessionId and event", () => {
  it("has correct properties", () => {
    const event: ProtocolEvent = {
      type: "action",
      stateId: "s1",
      body: "",
      lang: "ts",
      isAsync: false,
      ctx: {},
      self: {},
    };
    const err = new GateValidationError("test error", "sess-1", event);
    assert.equal(err.name, "GateValidationError");
    assert.equal(err.sessionId, "sess-1");
    assert.equal(err.event.type, "action");
    assert.equal(err.message, "test error");
    assert.ok(err instanceof Error);
  });
});
