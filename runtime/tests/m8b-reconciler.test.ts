/**
 * M8b Reconciler E2E Tests
 *
 * REC1: Empty cluster + DeploySpec → deploy-protocol actions
 * REC2: Existing v1.0.0 + spec v1.0.1 → upgrade-protocol
 * REC3: Dependency ordering (child deployed before parent)
 * REC4: Convergence happy path (apply plan → registry matches spec)
 * REC5: Stale agents → stop-agent actions
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcile, planSummary, type ReconciliationPlan } from "../../runtime/ts/src/reconciler.js";
import type { DeploySpec, DeployProtocolSpec, DeployAgentSpec } from "../../runtime/ts/src/deploy-spec.js";
import {
  createEmptyView,
  mergeNodeProtocols,
  type RegistryView,
} from "../../runtime/ts/src/registry-view.js";
import type { ProtocolFingerprint } from "../../runtime/ts/src/types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function fp(hash: string): ProtocolFingerprint {
  return { structureHash: hash, schemaHash: hash, implHash: hash };
}

function makeSpec(overrides: Partial<DeploySpec> = {}): DeploySpec {
  return {
    deploymentId: "test-deploy",
    protocols: [],
    agents: [],
    ...overrides,
  };
}

// ── REC1: Empty cluster + DeploySpec → deploy-protocol actions ──────

test("REC1: Empty cluster + DeploySpec → deploy-protocol actions", () => {
  const spec = makeSpec({
    protocols: [
      { name: "ProtoA", version: "1.0.0", fingerprints: fp("aaa") },
      { name: "ProtoB", version: "1.0.0", fingerprints: fp("bbb") },
    ],
    agents: [
      { agentName: "agent1", roleName: "RoleA", protocolName: "ProtoA" },
      { agentName: "agent2", roleName: "RoleB", protocolName: "ProtoB" },
    ],
  });

  const view = createEmptyView();
  view.nodes.push({ nodeId: "rc-1", status: "connected", lastSeen: Date.now() });

  const plan = reconcile(spec, view);

  assert.equal(plan.conflicts.length, 0, "No conflicts");
  const deploys = plan.actions.filter(a => a.kind === "deploy-protocol");
  assert.equal(deploys.length, 2, "Should deploy 2 protocols");
  assert.ok(deploys.some(d => d.kind === "deploy-protocol" && d.protocolName === "ProtoA"));
  assert.ok(deploys.some(d => d.kind === "deploy-protocol" && d.protocolName === "ProtoB"));

  const creates = plan.actions.filter(a => a.kind === "create-agent");
  assert.equal(creates.length, 2, "Should create 2 agents");

  console.log("  REC1: PASS");
  console.log("  Plan:\n" + planSummary(plan));
});

// ── REC2: Existing v1.0.0 + spec v1.0.1 → upgrade-protocol ────────

test("REC2: Existing v1.0.0 + spec v1.0.1 → upgrade-protocol", () => {
  const spec = makeSpec({
    protocols: [
      { name: "ProtoA", version: "1.0.1", fingerprints: fp("aaa") },
    ],
  });

  const view = createEmptyView();
  view.nodes.push({ nodeId: "rc-1", status: "connected", lastSeen: Date.now() });
  mergeNodeProtocols(view, "rc-1", [
    { name: "ProtoA", version: "1.0.0", fingerprints: fp("aaa"), dependencies: [], boundAgents: ["agent1"] },
  ]);

  const plan = reconcile(spec, view);

  assert.equal(plan.conflicts.length, 0, "No conflicts (same structure)");
  const upgrades = plan.actions.filter(a => a.kind === "upgrade-protocol");
  assert.equal(upgrades.length, 1, "Should upgrade 1 protocol");
  assert.equal(upgrades[0].kind === "upgrade-protocol" && upgrades[0].fromVersion, "1.0.0");
  assert.equal(upgrades[0].kind === "upgrade-protocol" && upgrades[0].toVersion, "1.0.1");

  console.log("  REC2: PASS");
});

// ── REC3: Dependency ordering ───────────────────────────────────────

test("REC3: Dependency ordering (child deployed before parent)", () => {
  const spec = makeSpec({
    protocols: [
      {
        name: "Parent",
        version: "1.0.0",
        fingerprints: fp("parent"),
        dependencies: [{ protocolName: "Child", version: "1.0.0", structureHash: "child" }],
      },
      {
        name: "Child",
        version: "1.0.0",
        fingerprints: fp("child"),
      },
    ],
    agents: [
      { agentName: "parentAgent", roleName: "ParentRole", protocolName: "Parent" },
      { agentName: "childAgent", roleName: "ChildRole", protocolName: "Child" },
    ],
  });

  const view = createEmptyView();
  view.nodes.push({ nodeId: "rc-1", status: "connected", lastSeen: Date.now() });

  const plan = reconcile(spec, view);

  assert.equal(plan.conflicts.length, 0, "No conflicts");
  const deploys = plan.actions.filter(a => a.kind === "deploy-protocol");
  assert.equal(deploys.length, 2);

  const childIdx = plan.actions.findIndex(a => a.kind === "deploy-protocol" && a.protocolName === "Child");
  const parentIdx = plan.actions.findIndex(a => a.kind === "deploy-protocol" && a.protocolName === "Parent");
  assert.ok(childIdx < parentIdx, "Child should be deployed before Parent");

  console.log("  REC3: PASS");
});

// ── REC4: Convergence happy path ────────────────────────────────────

test("REC4: Convergence happy path (already deployed → no actions)", () => {
  const spec = makeSpec({
    protocols: [
      { name: "ProtoA", version: "1.0.0", fingerprints: fp("aaa") },
    ],
    agents: [
      { agentName: "agent1", roleName: "RoleA", protocolName: "ProtoA" },
    ],
  });

  const view = createEmptyView();
  view.nodes.push({ nodeId: "rc-1", status: "connected", lastSeen: Date.now() });
  mergeNodeProtocols(view, "rc-1", [
    { name: "ProtoA", version: "1.0.0", fingerprints: fp("aaa"), dependencies: [], boundAgents: ["agent1"] },
  ]);
  view.agents.push({
    agentName: "agent1",
    roleName: "RoleA",
    protocolName: "ProtoA",
    nodeId: "rc-1",
    status: "running",
  });

  const plan = reconcile(spec, view);

  assert.equal(plan.conflicts.length, 0, "No conflicts");
  const deploys = plan.actions.filter(a => a.kind === "deploy-protocol");
  const creates = plan.actions.filter(a => a.kind === "create-agent");
  assert.equal(deploys.length, 0, "Already deployed — no deploy action");
  assert.equal(creates.length, 0, "Already running — no create action");

  console.log("  REC4: PASS");
});

// ── REC5: Stale agents → stop-agent ────────────────────────────────

test("REC5: Stale agents not in spec → stop-agent actions", () => {
  const spec = makeSpec({
    protocols: [
      { name: "ProtoA", version: "1.0.0", fingerprints: fp("aaa") },
    ],
    agents: [
      { agentName: "agent1", roleName: "RoleA", protocolName: "ProtoA" },
    ],
  });

  const view = createEmptyView();
  view.nodes.push({ nodeId: "rc-1", status: "connected", lastSeen: Date.now() });
  mergeNodeProtocols(view, "rc-1", [
    { name: "ProtoA", version: "1.0.0", fingerprints: fp("aaa"), dependencies: [], boundAgents: ["agent1", "staleAgent"] },
  ]);
  view.agents.push(
    { agentName: "agent1", roleName: "RoleA", protocolName: "ProtoA", nodeId: "rc-1", status: "running" },
    { agentName: "staleAgent", roleName: "RoleA", protocolName: "ProtoA", nodeId: "rc-1", status: "running" },
  );

  const plan = reconcile(spec, view);

  const stops = plan.actions.filter(a => a.kind === "stop-agent");
  assert.equal(stops.length, 1, "Should stop 1 stale agent");
  assert.equal(stops[0].kind === "stop-agent" && stops[0].agentName, "staleAgent");

  const stopIdx = plan.actions.findIndex(a => a.kind === "stop-agent");
  const createIdx = plan.actions.findIndex(a => a.kind === "create-agent");
  if (createIdx >= 0) {
    assert.ok(stopIdx < createIdx, "Stops should come before creates");
  }

  console.log("  REC5: PASS");
});
