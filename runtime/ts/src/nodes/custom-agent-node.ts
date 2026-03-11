/**
 * CustomAgentNode — AgentNode for user-implemented agents.
 *
 * Instead of executing zones from .rg files, the user provides a class
 * that implements AgentInterface.handle(). The RC calls it for each
 * ProtocolEvent, giving the user full control over agent behavior.
 */

import type { RoleIR, IRGraph, MessageEnvelope, ProtocolTrigger } from "../contracts/types.js";
import type { ReagentTransport } from "../contracts/transport.js";
import type { AgentNode, AgentHandle } from "../contracts/agent-node.js";
import type { AgentInterface } from "../core/agent-interface.js";
import { ProtocolEngine, durationToMs } from "../core/protocol-engine.js";
import type { ProtocolEvent, AgentResponse } from "../core/protocol-engine.js";
import { createMessageEnvelope, createTraceEvent } from "../contracts/types.js";
import type { TraceHook } from "../contracts/interceptor.js";
import type { RoleBindingMap, RoleBindingResolver } from "../controller/role-bindings.js";
import { mergeRoleBindings, normalizeRoleBindingMap, resolveRoleBinding, resolveSingleRoleBinding, setRoleBinding } from "../controller/role-bindings.js";

export interface CustomAgentNodeConfig {
  roleToAgent: RoleBindingMap | RoleBindingResolver;
  agentFactory: (agentName: string, roleIR: RoleIR) => AgentInterface;
  traceHook?: TraceHook;
  roleSpawnCallback?: (request: {
    roleName: string;
    config?: Record<string, unknown>;
    bindAs?: string;
    persistent: boolean;
    instanceId: string;
  }) => string;
}

export class CustomAgentHandle implements AgentHandle {
  readonly agentName: string;
  private agent: AgentInterface;
  private graphs: Map<string, IRGraph>;
  private transport: ReagentTransport;
  private roleToAgent: RoleBindingMap | RoleBindingResolver;
  private selfState: Record<string, unknown> = {};
  private instances: Map<string, ProtocolEngine> = new Map();
  private completionCount = 0;
  private completionWaiters: Array<{ target: number; resolve: () => void }> = [];
  private traceHook?: TraceHook;
  private roleSpawnCallback?: (request: {
    roleName: string;
    config?: Record<string, unknown>;
    bindAs?: string;
    persistent: boolean;
    instanceId: string;
  }) => string;

  constructor(
    agentName: string,
    agent: AgentInterface,
    graphs: Map<string, IRGraph>,
    transport: ReagentTransport,
    roleToAgent: RoleBindingMap | RoleBindingResolver,
    traceHook?: TraceHook,
    roleSpawnCallback?: (request: {
      roleName: string;
      config?: Record<string, unknown>;
      bindAs?: string;
      persistent: boolean;
      instanceId: string;
    }) => string,
  ) {
    this.agentName = agentName;
    this.agent = agent;
    this.graphs = graphs;
    this.transport = transport;
    this.roleToAgent = roleToAgent;
    this.traceHook = traceHook;
    this.roleSpawnCallback = roleSpawnCallback;
  }

  private pushLifecycleNotification(instanceId: string, event: ProtocolEvent): void {
    const notify = (this.agent as {
      pushNotification?: (instanceId: string, event: ProtocolEvent) => void;
    }).pushNotification;
    if (typeof notify === "function") {
      notify.call(this.agent, instanceId, event);
    }
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
    this.runEngine(engine, normalizeRoleBindingMap(trigger.roleToAgent)).catch((err) => {
      console.error(`[${this.agentName}] Engine error:`, err);
    });
  }

  dispatchMessage(env: MessageEnvelope): void {
    let engine: ProtocolEngine | null | undefined = this.instances.get(env.instanceId);
    if (!engine) {
      engine = this.materializeReceiveSideEngine(env);
    }
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

  private materializeReceiveSideEngine(env: MessageEnvelope): ProtocolEngine | null {
    const graphKey = `${env.protocolName}.${env.to.role}`;
    const graph = this.graphs.get(graphKey);
    if (!graph) return null;

    const engine = new ProtocolEngine(graph, {
      instanceId: env.instanceId,
      protocolName: env.protocolName,
      agentName: this.agentName,
      roleName: env.to.role,
      selfRef: this.selfState,
      input: undefined,
    });

    this.instances.set(env.instanceId, engine);
    const inbox = (engine as any)._messageInbox ?? [];
    (engine as any)._messageInbox = inbox;

    const roleBindings = this.buildRoleBindings(env.protocolName);
    setRoleBinding(roleBindings, env.protocolName, env.from.role, env.from.agent);
    setRoleBinding(roleBindings, env.protocolName, env.to.role, env.to.agent);

    this.runEngine(engine, roleBindings).catch((err) => {
      console.error(`[${this.agentName}] Engine error:`, err);
    });

    return engine;
  }

  private buildRoleBindings(protocolName: string): RoleBindingMap {
    if (typeof this.roleToAgent === "function") {
      const bindings: RoleBindingMap = {};
      for (const [, graph] of this.graphs) {
        if (graph.protocolName !== protocolName) continue;
        const resolved = this.roleToAgent(protocolName, graph.role);
        if (resolved) {
          setRoleBinding(bindings, protocolName, graph.role, resolved);
        }
      }
      return bindings;
    }

    return mergeRoleBindings(protocolName, {}, this.roleToAgent);
  }

  private async runEngine(engine: ProtocolEngine, roleToAgent: RoleBindingMap): Promise<void> {
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
      this.pushLifecycleNotification(engine.instanceId, {
        type: "protocol_started",
        protocolName: engine.protocolName,
      });

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
              emitTrace(state.data.status === "completed" ? "ProtocolCompleted" : "ProtocolFailed",
                { protocolName: engine.protocolName });
              this.pushLifecycleNotification(
                engine.instanceId,
                state.data.status === "completed"
                  ? { type: "protocol_completed", ctx: engine.ctx }
                  : { type: "protocol_failed", error: "protocol_failed", ctx: engine.ctx },
              );
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
                isAsync: false,
                ctx: engine.ctx,
                self: engine.selfRef,
              });
              this.applyResponse(engine, resp);
              if (resp.type === "return_value") {
                engine.setReturnValue(resp.value);
                emitTrace("ProtocolCompleted", { protocolName: engine.protocolName, returned: true });
                this.pushLifecycleNotification(engine.instanceId, {
                  type: "protocol_completed",
                  ctx: engine.ctx,
                });
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
              const toAgent = resolveSingleRoleBinding(roleToAgent, engine.protocolName, data.to);
              if (!toAgent) {
                const binding = resolveRoleBinding(roleToAgent, engine.protocolName, data.to);
                if (binding?.cardinality === "many" && binding.agents.length > 1) {
                  throw new Error(
                    `Role ${data.to} in protocol ${engine.protocolName} resolved to many agents (${binding.agents.join(", ")}); explicit narrowing is required before send`,
                  );
                }
                throw new Error(`Cannot resolve agent for role ${data.to}`);
              }

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
              if (state.data.kind === "spawn") {
                const spawnData = state.data as {
                  kind: "spawn";
                  roleName: string;
                  config: string;
                  bindAs?: string;
                  resultTarget?: string;
                  persistent: boolean;
                };
                if (!this.roleSpawnCallback) {
                  throw new Error(`role spawn for ${spawnData.roleName} but no roleSpawnCallback configured`);
                }
                let configValue: Record<string, unknown>;
                try {
                  configValue = new Function("$ctx", "$self", `return (${spawnData.config})`)(engine.ctx, engine.selfRef) as Record<string, unknown>;
                } catch {
                  configValue = {};
                }
                const spawnedAgent = this.roleSpawnCallback({
                  roleName: spawnData.roleName,
                  config: configValue,
                  bindAs: spawnData.bindAs,
                  persistent: spawnData.persistent,
                  instanceId: engine.instanceId,
                });
                if (spawnData.bindAs) {
                  const graph = this.graphs.get(`${engine.protocolName}.${engine.roleName}`);
                  const participant = graph?.participants?.find((p) => p.name === spawnData.bindAs);
                  const existing = resolveRoleBinding(roleToAgent, engine.protocolName, spawnData.bindAs);
                  if (participant?.cardinality === "many") {
                    setRoleBinding(roleToAgent, engine.protocolName, spawnData.bindAs, {
                      cardinality: "many",
                      agents: [...new Set([...(existing?.agents ?? []), spawnedAgent])],
                    });
                  } else {
                    setRoleBinding(roleToAgent, engine.protocolName, spawnData.bindAs, spawnedAgent, "single");
                  }
                }
                if (spawnData.resultTarget) {
                  engine.assignTarget(spawnData.resultTarget, spawnedAgent);
                }
                emitTrace("SpawnCompleted", {
                  stateId: state.id,
                  roleName: spawnData.roleName,
                  bindAs: spawnData.bindAs,
                  agentName: spawnedAgent,
                });
                engine.setCurrentState(engine.followDefault());
                break;
              }
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
      this.pushLifecycleNotification(engine.instanceId, {
        type: "protocol_failed",
        error: String(err),
        ctx: engine.ctx,
      });
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
  private roleToAgent: RoleBindingMap | RoleBindingResolver;
  private traceHook?: TraceHook;
  private roleSpawnCallback?: (request: {
    roleName: string;
    config?: Record<string, unknown>;
    bindAs?: string;
    persistent: boolean;
    instanceId: string;
  }) => string;

  constructor(config: CustomAgentNodeConfig) {
    this.agentFactory = config.agentFactory;
    this.roleToAgent = config.roleToAgent;
    this.traceHook = config.traceHook;
    this.roleSpawnCallback = config.roleSpawnCallback;
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
      this.roleToAgent, this.traceHook, this.roleSpawnCallback,
    );
  }

  setRoleSpawnCallback(cb: ((request: {
    roleName: string;
    config?: Record<string, unknown>;
    bindAs?: string;
    persistent: boolean;
    instanceId: string;
  }) => string) | undefined): void {
    this.roleSpawnCallback = cb;
  }

  async destroyAgent(handle: AgentHandle): Promise<void> {
    await handle.stop();
  }
}
