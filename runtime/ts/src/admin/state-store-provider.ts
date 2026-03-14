import type { StateStore, Disposable, Lease, StoreValue } from "../cluster/state-store.js";
import { InMemoryStateStore } from "../cluster/state-store.js";
import { EtcdStateStore } from "../cluster/etcd-state-store.js";
import { NodeControlClient } from "./node-control-client.js";

export interface StateStoreProvider {
  getStateStore(): Promise<StateStore>;
}

export class DirectStateStoreProvider implements StateStoreProvider {
  private store: StateStore | null = null;

  constructor(private readonly config: { kind: "memory" } | { kind: "etcd"; hosts: string[] }) {}

  async getStateStore(): Promise<StateStore> {
    if (this.store) return this.store;
    this.store = this.config.kind === "etcd"
      ? new EtcdStateStore({ hosts: this.config.hosts })
      : new InMemoryStateStore();
    return this.store;
  }
}

class ProxiedStateStore implements StateStore {
  constructor(private readonly client: NodeControlClient) {}

  async get(key: string): Promise<StoreValue | null> {
    const result = await this.client.request("StoreGet", { key });
    const encoded = result.value as string | undefined;
    if (encoded == null) return null;
    return encoded;
  }

  async put(): Promise<void> {
    throw new Error("ProxiedStateStore is read-only");
  }

  async delete(): Promise<boolean> {
    throw new Error("ProxiedStateStore is read-only");
  }

  async list(prefix: string) {
    const result = await this.client.request("StoreList", { prefix });
    return (result.entries as Array<{ key: string; value: string }>) ?? [];
  }

  async putIfAbsent(): Promise<boolean> {
    throw new Error("ProxiedStateStore is read-only");
  }

  async compareAndSwap(): Promise<boolean> {
    throw new Error("ProxiedStateStore is read-only");
  }

  watch(): Disposable {
    return {
      dispose: () => {
        // Polling/watch proxy is not implemented yet.
      },
    };
  }

  async createLease(): Promise<Lease> {
    throw new Error("ProxiedStateStore is read-only");
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

export class ProxiedStateStoreProvider implements StateStoreProvider {
  private store: StateStore | null = null;

  constructor(private readonly nodeUrl: string) {}

  async getStateStore(): Promise<StateStore> {
    if (this.store) return this.store;
    const client = new NodeControlClient(this.nodeUrl);
    await client.connect();
    this.store = new ProxiedStateStore(client);
    return this.store;
  }
}
