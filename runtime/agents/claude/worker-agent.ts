#!/usr/bin/env node
/**
 * Headless Claude worker agent for Reagent protocols.
 *
 * Uses @anthropic-ai/claude-agent-sdk to run Claude as an autonomous agent
 * with mcp-gate as its MCP server for Reagent protocol participation.
 *
 * Environment:
 *   ANTHROPIC_API_KEY — required
 *   MCP_RUNTIME_CONFIG — optional path to mcp-gate runtime config JSON
 *   NATS_URL          — legacy override when no runtime config is provided
 *   ETCD_HOSTS        — legacy override when no runtime config is provided
 *   NODE_ID           — legacy override when no runtime config is provided
 *   WORKER_AGENT      — default WorkerAgent
 *   WORKER_ROLES      — default WorkerRole (comma-separated)
 *   MCP_GATE_PATH     — path to mcp-gate.js
 *   MAX_TURNS         — default 200
 *   RESTART_DELAY_MS  — delay between session restarts (default 3000)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";

const runtimeConfigPath = process.env.MCP_RUNTIME_CONFIG;
const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
const etcdHosts = process.env.ETCD_HOSTS ?? "http://127.0.0.1:2379";
const nodeId = process.env.NODE_ID ?? "worker-gate";
const agentName = process.env.WORKER_AGENT ?? "WorkerAgent";
const roles = (process.env.WORKER_ROLES ?? "WorkerRole")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
const maxTurns = parseInt(process.env.MAX_TURNS ?? "200", 10);
const restartDelayMs = parseInt(process.env.RESTART_DELAY_MS ?? "3000", 10);

const mcpGatePath =
  process.env.MCP_GATE_PATH ??
  path.resolve("/opt/reagent/dist/nodes/mcp/mcp-gate.js");

const log = (msg: string) =>
  process.stderr.write(`[worker-agent] ${msg}\n`);

function buildMcpGateArgs(): string[] {
  const args = [
    mcpGatePath,
  ];

  if (runtimeConfigPath) {
    args.push("--runtime-config", runtimeConfigPath);
    return args;
  }

  args.push(
    "--nats-url", natsUrl,
    "--etcd-hosts", etcdHosts,
    "--node-id", nodeId,
  );
  return args;
}

const SYSTEM_PROMPT = `You are an autonomous worker agent participating in Reagent protocols.

You have access to a Reagent MCP server ("reagent") with these tools:

- reagent_register — register as an agent (call once at the start)
- reagent_wait_for_events — long-poll for protocol events (blocks until event arrives)
- reagent_respond — respond to a protocol event
- reagent_invoke — start a new protocol instance

## Your workflow

1. Call reagent_register with agentName: "${agentName}" and roles: ${JSON.stringify(roles)}
2. Call reagent_wait_for_events to receive protocol events
3. For each event, examine the "type" field:
   - "action" / "pre_send_action" / "post_receive_action": execute the zone code described in "body", then call reagent_respond with { instanceId, response: { type: "ctx_update", ctx: <updated context> } }
   - "protocol_started" / "protocol_completed": informational, no response needed
4. After responding, call reagent_wait_for_events again for the next event
5. Never stop — keep looping on wait_for_events indefinitely

## Key concepts

- $ctx is the protocol context — a JSON object carrying state through the protocol
- $ctx.input contains the trigger input (set when protocol is invoked)
- $ctx.msg is the message payload (set before send, available after receive)
- $self contains agent-local state (persists across protocol steps but not across instances)
- Respond with { type: "ctx_update", ctx: { ...updatedCtx } } to update context
- Respond with { type: "noop" } if the zone has no side effects

## Important

- You are headless — there is no human in the loop. Act autonomously.
- Start by registering, then immediately enter the wait_for_events loop.
- Process tasks described in incoming events to the best of your ability.
- When a task asks you to do something (e.g. summarize, analyze, generate), do it and put the result in $ctx.msg.
`;

async function runSession(): Promise<string> {
  log(`Starting session (agent: ${agentName}, node: ${nodeId})`);

  const conversation = query({
    prompt: "Begin. Register as a Reagent agent and start processing protocol events.",
    options: {
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns,
      tools: [],
      mcpServers: {
        reagent: {
          command: "node",
          args: buildMcpGateArgs(),
        },
      },
    },
  });

  let stopReason = "unknown";

  for await (const msg of conversation) {
    switch (msg.type) {
      case "assistant":
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            log(`Claude: ${block.text.slice(0, 300)}`);
          }
          if (block.type === "tool_use") {
            log(`Tool call: ${block.name}`);
          }
        }
        break;

      case "result":
        if (msg.subtype === "success") {
          log(`Session ended: ${msg.result.slice(0, 200)}`);
          log(`Cost: $${msg.total_cost_usd.toFixed(4)}, turns: ${msg.num_turns}`);
          stopReason = msg.stop_reason ?? "completed";
        } else {
          log(`Session error: ${(msg as any).error ?? "unknown"}`);
          stopReason = "error";
        }
        break;

      case "system":
        if ((msg as any).subtype === "init") {
          log("Session initialized");
        }
        break;
    }
  }

  return stopReason;
}

const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_BACKOFF_MS = 60_000;

const FATAL_PATTERNS = [
  "authentication_failed",
  "invalid api key",
  "billing_error",
  "ANTHROPIC_API_KEY",
];

function isFatalError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return FATAL_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
}

async function main(): Promise<void> {
  log(`Worker agent starting`);
  log(`MCP gate: ${mcpGatePath}`);
  if (runtimeConfigPath) {
    log(`runtimeConfig: ${runtimeConfigPath}`);
  } else {
    log(`NATS: ${natsUrl}, etcd: ${etcdHosts}`);
  }
  log(`Agent: ${agentName}, roles: ${roles.join(",")}, maxTurns: ${maxTurns}`);

  let consecutiveFailures = 0;

  while (true) {
    try {
      const reason = await runSession();
      log(`Session ended with reason: ${reason}`);

      if (reason === "completed" || reason === "end_turn") {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }
    } catch (err) {
      consecutiveFailures++;
      log(`Session crashed: ${err}`);

      if (isFatalError(err)) {
        log(`Fatal error detected, not restarting`);
        process.exit(1);
      }
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, exiting`);
      process.exit(1);
    }

    const delay = Math.min(restartDelayMs * Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF_MS);
    log(`Restarting in ${delay}ms (failures: ${consecutiveFailures})...`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
