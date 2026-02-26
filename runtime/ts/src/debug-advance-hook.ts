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
  protocolName: string;
  roleName: string;
  ctx: Record<string, unknown>;
  self: Record<string, unknown>;
  reason: "breakpoint" | "step";
}

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
  /** Per-instance gates keyed by instanceId:agentName:stateId to avoid deadlock. */
  private gates = new Map<string, PromiseGate>();

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

  stepState(): void {
    this.stepMode = "stepState";
    this.enabled = true;
    this.releaseAllGates();
  }

  stepOver(): void {
    this.stepMode = "stepOver";
    this.enabled = true;
    this.releaseAllGates();
  }

  continue(): void {
    this.stepMode = "none";
    this.enabled = this.stateBreakpoints.size > 0 || this.stateKindBreakpoints.size > 0;
    this.releaseAllGates();
  }

  private releaseAllGates(): void {
    for (const gate of this.gates.values()) {
      gate.open();
    }
    this.gates.clear();
  }

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
        protocolName: hookCtx.protocolName,
        roleName: hookCtx.roleName,
        ctx: hookCtx.ctx,
        self: hookCtx.self,
        reason,
      });

      const gateKey = `${hookCtx.instanceId}:${hookCtx.agentName}:${hookCtx.stateId}`;
      const gate = createGate();
      this.gates.set(gateKey, gate);
      await gate.promise;
      this.gates.delete(gateKey);
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
