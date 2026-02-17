/**
 * ProtocolInstance — interprets one IRGraph state machine for a single protocol instance.
 *
 * Each instance has its own $ctx and walks the state machine by:
 *   - Executing zone code at action/send/receive states
 *   - Publishing messages via NATS
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
  msgSubject,
  traceSubject,
} from "./types.js";
import { executeZone, createReagentStub, type ReagentStub } from "./zone-executor.js";
import type { NatsTransport } from "./nats-transport.js";

export type InstanceConfig = {
  instanceId: string;
  protocolName: string;
  agentName: string;
  roleName: string;
  roleToAgent: Record<string, string>;
  input?: Record<string, unknown>;
};

export type InstanceStatus = "running" | "completed" | "failed";

export class ProtocolInstance {
  readonly instanceId: string;
  readonly protocolName: string;
  readonly agentName: string;
  readonly roleName: string;

  private graph: IRGraph;
  private transport: NatsTransport;
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

  private onComplete: ((status: InstanceStatus) => void) | null = null;
  private traces: TraceEvent[] = [];

  constructor(
    graph: IRGraph,
    transport: NatsTransport,
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

    this.reagent = createReagentStub();
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

      switch (state.data.kind) {
        case "initial":
          this.currentStateId = this.followDefault();
          break;

        case "send":
          await this.handleSend(state);
          this.currentStateId = this.followDefault();
          break;

        case "receive":
          await this.handleReceive(state);
          this.currentStateId = this.followDefault();
          break;

        case "action":
          this.handleAction(state);
          this.currentStateId = this.followDefault();
          break;

        case "guard":
          await this.handleGuard(state);
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
          console.warn(`[instance] Unsupported state kind: ${state.data.kind}, skipping`);
          this.currentStateId = this.followDefault();
          break;
      }
    }
  }

  private async handleSend(state: IRState): Promise<void> {
    const data = state.data as { kind: "send"; to: string; messageName: string; preSendZone?: string };

    this.ctx.msg = {};

    if (data.preSendZone) {
      this.emitTrace("ActionStarted", { stateId: state.id, zone: "preSend" });
      executeZone(data.preSendZone, this.ctx, this.selfRef, this.reagent);
      this.emitTrace("ActionFinished", { stateId: state.id, zone: "preSend" });
    }

    const payload = (this.ctx.msg as Record<string, unknown>) ?? {};

    const toAgentKey = `${this.protocolName}.${data.to}`;
    const toAgent = this.config.roleToAgent[toAgentKey];
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

    this.transport.publish(
      msgSubject(this.instanceId, toAgent, data.messageName),
      env,
    );

    delete this.ctx.msg;
  }

  private async handleReceive(state: IRState): Promise<void> {
    const data = state.data as { kind: "receive"; from: string; messageName: string; postReceiveZone?: string };

    const env = await this.waitForMessage(data.messageName);

    this.emitTrace("MessageReceived", {
      messageName: data.messageName,
      from: env.from.agent,
      fromRole: env.from.role,
    });

    this.ctx.msg = env.payload;

    if (data.postReceiveZone) {
      this.emitTrace("ActionStarted", { stateId: state.id, zone: "postReceive" });
      executeZone(data.postReceiveZone, this.ctx, this.selfRef, this.reagent);
      this.emitTrace("ActionFinished", { stateId: state.id, zone: "postReceive" });
    }

    delete this.ctx.msg;
  }

  private handleAction(state: IRState): void {
    const data = state.data as { kind: "action"; body: string; lang: string };
    this.emitTrace("ActionStarted", { stateId: state.id });
    executeZone(data.body, this.ctx, this.selfRef, this.reagent);
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
        // Try evaluating expressions
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
          this.ctx.msg = result.env.payload;

          // Execute postReceiveZone if present on the matched receive state
          const recvState = this.stateMap.get(result.targetStateId);
          if (recvState && recvState.data.kind === "receive") {
            const recvData = recvState.data as { kind: "receive"; postReceiveZone?: string };
            if (recvData.postReceiveZone) {
              this.emitTrace("ActionStarted", { stateId: result.targetStateId, zone: "postReceive" });
              executeZone(recvData.postReceiveZone, this.ctx, this.selfRef, this.reagent);
              this.emitTrace("ActionFinished", { stateId: result.targetStateId, zone: "postReceive" });
            }
          }
          delete this.ctx.msg;

          // Advance past the receive state to next
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
      try {
        const result = new Function("$ctx", "$self", `return (${data.expr})`)(this.ctx, this.selfRef);
        if (result) {
          const defaultT = transitions.find(t => t.label.kind === "default" || t.label.kind === "expression");
          if (defaultT) {
            this.currentStateId = defaultT.to;
            return;
          }
        }
      } catch {
        // Fall through
      }
      const elseT = transitions.find(t => t.label.kind === "else");
      if (elseT) {
        this.currentStateId = elseT.to;
        return;
      }
    }

    // Passthrough guard — just follow default
    this.currentStateId = this.followDefault();
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
    return new Promise<MessageEnvelope>((resolve) => {
      this.messageResolvers.set(messageName, resolve);
    });
  }

  private waitForAnyMessage(
    guardId: string,
    expectations: Array<{ messageName: string; targetStateId: string }>,
  ): Promise<{ env: MessageEnvelope; targetStateId: string }> {
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
    this.transport.publish(traceSubject(this.instanceId), te);
  }
}
