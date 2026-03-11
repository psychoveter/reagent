/**
 * GateTransport — wire protocol adapters for Message Gate communication.
 *
 * Provides WebSocket, stdio, and HTTP transports for connecting external
 * agents to the RC via the Message Gate pattern.
 */

import type { ProtocolEvent, AgentResponse } from "../core/protocol-engine.js";

/**
 * Bidirectional transport for gate sessions.
 * Sends ProtocolEvents to the external agent and receives AgentResponses.
 */
export interface GateTransport {
  send(event: ProtocolEvent): void;
  onResponse(handler: (response: AgentResponse) => void): void;
  close(): void;
}

/**
 * WebSocket-based gate transport.
 */
export class WsGateTransport implements GateTransport {
  private ws: any;
  private responseHandler: ((response: AgentResponse) => void) | null = null;

  constructor(ws: any) {
    this.ws = ws;
    ws.on("message", (data: any) => {
      try {
        const response = JSON.parse(data.toString()) as AgentResponse;
        this.responseHandler?.(response);
      } catch {
        console.warn("[WsGateTransport] Failed to parse message");
      }
    });
  }

  send(event: ProtocolEvent): void {
    if (this.ws.readyState === 1) { // OPEN
      this.ws.send(JSON.stringify(event));
    }
  }

  onResponse(handler: (response: AgentResponse) => void): void {
    this.responseHandler = handler;
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Stdio-based gate transport (for subprocess agents).
 */
export class StdioGateTransport implements GateTransport {
  private proc: any;
  private responseHandler: ((response: AgentResponse) => void) | null = null;
  private buffer = "";

  constructor(proc: { stdin: any; stdout: any }) {
    this.proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as AgentResponse;
          this.responseHandler?.(response);
        } catch {
          // Not JSON — likely normal stdout output
        }
      }
    });
  }

  send(event: ProtocolEvent): void {
    this.proc.stdin.write(JSON.stringify(event) + "\n");
  }

  onResponse(handler: (response: AgentResponse) => void): void {
    this.responseHandler = handler;
  }

  close(): void {
    try { this.proc.stdin.end(); } catch { /* ignore */ }
  }
}

/**
 * HTTP-based gate transport (request-response per event).
 */
export class HttpGateTransport implements GateTransport {
  private url: string;
  private responseHandler: ((response: AgentResponse) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(event: ProtocolEvent): void {
    fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    })
      .then(res => res.json())
      .then(response => this.responseHandler?.(response as AgentResponse))
      .catch(err => console.warn("[HttpGateTransport] Request failed:", err.message));
  }

  onResponse(handler: (response: AgentResponse) => void): void {
    this.responseHandler = handler;
  }

  close(): void {
    // HTTP is stateless — no cleanup needed
  }
}
