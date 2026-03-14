/**
 * M8c RC lifecycle tests
 *
 * Verifies the new RC ontology split:
 * ProtocolArtifacts -> AgentTemplate -> AgentRecord -> AgentRuntime
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { ReagentController } from "../ts/src/controller/reagent-controller.js";
import { InMemoryStateStore } from "../ts/src/cluster/state-store.js";
import { ManagedBehaviorFactory } from "../ts/src/nodes/managed-behavior-factory.js";
import { createInMemoryLinkPair } from "../ts/src/network/inmemory-node-link.js";
import type { IRGraph, ThinAgentIR, RoleIR } from "../ts/src/contracts/types.js";
import type { ProtocolRunRecord } from "../ts/src/contracts/protocol-run.js";
import { parseProgram } from "../../lang/src/parser.js";
import { emitIR, emitRoleIR, resetIdCounter } from "../../lang/src/ir-emitter.js";
import type { ProtocolDef, RoleDef } from "../../lang/src/ast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "examples", "out", "14-ts-only-demo");

function loadRoleIR(dir: string, agentName: string): RoleIR {
  const thin: ThinAgentIR = JSON.parse(readFileSync(join(dir, `${agentName}.agent.json`), "utf8"));
  return JSON.parse(readFileSync(join(dir, thin.roleFile), "utf8"));
}

function loadGraph(dir: string, proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(dir, `${proto}.${role}.ir.json`), "utf8"));
}

function loadDeploymentFrom(dir: string): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, "deployment.json"), "utf8"));
}

function createController() {
  const deployment = loadDeploymentFrom(FIXTURES_DIR);
  const factory = new ManagedBehaviorFactory();
  const rc = new ReagentController({ nodeId: "lifecycle-node", behaviorFactory: factory });
  return { rc, deployment };
}

async function waitFor<T>(fn: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 1000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

function compileSpawnSource(src: string) {
  const res = parseProgram(src);
  assert.ok(res.ok, `Parse failed: ${res.errors.map((e) => e.message).join(", ")}`);

  const protocols = res.ast.items.filter((i): i is ProtocolDef => i.kind === "ProtocolDef");
  const roles = res.ast.items.filter((i): i is RoleDef => i.kind === "RoleDef");
  const roleMap = new Map<string, RoleDef>();
  for (const role of roles) roleMap.set(role.name, role);

  const graphs = new Map<string, IRGraph>();
  const roleIRs = new Map<string, RoleIR>();

  for (const proto of protocols) {
    resetIdCounter();
    const result = emitIR(proto);
    assert.ok(result.ok);
    for (const [role, graph] of result.graphs) {
      graphs.set(`${proto.name}.${role}`, graph);
    }
  }

  for (const role of roles) {
    const result = emitRoleIR(role, roleMap);
    assert.ok(result.ok);
    roleIRs.set(role.name, result.roleIR);
  }

  return { graphs, roleIRs };
}

test("L1: AgentRecord can exist without AgentRuntime", async () => {
  const { rc } = createController();
  const roleIR = loadRoleIR(FIXTURES_DIR, "ClientAgent");
  const graphs = new Map<string, IRGraph>([
    ["TsDemo.client", loadGraph(FIXTURES_DIR, "TsDemo", "client")],
  ]);

  const template = rc.deployAgentTemplate("ClientAgent", roleIR, graphs);
  const record = rc.createAgentRecord("ClientAgent", roleIR, template.templateId, template.extras);

  assert.equal(record.lifecycle, "declared");
  assert.equal(rc.hasAgent("ClientAgent"), false, "Declared record should not imply attached runtime");
  assert.equal(rc.getAgent("ClientAgent"), undefined);
  assert.equal(rc.resolveRoleBinding("TsDemo", "client"), undefined, "Declared record should not be addressable");

  await rc.stop();
});

test("L2: createAgentFromTemplate attaches runtime after record creation", async () => {
  const { rc } = createController();
  const roleIR = loadRoleIR(FIXTURES_DIR, "ClientAgent");
  const graphs = new Map<string, IRGraph>([
    ["TsDemo.client", loadGraph(FIXTURES_DIR, "TsDemo", "client")],
  ]);

  rc.deployAgentTemplate("ClientAgent", roleIR, graphs);
  rc.createAgentRecord("ClientAgent", roleIR, "ClientAgent:ClientRole");
  rc.createAgentFromTemplate("ClientAgent");

  const beforeStart = rc.getAgentRecord("ClientAgent");
  assert.ok(beforeStart);
  assert.equal(beforeStart.runtime?.lifecycle, "attached");
  assert.equal(rc.hasAgent("ClientAgent"), true);

  await rc.start();

  const afterStart = rc.getAgentRecord("ClientAgent");
  assert.ok(afterStart);
  assert.equal(afterStart.lifecycle, "ready");
  assert.equal(afterStart.runtime?.lifecycle, "ready");
  assert.equal(rc.resolveRoleBinding("TsDemo", "client"), "ClientAgent");

  await rc.stop();
});

test("L3: destroyAgent removes detached record without runtime", async () => {
  const { rc } = createController();
  const roleIR = loadRoleIR(FIXTURES_DIR, "ClientAgent");
  const graphs = new Map<string, IRGraph>([
    ["TsDemo.client", loadGraph(FIXTURES_DIR, "TsDemo", "client")],
  ]);

  const template = rc.deployAgentTemplate("ClientAgent", roleIR, graphs);
  rc.createAgentRecord("ClientAgent", roleIR, template.templateId, template.extras);

  await rc.destroyAgent("ClientAgent");

  assert.equal(rc.getAgentRecord("ClientAgent"), undefined);
  assert.equal(rc.hasAgent("ClientAgent"), false);

  await rc.stop();
});

test("L4: spawnRoleInstance creates attached runtime from a deployed role template", async () => {
  const { rc } = createController();
  const roleIR = loadRoleIR(FIXTURES_DIR, "HandlerAgent");
  const graphs = new Map<string, IRGraph>([
    ["TsDemo.handler", loadGraph(FIXTURES_DIR, "TsDemo", "handler")],
  ]);

  rc.deployAgentTemplate("HandlerAgent", roleIR, graphs);

  const spawnedName = rc.spawnRoleInstance(roleIR.roleName, { labels: { source: "spawn" } }, "instance-1");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const record = rc.getAgentRecord(spawnedName);
  assert.ok(record);
  assert.equal(rc.hasAgent(spawnedName), true);
  assert.equal(record.runtime?.lifecycle, "ready");

  await rc.destroyAgent(spawnedName);
  await rc.stop();
});

test("L5: spawnAgentRecord remains available for logical-only record creation", async () => {
  const { rc } = createController();

  const spawnedName = rc.spawnAgentRecord("WorkerRole", { labels: { source: "spawn" } }, "instance-1");
  const record = rc.getAgentRecord(spawnedName);

  assert.ok(record);
  assert.equal(record.lifecycle, "declared");
  assert.equal(record.runtime, undefined);
  assert.equal(rc.hasAgent(spawnedName), false);

  await rc.destroyAgent(spawnedName);
  await rc.stop();
});

test("L6: protocol-level role spawn attaches agent and lets it participate via bindAs", async () => {
  const source = `
message Ping { text: string }
message Pong { text: string }

protocol SpawnProto {
  participants:
    mgr [ts] initiator,
    worker [ts] dynamic
  supervision: detached

  trigger on invoke with Ping {
    resolve mgr = single
  }

  mgr spawns WorkerRole({ seed: "ok" }) as worker -> $ctx.workerRef
  mgr --> worker: Ping = {
    onSend {
      $ctx.msg.text = "hello"
    }
    onReceive {
      $self.seen = $ctx.msg.text
    }
  }
  worker --> mgr: Pong = {
    onSend {
      $ctx.msg.text = "done:" + $self.seen
    }
    onReceive {
      $self.lastSpawned = $ctx.workerRef
      $self.lastResult = $ctx.msg.text
    }
  }
}

role ManagerRole [ts] {
  plays SpawnProto as mgr
}

role WorkerRole [ts] {
  plays SpawnProto as worker
}
`;

  const { graphs, roleIRs } = compileSpawnSource(source);
  const factory = new ManagedBehaviorFactory();
  const rc = new ReagentController({ nodeId: "spawn-proto-node", behaviorFactory: factory });

  rc.deployAgentTemplate("WorkerTemplate", roleIRs.get("WorkerRole")!, new Map([
    ["SpawnProto.worker", graphs.get("SpawnProto.worker")!],
  ]));
  rc.registerAgent("ManagerAgent", roleIRs.get("ManagerRole")!, new Map([
    ["SpawnProto.mgr", graphs.get("SpawnProto.mgr")!],
  ]));

  await rc.start();

  const instanceId = randomUUID();
  rc.triggerProtocol("ManagerAgent", {
    instanceId,
    protocolName: "SpawnProto",
    input: {},
    roleToAgent: { "SpawnProto.mgr": "ManagerAgent" },
  });

  const manager = rc.getAgent("ManagerAgent") as any;
  await manager.waitForCompletion(1, 5000);

  const managerSelf = manager.getSelf();
  assert.equal(managerSelf.lastResult, "done:hello");
  assert.equal(typeof managerSelf.lastSpawned, "string");

  const spawnedName = managerSelf.lastSpawned as string;
  assert.equal(rc.hasAgent(spawnedName), true);

  const spawnedRecord = rc.getAgentRecord(spawnedName);
  assert.ok(spawnedRecord);
  assert.equal(spawnedRecord.runtime?.lifecycle, "ready");

  const spawnedHandle = rc.getAgent(spawnedName) as any;
  assert.ok(spawnedHandle);
  assert.equal(spawnedHandle.getSelf().seen, "hello");

  await rc.stop();
});

test("L7: protocol runs persist durable record with spawn lineage", async () => {
  const source = `
message Ping { text: string }
message Pong { text: string }

protocol SpawnProto {
  participants:
    mgr [ts] initiator,
    worker [ts] dynamic
  supervision: detached

  trigger on invoke with Ping {
    resolve mgr = single
  }

  mgr spawns WorkerRole({ seed: "ok" }) as worker -> $ctx.workerRef
  mgr --> worker: Ping = {
    onSend {
      $ctx.msg.text = "hello"
    }
  }
  worker --> mgr: Pong = {
    onSend {
      $ctx.msg.text = "done"
    }
    onReceive {
      $self.lastSpawned = $ctx.workerRef
    }
  }
}

role ManagerRole [ts] {
  plays SpawnProto as mgr
}

role WorkerRole [ts] {
  plays SpawnProto as worker
}
`;

  const { graphs, roleIRs } = compileSpawnSource(source);
  const stateStore = new InMemoryStateStore();
  const rc = new ReagentController({
    nodeId: "run-record-node",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
  });

  rc.deployAgentTemplate("WorkerTemplate", roleIRs.get("WorkerRole")!, new Map([
    ["SpawnProto.worker", graphs.get("SpawnProto.worker")!],
  ]));
  rc.registerAgent("ManagerAgent", roleIRs.get("ManagerRole")!, new Map([
    ["SpawnProto.mgr", graphs.get("SpawnProto.mgr")!],
  ]));

  await rc.start();

  const instanceId = randomUUID();
  rc.triggerProtocol("ManagerAgent", {
    instanceId,
    protocolName: "SpawnProto",
    input: {},
    roleToAgent: { "SpawnProto.mgr": "ManagerAgent" },
  });

  const manager = rc.getAgent("ManagerAgent") as any;
  await manager.waitForCompletion(1, 5000);

  const inspected = await waitFor(
    () => rc.inspectProtocolRun(instanceId),
    (value) => !!value.record && value.record.spawnedAgents.length === 1 && value.record.status === "completed",
  );

  assert.ok(inspected.record);
  assert.equal(inspected.record.homeNodeId, "run-record-node");
  assert.equal(inspected.record.rootInstanceId, instanceId);
  assert.equal(inspected.record.status, "completed");
  assert.equal(inspected.record.supervisionStrategy, "detached");
  assert.equal(inspected.record.spawnedAgents.length, 1);
  assert.equal(inspected.record.spawnedAgents[0].roleName, "WorkerRole");
  assert.equal(inspected.record.roles.mgr?.status, "completed");

  await rc.stop();
  await stateStore.close();
});

test("L8: cancelProtocolRun marks a durable running record as cancelling before convergence", async () => {
  const stateStore = new InMemoryStateStore();
  const rc = new ReagentController({
    nodeId: "cancel-record-node",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
  });
  const instanceId = randomUUID();

  await stateStore.put(`/protocol-runs/${instanceId}`, JSON.stringify({
    instanceId,
    protocolName: "WaitProto",
    status: "running",
    homeNodeId: "cancel-record-node",
    relationKind: "root",
    supervisionStrategy: "scoped",
    rootInstanceId: instanceId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    ownerAgentName: "ManagerAgent",
    ownerRoleName: "mgr",
    roles: {
      mgr: {
        agentName: "ManagerAgent",
        roleName: "mgr",
        nodeId: "cancel-record-node",
        status: "running",
        updatedAt: Date.now(),
      },
    },
    childInstanceIds: [],
    spawnedAgents: [],
  } satisfies ProtocolRunRecord));

  const cancelled = await rc.cancelProtocolRun(instanceId, "test cancel");
  assert.equal(cancelled, true);

  const cancelledRecord = await waitFor(
    async () => (await rc.inspectProtocolRun(instanceId)).record,
    (value): value is ProtocolRunRecord => !!value && value.status === "cancelling",
  );
  assert.equal(cancelledRecord.status, "cancelling");
  assert.equal(cancelledRecord.cancellation?.requestedByNodeId, "cancel-record-node");

  await rc.stop();
  await stateStore.close();
});

test("L9: cleanupSpawnedAgents destroys non-persistent spawned runtimes for one protocol instance", async () => {
  const { rc } = createController();
  const roleIR = loadRoleIR(FIXTURES_DIR, "HandlerAgent");
  const graphs = new Map<string, IRGraph>([
    ["TsDemo.handler", loadGraph(FIXTURES_DIR, "TsDemo", "handler")],
  ]);

  rc.deployAgentTemplate("HandlerAgent", roleIR, graphs);

  const instanceId = "cleanup-instance";
  const spawnedName = rc.spawnRoleInstance(roleIR.roleName, {}, instanceId);
  await waitFor(() => rc.getAgent(spawnedName), (value) => value != null);

  rc.cleanupSpawnedAgents(instanceId);

  await waitFor(() => rc.getAgent(spawnedName), (value) => value == null);
  await rc.stop();
});

test("L10: node departure adopts scoped orphaned protocol run and cancels it conservatively", async () => {
  const stateStore = new InMemoryStateStore();
  const seenStatuses: string[] = [];
  const watch = stateStore.watch("/protocol-runs/", (event) => {
    if (event.kind === "delete" || event.key !== "/protocol-runs/orphan-1") return;
    const record = JSON.parse(String(event.value)) as ProtocolRunRecord;
    seenStatuses.push(record.status);
  });
  const rc = new ReagentController({
    nodeId: "survivor-node",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
  });

  const record: ProtocolRunRecord = {
    instanceId: "orphan-1",
    protocolName: "DemoProto",
    status: "running",
    homeNodeId: "lost-node",
    relationKind: "root",
    supervisionStrategy: "scoped",
    rootInstanceId: "orphan-1",
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
  };
  await stateStore.put("/protocol-runs/orphan-1", JSON.stringify(record));

  await rc.handleNodeDeparture("lost-node");

  const inspected = await rc.inspectProtocolRun("orphan-1");
  assert.ok(inspected.record);
  assert.equal(inspected.record.status, "cancelled");
  assert.equal(inspected.record.adoptedByNodeId, "survivor-node");
  assert.equal(inspected.record.homeNodeId, "survivor-node");
  assert.match(inspected.record.failureReason ?? "", /left cluster/);
  assert.ok(seenStatuses.includes("adopting"), "adoption should expose an adopting intermediate state");
  const adoptionLocks = await stateStore.list("/protocol-runs-adoption-locks/");
  assert.equal(adoptionLocks.length, 0, "record-level CAS should not create separate adoption lock keys");

  watch.dispose();
  await rc.stop();
  await stateStore.close();
});

test("L10b: node departure lets one-for-one orphan adoption continue with a replacement owner", async () => {
  const source = `
message Kick {}

protocol AdoptProto {
  participants:
    owner [ts] initiator
  supervision: one-for-one

  trigger on invoke with Kick {
    resolve owner = single
  }

  owner {
    wait 5s
  }
}

role OwnerRole [ts] {
  plays AdoptProto as owner
}
`;

  const { graphs, roleIRs } = compileSpawnSource(source);
  const stateStore = new InMemoryStateStore();
  const seenStatuses: string[] = [];
  const watch = stateStore.watch("/protocol-runs/", (event) => {
    if (event.kind === "delete" || event.key !== "/protocol-runs/orphan-resume") return;
    const record = JSON.parse(String(event.value)) as ProtocolRunRecord;
    seenStatuses.push(record.status);
  });
  const rc = new ReagentController({
    nodeId: "survivor-node",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
  });
  rc.registerAgent("ReplacementOwner", roleIRs.get("OwnerRole")!, new Map([
    ["AdoptProto.owner", graphs.get("AdoptProto.owner")!],
  ]));

  await rc.start();
  await stateStore.put("/protocol-runs/orphan-resume", JSON.stringify({
    instanceId: "orphan-resume",
    protocolName: "AdoptProto",
    status: "running",
    homeNodeId: "lost-node",
    relationKind: "root",
    supervisionStrategy: "one-for-one",
    rootInstanceId: "orphan-resume",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    ownerAgentName: "LostOwner",
    ownerRoleName: "owner",
    roles: {
      owner: {
        agentName: "LostOwner",
        roleName: "owner",
        nodeId: "lost-node",
        status: "running",
        updatedAt: Date.now(),
      },
    },
    childInstanceIds: [],
    spawnedAgents: [],
    participantLosses: [],
  } satisfies ProtocolRunRecord));

  await rc.handleNodeDeparture("lost-node");

  const inspected = await waitFor(
    async () => (await rc.inspectProtocolRun("orphan-resume")).record,
    (value): value is ProtocolRunRecord =>
      !!value
      && value.status === "running"
      && value.roles.owner?.agentName === "ReplacementOwner",
    5000,
  );
  assert.equal(inspected.homeNodeId, "survivor-node");
  assert.equal(inspected.adoptedByNodeId, "survivor-node");
  assert.ok(seenStatuses.includes("adopting"), "resume path should still expose adoption");
  assert.equal(inspected.participantLosses?.[0]?.replacementAgentName, "ReplacementOwner");

  watch.dispose();
  await rc.stop();
  await stateStore.close();
});

test("L11: initiator-shell loss is treated as participant loss while home RC survives", async () => {
  const stateStore = new InMemoryStateStore();
  const rc = new ReagentController({
    nodeId: "home-rc-node",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
  });
  const roleIR = loadRoleIR(FIXTURES_DIR, "ClientAgent");
  const graphs = new Map<string, IRGraph>([
    ["TsDemo.client", loadGraph(FIXTURES_DIR, "TsDemo", "client")],
  ]);
  rc.registerAgent("ManagerAgent", roleIR, graphs);

  await rc.start();

  const instanceId = "detached-initiator-run";
  await stateStore.put(`/protocol-runs/${instanceId}`, JSON.stringify({
    instanceId,
    protocolName: "TsDemo",
    status: "running",
    homeNodeId: "home-rc-node",
    relationKind: "root",
    supervisionStrategy: "scoped",
    rootInstanceId: instanceId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    ownerAgentName: "ManagerAgent",
    ownerRoleName: "client",
    roles: {
      client: {
        agentName: "ManagerAgent",
        roleName: "client",
        nodeId: "home-rc-node",
        status: "running",
        updatedAt: Date.now(),
      },
    },
    childInstanceIds: [],
    spawnedAgents: [],
    participantLosses: [],
  } satisfies ProtocolRunRecord));

  const shell = rc.getAgent("ManagerAgent");
  assert.ok(shell);
  shell.detachBehavior();

  const failedRecord = await waitFor(
    async () => (await rc.inspectProtocolRun(instanceId)).record,
    (value): value is ProtocolRunRecord => !!value && value.status === "failed",
    5000,
  );
  assert.equal(failedRecord.homeNodeId, "home-rc-node");
  assert.notEqual(failedRecord.status, "orphaned");
  assert.notEqual(failedRecord.status, "adopting");
  assert.equal(failedRecord.participantLosses?.length, 1);
  assert.match(failedRecord.failureReason ?? "", /detached/);

  await rc.stop();
  await stateStore.close();
});

test("L12: home RC re-resolves lost participant to a replacement agent when one exists", async () => {
  const stateStore = new InMemoryStateStore();
  const rc = new ReagentController({
    nodeId: "repair-node",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
  });
  const roleIR = loadRoleIR(FIXTURES_DIR, "HandlerAgent");
  const graphs = new Map<string, IRGraph>([
    ["TsDemo.handler", loadGraph(FIXTURES_DIR, "TsDemo", "handler")],
  ]);
  rc.registerAgent("WorkerA", roleIR, graphs);
  rc.registerAgent("WorkerB", roleIR, graphs);

  await rc.start();

  const seeded: ProtocolRunRecord = {
    instanceId: "repair-run",
    protocolName: "TsDemo",
    status: "running",
    homeNodeId: "repair-node",
    relationKind: "root",
    supervisionStrategy: "scoped",
    rootInstanceId: "repair-run",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    ownerAgentName: "WorkerA",
    ownerRoleName: "handler",
    roles: {
      handler: {
        agentName: "WorkerA",
        roleName: "handler",
        nodeId: "repair-node",
        status: "running",
        updatedAt: Date.now(),
      },
    },
    childInstanceIds: [],
    spawnedAgents: [],
    participantLosses: [],
  };
  await stateStore.put("/protocol-runs/repair-run", JSON.stringify(seeded));

  await rc.agentRegistry.deregister("WorkerA");
  const workerAShell = rc.getAgent("WorkerA");
  assert.ok(workerAShell);
  workerAShell.detachBehavior();

  const repaired = await waitFor(
    async () => (await rc.inspectProtocolRun("repair-run")).record,
    (value): value is ProtocolRunRecord => !!value && value.roles.handler?.agentName === "WorkerB",
    5000,
  );
  assert.equal(repaired.status, "running");
  assert.equal(repaired.roles.handler?.agentName, "WorkerB");
  assert.equal(repaired.participantLosses?.[0]?.replacementAgentName, "WorkerB");

  await rc.stop();
  await stateStore.close();
});

test("L13: distributed cancellation converges through shared protocol-run watch state", async () => {
  const managerGraph: IRGraph = {
    protocolName: "CancelProto",
    role: "mgr",
    lang: "ts",
    supervisionStrategy: "scoped",
    participants: [
      { name: "mgr", lang: "ts", binding: "static", cardinality: "single", initiator: true },
      { name: "worker", lang: "ts", binding: "static", cardinality: "single", initiator: false },
    ],
    states: [
      { id: "init", kind: "initial", data: { kind: "initial" } },
      { id: "send", kind: "send", data: { kind: "send", to: "worker", arrow: "-->", messageName: "Ping" } },
      { id: "end", kind: "terminal", data: { kind: "terminal", status: "completed" } },
    ],
    transitions: [
      { from: "init", to: "send", label: { kind: "default" } },
      { from: "send", to: "end", label: { kind: "default" } },
    ],
    initialStateId: "init",
    terminalStateIds: ["end"],
  };
  const workerGraph: IRGraph = {
    protocolName: "CancelProto",
    role: "worker",
    lang: "ts",
    supervisionStrategy: "scoped",
    participants: managerGraph.participants,
    states: [
      { id: "init", kind: "initial", data: { kind: "initial" } },
      { id: "recv", kind: "receive", data: { kind: "receive", from: "mgr", arrow: "-->", messageName: "Ping" } },
      { id: "wait", kind: "timer", data: { kind: "timer", duration: { value: 5000, unit: "ms" } } },
      { id: "end", kind: "terminal", data: { kind: "terminal", status: "completed" } },
    ],
    transitions: [
      { from: "init", to: "recv", label: { kind: "default" } },
      { from: "recv", to: "wait", label: { kind: "default" } },
      { from: "wait", to: "end", label: { kind: "default" } },
    ],
    initialStateId: "init",
    terminalStateIds: ["end"],
  };
  const managerRoleIR: RoleIR = {
    roleName: "ManagerRole",
    lang: "ts",
    plays: [{ protocolName: "CancelProto", roleName: "mgr" }],
    lifecycleHandlers: [],
  };
  const workerRoleIR: RoleIR = {
    roleName: "WorkerRole",
    lang: "ts",
    plays: [{ protocolName: "CancelProto", roleName: "worker" }],
    lifecycleHandlers: [],
  };
  const stateStore = new InMemoryStateStore();
  const rcHome = new ReagentController({
    nodeId: "node-home",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
  });
  const rcRemote = new ReagentController({
    nodeId: "node-remote",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
  });
  const [homeLink, remoteLink] = createInMemoryLinkPair("node-home", "node-remote");
  rcHome.addNodeLink(homeLink);
  rcRemote.addNodeLink(remoteLink);
  rcHome.registerAgent("ManagerAgent", managerRoleIR, new Map([
    ["CancelProto.mgr", managerGraph],
  ]));
  rcRemote.registerAgent("WorkerAgent", workerRoleIR, new Map([
    ["CancelProto.worker", workerGraph],
  ]));
  rcHome.registerRemoteAgent("WorkerAgent", "node-remote");
  rcRemote.registerRemoteAgent("ManagerAgent", "node-home");

  await rcHome.start();
  await rcRemote.start();

  const remoteShell = rcRemote.getAgent("WorkerAgent");
  assert.ok(remoteShell);
  const trigger = {
    instanceId: "cancel-watch-run",
    protocolName: "CancelProto",
    input: {},
    roleToAgent: {
      "CancelProto.mgr": "ManagerAgent",
      "CancelProto.worker": "WorkerAgent",
    },
  };
  rcRemote.triggerProtocol("WorkerAgent", trigger);
  rcHome.triggerProtocol("ManagerAgent", trigger);
  await new Promise((resolve) => setTimeout(resolve, 200));

  await rcHome.cancelProtocolRun("cancel-watch-run", "cluster cancellation");

  const converged = await waitFor(
    async () => (await rcHome.inspectProtocolRun("cancel-watch-run")).record,
    (value): value is ProtocolRunRecord =>
      !!value
      && value.status === "cancelled"
      && value.roles.worker?.status === "cancelled",
    5000,
  );
  assert.equal(converged.cancellation?.requestedByNodeId, "node-home");
  assert.equal(remoteShell.getActiveRuns().has("cancel-watch-run"), false, "remote watch path should cancel the live worker run");

  await rcHome.stop();
  await rcRemote.stop();
  await stateStore.close();
});

test("L14: local finished-run retention is bounded while durable protocol-run records remain inspectable", async () => {
  const source = `
message Ping {}

protocol QuickProto {
  participants:
    mgr [ts] initiator
  trigger on invoke with Ping {
    resolve mgr = single
  }

  mgr {
    $ctx.done = true
  }
}

role ManagerRole [ts] {
  plays QuickProto as mgr
}
`;

  const { graphs, roleIRs } = compileSpawnSource(source);
  const stateStore = new InMemoryStateStore();
  const rc = new ReagentController({
    nodeId: "retention-node",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
    finishedRunRetentionLimit: 1,
  });
  rc.registerAgent("ManagerAgent", roleIRs.get("ManagerRole")!, new Map([
    ["QuickProto.mgr", graphs.get("QuickProto.mgr")!],
  ]));

  await rc.start();

  const shell = rc.getAgent("ManagerAgent");
  assert.ok(shell);
  rc.triggerProtocol("ManagerAgent", {
    instanceId: "quick-1",
    protocolName: "QuickProto",
    input: {},
    roleToAgent: { "QuickProto.mgr": "ManagerAgent" },
  });
  rc.triggerProtocol("ManagerAgent", {
    instanceId: "quick-2",
    protocolName: "QuickProto",
    input: {},
    roleToAgent: { "QuickProto.mgr": "ManagerAgent" },
  });

  await shell.waitForCompletion(2, 5000);

  const first = await waitFor(
    async () => (await rc.inspectProtocolRun("quick-1")).record,
    (value): value is ProtocolRunRecord => !!value && value.status === "completed",
    5000,
  );
  const second = await waitFor(
    async () => (await rc.inspectProtocolRun("quick-2")).record,
    (value): value is ProtocolRunRecord => !!value && value.status === "completed",
    5000,
  );

  assert.equal(shell.getCompletedRuns().length, 1, "local completion history should respect retention limit");
  assert.equal(shell.getCompletedRuns()[0].instanceId, "quick-2");
  assert.equal(shell.getInstances().has("quick-1"), false, "evicted finished run should disappear from local instances");
  assert.equal(shell.getInstances().has("quick-2"), true);
  assert.equal(first.status, "completed", "durable protocol record should remain inspectable after local eviction");
  assert.equal(second.status, "completed");

  await rc.stop();
  await stateStore.close();
});

test("L15: startup reconciliation cleans non-persistent spawned agents from durable lineage after restart", async () => {
  const stateStore = new InMemoryStateStore();
  const rc = new ReagentController({
    nodeId: "restart-node",
    behaviorFactory: new ManagedBehaviorFactory(),
    stateStore,
  });
  const roleIR = loadRoleIR(FIXTURES_DIR, "HandlerAgent");
  const graphs = new Map<string, IRGraph>([
    ["TsDemo.handler", loadGraph(FIXTURES_DIR, "TsDemo", "handler")],
  ]);
  const spawnedName = "RestartSpawnedAgent";

  rc.deployAgentTemplate(spawnedName, roleIR, graphs);
  rc.createAgentRecord(spawnedName, roleIR, `${spawnedName}:HandlerRole`);
  rc.createAgentFromTemplate(spawnedName);

  await stateStore.put("/protocol-runs/restart-cleanup", JSON.stringify({
    instanceId: "restart-cleanup",
    protocolName: "TsDemo",
    status: "failed",
    homeNodeId: "restart-node",
    relationKind: "root",
    supervisionStrategy: "scoped",
    rootInstanceId: "restart-cleanup",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    completedAt: Date.now(),
    ownerAgentName: "ManagerAgent",
    ownerRoleName: "client",
    failureReason: "already terminated",
    roles: {
      client: {
        agentName: "ManagerAgent",
        roleName: "client",
        nodeId: "restart-node",
        status: "failed",
        updatedAt: Date.now(),
      },
    },
    childInstanceIds: [],
    spawnedAgents: [{
      agentName: spawnedName,
      roleName: roleIR.roleName,
      persistent: false,
      createdAt: Date.now(),
    }],
    participantLosses: [],
  } satisfies ProtocolRunRecord));

  await rc.start();

  await waitFor(
    () => rc.getAgent(spawnedName),
    (value) => value == null,
    5000,
  );

  await rc.stop();
  await stateStore.close();
});
