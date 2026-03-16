/**
 * AsyncQueue — promise-based queue with timeout drain.
 *
 * Used by McpAgentAdapter to bridge push (engine emits events) with
 * pull (MCP client calls wait_for_events).
 */

export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiter: { resolve: (items: T[]) => void; max: number } | null = null;

  push(item: T): void {
    if (this.waiter) {
      const { resolve, max } = this.waiter;
      this.waiter = null;
      this.buffer.push(item);
      resolve(this.buffer.splice(0, max));
    } else {
      this.buffer.push(item);
    }
  }

  /**
   * Drain up to `max` items. If the buffer is empty, block until at least
   * one item arrives or `timeoutMs` expires (returns [] on timeout).
   */
  async drain(timeoutMs: number, max = 1): Promise<T[]> {
    if (this.buffer.length > 0) {
      return this.buffer.splice(0, max);
    }

    return new Promise<T[]>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve([]);
      }, timeoutMs);

      this.waiter = {
        resolve: (items) => {
          clearTimeout(timer);
          resolve(items);
        },
        max,
      };
    });
  }

  get length(): number {
    return this.buffer.length;
  }

  peek(): T[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
    if (this.waiter) {
      this.waiter.resolve([]);
      this.waiter = null;
    }
  }
}
