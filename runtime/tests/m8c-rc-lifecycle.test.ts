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
import { NativeAgentNode } from "../ts/src/nodes/native-agent-node.js";
import type { IRGraph, ThinAgentIR, RoleIR } from "../ts/src/contracts/types.js";
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
  const agentNode = new NativeAgentNode({ roleToAgent: deployment.roleToAgent });
  const rc = new ReagentController({ nodeId: "lifecycle-node", agentNode });
  return { rc, deployment };
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
  const agentNode = new NativeAgentNode({ roleToAgent: {} });
  const rc = new ReagentController({ nodeId: "spawn-proto-node", agentNode });

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
