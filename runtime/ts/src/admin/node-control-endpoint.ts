import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { NodeControlEvent, NodeControlHandler, NodeControlMessage, NodeControlRequest } from "./node-control-protocol.js";

export interface NodeControlEndpointConfig {
  host?: string;
  port?: number;
  handler: NodeControlHandler;
}

export class NodeControlEndpoint {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  constructor(private readonly config: NodeControlEndpointConfig) {}

  async start(): Promise<number> {
    return await new Promise<number>((resolve) => {
      this.wss = new WebSocketServer(
        {
          host: this.config.host ?? "127.0.0.1",
          port: this.config.port ?? 0,
        },
        () => {
          const address = this.wss!.address();
          const port = typeof address === "object" && address ? address.port : (this.config.port ?? 0);
          resolve(port);
        },
      );

      this.wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("close", () => {
          this.clients.delete(ws);
        });
        ws.on("message", (data) => {
          this.handleRawMessage(ws, data.toString());
        });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.wss) return;
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
    this.clients.clear();
    this.wss = null;
  }

  emit(event: string, payload: Record<string, unknown>): void {
    const message: NodeControlEvent = {
      kind: "event",
      event,
      payload,
    };
    const raw = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  private async handleRawMessage(ws: WebSocket, raw: string): Promise<void> {
    let parsed: NodeControlMessage;
    try {
      parsed = JSON.parse(raw) as NodeControlMessage;
    } catch {
      return;
    }

    if (parsed.kind !== "request") return;
    const request = parsed as NodeControlRequest;

    try {
      const payload = await this.config.handler(request.op, request.payload ?? {});
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          kind: "response",
          id: request.id ?? randomUUID(),
          ok: true,
          payload,
        }));
      }
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          kind: "response",
          id: request.id ?? randomUUID(),
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  }
}
