/**
 * Transport interfaces — agent addressing, inter-node links, and per-agent transport.
 *
 * These are the core M5-CTRL abstractions that decouple the runtime from any
 * specific messaging system (NATS, WebSocket, etc.).
 */

import type { MessageEnvelope } from "./types.js";

// ── NodeRef ─────────────────────────────────────────────────────────

/**
 * A reference to a node. Knows how to deliver an envelope to that node.
 * For local delivery, the RC uses a built-in loopback NodeRef (direct dispatch).
 * For remote delivery, the NodeRef wraps a NodeLink.
 */
export interface NodeRef {
  readonly nodeId: string;
  send(envelope: MessageEnvelope): void;
}

// ── AgentRef ────────────────────────────────────────────────────────

/**
 * A reference to a specific agent — the primary addressing primitive in Reagent.
 * Equivalent of Akka's ActorRef. Composes a NodeRef with an agent name.
 *
 * send() and sendEnvelope() are fire-and-forget (best-effort, non-blocking).
 */
export interface AgentRef {
  readonly agentName: string;
  readonly nodeRef: NodeRef;

  /**
   * Convenience: constructs a MessageEnvelope from protocol context and sends.
   * The envelope's `from`, `instanceId`, `ts`, `idempotencyKey` are populated
   * automatically from the transport context.
   */
  send(messageName: string, payload: Record<string, unknown>): void;

  /** Forwards a pre-built envelope without modification. */
  sendEnvelope(envelope: MessageEnvelope): void;
}

// ── ReagentTransport ────────────────────────────────────────────────

/**
 * Per-agent transport context provided by the ReagentController.
 * Used to obtain AgentRefs and to receive inbound messages.
 */
export interface ReagentTransport {
  readonly agentName: string;

  /** Get a ref to another agent. The RC resolves local vs. remote. */
  ref(agentName: string): AgentRef;

  /** Register a handler for inbound messages addressed to this agent. */
  onMessage(handler: (envelope: MessageEnvelope) => void): void;
}

// ── NodeLink ────────────────────────────────────────────────────────

/**
 * A thin, bidirectional envelope pipe between two node RCs.
 * Not a messaging system — just a connection that serializes envelopes,
 * sends bytes, receives bytes, deserializes envelopes. No subjects,
 * no subscriptions, no routing logic.
 *
 * Connection asymmetry: for TCP/WS, one side listens and the other connects.
 * The interface is symmetric (both ends call connect()), but the implementation
 * decides client vs. server based on config.
 */
export interface NodeLink {
  readonly remoteNodeId: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  send(envelope: MessageEnvelope): void;
  onEnvelope(handler: (envelope: MessageEnvelope) => void): void;
}
