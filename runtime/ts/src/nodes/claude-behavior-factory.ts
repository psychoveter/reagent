/**
 * ClaudeBehaviorFactory — creates AgentBehavior instances that delegate
 * protocol event handling to the Claude API via @anthropic-ai/claude-agent-sdk.
 *
 * Calls Claude directly in-process inside handle() — no MCP intermediary.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBehavior } from "../contracts/agent-behavior.js";
import type { BehaviorFactory } from "../contracts/behavior-factory.js";
import type { ProtocolEvent, AgentResponse } from "../core/protocol-engine.js";
import type { RoleIR, IRGraph } from "../contracts/types.js";
import type {
  ClaudeToolsConfig,
  ClaudeMcpServersConfig,
  ClaudePermissionMode,
} from "./claude-config.js";

export interface ClaudeBehaviorConfig {
  model?: string;
  maxTurns: number;
  extraInstructions: string;
  permissionMode: ClaudePermissionMode;
  tools: ClaudeToolsConfig;
  mcpServers?: ClaudeMcpServersConfig;
  cwd?: string;
}

const SYSTEM_PROMPT_TEMPLATE = `You are a headless Reagent protocol participant.

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
- Keep summaries concise and concrete.`;

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function serializeEvent(event: ProtocolEvent): Record<string, unknown> {
  const base: Record<string, unknown> = { type: event.type };
  if ("stateId" in event) base.stateId = event.stateId;
  if ("body" in event) base.body = event.body;
  if ("lang" in event) base.lang = event.lang;
  if ("isAsync" in event) base.isAsync = event.isAsync;
  if ("ctx" in event) base.ctx = event.ctx;
  if ("self" in event) base.self = event.self;
  if ("error" in event) base.error = event.error;
  if ("protocolName" in event) base.protocolName = event.protocolName;
  return base;
}

class ClaudeBehavior implements AgentBehavior {
  constructor(
    private agentName: string,
    private roles: string[],
    private config: ClaudeBehaviorConfig,
  ) {}

  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    if (
      event.type !== "action" &&
      event.type !== "pre_send_action" &&
      event.type !== "post_receive_action"
    ) {
      return { type: "noop" };
    }

    const extraLine = this.config.extraInstructions
      ? `- Extra instructions: ${this.config.extraInstructions}`
      : "";

    const systemPrompt = extraLine
      ? `${SYSTEM_PROMPT_TEMPLATE}\n${extraLine}`
      : SYSTEM_PROMPT_TEMPLATE;

    const prompt = `Agent name: ${this.agentName}
Roles: ${this.roles.join(", ")}
Event JSON:
${JSON.stringify(serializeEvent(event), null, 2)}

Return the JSON response now.`;

    const conversation = query({
      prompt,
      options: {
        systemPrompt,
        cwd: this.config.cwd,
        model: this.config.model,
        mcpServers: this.config.mcpServers as Record<string, never> | undefined,
        permissionMode: this.config.permissionMode,
        allowDangerouslySkipPermissions:
          this.config.permissionMode === "bypassPermissions",
        maxTurns: this.config.maxTurns,
        tools: this.config.tools,
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
      } else if (
        msg.type === "result" &&
        !textOutput &&
        msg.subtype === "success"
      ) {
        textOutput = msg.result;
      }
    }

    const jsonText = extractJsonObject(textOutput);
    return JSON.parse(jsonText) as AgentResponse;
  }
}

export class ClaudeBehaviorFactory implements BehaviorFactory {
  readonly runtimeName = "claude";
  private roles: string[];
  private config: ClaudeBehaviorConfig;

  constructor(roles: string[], config: ClaudeBehaviorConfig) {
    this.roles = roles;
    this.config = config;
  }

  createBehavior(
    agentName: string,
    _roleIR: RoleIR,
    _graphs: Map<string, IRGraph>,
    _extras?: Record<string, unknown>,
  ): AgentBehavior {
    return new ClaudeBehavior(agentName, this.roles, this.config);
  }

  async destroyBehavior(_behavior: AgentBehavior): Promise<void> {}
}
