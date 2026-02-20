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
  private held: Array<{ held: HeldMessage; next: () => void }> = [];
  private onEvent: ((event: DebugInterceptorEvent) => void) | null = null;
  private enabled = true;

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

  /**
   * Release the first held message and hold the next one (single step).
   */
  stepMessage(): HeldMessage | null {
    if (this.held.length === 0) return null;
    const first = this.held.shift()!;
    first.held.release();
    this.onEvent?.({ kind: "released", messageName: first.held.envelope.messageName });
    return first.held;
  }

  /**
   * Release all held messages and disable interception until new breakpoints are set.
   */
  continue(): void {
    this.pauseAll = false;
    this.enabled = false;
    const toRelease = [...this.held];
    this.held = [];
    for (const entry of toRelease) {
      entry.held.release();
      this.onEvent?.({ kind: "released", messageName: entry.held.envelope.messageName });
    }
  }

  /**
   * Returns an InterceptorFn suitable for use in ReagentController.
   */
  asInterceptorFn(): InterceptorFn {
    return (ctx: InterceptorContext, next: () => void): void => {
      if (!this.enabled) {
        next();
        return;
      }

      const shouldPause = this.pauseAll || this.messageBreakpoints.has(ctx.envelope.messageName);

      if (shouldPause) {
        let released = false;
        let dropped = false;

        const heldMsg: HeldMessage = {
          envelope: ctx.envelope,
          direction: ctx.direction,
          release: () => { released = true; },
          drop: () => { dropped = true; },
        };

        const entry = {
          held: heldMsg,
          next,
        };

        this.held.push(entry);
        this.onEvent?.({ kind: "stopped", held: heldMsg });

        // Schedule a microtask loop that checks if released/dropped
        const checkRelease = (): void => {
          if (released) {
            next();
          } else if (dropped) {
            this.onEvent?.({ kind: "dropped", messageName: ctx.envelope.messageName });
          } else {
            setTimeout(checkRelease, 10);
          }
        };
        checkRelease();
      } else {
        next();
      }
    };
  }
}
