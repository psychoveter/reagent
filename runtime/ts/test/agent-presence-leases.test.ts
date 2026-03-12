import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStateStore } from "../src/cluster/state-store.js";
import { StateStoreAgentRegistry } from "../src/cluster/state-store-agent-registry.js";
import { ReagentController } from "../src/controller/reagent-controller.js";
import type { AgentHandle, AgentNode } from "../src/contracts/agent-node.js";
import type { IRGraph, MessageEnvelope, ProtocolTrigger, RoleIR } from "../src/contracts/types.js";
import type { ReagentTransport } from "../src/contracts/transport.js";

class FakeHandle implements AgentHandle {
  constructor(readonly agentName: string) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getSelf(): Record<string, unknown> { return {}; }
  triggerProtocol(_trigger: ProtocolTrigger): void {}
  dispatchMessage(_env: MessageEnvelope): void {}
}

class FakeNode implements AgentNode {
  readonly runtimeName = "fake";

  createAgent(
    agentName: string,
    _roleIR: RoleIR,
    _graphs: Map<string, IRGraph>,
    _transport: ReagentTransport,
    _extras?: Record<string, unknown>,
  ): AgentHandle {
    return new FakeHandle(agentName);
  }

  async destroyAgent(_handle: AgentHandle): Promise<void> {}
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

describe("lease-backed agent presence", () => {
  it("state store registry removes leased agent entries on revoke", async () => {
    const store = new InMemoryStateStore();
    const registry = new StateStoreAgentRegistry(store);
    const lease = await store.createLease(30);

    await registry.register({
      name: "LeaseAgent",
      role: "WorkerRole",
      nodeId: "node-a",
      lifecycle: "ready",
      runtime: {
        runtimeName: "fake",
        lifecycle: "ready",
        nodeId: "node-a",
        attachedAt: Date.now(),
        readyAt: Date.now(),
      },
    }, { lease: lease.id });

    assert.ok(await store.get("/agents/LeaseAgent"));
    await lease.revoke();
    assert.equal(await store.get("/agents/LeaseAgent"), null);
    assert.equal(registry.get("LeaseAgent"), undefined);
  });

  it("controller publishes only live agent presence and removes it on detach or lease expiry", async () => {
    const store = new InMemoryStateStore();
    const rc = new ReagentController({
      nodeId: "node-a",
      agentNode: new FakeNode(),
      stateStore: store,
    });

    rc.createAgentRecord("WorkerAgent", roleIR);
    assert.equal(await store.get("/agents/WorkerAgent"), null);

    const lease = await store.createLease(30);
    rc.setAgentPresenceLease(lease.id);
    rc.deployAgentTemplate("WorkerAgent", roleIR, new Map([["LeaseProto.worker", graph]]));
    rc.createAgentFromTemplate("WorkerAgent", { start: false });

    assert.ok(await store.get("/agents/WorkerAgent"));

    rc.detachAgentRuntime("WorkerAgent");
    assert.equal(await store.get("/agents/WorkerAgent"), null);

    rc.createAgentFromTemplate("WorkerAgent", { start: false });
    assert.ok(await store.get("/agents/WorkerAgent"));

    await lease.revoke();
    assert.equal(await store.get("/agents/WorkerAgent"), null);
  });
});
