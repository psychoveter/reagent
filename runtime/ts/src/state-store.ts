/**
 * StateStore — abstract key-value interface for all Reagent runtime state.
 *
 * Implementations:
 * - InMemoryStateStore (dev/single-node)
 * - EtcdStateStore (future, cluster)
 */

import { EventEmitter } from "node:events";

export type StoreValue = string | Buffer;

export type StoreEntry = {
  key: string;
  value: StoreValue;
};

export type WatchEventKind = "put" | "delete";

export type WatchEvent = {
  kind: WatchEventKind;
  key: string;
  value?: StoreValue;
};

export interface Disposable {
  dispose(): void;
}

export interface Lease {
  id: string;
  keepAlive(): Promise<void>;
  revoke(): Promise<void>;
}

export interface StateStore {
  get(key: string): Promise<StoreValue | null>;
  put(key: string, value: StoreValue, opts?: { lease?: string }): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<StoreEntry[]>;
  putIfAbsent(key: string, value: StoreValue, opts?: { lease?: string }): Promise<boolean>;
  watch(prefix: string, cb: (event: WatchEvent) => void): Disposable;
  createLease(ttlSeconds: number): Promise<Lease>;
  close(): Promise<void>;
}

// ── InMemoryStateStore ──────────────────────────────────────────────

type LeaseRecord = {
  id: string;
  ttlMs: number;
  timer: ReturnType<typeof setTimeout>;
  keys: Set<string>;
};

export class InMemoryStateStore implements StateStore {
  private data = new Map<string, StoreValue>();
  private leases = new Map<string, LeaseRecord>();
  private keyToLease = new Map<string, string>();
  private emitter = new EventEmitter();
  private leaseCounter = 0;
  private closed = false;

  async get(key: string): Promise<StoreValue | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: StoreValue, opts?: { lease?: string }): Promise<void> {
    this.data.set(key, value);

    if (opts?.lease) {
      const lease = this.leases.get(opts.lease);
      if (lease) {
        lease.keys.add(key);
        this.keyToLease.set(key, opts.lease);
      }
    }

    this.emitter.emit("watch", { kind: "put", key, value } satisfies WatchEvent);
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.data.has(key);
    if (existed) {
      this.data.delete(key);
      const leaseId = this.keyToLease.get(key);
      if (leaseId) {
        this.keyToLease.delete(key);
        this.leases.get(leaseId)?.keys.delete(key);
      }
      this.emitter.emit("watch", { kind: "delete", key } satisfies WatchEvent);
    }
    return existed;
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    const result: StoreEntry[] = [];
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        result.push({ key, value });
      }
    }
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }

  async putIfAbsent(key: string, value: StoreValue, opts?: { lease?: string }): Promise<boolean> {
    if (this.data.has(key)) return false;
    await this.put(key, value, opts);
    return true;
  }

  watch(prefix: string, cb: (event: WatchEvent) => void): Disposable {
    const handler = (event: WatchEvent) => {
      if (event.key.startsWith(prefix)) {
        cb(event);
      }
    };
    this.emitter.on("watch", handler);
    return {
      dispose: () => {
        this.emitter.removeListener("watch", handler);
      },
    };
  }

  async createLease(ttlSeconds: number): Promise<Lease> {
    const id = `lease_${++this.leaseCounter}`;
    const ttlMs = ttlSeconds * 1000;

    const record: LeaseRecord = {
      id,
      ttlMs,
      timer: this.scheduleLeaseExpiry(id, ttlMs),
      keys: new Set(),
    };
    this.leases.set(id, record);

    return {
      id,
      keepAlive: async () => {
        const r = this.leases.get(id);
        if (!r) return;
        clearTimeout(r.timer);
        r.timer = this.scheduleLeaseExpiry(id, r.ttlMs);
      },
      revoke: async () => {
        this.expireLease(id);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id] of this.leases) {
      this.expireLease(id);
    }
    this.emitter.removeAllListeners();
  }

  private scheduleLeaseExpiry(id: string, ttlMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.expireLease(id), ttlMs);
  }

  private expireLease(id: string): void {
    const record = this.leases.get(id);
    if (!record) return;
    clearTimeout(record.timer);
    for (const key of record.keys) {
      this.data.delete(key);
      this.keyToLease.delete(key);
      this.emitter.emit("watch", { kind: "delete", key } satisfies WatchEvent);
    }
    this.leases.delete(id);
  }
}
