/**
 * ReagentMcpServer — Reagent protocol participation as an MCP server.
 *
 * Designed for **stdio transport**: the agent (Claude Code, Cursor) starts
 * this process as a subprocess and communicates via stdin/stdout JSON-RPC.
 *
 * The server exposes MCP tools:
 *   reagent/register        – register agent identity
 *   reagent/unregister      – leave discovery
 *   reagent/wait_for_events – long-poll for protocol events
 *   reagent/respond         – submit response for a protocol event
 *   reagent/invoke          – start a new protocol instance
 *   reagent/list_protocols  – list available protocols
 *   reagent/list_instances  – list active protocol instances
 *   reagent/get_state       – get instance state
 *
 * Can also be used with Streamable HTTP transport by providing a custom
 * transport via startWithTransport().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { McpAgentAdapter, type QueuedEvent } from "./mcp-agent-adapter.js";
import type { AgentResponse } from "../../core/protocol-engine.js";

// ── Serialization helpers ────────────────────────────────────────────

function serializeEvent(qe: QueuedEvent): Record<string, unknown> {
  const ev = qe.event;
  const base: Record<string, unknown> = {
    instanceId: qe.instanceId,
    protocolName: qe.protocolName,
    role: qe.role,
    seq: qe.seq,
    type: ev.type,
  };

  switch (ev.type) {
    case "action":
      return { ...base, stateId: ev.stateId, body: ev.body, lang: ev.lang, isAsync: ev.isAsync, ctx: ev.ctx, self: ev.self };
    case "pre_send_action":
      return { ...base, stateId: ev.stateId, body: ev.body, isAsync: ev.isAsync, ctx: ev.ctx, self: ev.self };
    case "post_receive_action":
      return { ...base, stateId: ev.stateId, body: ev.body, isAsync: ev.isAsync, ctx: ev.ctx, self: ev.self };
    case "protocol_started":
      return { ...base };
    case "protocol_completed":
      return { ...base, ctx: ev.ctx };
    case "protocol_failed":
      return { ...base, error: ev.error, ctx: ev.ctx };
    default:
      return base;
  }
}

function parseAgentResponse(raw: Record<string, unknown>): AgentResponse {
  const type = raw.type as string;
  switch (type) {
    case "ctx_update":
      return { type: "ctx_update", ctx: (raw.ctx ?? {}) as Record<string, unknown> };
    case "noop":
      return { type: "noop" };
    case "return_value":
      return { type: "return_value", value: raw.value };
    case "break_requested":
      return { type: "break_requested" };
    case "error_thrown":
      return { type: "error_thrown", error: new Error(String(raw.error ?? "unknown")) };
    default:
      return { type: "ctx_update", ctx: (raw.ctx ?? {}) as Record<string, unknown> };
  }
}

// ── Config ───────────────────────────────────────────────────────────

export interface ReagentMcpServerConfig {
  adapter: McpAgentAdapter;
  onRegister?: (agentName: string, roles: string[]) => Promise<{ agentId: string; registeredRoles: string[] }>;
  onUnregister?: (agentName: string) => Promise<void>;
  onInvoke?: (protocolName: string, input: Record<string, unknown>, roleBindings?: Record<string, string>) => Promise<string>;
  listProtocols?: () => Array<{ name: string; version?: string; roles: string[]; description?: string }>;
  listInstances?: (agentName: string) => Array<{ instanceId: string; protocolName: string; status: string; role: string }>;
  getState?: (instanceId: string) => { currentState: string; status: string; ctx: Record<string, unknown> } | null;
}

// ── Server ───────────────────────────────────────────────────────────

export class ReagentMcpServer {
  private config: ReagentMcpServerConfig;
  private server: McpServer;

  constructor(config: ReagentMcpServerConfig) {
    this.config = config;
    this.server = this.createMcpServer();
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: "reagent-mcp-server", version: "0.1.0" },
      { capabilities: { logging: {} } },
    );

    const adapter = this.config.adapter;

    server.tool(
      "reagent_register",
      "Register agent identity and attach MCP runtime to the RC lifecycle",
      { agentName: z.string(), roles: z.array(z.string()) },
      async ({ agentName, roles }) => {
        const result = this.config.onRegister
          ? await this.config.onRegister(agentName, roles)
          : adapter.register(agentName, roles);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    );

    server.tool(
      "reagent_unregister",
      "Detach MCP runtime from the RC lifecycle",
      {},
      async () => {
        if (this.config.onUnregister) {
          await this.config.onUnregister(adapter.agentName);
        }
        adapter.unregister();
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
      },
    );

    server.tool(
      "reagent_wait_for_events",
      "Long-poll for protocol events. Blocks until an event arrives or timeout expires.",
      {
        timeout_ms: z.number().optional().default(25000),
        max_events: z.number().optional().default(1),
      },
      async ({ timeout_ms, max_events }) => {
        if (!adapter.isRegistered()) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Not registered. Call reagent_register first." }) }], isError: true };
        }
        const events = await adapter.waitForEvents(timeout_ms, max_events);
        const serialized = events.map(serializeEvent);
        return { content: [{ type: "text" as const, text: JSON.stringify(serialized) }] };
      },
    );

    server.tool(
      "reagent_respond",
      "Submit a response for a protocol event",
      {
        instanceId: z.string(),
        response: z.record(z.unknown()),
      },
      async ({ instanceId, response }) => {
        const parsed = parseAgentResponse(response as Record<string, unknown>);
        const ok = adapter.deliverResponse(instanceId, parsed);
        if (!ok) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No pending event for this instance" }) }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
      },
    );

    server.tool(
      "reagent_invoke",
      "Create a new protocol instance",
      {
        protocolName: z.string(),
        input: z.record(z.unknown()).optional().default({}),
        roleBindings: z.record(z.string()).optional(),
      },
      async ({ protocolName, input, roleBindings }) => {
        if (!this.config.onInvoke) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "invoke not configured" }) }], isError: true };
        }
        const instanceId = await this.config.onInvoke(protocolName, input, roleBindings);
        return { content: [{ type: "text" as const, text: JSON.stringify({ instanceId }) }] };
      },
    );

    server.tool(
      "reagent_list_protocols",
      "List available protocols",
      {},
      async () => {
        const protocols = this.config.listProtocols?.() ?? [];
        return { content: [{ type: "text" as const, text: JSON.stringify(protocols) }] };
      },
    );

    server.tool(
      "reagent_list_instances",
      "List active protocol instances for this agent",
      {},
      async () => {
        const instances = this.config.listInstances?.(adapter.agentName) ?? [];
        return { content: [{ type: "text" as const, text: JSON.stringify(instances) }] };
      },
    );

    server.tool(
      "reagent_get_state",
      "Get protocol instance state",
      { instanceId: z.string() },
      async ({ instanceId }) => {
        const state = this.config.getState?.(instanceId);
        if (!state) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Instance not found" }) }], isError: true };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(state) }] };
      },
    );

    return server;
  }

  /**
   * Start with stdio transport (default, for subprocess usage).
   * The agent (Claude Code, Cursor) starts this process and communicates
   * via stdin/stdout JSON-RPC.
   */
  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Start with any MCP transport (for custom setups — HTTP, WebSocket, etc.)
   */
  async startWithTransport(transport: { start(): Promise<void> }): Promise<void> {
    await this.server.connect(transport as any);
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}
