/**
 * M13 Phase 8: Untested components.
 *
 * UC.1: RegistryView — createEmptyView, mergeNodeProtocols, findProtocol, findAgents
 * UC.2: diagram.ts — buildSequenceDiagram, buildStateMachineDiagram
 * UC.3: ir-validator — validateIRGraph (fork/join/scatter consistency)
 * UC.4: project.ts — scaffoldProject
 * UC.5: protocol-engine durationToMs edge cases
 *
 * Run: npx tsx runtime/tests/m13-misc.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEmptyView,
  mergeNodeProtocols,
  findProtocol,
  findAgents,
} from "../ts/src/admin/registry-view.js";
import type { RegistryView, RegistryAgentEntry } from "../ts/src/admin/registry-view.js";

import { durationToMs } from "../ts/src/core/protocol-engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, "..", "..", ".tmp-m13-misc");

const DUMMY_FINGERPRINTS = { structureHash: "abc", schemaHash: "def", implHash: "ghi" };

// ── UC.1: RegistryView ──────────────────────────────────────────────

describe("UC.1: RegistryView", () => {
  it("createEmptyView returns valid structure", () => {
    const view = createEmptyView();
    assert.deepEqual(view.nodes, []);
    assert.deepEqual(view.protocols, []);
    assert.deepEqual(view.agents, []);
    assert.ok(typeof view.timestamp === "number");
    assert.ok(view.timestamp > 0);
  });

  it("mergeNodeProtocols adds new node + protocols", () => {
    const view = createEmptyView();
    mergeNodeProtocols(view, "node-1", [
      {
        name: "Auth",
        version: "1.0.0",
        fingerprints: DUMMY_FINGERPRINTS,
        dependencies: [],
        boundAgents: ["agent-a"],
      },
    ]);
    assert.equal(view.nodes.length, 1);
    assert.equal(view.nodes[0].nodeId, "node-1");
    assert.equal(view.nodes[0].status, "connected");
    assert.equal(view.protocols.length, 1);
    assert.equal(view.protocols[0].name, "Auth");
    assert.equal(view.protocols[0].nodeId, "node-1");
  });

  it("mergeNodeProtocols upserts same protocol on same node", () => {
    const view = createEmptyView();
    mergeNodeProtocols(view, "node-1", [
      { name: "Auth", version: "1.0.0", fingerprints: DUMMY_FINGERPRINTS, dependencies: [], boundAgents: ["a"] },
    ]);
    mergeNodeProtocols(view, "node-1", [
      { name: "Auth", version: "2.0.0", fingerprints: DUMMY_FINGERPRINTS, dependencies: [], boundAgents: ["a", "b"] },
    ]);
    assert.equal(view.nodes.length, 1, "Same node should not be duplicated");
    assert.equal(view.protocols.length, 1, "Same protocol on same node should be upserted");
    assert.equal(view.protocols[0].version, "2.0.0");
    assert.deepEqual(view.protocols[0].boundAgents, ["a", "b"]);
  });

  it("mergeNodeProtocols adds same protocol from different nodes", () => {
    const view = createEmptyView();
    mergeNodeProtocols(view, "node-1", [
      { name: "Auth", version: "1.0.0", fingerprints: DUMMY_FINGERPRINTS, dependencies: [], boundAgents: [] },
    ]);
    mergeNodeProtocols(view, "node-2", [
      { name: "Auth", version: "1.0.0", fingerprints: DUMMY_FINGERPRINTS, dependencies: [], boundAgents: [] },
    ]);
    assert.equal(view.nodes.length, 2);
    assert.equal(view.protocols.length, 2, "Same protocol on different nodes = 2 entries");
  });

  it("findProtocol returns entries from multiple nodes", () => {
    const view = createEmptyView();
    mergeNodeProtocols(view, "n1", [
      { name: "Chat", version: "1.0.0", fingerprints: DUMMY_FINGERPRINTS, dependencies: [], boundAgents: [] },
    ]);
    mergeNodeProtocols(view, "n2", [
      { name: "Chat", version: "1.1.0", fingerprints: DUMMY_FINGERPRINTS, dependencies: [], boundAgents: [] },
    ]);
    const results = findProtocol(view, "Chat");
    assert.equal(results.length, 2);
  });

  it("findProtocol returns empty for unknown", () => {
    const view = createEmptyView();
    assert.deepEqual(findProtocol(view, "NonExistent"), []);
  });

  it("findAgents filters by protocolName and roleName", () => {
    const view = createEmptyView();
    const agents: RegistryAgentEntry[] = [
      { agentName: "a1", roleName: "buyer", protocolName: "Auction", nodeId: "n1", status: "running" },
      { agentName: "a2", roleName: "seller", protocolName: "Auction", nodeId: "n1", status: "running" },
      { agentName: "a3", roleName: "viewer", protocolName: "Chat", nodeId: "n1", status: "running" },
    ];
    view.agents.push(...agents);

    const auctionAgents = findAgents(view, "Auction");
    assert.equal(auctionAgents.length, 2);

    const buyers = findAgents(view, "Auction", "buyer");
    assert.equal(buyers.length, 1);
    assert.equal(buyers[0].agentName, "a1");

    const chatAgents = findAgents(view, "Chat");
    assert.equal(chatAgents.length, 1);

    const none = findAgents(view, "NonExistent");
    assert.equal(none.length, 0);
  });
});

// ── UC.2: diagram.ts ────────────────────────────────────────────────

describe("UC.2: diagram.ts — buildSequenceDiagram + buildStateMachineDiagram", () => {
  const { buildSequenceDiagram, buildStateMachineDiagram } =
    require("../../lang/src/diagram.js") as typeof import("../../lang/src/diagram.js");

  function loadGraphs(example: string): Map<string, any> {
    const dir = join(__dirname, "..", "..", "examples", "out", example);
    const files = readdirSync(dir).filter(f => f.endsWith(".ir.json"));
    const graphs = new Map<string, any>();
    for (const f of files) {
      const ir = JSON.parse(readFileSync(join(dir, f), "utf8"));
      graphs.set(ir.role, ir);
    }
    return graphs;
  }

  it("builds sequence diagram for linear protocol (14-ts-only-demo)", () => {
    const graphs = loadGraphs("14-ts-only-demo");
    assert.ok(graphs.size >= 2, "Expected at least 2 roles");

    const firstIr = [...graphs.values()][0];
    const diagram = buildSequenceDiagram(graphs, firstIr.protocolName);

    assert.ok(diagram.participants.length >= 2, "At least 2 participants");
    assert.ok(diagram.elements.length > 0, "At least 1 sequence element");
    const msgElements = diagram.elements.filter((e: any) => e.kind === "message");
    assert.ok(msgElements.length > 0, "Should have at least one message element");
  });

  it("builds sequence diagram for alt protocol (02)", () => {
    const graphs = loadGraphs("02-await-timeout-and-alt");
    const firstIr = [...graphs.values()][0];
    const diagram = buildSequenceDiagram(graphs, firstIr.protocolName);
    assert.ok(diagram.participants.length >= 2);
    assert.ok(diagram.elements.length > 0);
  });

  it("builds state machine diagram for a single role", () => {
    const graphs = loadGraphs("14-ts-only-demo");
    const [, graph] = [...graphs.entries()][0];
    const sm = buildStateMachineDiagram(graph);

    assert.ok(sm.nodes.length > 0, "At least 1 state node");
    assert.ok(sm.edges.length > 0, "At least 1 edge");
    assert.ok(
      sm.nodes.some((n: any) => n.kind === "initial"),
      "Must have initial node",
    );
    assert.ok(
      sm.nodes.some((n: any) => n.kind === "terminal"),
      "Must have terminal node",
    );
  });

  it("builds state machine diagram for scatter protocol (23)", () => {
    const graphs = loadGraphs("23-scatter-gather");
    const coordinatorGraph = graphs.get("coordinator");
    assert.ok(coordinatorGraph, "Expected coordinator role");
    const sm = buildStateMachineDiagram(coordinatorGraph);
    assert.ok(sm.nodes.length > 0);
    assert.ok(
      sm.nodes.some((n: any) => n.kind === "scatter"),
      "Must have scatter node",
    );
  });
});

// ── UC.3: ir-validator ──────────────────────────────────────────────

describe("UC.3: ir-validator edge cases", () => {
  const { validateIRGraph } = require("../../lang/src/ir-validator.js");

  it("valid linear graph passes", () => {
    const graph = {
      states: [
        { id: "s1", data: { kind: "initial" } },
        { id: "s2", data: { kind: "action" } },
        { id: "s3", data: { kind: "terminal" } },
      ],
      transitions: [
        { from: "s1", to: "s2", label: { kind: "default" } },
        { from: "s2", to: "s3", label: { kind: "default" } },
      ],
      initialStateId: "s1",
      terminalStateIds: ["s3"],
    };
    const result = validateIRGraph(graph);
    assert.ok(result.ok, `Errors: ${result.errors.map((e: any) => e.message).join(", ")}`);
    assert.equal(result.stats.stateCount, 3);
    assert.equal(result.stats.reachableCount, 3);
    assert.equal(result.stats.terminalCount, 1);
  });

  it("detects dangling transition to non-existent state", () => {
    const graph = {
      states: [
        { id: "s1", data: { kind: "initial" } },
      ],
      transitions: [
        { from: "s1", to: "s99", label: { kind: "default" } },
      ],
      initialStateId: "s1",
      terminalStateIds: ["s1"],
    };
    const result = validateIRGraph(graph);
    assert.ok(result.errors.some((e: any) => e.code === "E_DANGLING_TO"));
  });

  it("detects missing initial state", () => {
    const graph = {
      states: [{ id: "s1", data: { kind: "terminal" } }],
      transitions: [],
      initialStateId: "s_missing",
      terminalStateIds: ["s1"],
    };
    const result = validateIRGraph(graph);
    assert.ok(result.errors.some((e: any) => e.code === "E_NO_INITIAL"));
  });

  it("detects no terminal states", () => {
    const graph = {
      states: [{ id: "s1", data: { kind: "initial" } }],
      transitions: [],
      initialStateId: "s1",
      terminalStateIds: [],
    };
    const result = validateIRGraph(graph);
    assert.ok(result.errors.some((e: any) => e.code === "E_NO_TERMINAL"));
  });

  it("warns about unreachable states", () => {
    const graph = {
      states: [
        { id: "s1", data: { kind: "initial" } },
        { id: "s2", data: { kind: "terminal" } },
        { id: "s3", data: { kind: "action" } },
      ],
      transitions: [
        { from: "s1", to: "s2", label: { kind: "default" } },
      ],
      initialStateId: "s1",
      terminalStateIds: ["s2"],
    };
    const result = validateIRGraph(graph);
    assert.ok(result.ok, "Should still be ok (W_ is a warning)");
    assert.ok(result.errors.some((e: any) => e.code === "W_UNREACHABLE"));
  });

  it("validates fork/join consistency", () => {
    const graph = {
      states: [
        { id: "s1", data: { kind: "initial" } },
        { id: "fork1", data: { kind: "fork", branchStartIds: ["b1", "b_missing"] } },
        { id: "b1", data: { kind: "action" } },
        { id: "join1", data: { kind: "join", branchCount: 2 } },
        { id: "s2", data: { kind: "terminal" } },
      ],
      transitions: [
        { from: "s1", to: "fork1", label: { kind: "default" } },
        { from: "fork1", to: "b1", label: { kind: "branch" } },
        { from: "b1", to: "join1", label: { kind: "default" } },
        { from: "join1", to: "s2", label: { kind: "default" } },
      ],
      initialStateId: "s1",
      terminalStateIds: ["s2"],
    };
    const result = validateIRGraph(graph);
    assert.ok(result.errors.some((e: any) => e.code === "E_FORK_DANGLING"));
  });

  it("validates scatter with missing collection", () => {
    const graph = {
      states: [
        { id: "s1", data: { kind: "initial" } },
        { id: "sc1", data: { kind: "scatter", branchStartIds: ["b1"], collection: "" } },
        { id: "b1", data: { kind: "action" } },
        { id: "s2", data: { kind: "terminal" } },
      ],
      transitions: [
        { from: "s1", to: "sc1", label: { kind: "default" } },
        { from: "sc1", to: "b1", label: { kind: "branch" } },
        { from: "b1", to: "s2", label: { kind: "default" } },
      ],
      initialStateId: "s1",
      terminalStateIds: ["s2"],
    };
    const result = validateIRGraph(graph);
    assert.ok(result.errors.some((e: any) => e.code === "E_SCATTER_NO_COLLECTION"));
  });
});

// ── UC.4: project.ts — scaffoldProject ──────────────────────────────

describe("UC.4: scaffoldProject", () => {
  const { scaffoldProject, loadManifest } = require("../../lang/src/project.js");

  before(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
  });

  after(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("creates project structure with reagent.json", () => {
    const projectDir = join(TMP_DIR, "my-project");
    scaffoldProject(projectDir, "test-proj");
    assert.ok(existsSync(join(projectDir, "reagent.json")));
    assert.ok(existsSync(join(projectDir, "protocols")));
    assert.ok(existsSync(join(projectDir, "agents")));
    assert.ok(existsSync(join(projectDir, ".gitignore")));

    const manifest = loadManifest(projectDir);
    assert.equal(manifest.name, "test-proj");
    assert.equal(manifest.version, "0.1.0");
    assert.ok(Array.isArray(manifest.protocols));
  });

  it("uses directory basename when name is not provided", () => {
    const projectDir = join(TMP_DIR, "auto-named");
    scaffoldProject(projectDir);
    const manifest = loadManifest(projectDir);
    assert.equal(manifest.name, "auto-named");
  });
});

// ── UC.5: durationToMs edge cases ───────────────────────────────────

describe("UC.5: durationToMs edge cases", () => {
  it("handles ms, s, m, h units", () => {
    assert.equal(durationToMs({ value: 100, unit: "ms" }), 100);
    assert.equal(durationToMs({ value: 5, unit: "s" }), 5000);
    assert.equal(durationToMs({ value: 3, unit: "m" }), 180_000);
    assert.equal(durationToMs({ value: 1, unit: "h" }), 3_600_000);
  });

  it("returns raw value for unknown unit", () => {
    assert.equal(durationToMs({ value: 42, unit: "unknown" }), 42);
  });

  it("handles zero values", () => {
    assert.equal(durationToMs({ value: 0, unit: "s" }), 0);
    assert.equal(durationToMs({ value: 0, unit: "ms" }), 0);
  });
});
