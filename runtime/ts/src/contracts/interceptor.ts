/**
 * Message-level interception and address page types.
 */

import type { MessageEnvelope } from "./types.js";

// ── Interceptor ─────────────────────────────────────────────────────

export type MessageDirection = "outbound" | "inbound" | "loopback";

export interface InterceptorContext {
  envelope: MessageEnvelope;
  direction: MessageDirection;
  nodeId: string;
}

/**
 * Message-level interceptor function. Runs for every message (local or remote,
 * inbound or outbound) flowing through the RC. Call next() to pass control;
 * omitting next() drops the message.
 */
export type InterceptorFn = (
  ctx: InterceptorContext,
  next: () => void,
) => void;

// ── TraceHook ───────────────────────────────────────────────────────

import type { TraceEvent } from "./types.js";

/**
 * Agent-level trace hook. Configured per AgentRunner (inside NativeAgentNode).
 * Not part of the RC interface — the RC doesn't know about trace events.
 */
export type TraceHook = (event: TraceEvent) => void;

// ── AddressPage ─────────────────────────────────────────────────────

/**
 * Static routing information distributed by the orchestrator.
 * Contains agent-to-node mappings and known node link hints.
 */
export interface AddressPage {
  sourceNodeId: string;
  agents: Array<{ agentName: string; nodeId: string }>;
  nodes: Array<{ nodeId: string; linkType: string; url?: string }>;
  ts: number;
}
