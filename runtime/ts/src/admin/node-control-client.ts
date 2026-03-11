import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { NodeControlEvent, NodeControlMessage } from "./node-control-protocol.js";

type PendingRequest = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
};

export class NodeControlClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });

    this.ws.on("message", (data) => {
      this.handleMessage(data.toString());
    });
    this.ws.on("close", () => {
      this.ws = null;
      for (const [, pending] of this.pending) {
        pending.reject(new Error("Node control connection closed"));
      }
      this.pending.clear();
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  on(event: string, listener: (payload: Record<string, unknown>) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }

  async request(op: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Node control endpoint is unavailable: ${this.url}`);
    }

    const id = randomUUID();
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.ws.send(JSON.stringify({
      kind: "request",
      id,
      op,
      payload,
    }));

    return await promise;
  }

  private handleMessage(raw: string): void {
    let message: NodeControlMessage;
    try {
      message = JSON.parse(raw) as NodeControlMessage;
    } catch {
      return;
    }

    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new Error(message.error));
      }
      return;
    }

    if (message.kind === "event") {
      const event = message as NodeControlEvent;
      const listeners = this.listeners.get(event.event);
      if (!listeners) return;
      for (const listener of listeners) {
        listener(event.payload);
      }
    }
  }
}
