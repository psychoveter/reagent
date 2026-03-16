/**
 * Claude node config types and loaders.
 *
 * Pure config layer — no Claude SDK dependency. These types define the
 * wrapper config shape that claude-node.ts reads at startup.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

export type ClaudeToolsConfig =
  | string[]
  | { type: "preset"; preset: "claude_code" };

export type ClaudeMcpServersConfig = Record<string, Record<string, unknown>>;

export interface ClaudeLiveAgentSettings {
  tools?: ClaudeToolsConfig;
  mcpServers?: ClaudeMcpServersConfig;
  maxTurns?: number;
  permissionMode?: ClaudePermissionMode;
  extraInstructions?: string;
  eventWaitTimeoutMs?: number;
  model?: string;
  cwd?: string;
}

export interface ClaudeLiveAgentNodeConfig<TRuntime = Record<string, unknown>> {
  kind: "claude_live_agent_node";
  runtime: TRuntime;
  agent: {
    name: string;
    roles: string[];
  };
  claude?: ClaudeLiveAgentSettings;
}

export interface LoadedClaudeLiveAgentNodeConfig {
  configPath: string;
  configDir: string;
  config: ClaudeLiveAgentNodeConfig<Record<string, unknown>>;
}

export function loadClaudeLiveAgentNodeConfig(configPath: string): LoadedClaudeLiveAgentNodeConfig {
  const resolvedPath = resolve(configPath);
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as ClaudeLiveAgentNodeConfig<Record<string, unknown>>;
  if (parsed.kind !== "claude_live_agent_node") {
    throw new Error(`Unsupported config kind in ${resolvedPath}: ${String((parsed as { kind?: unknown }).kind ?? "")}`);
  }
  if (!parsed.runtime || typeof parsed.runtime !== "object") {
    throw new Error(`Missing runtime section in ${resolvedPath}`);
  }
  if (!parsed.agent || typeof parsed.agent.name !== "string" || !Array.isArray(parsed.agent.roles)) {
    throw new Error(`Missing agent section in ${resolvedPath}`);
  }
  return {
    configPath: resolvedPath,
    configDir: dirname(resolvedPath),
    config: parsed,
  };
}

export function resolveClaudeCwd(
  configDir: string,
  settings?: ClaudeLiveAgentSettings,
): string | undefined {
  if (!settings?.cwd) return undefined;
  return isAbsolute(settings.cwd) ? settings.cwd : resolve(configDir, settings.cwd);
}
