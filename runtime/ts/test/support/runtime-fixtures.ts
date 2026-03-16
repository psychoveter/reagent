import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ReagentController, type ReagentControllerConfig } from "../../src/controller/reagent-controller.js";
import { ManagedBehaviorFactory } from "../../src/nodes/managed/managed-behavior-factory.js";
import { AgentShellImpl } from "../../src/core/agent-shell-impl.js";
import type { AgentIR, IRGraph, ThinAgentIR, RoleIR } from "../../src/contracts/types.js";
import { resolveAgentIR } from "../../src/contracts/types.js";

export type FixtureGraphEntry = { proto: string; role: string };

export type FixtureAgentDef = {
  name: string;
  graphEntries: FixtureGraphEntry[];
};

export type FixtureDeployment = { roleToAgent: Record<string, string> };

export type LoadedRoleIR = {
  thin: ThinAgentIR;
  roleIR: RoleIR;
  agentIR: AgentIR;
};

export function loadRoleIR(dir: string, agentName: string): LoadedRoleIR {
  const thin: ThinAgentIR = JSON.parse(readFileSync(join(dir, `${agentName}.agent.json`), "utf8"));
  const roleIR: RoleIR = JSON.parse(readFileSync(join(dir, thin.roleFile), "utf8"));
  const agentIR = resolveAgentIR(thin, roleIR);
  return { thin, roleIR, agentIR };
}

export function loadGraph(dir: string, proto: string, role: string): IRGraph {
  return JSON.parse(readFileSync(join(dir, `${proto}.${role}.ir.json`), "utf8"));
}

export function buildGraphs(dir: string, graphEntries: readonly FixtureGraphEntry[]): Map<string, IRGraph> {
  const graphs = new Map<string, IRGraph>();
  for (const entry of graphEntries) {
    graphs.set(`${entry.proto}.${entry.role}`, loadGraph(dir, entry.proto, entry.role));
  }
  return graphs;
}

export function loadDeploymentFrom(dir: string): FixtureDeployment {
  return JSON.parse(readFileSync(join(dir, "deployment.json"), "utf8"));
}

export function registerFixtureAgent(
  rc: ReagentController,
  dir: string,
  agent: FixtureAgentDef,
): LoadedRoleIR {
  const loaded = loadRoleIR(dir, agent.name);
  rc.registerAgent(agent.name, loaded.roleIR, buildGraphs(dir, agent.graphEntries));
  return loaded;
}

export function registerFixtureAgents(
  rc: ReagentController,
  dir: string,
  agents: readonly FixtureAgentDef[],
): void {
  for (const agent of agents) {
    registerFixtureAgent(rc, dir, agent);
  }
}

export function createSingleNodeSetup(
  dir: string,
  agents: readonly FixtureAgentDef[],
  controllerConfig: Partial<ReagentControllerConfig> = {},
): {
  rc: ReagentController;
  deployment: FixtureDeployment;
} {
  const deployment = loadDeploymentFrom(dir);
  const behaviorFactory = controllerConfig.behaviorFactory ?? new ManagedBehaviorFactory();
  const rc = new ReagentController({
    ...controllerConfig,
    nodeId: controllerConfig.nodeId ?? "test-node",
    behaviorFactory,
  });

  registerFixtureAgents(rc, dir, agents);
  return { rc, deployment };
}

export function getHandle(rc: ReagentController, name: string): AgentShellImpl {
  return rc.getAgent(name) as AgentShellImpl;
}

export async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 1_000,
  intervalMs = 10,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}
