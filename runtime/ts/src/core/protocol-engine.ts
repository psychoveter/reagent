/**
 * ProtocolEngine — pure FSM walker for Reagent protocol instances.
 *
 * Owns the IR graph, state machine state, and $ctx. Emits ProtocolEvent
 * objects that the orchestrating layer (e.g. ManagedAgentAdapter) handles.
 *
 * Does NOT execute zones, talk to transport, or manage traces directly.
 * These concerns are delegated via the event/response interface.
 */

import type {
  IRGraph,
  IRState,
  IRTransition,
  MessageEnvelope,
} from "../contracts/types.js";

// ── Event and Response types ─────────────────────────────────────────

export type ProtocolEvent =
  | { type: "protocol_started"; protocolName: string }
  | { type: "protocol_completed"; ctx: Record<string, unknown> }
  | { type: "protocol_failed"; error: string; ctx: Record<string, unknown> }
  | { type: "action"; stateId: string; body: string; lang: string; isAsync: boolean; ctx: Record<string, unknown>; self: Record<string, unknown> }
  | { type: "pre_send_action"; stateId: string; body: string; isAsync: boolean; ctx: Record<string, unknown>; self: Record<string, unknown> }
  | { type: "post_receive_action"; stateId: string; body: string; isAsync: boolean; ctx: Record<string, unknown>; self: Record<string, unknown> }
  | { type: "send_required"; stateId: string; to: string; messageName: string; ctx: Record<string, unknown>; scatterItem?: unknown }
  | { type: "receive_required"; stateId: string; from: string; messageName: string }
  | { type: "receive_any_required"; guardId: string; expectations: Array<{ messageName: string; targetStateId: string }> }
  | { type: "guard_evaluated"; data: Record<string, unknown> }
  | { type: "timer_required"; stateId: string; durationMs: number }
  | { type: "scatter_required"; stateId: string; items: unknown[]; branchStartId: string; joinId: string | null }
  | { type: "fork_required"; stateId: string; branchStartIds: string[]; joinId: string | null }
  | { type: "invoke_required"; stateId: string; protocolName: string; input: unknown }
  | { type: "async_invoke_required"; stateId: string; protocolName: string; input: unknown }
  | { type: "spawn_required"; stateId: string; protocolName: string; input: unknown }
  | { type: "advance_hook"; stateId: string; stateKind: string }
  | { type: "state_entered"; stateId: string; stateKind: string };

export type AgentResponse =
  | { type: "ctx_update"; ctx: Record<string, unknown> }
  | { type: "send_payload"; payload: Record<string, unknown> }
  | { type: "message_received"; env: MessageEnvelope }
  | { type: "message_any_received"; env: MessageEnvelope; targetStateId: string }
  | { type: "timer_fired" }
  | { type: "invoke_result"; value: unknown }
  | { type: "scatter_complete" }
  | { type: "fork_complete" }
  | { type: "noop" }
  | { type: "break_requested" }
  | { type: "return_value"; value: unknown }
  | { type: "error_thrown"; error: Error | string };

export type EngineStatus = "idle" | "running" | "completed" | "failed";

// ── Engine ───────────────────────────────────────────────────────────

export class ProtocolEngine {
  readonly instanceId: string;
  readonly protocolName: string;
  readonly agentName: string;
  readonly roleName: string;

  private graph: IRGraph;
  private stateMap: Map<string, IRState>;
  private transitionsFrom: Map<string, IRTransition[]>;
  private tryCatchMap: Map<string, string> = new Map();
  private catchStack: string[] = [];

  private _ctx: Record<string, unknown>;
  private _selfRef: Record<string, unknown>;
  private currentStateId: string;
  private _status: EngineStatus = "idle";

  private returnValue: unknown = undefined;
  private hasReturnValue = false;

  constructor(
    graph: IRGraph,
    config: {
      instanceId: string;
      protocolName: string;
      agentName: string;
      roleName: string;
      selfRef: Record<string, unknown>;
      input?: Record<string, unknown>;
    },
  ) {
    this.graph = graph;
    this.instanceId = config.instanceId;
    this.protocolName = config.protocolName;
    this.agentName = config.agentName;
    this.roleName = config.roleName;
    this._selfRef = config.selfRef;

    this._ctx = {};
    if (config.input) {
      this._ctx.input = config.input;
    }

    this.currentStateId = graph.initialStateId;

    this.stateMap = new Map();
    for (const s of graph.states) this.stateMap.set(s.id, s);

    this.transitionsFrom = new Map();
    for (const t of graph.transitions) {
      const arr = this.transitionsFrom.get(t.from) ?? [];
      arr.push(t);
      this.transitionsFrom.set(t.from, arr);
    }

    for (const t of graph.transitions) {
      if (t.label.kind === "error") {
        this.tryCatchMap.set(t.from, t.to);
      }
    }
  }

  get ctx(): Record<string, unknown> { return this._ctx; }
  set ctx(val: Record<string, unknown>) { this._ctx = val; }
  get selfRef(): Record<string, unknown> { return this._selfRef; }
  get status(): EngineStatus { return this._status; }

  getReturnValue(): { value: unknown; has: boolean } {
    return { value: this.returnValue, has: this.hasReturnValue };
  }

  getCurrentStateId(): string { return this.currentStateId; }

  getGraph(): IRGraph { return this.graph; }
  getStateMap(): Map<string, IRState> { return this.stateMap; }
  getTransitionsFrom(): Map<string, IRTransition[]> { return this.transitionsFrom; }

  setReturnValue(value: unknown): void {
    this.returnValue = value;
    this.hasReturnValue = true;
    this._status = "completed";
  }

  /**
   * Evaluate a guard expression against current ctx/self.
   * Returns undefined if the expression can't be evaluated (non-deciding role).
   */
  evalExpr(expr: string): unknown {
    return new Function("$ctx", "$self", `return (${expr})`)(this._ctx, this._selfRef);
  }

  /**
   * Check if all referenced $ctx/$self vars in an expression are defined.
   */
  expressionVarsAreDefined(expr: string): boolean {
    const ctxRefs = expr.match(/\$ctx\.(\w+)/g);
    const selfRefs = expr.match(/\$self\.(\w+)/g);

    if (ctxRefs) {
      for (const ref of ctxRefs) {
        const prop = ref.replace("$ctx.", "");
        if (this._ctx[prop] === undefined) return false;
      }
    }
    if (selfRefs) {
      for (const ref of selfRefs) {
        const prop = ref.replace("$self.", "");
        if (this._selfRef[prop] === undefined) return false;
      }
    }
    return true;
  }

  /**
   * Walk from a branch start state looking for the first receive state.
   */
  findFirstReceiveInBranch(stateId: string): string | null {
    let current = stateId;
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      const st = this.stateMap.get(current);
      if (!st) return null;
      if (st.data.kind === "receive") return current;
      const trans = this.transitionsFrom.get(current) ?? [];
      const def = trans.find(t => t.label.kind === "default");
      if (def) {
        current = def.to;
      } else {
        return null;
      }
    }
    return null;
  }

  findJoinForFork(forkId: string): string | null {
    const transitions = this.transitionsFrom.get(forkId) ?? [];
    const branchStarts = transitions.filter(t => t.label.kind === "branch").map(t => t.to);

    for (const startId of branchStarts) {
      let current = startId;
      const visited = new Set<string>();
      while (!visited.has(current)) {
        visited.add(current);
        const st = this.stateMap.get(current);
        if (!st) break;
        if (st.data.kind === "join") return current;
        const trans = this.transitionsFrom.get(current) ?? [];
        const def = trans.find(t => t.label.kind === "default");
        if (def) {
          current = def.to;
        } else {
          break;
        }
      }
    }
    return null;
  }

  findLoopExit(fromStateId: string): string | null {
    const visited = new Set<string>();
    const queue = [fromStateId];
    while (queue.length > 0) {
      const sid = queue.shift()!;
      if (visited.has(sid)) continue;
      visited.add(sid);
      for (const t of this.graph.transitions) {
        if (t.to === sid) {
          const sourceState = this.stateMap.get(t.from);
          if (sourceState?.data.kind === "guard" && (sourceState.data as any).guardType === "expression") {
            const fromTrans = this.transitionsFrom.get(t.from) ?? [];
            const elseTrans = fromTrans.find(tr => tr.label.kind === "else");
            if (elseTrans) {
              return elseTrans.to;
            }
          }
          queue.push(t.from);
        }
      }
    }
    return null;
  }

  findAlternateErrorReceive(currentRecvState: IRState): { stateId: string; messageName: string } | null {
    if (this.catchStack.length === 0) return null;

    for (const [tryEntryId, catchTargetId] of this.tryCatchMap) {
      const tryDefaultReceiveId = this.findFirstReceiveInBranch(tryEntryId);
      if (tryDefaultReceiveId !== currentRecvState.id) continue;

      const errorReceiveId = this.findFirstReceiveInBranch(catchTargetId);
      if (errorReceiveId) {
        const errorRecvState = this.stateMap.get(errorReceiveId);
        if (errorRecvState?.data.kind === "receive") {
          const errorRecvData = errorRecvState.data as { kind: "receive"; messageName: string };
          return { stateId: errorReceiveId, messageName: errorRecvData.messageName };
        }
      }
    }
    return null;
  }

  /**
   * Advance to the next state following default transition.
   */
  followDefault(): string {
    const transitions = this.transitionsFrom.get(this.currentStateId) ?? [];
    const def = transitions.find(t => t.label.kind === "default");
    if (def) return def.to;
    if (transitions.length > 0) return transitions[0].to;
    throw new Error(`No outgoing transition from state ${this.currentStateId}`);
  }

  /**
   * Set the current state ID and status. Used by the orchestrating layer.
   */
  setCurrentState(stateId: string): void {
    this.currentStateId = stateId;
  }

  setStatus(status: EngineStatus): void {
    this._status = status;
  }

  pushCatchTarget(target: string): void {
    this.catchStack.push(target);
  }

  popCatchTarget(): string | undefined {
    return this.catchStack.pop();
  }

  hasCatchTargets(): boolean {
    return this.catchStack.length > 0;
  }

  getCatchTarget(stateId: string): string | undefined {
    return this.tryCatchMap.get(stateId);
  }

  assignTarget(target: string, value: unknown): void {
    if (target.startsWith("$ctx.")) {
      const key = target.slice(5);
      this._ctx[key] = value;
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────

export function durationToMs(duration: { value: number; unit: string }): number {
  switch (duration.unit) {
    case "ms": return duration.value;
    case "s": return duration.value * 1000;
    case "m": return duration.value * 60_000;
    case "h": return duration.value * 3_600_000;
    default: return duration.value;
  }
}
