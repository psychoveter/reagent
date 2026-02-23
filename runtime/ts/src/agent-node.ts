/**
 * AgentNode and AgentHandle interfaces — platform abstraction for agent runtimes.
 *
 * The AgentNode is the platform-specific component that knows how to create
 * and manage agents from IR artifacts. The RC receives an AgentNode as a
 * dependency and delegates agent creation/destruction to it.
 */

import type { RoleIR, IRGraph, MessageEnvelope, ProtocolTrigger } from "./types.js";
import type { ReagentTransport } from "./transport.js";

// ── AgentHandle ─────────────────────────────────────────────────────

/**
 * Opaque handle the RC uses to interact with a created agent.
 * The RC never sees inside — it only dispatches messages and manages lifecycle.
 */
export interface AgentHandle {
  readonly agentName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getSelf(): Record<string, unknown>;
  triggerProtocol(trigger: ProtocolTrigger): void;
  dispatchMessage(env: MessageEnvelope): void;
}

// ── AgentNode ───────────────────────────────────────────────────────

/**
 * Platform abstraction for creating agents from IR.
 * Different platforms provide different implementations:
 *  - NativeAgentNode: wraps AgentRunner (TS/Python)
 *  - LososAgentNode:  wraps Losos engine (Kotlin/JVM)
 *  - LangGraphAgentNode: wraps LangGraph (Python)
 *
 * roleToAgent is NOT passed here — it's a ProtocolInstance-level concern.
 */
export interface AgentNode {
  readonly runtimeName: string;

  createAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    transport: ReagentTransport,
    extras?: Record<string, unknown>,
  ): AgentHandle;

  destroyAgent(handle: AgentHandle): Promise<void>;
}
