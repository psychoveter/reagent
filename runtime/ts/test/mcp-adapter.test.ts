/**
 * Smoke tests for McpAgentAdapter and AsyncQueue.
 *
 * Run: npx tsx test/mcp-adapter.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsyncQueue } from "../src/gate/async-queue.js";
import { McpAgentAdapter } from "../src/mcp/mcp-agent-adapter.js";
import type { ProtocolEvent, AgentResponse } from "../src/core/protocol-engine.js";

describe("AsyncQueue", () => {
  it("push + drain returns items immediately when buffer non-empty", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    const result = await q.drain(1000, 10);
    assert.deepStrictEqual(result, [1, 2]);
  });

  it("drain blocks until push", async () => {
    const q = new AsyncQueue<string>();
    const drainPromise = q.drain(5000, 1);

    setTimeout(() => q.push("hello"), 50);
    const result = await drainPromise;
    assert.deepStrictEqual(result, ["hello"]);
  });

  it("drain returns empty on timeout", async () => {
    const q = new AsyncQueue<string>();
    const result = await q.drain(50, 1);
    assert.deepStrictEqual(result, []);
  });

  it("respects max parameter", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    const result = await q.drain(1000, 2);
    assert.deepStrictEqual(result, [1, 2]);
    assert.strictEqual(q.length, 1);
  });
});

describe("McpAgentAdapter", () => {
  it("register / unregister lifecycle", () => {
    const adapter = new McpAgentAdapter("test-agent");
    assert.strictEqual(adapter.isRegistered(), false);

    const result = adapter.register("test-agent", ["reviewer", "researcher"]);
    assert.strictEqual(result.agentId, "test-agent");
    assert.deepStrictEqual(result.registeredRoles, ["reviewer", "researcher"]);
    assert.strictEqual(adapter.isRegistered(), true);

    adapter.unregister();
    assert.strictEqual(adapter.isRegistered(), false);
  });

  it("handle() queues event, waitForEvents() returns it", async () => {
    const adapter = new McpAgentAdapter("test-agent");
    adapter.register(["worker"]);
    adapter.setCurrentInstance("inst-1", "TestProto", "worker");

    const event: ProtocolEvent = {
      type: "action",
      stateId: "s1",
      body: "$ctx.result = 42",
      lang: "ts",
      isAsync: false,
      ctx: { input: "hello" },
      self: {},
    };

    const handlePromise = adapter.handle(event);

    const events = await adapter.waitForEvents(5000, 1);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].instanceId, "inst-1");
    assert.strictEqual(events[0].protocolName, "TestProto");
    assert.strictEqual(events[0].role, "worker");
    assert.strictEqual(events[0].event.type, "action");

    const response: AgentResponse = {
      type: "ctx_update",
      ctx: { input: "hello", result: 42 },
    };
    const ok = adapter.deliverResponse("inst-1", response);
    assert.strictEqual(ok, true);

    const returned = await handlePromise;
    assert.strictEqual(returned.type, "ctx_update");
    assert.strictEqual((returned as any).ctx.result, 42);
  });

  it("waitForEvents blocks and unblocks on handle()", async () => {
    const adapter = new McpAgentAdapter("test-agent");
    adapter.register(["worker"]);
    adapter.setCurrentInstance("inst-2", "Proto2", "worker");

    const waitPromise = adapter.waitForEvents(5000, 1);

    setTimeout(async () => {
      const event: ProtocolEvent = {
        type: "pre_send_action",
        stateId: "s2",
        body: "$ctx.msg = { text: 'hi' }",
        isAsync: false,
        ctx: {},
        self: {},
      };
      adapter.handle(event);
    }, 50);

    const events = await waitPromise;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event.type, "pre_send_action");

    adapter.deliverResponse("inst-2", { type: "ctx_update", ctx: { msg: { text: "hi" } } });
  });

  it("deliverResponse returns false when no pending", () => {
    const adapter = new McpAgentAdapter("test-agent");
    const ok = adapter.deliverResponse("nonexistent", { type: "noop" });
    assert.strictEqual(ok, false);
  });

  it("concurrent instances — each gets its own pending resolve", async () => {
    const adapter = new McpAgentAdapter("test-agent");
    adapter.register(["worker"]);

    const makeEvent = (stateId: string): ProtocolEvent => ({
      type: "action",
      stateId,
      body: "$ctx.x = 1",
      lang: "ts",
      isAsync: false,
      ctx: {},
      self: {},
    });

    adapter.setCurrentInstance("inst-A", "ProtoA", "worker");
    const handleA = adapter.handle(makeEvent("sA"));

    adapter.setCurrentInstance("inst-B", "ProtoB", "worker");
    const handleB = adapter.handle(makeEvent("sB"));

    assert.strictEqual(adapter.hasPendingResponse("inst-A"), true);
    assert.strictEqual(adapter.hasPendingResponse("inst-B"), true);

    const events = await adapter.waitForEvents(1000, 10);
    assert.strictEqual(events.length, 2);

    const respA: AgentResponse = { type: "ctx_update", ctx: { result: "A" } };
    const respB: AgentResponse = { type: "ctx_update", ctx: { result: "B" } };

    adapter.deliverResponse("inst-B", respB);
    adapter.deliverResponse("inst-A", respA);

    const returnedA = await handleA;
    const returnedB = await handleB;
    assert.strictEqual((returnedA as any).ctx.result, "A");
    assert.strictEqual((returnedB as any).ctx.result, "B");

    assert.strictEqual(adapter.hasPendingResponse("inst-A"), false);
    assert.strictEqual(adapter.hasPendingResponse("inst-B"), false);
  });

  it("pushNotification queues without blocking", async () => {
    const adapter = new McpAgentAdapter("test-agent");
    adapter.register(["worker"]);

    adapter.pushNotification("inst-1", {
      type: "protocol_started",
      protocolName: "TestProto",
    });

    const events = await adapter.waitForEvents(1000, 5);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event.type, "protocol_started");
  });
});
