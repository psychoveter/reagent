/**
 * ProtocolInstance — interprets one IRGraph state machine for a single protocol instance.
 *
 * Each instance has its own $ctx and walks the state machine by:
 *   - Executing zone code at action/send/receive states
 *   - Sending messages via ReagentTransport (AgentRef)
 *   - Waiting for incoming messages (dispatched by AgentRunner)
 */

import type {
  IRGraph,
  IRState,
  IRTransition,
  MessageEnvelope,
  TraceEvent,
} from "./types.js";
import {
  createMessageEnvelope,
  createTraceEvent,
} from "./types.js";
import { executeZone, executeZoneAsync, InvokeRequest, ReturnValue, BreakRequest, type ReagentStub } from "./zone-executor.js";
import type { ReagentTransport } from "./transport.js";
import type { TraceHook } from "./interceptor.js";

export interface AdvanceHookContext {
  instanceId: string;
  agentName: string;
  stateId: string;
  stateKind: string;
  protocolName: string;
  roleName: string;
  ctx: Record<string, unknown>;
  self: Record<string, unknown>;
}

export type AdvanceHook = (ctx: AdvanceHookContext) => Promise<void>;

export type InstanceConfig = {
  instanceId: string;
  protocolName: string;
  agentName: string;
  roleName: string;
  roleToAgent: Record<string, string>;
  input?: Record<string, unknown>;
  traceHook?: TraceHook;
  advanceHook?: AdvanceHook;
  extras?: Record<string, unknown>;
};

export type InstanceStatus = "running" | "completed" | "failed";

export class ProtocolInstance {
  readonly instanceId: string;
  readonly protocolName: string;
  readonly agentName: string;
  readonly roleName: string;

  private graph: IRGraph;
  private transport: ReagentTransport;
  private config: InstanceConfig;

  private ctx: Record<string, unknown>;
  private selfRef: Record<string, unknown>;
  private reagent: ReagentStub;

  private currentStateId: string;
  private stateMap: Map<string, IRState>;
  private transitionsFrom: Map<string, IRTransition[]>;

  private status: InstanceStatus = "running";
  private messageResolvers: Map<string, (env: MessageEnvelope) => void> = new Map();
  private xorResolvers: Map<string, { messageName: string; resolve: (env: MessageEnvelope) => void }[]> = new Map();
  private messageInbox: MessageEnvelope[] = [];
  /** Maps try-entry state IDs to their catch (error) target state ID */
  private tryCatchMap: Map<string, string> = new Map();
  /** Stack of active catch targets (for nested try/catch) */
  private catchStack: string[] = [];

  private onComplete: ((status: InstanceStatus) => void) | null = null;
  private traces: TraceEvent[] = [];

  /** Set by AgentRunner — used when a zone calls reagent.invoke() */
  private invokeCallback: ((protoName: string, input?: Record<string, unknown>) => Promise<unknown>) | null = null;
  /** Set by AgentRunner — used when a zone calls reagent.spawn() */
  private spawnCallback: ((protoName: string, input?: Record<string, unknown>) => void) | null = null;
  /** Set by AgentRunner — used when a zone calls reagent.emit() */
  private emitCallback: ((eventName: string, data?: Record<string, unknown>) => void) | null = null;
  /** Captured return value when a child protocol calls reagent.return() */
  private returnValue: unknown = undefined;
  private hasReturnValue = false;

  constructor(
    graph: IRGraph,
    transport: ReagentTransport,
    selfState: Record<string, unknown>,
    config: InstanceConfig,
  ) {
    this.graph = graph;
    this.transport = transport;
    this.selfRef = selfState;
    this.config = config;
    this.instanceId = config.instanceId;
    this.protocolName = config.protocolName;
    this.agentName = config.agentName;
    this.roleName = config.roleName;

    this.ctx = {};
    if (config.input) {
      this.ctx.input = config.input;
    }

    this.reagent = this.createBoundReagent();
    this.currentStateId = graph.initialStateId;

    this.stateMap = new Map();
    for (const s of graph.states) {
      this.stateMap.set(s.id, s);
    }

    this.transitionsFrom = new Map();
    for (const t of graph.transitions) {
      const arr = this.transitionsFrom.get(t.from) ?? [];
      arr.push(t);
      this.transitionsFrom.set(t.from, arr);
    }

    // Build try/catch scope map: for each state that has an error transition, record the catch target
    for (const t of graph.transitions) {
      if (t.label.kind === "error") {
        this.tryCatchMap.set(t.from, t.to);
      }
    }
  }

  private zoneExtras(): Record<string, unknown> | undefined {
    return this.config.extras ? { $agent: this.config.extras } : undefined;
  }

  getStatus(): InstanceStatus {
    return this.status;
  }

  getTraces(): TraceEvent[] {
    return this.traces;
  }

  setOnComplete(cb: (status: InstanceStatus) => void): void {
    this.onComplete = cb;
  }

  setInvokeCallback(cb: (protoName: string, input?: Record<string, unknown>) => Promise<unknown>): void {
    this.invokeCallback = cb;
  }

  setSpawnCallback(cb: (protoName: string, input?: Record<string, unknown>) => void): void {
    this.spawnCallback = cb;
  }

  setEmitCallback(cb: (eventName: string, data?: Record<string, unknown>) => void): void {
    this.emitCallback = cb;
  }

  getReturnValue(): { value: unknown; has: boolean } {
    return { value: this.returnValue, has: this.hasReturnValue };
  }

  private createBoundReagent(): ReagentStub {
    return {
      invoke: (proto, args) => {
        throw new InvokeRequest(proto as string, args as Record<string, unknown> | undefined);
      },
      return: (value) => {
        throw new ReturnValue(value);
      },
      spawn: (proto, args) => {
        this.spawnCallback?.(proto as string, args as Record<string, unknown> | undefined);
        this.emitTrace("Spawned", { protoName: proto as string });
      },
      emit: (eventName, data) => {
        this.emitCallback?.(eventName, data);
        this.emitTrace("EventEmitted", { eventName, data });
      },
      break: () => {
        throw new BreakRequest();
      },
    };
  }

  /** Called by AgentRunner when a message arrives for this instance */
  dispatchMessage(env: MessageEnvelope): void {
    // Check XOR resolvers first
    for (const [guardId, resolvers] of this.xorResolvers) {
      for (const r of resolvers) {
        if (r.messageName === env.messageName) {
          this.xorResolvers.delete(guardId);
          r.resolve(env);
          return;
        }
      }
    }

    // Check single-message resolvers
    const key = env.messageName;
    const resolver = this.messageResolvers.get(key);
    if (resolver) {
      this.messageResolvers.delete(key);
      resolver(env);
    } else {
      // Buffer for later — the receive state may not have registered yet
      // (common with synchronous loopback transport + par branches)
      this.messageInbox.push(env);
    }
  }

  /** Start walking the state machine */
  async run(): Promise<void> {
    try {
      this.emitTrace("ProtocolStarted", { protocolName: this.protocolName });
      await this.advance();
    } catch (err) {
      console.error(`[instance ${this.instanceId}] Fatal error:`, err);
      this.status = "failed";
      this.emitTrace("ProtocolFailed", { error: String(err) });
      this.onComplete?.("failed");
    }
  }

  private async advance(): Promise<void> {
    while (this.status === "running") {
      const state = this.stateMap.get(this.currentStateId);
      if (!state) {
        throw new Error(`State ${this.currentStateId} not found`);
      }

      if (this.config.advanceHook) {
        await this.config.advanceHook({
          instanceId: this.instanceId,
          agentName: this.config.agentName,
          stateId: state.id,
          stateKind: state.data.kind,
          protocolName: this.protocolName,
          roleName: this.roleName,
          ctx: { ...this.ctx },
          self: { ...this.selfRef },
        });
      }

      // Track try/catch scopes: if this state has an error transition, push catch target
      const catchTarget = this.tryCatchMap.get(state.id);
      if (catchTarget) {
        this.catchStack.push(catchTarget);
      }

      // If we've reached an error (catch) state, pop the corresponding try scope
      if (state.data.kind === "error") {
        this.catchStack.pop();
      }

      try {
        switch (state.data.kind) {
          case "initial":
            this.currentStateId = this.followDefault();
            break;

          case "send":
            await this.handleSend(state);
            this.currentStateId = this.followDefault();
            break;

        case "receive": {
          // Check if we're inside a try scope and there's an alternate receive on the error path
          const errorRecv = this.findAlternateErrorReceive(state);
          if (errorRecv) {
            await this.handleReceiveWithErrorFallback(state, errorRecv);
          } else {
            await this.handleReceive(state);
            this.currentStateId = this.followDefault();
          }
          break;
        }

          case "action":
            await this.handleAction(state);
            this.currentStateId = this.followDefault();
            break;

          case "guard":
            await this.handleGuard(state);
            break;

          case "timer":
            await this.handleTimer(state);
            this.currentStateId = this.followDefault();
            break;

          case "fork":
            await this.handleFork(state);
            break;

          case "join":
            this.currentStateId = this.followDefault();
            break;

          case "error":
            this.currentStateId = this.followDefault();
            break;

          case "invoke":
            await this.handleInvoke(state);
            this.currentStateId = this.followDefault();
            break;

          case "async_invoke":
            await this.handleAsyncInvoke(state);
            this.currentStateId = this.followDefault();
            break;

          case "spawn":
            await this.handleSpawn(state);
            this.currentStateId = this.followDefault();
            break;

          case "scatter":
            await this.handleScatter(state);
            break;

          case "terminal":
            this.status = state.data.status === "completed" ? "completed" : "failed";
            this.emitTrace(
              this.status === "completed" ? "ProtocolCompleted" : "ProtocolFailed",
              { protocolName: this.protocolName },
            );
            this.onComplete?.(this.status);
            return;

          default:
            console.warn(`[instance] Unsupported state kind: ${(state.data as any).kind}, skipping`);
            this.currentStateId = this.followDefault();
            break;
        }
      } catch (err) {
        if (err instanceof ReturnValue) {
          this.returnValue = err.value;
          this.hasReturnValue = true;
          this.status = "completed";
          this.emitTrace("ProtocolCompleted", { protocolName: this.protocolName, returned: true });
          this.onComplete?.("completed");
          return;
        }
        if (err instanceof BreakRequest) {
          this.emitTrace("ActionFinished", { stateId: state.id, breakRequested: true });
          const exitId = this.findLoopExit(state.id);
          if (exitId) {
            this.currentStateId = exitId;
            continue;
          }
          throw new Error("reagent.break() called outside of a loop");
        }
        // Zone threw an error — route to catch block if inside a try scope
        if (this.catchStack.length > 0) {
          const catchId = this.catchStack.pop()!;
          this.emitTrace("ErrorCaught", {
            stateId: state.id,
            error: err instanceof Error ? err.message : String(err),
            catchStateId: catchId,
          });
          this.ctx.error = err instanceof Error ? err.message : String(err);
          this.currentStateId = catchId;
          // Continue the advance loop (will process the catch/error state next)
        } else {
          throw err;
        }
      }
    }
  }

  private async handleSend(state: IRState): Promise<void> {
    const data = state.data as { kind: "send"; to: string; messageName: string; preSendZone?: string; preSendAsync?: boolean };

    this.ctx.msg = {};

    if (data.preSendZone) {
      this.emitTrace("ActionStarted", { stateId: state.id, zone: "preSend" });
      const result = this.execZone(data.preSendZone, !!data.preSendAsync);
      if (result instanceof Promise) await result;
      this.emitTrace("ActionFinished", { stateId: state.id, zone: "preSend" });
    }

    const payload = (this.ctx.msg as Record<string, unknown>) ?? {};

    const toAgentKey = `${this.protocolName}.${data.to}`;
    const scatterItem = this.ctx._scatterItem;
    const toAgent = (typeof scatterItem === "string" && scatterItem !== this.agentName)
      ? scatterItem
      : this.config.roleToAgent[toAgentKey];
    if (!toAgent) {
      throw new Error(`Cannot resolve agent for role ${data.to} in protocol ${this.protocolName}`);
    }

    const env = createMessageEnvelope(
      this.instanceId,
      this.protocolName,
      this.agentName,
      this.roleName,
      toAgent,
      data.to,
      data.messageName,
      payload,
    );

    this.emitTrace("MessageSent", {
      messageName: data.messageName,
      to: toAgent,
      toRole: data.to,
    });

    this.transport.ref(toAgent).sendEnvelope(env);

    delete this.ctx.msg;
  }

  private async handleReceive(state: IRState): Promise<void> {
    const data = state.data as { kind: "receive"; from: string; messageName: string; postReceiveZone?: string; postReceiveAsync?: boolean };

    const env = await this.waitForMessage(data.messageName);

    this.emitTrace("MessageReceived", {
      messageName: data.messageName,
      from: env.from.agent,
      fromRole: env.from.role,
    });

    this.ctx.msg = env.payload;

    if (data.postReceiveZone) {
      this.emitTrace("ActionStarted", { stateId: state.id, zone: "postReceive" });
      const result = this.execZone(data.postReceiveZone, !!data.postReceiveAsync);
      if (result instanceof Promise) await result;
      this.emitTrace("ActionFinished", { stateId: state.id, zone: "postReceive" });
    }

    delete this.ctx.msg;
  }

  private execZone(body: string, isAsync: boolean, reagentOverride?: ReagentStub): void | Promise<boolean> {
    const r = reagentOverride ?? this.reagent;
    if (isAsync) {
      return executeZoneAsync(body, this.ctx, this.selfRef, r, this.zoneExtras());
    }
    executeZone(body, this.ctx, this.selfRef, r, this.zoneExtras());
  }

  private async handleAction(state: IRState): Promise<void> {
    const data = state.data as { kind: "action"; body: string; lang: string; async?: boolean };
    this.emitTrace("ActionStarted", { stateId: state.id });
    try {
      const result = this.execZone(data.body, !!data.async);
      if (result instanceof Promise) await result;
    } catch (err) {
      if (err instanceof ReturnValue) {
        this.returnValue = err.value;
        this.hasReturnValue = true;
        this.emitTrace("ActionFinished", { stateId: state.id, returnValue: true });
        return;
      }
      if (err instanceof BreakRequest) {
        throw err;
      }
      if (err instanceof InvokeRequest) {
        if (!this.invokeCallback) {
          throw new Error("reagent.invoke() called but no invokeCallback set — ensure AgentRunner is configured");
        }
        const invokeResult = await this.invokeCallback(err.protoName, err.input);
        const cachedReagent: ReagentStub = {
          ...this.reagent,
          invoke: () => invokeResult,
        };
        const r2 = this.execZone(data.body, !!data.async, cachedReagent);
        if (r2 instanceof Promise) await r2;
        this.emitTrace("ActionFinished", { stateId: state.id, invoked: err.protoName });
        return;
      }
      throw err;
    }
    this.emitTrace("ActionFinished", { stateId: state.id });
  }

  private async handleGuard(state: IRState): Promise<void> {
    const data = state.data as { kind: "guard"; guardType: string; expr?: string };
    const transitions = this.transitionsFrom.get(state.id) ?? [];

    if (data.guardType === "xor") {
      const exprTransitions = transitions.filter(t => t.label.kind === "expression");
      const elseTransition = transitions.find(t => t.label.kind === "else");
      const msgTransitions = transitions.filter(t => t.label.kind === "message");

      if (exprTransitions.length > 0) {
        let anyEvalSucceeded = false;
        for (const t of exprTransitions) {
          const expr = (t.label as { kind: "expression"; expr: string }).expr;
          try {
            const result = new Function("$ctx", "$self", `return (${expr})`)(this.ctx, this.selfRef);
            anyEvalSucceeded = true;
            if (result) {
              this.emitTrace("GuardEvaluated", { expr, result: true });
              this.currentStateId = t.to;
              await this.advance();
              return;
            }
          } catch {
            // Expression failed (e.g. $ctx.result is undefined on the non-deciding side)
          }
        }

        if (anyEvalSucceeded) {
          // Expressions evaluated but none were true — use else branch
          if (elseTransition) {
            this.emitTrace("GuardEvaluated", { branch: "else" });
            this.currentStateId = elseTransition.to;
            await this.advance();
            return;
          }
          throw new Error(`No matching branch in XOR guard ${state.id}`);
        }

        // Expressions ALL failed to evaluate (non-deciding agent).
        // Fall through to message-based waiting: scan branch targets for receive states.
        const receiveExpectations: Array<{ messageName: string; targetStateId: string }> = [];

        const allBranchStarts = [
          ...exprTransitions.map(t => t.to),
          ...(elseTransition ? [elseTransition.to] : []),
        ];

        for (const branchStartId of allBranchStarts) {
          const receiveId = this.findFirstReceiveInBranch(branchStartId);
          if (receiveId) {
            const recvState = this.stateMap.get(receiveId);
            if (recvState && recvState.data.kind === "receive") {
              const recvData = recvState.data as { kind: "receive"; messageName: string };
              receiveExpectations.push({
                messageName: recvData.messageName,
                targetStateId: receiveId,
              });
            }
          }
        }

        if (receiveExpectations.length > 0) {
          this.emitTrace("GuardEvaluated", { mode: "message-wait-fallback" });
          const result = await this.waitForAnyMessage(state.id, receiveExpectations);

          this.emitTrace("MessageReceived", {
            messageName: result.env.messageName,
            from: result.env.from.agent,
            fromRole: result.env.from.role,
          });

          this.ctx.msg = result.env.payload;

          // Execute postReceiveZone if present on the matched receive state
          const recvState = this.stateMap.get(result.targetStateId);
          if (recvState && recvState.data.kind === "receive") {
            const recvData = recvState.data as { kind: "receive"; postReceiveZone?: string };
            if (recvData.postReceiveZone) {
              this.emitTrace("ActionStarted", { stateId: result.targetStateId, zone: "postReceive" });
              executeZone(recvData.postReceiveZone, this.ctx, this.selfRef, this.reagent, this.zoneExtras());
              this.emitTrace("ActionFinished", { stateId: result.targetStateId, zone: "postReceive" });
            }
          }
          delete this.ctx.msg;

          this.currentStateId = result.targetStateId;
          this.currentStateId = this.followDefault();
          await this.advance();
          return;
        }

        throw new Error(`No matching branch in XOR guard ${state.id}`);
      }

      if (msgTransitions.length > 0) {
        const env = await this.waitForAnyMessage(
          state.id,
          msgTransitions.map(t => ({
            messageName: (t.label as { kind: "message"; messageName: string }).messageName,
            targetStateId: t.to,
          })),
        );
        this.ctx.msg = env.env.payload;
        this.currentStateId = env.targetStateId;
        await this.advance();
        return;
      }

      this.currentStateId = transitions[0]?.to ?? this.currentStateId;
      await this.advance();
      return;
    }

    if (data.guardType === "expression" && data.expr) {
      const defaultT = transitions.find(t => t.label.kind === "default" || t.label.kind === "expression");
      const elseT = transitions.find(t => t.label.kind === "else");

      let evalSucceeded = false;
      let canDecide = true;
      try {
        // Check if this agent can actually decide: all $ctx vars in the expression must be defined
        canDecide = expressionVarsAreDefined(data.expr, this.ctx, this.selfRef);
        if (canDecide) {
          const result = new Function("$ctx", "$self", `return (${data.expr})`)(this.ctx, this.selfRef);
          evalSucceeded = true;
          if (result) {
            if (defaultT) {
              this.currentStateId = defaultT.to;
              return;
            }
          } else {
            if (elseT) {
              this.currentStateId = elseT.to;
              return;
            }
          }
        }
      } catch {
        // Expression failed — this role can't evaluate
      }

      if (!evalSucceeded && defaultT && elseT) {
        // Non-deciding agent: wait for a message to determine which branch
        const receiveExpectations: Array<{ messageName: string; targetStateId: string; branchId: string }> = [];

        for (const branch of [
          { id: "body", startId: defaultT.to },
          { id: "exit", startId: elseT.to },
        ]) {
          const recvId = this.findFirstReceiveInBranch(branch.startId);
          if (recvId) {
            const recvState = this.stateMap.get(recvId);
            if (recvState?.data.kind === "receive") {
              const recvData = recvState.data as { kind: "receive"; messageName: string };
              receiveExpectations.push({
                messageName: recvData.messageName,
                targetStateId: recvId,
                branchId: branch.id,
              });
            }
          }
        }

        if (receiveExpectations.length > 0) {
          this.emitTrace("GuardEvaluated", { mode: "loop-message-wait-fallback", expr: data.expr });
          const result = await this.waitForAnyMessage(state.id,
            receiveExpectations.map(e => ({ messageName: e.messageName, targetStateId: e.targetStateId })),
          );

          this.emitTrace("MessageReceived", {
            messageName: result.env.messageName,
            from: result.env.from.agent,
            fromRole: result.env.from.role,
          });

          this.ctx.msg = result.env.payload;

          const recvState = this.stateMap.get(result.targetStateId);
          if (recvState?.data.kind === "receive") {
            const recvData = recvState.data as { kind: "receive"; postReceiveZone?: string };
            if (recvData.postReceiveZone) {
              this.emitTrace("ActionStarted", { stateId: result.targetStateId, zone: "postReceive" });
              executeZone(recvData.postReceiveZone, this.ctx, this.selfRef, this.reagent, this.zoneExtras());
              this.emitTrace("ActionFinished", { stateId: result.targetStateId, zone: "postReceive" });
            }
          }
          delete this.ctx.msg;

          this.currentStateId = result.targetStateId;
          this.currentStateId = this.followDefault();
          await this.advance();
          return;
        }
      }

      if (elseT) {
        this.currentStateId = elseT.to;
        return;
      }
    }

    // Passthrough guard — just follow default
    this.currentStateId = this.followDefault();
  }

  /**
   * Check if there's an alternate error-path receive for the current try scope.
   * Returns the error-path receive state ID and message name, or null.
   */
  private findAlternateErrorReceive(currentRecvState: IRState): { stateId: string; messageName: string } | null {
    if (this.catchStack.length === 0) return null;

    // Find the try entry that has the error transition
    for (const [tryEntryId, catchTargetId] of this.tryCatchMap) {
      // Check if the current receive is in the try (non-error) path
      const tryDefaultReceiveId = this.findFirstReceiveInBranch(tryEntryId);
      if (tryDefaultReceiveId !== currentRecvState.id) continue;

      // Find the first receive in the error (catch) path
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
   * Handle a receive that might get either the normal message or the error-path message.
   * Waits for either, then routes to the appropriate path.
   */
  private async handleReceiveWithErrorFallback(
    normalRecvState: IRState,
    errorRecv: { stateId: string; messageName: string },
  ): Promise<void> {
    const normalData = normalRecvState.data as { kind: "receive"; messageName: string; postReceiveZone?: string };

    const expectations = [
      { messageName: normalData.messageName, targetStateId: normalRecvState.id },
      { messageName: errorRecv.messageName, targetStateId: errorRecv.stateId },
    ];

    this.emitTrace("GuardEvaluated", { mode: "try-catch-message-wait" });
    const result = await this.waitForAnyMessage(`trycatch_${normalRecvState.id}`, expectations);

    this.emitTrace("MessageReceived", {
      messageName: result.env.messageName,
      from: result.env.from.agent,
      fromRole: result.env.from.role,
    });

    this.ctx.msg = result.env.payload;

    const matchedState = this.stateMap.get(result.targetStateId);
    if (matchedState?.data.kind === "receive") {
      const recvData = matchedState.data as { kind: "receive"; postReceiveZone?: string };
      if (recvData.postReceiveZone) {
        this.emitTrace("ActionStarted", { stateId: result.targetStateId, zone: "postReceive" });
        executeZone(recvData.postReceiveZone, this.ctx, this.selfRef, this.reagent, this.zoneExtras());
        this.emitTrace("ActionFinished", { stateId: result.targetStateId, zone: "postReceive" });
      }
    }
    delete this.ctx.msg;

    this.currentStateId = result.targetStateId;
    this.currentStateId = this.followDefault();
  }

  private async handleInvoke(state: IRState): Promise<void> {
    const data = state.data as { kind: "invoke"; protocolName: string; input: string; roleMapping?: Record<string, string>; resultTarget?: string };
    this.emitTrace("InvokeStarted", { stateId: state.id, protocolName: data.protocolName });

    if (!this.invokeCallback) {
      throw new Error(`reagent.invoke() for protocol "${data.protocolName}" but no invokeCallback set`);
    }

    let inputValue: Record<string, unknown> | undefined;
    try {
      inputValue = new Function("$ctx", "$self", `return (${data.input})`)(this.ctx, this.selfRef) as Record<string, unknown>;
    } catch {
      inputValue = {};
    }

    const result = await this.invokeCallback(data.protocolName, inputValue);

    if (data.resultTarget) {
      this.assignTarget(data.resultTarget, result);
    }

    this.emitTrace("InvokeCompleted", { stateId: state.id, protocolName: data.protocolName });
  }

  private async handleAsyncInvoke(state: IRState): Promise<void> {
    const data = state.data as { kind: "async_invoke"; protocolName: string; input: string; roleMapping?: Record<string, string> };
    this.emitTrace("AsyncInvokeStarted", { stateId: state.id, protocolName: data.protocolName });

    if (!this.spawnCallback) {
      console.warn(`async invokes for protocol "${data.protocolName}" but no spawnCallback set`);
      return;
    }

    let inputValue: Record<string, unknown> | undefined;
    try {
      inputValue = new Function("$ctx", "$self", `return (${data.input})`)(this.ctx, this.selfRef) as Record<string, unknown>;
    } catch {
      inputValue = {};
    }

    this.spawnCallback(data.protocolName, inputValue);
  }

  /** @deprecated — handles legacy "spawn" IR states; new code emits "async_invoke" */
  private async handleSpawn(state: IRState): Promise<void> {
    const data = state.data as { kind: "spawn"; protocolName: string; input: string; roleMapping?: Record<string, string> };
    this.emitTrace("AsyncInvokeStarted", { stateId: state.id, protocolName: data.protocolName });

    if (!this.spawnCallback) {
      console.warn(`async invokes for protocol "${data.protocolName}" but no spawnCallback set`);
      return;
    }

    let inputValue: Record<string, unknown> | undefined;
    try {
      inputValue = new Function("$ctx", "$self", `return (${data.input})`)(this.ctx, this.selfRef) as Record<string, unknown>;
    } catch {
      inputValue = {};
    }

    this.spawnCallback(data.protocolName, inputValue);
  }

  private async handleScatter(state: IRState): Promise<void> {
    const data = state.data as { kind: "scatter"; collection: string; itemRole: string; branchStartIds: string[] };
    this.emitTrace("ScatterStarted", { stateId: state.id, collection: data.collection, itemRole: data.itemRole });

    let list: unknown[];
    try {
      list = new Function("$ctx", "$self", `return (${data.collection})`)(this.ctx, this.selfRef) as unknown[];
    } catch {
      list = [];
    }

    if (!Array.isArray(list) || list.length === 0) {
      this.emitTrace("ScatterCompleted", { stateId: state.id, count: 0 });
      const joinId = this.findJoinForFork(state.id);
      if (joinId) {
        this.currentStateId = joinId;
        this.currentStateId = this.followDefault();
      } else {
        this.currentStateId = this.followDefault();
      }
      return;
    }

    const joinId = this.findJoinForFork(state.id);
    const branchStartId = data.branchStartIds[0];

    const branchPromises = list.map(async (item, idx) => {
      const branchCtx = Object.create(this.ctx);
      branchCtx._scatterItem = item;
      branchCtx._scatterIdx = idx;
      const branchRunner = new BranchRunner(
        this.graph,
        this.transport,
        this.selfRef,
        this.config,
        branchCtx,
        this.reagent,
        this.stateMap,
        this.transitionsFrom,
        this.messageResolvers,
        this.xorResolvers,
        (kind, d) => this.emitTrace(kind, d),
        this.messageInbox,
      );
      await branchRunner.runFrom(branchStartId, joinId);
    });

    await Promise.all(branchPromises);
    this.emitTrace("ScatterCompleted", { stateId: state.id, count: list.length });

    if (joinId) {
      this.currentStateId = joinId;
      this.currentStateId = this.followDefault();
    } else {
      this.currentStateId = this.followDefault();
    }
  }

  /** Assign a value to a dot-path target like `$ctx.result` */
  private assignTarget(target: string, value: unknown): void {
    if (target.startsWith("$ctx.")) {
      const key = target.slice(5);
      this.ctx[key] = value;
    }
  }

  /**
   * Walk backwards from a state to find the loop exit (else transition from loop_guard).
   * Used by reagent.break() to jump out of a loop.
   */
  private findLoopExit(fromStateId: string): string | null {
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

  private async handleTimer(state: IRState): Promise<void> {
    const data = state.data as { kind: "timer"; duration: { value: number; unit: string } };
    const ms = durationToMs(data.duration);
    this.emitTrace("TimerStarted", { stateId: state.id, durationMs: ms });
    await new Promise<void>(resolve => setTimeout(resolve, ms));
    this.emitTrace("TimerFired", { stateId: state.id });
  }

  private async handleFork(state: IRState): Promise<void> {
    const data = state.data as { kind: "fork"; branchStartIds: string[] };
    const transitions = this.transitionsFrom.get(state.id) ?? [];
    const branchTransitions = transitions.filter(t => t.label.kind === "branch");

    this.emitTrace("ForkStarted", { stateId: state.id, branchCount: branchTransitions.length });

    const joinId = this.findJoinForFork(state.id);

    const branchPromises = branchTransitions.map(async (bt) => {
      const branchCtx = Object.create(this.ctx);
      const branchRunner = new BranchRunner(
        this.graph,
        this.transport,
        this.selfRef,
        this.config,
        branchCtx,
        this.reagent,
        this.stateMap,
        this.transitionsFrom,
        this.messageResolvers,
        this.xorResolvers,
        (kind, d) => this.emitTrace(kind, d),
        this.messageInbox,
      );
      await branchRunner.runFrom(bt.to, joinId);
    });

    await Promise.all(branchPromises);
    this.emitTrace("JoinCompleted", { stateId: joinId ?? state.id });

    if (joinId) {
      this.currentStateId = joinId;
      this.currentStateId = this.followDefault();
    } else {
      this.currentStateId = this.followDefault();
    }
  }

  private findJoinForFork(forkId: string): string | null {
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

  /**
   * Walk from a branch start state looking for the first receive state.
   * Follows default transitions through passthrough guards.
   */
  private findFirstReceiveInBranch(stateId: string): string | null {
    let current = stateId;
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      const st = this.stateMap.get(current);
      if (!st) return null;
      if (st.data.kind === "receive") return current;
      // Follow default transition through guards/actions
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

  private followDefault(): string {
    const transitions = this.transitionsFrom.get(this.currentStateId) ?? [];
    const def = transitions.find(t => t.label.kind === "default");
    if (def) return def.to;
    if (transitions.length > 0) return transitions[0].to;
    throw new Error(`No outgoing transition from state ${this.currentStateId}`);
  }

  private waitForMessage(messageName: string): Promise<MessageEnvelope> {
    const idx = this.messageInbox.findIndex(e => e.messageName === messageName);
    if (idx >= 0) {
      return Promise.resolve(this.messageInbox.splice(idx, 1)[0]);
    }
    return new Promise<MessageEnvelope>((resolve) => {
      this.messageResolvers.set(messageName, resolve);
    });
  }

  private waitForAnyMessage(
    guardId: string,
    expectations: Array<{ messageName: string; targetStateId: string }>,
  ): Promise<{ env: MessageEnvelope; targetStateId: string }> {
    for (const e of expectations) {
      const idx = this.messageInbox.findIndex(m => m.messageName === e.messageName);
      if (idx >= 0) {
        return Promise.resolve({ env: this.messageInbox.splice(idx, 1)[0], targetStateId: e.targetStateId });
      }
    }
    return new Promise((resolve) => {
      const resolvers = expectations.map(e => ({
        messageName: e.messageName,
        resolve: (env: MessageEnvelope) => {
          resolve({ env, targetStateId: e.targetStateId });
        },
      }));
      this.xorResolvers.set(guardId, resolvers);
    });
  }

  private emitTrace(kind: string, data?: Record<string, unknown>): void {
    const te = createTraceEvent(
      this.instanceId,
      kind as any,
      this.agentName,
      {
        role: this.roleName,
        protocolName: this.protocolName,
        data,
      },
    );
    this.traces.push(te);
    this.config.traceHook?.(te);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Check if all $ctx/$self property paths referenced in an expression are defined.
 * Returns false if any referenced variable is undefined (non-deciding agent).
 */
function expressionVarsAreDefined(
  expr: string,
  ctx: Record<string, unknown>,
  selfState: Record<string, unknown>,
): boolean {
  const ctxRefs = expr.match(/\$ctx\.(\w+)/g);
  const selfRefs = expr.match(/\$self\.(\w+)/g);

  if (ctxRefs) {
    for (const ref of ctxRefs) {
      const prop = ref.replace("$ctx.", "");
      if (ctx[prop] === undefined) return false;
    }
  }
  if (selfRefs) {
    for (const ref of selfRefs) {
      const prop = ref.replace("$self.", "");
      if (selfState[prop] === undefined) return false;
    }
  }
  return true;
}

function durationToMs(duration: { value: number; unit: string }): number {
  switch (duration.unit) {
    case "ms": return duration.value;
    case "s": return duration.value * 1000;
    case "m": return duration.value * 60_000;
    case "h": return duration.value * 3_600_000;
    default: return duration.value;
  }
}

/**
 * Runs a sub-section of the state machine for a parallel branch.
 * Shares $ctx, $self, transport, and message resolvers with the parent instance.
 */
class BranchRunner {
  constructor(
    private graph: IRGraph,
    private transport: ReagentTransport,
    private selfRef: Record<string, unknown>,
    private config: InstanceConfig,
    private ctx: Record<string, unknown>,
    private reagent: ReagentStub,
    private stateMap: Map<string, IRState>,
    private transitionsFrom: Map<string, IRTransition[]>,
    private messageResolvers: Map<string, (env: MessageEnvelope) => void>,
    private xorResolvers: Map<string, { messageName: string; resolve: (env: MessageEnvelope) => void }[]>,
    private emitTrace: (kind: string, data?: Record<string, unknown>) => void,
    private messageInbox: MessageEnvelope[] = [],
  ) {}

  private zoneExtras(): Record<string, unknown> | undefined {
    return this.config.extras ? { $agent: this.config.extras } : undefined;
  }

  async runFrom(startId: string, stopAtId: string | null): Promise<void> {
    let currentId = startId;

    while (true) {
      if (stopAtId && currentId === stopAtId) return;

      const state = this.stateMap.get(currentId);
      if (!state) throw new Error(`State ${currentId} not found in branch`);

      switch (state.data.kind) {
        case "send": {
          const data = state.data as { kind: "send"; to: string; messageName: string; preSendZone?: string; preSendAsync?: boolean };
          this.ctx.msg = {};
          if (data.preSendZone) {
            this.emitTrace("ActionStarted", { stateId: state.id, zone: "preSend" });
            if (data.preSendAsync) {
              await executeZoneAsync(data.preSendZone, this.ctx, this.selfRef, this.reagent, this.zoneExtras());
            } else {
              executeZone(data.preSendZone, this.ctx, this.selfRef, this.reagent, this.zoneExtras());
            }
            this.emitTrace("ActionFinished", { stateId: state.id, zone: "preSend" });
          }
          const payload = (this.ctx.msg as Record<string, unknown>) ?? {};
          const toAgentKey = `${this.config.protocolName}.${data.to}`;
          const scatterItem = this.ctx._scatterItem;
          const toAgent = (typeof scatterItem === "string" && scatterItem !== this.config.agentName)
            ? scatterItem
            : this.config.roleToAgent[toAgentKey];
          if (!toAgent) throw new Error(`Cannot resolve agent for role ${data.to}`);
          const env = createMessageEnvelope(
            this.config.instanceId, this.config.protocolName,
            this.config.agentName, this.config.roleName ?? "",
            toAgent, data.to, data.messageName, payload,
          );
          this.emitTrace("MessageSent", { messageName: data.messageName, to: toAgent, toRole: data.to });
          this.transport.ref(toAgent).sendEnvelope(env);
          delete this.ctx.msg;
          currentId = this.followDefault(currentId);
          break;
        }
        case "receive": {
          const data = state.data as { kind: "receive"; from: string; messageName: string; postReceiveZone?: string; postReceiveAsync?: boolean };
          const inboxIdx = this.messageInbox.findIndex(e => e.messageName === data.messageName);
          const env = inboxIdx >= 0
            ? this.messageInbox.splice(inboxIdx, 1)[0]
            : await new Promise<MessageEnvelope>(resolve => {
                this.messageResolvers.set(data.messageName, resolve);
              });
          this.emitTrace("MessageReceived", { messageName: data.messageName, from: env.from.agent, fromRole: env.from.role });
          this.ctx.msg = env.payload;
          if (data.postReceiveZone) {
            this.emitTrace("ActionStarted", { stateId: state.id, zone: "postReceive" });
            if (data.postReceiveAsync) {
              await executeZoneAsync(data.postReceiveZone, this.ctx, this.selfRef, this.reagent, this.zoneExtras());
            } else {
              executeZone(data.postReceiveZone, this.ctx, this.selfRef, this.reagent, this.zoneExtras());
            }
            this.emitTrace("ActionFinished", { stateId: state.id, zone: "postReceive" });
          }
          delete this.ctx.msg;
          currentId = this.followDefault(currentId);
          break;
        }
        case "action": {
          const data = state.data as { kind: "action"; body: string; async?: boolean };
          this.emitTrace("ActionStarted", { stateId: state.id });
          if (data.async) {
            await executeZoneAsync(data.body, this.ctx, this.selfRef, this.reagent, this.zoneExtras());
          } else {
            executeZone(data.body, this.ctx, this.selfRef, this.reagent, this.zoneExtras());
          }
          this.emitTrace("ActionFinished", { stateId: state.id });
          currentId = this.followDefault(currentId);
          break;
        }
        case "timer": {
          const data = state.data as { kind: "timer"; duration: { value: number; unit: string } };
          const ms = durationToMs(data.duration);
          this.emitTrace("TimerStarted", { stateId: state.id, durationMs: ms });
          await new Promise<void>(r => setTimeout(r, ms));
          this.emitTrace("TimerFired", { stateId: state.id });
          currentId = this.followDefault(currentId);
          break;
        }
        case "guard":
        case "initial":
        case "terminal":
        case "join":
          currentId = this.followDefault(currentId);
          break;
        default:
          currentId = this.followDefault(currentId);
          break;
      }
    }
  }

  private followDefault(stateId: string): string {
    const transitions = this.transitionsFrom.get(stateId) ?? [];
    const def = transitions.find(t => t.label.kind === "default");
    if (def) return def.to;
    if (transitions.length > 0) return transitions[0].to;
    throw new Error(`No outgoing transition from state ${stateId} in branch`);
  }
}
