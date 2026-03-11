/**
 * DeploySpec — desired-state specification for protocol deployment.
 *
 * A DeploySpec describes what protocols should be running, which agents
 * should play which roles, and on which RC nodes. The admin reconciler
 * compares this against actual RegistryView to produce a ReconciliationPlan.
 */

import type { ProtocolFingerprint, ProtocolDependency } from "../contracts/types.js";

// ── Desired state ───────────────────────────────────────────────────

export interface DeploySpec {
  /** Unique deployment ID (e.g. project name + version) */
  deploymentId: string;
  /** Protocols to deploy */
  protocols: DeployProtocolSpec[];
  /** Agent placement */
  agents: DeployAgentSpec[];
}

export interface DeployProtocolSpec {
  name: string;
  version: string;
  fingerprints: ProtocolFingerprint;
  dependencies?: ProtocolDependency[];
  /** Path to compiled IR artifacts (directory or list of files) */
  artifactsPath?: string;
}

export interface DeployAgentSpec {
  agentName: string;
  roleName: string;
  protocolName: string;
  /** Target RC node ID. If omitted, reconciler assigns automatically. */
  targetNode?: string;
  /** Optional agent.json manifest path */
  manifest?: string;
  /** Optional native module extras */
  extras?: Record<string, unknown>;
}

// ── Loader ──────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadDeploySpec(path: string): DeploySpec {
  if (!existsSync(path)) {
    throw new Error(`Deploy spec not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  validateDeploySpec(raw, path);
  return raw as DeploySpec;
}

function validateDeploySpec(raw: unknown, path: string): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path}: expected JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.deploymentId !== "string") {
    throw new Error(`${path}: "deploymentId" is required`);
  }
  if (!Array.isArray(obj.protocols)) {
    throw new Error(`${path}: "protocols" must be an array`);
  }
  if (!Array.isArray(obj.agents)) {
    throw new Error(`${path}: "agents" must be an array`);
  }
}

/**
 * Build a DeploySpec from compiled output.
 * Reads deployment.json + lock file to populate protocol metadata.
 */
export function buildDeploySpecFromBuild(
  outDir: string,
  deploymentId: string,
): DeploySpec {
  const deploymentPath = resolve(outDir, "deployment.json");
  const lockPath = resolve(outDir, "..", "reagent.lock");

  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  let lock: Record<string, any> = {};
  if (existsSync(lockPath)) {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  }

  const protocols: DeployProtocolSpec[] = [];
  const seenProtos = new Set<string>();

  for (const agent of deployment.agents) {
    for (const role of agent.roles) {
      if (seenProtos.has(role.protocolName)) continue;
      seenProtos.add(role.protocolName);

      const lockEntry = lock.protocols?.[role.protocolName];
      protocols.push({
        name: role.protocolName,
        version: lockEntry?.version ?? "0.0.0",
        fingerprints: lockEntry?.fingerprints ?? { structureHash: "", schemaHash: "", implHash: "" },
        artifactsPath: outDir,
      });
    }
  }

  const agents: DeployAgentSpec[] = deployment.agents.map((a: any) => ({
    agentName: a.agentName,
    roleName: a.roleName,
    protocolName: a.roles[0]?.protocolName ?? "",
  }));

  return { deploymentId, protocols, agents };
}
