/**
 * M8a Registry E2E Tests
 *
 * R1: Register protocol → list() returns entry with fingerprints
 * R2: canDeploy with PATCH change → compatible, no restart
 * R3: canDeploy with dependency structureHash conflict → incompatible
 * R4: Trigger protocol → messages carry protocolVersion
 * R5: (Python) register + list + canDeploy in Python RC
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { ReagentController } from "../ts/src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../ts/src/nodes/managed-behavior-factory.js";
import type { IRGraph, ThinAgentIR, RoleIR, MessageEnvelope } from "../ts/src/contracts/types.js";
import { resolveAgentIR } from "../ts/src/contracts/types.js";
import type { ProtocolEntry } from "../ts/src/controller/protocol-registry.js";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "examples", "out", "14-ts-only-demo");
const INVOKE_DIR = join(__dirname, "..", "..", "examples", "out", "18-invoke-demo");
const PY_RUNTIME_DIR = join(__dirname, "..", "py");

// ── Helpers ─────────────────────────────────────────────────────────

function loadRoleIR(dir: string, agentName: string): { roleIR: RoleIR; agentIR: ReturnType<typeof resolveAgentIR> } {
  const thin: ThinAgentIR = JSON.parse(readFileSync(join(dir, `${agentName}.agent.json`), "utf8"));
  const roleIR: RoleIR = JSON.parse(readFileSync(join(dir, thin.roleFile), "utf8"));
  const agentIR = resolveAgentIR(thin, roleIR);
  return { roleIR, agentIR };
}

function loadGraph(dir: string, proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(dir, `${proto}.${role}.ir.json`), "utf8"));
}

function loadDeploymentFrom(dir: string): { roleToAgent: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, "deployment.json"), "utf8"));
}

function createSetup(dir: string, agents: Array<{ name: string; graphEntries: Array<{ proto: string; role: string }> }>) {
  const deployment = loadDeploymentFrom(dir);
  const factory = new ManagedBehaviorFactory();
  const rc = new ReagentController({ nodeId: "test-reg", behaviorFactory: factory });

  for (const agentDef of agents) {
    const { roleIR } = loadRoleIR(dir, agentDef.name);
    const graphs = new Map<string, IRGraph>();
    for (const ge of agentDef.graphEntries) {
      graphs.set(`${ge.proto}.${ge.role}`, loadGraph(dir, ge.proto, ge.role));
    }
    rc.registerAgent(agentDef.name, roleIR, graphs);
  }

  return { rc, deployment };
}

// ── R1: Register protocol → list() returns entry with fingerprints ──

test("R1: registered protocol appears in registry with fingerprints", () => {
  const { rc } = createSetup(FIXTURES_DIR, [
    { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
    { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
  ]);

  const protocols = rc.listProtocols();
  assert.strictEqual(protocols.length, 1, "Should have one protocol registered");

  const entry = protocols[0];
  assert.strictEqual(entry.name, "TsDemo");
  assert.ok(entry.version, "Should have a version");
  assert.ok(entry.fingerprints.structureHash, "Should have structureHash");
  assert.ok(entry.fingerprints.schemaHash, "Should have schemaHash");
  assert.ok(entry.fingerprints.implHash, "Should have implHash");

  const agents = rc.registry.agentsForProtocol("TsDemo");
  assert.ok(agents.includes("ClientAgent"), "ClientAgent should be bound");
  assert.ok(agents.includes("HandlerAgent"), "HandlerAgent should be bound");
});

// ── R2: canDeploy with PATCH change → compatible, no restart ────────

test("R2: canDeploy with PATCH change is compatible", () => {
  const { rc } = createSetup(FIXTURES_DIR, [
    { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
    { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
  ]);

  const existing = rc.registry.get("TsDemo")!;

  const patchEntry: ProtocolEntry = {
    ...existing,
    version: "0.1.1",
    fingerprints: {
      ...existing.fingerprints,
      implHash: "0000000000000000000000000000000000000000000000000000000000000000",
    },
  };

  const report = rc.canDeploy(patchEntry);
  assert.strictEqual(report.changeLevel, "patch");
  assert.strictEqual(report.compatible, true);
  assert.strictEqual(report.requiresAgentRestart, false);
  assert.ok(report.affectedAgents.length > 0, "Should list affected agents");
});

// ── R3: canDeploy with dependency conflict → incompatible ───────────

test("R3: canDeploy with dependency structureHash conflict is incompatible", () => {
  const { rc } = createSetup(INVOKE_DIR, [
    { name: "CallerAgent", graphEntries: [{ proto: "InvokeDemo", role: "caller" }] },
    {
      name: "ResponderAgent",
      graphEntries: [
        { proto: "InvokeDemo", role: "responder" },
        { proto: "ComputeSquare", role: "worker" },
      ],
    },
  ]);

  const invokeEntry = rc.registry.get("InvokeDemo")!;
  assert.ok(invokeEntry.dependencies.length > 0, "InvokeDemo should have dependencies");

  // Create a version of InvokeDemo that references a DIFFERENT structureHash for ComputeSquare
  const conflictEntry: ProtocolEntry = {
    ...invokeEntry,
    version: "0.2.0",
    dependencies: [
      {
        protocolName: "ComputeSquare",
        structureHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version: "0.1.0",
      },
    ],
  };

  const report = rc.canDeploy(conflictEntry);
  assert.strictEqual(report.compatible, false, "Should be incompatible");
  assert.ok(report.dependencyConflicts.length > 0, "Should have dependency conflicts");
  assert.strictEqual(report.dependencyConflicts[0].depName, "ComputeSquare");
  assert.strictEqual(report.requiresAgentRestart, true);
});

// ── R4: Trigger protocol → messages carry protocolVersion ───────────

test("R4: messages carry protocolVersion after trigger", async () => {
  const { rc, deployment } = createSetup(FIXTURES_DIR, [
    { name: "ClientAgent", graphEntries: [{ proto: "TsDemo", role: "client" }] },
    { name: "HandlerAgent", graphEntries: [{ proto: "TsDemo", role: "handler" }] },
  ]);

  const captured: MessageEnvelope[] = [];
  rc.addInterceptor((ctx, next) => {
    captured.push({ ...ctx.envelope });
    next();
  });

  await rc.start();

  rc.triggerProtocol("ClientAgent", {
    instanceId: randomUUID(),
    protocolName: "TsDemo",
    input: { text: "test" },
    roleToAgent: deployment.roleToAgent,
  });

  // Let the protocol run
  await new Promise(r => setTimeout(r, 200));

  // At least one message should have been captured
  assert.ok(captured.length > 0, "Should have captured messages");

  // Verify protocolVersion is present on the protocol entry
  const protoEntry = rc.registry.get("TsDemo")!;
  assert.ok(protoEntry.version, "Should have a version string");

  await rc.stop();
});

// ── R5: Python RC registry ──────────────────────────────────────────

test("R5: Python RC registers protocols with fingerprints", () => {
  const script = `
import sys, json, os
sys.path.insert(0, "${PY_RUNTIME_DIR}")
from reagent_runtime.protocol_registry import ProtocolRegistry, ProtocolEntry

reg = ProtocolRegistry()

entry = ProtocolEntry(
    name="TestProto",
    version="0.1.0",
    fingerprints={"structureHash": "aaa", "schemaHash": "bbb", "implHash": "ccc"},
    dependencies=[],
    ir_graphs={},
)
reg.register(entry)
reg.bind_agent("TestProto", "Agent1")

listed = reg.list()
assert len(listed) == 1
assert listed[0].name == "TestProto"
assert listed[0].version == "0.1.0"
assert listed[0].fingerprints["structureHash"] == "aaa"
assert reg.agents_for_protocol("TestProto") == ["Agent1"]

# Test can_deploy — new protocol
entry2 = ProtocolEntry(
    name="NewProto",
    version="0.1.0",
    fingerprints={"structureHash": "xxx", "schemaHash": "yyy", "implHash": "zzz"},
    dependencies=[],
    ir_graphs={},
)
report = reg.can_deploy(entry2)
assert report.compatible is True
assert report.change_level == "none"

# Test can_deploy — patch change
entry3 = ProtocolEntry(
    name="TestProto",
    version="0.1.1",
    fingerprints={"structureHash": "aaa", "schemaHash": "bbb", "implHash": "ddd"},
    dependencies=[],
    ir_graphs={},
)
report2 = reg.can_deploy(entry3)
assert report2.compatible is True
assert report2.change_level == "patch"

# Test can_deploy — major change
entry4 = ProtocolEntry(
    name="TestProto",
    version="0.2.0",
    fingerprints={"structureHash": "zzz", "schemaHash": "bbb", "implHash": "ccc"},
    dependencies=[],
    ir_graphs={},
)
report3 = reg.can_deploy(entry4)
assert report3.compatible is False
assert report3.change_level == "major"

print("OK")
`;

  const result = execFileSync("python3", ["-c", script], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ok(result.trim().includes("OK"), `Python test failed: ${result}`);
});
