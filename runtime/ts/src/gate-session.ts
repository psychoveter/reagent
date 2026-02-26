/**
 * GateSession — FSM validation and event/response framing for Message Gate.
 *
 * Wraps a GateTransport with:
 * - FSM state tracking (validates that external agents follow the protocol)
 * - Request-response correlation (maps events to expected responses)
 * - State frame emission (periodic snapshots of agent state for debugging)
 */

import type { ProtocolEvent, AgentResponse } from "./protocol-engine.js";
import type { GateTransport } from "./gate-transport.js";

export type GateSessionStatus = "idle" | "active" | "completed" | "error";

export interface GateSessionConfig {
  sessionId: string;
  agentName: string;
  protocolName: string;
  transport: GateTransport;
  validateFSM?: boolean;
}

export class GateSession {
  readonly sessionId: string;
  readonly agentName: string;
  readonly protocolName: string;

  private transport: GateTransport;
  private status: GateSessionStatus = "idle";
  private pendingResolve: ((response: AgentResponse) => void) | null = null;
  private eventLog: ProtocolEvent[] = [];
  private validateFSM: boolean;

  constructor(config: GateSessionConfig) {
    this.sessionId = config.sessionId;
    this.agentName = config.agentName;
    this.protocolName = config.protocolName;
    this.transport = config.transport;
    this.validateFSM = config.validateFSM ?? true;

    this.transport.onResponse((response) => {
      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        resolve(response);
      }
    });
  }

  getStatus(): GateSessionStatus {
    return this.status;
  }

  getEventLog(): ProtocolEvent[] {
    return [...this.eventLog];
  }

  /**
   * Send a ProtocolEvent through the gate and wait for the AgentResponse.
   * Optionally validates the FSM to ensure the external agent follows protocol.
   */
  async sendAndWait(event: ProtocolEvent, timeoutMs = 30000): Promise<AgentResponse> {
    if (this.status === "error") {
      throw new Error(`Gate session ${this.sessionId} is in error state`);
    }

    this.status = "active";
    this.eventLog.push(event);

    if (this.validateFSM && !this.isValidTransition(event)) {
      this.status = "error";
      throw new GateValidationError(
        `Invalid event type "${event.type}" in current session state`,
        this.sessionId,
        event,
      );
    }

    this.transport.send(event);

    const response = await new Promise<AgentResponse>((resolve, reject) => {
      this.pendingResolve = resolve;
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          this.status = "error";
          reject(new Error(`Gate response timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });

    if (event.type === "protocol_completed" || event.type === "protocol_failed") {
      this.status = "completed";
    }

    return response;
  }

  /**
   * Send a fire-and-forget event (no response expected).
   */
  sendNotification(event: ProtocolEvent): void {
    this.eventLog.push(event);
    this.transport.send(event);
  }

  close(): void {
    this.status = "completed";
    this.transport.close();
  }

  private isValidTransition(event: ProtocolEvent): boolean {
    // Basic FSM validation: disallow events after completion
    if (this.status === "completed") return false;

    // Disallow certain event sequences
    const lastEvent = this.eventLog.length > 1
      ? this.eventLog[this.eventLog.length - 2]
      : null;

    if (lastEvent?.type === "protocol_completed" || lastEvent?.type === "protocol_failed") {
      return false;
    }

    return true;
  }
}

export class GateValidationError extends Error {
  readonly sessionId: string;
  readonly event: ProtocolEvent;

  constructor(message: string, sessionId: string, event: ProtocolEvent) {
    super(message);
    this.name = "GateValidationError";
    this.sessionId = sessionId;
    this.event = event;
  }
}
