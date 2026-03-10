/**
 * Integration tests for etcd cluster infrastructure.
 *
 * Tests: LeaderElection, EtcdMembership, trigger dedup.
 * Requires etcd at localhost:2379.
 *
 * Run: npx tsx test/etcd-cluster.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EtcdStateStore } from "../src/etcd-state-store.js";
import { LeaderElection } from "../src/leader-election.js";
import { EtcdMembership } from "../src/etcd-membership.js";

const ETCD_HOSTS = (process.env.ETCD_HOSTS ?? "http://127.0.0.1:2379").split(",");

async function etcdReachable(): Promise<boolean> {
  try {
    const store = new EtcdStateStore({ hosts: ETCD_HOSTS });
    await store.get("/__probe__");
    await store.close();
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── LeaderElection ──────────────────────────────────────────────────

describe("LeaderElection (integration)", () => {
  let available = false;
  let store: EtcdStateStore;
  const testKey = `/__test_leader_${Date.now()}`;

  before(async () => {
    available = await etcdReachable();
    if (!available) {
      console.log("  ⚠ etcd not reachable — skipping");
      return;
    }
    store = new EtcdStateStore({ hosts: ETCD_HOSTS });
  });

  after(async () => {
    if (!available) return;
    await store.delete(testKey);
    await store.close();
  });

  it("first candidate acquires leadership", async (t) => {
    if (!available) { t.skip(); return; }

    let elected = false;
    const le = new LeaderElection({
      stateStore: store,
      leaderKey: testKey,
      candidateId: "node-A",
      leaseTtlSeconds: 5,
      onElected: () => { elected = true; },
    });

    await le.start();
    await sleep(500);

    assert.strictEqual(le.isLeader, true);
    assert.strictEqual(elected, true);

    await le.stop();
  });

  it("second candidate does not acquire leadership while first holds it", async (t) => {
    if (!available) { t.skip(); return; }

    const key = `${testKey}_contention`;

    const le1 = new LeaderElection({
      stateStore: store,
      leaderKey: key,
      candidateId: "node-A",
      leaseTtlSeconds: 10,
    });

    const le2 = new LeaderElection({
      stateStore: store,
      leaderKey: key,
      candidateId: "node-B",
      leaseTtlSeconds: 10,
      retryIntervalMs: 500,
    });

    await le1.start();
    await sleep(300);
    assert.strictEqual(le1.isLeader, true);

    await le2.start();
    await sleep(1000);
    assert.strictEqual(le2.isLeader, false);

    await le1.stop();
    await le2.stop();
    await store.delete(key);
  });

  it("second candidate acquires leadership after first stops", async (t) => {
    if (!available) { t.skip(); return; }

    const key = `${testKey}_failover`;

    let le2Elected = false;
    const le1 = new LeaderElection({
      stateStore: store,
      leaderKey: key,
      candidateId: "node-A",
      leaseTtlSeconds: 2,
    });

    const le2 = new LeaderElection({
      stateStore: store,
      leaderKey: key,
      candidateId: "node-B",
      leaseTtlSeconds: 5,
      retryIntervalMs: 500,
      onElected: () => { le2Elected = true; },
    });

    await le1.start();
    await sleep(300);
    assert.strictEqual(le1.isLeader, true);

    await le2.start();
    await sleep(500);
    assert.strictEqual(le2.isLeader, false);

    // Stop le1 — its lease will expire (2s TTL)
    await le1.stop();

    // Wait for lease expiry + le2 retry
    await sleep(4000);
    assert.strictEqual(le2.isLeader, true);
    assert.strictEqual(le2Elected, true);

    await le2.stop();
    await store.delete(key);
  });
});

// ── EtcdMembership ──────────────────────────────────────────────────

describe("EtcdMembership (integration)", () => {
  let available = false;
  let store1: EtcdStateStore;
  let store2: EtcdStateStore;

  before(async () => {
    available = await etcdReachable();
    if (!available) {
      console.log("  ⚠ etcd not reachable — skipping");
      return;
    }
    store1 = new EtcdStateStore({ hosts: ETCD_HOSTS });
    store2 = new EtcdStateStore({ hosts: ETCD_HOSTS });
  });

  after(async () => {
    if (!available) return;
    // Clean up
    const entries = await store1.list("/nodes/");
    for (const e of entries) await store1.delete(e.key);
    const agents = await store1.list("/agents/");
    for (const e of agents) await store1.delete(e.key);
    await store1.close();
    await store2.close();
  });

  it("detects node join", async (t) => {
    if (!available) { t.skip(); return; }

    const joinedNodes: string[] = [];

    const m1 = new EtcdMembership({
      stateStore: store1,
      nodeId: "test-node-1",
      leaseTtlSeconds: 10,
      onNodeJoin: (id) => joinedNodes.push(id),
    });

    await m1.start();
    await sleep(500);

    const m2 = new EtcdMembership({
      stateStore: store2,
      nodeId: "test-node-2",
      leaseTtlSeconds: 10,
    });

    await m2.start();
    await sleep(1000);

    assert.ok(joinedNodes.includes("test-node-2"), `Expected test-node-2 in joined: ${joinedNodes}`);

    await m1.stop();
    await m2.stop();
  });

  it("detects remote agent registration", async (t) => {
    if (!available) { t.skip(); return; }

    const remoteAgents: Array<{ name: string; nodeId: string }> = [];

    const m1 = new EtcdMembership({
      stateStore: store1,
      nodeId: "test-node-A",
      leaseTtlSeconds: 10,
      onRemoteAgent: (name, nodeId) => remoteAgents.push({ name, nodeId }),
    });

    await m1.start();
    await sleep(500);

    // Simulate node B registering an agent in the store
    await store2.put("/agents/BuyerAgent", JSON.stringify({
      name: "BuyerAgent",
      role: "buyer",
      nodeId: "test-node-B",
      tags: [],
      capabilities: [],
      labels: {},
      metadata: {},
    }));

    await sleep(1000);

    const found = remoteAgents.find((a) => a.name === "BuyerAgent");
    assert.ok(found, `Expected BuyerAgent in remote agents: ${JSON.stringify(remoteAgents)}`);
    assert.strictEqual(found!.nodeId, "test-node-B");

    await m1.stop();
  });

  it("detects node leave on lease expiry", async (t) => {
    if (!available) { t.skip(); return; }

    const leftNodes: string[] = [];

    const m1 = new EtcdMembership({
      stateStore: store1,
      nodeId: "test-leave-observer",
      leaseTtlSeconds: 15,
      onNodeLeave: (id) => leftNodes.push(id),
    });

    const m2 = new EtcdMembership({
      stateStore: store2,
      nodeId: "test-leave-target",
      leaseTtlSeconds: 2,
    });

    await m1.start();
    await sleep(300);
    await m2.start();
    await sleep(1000);

    // Stop m2 (revokes lease → deletes /nodes/test-leave-target)
    await m2.stop();
    await sleep(1000);

    assert.ok(leftNodes.includes("test-leave-target"), `Expected test-leave-target in left: ${leftNodes}`);

    await m1.stop();
  });
});

// ── Trigger dedup ───────────────────────────────────────────────────

describe("Trigger dedup via StateStore (integration)", () => {
  let available = false;
  let store: EtcdStateStore;
  const prefix = `/__test_dedup_${Date.now()}/`;

  before(async () => {
    available = await etcdReachable();
    if (!available) {
      console.log("  ⚠ etcd not reachable — skipping");
      return;
    }
    store = new EtcdStateStore({ hosts: ETCD_HOSTS });
  });

  after(async () => {
    if (!available) return;
    const entries = await store.list(prefix);
    for (const e of entries) await store.delete(e.key);
    await store.close();
  });

  it("first putIfAbsent wins, second loses", async (t) => {
    if (!available) { t.skip(); return; }

    const key = `${prefix}trigger-lock-1`;

    const first = await store.putIfAbsent(key, "node-A");
    assert.strictEqual(first, true);

    const second = await store.putIfAbsent(key, "node-B");
    assert.strictEqual(second, false);

    const val = await store.get(key);
    assert.strictEqual(val, "node-A");
  });

  it("concurrent CAS: only one wins", async (t) => {
    if (!available) { t.skip(); return; }

    const key = `${prefix}trigger-lock-concurrent`;

    const results = await Promise.all([
      store.putIfAbsent(key, "node-1"),
      store.putIfAbsent(key, "node-2"),
      store.putIfAbsent(key, "node-3"),
    ]);

    const winners = results.filter((r) => r === true);
    assert.strictEqual(winners.length, 1, `Expected exactly 1 winner, got ${winners.length}`);
  });
});
