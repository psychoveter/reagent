/**
 * M6 AdminClient / NodeControlEndpoint tests.
 *
 * Validates the final control-plane split:
 * - declarative cluster truth via StateStore
 * - imperative node operations via NodeControlEndpoint
 * - AdminClient acting as a stateless tool-side SDK
 */

import { InMemoryStateStore } from "../ts/src/cluster/state-store.js";
import { AdminClient } from "../ts/src/admin/client.js";
import { NodeControlEndpoint } from "../ts/src/admin/node-control-endpoint.js";
import { ProxiedStateStoreProvider } from "../ts/src/admin/state-store-provider.js";

type TestResult = { name: string; passed: boolean; error?: string };

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function withNode(
  nodeId: string,
  store: InMemoryStateStore,
  handler: (op: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<{ url: string; close(): Promise<void> }> {
  const endpoint = new NodeControlEndpoint({
    port: 0,
    handler,
  });
  const port = await endpoint.start();
  const url = `ws://127.0.0.1:${port}`;
  await store.put(`/nodes/${nodeId}`, JSON.stringify({
    nodeId,
    startedAt: new Date().toISOString(),
    control: { kind: "ws", url },
  }));
  return {
    url,
    close: async () => {
      await endpoint.stop();
    },
  };
}

async function testT21(): Promise<TestResult> {
  const name = "T21: cluster status reads shared StateStore";
  const store = new InMemoryStateStore();
  let node: { close(): Promise<void> } | null = null;
  try {
    await store.put("/agents/Alice", JSON.stringify({
      name: "Alice",
      role: "Requester",
      nodeId: "node-a",
      lifecycle: "ready",
      tags: [],
      capabilities: [],
      labels: {},
      metadata: { protocolName: "Demo" },
      runtime: { runtimeName: "ts", lifecycle: "ready", nodeId: "node-a" },
    }));
    node = await withNode("node-a", store, async (op) => {
      if (op === "InspectNode") {
        return {
          nodeId: "node-a",
          agents: [{ name: "Alice", lang: "ts", route: "local (node-a)" }],
          protocols: [{ name: "Demo", version: "1.0", agents: ["Alice"], graphs: ["Demo.Requester"] }],
          routing: { "Demo.Requester": "Alice" },
          agentNodes: ["node-a"],
        };
      }
      throw new Error(`Unexpected op: ${op}`);
    });

    const client = new AdminClient({
      stateStoreProvider: { getStateStore: async () => store },
    });

    const status = await client.clusterStatus();
    const nodes = status.payload.nodes as Array<{ nodeId: string }>;
    const agents = status.payload.agents as Array<{ agentName: string }>;
    const protocols = status.payload.protocols as Array<{ name: string }>;

    assert(nodes.length === 1 && nodes[0].nodeId === "node-a", "should list node from StateStore");
    assert(agents.length === 1 && agents[0].agentName === "Alice", "should list agent from StateStore");
    assert(protocols.length === 1 && protocols[0].name === "Demo", "should aggregate protocol via node inspect");

    await node.close();
    await store.close();
    return { name, passed: true };
  } catch (err) {
    if (node) await node.close();
    await store.close();
    return { name, passed: false, error: String(err) };
  }
}

async function testT22(): Promise<TestResult> {
  const name = "T22: inspect-node goes directly to node endpoint";
  const store = new InMemoryStateStore();
  let node: { close(): Promise<void> } | null = null;
  try {
    node = await withNode("node-b", store, async (op) => {
      assert(op === "InspectNode", "inspect should call node endpoint");
      return {
        nodeId: "node-b",
        agents: [{ name: "WorkerAgent", lang: "ts", route: "local (node-b)" }],
        protocols: [],
        routing: {},
        agentNodes: ["node-b"],
        projectedState: { knownAgents: ["WorkerAgent"] },
      };
    });

    const client = new AdminClient({
      stateStoreProvider: { getStateStore: async () => store },
    });
    const inspect = await client.inspectNode("node-b");
    assert(inspect.payload.nodeId === "node-b", "inspect should return target node payload");
    assert(((inspect.payload.projectedState as Record<string, unknown>).knownAgents as string[])[0] === "WorkerAgent", "inspect should surface projected state");

    await node.close();
    await store.close();
    return { name, passed: true };
  } catch (err) {
    if (node) await node.close();
    await store.close();
    return { name, passed: false, error: String(err) };
  }
}

async function testT23(): Promise<TestResult> {
  const name = "T23: trigger resolves agent owner through StateStore";
  const store = new InMemoryStateStore();
  let node: { close(): Promise<void> } | null = null;
  try {
    let triggered = false;
    node = await withNode("node-c", store, async (op, payload) => {
      if (op === "TriggerProtocol") {
        triggered = true;
        assert(payload.agentName === "OwnerAgent", "trigger should target resolved owner agent");
        assert(payload.protocolName === "Delegation", "trigger should forward protocol name");
        return { accepted: true };
      }
      if (op === "InspectNode") {
        return { nodeId: "node-c", agents: [], protocols: [], routing: {}, agentNodes: ["node-c"] };
      }
      throw new Error(`Unexpected op: ${op}`);
    });

    await store.put("/agents/OwnerAgent", JSON.stringify({
      name: "OwnerAgent",
      role: "Manager",
      nodeId: "node-c",
      lifecycle: "ready",
      tags: [],
      capabilities: [],
      labels: {},
      metadata: { protocolName: "Delegation" },
      runtime: { runtimeName: "ts", lifecycle: "ready", nodeId: "node-c" },
    }));

    const client = new AdminClient({
      stateStoreProvider: { getStateStore: async () => store },
    });
    const response = await client.triggerProtocol({
      agentName: "OwnerAgent",
      protocolName: "Delegation",
      input: { task: "demo" },
    });
    assert(triggered, "trigger should reach the resolved node endpoint");
    assert(response.payload.nodeId === "node-c", "response should identify resolved owner node");

    await node.close();
    await store.close();
    return { name, passed: true };
  } catch (err) {
    if (node) await node.close();
    await store.close();
    return { name, passed: false, error: String(err) };
  }
}

async function testT24(): Promise<TestResult> {
  const name = "T24: deploy fans out to reachable node endpoints";
  const store = new InMemoryStateStore();
  let nodeA: { close(): Promise<void> } | null = null;
  let nodeB: { close(): Promise<void> } | null = null;
  try {
    const deployed: string[] = [];
    nodeA = await withNode("node-a", store, async (op) => {
      if (op === "DeployProject") {
        deployed.push("node-a");
        return { deployedAgents: ["AgentA"] };
      }
      if (op === "InspectNode") {
        return { nodeId: "node-a", agents: [], protocols: [], routing: {}, agentNodes: ["node-a"] };
      }
      throw new Error(`Unexpected op: ${op}`);
    });
    nodeB = await withNode("node-b", store, async (op) => {
      if (op === "DeployProject") {
        deployed.push("node-b");
        return { deployedAgents: ["AgentB"] };
      }
      if (op === "InspectNode") {
        return { nodeId: "node-b", agents: [], protocols: [], routing: {}, agentNodes: ["node-b"] };
      }
      throw new Error(`Unexpected op: ${op}`);
    });

    const client = new AdminClient({
      stateStoreProvider: { getStateStore: async () => store },
    });
    const response = await client.deployProject({
      deployment: { agents: [], roleToAgent: {} },
      irGraphs: {},
      roleIRs: {},
    });
    const nodes = response.payload.nodes as Array<{ nodeId: string; deployedAgents: string[] }>;
    assert(deployed.length === 2, "deploy should fan out to all reachable nodes");
    assert(nodes.length === 2, "deploy response should aggregate node results");

    await nodeA.close();
    await nodeB.close();
    await store.close();
    return { name, passed: true };
  } catch (err) {
    if (nodeA) await nodeA.close();
    if (nodeB) await nodeB.close();
    await store.close();
    return { name, passed: false, error: String(err) };
  }
}

async function testT25(): Promise<TestResult> {
  const name = "T25: proxied StateStoreProvider mirrors direct state reads";
  const store = new InMemoryStateStore();
  let node: { close(): Promise<void> } | null = null;
  try {
    await store.put("/agents/ProjectedAgent", JSON.stringify({
      name: "ProjectedAgent",
      role: "Observer",
      nodeId: "node-proxy",
      lifecycle: "ready",
      tags: [],
      capabilities: [],
      labels: {},
      metadata: {},
      runtime: { runtimeName: "ts", lifecycle: "ready", nodeId: "node-proxy" },
    }));

    node = await withNode("node-proxy", store, async (op, payload) => {
      if (op === "StoreGet") {
        const value = await store.get(String(payload.key));
        return { value };
      }
      if (op === "StoreList") {
        const entries = await store.list(String(payload.prefix));
        return { entries };
      }
      if (op === "InspectNode") {
        return { nodeId: "node-proxy", agents: [], protocols: [], routing: {}, agentNodes: ["node-proxy"] };
      }
      throw new Error(`Unexpected op: ${op}`);
    });

    const proxied = new ProxiedStateStoreProvider(node.url);
    const proxyStore = await proxied.getStateStore();
    const directValue = await store.get("/agents/ProjectedAgent");
    const proxiedValue = await proxyStore.get("/agents/ProjectedAgent");
    const proxiedList = await proxyStore.list("/agents/");

    assert(proxiedValue === directValue, "proxied store get should match direct store");
    assert(proxiedList.length === 1 && proxiedList[0].key === "/agents/ProjectedAgent", "proxied store list should match direct store");

    await node.close();
    await store.close();
    return { name, passed: true };
  } catch (err) {
    if (node) await node.close();
    await store.close();
    return { name, passed: false, error: String(err) };
  }
}

async function testT26(): Promise<TestResult> {
  const name = "T26: protocol-run list/inspect/cancel use StateStore plus home-node control endpoint";
  const store = new InMemoryStateStore();
  let node: { close(): Promise<void> } | null = null;
  try {
    let cancelCalled = false;
    await store.put("/protocol-runs/run-1", JSON.stringify({
      instanceId: "run-1",
      protocolName: "Demo",
      status: "running",
      homeNodeId: "node-run",
      relationKind: "root",
      supervisionStrategy: "scoped",
      rootInstanceId: "run-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      ownerAgentName: "OwnerAgent",
      ownerRoleName: "owner",
      roles: {
        owner: {
          agentName: "OwnerAgent",
          roleName: "owner",
          nodeId: "node-run",
          status: "running",
          updatedAt: Date.now(),
        },
      },
      childInstanceIds: ["run-1-child"],
      spawnedAgents: [],
    }));
    await store.put("/protocol-runs/run-1-child", JSON.stringify({
      instanceId: "run-1-child",
      protocolName: "ChildDemo",
      status: "completed",
      homeNodeId: "node-run",
      relationKind: "invoke",
      supervisionStrategy: "scoped",
      rootInstanceId: "run-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      completedAt: Date.now(),
      parentInstanceId: "run-1",
      parentProtocolName: "Demo",
      ownerAgentName: "OwnerAgent",
      ownerRoleName: "owner",
      roles: {},
      childInstanceIds: [],
      spawnedAgents: [],
    }));

    node = await withNode("node-run", store, async (op, payload) => {
      if (op === "CancelProtocolRun") {
        cancelCalled = true;
        assert(payload.instanceId === "run-1", "cancel should target requested protocol run");
        return { instanceId: "run-1", cancelled: true };
      }
      if (op === "InspectNode") {
        return { nodeId: "node-run", agents: [], protocols: [], routing: {}, agentNodes: ["node-run"] };
      }
      throw new Error(`Unexpected op: ${op}`);
    });

    const client = new AdminClient({
      stateStoreProvider: { getStateStore: async () => store },
    });

    const listed = await client.listProtocolRuns();
    const inspected = await client.inspectProtocolRun("run-1");
    const cancelled = await client.cancelProtocolRun("run-1");

    assert((listed.payload.total as number) === 2, "listProtocolRuns should read store-backed records");
    assert((inspected.payload.found as boolean) === true, "inspectProtocolRun should find stored record");
    assert(((inspected.payload.children as Array<{ instanceId: string }>)[0]?.instanceId) === "run-1-child", "inspect should expand stored child lineage");
    assert(cancelCalled, "cancel should route to the home node control endpoint");
    assert((cancelled.payload.cancelled as boolean) === true, "cancelProtocolRun should surface endpoint acknowledgement");

    await node.close();
    await store.close();
    return { name, passed: true };
  } catch (err) {
    if (node) await node.close();
    await store.close();
    return { name, passed: false, error: String(err) };
  }
}

async function testT27(): Promise<TestResult> {
  const name = "T27: inspect/list surface cancelling protocol runs with acknowledgement metadata";
  const store = new InMemoryStateStore();
  try {
    await store.put("/protocol-runs/run-cancelling", JSON.stringify({
      instanceId: "run-cancelling",
      protocolName: "Demo",
      status: "cancelling",
      homeNodeId: "node-run",
      relationKind: "root",
      supervisionStrategy: "detached",
      rootInstanceId: "run-cancelling",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      ownerAgentName: "OwnerAgent",
      ownerRoleName: "owner",
      cancellation: {
        requestedAt: Date.now(),
        requestedByNodeId: "node-run",
        reason: "operator cancel",
        acknowledgedRoleNames: ["owner"],
        acknowledgedNodeIds: ["node-run"],
      },
      roles: {
        owner: {
          agentName: "OwnerAgent",
          roleName: "owner",
          nodeId: "node-run",
          status: "cancelled",
          updatedAt: Date.now(),
        },
      },
      childInstanceIds: [],
      spawnedAgents: [],
      participantLosses: [],
    }));

    const client = new AdminClient({
      stateStoreProvider: { getStateStore: async () => store },
    });

    const listed = await client.listProtocolRuns();
    const inspected = await client.inspectProtocolRun("run-cancelling");
    const listedRecord = (listed.payload.runs as Array<Record<string, unknown>>)[0];
    const inspectedRecord = inspected.payload.record as Record<string, unknown>;
    const cancellation = inspectedRecord.cancellation as Record<string, unknown>;

    assert((listed.payload.total as number) === 1, "list should include cancelling protocol run");
    assert(listedRecord.status === "cancelling", "list should preserve non-terminal cancelling state");
    assert(inspectedRecord.supervisionStrategy === "detached", "inspect should surface persisted supervision strategy");
    assert(cancellation.requestedByNodeId === "node-run", "inspect should surface cancellation metadata");
    assert(Array.isArray(cancellation.acknowledgedNodeIds), "inspect should surface acknowledgement arrays");

    await store.close();
    return { name, passed: true };
  } catch (err) {
    await store.close();
    return { name, passed: false, error: String(err) };
  }
}

async function main() {
  console.log("=== M6 AdminClient / NodeControlEndpoint Tests ===\n");

  const results = [
    await testT21(),
    await testT22(),
    await testT23(),
    await testT24(),
    await testT25(),
    await testT26(),
    await testT27(),
  ];

  let passed = 0;
  for (const result of results) {
    if (result.passed) {
      console.log(`  ✓ ${result.name}`);
      passed++;
    } else {
      console.error(`  ✗ ${result.name}\n    ${result.error}`);
    }
  }

  console.log(`\n${passed} passed, ${results.length - passed} failed out of ${results.length}`);
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
