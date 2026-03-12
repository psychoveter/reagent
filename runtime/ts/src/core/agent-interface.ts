/**
 * ManagedAgentBehavior — executes .rg zone code on behalf of the engine.
 *
 * This is the default AgentBehavior for managed agents.
 * It wraps the zone executor and provides zone execution for agents
 * whose logic is embedded in .rg protocol zones.
 */

import type { ProtocolEvent, AgentResponse } from "./protocol-engine.js";
import type { AgentBehavior } from "../contracts/agent-behavior.js";
import { executeZone, executeZoneAsync, InvokeRequest, ReturnValue, BreakRequest, type ReagentStub } from "./zone-executor.js";

export interface ManagedBehaviorConfig {
  extras?: Record<string, unknown>;
  invokeCallback?: (protoName: string, input?: Record<string, unknown>) => Promise<unknown>;
  spawnCallback?: (protoName: string, input?: Record<string, unknown>) => void;
  emitCallback?: (eventName: string, data?: Record<string, unknown>) => void;
}

export class ManagedAgentBehavior implements AgentBehavior {
  private reagent: ReagentStub;
  private config: ManagedBehaviorConfig;

  constructor(config: ManagedBehaviorConfig = {}) {
    this.config = config;
    this.reagent = this.createReagent();
  }

  setInvokeCallback(cb: (protoName: string, input?: Record<string, unknown>) => Promise<unknown>): void {
    this.config.invokeCallback = cb;
  }

  setSpawnCallback(cb: (protoName: string, input?: Record<string, unknown>) => void): void {
    this.config.spawnCallback = cb;
  }

  setEmitCallback(cb: (eventName: string, data?: Record<string, unknown>) => void): void {
    this.config.emitCallback = cb;
  }

  private createReagent(): ReagentStub {
    return {
      invoke: (proto, args) => {
        throw new InvokeRequest(proto as string, args as Record<string, unknown> | undefined);
      },
      return: (value) => {
        throw new ReturnValue(value);
      },
      spawn: (proto, args) => {
        this.config.spawnCallback?.(proto as string, args as Record<string, unknown> | undefined);
      },
      emit: (eventName, data) => {
        this.config.emitCallback?.(eventName, data);
      },
      break: () => {
        throw new BreakRequest();
      },
      resolve: () => [],
      registry: {
        findByRole: () => [],
        get: () => undefined,
        all: () => [],
      },
      stop: () => {},
    };
  }

  private zoneExtras(): Record<string, unknown> | undefined {
    return this.config.extras ? { $agent: this.config.extras } : undefined;
  }

  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    switch (event.type) {
      case "action":
        return this.handleAction(event);

      case "pre_send_action":
        return this.handleZoneExec(event.body, event.isAsync, event.ctx, event.self);

      case "post_receive_action":
        return this.handleZoneExec(event.body, event.isAsync, event.ctx, event.self);

      default:
        return { type: "noop" };
    }
  }

  private async handleAction(event: Extract<ProtocolEvent, { type: "action" }>): Promise<AgentResponse> {
    const { body, isAsync, ctx, self: selfRef } = event;
    try {
      if (isAsync) {
        await executeZoneAsync(body, ctx, selfRef, this.reagent, this.zoneExtras());
      } else {
        executeZone(body, ctx, selfRef, this.reagent, this.zoneExtras());
      }
      return { type: "ctx_update", ctx };
    } catch (err) {
      if (err instanceof ReturnValue) {
        return { type: "return_value", value: err.value };
      }
      if (err instanceof BreakRequest) {
        return { type: "break_requested" };
      }
      if (err instanceof InvokeRequest) {
        if (!this.config.invokeCallback) {
          return { type: "error_thrown", error: new Error("reagent.invoke() called but no invokeCallback set") };
        }
        const invokeResult = await this.config.invokeCallback(err.protoName, err.input);
        const cachedReagent: ReagentStub = {
          ...this.reagent,
          invoke: () => invokeResult,
        };
        if (isAsync) {
          await executeZoneAsync(body, ctx, selfRef, cachedReagent, this.zoneExtras());
        } else {
          executeZone(body, ctx, selfRef, cachedReagent, this.zoneExtras());
        }
        return { type: "ctx_update", ctx };
      }
      return { type: "error_thrown", error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  private async handleZoneExec(
    body: string,
    isAsync: boolean,
    ctx: Record<string, unknown>,
    selfRef: Record<string, unknown>,
  ): Promise<AgentResponse> {
    try {
      if (isAsync) {
        await executeZoneAsync(body, ctx, selfRef, this.reagent, this.zoneExtras());
      } else {
        executeZone(body, ctx, selfRef, this.reagent, this.zoneExtras());
      }
      return { type: "ctx_update", ctx };
    } catch (err) {
      if (err instanceof ReturnValue) {
        return { type: "return_value", value: err.value };
      }
      if (err instanceof BreakRequest) {
        return { type: "break_requested" };
      }
      return { type: "error_thrown", error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}

/** @deprecated Use ManagedAgentBehavior */
export const ManagedAgentAdapter = ManagedAgentBehavior;
/** @deprecated Use ManagedBehaviorConfig */
export type ManagedAgentConfig = ManagedBehaviorConfig;
/** @deprecated Use AgentBehavior from contracts/agent-behavior.ts */
export type AgentInterface = AgentBehavior;
