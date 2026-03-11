/**
 * DebugController — coordinates message-level and state-level debugging.
 *
 * Manages per-session DebugInterceptor + DebugAdvanceHook instances.
 * Resolves breakpoints via source map, dispatches step/continue commands.
 */

import { DebugInterceptor, type DebugInterceptorEvent, type HeldMessage } from "./debug-interceptor.js";
import { DebugAdvanceHook, type DebugAdvanceHookEvent } from "./debug-advance-hook.js";
import type { SourceMap, SourceMapEntry } from "./session.js";
import type { AdvanceHook } from "../core/protocol-instance.js";
import type { InterceptorFn } from "../contracts/interceptor.js";
import type { DebugResolveHookFn } from "../controller/reagent-controller.js";

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
  level: "message" | "state" | "resolve";
  sessionId: string;
  agentName?: string;
  stateId?: string;
  stateKind?: string;
  messageName?: string;
  reason: string;
  ctx?: Record<string, unknown>;
  self?: Record<string, unknown>;
  role?: string;
  candidates?: string[];
  selected?: string[];
  pipelineSummary?: string;
}

interface ResolveGate {
  promise: Promise<void>;
  open: () => void;
}

function createResolveGate(): ResolveGate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

export class DebugController {
  private interceptors = new Map<string, DebugInterceptor>();
  private advanceHooks = new Map<string, DebugAdvanceHook>();
  private sourceMaps = new Map<string, SourceMap>();
  private resolveGates = new Map<string, ResolveGate[]>();
  private onStopped: ((event: DebugStoppedEvent) => void) | null = null;

  setOnStopped(cb: (event: DebugStoppedEvent) => void): void {
    this.onStopped = cb;
  }

  createSession(sessionId: string, sourceMap?: SourceMap): {
    interceptorFn: InterceptorFn;
    advanceHook: AdvanceHook;
    resolveHook: DebugResolveHookFn;
  } {
    if (this.interceptors.has(sessionId)) {
      if (sourceMap) this.sourceMaps.set(sessionId, sourceMap);
      return {
        interceptorFn: this.interceptors.get(sessionId)!.asInterceptorFn(),
        advanceHook: this.advanceHooks.get(sessionId)!.asAdvanceHook(),
        resolveHook: this.createResolveHookFn(sessionId),
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
      resolveHook: this.createResolveHookFn(sessionId),
    };
  }

  private createResolveHookFn(sessionId: string): DebugResolveHookFn {
    return async (data) => {
      this.onStopped?.({
        level: "resolve",
        sessionId,
        reason: "resolve",
        role: data.role,
        candidates: data.candidates,
        selected: data.selected,
        pipelineSummary: data.pipelineSummary,
      });

      const gate = createResolveGate();
      let gates = this.resolveGates.get(sessionId);
      if (!gates) {
        gates = [];
        this.resolveGates.set(sessionId, gates);
      }
      gates.push(gate);
      await gate.promise;
    };
  }

  updateSourceMap(sessionId: string, sourceMap: SourceMap): void {
    this.sourceMaps.set(sessionId, sourceMap);
    if (!this.interceptors.has(sessionId)) {
      this.createSession(sessionId, sourceMap);
    }
  }

  setBreakpoints(sessionId: string, breakpoints: Breakpoint[]): ResolvedBreakpoint[] {
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
            let matchingStates = sourceMap.entries
              .filter((e: SourceMapEntry) => e.file === bp.file && e.line === bp.line)
              .map((e: SourceMapEntry) => e.stateId);

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

  stepMessage(sessionId: string): void {
    const interceptor = this.interceptors.get(sessionId);
    interceptor?.stepMessage();
  }

  stepState(sessionId: string): void {
    const hook = this.advanceHooks.get(sessionId);
    hook?.stepState();
  }

  stepOver(sessionId: string): void {
    const hook = this.advanceHooks.get(sessionId);
    hook?.stepOver();
  }

  continue(sessionId: string): void {
    const interceptor = this.interceptors.get(sessionId);
    const hook = this.advanceHooks.get(sessionId);
    interceptor?.continue();
    hook?.continue();
    this.releaseResolveGates(sessionId);
  }

  private releaseResolveGates(sessionId: string): void {
    const gates = this.resolveGates.get(sessionId);
    if (gates) {
      for (const gate of gates) gate.open();
      this.resolveGates.delete(sessionId);
    }
  }

  getHeldMessages(sessionId: string): HeldMessage[] {
    const interceptor = this.interceptors.get(sessionId);
    return interceptor?.getHeld() ?? [];
  }

  destroySession(sessionId: string): void {
    const interceptor = this.interceptors.get(sessionId);
    interceptor?.dispose();
    this.interceptors.delete(sessionId);

    const hook = this.advanceHooks.get(sessionId);
    hook?.continue();
    this.advanceHooks.delete(sessionId);

    this.releaseResolveGates(sessionId);
    this.sourceMaps.delete(sessionId);
  }
}
