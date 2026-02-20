/**
 * DebugAdvanceHook — state-level breakpoints using PromiseGate.
 *
 * Wraps an AdvanceHook that pauses before each IR state.
 * Supports breakpoint matching on state IDs and step modes.
 */

import type { AdvanceHookContext, AdvanceHook } from "./protocol-instance.js";

export type StepMode = "none" | "stepState" | "stepOver";

export interface DebugAdvanceHookEvent {
  kind: "stopped";
  stateId: string;
  stateKind: string;
  agentName: string;
  instanceId: string;
  ctx: Record<string, unknown>;
  self: Record<string, unknown>;
  reason: "breakpoint" | "step";
}

/**
 * Simple promise-based gate: await gate.promise, then call gate.open() to release.
 */
interface PromiseGate {
  promise: Promise<void>;
  open: () => void;
}

function createGate(): PromiseGate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

export class DebugAdvanceHook {
  private stateBreakpoints = new Set<string>();
  private stateKindBreakpoints = new Set<string>();
  private stepMode: StepMode = "none";
  private enabled = true;
  private onEvent: ((event: DebugAdvanceHookEvent) => void) | null = null;
  private currentGate: PromiseGate | null = null;

  setOnEvent(cb: (event: DebugAdvanceHookEvent) => void): void {
    this.onEvent = cb;
  }

  setStateBreakpoints(stateIds: string[]): void {
    this.stateBreakpoints.clear();
    for (const id of stateIds) this.stateBreakpoints.add(id);
    if (stateIds.length > 0) this.enabled = true;
  }

  setStateKindBreakpoints(kinds: string[]): void {
    this.stateKindBreakpoints.clear();
    for (const k of kinds) this.stateKindBreakpoints.add(k);
    if (kinds.length > 0) this.enabled = true;
  }

  setStepMode(mode: StepMode): void {
    this.stepMode = mode;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Step to next state (stepState).
   */
  stepState(): void {
    this.stepMode = "stepState";
    this.enabled = true;
    this.releaseGate();
  }

  /**
   * Step over — pause at next send/receive/terminal only.
   */
  stepOver(): void {
    this.stepMode = "stepOver";
    this.enabled = true;
    this.releaseGate();
  }

  /**
   * Continue — release gate, disable stepping, and disable all breakpoints
   * until new breakpoints are configured.
   */
  continue(): void {
    this.stepMode = "none";
    this.enabled = false;
    this.releaseGate();
  }

  private releaseGate(): void {
    if (this.currentGate) {
      this.currentGate.open();
      this.currentGate = null;
    }
  }

  /**
   * Returns an AdvanceHook function for use in InstanceConfig.
   */
  asAdvanceHook(): AdvanceHook {
    return async (hookCtx: AdvanceHookContext): Promise<void> => {
      if (!this.enabled) return;

      const shouldPause = this.shouldPauseAt(hookCtx);
      if (!shouldPause) return;

      const reason: "breakpoint" | "step" = this.stateBreakpoints.has(hookCtx.stateId) || this.stateKindBreakpoints.has(hookCtx.stateKind)
        ? "breakpoint"
        : "step";

      this.onEvent?.({
        kind: "stopped",
        stateId: hookCtx.stateId,
        stateKind: hookCtx.stateKind,
        agentName: hookCtx.agentName,
        instanceId: hookCtx.instanceId,
        ctx: hookCtx.ctx,
        self: hookCtx.self,
        reason,
      });

      // Create a gate and wait for it to be opened
      this.currentGate = createGate();
      await this.currentGate.promise;
    };
  }

  private shouldPauseAt(ctx: AdvanceHookContext): boolean {
    if (this.stateBreakpoints.has(ctx.stateId)) return true;
    if (this.stateKindBreakpoints.has(ctx.stateKind)) return true;

    switch (this.stepMode) {
      case "stepState":
        return true;
      case "stepOver":
        return ctx.stateKind === "send" || ctx.stateKind === "receive" || ctx.stateKind === "terminal" || ctx.stateKind === "action";
      case "none":
      default:
        return false;
    }
  }
}
