/**
 * NativeAgentNode — wraps the AgentRunner-based runtime as an AgentNode.
 *
 * This is the platform implementation for the native TS runtime.
 * It creates AgentRunner instances as AgentHandles and manages their lifecycle.
 */

import type { RoleIR, IRGraph, MessageEnvelope, ProtocolTrigger } from "../contracts/types.js";
import { resolveAgentIR, type AgentIR } from "../contracts/types.js";
import type { ReagentTransport } from "../contracts/transport.js";
import type { AgentNode, AgentHandle } from "../contracts/agent-node.js";
import { AgentRunner, type EmitBusCallback } from "../core/agent-runner.js";
import type { TraceHook } from "../contracts/interceptor.js";
import type { AdvanceHook, RoleSpawnRequest } from "../core/protocol-instance.js";
import type { RoleBindingMap, RoleBindingResolver } from "../controller/role-bindings.js";

export interface NativeAgentNodeConfig {
  roleToAgent: RoleBindingMap | RoleBindingResolver;
  traceHook?: TraceHook;
  advanceHook?: AdvanceHook;
  emitBusCallback?: EmitBusCallback;
  roleSpawnCallback?: (request: RoleSpawnRequest) => string;
}

export class NativeAgentNode implements AgentNode {
  readonly runtimeName = "native-ts";
  private roleToAgent: RoleBindingMap | RoleBindingResolver;
  private traceHook?: TraceHook;
  private advanceHook?: AdvanceHook;
  private emitBusCb?: EmitBusCallback;
  private roleSpawnCb?: (request: RoleSpawnRequest) => string;
  private handles: NativeAgentHandle[] = [];

  constructor(config: NativeAgentNodeConfig) {
    this.roleToAgent = config.roleToAgent;
    this.traceHook = config.traceHook;
    this.advanceHook = config.advanceHook;
    this.emitBusCb = config.emitBusCallback;
    this.roleSpawnCb = config.roleSpawnCallback;
  }

  createAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    transport: ReagentTransport,
    extras?: Record<string, unknown>,
  ): AgentHandle {
    const agentIR: AgentIR = {
      agentName,
      lang: (roleIR.lang ?? "ts") as any,
      roleName: roleIR.roleName,
      plays: roleIR.plays,
      initAction: roleIR.initAction,
      lifecycleHandlers: roleIR.lifecycleHandlers,
    };

    const runner = new AgentRunner({
      agentIR,
      graphs,
      transport,
      roleToAgent: this.roleToAgent,
      traceHook: this.traceHook,
      advanceHook: this.advanceHook,
      extras,
      emitBusCallback: this.emitBusCb,
      roleSpawnCallback: this.roleSpawnCb,
    });

    const handle = new NativeAgentHandle(agentName, runner);
    this.handles.push(handle);
    return handle;
  }

  setAdvanceHook(hook: AdvanceHook | undefined): void {
    this.advanceHook = hook;
    for (const h of this.handles) {
      h.getRunner().setAdvanceHook(hook);
    }
  }

  setEmitBusCallback(cb: EmitBusCallback | undefined): void {
    this.emitBusCb = cb;
  }

  setRoleSpawnCallback(cb: ((request: RoleSpawnRequest) => string) | undefined): void {
    this.roleSpawnCb = cb;
    for (const h of this.handles) {
      h.getRunner().setRoleSpawnCallback(cb);
    }
  }

  async destroyAgent(handle: AgentHandle): Promise<void> {
    await handle.stop();
  }
}

class NativeAgentHandle implements AgentHandle {
  readonly agentName: string;
  private runner: AgentRunner;

  constructor(agentName: string, runner: AgentRunner) {
    this.agentName = agentName;
    this.runner = runner;
  }

  async start(): Promise<void> {
    await this.runner.start();
  }

  async stop(): Promise<void> {
    await this.runner.stop();
  }

  getSelf(): Record<string, unknown> {
    return this.runner.getSelf();
  }

  triggerProtocol(trigger: ProtocolTrigger): void {
    this.runner.triggerProtocol(trigger);
  }

  dispatchMessage(env: MessageEnvelope): void {
    this.runner.dispatchMessage(env);
  }

  getRunner(): AgentRunner {
    return this.runner;
  }

  waitForCompletion(expectedCount: number, timeoutMs?: number): Promise<void> {
    return this.runner.waitForCompletion(expectedCount, timeoutMs);
  }

  getInstances() {
    return this.runner.getInstances();
  }
}

export { NativeAgentHandle };
