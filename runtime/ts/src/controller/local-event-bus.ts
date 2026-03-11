/**
 * LocalEventBus — in-process pub/sub for single-node event triggers.
 *
 * Used by TriggerMatcher for event-based trigger subscriptions.
 * Cross-node event routing goes through EventHubAgent (future Phase).
 */

export interface BusEvent {
  topic: string;
  payload: Record<string, unknown>;
  source?: { agent: string; instanceId: string };
  ts: number;
}

export interface Disposable {
  dispose(): void;
}

export class LocalEventBus {
  private subs = new Map<string, Set<(event: BusEvent) => void>>();
  private wildcardSubs = new Set<(event: BusEvent) => void>();

  publish(topic: string, event: BusEvent): void {
    const handlers = this.subs.get(topic);
    if (handlers) {
      for (const h of handlers) h(event);
    }
    for (const h of this.wildcardSubs) h(event);
  }

  subscribe(topic: string, handler: (event: BusEvent) => void): Disposable {
    if (topic === "*") {
      this.wildcardSubs.add(handler);
      return { dispose: () => this.wildcardSubs.delete(handler) };
    }
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(handler);
    return {
      dispose: () => {
        set!.delete(handler);
        if (set!.size === 0) this.subs.delete(topic);
      },
    };
  }

  clear(): void {
    this.subs.clear();
    this.wildcardSubs.clear();
  }
}
