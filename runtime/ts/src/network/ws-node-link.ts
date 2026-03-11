/**
 * WsNodeLink — WebSocket-based NodeLink for inter-node communication.
 *
 * Two modes:
 * - Client: connects to a remote WS server
 * - Server: accepts a pre-established WebSocket from WsNodeLinkServer
 */

import { WebSocket, WebSocketServer } from "ws";
import type { MessageEnvelope } from "../contracts/types.js";
import type { NodeLink } from "../contracts/transport.js";

export interface WsNodeLinkConfig {
  remoteNodeId: string;
  url?: string;
  role: "client" | "server";
}

export class WsNodeLink implements NodeLink {
  readonly remoteNodeId: string;
  private ws: WebSocket | null = null;
  private handler: ((envelope: MessageEnvelope) => void) | null = null;
  private url?: string;
  private role: "client" | "server";
  private connected = false;

  constructor(config: WsNodeLinkConfig) {
    this.remoteNodeId = config.remoteNodeId;
    this.url = config.url;
    this.role = config.role;
  }

  /** @internal Attach a pre-established WebSocket (server mode). */
  _attachSocket(ws: WebSocket): void {
    this.ws = ws;
    this._wireListeners();
  }

  async connect(): Promise<void> {
    if (this.role === "client") {
      if (!this.url) throw new Error("WsNodeLink client mode requires url");
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(this.url!);
        ws.on("open", () => {
          this.ws = ws;
          this._wireListeners();
          this.connected = true;
          resolve();
        });
        ws.on("error", reject);
      });
    }
    // Server mode: socket already attached via _attachSocket
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  send(envelope: MessageEnvelope): void {
    if (!this.connected || !this.ws) {
      throw new Error(`WsNodeLink to ${this.remoteNodeId} not connected`);
    }
    this.ws.send(JSON.stringify(envelope));
  }

  onEnvelope(handler: (envelope: MessageEnvelope) => void): void {
    this.handler = handler;
  }

  private _wireListeners(): void {
    if (!this.ws) return;
    this.ws.on("message", (data) => {
      try {
        const envelope = JSON.parse(data.toString()) as MessageEnvelope;
        this.handler?.(envelope);
      } catch {
        // Ignore non-JSON or non-envelope messages
      }
    });
    this.ws.on("close", () => {
      this.connected = false;
    });
  }
}

export interface WsNodeLinkServerConfig {
  port?: number;
  wss?: WebSocketServer;
}

/**
 * Accepts incoming WS connections and produces WsNodeLink instances.
 * Each connecting node sends a JSON handshake: { nodeId: "..." } as first message.
 */
export class WsNodeLinkServer {
  private wss: WebSocketServer;
  private ownsWss: boolean;
  private onLinkCallback: ((link: WsNodeLink) => void) | null = null;

  constructor(config: WsNodeLinkServerConfig) {
    if (config.wss) {
      this.wss = config.wss;
      this.ownsWss = false;
    } else {
      this.wss = new WebSocketServer({ port: config.port ?? 0 });
      this.ownsWss = true;
    }

    this.wss.on("connection", (ws) => {
      let identified = false;
      const earlyMessages: string[] = [];

      ws.on("message", (data) => {
        const raw = data.toString();
        if (!identified) {
          try {
            const msg = JSON.parse(raw);
            if (msg.nodeId) {
              identified = true;
              const link = new WsNodeLink({
                remoteNodeId: msg.nodeId,
                role: "server",
              });
              link._attachSocket(ws);
              // Replay any messages that arrived before identification
              for (const queued of earlyMessages) {
                ws.emit("message", Buffer.from(queued));
              }
              this.onLinkCallback?.(link);
              return;
            }
          } catch { /* not a handshake */ }
          earlyMessages.push(raw);
        }
      });
    });
  }

  onLink(callback: (link: WsNodeLink) => void): void {
    this.onLinkCallback = callback;
  }

  get port(): number {
    const addr = this.wss.address();
    if (typeof addr === "object" && addr) return addr.port;
    return 0;
  }

  async close(): Promise<void> {
    if (this.ownsWss) {
      return new Promise((resolve) => this.wss.close(() => resolve()));
    }
  }
}
