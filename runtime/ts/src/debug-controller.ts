/**
 * DebugController — coordinates message-level and state-level debugging.
 *
 * Manages per-session DebugInterceptor + DebugAdvanceHook instances.
 * Resolves breakpoints via source map, dispatches step/continue commands.
 */

import { DebugInterceptor, type DebugInterceptorEvent, type HeldMessage } from "./debug-interceptor.js";
import { DebugAdvanceHook, type DebugAdvanceHookEvent } from "./debug-advance-hook.js";
import type { SourceMap, SourceMapEntry } from "./session.js";
import type { AdvanceHook } from "./protocol-instance.js";
import type { InterceptorFn } from "./interceptor.js";

export interface Breakpoint {
  type: "message" | "stateId" | "sourceLine" | "stateKind";
  value: string;
  /** For sourceLine breakpoints: file + line */
  file?: string;
  line?: number;
}

export interface ResolvedBreakpoint extends Breakpoint {
  resolved: boolean;
  resolvedStateIds?: string[];
}

export interface DebugStoppedEvent {
  level: "message" | "state";
  sessionId: string;
  agentName?: string;
  stateId?: string;
  stateKind?: string;
  messageName?: string;
  reason: string;
  ctx?: Record<string, unknown>;
  self?: Record<string, unknown>;
}

export class DebugController {
  private interceptors = new Map<string, DebugInterceptor>();
  private advanceHooks = new Map<string, DebugAdvanceHook>();
  private sourceMaps = new Map<string, SourceMap>();
  private onStopped: ((event: DebugStoppedEvent) => void) | null = null;

  setOnStopped(cb: (event: DebugStoppedEvent) => void): void {
    this.onStopped = cb;
  }

  /**
   * Create debug instruments for a session.
   * Idempotent — returns existing instruments if already created.
   */
  createSession(sessionId: string, sourceMap?: SourceMap): {
    interceptorFn: InterceptorFn;
    advanceHook: AdvanceHook;
  } {
    if (this.interceptors.has(sessionId)) {
      if (sourceMap) this.sourceMaps.set(sessionId, sourceMap);
      return {
        interceptorFn: this.interceptors.get(sessionId)!.asInterceptorFn(),
        advanceHook: this.advanceHooks.get(sessionId)!.asAdvanceHook(),
      };
    }

    const interceptor = new DebugInterceptor();
    const advanceHook = new DebugAdvanceHook();

    interceptor.setOnEvent((event: DebugInterceptorEvent) => {
      if (event.kind === "stopped") {
        this.onStopped?.({
          level: "message",
          sessionId,
          messageName: event.held.envelope.messageName,
          agentName: event.held.envelope.to.agent,
          reason: "breakpoint",
        });
      }
    });

    advanceHook.setOnEvent((event: DebugAdvanceHookEvent) => {
      if (event.kind === "stopped") {
        this.onStopped?.({
          level: "state",
          sessionId,
          agentName: event.agentName,
          stateId: event.stateId,
          stateKind: event.stateKind,
          ctx: event.ctx,
          self: event.self,
          reason: event.reason,
        });
      }
    });

    this.interceptors.set(sessionId, interceptor);
    this.advanceHooks.set(sessionId, advanceHook);
    if (sourceMap) this.sourceMaps.set(sessionId, sourceMap);

    return {
      interceptorFn: interceptor.asInterceptorFn(),
      advanceHook: advanceHook.asAdvanceHook(),
    };
  }

  /**
   * Update source map for an existing session (e.g. after recompile/redeploy).
   * Creates the session lazily if it doesn't exist yet.
   */
  updateSourceMap(sessionId: string, sourceMap: SourceMap): void {
    this.sourceMaps.set(sessionId, sourceMap);
    if (!this.interceptors.has(sessionId)) {
      this.createSession(sessionId, sourceMap);
    }
  }

  /**
   * Set breakpoints for a session. Returns resolved breakpoints.
   * Lazily creates debug instruments if not yet created.
   */
  setBreakpoints(sessionId: string, breakpoints: Breakpoint[]): ResolvedBreakpoint[] {
    // Lazily create instruments if not yet created
    if (!this.interceptors.has(sessionId)) {
      this.createSession(sessionId);
    }

    const interceptor = this.interceptors.get(sessionId);
    const advanceHook = this.advanceHooks.get(sessionId);
    const sourceMap = this.sourceMaps.get(sessionId);

    const resolved: ResolvedBreakpoint[] = [];
    const messageBreakpoints: string[] = [];
    const stateBreakpoints: string[] = [];
    const stateKindBreakpoints: string[] = [];

    for (const bp of breakpoints) {
      switch (bp.type) {
        case "message": {
          messageBreakpoints.push(bp.value);
          resolved.push({ ...bp, resolved: true });
          break;
        }
        case "stateId": {
          stateBreakpoints.push(bp.value);
          resolved.push({ ...bp, resolved: true, resolvedStateIds: [bp.value] });
          break;
        }
        case "stateKind": {
          stateKindBreakpoints.push(bp.value);
          resolved.push({ ...bp, resolved: true });
          break;
        }
        case "sourceLine": {
          if (sourceMap && bp.file && bp.line !== undefined) {
            // Exact match first
            let matchingStates = sourceMap.entries
              .filter((e: SourceMapEntry) => e.file === bp.file && e.line === bp.line)
              .map((e: SourceMapEntry) => e.stateId);

            // Nearest-line snapping within ±5 lines
            if (matchingStates.length === 0) {
              const range = 5;
              let best: SourceMapEntry | undefined;
              let bestDist = range + 1;
              for (const e of sourceMap.entries) {
                if (e.file !== bp.file) continue;
                const dist = Math.abs(e.line - bp.line);
                if (dist > range) continue;
                if (dist < bestDist || (dist === bestDist && e.line > bp.line)) {
                  best = e;
                  bestDist = dist;
                }
              }
              if (best) {
                matchingStates = [best.stateId];
              }
            }

            if (matchingStates.length > 0) {
              stateBreakpoints.push(...matchingStates);
              resolved.push({ ...bp, resolved: true, resolvedStateIds: matchingStates });
            } else {
              resolved.push({ ...bp, resolved: false });
            }
          } else {
            resolved.push({ ...bp, resolved: false });
          }
          break;
        }
      }
    }

    interceptor?.setMessageBreakpoints(messageBreakpoints);
    if (messageBreakpoints.length > 0) {
      interceptor?.setPauseAll(false);
    }

    advanceHook?.setStateBreakpoints(stateBreakpoints);
    advanceHook?.setStateKindBreakpoints(stateKindBreakpoints);

    return resolved;
  }

  /**
   * Step one message forward (message-level).
   */
  stepMessage(sessionId: string): void {
    const interceptor = this.interceptors.get(sessionId);
    interceptor?.stepMessage();
  }

  /**
   * Step to next state (state-level).
   */
  stepState(sessionId: string): void {
    const hook = this.advanceHooks.get(sessionId);
    hook?.stepState();
  }

  /**
   * Step over — pause at next send/receive/terminal/action (state-level).
   */
  stepOver(sessionId: string): void {
    const hook = this.advanceHooks.get(sessionId);
    hook?.stepOver();
  }

  /**
   * Continue — release all held messages and resume execution.
   */
  continue(sessionId: string): void {
    const interceptor = this.interceptors.get(sessionId);
    const hook = this.advanceHooks.get(sessionId);
    interceptor?.continue();
    hook?.continue();
  }

  /**
   * Get held messages for a session.
   */
  getHeldMessages(sessionId: string): HeldMessage[] {
    const interceptor = this.interceptors.get(sessionId);
    return interceptor?.getHeld() ?? [];
  }

  /**
   * Remove debug instruments for a session.
   */
  destroySession(sessionId: string): void {
    const interceptor = this.interceptors.get(sessionId);
    interceptor?.dispose();
    this.interceptors.delete(sessionId);

    const hook = this.advanceHooks.get(sessionId);
    hook?.continue();
    this.advanceHooks.delete(sessionId);

    this.sourceMaps.delete(sessionId);
  }
}
