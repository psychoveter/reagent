/**
 * Agent manifest (agent.json) — defines an agent's identity, role binding,
 * native module, and static config.
 *
 * Format:
 *   { "name": "alice", "role": "GreeterRole", "module": "./impl.ts", "config": { ... } }
 *
 * - name: agent name (overrides inline `agent X runs Y` from .rg)
 * - role: single role name (composition via `role extends`)
 * - module: path to native code module whose default export becomes $agent
 * - config: static config passed to the module on load
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface AgentManifest {
  name: string;
  role: string;
  module?: string;
  config?: Record<string, unknown>;
}

export function loadAgentManifest(manifestPath: string): AgentManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Agent manifest not found: ${manifestPath}`);
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(raw, manifestPath);
  return raw as AgentManifest;
}

function validateManifest(raw: unknown, path: string): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path}: expected JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name) {
    throw new Error(`${path}: "name" is required (string)`);
  }
  if (typeof obj.role !== "string" || !obj.role) {
    throw new Error(`${path}: "role" is required (string)`);
  }
  if (obj.module !== undefined && typeof obj.module !== "string") {
    throw new Error(`${path}: "module" must be a string path`);
  }
}

/**
 * Load the native module specified by agent.json and return its default export.
 * The module export becomes the `$agent` binding in zones.
 */
export async function loadAgentModule(
  manifestPath: string,
  manifest: AgentManifest,
): Promise<Record<string, unknown> | undefined> {
  if (!manifest.module) return undefined;

  const baseDir = dirname(resolve(manifestPath));
  const modulePath = resolve(baseDir, manifest.module);

  const moduleUrl = pathToFileURL(modulePath).href;
  const mod = await import(moduleUrl);

  const exported = mod.default ?? mod;
  if (typeof exported === "function") {
    return exported(manifest.config ?? {});
  }
  return exported;
}
