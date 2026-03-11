/**
 * McpAgentAdapter — bridges AgentInterface to MCP tool interactions.
 *
 * Implements AgentInterface.handle() by queueing events for the MCP client
 * to pull via wait_for_events, then blocking until the client responds
 * via deliverResponse().
 *
 * Used with CustomAgentNode: the ProtocolEngine runs on the RC side
 * (inside RemoteNode), handling send/receive/timer/guard automatically.
 * The MCP client only sees zone events (action, pre_send_action,
 * post_receive_action) and lifecycle notifications.
 */

import type { AgentInterface } from "../core/agent-interface.js";
import type { ProtocolEvent, AgentResponse } from "../core/protocol-engine.js";
import { AsyncQueue } from "../gate/async-queue.js";

export interface QueuedEvent {
  instanceId: string;
  protocolName: string;
  role: string;
  event: ProtocolEvent;
  seq: number;
}

export class McpAgentAdapter implements AgentInterface {
  agentName: string;

  private eventQueue = new AsyncQueue<QueuedEvent>();
  private pendingResolves = new Map<string, (response: AgentResponse) => void>();
  private currentInstanceId: string | null = null;
  private seqCounter = 0;
  private registered = false;
  private registeredRoles: string[] = [];
  private instanceMeta = new Map<string, { protocolName: string; role: string }>();

  constructor(agentName: string) {
    this.agentName = agentName;
  }

  // ── AgentInterface ─────────────────────────────────────────────

  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    const instanceId = this.currentInstanceId;
    if (!instanceId) {
      throw new Error("[McpAgentAdapter] handle() called without active instance");
    }

    const meta = this.instanceMeta.get(instanceId);

    this.eventQueue.push({
      instanceId,
      protocolName: meta?.protocolName ?? "",
      role: meta?.role ?? "",
      event,
      seq: ++this.seqCounter,
    });

    return new Promise<AgentResponse>((resolve) => {
      this.pendingResolves.set(instanceId, resolve);
    });
  }

  // ── Called by CustomAgentHandle (engine loop context) ──────────

  /**
   * Set the current instance context before the engine calls handle().
   * CustomAgentHandle.runEngine() should call this before each handle().
   */
  setCurrentInstance(instanceId: string, protocolName: string, role: string): void {
    this.currentInstanceId = instanceId;
    if (!this.instanceMeta.has(instanceId)) {
      this.instanceMeta.set(instanceId, { protocolName, role });
    }
  }

  /**
   * Push a lifecycle notification (protocol_started, protocol_completed, etc.)
   * These don't block — the engine doesn't wait for a response.
   */
  pushNotification(instanceId: string, event: ProtocolEvent): void {
    const meta = this.instanceMeta.get(instanceId);
    this.eventQueue.push({
      instanceId,
      protocolName: meta?.protocolName ?? "",
      role: meta?.role ?? "",
      event,
      seq: ++this.seqCounter,
    });
  }

  // ── Called by MCP tool handlers ────────────────────────────────

  register(agentName: string, roles: string[]): { agentId: string; registeredRoles: string[] } {
    this.agentName = agentName;
    this.registered = true;
    this.registeredRoles = roles;
    return { agentId: this.agentName, registeredRoles: roles };
  }

  unregister(): void {
    this.registered = false;
    this.registeredRoles = [];
    this.eventQueue.clear();
  }

  isRegistered(): boolean {
    return this.registered;
  }

  getRegisteredRoles(): string[] {
    return this.registeredRoles;
  }

  async waitForEvents(timeoutMs = 30000, maxEvents = 1): Promise<QueuedEvent[]> {
    return this.eventQueue.drain(timeoutMs, maxEvents);
  }

  deliverResponse(instanceId: string, response: AgentResponse): boolean {
    const resolve = this.pendingResolves.get(instanceId);
    if (!resolve) {
      return false;
    }
    this.pendingResolves.delete(instanceId);
    resolve(response);
    return true;
  }

  getPendingEvents(): QueuedEvent[] {
    return this.eventQueue.peek();
  }

  hasPendingResponse(instanceId?: string): boolean {
    if (instanceId) return this.pendingResolves.has(instanceId);
    return this.pendingResolves.size > 0;
  }

  removeInstance(instanceId: string): void {
    this.instanceMeta.delete(instanceId);
    this.pendingResolves.delete(instanceId);
  }
}
