import * as vscode from 'vscode';

interface RapMessage {
  rap: string;
  id?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

type RapListener = (msg: RapMessage) => void;

/**
 * WebSocket-based RAP client for communication with the Reagent Orchestrator Service.
 * Uses the built-in VS Code / Node.js WebSocket where available, falling back to ws.
 */
export class RapClient {
  private ws: import('ws') | null = null;
  private listeners = new Map<string, Set<RapListener>>();
  private wildcardListeners = new Set<RapListener>();
  private pendingRequests = new Map<string, {
    resolve: (msg: RapMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private reqCounter = 0;
  private _connected = false;

  constructor(private readonly url: string) {}

  get connected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    const WebSocket = (await import('ws')).default;
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url) as import('ws');
      this.ws.on('open', () => {
        this._connected = true;
        resolve();
      });
      this.ws.on('error', (err: Error) => {
        if (!this._connected) reject(err);
      });
      this.ws.on('close', () => { this._connected = false; });
      this.ws.on('message', (data: import('ws').RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as RapMessage;
          this.dispatch(msg);
        } catch { /* ignore non-JSON */ }
      });
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }

  send(msg: RapMessage): void {
    if (!this.ws || !this._connected) {
      throw new Error('RapClient not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Send a request and wait for a specific response RAP type with the same id.
   */
  async request(rapType: string, payload: Record<string, unknown>, responseType: string, timeoutMs = 10000): Promise<RapMessage> {
    const id = `req-${++this.reqCounter}`;
    this.send({ rap: rapType, id, payload });

    return new Promise<RapMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for ${responseType} (id=${id})`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
    });
  }

  on(rapType: string, listener: RapListener): vscode.Disposable {
    if (!this.listeners.has(rapType)) {
      this.listeners.set(rapType, new Set());
    }
    this.listeners.get(rapType)!.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.get(rapType)?.delete(listener);
    });
  }

  onAny(listener: RapListener): vscode.Disposable {
    this.wildcardListeners.add(listener);
    return new vscode.Disposable(() => {
      this.wildcardListeners.delete(listener);
    });
  }

  private dispatch(msg: RapMessage): void {
    // Check pending request-response first
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const req = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      clearTimeout(req.timer);
      req.resolve(msg);
    }

    // Typed listeners
    if (msg.rap && this.listeners.has(msg.rap)) {
      for (const listener of this.listeners.get(msg.rap)!) {
        listener(msg);
      }
    }

    // Wildcard listeners
    for (const listener of this.wildcardListeners) {
      listener(msg);
    }
  }
}
