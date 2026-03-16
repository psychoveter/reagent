/**
 * Tests for M11-STATE: StateStore, AgentRegistry, ResolvePolicyEvaluator.
 *
 * Run: npx tsx test/cluster/state-resolve.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { InMemoryStateStore } from "../../src/cluster/state-store.js";
import { StateStoreAgentRegistry, type AgentRegistration } from "../../src/cluster/state-store-agent-registry.js";
import { ResolvePolicyEvaluator } from "../../src/triggers/resolve-policy-evaluator.js";

function makeAgent(name: string, role: string, opts?: Partial<AgentRegistration>): AgentRegistration {
  return {
    name,
    role,
    nodeId: opts?.nodeId ?? "test-node",
    lifecycle: opts?.lifecycle ?? "ready",
    runtime: opts?.runtime ?? {
      runtimeName: "test-runtime",
      lifecycle: "ready",
      nodeId: opts?.nodeId ?? "test-node",
      attachedAt: Date.now(),
      readyAt: Date.now(),
    },
    tags: opts?.tags ?? [],
    capabilities: opts?.capabilities ?? [],
    labels: opts?.labels ?? {},
    metadata: opts?.metadata ?? {},
  };
}

// ── InMemoryStateStore ──────────────────────────────────────────────

describe("InMemoryStateStore", () => {
  let store: InMemoryStateStore;

  beforeEach(() => { store = new InMemoryStateStore(); });

  it("get/put/delete", async () => {
    await store.put("/a", "hello");
    assert.equal(await store.get("/a"), "hello");
    assert.equal(await store.delete("/a"), true);
    assert.equal(await store.get("/a"), null);
    assert.equal(await store.delete("/a"), false);
  });

  it("list by prefix", async () => {
    await store.put("/agents/a", "1");
    await store.put("/agents/b", "2");
    await store.put("/other/c", "3");
    const agents = await store.list("/agents/");
    assert.equal(agents.length, 2);
    assert.equal(agents[0].key, "/agents/a");
    assert.equal(agents[1].key, "/agents/b");
  });

  it("putIfAbsent CAS", async () => {
    assert.equal(await store.putIfAbsent("/k", "first"), true);
    assert.equal(await store.putIfAbsent("/k", "second"), false);
    assert.equal(await store.get("/k"), "first");
  });

  it("compareAndSwap updates only when expected value matches", async () => {
    await store.put("/cas", "v1");
    assert.equal(await store.compareAndSwap("/cas", "v0", "v2"), false);
    assert.equal(await store.get("/cas"), "v1");
    assert.equal(await store.compareAndSwap("/cas", "v1", "v2"), true);
    assert.equal(await store.get("/cas"), "v2");
  });

  it("compareAndSwap can create when expecting null", async () => {
    assert.equal(await store.compareAndSwap("/new", null, "created"), true);
    assert.equal(await store.get("/new"), "created");
    assert.equal(await store.compareAndSwap("/new", null, "other"), false);
    assert.equal(await store.get("/new"), "created");
  });

  it("watch emits put and delete events", async () => {
    const events: string[] = [];
    store.watch("/agents/", (e) => events.push(`${e.kind}:${e.key}`));
    await store.put("/agents/a", "1");
    await store.delete("/agents/a");
    await store.put("/other/x", "2");
    assert.deepEqual(events, ["put:/agents/a", "delete:/agents/a"]);
  });

  it("lease expires and cleans up keys", async () => {
    const lease = await store.createLease(0.05); // 50ms
    await store.put("/tmp/a", "v", { lease: lease.id });
    assert.equal(await store.get("/tmp/a"), "v");
    await new Promise(r => setTimeout(r, 100));
    assert.equal(await store.get("/tmp/a"), null);
  });

  it("lease revoke immediately cleans up", async () => {
    const lease = await store.createLease(60);
    await store.put("/tmp/b", "v", { lease: lease.id });
    assert.equal(await store.get("/tmp/b"), "v");
    await lease.revoke();
    assert.equal(await store.get("/tmp/b"), null);
  });
});

// ── StateStoreAgentRegistry ──────────────────────────────────────

describe("StateStoreAgentRegistry", () => {
  let store: InMemoryStateStore;
  let registry: StateStoreAgentRegistry;

  beforeEach(() => {
    store = new InMemoryStateStore();
    registry = new StateStoreAgentRegistry(store);
  });

  it("register and find by role", async () => {
    await registry.register(makeAgent("buyer1", "Buyer", { tags: ["eu"] }));
    await registry.register(makeAgent("buyer2", "Buyer", { tags: ["us"] }));
    await registry.register(makeAgent("seller1", "Seller"));

    const buyers = registry.findByRole("Buyer");
    assert.equal(buyers.length, 2);
    assert.equal(registry.findByRole("Seller").length, 1);
    assert.equal(registry.findByRole("Unknown").length, 0);
  });

  it("deregister removes from cache", async () => {
    await registry.register(makeAgent("a", "Role"));
    assert.ok(registry.get("a"));
    assert.equal(await registry.deregister("a"), true);
    assert.equal(registry.get("a"), undefined);
  });

  it("change notifications fire", async () => {
    const changes: string[] = [];
    registry.onChanged((name, agent) => {
      changes.push(agent ? `add:${name}` : `del:${name}`);
    });
    await registry.register(makeAgent("x", "R"));
    await registry.deregister("x");
    assert.deepEqual(changes, ["add:x", "del:x"]);
  });

  it("loadFromStore rebuilds cache", async () => {
    await store.put("/agents/a", JSON.stringify(makeAgent("a", "R")));
    await store.put("/agents/b", JSON.stringify(makeAgent("b", "R")));
    const reg2 = new StateStoreAgentRegistry(store);
    await reg2.loadFromStore();
    assert.equal(reg2.all().length, 2);
    reg2.dispose();
  });
});

// ── ResolvePolicyEvaluator ──────────────────────────────────────

describe("ResolvePolicyEvaluator", () => {
  let store: InMemoryStateStore;
  let registry: StateStoreAgentRegistry;
  let evaluator: ResolvePolicyEvaluator;

  beforeEach(async () => {
    store = new InMemoryStateStore();
    registry = new StateStoreAgentRegistry(store);
    evaluator = new ResolvePolicyEvaluator(registry);

    await registry.register(makeAgent("b1", "Buyer", { tags: ["eu", "ml"], capabilities: ["bidding"], labels: { tier: "premium" }, metadata: { score: 0.9 } }));
    await registry.register(makeAgent("b2", "Buyer", { tags: ["us"], capabilities: ["bidding"], labels: { tier: "standard" }, metadata: { score: 0.3 } }));
    await registry.register(makeAgent("b3", "Buyer", { tags: ["eu"], capabilities: [], labels: { tier: "standard" }, metadata: { score: 0.7 } }));
    await registry.register(makeAgent("s1", "Seller", { tags: ["eu"] }));
  });

  it("all returns all agents for role", async () => {
    const result = await evaluator.evaluate([{ step: "all" }], "Buyer");
    assert.equal(result.length, 3);
  });

  it("single returns first", async () => {
    const result = await evaluator.evaluate([{ step: "single" }], "Buyer");
    assert.equal(result.length, 1);
  });

  it("all | first returns one", async () => {
    const result = await evaluator.evaluate([{ step: "all" }, { step: "first" }], "Buyer");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "b1");
  });

  it("filter by tag", async () => {
    const result = await evaluator.evaluate([
      { step: "all" },
      { step: "filter", predicate: '"eu" in agent.tags' },
    ], "Buyer");
    assert.equal(result.length, 2);
    assert.ok(result.every(a => a.tags.includes("eu")));
  });

  it("filter by label", async () => {
    const result = await evaluator.evaluate([
      { step: "all" },
      { step: "filter", predicate: 'agent.labels.tier == "premium"' },
    ], "Buyer");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "b1");
  });

  it("filter by metadata comparison", async () => {
    const result = await evaluator.evaluate([
      { step: "all" },
      { step: "filter", predicate: "agent.metadata.score > 0.5" },
    ], "Buyer");
    assert.equal(result.length, 2);
  });

  it("filter compound (&&)", async () => {
    const result = await evaluator.evaluate([
      { step: "all" },
      { step: "filter", predicate: '"eu" in agent.tags && agent.metadata.score > 0.5' },
    ], "Buyer");
    assert.equal(result.length, 2);
  });

  it("roundRobin cycles through candidates", async () => {
    evaluator.resetRoundRobin();
    const r1 = await evaluator.evaluate([{ step: "all" }, { step: "roundRobin" }], "Buyer", {}, "t1");
    const r2 = await evaluator.evaluate([{ step: "all" }, { step: "roundRobin" }], "Buyer", {}, "t1");
    const r3 = await evaluator.evaluate([{ step: "all" }, { step: "roundRobin" }], "Buyer", {}, "t1");
    assert.equal(r1[0].name, "b1");
    assert.equal(r2[0].name, "b2");
    assert.equal(r3[0].name, "b3");
  });

  it("sample returns N items", async () => {
    const result = await evaluator.evaluate([
      { step: "all" },
      { step: "sample", count: 2 },
    ], "Buyer");
    assert.equal(result.length, 2);
  });

  it("fallback when primary yields empty", async () => {
    const result = await evaluator.evaluate([
      { step: "all" },
      { step: "filter", predicate: '"nonexistent" in agent.tags' },
      { step: "fallback", chain: [{ step: "all" }, { step: "first" }] },
    ], "Buyer");
    assert.equal(result.length, 1);
  });

  it("custom policy integration", async () => {
    evaluator.registerCustomPolicy("topScorer", (candidates) => {
      return candidates
        .filter(a => typeof a.metadata.score === "number")
        .sort((a, b) => (b.metadata.score as number) - (a.metadata.score as number))
        .slice(0, 1);
    });
    const result = await evaluator.evaluate([
      { step: "all" },
      { step: "custom", name: "topScorer" },
    ], "Buyer");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "b1");
  });

  it("from($ctx.input.agentName) resolves specific agent", async () => {
    const result = await evaluator.evaluate(
      [{ step: "from", expr: "$ctx.input.agentName" }],
      "Buyer",
      { input: { agentName: "b2" } },
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "b2");
  });
});
