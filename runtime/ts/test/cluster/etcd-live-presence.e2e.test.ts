/**
 * E2E tests for live node/agent presence against a real etcd instance.
 *
 * Requires etcd at localhost:2379 unless ETCD_HOSTS is set.
 *
 * Run: npx tsx --test test/etcd-live-presence.e2e.test.ts
 */
import { describe, it, before, beforeEach, after } from "node:test";
import * as assert from "node:assert/strict";
import { Etcd3 } from "etcd3";
import { EtcdStateStore } from "../../src/cluster/etcd-state-store.js";
import { EtcdMembership } from "../../src/cluster/etcd-membership.js";
import { StateStoreAgentRegistry, type AgentRegistration } from "../../src/cluster/state-store-agent-registry.js";
import { ReagentController } from "../../src/controller/reagent-controller.js";
import type { IRGraph, RoleIR } from "../../src/contracts/types.js";
import type { BehaviorFactory } from "../../src/contracts/behavior-factory.js";
import type { AgentBehavior } from "../../src/contracts/agent-behavior.js";
import { DEFAULT_ETCD_HOSTS, etcdReachable, sleep, waitFor } from "../support/infra.js";

const ETCD_HOSTS = DEFAULT_ETCD_HOSTS;

class FakeBehaviorFactory implements BehaviorFactory {
  readonly runtimeName = "fake";

  createBehavior(
    _agentName: string,
    _roleIR: RoleIR,
    _graphs: Map<string, IRGraph>,
  ): AgentBehavior {
    return {
      handle: async () => ({ type: "noop" as const }),
    } as AgentBehavior;
  }

  async destroyBehavior(): Promise<void> {}
}

const roleIR: RoleIR = {
  roleName: "WorkerRole",
  lang: "ts",
  plays: [{ protocolName: "LeaseProto", roleName: "worker" }],
  lifecycleHandlers: [],
};

const graph: IRGraph = {
  protocolName: "LeaseProto",
  role: "worker",
  lang: "ts",
  states: [
    { id: "init", kind: "initial", data: { kind: "initial" } },
    { id: "done", kind: "terminal", data: { kind: "terminal", status: "completed" } },
  ],
  transitions: [
    { from: "init", to: "done", label: { kind: "default" } },
  ],
  initialStateId: "init",
  terminalStateIds: ["done"],
};

async function wipeSuiteEtcd(): Promise<void> {
  const client = new Etcd3({ hosts: ETCD_HOSTS });
  try {
    const nodes = await client.getAll().prefix("/nodes/").strings();
    for (const key of Object.keys(nodes)) {
      if (key.startsWith("/nodes/e2e-")) {
        await client.delete().key(key).exec();
      }
    }

    const agents = await client.getAll().prefix("/agents/").strings();
    for (const key of Object.keys(agents)) {
      if (
        key.startsWith("/agents/DetachAgent") ||
        key.startsWith("/agents/LeaseGoneAgent") ||
        key.startsWith("/agents/e2e-")
      ) {
        await client.delete().key(key).exec();
      }
    }
  } finally {
    client.close();
  }
}

function liveAgent(name: string, nodeId: string): AgentRegistration {
  return {
    name,
    role: "worker",
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

describe("real etcd live presence e2e", () => {
  let available = false;

  before(async () => {
    available = await etcdReachable();
    if (!available) {
      console.log("  ⚠ etcd not reachable at", ETCD_HOSTS.join(","), "— skipping");
    }
  });

  beforeEach(async () => {
    if (!available) return;
    await wipeSuiteEtcd();
  });

  after(async () => {
    if (!available) return;
    await wipeSuiteEtcd();
  });

  it("removes live agent key on detach while keeping node key", async (t) => {
    if (!available) { t.skip(); return; }

    const store = new EtcdStateStore({ hosts: ETCD_HOSTS });
    const rc = new ReagentController({
      nodeId: "e2e-detach-node",
      behaviorFactory: new FakeBehaviorFactory(),
      stateStore: store,
    });

    try {
      await rc.startMembership({ leaseTtlSeconds: 5 });
      rc.deployAgentTemplate("DetachAgent", roleIR, new Map([["LeaseProto.worker", graph]]));
      rc.createAgentFromTemplate("DetachAgent", { start: false });
      rc.markAgentRuntimeReady("DetachAgent");

      await waitFor(async () => (await store.get("/nodes/e2e-detach-node")) != null, "node key was not published");
      await waitFor(async () => (await store.get("/agents/DetachAgent")) != null, "agent key was not published");

      rc.detachAgentRuntime("DetachAgent");

      await waitFor(async () => (await store.get("/agents/DetachAgent")) == null, "agent key was not removed on detach");
      assert.ok(await store.get("/nodes/e2e-detach-node"), "node key should remain after detach");
    } finally {
      await rc.stop().catch(() => {});
      await store.close().catch(() => {});
    }
  });

  it("removes node and leased agent keys when the node lease is revoked", async (t) => {
    if (!available) { t.skip(); return; }

    const observerStore = new EtcdStateStore({ hosts: ETCD_HOSTS });
    const targetStore = new EtcdStateStore({ hosts: ETCD_HOSTS });
    const observerSeen: Array<{ name: string; nodeId: string }> = [];
    const observerRemoved: string[] = [];

    const observer = new EtcdMembership({
      stateStore: observerStore,
      nodeId: "e2e-observer",
      leaseTtlSeconds: 10,
      onRemoteAgent: (name, nodeId) => observerSeen.push({ name, nodeId }),
      onRemoteAgentRemoved: (name) => observerRemoved.push(name),
    });
    const targetMembership = new EtcdMembership({
      stateStore: targetStore,
      nodeId: "e2e-target",
      leaseTtlSeconds: 5,
    });
    const registry = new StateStoreAgentRegistry(targetStore);

    try {
      await observer.start();
      await sleep(400);
      await targetMembership.start();
      await registry.register(liveAgent("LeaseGoneAgent", "e2e-target"), { lease: targetMembership.getLeaseId() });

      await waitFor(async () => (await targetStore.get("/nodes/e2e-target")) != null, "target node key was not created");
      await waitFor(async () => (await targetStore.get("/agents/LeaseGoneAgent")) != null, "leased agent key was not created");
      await waitFor(
        () => observerSeen.some((entry) => entry.name === "LeaseGoneAgent" && entry.nodeId === "e2e-target"),
        "observer did not see remote agent registration",
      );

      await targetMembership.stop();

      await waitFor(async () => (await targetStore.get("/nodes/e2e-target")) == null, "node key did not disappear after lease revoke");
      await waitFor(async () => (await targetStore.get("/agents/LeaseGoneAgent")) == null, "agent key did not disappear after lease revoke");
      await waitFor(
        () => observerRemoved.includes("LeaseGoneAgent"),
        "observer did not see remote agent removal",
      );
    } finally {
      registry.dispose();
      await targetMembership.stop().catch(() => {});
      await observer.stop().catch(() => {});
      await observerStore.close().catch(() => {});
      await targetStore.close().catch(() => {});
    }
  });
});
