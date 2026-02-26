/**
 * DebugInterceptor — message-level breakpoints.
 *
 * Implements InterceptorFn to hold messages matching configured breakpoints.
 * Held messages can be released one at a time (stepMessage) or all at once (continue).
 */

import type { InterceptorFn, InterceptorContext, MessageDirection } from "./interceptor.js";
import type { MessageEnvelope } from "./types.js";

export interface HeldMessage {
  envelope: MessageEnvelope;
  direction: MessageDirection;
  release: () => void;
  drop: () => void;
}

export type DebugInterceptorEvent =
  | { kind: "stopped"; held: HeldMessage }
  | { kind: "released"; messageName: string }
  | { kind: "dropped"; messageName: string };

export class DebugInterceptor {
  private messageBreakpoints = new Set<string>();
  private pauseAll = false;
  private held: Array<{ held: HeldMessage; resolve: () => void }> = [];
  private onEvent: ((event: DebugInterceptorEvent) => void) | null = null;
  private enabled = true;
  private disposed = false;

  setOnEvent(cb: (event: DebugInterceptorEvent) => void): void {
    this.onEvent = cb;
  }

  setMessageBreakpoints(messageNames: string[]): void {
    this.messageBreakpoints.clear();
    for (const name of messageNames) {
      this.messageBreakpoints.add(name);
    }
    if (messageNames.length > 0) this.enabled = true;
  }

  setPauseAll(pause: boolean): void {
    this.pauseAll = pause;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  getHeld(): HeldMessage[] {
    return this.held.map(h => h.held);
  }

  stepMessage(): HeldMessage | null {
    if (this.held.length === 0) return null;
    const first = this.held.shift()!;
    first.held.release();
    first.resolve();
    this.onEvent?.({ kind: "released", messageName: first.held.envelope.messageName });
    return first.held;
  }

  continue(): void {
    this.pauseAll = false;
    this.enabled = false;
    const toRelease = [...this.held];
    this.held = [];
    for (const entry of toRelease) {
      entry.held.release();
      entry.resolve();
      this.onEvent?.({ kind: "released", messageName: entry.held.envelope.messageName });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.continue();
  }

  asInterceptorFn(): InterceptorFn {
    return (ctx: InterceptorContext, next: () => void): void => {
      if (!this.enabled || this.disposed) {
        next();
        return;
      }

      const shouldPause = this.pauseAll || this.messageBreakpoints.has(ctx.envelope.messageName);

      if (shouldPause) {
        let released = false;

        const heldMsg: HeldMessage = {
          envelope: ctx.envelope,
          direction: ctx.direction,
          release: () => { released = true; },
          drop: () => { released = true; },
        };

        let resolveWait!: () => void;
        const waitPromise = new Promise<void>((r) => { resolveWait = r; });

        this.held.push({ held: heldMsg, resolve: resolveWait });
        this.onEvent?.({ kind: "stopped", held: heldMsg });

        // Use promise-based waiting instead of polling setTimeout
        void waitPromise.then(() => {
          if (!released) {
            this.onEvent?.({ kind: "dropped", messageName: ctx.envelope.messageName });
          } else {
            next();
          }
        });
      } else {
        next();
      }
    };
  }
}
