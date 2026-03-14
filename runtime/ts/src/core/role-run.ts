/**
 * RoleRun — R1 ontology.
 *
 * One local execution of one role inside one distributed ProtocolRun.
 * Wraps a RoleEngine, delegates to an AgentBehavior, and handles the
 * full advance loop: action, send, receive, guard, fork/join, scatter,
 * invoke, spawn, timer, try/catch.
 *
 * Replaces both ProtocolInstance (managed path) and the runEngine() loop
 * in CustomAgentHandle (custom path).
 */

import type {
  IRGraph,
  IRState,
  IRTransition,
  MessageEnvelope,
  TraceEvent,
} from "../contracts/types.js";
import {
  createMessageEnvelope,
  createTraceEvent,
} from "../contracts/types.js";
import type { ReagentTransport } from "../contracts/transport.js";
import type { TraceHook } from "../contracts/interceptor.js";
import type { AgentBehavior } from "../contracts/agent-behavior.js";
import type { RoleRunIdentity, RoleRunStatus } from "../contracts/protocol-run.js";
import type { RoleBindingSource, RoleBindingMap } from "../controller/role-bindings.js";
import { resolveRoleBinding, resolveSingleRoleBinding, setRoleBinding } from "../controller/role-bindings.js";
import { RoleEngine, durationToMs } from "./role-engine.js";
import type { ProtocolEvent, AgentResponse } from "./protocol-engine.js";

// ── Public interface ─────────────────────────────────────────────────

export interface RoleRunInterface {
  readonly identity: RoleRunIdentity;
  readonly engine: RoleEngine;
  readonly status: RoleRunStatus;

  dispatchMessage(env: MessageEnvelope): void;
  run(): Promise<void>;
  cancel(reason?: string): void;

  onComplete(cb: (status: "completed" | "failed" | "cancelled") => void): void;
  getTraces(): TraceEvent[];
  getReturnValue(): { has: boolean; value: unknown };
}

// ── Config ───────────────────────────────────────────────────────────

export interface RoleRunConfig {
  instanceId: string;
  protocolName: string;
  agentName: string;
  roleName: string;
  roleToAgent: RoleBindingSource;
  input?: Record<string, unknown>;
  traceHook?: TraceHook;
  advanceHook?: (ctx: AdvanceHookContext) => Promise<void>;
  roleSpawnCallback?: (request: RoleSpawnRequest) => string;
  invokeCallback?: (protoName: string, input?: Record<string, unknown>, roleMapping?: Record<string, string>) => Promise<unknown>;
  spawnCallback?: (protoName: string, input?: Record<string, unknown>, roleMapping?: Record<string, string>) => void;
  emitCallback?: (eventName: string, data?: Record<string, unknown>) => void;
}

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

export type RoleSpawnRequest = {
  roleName: string;
  config?: Record<string, unknown>;
  bindAs?: string;
  persistent: boolean;
  instanceId: string;
};

// ── Message expectations (internal) ──────────────────────────────────

type MessageExpectation = {
  messageName: string;
  fromRole?: string;
};

class RoleRunCancelledError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "RoleRunCancelledError";
    this.reason = reason;
  }
}

// ── RoleRun implementation ───────────────────────────────────────────

export class RoleRun implements RoleRunInterface {
  readonly identity: RoleRunIdentity;
  readonly engine: RoleEngine;

  private _status: RoleRunStatus = "idle";
  private behavior: AgentBehavior;
  private transport: ReagentTransport;
  private selfRef: Record<string, unknown>;
  private config: RoleRunConfig;

  private dynamicRoleBindings: RoleBindingMap = {};
  private baseRoleBindings: RoleBindingSource;
  private roleToAgent: RoleBindingSource;

  private messageResolvers: Array<{
    expectation: MessageExpectation;
    resolve: (env: MessageEnvelope) => void;
    reject: (err: Error) => void;
  }> = [];
  private xorResolvers = new Map<string, Array<{
    expectation: MessageExpectation;
    resolve: (env: MessageEnvelope) => void;
    reject: (err: Error) => void;
  }>>();
  private messageInbox: MessageEnvelope[] = [];

  private onCompleteCallbacks: Array<(status: "completed" | "failed" | "cancelled") => void> = [];
  private traces: TraceEvent[] = [];
  private returnValue: unknown = undefined;
  private hasReturnValue = false;
  private cancelReason: string | null = null;
  private completionFired = false;
  private timerHandles = new Set<ReturnType<typeof setTimeout>>();
  private sleepRejectors = new Map<ReturnType<typeof setTimeout>, (err: Error) => void>();

  constructor(
    graph: IRGraph,
    behavior: AgentBehavior,
    transport: ReagentTransport,
    selfRef: Record<string, unknown>,
    config: RoleRunConfig,
  ) {
    this.engine = new RoleEngine(graph, {
      instanceId: config.instanceId,
      protocolName: config.protocolName,
      agentName: config.agentName,
      roleName: config.roleName,
      selfRef,
      input: config.input,
    });
    this.identity = this.engine.identity;
    this.behavior = behavior;
    this.transport = transport;
    this.selfRef = selfRef;
    this.config = config;
    this.baseRoleBindings = config.roleToAgent;
    this.roleToAgent = (protocolName: string, roleName: string) =>
      resolveRoleBinding(this.dynamicRoleBindings, protocolName, roleName)
      ?? resolveRoleBinding(this.baseRoleBindings, protocolName, roleName);
  }

  get status(): RoleRunStatus { return this._status; }

  getStatus(): RoleRunStatus { return this._status; }

  rebindRole(roleName: string, agentName: string): void {
    this.learnDynamicBinding(roleName, agentName);
  }

  cancel(reason = "cancelled"): void {
    if (this._status === "completed" || this._status === "failed" || this._status === "cancelled") {
      return;
    }
    this.cancelReason = reason;
    this._status = "cancelled";
    this.engine.setStatus("failed");
    this.rejectPendingWaiters(new RoleRunCancelledError(reason));
    this.clearPendingTimers(new RoleRunCancelledError(reason));
  }

  dispatchMessage(env: MessageEnvelope): void {
    for (const [guardId, resolvers] of this.xorResolvers) {
      for (const r of resolvers) {
        if (this.matchesMessageExpectation(env, r.expectation)) {
          this.xorResolvers.delete(guardId);
          r.resolve(env);
          return;
        }
      }
    }

    const resolverIdx = this.messageResolvers.findIndex(
      entry => this.matchesMessageExpectation(env, entry.expectation),
    );
    if (resolverIdx >= 0) {
      const [{ resolve }] = this.messageResolvers.splice(resolverIdx, 1);
      resolve(env);
      return;
    }

    this.messageInbox.push(env);
  }

  async run(): Promise<void> {
    this._status = "running";
    this.engine.setStatus("running");
    try {
      this.emitTrace("ProtocolStarted", { protocolName: this.identity.protocolName });
      await this.advance();
      if (this.cancelReason && !this.completionFired) {
        this._status = "cancelled";
        this.engine.setStatus("failed");
        this.emitTrace("ProtocolFailed", { error: this.cancelReason, cancelled: true });
        this.fireOnComplete("cancelled");
      }
    } catch (err) {
      if (err instanceof RoleRunCancelledError || this.cancelReason) {
        const reason = err instanceof RoleRunCancelledError ? err.reason : (this.cancelReason ?? "cancelled");
        this._status = "cancelled";
        this.engine.setStatus("failed");
        this.emitTrace("ProtocolFailed", { error: reason, cancelled: true });
        this.fireOnComplete("cancelled");
        return;
      }
      console.error(`[RoleRun ${this.identity.instanceId}] Fatal error:`, err);
      this._status = "failed";
      this.engine.setStatus("failed");
      this.emitTrace("ProtocolFailed", { error: String(err) });
      this.fireOnComplete("failed");
    }
  }

  onComplete(cb: (status: "completed" | "failed" | "cancelled") => void): void {
    this.onCompleteCallbacks.push(cb);
  }

  getTraces(): TraceEvent[] { return this.traces; }

  getReturnValue(): { has: boolean; value: unknown } {
    return { has: this.hasReturnValue, value: this.returnValue };
  }

  // ── Internal advance loop ──────────────────────────────────────────

  private async advance(): Promise<void> {
    const engine = this.engine;

    while (engine.status === "running") {
      this.throwIfCancelled();
      const state = engine.getStateMap().get(engine.getCurrentStateId());
      if (!state) throw new Error(`State ${engine.getCurrentStateId()} not found`);

      if (this.config.advanceHook) {
        await this.config.advanceHook({
          instanceId: this.identity.instanceId,
          agentName: this.identity.agentName,
          stateId: state.id,
          stateKind: state.data.kind,
          protocolName: this.identity.protocolName,
          roleName: this.identity.roleName,
          ctx: { ...engine.ctx },
          self: { ...this.selfRef },
        });
      }

      const catchTarget = engine.getCatchTarget(state.id);
      if (catchTarget) engine.pushCatchTarget(catchTarget);
      if (state.data.kind === "error") engine.popCatchTarget();

      try {
        switch (state.data.kind) {
          case "initial":
            engine.setCurrentState(engine.followDefault());
            break;

          case "terminal":
            this.handleTerminal(state);
            return;

          case "action":
            await this.handleAction(state);
            break;

          case "send":
            await this.handleSend(state);
            engine.setCurrentState(engine.followDefault());
            break;

          case "receive": {
            const errorRecv = engine.findAlternateErrorReceive(state);
            if (errorRecv) {
              await this.handleReceiveWithErrorFallback(state, errorRecv);
            } else {
              await this.handleReceive(state);
              engine.setCurrentState(engine.followDefault());
            }
            break;
          }

          case "guard":
            await this.handleGuard(state);
            break;

          case "timer":
            await this.handleTimer(state);
            engine.setCurrentState(engine.followDefault());
            break;

          case "fork":
            await this.handleFork(state);
            break;

          case "join":
          case "error":
            engine.setCurrentState(engine.followDefault());
            break;

          case "invoke":
            await this.handleInvoke(state);
            engine.setCurrentState(engine.followDefault());
            break;

          case "async_invoke":
            await this.handleAsyncInvoke(state);
            engine.setCurrentState(engine.followDefault());
            break;

          case "spawn":
            await this.handleSpawn(state);
            engine.setCurrentState(engine.followDefault());
            break;

          case "scatter":
            await this.handleScatter(state);
            break;

          default:
            engine.setCurrentState(engine.followDefault());
            break;
        }
      } catch (err) {
        if (engine.hasCatchTargets()) {
          const catchId = engine.popCatchTarget()!;
          this.emitTrace("ErrorCaught", {
            stateId: state.id,
            error: err instanceof Error ? err.message : String(err),
            catchStateId: catchId,
          });
          engine.ctx.error = err instanceof Error ? err.message : String(err);
          engine.setCurrentState(catchId);
        } else {
          throw err;
        }
      }
    }
  }

  // ── State handlers ─────────────────────────────────────────────────

  private handleTerminal(state: IRState): void {
    const data = state.data as { kind: "terminal"; status: "completed" | "error" };
    const finalStatus: "completed" | "failed" = data.status === "completed" ? "completed" : "failed";
    this._status = finalStatus;
    this.engine.setStatus(finalStatus);
    this.emitTrace(
      finalStatus === "completed" ? "ProtocolCompleted" : "ProtocolFailed",
      { protocolName: this.identity.protocolName },
    );
    this.fireOnComplete(finalStatus);
  }

  private async handleAction(state: IRState): Promise<void> {
    const data = state.data as { kind: "action"; body: string; lang: string; async?: boolean };
    this.emitTrace("ActionStarted", { stateId: state.id });
    const resp = await this.behavior.handle({
      type: "action",
      stateId: state.id,
      body: data.body,
      lang: data.lang ?? "*",
      isAsync: data.async === true,
      ctx: this.engine.ctx,
      self: this.selfRef,
      invokeCallback: this.config.invokeCallback,
      spawnCallback: this.config.spawnCallback,
      emitCallback: this.config.emitCallback,
    });
    this.applyResponse(resp);
    if (resp.type === "return_value") {
      this.setReturnAndComplete(resp.value);
      return;
    }
    if (resp.type === "break_requested") {
      this.emitTrace("ActionFinished", { stateId: state.id, breakRequested: true });
      const exitId = this.engine.findLoopExit(state.id);
      if (exitId) {
        this.engine.setCurrentState(exitId);
        return;
      }
      throw new Error("reagent.break() called outside of a loop");
    }
    if (resp.type === "error_thrown") {
      throw resp.error instanceof Error ? resp.error : new Error(String(resp.error));
    }
    this.emitTrace("ActionFinished", { stateId: state.id });
    this.engine.setCurrentState(this.engine.followDefault());
  }

  private async handleSend(state: IRState): Promise<void> {
    const data = state.data as { kind: "send"; to: string; messageName: string; preSendZone?: string; preSendAsync?: boolean };
    this.engine.ctx.msg = {};

    if (data.preSendZone) {
      this.emitTrace("ActionStarted", { stateId: state.id, zone: "preSend" });
      const resp = await this.behavior.handle({
        type: "pre_send_action",
        stateId: state.id,
        body: data.preSendZone,
        isAsync: data.preSendAsync === true,
        ctx: this.engine.ctx,
        self: this.selfRef,
        invokeCallback: this.config.invokeCallback,
        spawnCallback: this.config.spawnCallback,
        emitCallback: this.config.emitCallback,
      });
      this.applyZoneResponse(resp, state.id);
      if (resp.type === "return_value" || resp.type === "break_requested") return;
      this.emitTrace("ActionFinished", { stateId: state.id, zone: "preSend" });
    }

    const payload = (this.engine.ctx.msg as Record<string, unknown>) ?? {};
    const scatterItem = this.engine.ctx._scatterItem;
    const toAgent = (typeof scatterItem === "string" && scatterItem !== this.identity.agentName)
      ? scatterItem
      : resolveSingleRoleBinding(this.roleToAgent, this.identity.protocolName, data.to);
    if (!toAgent) {
      const binding = resolveRoleBinding(this.roleToAgent, this.identity.protocolName, data.to);
      if (binding?.cardinality === "many" && binding.agents.length > 1) {
        throw new Error(
          `Role ${data.to} in protocol ${this.identity.protocolName} resolved to many agents (${binding.agents.join(", ")}); explicit narrowing is required before send`,
        );
      }
      throw new Error(`Cannot resolve agent for role ${data.to} in protocol ${this.identity.protocolName}`);
    }

    const env = createMessageEnvelope(
      this.identity.instanceId, this.identity.protocolName,
      this.identity.agentName, this.identity.roleName,
      toAgent, data.to, data.messageName, payload,
    );
    this.emitTrace("MessageSent", { messageName: data.messageName, to: toAgent, toRole: data.to });
    this.transport.ref(toAgent).sendEnvelope(env);
    delete this.engine.ctx.msg;
  }

  private async handleReceive(state: IRState): Promise<void> {
    const data = state.data as { kind: "receive"; from: string; messageName: string; postReceiveZone?: string; postReceiveAsync?: boolean };
    const env = await this.waitForMessage({ messageName: data.messageName, fromRole: data.from });
    this.learnDynamicBinding(env.from.role, env.from.agent);
    this.learnDynamicBinding(env.to.role, env.to.agent);
    this.emitTrace("MessageReceived", { messageName: data.messageName, from: env.from.agent, fromRole: env.from.role });
    this.engine.ctx.msg = env.payload;

    if (data.postReceiveZone) {
      this.emitTrace("ActionStarted", { stateId: state.id, zone: "postReceive" });
      const resp = await this.behavior.handle({
        type: "post_receive_action",
        stateId: state.id,
        body: data.postReceiveZone,
        isAsync: data.postReceiveAsync === true,
        ctx: this.engine.ctx,
        self: this.selfRef,
        invokeCallback: this.config.invokeCallback,
        spawnCallback: this.config.spawnCallback,
        emitCallback: this.config.emitCallback,
      });
      this.applyZoneResponse(resp, state.id);
      if (resp.type === "return_value" || resp.type === "break_requested") return;
      this.emitTrace("ActionFinished", { stateId: state.id, zone: "postReceive" });
    }
    delete this.engine.ctx.msg;
  }

  private async handleGuard(state: IRState): Promise<void> {
    const data = state.data as { kind: "guard"; guardType: string; expr?: string };
    const transitions = this.engine.getTransitionsFrom().get(state.id) ?? [];

    if (data.guardType === "xor") {
      await this.handleXorGuard(state, transitions);
      return;
    }

    if (data.guardType === "expression" && data.expr) {
      await this.handleExpressionGuard(state, data.expr, transitions);
      return;
    }

    this.engine.setCurrentState(this.engine.followDefault());
  }

  private async handleXorGuard(state: IRState, transitions: IRTransition[]): Promise<void> {
    const exprTransitions = transitions.filter(t => t.label.kind === "expression");
    const elseTransition = transitions.find(t => t.label.kind === "else");
    const msgTransitions = transitions.filter(t => t.label.kind === "message");

    if (exprTransitions.length > 0) {
      let anyEvalSucceeded = false;
      for (const t of exprTransitions) {
        const expr = (t.label as { kind: "expression"; expr: string }).expr;
        try {
          const result = this.engine.evalExpr(expr);
          anyEvalSucceeded = true;
          if (result) {
            this.emitTrace("GuardEvaluated", { expr, result: true });
            this.engine.setCurrentState(t.to);
            await this.advance();
            return;
          }
        } catch { /* non-deciding role */ }
      }

      if (anyEvalSucceeded) {
        if (elseTransition) {
          this.emitTrace("GuardEvaluated", { branch: "else" });
          this.engine.setCurrentState(elseTransition.to);
          await this.advance();
          return;
        }
        throw new Error(`No matching branch in XOR guard ${state.id}`);
      }

      const receiveExpectations = this.collectBranchReceiveExpectations([
        ...exprTransitions.map(t => t.to),
        ...(elseTransition ? [elseTransition.to] : []),
      ]);

      if (receiveExpectations.length > 0) {
        this.emitTrace("GuardEvaluated", { mode: "message-wait-fallback" });
        const result = await this.waitForAnyMessage(state.id, receiveExpectations);
        await this.processXorRecvResult(result);
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
      this.engine.ctx.msg = env.env.payload;
      this.engine.setCurrentState(env.targetStateId);
      await this.advance();
      return;
    }

    this.engine.setCurrentState(transitions[0]?.to ?? this.engine.getCurrentStateId());
    await this.advance();
  }

  private async handleExpressionGuard(state: IRState, expr: string, transitions: IRTransition[]): Promise<void> {
    const defaultT = transitions.find(t => t.label.kind === "default" || t.label.kind === "expression");
    const elseT = transitions.find(t => t.label.kind === "else");

    let evalSucceeded = false;
    try {
      if (this.engine.expressionVarsAreDefined(expr)) {
        const result = this.engine.evalExpr(expr);
        evalSucceeded = true;
        if (result) {
          if (defaultT) { this.engine.setCurrentState(defaultT.to); return; }
        } else {
          if (elseT) { this.engine.setCurrentState(elseT.to); return; }
        }
      }
    } catch { /* non-deciding role */ }

    if (!evalSucceeded && defaultT && elseT) {
      const receiveExpectations = this.collectBranchReceiveExpectations([defaultT.to, elseT.to]);
      if (receiveExpectations.length > 0) {
        this.emitTrace("GuardEvaluated", { mode: "loop-message-wait-fallback", expr });
        const result = await this.waitForAnyMessage(state.id,
          receiveExpectations.map(e => ({ messageName: e.messageName, fromRole: e.fromRole, targetStateId: e.targetStateId })),
        );
        await this.processXorRecvResult(result);
        return;
      }
    }

    if (elseT) { this.engine.setCurrentState(elseT.to); return; }
    this.engine.setCurrentState(this.engine.followDefault());
  }

  private async handleReceiveWithErrorFallback(
    normalRecvState: IRState,
    errorRecv: { stateId: string; messageName: string },
  ): Promise<void> {
    const normalData = normalRecvState.data as { kind: "receive"; messageName: string; from: string };
    const expectations = [
      { messageName: normalData.messageName, fromRole: normalData.from, targetStateId: normalRecvState.id },
      { messageName: errorRecv.messageName, targetStateId: errorRecv.stateId },
    ];

    this.emitTrace("GuardEvaluated", { mode: "try-catch-message-wait" });
    const result = await this.waitForAnyMessage(`trycatch_${normalRecvState.id}`, expectations);
    await this.processRecvResult(result);
  }

  private async handleTimer(state: IRState): Promise<void> {
    const data = state.data as { kind: "timer"; duration: { value: number; unit: string } };
    const ms = durationToMs(data.duration);
    this.emitTrace("TimerStarted", { stateId: state.id, durationMs: ms });
    await this.sleep(ms);
    this.emitTrace("TimerFired", { stateId: state.id });
  }

  private async handleFork(state: IRState): Promise<void> {
    const transitions = this.engine.getTransitionsFrom().get(state.id) ?? [];
    const branchTransitions = transitions.filter(t => t.label.kind === "branch");
    this.emitTrace("ForkStarted", { stateId: state.id, branchCount: branchTransitions.length });

    const joinId = this.engine.findJoinForFork(state.id);

    const branchPromises = branchTransitions.map(async (bt) => {
      const branchCtx = Object.create(this.engine.ctx);
      await this.runBranch(bt.to, joinId, branchCtx);
    });
    await Promise.all(branchPromises);
    this.emitTrace("JoinCompleted", { stateId: joinId ?? state.id });

    if (joinId) {
      this.engine.setCurrentState(joinId);
      this.engine.setCurrentState(this.engine.followDefault());
    } else {
      this.engine.setCurrentState(this.engine.followDefault());
    }
  }

  private async handleScatter(state: IRState): Promise<void> {
    const data = state.data as { kind: "scatter"; collection: string; itemRole: string; branchStartIds: string[] };
    this.emitTrace("ScatterStarted", { stateId: state.id, collection: data.collection, itemRole: data.itemRole });

    let list: unknown[];
    try {
      list = this.engine.evalExpr(data.collection) as unknown[];
    } catch { list = []; }

    if (!Array.isArray(list) || list.length === 0) {
      this.emitTrace("ScatterCompleted", { stateId: state.id, count: 0 });
      const joinId = this.engine.findJoinForFork(state.id);
      if (joinId) {
        this.engine.setCurrentState(joinId);
        this.engine.setCurrentState(this.engine.followDefault());
      } else {
        this.engine.setCurrentState(this.engine.followDefault());
      }
      return;
    }

    const joinId = this.engine.findJoinForFork(state.id);
    const branchStartId = data.branchStartIds[0];

    const branchPromises = list.map(async (item, idx) => {
      const branchCtx = Object.create(this.engine.ctx);
      branchCtx._scatterItem = item;
      branchCtx._scatterIdx = idx;
      await this.runBranch(branchStartId, joinId, branchCtx);
    });
    await Promise.all(branchPromises);
    this.emitTrace("ScatterCompleted", { stateId: state.id, count: list.length });

    if (joinId) {
      this.engine.setCurrentState(joinId);
      this.engine.setCurrentState(this.engine.followDefault());
    } else {
      this.engine.setCurrentState(this.engine.followDefault());
    }
  }

  private async handleInvoke(state: IRState): Promise<void> {
    const data = state.data as { kind: "invoke"; protocolName: string; input: string; resultTarget?: string };
    this.emitTrace("InvokeStarted", { stateId: state.id, protocolName: data.protocolName });

    if (!this.config.invokeCallback) {
      throw new Error(`reagent.invoke() for protocol "${data.protocolName}" but no invokeCallback set`);
    }

    let inputValue: Record<string, unknown> | undefined;
    try { inputValue = this.engine.evalExpr(data.input) as Record<string, unknown>; }
    catch { inputValue = {}; }

    const result = await this.config.invokeCallback(data.protocolName, inputValue);
    if (data.resultTarget) this.engine.assignTarget(data.resultTarget, result);
    this.emitTrace("InvokeCompleted", { stateId: state.id, protocolName: data.protocolName });
  }

  private async handleAsyncInvoke(state: IRState): Promise<void> {
    const data = state.data as { kind: "async_invoke"; protocolName: string; input: string };
    this.emitTrace("AsyncInvokeStarted", { stateId: state.id, protocolName: data.protocolName });

    if (!this.config.spawnCallback) {
      console.warn(`async invoke for protocol "${data.protocolName}" but no spawnCallback set`);
      return;
    }

    let inputValue: Record<string, unknown> | undefined;
    try { inputValue = this.engine.evalExpr(data.input) as Record<string, unknown>; }
    catch { inputValue = {}; }

    this.config.spawnCallback(data.protocolName, inputValue);
  }

  private async handleSpawn(state: IRState): Promise<void> {
    const data = state.data as { kind: "spawn"; roleName: string; config: string; bindAs?: string; resultTarget?: string; persistent: boolean };
    this.emitTrace("SpawnStarted", { stateId: state.id, roleName: data.roleName, bindAs: data.bindAs, persistent: data.persistent });

    if (!this.config.roleSpawnCallback) {
      throw new Error(`role spawn for "${data.roleName}" but no roleSpawnCallback set`);
    }

    let configValue: Record<string, unknown> | undefined;
    try { configValue = this.engine.evalExpr(data.config) as Record<string, unknown>; }
    catch { configValue = {}; }

    const spawnedAgent = this.config.roleSpawnCallback({
      roleName: data.roleName,
      config: configValue,
      bindAs: data.bindAs,
      persistent: data.persistent,
      instanceId: this.identity.instanceId,
    });

    if (data.bindAs) this.learnDynamicBinding(data.bindAs, spawnedAgent);
    if (data.resultTarget) this.engine.assignTarget(data.resultTarget, spawnedAgent);

    this.emitTrace("SpawnCompleted", {
      stateId: state.id, roleName: data.roleName,
      bindAs: data.bindAs, agentName: spawnedAgent, persistent: data.persistent,
    });
  }

  // ── Branch runner (for fork/join, scatter) ─────────────────────────

  private async runBranch(startId: string, stopAtId: string | null, branchCtx: Record<string, unknown>): Promise<void> {
    let currentId = startId;
    while (true) {
      if (stopAtId && currentId === stopAtId) return;
      const state = this.engine.getStateMap().get(currentId);
      if (!state) throw new Error(`State ${currentId} not found in branch`);

      switch (state.data.kind) {
        case "send": {
          const data = state.data as { kind: "send"; to: string; messageName: string; preSendZone?: string; preSendAsync?: boolean };
          branchCtx.msg = {};
          if (data.preSendZone) {
            this.emitTrace("ActionStarted", { stateId: state.id, zone: "preSend" });
            const resp = await this.behavior.handle({
              type: "pre_send_action", stateId: state.id, body: data.preSendZone,
              isAsync: data.preSendAsync === true, ctx: branchCtx, self: this.selfRef,
              invokeCallback: this.config.invokeCallback,
              spawnCallback: this.config.spawnCallback,
              emitCallback: this.config.emitCallback,
            });
            this.applyBranchZoneResponse(resp, branchCtx, state.id);
            if (resp.type === "return_value" || resp.type === "break_requested") return;
            this.emitTrace("ActionFinished", { stateId: state.id, zone: "preSend" });
          }
          const payload = (branchCtx.msg as Record<string, unknown>) ?? {};
          const scatterItem = branchCtx._scatterItem;
          const toAgent = (typeof scatterItem === "string" && scatterItem !== this.identity.agentName)
            ? scatterItem
            : resolveSingleRoleBinding(this.roleToAgent, this.identity.protocolName, data.to);
          if (!toAgent) {
            const binding = resolveRoleBinding(this.roleToAgent, this.identity.protocolName, data.to);
            if (binding?.cardinality === "many" && binding.agents.length > 1) {
              throw new Error(`Role ${data.to} resolved to many agents`);
            }
            throw new Error(`Cannot resolve agent for role ${data.to}`);
          }
          const env = createMessageEnvelope(
            this.identity.instanceId, this.identity.protocolName,
            this.identity.agentName, this.identity.roleName,
            toAgent, data.to, data.messageName, payload,
          );
          this.emitTrace("MessageSent", { messageName: data.messageName, to: toAgent, toRole: data.to });
          this.transport.ref(toAgent).sendEnvelope(env);
          delete branchCtx.msg;
          currentId = this.branchFollowDefault(currentId);
          break;
        }
        case "receive": {
          const data = state.data as { kind: "receive"; from: string; messageName: string; postReceiveZone?: string; postReceiveAsync?: boolean };
          const env = await this.waitForMessage({ messageName: data.messageName, fromRole: data.from });
          this.emitTrace("MessageReceived", { messageName: data.messageName, from: env.from.agent, fromRole: env.from.role });
          branchCtx.msg = env.payload;
          if (data.postReceiveZone) {
            this.emitTrace("ActionStarted", { stateId: state.id, zone: "postReceive" });
            const resp = await this.behavior.handle({
              type: "post_receive_action", stateId: state.id, body: data.postReceiveZone,
              isAsync: data.postReceiveAsync === true, ctx: branchCtx, self: this.selfRef,
              invokeCallback: this.config.invokeCallback,
              spawnCallback: this.config.spawnCallback,
              emitCallback: this.config.emitCallback,
            });
            this.applyBranchZoneResponse(resp, branchCtx, state.id);
            if (resp.type === "return_value" || resp.type === "break_requested") return;
            this.emitTrace("ActionFinished", { stateId: state.id, zone: "postReceive" });
          }
          delete branchCtx.msg;
          currentId = this.branchFollowDefault(currentId);
          break;
        }
        case "action": {
          const data = state.data as { kind: "action"; body: string; async?: boolean };
          this.emitTrace("ActionStarted", { stateId: state.id });
          const resp = await this.behavior.handle({
            type: "action", stateId: state.id, body: data.body,
            lang: "*", isAsync: data.async === true, ctx: branchCtx, self: this.selfRef,
            invokeCallback: this.config.invokeCallback,
            spawnCallback: this.config.spawnCallback,
            emitCallback: this.config.emitCallback,
          });
          this.applyBranchZoneResponse(resp, branchCtx, state.id);
          if (resp.type === "return_value" || resp.type === "break_requested") return;
          this.emitTrace("ActionFinished", { stateId: state.id });
          currentId = this.branchFollowDefault(currentId);
          break;
        }
        case "timer": {
          const data = state.data as { kind: "timer"; duration: { value: number; unit: string } };
          const ms = durationToMs(data.duration);
          this.emitTrace("TimerStarted", { stateId: state.id, durationMs: ms });
          await this.sleep(ms);
          this.emitTrace("TimerFired", { stateId: state.id });
          currentId = this.branchFollowDefault(currentId);
          break;
        }
        case "guard":
        case "initial":
        case "terminal":
        case "join":
          currentId = this.branchFollowDefault(currentId);
          break;
        default:
          currentId = this.branchFollowDefault(currentId);
          break;
      }
    }
  }

  private branchFollowDefault(stateId: string): string {
    const transitions = this.engine.getTransitionsFrom().get(stateId) ?? [];
    const def = transitions.find(t => t.label.kind === "default");
    if (def) return def.to;
    if (transitions.length > 0) return transitions[0].to;
    throw new Error(`No outgoing transition from state ${stateId} in branch`);
  }

  // ── Messaging helpers ──────────────────────────────────────────────

  private waitForMessage(expectation: MessageExpectation): Promise<MessageEnvelope> {
    const idx = this.messageInbox.findIndex(e => this.matchesMessageExpectation(e, expectation));
    if (idx >= 0) return Promise.resolve(this.messageInbox.splice(idx, 1)[0]);
    return new Promise<MessageEnvelope>((resolve, reject) => {
      this.messageResolvers.push({
        expectation,
        resolve: (env) => {
          if (this.cancelReason) {
            reject(new RoleRunCancelledError(this.cancelReason));
            return;
          }
          resolve(env);
        },
        reject,
      });
    });
  }

  private waitForAnyMessage(
    guardId: string,
    expectations: Array<MessageExpectation & { targetStateId: string }>,
  ): Promise<{ env: MessageEnvelope; targetStateId: string }> {
    for (const e of expectations) {
      const idx = this.messageInbox.findIndex(m => this.matchesMessageExpectation(m, e));
      if (idx >= 0) {
        return Promise.resolve({ env: this.messageInbox.splice(idx, 1)[0], targetStateId: e.targetStateId });
      }
    }
    return new Promise((resolve, reject) => {
      const resolvers = expectations.map(e => ({
        expectation: e,
        resolve: (env: MessageEnvelope) => {
          if (this.cancelReason) {
            reject(new RoleRunCancelledError(this.cancelReason));
            return;
          }
          resolve({ env, targetStateId: e.targetStateId });
        },
        reject,
      }));
      this.xorResolvers.set(guardId, resolvers);
    });
  }

  private matchesMessageExpectation(env: MessageEnvelope, expectation: MessageExpectation): boolean {
    if (env.messageName !== expectation.messageName) return false;
    if (expectation.fromRole && env.from.role !== expectation.fromRole) return false;
    if (!expectation.fromRole) return true;
    const binding = resolveRoleBinding(this.roleToAgent, this.identity.protocolName, expectation.fromRole);
    if (!binding || binding.agents.length === 0) return true;
    return binding.agents.includes(env.from.agent);
  }

  // ── Guard helpers ──────────────────────────────────────────────────

  private collectBranchReceiveExpectations(branchStartIds: string[]): Array<MessageExpectation & { targetStateId: string }> {
    const results: Array<MessageExpectation & { targetStateId: string }> = [];
    for (const branchStartId of branchStartIds) {
      const receiveId = this.engine.findFirstReceiveInBranch(branchStartId);
      if (receiveId) {
        const recvState = this.engine.getStateMap().get(receiveId);
        if (recvState?.data.kind === "receive") {
          const recvData = recvState.data as { kind: "receive"; messageName: string; from: string };
          results.push({ messageName: recvData.messageName, fromRole: recvData.from, targetStateId: receiveId });
        }
      }
    }
    return results;
  }

  private async processXorRecvResult(result: { env: MessageEnvelope; targetStateId: string }): Promise<void> {
    await this.processRecvResult(result);
  }

  private async processRecvResult(result: { env: MessageEnvelope; targetStateId: string }): Promise<void> {
    this.emitTrace("MessageReceived", {
      messageName: result.env.messageName,
      from: result.env.from.agent,
      fromRole: result.env.from.role,
    });
    this.engine.ctx.msg = result.env.payload;

    const recvState = this.engine.getStateMap().get(result.targetStateId);
    if (recvState?.data.kind === "receive") {
      const recvData = recvState.data as { kind: "receive"; postReceiveZone?: string; postReceiveAsync?: boolean };
      if (recvData.postReceiveZone) {
        this.emitTrace("ActionStarted", { stateId: result.targetStateId, zone: "postReceive" });
        const resp = await this.behavior.handle({
          type: "post_receive_action",
          stateId: result.targetStateId,
          body: recvData.postReceiveZone,
          isAsync: recvData.postReceiveAsync === true,
          ctx: this.engine.ctx,
          self: this.selfRef,
          invokeCallback: this.config.invokeCallback,
          spawnCallback: this.config.spawnCallback,
          emitCallback: this.config.emitCallback,
        });
        this.applyZoneResponse(resp, result.targetStateId);
        if (resp.type === "return_value" || resp.type === "break_requested") return;
        this.emitTrace("ActionFinished", { stateId: result.targetStateId, zone: "postReceive" });
      }
    }
    delete this.engine.ctx.msg;

    this.engine.setCurrentState(result.targetStateId);
    this.engine.setCurrentState(this.engine.followDefault());
    await this.advance();
  }

  // ── Response/trace/binding helpers ─────────────────────────────────

  private applyResponse(resp: AgentResponse): void {
    if (resp.type === "ctx_update") {
      this.engine.ctx = resp.ctx;
    }
  }

  /**
   * Apply a zone response, propagating errors and control flow
   * the same way handleAction does.
   */
  private applyZoneResponse(resp: AgentResponse, stateId: string): void {
    if (resp.type === "ctx_update") {
      this.engine.ctx = resp.ctx;
      return;
    }
    if (resp.type === "return_value") {
      this.setReturnAndComplete(resp.value);
      return;
    }
    if (resp.type === "break_requested") {
      const exitId = this.engine.findLoopExit(stateId);
      if (exitId) {
        this.engine.setCurrentState(exitId);
        return;
      }
      throw new Error("reagent.break() called outside of a loop");
    }
    if (resp.type === "error_thrown") {
      throw resp.error instanceof Error ? resp.error : new Error(String(resp.error));
    }
  }

  /** Same as applyZoneResponse but merges ctx into a branch-local context object. */
  private applyBranchZoneResponse(resp: AgentResponse, branchCtx: Record<string, unknown>, stateId: string): void {
    if (resp.type === "ctx_update") {
      Object.assign(branchCtx, resp.ctx);
      return;
    }
    if (resp.type === "return_value") {
      this.setReturnAndComplete(resp.value);
      return;
    }
    if (resp.type === "break_requested") {
      const exitId = this.engine.findLoopExit(stateId);
      if (exitId) {
        this.engine.setCurrentState(exitId);
        return;
      }
      throw new Error("reagent.break() called outside of a loop");
    }
    if (resp.type === "error_thrown") {
      throw resp.error instanceof Error ? resp.error : new Error(String(resp.error));
    }
  }

  private setReturnAndComplete(value: unknown): void {
    this.returnValue = value;
    this.hasReturnValue = true;
    this._status = "completed";
    this.engine.setReturnValue(value);
    this.emitTrace("ProtocolCompleted", { protocolName: this.identity.protocolName, returned: true });
    this.fireOnComplete("completed");
  }

  private fireOnComplete(status: "completed" | "failed" | "cancelled"): void {
    if (this.completionFired) return;
    this.completionFired = true;
    this.rejectPendingWaiters(new RoleRunCancelledError(this.cancelReason ?? status));
    this.clearPendingTimers();
    for (const cb of this.onCompleteCallbacks) cb(status);
  }

  private throwIfCancelled(): void {
    if (this.cancelReason) {
      throw new RoleRunCancelledError(this.cancelReason);
    }
  }

  private rejectPendingWaiters(err: RoleRunCancelledError): void {
    if (this.messageResolvers.length > 0) {
      for (const resolver of this.messageResolvers) {
        resolver.reject(err);
      }
      this.messageResolvers = [];
    }
    if (this.xorResolvers.size > 0) {
      for (const resolvers of this.xorResolvers.values()) {
        for (const resolver of resolvers) {
          resolver.reject(err);
        }
      }
      this.xorResolvers.clear();
    }
    if (this.cancelReason == null) {
      this.cancelReason = err.reason;
    }
  }

  private clearPendingTimers(err?: Error): void {
    for (const handle of this.timerHandles) {
      clearTimeout(handle);
      this.sleepRejectors.get(handle)?.(err ?? new Error("timer cleared"));
      this.sleepRejectors.delete(handle);
    }
    this.timerHandles.clear();
  }

  private async sleep(ms: number): Promise<void> {
    this.throwIfCancelled();
    await new Promise<void>((resolve, reject) => {
      const handle = setTimeout(() => {
        this.timerHandles.delete(handle);
        this.sleepRejectors.delete(handle);
        resolve();
      }, ms);
      this.timerHandles.add(handle);
      this.sleepRejectors.set(handle, reject);
      if (this.cancelReason) {
        clearTimeout(handle);
        this.timerHandles.delete(handle);
        this.sleepRejectors.delete(handle);
        reject(new RoleRunCancelledError(this.cancelReason));
      }
    });
    this.throwIfCancelled();
  }

  private participantCardinality(roleName: string): "single" | "many" {
    return this.engine.getGraph().participants?.find(p => p.name === roleName)?.cardinality ?? "single";
  }

  private learnDynamicBinding(roleName: string, agentName: string): void {
    const cardinality = this.participantCardinality(roleName);
    const existing = resolveRoleBinding(this.roleToAgent, this.identity.protocolName, roleName);
    if (cardinality === "many") {
      const agents = [...new Set([...(existing?.agents ?? []), agentName])];
      setRoleBinding(this.dynamicRoleBindings, this.identity.protocolName, roleName, { cardinality: "many", agents });
      return;
    }
    setRoleBinding(this.dynamicRoleBindings, this.identity.protocolName, roleName, agentName, "single");
  }

  private emitTrace(kind: string, data?: Record<string, unknown>): void {
    const te = createTraceEvent(
      this.identity.instanceId,
      kind as any,
      this.identity.agentName,
      { role: this.identity.roleName, protocolName: this.identity.protocolName, data },
    );
    this.traces.push(te);
    this.config.traceHook?.(te);
  }
}
