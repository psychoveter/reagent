/**
 * CustomAgentNode — AgentNode for user-implemented agents.
 *
 * Instead of executing zones from .rg files, the user provides a class
 * that implements AgentInterface.handle(). The RC calls it for each
 * ProtocolEvent, giving the user full control over agent behavior.
 */

import type { RoleIR, IRGraph, MessageEnvelope, ProtocolTrigger } from "./types.js";
import type { ReagentTransport } from "./transport.js";
import type { AgentNode, AgentHandle } from "./agent-node.js";
import type { AgentInterface } from "./agent-interface.js";
import { ProtocolEngine, durationToMs } from "./protocol-engine.js";
import type { ProtocolEvent, AgentResponse } from "./protocol-engine.js";
import { createMessageEnvelope, createTraceEvent } from "./types.js";
import type { TraceHook } from "./interceptor.js";

export interface CustomAgentNodeConfig {
  roleToAgent: Record<string, string>;
  agentFactory: (agentName: string, roleIR: RoleIR) => AgentInterface;
  traceHook?: TraceHook;
}

export class CustomAgentHandle implements AgentHandle {
  readonly agentName: string;
  private agent: AgentInterface;
  private graphs: Map<string, IRGraph>;
  private transport: ReagentTransport;
  private roleToAgent: Record<string, string>;
  private selfState: Record<string, unknown> = {};
  private instances: Map<string, ProtocolEngine> = new Map();
  private completionCount = 0;
  private completionWaiters: Array<{ target: number; resolve: () => void }> = [];
  private traceHook?: TraceHook;

  constructor(
    agentName: string,
    agent: AgentInterface,
    graphs: Map<string, IRGraph>,
    transport: ReagentTransport,
    roleToAgent: Record<string, string>,
    traceHook?: TraceHook,
  ) {
    this.agentName = agentName;
    this.agent = agent;
    this.graphs = graphs;
    this.transport = transport;
    this.roleToAgent = roleToAgent;
    this.traceHook = traceHook;
  }

  async start(): Promise<void> {
    console.log(`[${this.agentName}] Custom agent started`);
  }

  async stop(): Promise<void> {
    console.log(`[${this.agentName}] Custom agent stopped`);
  }

  getSelf(): Record<string, unknown> {
    return this.selfState;
  }

  getInstances(): Map<string, ProtocolEngine> {
    return this.instances;
  }

  waitForCompletion(expectedCount: number, timeoutMs = 10000): Promise<void> {
    if (this.completionCount >= expectedCount) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${expectedCount} completions`)), timeoutMs);
      this.completionWaiters.push({
        target: expectedCount,
        resolve: () => { clearTimeout(timer); resolve(); },
      });
    });
  }

  triggerProtocol(trigger: ProtocolTrigger): void {
    const graphKey = `${trigger.protocolName}.${this.findRoleForProtocol(trigger.protocolName)}`;
    const graph = this.graphs.get(graphKey);
    if (!graph) {
      console.warn(`[${this.agentName}] No graph for ${graphKey}`);
      return;
    }

    const roleName = graph.role;
    const engine = new ProtocolEngine(graph, {
      instanceId: trigger.instanceId,
      protocolName: trigger.protocolName,
      agentName: this.agentName,
      roleName,
      selfRef: this.selfState,
      input: trigger.input as Record<string, unknown>,
    });

    this.instances.set(trigger.instanceId, engine);
    this.runEngine(engine, trigger.roleToAgent ?? this.roleToAgent).catch((err) => {
      console.error(`[${this.agentName}] Engine error:`, err);
    });
  }

  dispatchMessage(env: MessageEnvelope): void {
    const engine = this.instances.get(env.instanceId);
    if (!engine) {
      console.warn(`[${this.agentName}] No instance for ${env.instanceId}, ignoring message ${env.messageName}`);
      return;
    }
    // Store message for pickup by the running engine loop
    const inbox = (engine as any)._messageInbox ?? [];
    inbox.push(env);
    (engine as any)._messageInbox = inbox;

    // Resolve any waiting message promises
    const resolvers = (engine as any)._messageResolvers as Map<string, (env: MessageEnvelope) => void> | undefined;
    if (resolvers) {
      const resolver = resolvers.get(env.messageName);
      if (resolver) {
        resolvers.delete(env.messageName);
        resolver(env);
      }
    }
  }

  private findRoleForProtocol(protocolName: string): string | undefined {
    for (const [key] of this.graphs) {
      if (key.startsWith(`${protocolName}.`)) {
        return key.split(".")[1];
      }
    }
    return undefined;
  }

  private async runEngine(engine: ProtocolEngine, roleToAgent: Record<string, string>): Promise<void> {
    engine.setStatus("running");
    const messageInbox: MessageEnvelope[] = (engine as any)._messageInbox ?? [];
    (engine as any)._messageInbox = messageInbox;
    const messageResolvers = new Map<string, (env: MessageEnvelope) => void>();
    (engine as any)._messageResolvers = messageResolvers;

    const emitTrace = (kind: string, data?: Record<string, unknown>) => {
      if (this.traceHook) {
        this.traceHook(createTraceEvent(
          engine.instanceId, kind as any, this.agentName,
          { role: engine.roleName, protocolName: engine.protocolName, data },
        ));
      }
    };

    const waitForMessage = (messageName: string): Promise<MessageEnvelope> => {
      const idx = messageInbox.findIndex(e => e.messageName === messageName);
      if (idx >= 0) return Promise.resolve(messageInbox.splice(idx, 1)[0]);
      return new Promise(resolve => messageResolvers.set(messageName, resolve));
    };

    try {
      emitTrace("ProtocolStarted", { protocolName: engine.protocolName });

      while (engine.status === "running") {
        const state = engine.getStateMap().get(engine.getCurrentStateId());
        if (!state) throw new Error(`State ${engine.getCurrentStateId()} not found`);

        const catchTarget = engine.getCatchTarget(state.id);
        if (catchTarget) engine.pushCatchTarget(catchTarget);
        if (state.data.kind === "error") engine.popCatchTarget();

        try {
          switch (state.data.kind) {
            case "initial":
              engine.setCurrentState(engine.followDefault());
              break;

            case "terminal":
              engine.setStatus(state.data.status === "completed" ? "completed" : "failed");
              emitTrace(engine.status === "completed" ? "ProtocolCompleted" : "ProtocolFailed",
                { protocolName: engine.protocolName });
              this.onInstanceComplete(engine.instanceId);
              return;

            case "action": {
              emitTrace("ActionStarted", { stateId: state.id });
              if (typeof (this.agent as any).setCurrentInstance === "function") {
                (this.agent as any).setCurrentInstance(engine.instanceId, engine.protocolName, engine.roleName);
              }
              const resp = await this.agent.handle({
                type: "action",
                stateId: state.id,
                body: state.data.body,
                lang: state.data.lang ?? "*",
                isAsync: !!state.data.async,
                ctx: engine.ctx,
                self: engine.selfRef,
              });
              this.applyResponse(engine, resp);
              if (resp.type === "return_value") {
                engine.setReturnValue(resp.value);
                emitTrace("ProtocolCompleted", { protocolName: engine.protocolName, returned: true });
                this.onInstanceComplete(engine.instanceId);
                return;
              }
              if (resp.type === "break_requested") {
                const exitId = engine.findLoopExit(state.id);
                if (exitId) { engine.setCurrentState(exitId); break; }
                throw new Error("reagent.break() called outside of a loop");
              }
              emitTrace("ActionFinished", { stateId: state.id });
              engine.setCurrentState(engine.followDefault());
              break;
            }

            case "send": {
              const data = state.data as any;
              engine.ctx.msg = {};
              if (data.preSendZone) {
                emitTrace("ActionStarted", { stateId: state.id, zone: "preSend" });
                if (typeof (this.agent as any).setCurrentInstance === "function") {
                  (this.agent as any).setCurrentInstance(engine.instanceId, engine.protocolName, engine.roleName);
                }
                const resp = await this.agent.handle({
                  type: "pre_send_action",
                  stateId: state.id,
                  body: data.preSendZone,
                  isAsync: !!data.preSendAsync,
                  ctx: engine.ctx,
                  self: engine.selfRef,
                });
                this.applyResponse(engine, resp);
                emitTrace("ActionFinished", { stateId: state.id, zone: "preSend" });
              }
              const payload = (engine.ctx.msg as Record<string, unknown>) ?? {};
              const toAgentKey = `${engine.protocolName}.${data.to}`;
              const toAgent = roleToAgent[toAgentKey];
              if (!toAgent) throw new Error(`Cannot resolve agent for role ${data.to}`);

              const env = createMessageEnvelope(
                engine.instanceId, engine.protocolName,
                this.agentName, engine.roleName,
                toAgent, data.to, data.messageName, payload,
              );
              emitTrace("MessageSent", { messageName: data.messageName, to: toAgent, toRole: data.to });
              this.transport.ref(toAgent).sendEnvelope(env);
              delete engine.ctx.msg;
              engine.setCurrentState(engine.followDefault());
              break;
            }

            case "receive": {
              const data = state.data as any;
              const env = await waitForMessage(data.messageName);
              emitTrace("MessageReceived", { messageName: data.messageName, from: env.from.agent, fromRole: env.from.role });
              engine.ctx.msg = env.payload;
              if (data.postReceiveZone) {
                emitTrace("ActionStarted", { stateId: state.id, zone: "postReceive" });
                if (typeof (this.agent as any).setCurrentInstance === "function") {
                  (this.agent as any).setCurrentInstance(engine.instanceId, engine.protocolName, engine.roleName);
                }
                const resp = await this.agent.handle({
                  type: "post_receive_action",
                  stateId: state.id,
                  body: data.postReceiveZone,
                  isAsync: !!data.postReceiveAsync,
                  ctx: engine.ctx,
                  self: engine.selfRef,
                });
                this.applyResponse(engine, resp);
                emitTrace("ActionFinished", { stateId: state.id, zone: "postReceive" });
              }
              delete engine.ctx.msg;
              engine.setCurrentState(engine.followDefault());
              break;
            }

            case "timer": {
              const ms = durationToMs(state.data.duration as any);
              emitTrace("TimerStarted", { stateId: state.id, durationMs: ms });
              await new Promise<void>(r => setTimeout(r, ms));
              emitTrace("TimerFired", { stateId: state.id });
              engine.setCurrentState(engine.followDefault());
              break;
            }

            case "async_invoke":
            case "spawn": {
              const d = state.data as { protocolName: string; input: string };
              let inputValue: unknown;
              try {
                inputValue = new Function("$ctx", "$self", `return (${d.input})`)(engine.ctx, engine.selfRef);
              } catch { inputValue = {}; }
              emitTrace("AsyncInvokeStarted", { stateId: state.id, protocolName: d.protocolName });
              this.agent.handle({
                type: "async_invoke_required",
                stateId: state.id,
                protocolName: d.protocolName,
                input: inputValue,
              } as any);
              engine.setCurrentState(engine.followDefault());
              break;
            }

            case "guard":
            case "join":
            case "error":
              engine.setCurrentState(engine.followDefault());
              break;

            default:
              engine.setCurrentState(engine.followDefault());
              break;
          }
        } catch (err) {
          if (engine.hasCatchTargets()) {
            const catchId = engine.popCatchTarget()!;
            emitTrace("ErrorCaught", { stateId: state.id, error: String(err), catchStateId: catchId });
            engine.ctx.error = err instanceof Error ? err.message : String(err);
            engine.setCurrentState(catchId);
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      console.error(`[${this.agentName}] Fatal error:`, err);
      engine.setStatus("failed");
      emitTrace("ProtocolFailed", { error: String(err) });
      this.onInstanceComplete(engine.instanceId);
    }
  }

  private applyResponse(engine: ProtocolEngine, resp: AgentResponse): void {
    if (resp.type === "ctx_update") {
      engine.ctx = resp.ctx;
    }
  }

  private onInstanceComplete(instanceId: string): void {
    this.completionCount++;
    const engine = this.instances.get(instanceId);
    if (engine) {
      console.log(`[${this.agentName}] Instance ${instanceId} completed with status: ${engine.status}`);
    }
    for (const w of this.completionWaiters) {
      if (this.completionCount >= w.target) w.resolve();
    }
    this.completionWaiters = this.completionWaiters.filter(w => this.completionCount < w.target);
  }
}

export class CustomAgentNode implements AgentNode {
  readonly runtimeName = "custom";
  private agentFactory: (agentName: string, roleIR: RoleIR) => AgentInterface;
  private roleToAgent: Record<string, string>;
  private traceHook?: TraceHook;

  constructor(config: CustomAgentNodeConfig) {
    this.agentFactory = config.agentFactory;
    this.roleToAgent = config.roleToAgent;
    this.traceHook = config.traceHook;
  }

  createAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    transport: ReagentTransport,
  ): AgentHandle {
    const agent = this.agentFactory(agentName, roleIR);
    return new CustomAgentHandle(
      agentName, agent, graphs, transport,
      this.roleToAgent, this.traceHook,
    );
  }

  async destroyAgent(handle: AgentHandle): Promise<void> {
    await handle.stop();
  }
}
