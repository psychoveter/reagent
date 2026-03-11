#!/usr/bin/env node
/**
 * Config-driven Claude live-agent for Reagent protocols.
 *
 * Primary environment:
 *   ANTHROPIC_API_KEY  — required
 *   CLAUDE_NODE_CONFIG — path to Claude live-agent node wrapper config
 *   MCP_GATE_PATH      — path to mcp-gate.js
 *
 * Legacy fallback environment:
 *   MCP_RUNTIME_CONFIG, AGENT_NAME, AGENT_ROLES, MAX_TURNS,
 *   EVENT_WAIT_TIMEOUT_MS, AGENT_EXTRA_INSTRUCTIONS
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { loadClaudeLiveAgentNodeConfig, resolveClaudeCwd, type ClaudeToolsConfig, type ClaudeMcpServersConfig, type ClaudePermissionMode } from "./config.js";

type ReagentEvent = {
  instanceId: string;
  protocolName: string;
  role: string;
  seq: number;
  type: string;
  stateId?: string;
  body?: string;
  lang?: string;
  isAsync?: boolean;
  ctx?: Record<string, unknown>;
  self?: Record<string, unknown>;
  error?: string;
};

type AgentResponse =
  | { type: "ctx_update"; ctx: Record<string, unknown> }
  | { type: "noop" }
  | { type: "return_value"; value: unknown }
  | { type: "break_requested" }
  | { type: "error_thrown"; error: string };

const agentName = process.env.AGENT_NAME ?? process.env.WORKER_AGENT ?? "WorkerAgent";
const roles = (process.env.AGENT_ROLES ?? process.env.WORKER_ROLES ?? "WorkerRole")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const runtimeConfigPath = process.env.MCP_RUNTIME_CONFIG;
const nodeConfigPath = process.env.CLAUDE_NODE_CONFIG;
const maxTurns = parseInt(process.env.MAX_TURNS ?? "4", 10);
const eventWaitTimeoutMs = parseInt(process.env.EVENT_WAIT_TIMEOUT_MS ?? "5000", 10);
const extraInstructions = process.env.AGENT_EXTRA_INSTRUCTIONS?.trim() ?? "";
const mcpGatePath = process.env.MCP_GATE_PATH
  ?? path.resolve("/opt/reagent/dist/mcp-gate.js");
let activeAgentName = agentName;

type ResolvedLiveAgentConfig = {
  agentName: string;
  roles: string[];
  runtimeConfigPath: string;
  nodeConfigPath?: string;
  maxTurns: number;
  eventWaitTimeoutMs: number;
  extraInstructions: string;
  permissionMode: ClaudePermissionMode;
  tools: ClaudeToolsConfig;
  mcpServers?: ClaudeMcpServersConfig;
  model?: string;
  cwd?: string;
  cleanup: () => void;
};

function log(message: string): void {
  process.stderr.write(`[live-agent ${activeAgentName}] ${message}\n`);
}

function emitJson(kind: string, payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    ts: new Date().toISOString(),
    agentName: payload.agentName ?? agentName,
    kind,
    ...payload,
  })}\n`);
}

function buildMcpGateArgs(resolved: ResolvedLiveAgentConfig): string[] {
  const args = [mcpGatePath];
  if (resolved.runtimeConfigPath) {
    args.push("--runtime-config", resolved.runtimeConfigPath);
    return args;
  }
  throw new Error("Embedded runtime config is required for live-agent.ts");
}

function resolveLiveAgentConfig(): ResolvedLiveAgentConfig {
  if (nodeConfigPath) {
    const loaded = loadClaudeLiveAgentNodeConfig(nodeConfigPath);
    const tempDir = mkdtempSync(join(tmpdir(), "reagent-claude-live-agent-"));
    const embeddedRuntimePath = join(tempDir, "runtime-config.json");
    writeFileSync(embeddedRuntimePath, JSON.stringify(loaded.config.runtime, null, 2));
    return {
      agentName: loaded.config.agent.name,
      roles: loaded.config.agent.roles,
      runtimeConfigPath: embeddedRuntimePath,
      nodeConfigPath: loaded.configPath,
      maxTurns: loaded.config.claude?.maxTurns ?? maxTurns,
      eventWaitTimeoutMs: loaded.config.claude?.eventWaitTimeoutMs ?? eventWaitTimeoutMs,
      extraInstructions: loaded.config.claude?.extraInstructions?.trim() ?? extraInstructions,
      permissionMode: loaded.config.claude?.permissionMode ?? "bypassPermissions",
      tools: loaded.config.claude?.tools ?? [],
      mcpServers: loaded.config.claude?.mcpServers,
      model: loaded.config.claude?.model,
      cwd: resolveClaudeCwd(loaded.configDir, loaded.config.claude),
      cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  if (runtimeConfigPath) {
    return {
      agentName,
      roles,
      runtimeConfigPath,
      maxTurns,
      eventWaitTimeoutMs,
      extraInstructions,
      permissionMode: "bypassPermissions",
      tools: [],
      cleanup: () => {},
    };
  }

  throw new Error("CLAUDE_NODE_CONFIG or MCP_RUNTIME_CONFIG is required for live-agent.ts");
}

async function callJsonTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args }) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = result.content?.find((item: { type?: string; text?: string }) => item.type === "text")?.text ?? "";
  if (!text) {
    throw new Error(`Tool ${name} returned no text payload`);
  }
  return JSON.parse(text) as T;
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text.trim();
}

async function askClaudeForResponse(
  event: ReagentEvent,
  resolved: ResolvedLiveAgentConfig,
): Promise<AgentResponse> {
  const systemPrompt = `You are a headless Reagent protocol participant.

You receive one protocol event at a time and must return ONLY a JSON object.
Valid response shapes:
- {"type":"ctx_update","ctx":{...}}
- {"type":"noop"}
- {"type":"return_value","value":...}
- {"type":"break_requested"}
- {"type":"error_thrown","error":"..."}

Rules:
- Output JSON only. No markdown, no commentary.
- Prefer {"type":"ctx_update","ctx":...} for action, pre_send_action, and post_receive_action events.
- Preserve all existing ctx fields unless the event body clearly tells you to replace or add them.
- If the event body says "Set ..." then make sure those fields exist in ctx after your response.
- Treat ctx and self as plain JSON objects.
- Keep summaries concise and concrete.
${resolved.extraInstructions ? `- Extra instructions: ${resolved.extraInstructions}` : ""}`;

  const prompt = `Agent name: ${resolved.agentName}
Roles: ${resolved.roles.join(", ")}
Event JSON:
${JSON.stringify(event, null, 2)}

Return the JSON response now.`;

  const conversation = query({
    prompt,
    options: {
      systemPrompt,
      cwd: resolved.cwd,
      model: resolved.model,
      mcpServers: resolved.mcpServers as Record<string, never> | undefined,
      permissionMode: resolved.permissionMode,
      allowDangerouslySkipPermissions: resolved.permissionMode === "bypassPermissions",
      maxTurns: resolved.maxTurns,
      tools: resolved.tools,
    },
  });

  let textOutput = "";
  for await (const msg of conversation) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          textOutput += block.text;
        }
      }
    } else if (msg.type === "result" && !textOutput && msg.subtype === "success") {
      textOutput = msg.result;
    }
  }

  const jsonText = extractJsonObject(textOutput);
  return JSON.parse(jsonText) as AgentResponse;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }

  const resolved = resolveLiveAgentConfig();
  activeAgentName = resolved.agentName;

  const transport = new StdioClientTransport({
    command: "node",
    args: buildMcpGateArgs(resolved),
    stderr: "pipe",
  });
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk) => {
      process.stderr.write(`[mcp-gate:${agentName}] ${chunk.toString()}`);
    });
  }

  const client = new Client({
    name: "reagent-claude-live-agent",
    version: "0.1.0",
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await callJsonTool(client, "reagent_unregister", {});
    } catch {
      // ignore shutdown errors
    }
    try {
      await transport.close();
    } catch {
      // ignore shutdown errors
    }
    resolved.cleanup();
  };

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  try {
    await client.connect(transport);
    await callJsonTool(client, "reagent_register", {
      agentName: resolved.agentName,
      roles: resolved.roles,
    });
    emitJson("registered", {
      agentName: resolved.agentName,
      roles: resolved.roles,
      runtimeConfigPath: resolved.runtimeConfigPath,
      nodeConfigPath: resolved.nodeConfigPath,
    });

    while (!shuttingDown) {
      let events: ReagentEvent[];
      try {
        events = await callJsonTool<ReagentEvent[]>(client, "reagent_wait_for_events", {
          timeout_ms: resolved.eventWaitTimeoutMs,
          max_events: 1,
        });
      } catch (err) {
        if (shuttingDown || String(err).includes("Not connected")) {
          break;
        }
        throw err;
      }

      if (!Array.isArray(events) || events.length === 0) {
        continue;
      }

      for (const event of events) {
        emitJson("event", {
          agentName: resolved.agentName,
          instanceId: event.instanceId,
          protocolName: event.protocolName,
          role: event.role,
          eventType: event.type,
          stateId: event.stateId,
        });

        if (event.type === "protocol_completed" || event.type === "protocol_failed") {
          emitJson("lifecycle", {
            agentName: resolved.agentName,
            instanceId: event.instanceId,
            protocolName: event.protocolName,
            role: event.role,
            eventType: event.type,
            ctx: event.ctx ?? {},
            error: event.error,
          });
          continue;
        }

        if (!["action", "pre_send_action", "post_receive_action"].includes(event.type)) {
          continue;
        }

        const response = await askClaudeForResponse(event, resolved);
        emitJson("response", {
          agentName: resolved.agentName,
          instanceId: event.instanceId,
          protocolName: event.protocolName,
          role: event.role,
          eventType: event.type,
          stateId: event.stateId,
          response,
        });

        await callJsonTool(client, "reagent_respond", {
          instanceId: event.instanceId,
          response,
        });
      }
    }
  } finally {
    await shutdown();
  }
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
