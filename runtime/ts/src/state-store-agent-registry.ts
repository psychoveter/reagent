/**
 * StateStoreAgentRegistry — agent registry backed by StateStore.
 *
 * Stores agent registrations at `/agents/{name}` prefix.
 * Maintains a local cache synchronized via watch events.
 */

import type { StateStore, Disposable, WatchEvent } from "./state-store.js";

export type AgentRegistration = {
  name: string;
  role: string;
  tags: string[];
  capabilities: string[];
  labels: Record<string, string>;
  metadata: Record<string, unknown>;
};

export interface AgentRegistry {
  register(agent: AgentRegistration): Promise<void>;
  deregister(name: string): Promise<boolean>;
  get(name: string): AgentRegistration | undefined;
  findByRole(role: string): AgentRegistration[];
  all(): AgentRegistration[];
  onChanged(cb: (name: string, agent: AgentRegistration | null) => void): Disposable;
}

const AGENTS_PREFIX = "/agents/";

export class StateStoreAgentRegistry implements AgentRegistry {
  private store: StateStore;
  private cache = new Map<string, AgentRegistration>();
  private watcher: Disposable | null = null;
  private changeListeners = new Set<(name: string, agent: AgentRegistration | null) => void>();

  constructor(store: StateStore) {
    this.store = store;
    this.watcher = store.watch(AGENTS_PREFIX, (event) => this.handleWatch(event));
  }

  async register(agent: AgentRegistration): Promise<void> {
    const key = AGENTS_PREFIX + agent.name;
    await this.store.put(key, JSON.stringify(agent));
    this.cache.set(agent.name, agent);
  }

  async deregister(name: string): Promise<boolean> {
    const key = AGENTS_PREFIX + name;
    const deleted = await this.store.delete(key);
    if (deleted) {
      this.cache.delete(name);
    }
    return deleted;
  }

  get(name: string): AgentRegistration | undefined {
    return this.cache.get(name);
  }

  findByRole(role: string): AgentRegistration[] {
    const result: AgentRegistration[] = [];
    for (const agent of this.cache.values()) {
      if (agent.role === role) result.push(agent);
    }
    return result;
  }

  all(): AgentRegistration[] {
    return [...this.cache.values()];
  }

  onChanged(cb: (name: string, agent: AgentRegistration | null) => void): Disposable {
    this.changeListeners.add(cb);
    return {
      dispose: () => { this.changeListeners.delete(cb); },
    };
  }

  async loadFromStore(): Promise<void> {
    const entries = await this.store.list(AGENTS_PREFIX);
    this.cache.clear();
    for (const entry of entries) {
      const val = typeof entry.value === "string" ? entry.value : entry.value.toString("utf8");
      try {
        const agent = JSON.parse(val) as AgentRegistration;
        this.cache.set(agent.name, agent);
      } catch { /* skip corrupt entries */ }
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = null;
    this.changeListeners.clear();
  }

  private handleWatch(event: WatchEvent): void {
    const name = event.key.slice(AGENTS_PREFIX.length);
    if (!name) return;

    if (event.kind === "put" && event.value != null) {
      const val = typeof event.value === "string" ? event.value : event.value.toString("utf8");
      try {
        const agent = JSON.parse(val) as AgentRegistration;
        this.cache.set(name, agent);
        for (const cb of this.changeListeners) cb(name, agent);
      } catch { /* ignore */ }
    } else if (event.kind === "delete") {
      this.cache.delete(name);
      for (const cb of this.changeListeners) cb(name, null);
    }
  }
}
