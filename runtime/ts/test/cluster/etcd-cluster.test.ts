/**
 * Integration tests for etcd cluster infrastructure.
 *
 * Tests: LeaderElection, EtcdMembership, trigger dedup.
 * Requires etcd at localhost:2379.
 *
 * Run: npx tsx test/cluster/etcd-cluster.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EtcdStateStore } from "../../src/cluster/etcd-state-store.js";
import { LeaderElection } from "../../src/cluster/leader-election.js";
import { EtcdMembership } from "../../src/cluster/etcd-membership.js";
import { StateStoreAgentRegistry, type AgentRegistration } from "../../src/cluster/state-store-agent-registry.js";
import { ReagentController } from "../../src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../../src/nodes/managed-behavior-factory.js";
import type { ProtocolRunRecord } from "../../src/contracts/protocol-run.js";
import { DEFAULT_ETCD_HOSTS, etcdReachable, sleep, waitFor } from "../support/infra.js";

const ETCD_HOSTS = DEFAULT_ETCD_HOSTS;

function liveAgent(name: string, nodeId: string): AgentRegistration {
  return {
    name,
    role: "buyer",
    nodeId,
    lifecycle: "ready",
    runtime: {
      runtimeName: "fake",
      lifecycle: "ready",
      nodeId,
      attachedAt: Date.now(),
      readyAt: Date.now(),
    },
    tags: [],
    capabilities: [],
    labels: {},
    metadata: {},
  };
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

    try {
      await le.start();
      await sleep(500);

      assert.strictEqual(le.isLeader, true);
      assert.strictEqual(elected, true);
    } finally {
      await le.stop().catch(() => {});
    }
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

    try {
      await le1.start();
      await sleep(300);
      assert.strictEqual(le1.isLeader, true);

      await le2.start();
      await sleep(1000);
      assert.strictEqual(le2.isLeader, false);
    } finally {
      await le1.stop().catch(() => {});
      await le2.stop().catch(() => {});
      await store.delete(key).catch(() => {});
    }
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

    try {
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
    } finally {
      await le1.stop().catch(() => {});
      await le2.stop().catch(() => {});
      await store.delete(key).catch(() => {});
    }
  });
});

describe("EtcdStateStore compareAndSwap (integration)", () => {
  let available = false;
  let store: EtcdStateStore;
  const key = `/__test_cas_${Date.now()}`;

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
    await store.delete(key).catch(() => {});
    await store.close();
  });

  it("atomically updates only when expected value matches", async (t) => {
    if (!available) { t.skip(); return; }

    await store.delete(key).catch(() => {});
    assert.equal(await store.compareAndSwap(key, null, "v1"), true);
    assert.equal(await store.compareAndSwap(key, null, "v2"), false);
    assert.equal(await store.get(key), "v1");
    assert.equal(await store.compareAndSwap(key, "v0", "v2"), false);
    assert.equal(await store.compareAndSwap(key, "v1", "v2"), true);
    assert.equal(await store.get(key), "v2");
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
    const registry = new StateStoreAgentRegistry(store2);

    const m1 = new EtcdMembership({
      stateStore: store1,
      nodeId: "test-node-A",
      leaseTtlSeconds: 10,
      onRemoteAgent: (name, nodeId) => remoteAgents.push({ name, nodeId }),
    });

    try {
      await m1.start();
      await sleep(500);

      await registry.register(liveAgent("BuyerAgent", "test-node-B"));

      await waitFor(
        () => remoteAgents.some((a) => a.name === "BuyerAgent" && a.nodeId === "test-node-B"),
        `Expected BuyerAgent in remote agents: ${JSON.stringify(remoteAgents)}`,
      );
    } finally {
      registry.dispose();
      await m1.stop().catch(() => {});
      await store2.delete("/agents/BuyerAgent").catch(() => {});
    }
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

    try {
      await m1.start();
      await sleep(300);
      await m2.start();
      await sleep(1000);

      // Stop m2 (revokes lease → deletes /nodes/test-leave-target)
      await m2.stop();
      await waitFor(
        () => leftNodes.includes("test-leave-target"),
        `Expected test-leave-target in left: ${leftNodes}`,
      );
    } finally {
      await m2.stop().catch(() => {});
      await m1.stop().catch(() => {});
    }
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

describe("Protocol-run adoption via Etcd CAS (integration)", () => {
  let available = false;
  let store: EtcdStateStore;
  const instanceId = `etcd-adoption-${Date.now()}`;
  const key = `/protocol-runs/${instanceId}`;

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
    await store.delete(key).catch(() => {});
    await store.close();
  });

  it("updates the durable record in-place when a survivor adopts a lost home node", async (t) => {
    if (!available) { t.skip(); return; }

    const record: ProtocolRunRecord = {
      instanceId,
      protocolName: "EtcdProto",
      status: "running",
      homeNodeId: "lost-node",
      relationKind: "root",
      supervisionStrategy: "scoped",
      rootInstanceId: instanceId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      ownerAgentName: "OwnerAgent",
      ownerRoleName: "owner",
      roles: {
        owner: {
          agentName: "OwnerAgent",
          roleName: "owner",
          nodeId: "lost-node",
          status: "running",
          updatedAt: Date.now(),
        },
      },
      childInstanceIds: [],
      spawnedAgents: [],
      participantLosses: [],
    };
    await store.put(key, JSON.stringify(record));

    const rc = new ReagentController({
      nodeId: "survivor-node",
      behaviorFactory: new ManagedBehaviorFactory(),
      stateStore: store,
    });

    try {
      await rc.handleNodeDeparture("lost-node");
      const raw = await store.get(key);
      assert.ok(raw);
      const updated = JSON.parse(String(raw)) as ProtocolRunRecord;
      assert.equal(updated.homeNodeId, "survivor-node");
      assert.equal(updated.adoptedByNodeId, "survivor-node");
      assert.equal(updated.status, "cancelled");
    } finally {
      await rc.stop().catch(() => {});
    }
  });
});
