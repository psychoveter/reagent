/**
 * Tests for NatsNodeLink.
 *
 * Unit tests (no NATS required):
 *   - Constructor sets fields correctly
 *   - send() throws when not connected
 *   - onEnvelope() stores handler
 *
 * Integration tests (require NATS at localhost:4222):
 *   - Bidirectional envelope delivery between two links
 *   - Multiple envelopes in sequence
 *   - close() stops delivery
 *
 * Run: npx tsx test/nats-node-link.test.ts
 *
 * Integration tests are skipped if NATS is unreachable. Set NATS_URL to override.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { NatsNodeLink } from "../src/network/nats-node-link.js";
import type { MessageEnvelope } from "../src/contracts/types.js";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    instanceId: "test-inst-1",
    protocolName: "TestProto",
    from: { agent: "AgentA", role: "sender" },
    to: { agent: "AgentB", role: "receiver" },
    messageName: "TestMessage",
    payload: { value: 42 },
    ts: Date.now(),
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

// ── Unit tests (no NATS needed) ─────────────────────────────────────

describe("NatsNodeLink (unit)", () => {
  it("constructor sets remoteNodeId", () => {
    const link = new NatsNodeLink({
      localNodeId: "node-a",
      remoteNodeId: "node-b",
      natsUrl: NATS_URL,
    });
    assert.strictEqual(link.remoteNodeId, "node-b");
  });

  it("send() throws when not connected", () => {
    const link = new NatsNodeLink({
      localNodeId: "node-a",
      remoteNodeId: "node-b",
      natsUrl: NATS_URL,
    });
    assert.throws(() => link.send(makeEnvelope()), /not connected/);
  });

  it("onEnvelope() can be called before connect()", () => {
    const link = new NatsNodeLink({
      localNodeId: "node-a",
      remoteNodeId: "node-b",
      natsUrl: NATS_URL,
    });
    let called = false;
    link.onEnvelope(() => { called = true; });
    assert.strictEqual(called, false);
  });
});

// ── Integration tests (require NATS) ────────────────────────────────

async function natsReachable(): Promise<boolean> {
  try {
    const { connect } = await import("nats");
    const nc = await connect({ servers: NATS_URL, timeout: 2000 });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

describe("NatsNodeLink (integration)", () => {
  let available = false;
  let linkA: NatsNodeLink;
  let linkB: NatsNodeLink;

  before(async () => {
    available = await natsReachable();
    if (!available) {
      console.log("  ⚠ NATS not reachable at", NATS_URL, "— skipping integration tests");
      return;
    }

    linkA = new NatsNodeLink({
      localNodeId: "test-node-a",
      remoteNodeId: "test-node-b",
      natsUrl: NATS_URL,
    });
    linkB = new NatsNodeLink({
      localNodeId: "test-node-b",
      remoteNodeId: "test-node-a",
      natsUrl: NATS_URL,
    });

    await linkA.connect();
    await linkB.connect();
  });

  after(async () => {
    if (!available) return;
    await linkA.close();
    await linkB.close();
  });

  it("A sends envelope, B receives it", async (t) => {
    if (!available) return t.skip("NATS unavailable");

    const received: MessageEnvelope[] = [];
    linkB.onEnvelope((env) => received.push(env));

    const env = makeEnvelope({ instanceId: "round-trip-1" });
    linkA.send(env);

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].instanceId, "round-trip-1");
    assert.strictEqual(received[0].messageName, "TestMessage");
    assert.deepStrictEqual(received[0].payload, { value: 42 });
  });

  it("B sends envelope, A receives it", async (t) => {
    if (!available) return t.skip("NATS unavailable");

    const received: MessageEnvelope[] = [];
    linkA.onEnvelope((env) => received.push(env));

    const env = makeEnvelope({ instanceId: "round-trip-2", from: { agent: "AgentB", role: "receiver" }, to: { agent: "AgentA", role: "sender" } });
    linkB.send(env);

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].instanceId, "round-trip-2");
  });

  it("multiple envelopes delivered in order", async (t) => {
    if (!available) return t.skip("NATS unavailable");

    const received: MessageEnvelope[] = [];
    linkB.onEnvelope((env) => received.push(env));

    for (let i = 0; i < 5; i++) {
      linkA.send(makeEnvelope({ instanceId: `seq-${i}`, payload: { index: i } }));
    }

    await new Promise((r) => setTimeout(r, 500));

    assert.strictEqual(received.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(received[i].instanceId, `seq-${i}`);
      assert.deepStrictEqual(received[i].payload, { index: i });
    }
  });

  it("close() stops delivery", async (t) => {
    if (!available) return t.skip("NATS unavailable");

    const extraLink = new NatsNodeLink({
      localNodeId: "test-node-c",
      remoteNodeId: "test-node-a",
      natsUrl: NATS_URL,
    });
    await extraLink.connect();

    const received: MessageEnvelope[] = [];
    extraLink.onEnvelope((env) => received.push(env));

    await extraLink.close();

    linkA.send(makeEnvelope({ instanceId: "after-close", to: { agent: "AgentC", role: "x" } }));
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(received.length, 0);
  });
});
