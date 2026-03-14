/**
 * EtcdStateStore — StateStore implementation backed by etcd v3 via the `etcd3` client.
 *
 * Maps the Reagent StateStore interface to etcd KV, watch, lease, and transaction primitives.
 */

import { Etcd3, type Watcher, type Lease as EtcdLease } from "etcd3";
import type { StateStore, StoreValue, StoreEntry, WatchEvent, Disposable, Lease } from "./state-store.js";

export interface EtcdStateStoreConfig {
  /** etcd endpoint(s). Default: ["http://127.0.0.1:2379"] */
  hosts?: string[];
}

export class EtcdStateStore implements StateStore {
  private client: Etcd3;
  private watchers: Watcher[] = [];
  private leases: EtcdLease[] = [];

  constructor(config?: EtcdStateStoreConfig) {
    this.client = new Etcd3({
      hosts: config?.hosts ?? ["http://127.0.0.1:2379"],
    });
  }

  async get(key: string): Promise<StoreValue | null> {
    const val = await this.client.get(key).string();
    return val ?? null;
  }

  async put(key: string, value: StoreValue, opts?: { lease?: string }): Promise<void> {
    const strVal = typeof value === "string" ? value : value.toString("utf8");
    let builder = this.client.put(key).value(strVal);
    if (opts?.lease) {
      builder = builder.lease(opts.lease);
    }
    await builder.exec();
  }

  async delete(key: string): Promise<boolean> {
    const resp = await this.client.delete().key(key).exec();
    return (resp as any).deleted !== undefined
      ? Number((resp as any).deleted) > 0
      : false;
  }

  async list(prefix: string): Promise<StoreEntry[]> {
    const all = await this.client.getAll().prefix(prefix).strings();
    const entries: StoreEntry[] = [];
    for (const [key, value] of Object.entries(all)) {
      entries.push({ key, value });
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  async putIfAbsent(key: string, value: StoreValue, opts?: { lease?: string }): Promise<boolean> {
    const strVal = typeof value === "string" ? value : value.toString("utf8");
    let putOp = this.client.put(key).value(strVal);
    if (opts?.lease) {
      putOp = putOp.lease(opts.lease);
    }

    const txn = this.client.if(key, "Version", "==", 0)
      .then(putOp)
      .else(this.client.get(key));

    const resp = await txn.commit();
    return resp.succeeded;
  }

  async compareAndSwap(
    key: string,
    expectedValue: StoreValue | null,
    nextValue: StoreValue,
    opts?: { lease?: string },
  ): Promise<boolean> {
    const nextStr = typeof nextValue === "string" ? nextValue : nextValue.toString("utf8");
    let putOp = this.client.put(key).value(nextStr);
    if (opts?.lease) {
      putOp = putOp.lease(opts.lease);
    }

    const txn = expectedValue == null
      ? this.client.if(key, "Version", "==", 0).then(putOp).else(this.client.get(key))
      : this.client
          .if(key, "Value", "==", (typeof expectedValue === "string" ? expectedValue : expectedValue.toString("utf8")))
          .then(putOp)
          .else(this.client.get(key));

    const resp = await txn.commit();
    return resp.succeeded;
  }

  watch(prefix: string, cb: (event: WatchEvent) => void): Disposable {
    let watcher: Watcher | null = null;

    const setup = async () => {
      const w = await this.client.watch().prefix(prefix).create();
      watcher = w;
      this.watchers.push(w);

      w.on("put", (kv) => {
        cb({
          kind: "put",
          key: kv.key.toString("utf8"),
          value: kv.value.toString("utf8"),
        });
      });

      w.on("delete", (kv) => {
        cb({
          kind: "delete",
          key: kv.key.toString("utf8"),
        });
      });
    };

    setup().catch((err) => {
      console.error(`[EtcdStateStore] watch setup failed for prefix "${prefix}":`, err);
    });

    return {
      dispose: () => {
        if (watcher) {
          const idx = this.watchers.indexOf(watcher);
          if (idx >= 0) this.watchers.splice(idx, 1);
          watcher.cancel().catch(() => {});
        }
      },
    };
  }

  async createLease(ttlSeconds: number): Promise<Lease> {
    const lease = this.client.lease(ttlSeconds, { autoKeepAlive: false });
    this.leases.push(lease);

    const id = await lease.grant();

    return {
      id,
      keepAlive: async () => {
        await lease.keepaliveOnce();
      },
      revoke: async () => {
        await lease.revoke();
        const idx = this.leases.indexOf(lease);
        if (idx >= 0) this.leases.splice(idx, 1);
      },
    };
  }

  async close(): Promise<void> {
    for (const w of this.watchers) {
      await w.cancel().catch(() => {});
    }
    this.watchers = [];

    for (const l of this.leases) {
      await l.revoke().catch(() => {});
    }
    this.leases = [];

    this.client.close();
  }
}
