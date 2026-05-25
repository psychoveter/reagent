/**
 * ManagedAgentBehavior — executes .rg zone code on behalf of the engine.
 *
 * This is the default AgentBehavior for managed agents.
 * It wraps the zone executor and provides zone execution for agents
 * whose logic is embedded in .rg protocol zones.
 */

import type { ProtocolEvent, AgentResponse } from "../../core/protocol-engine.js";
import type { AgentBehavior } from "../../contracts/agent-behavior.js";
import { executeZone, executeZoneAsync, ReturnValue, BreakRequest, type ReagentStub } from "../../core/zone-executor.js";

export interface ManagedBehaviorConfig {
  extras?: Record<string, unknown>;
  /**
   * Kept for compatibility with the engine's invoke wiring even though the
   * stable v0 zone surface no longer exposes `reagent.invoke`. Protocol-level
   * `<role> invokes` / `<role> async invokes` flow through this callback.
   */
  invokeCallback?: (protoName: string, input?: Record<string, unknown>) => Promise<unknown>;
  spawnCallback?: (protoName: string, input?: Record<string, unknown>) => void;
  emitCallback?: (eventName: string, data?: Record<string, unknown>) => void;
}

export class ManagedAgentBehavior implements AgentBehavior {
  private config: ManagedBehaviorConfig;

  constructor(config: ManagedBehaviorConfig = {}) {
    this.config = config;
  }

  private createReagent(config: ManagedBehaviorConfig = this.config): ReagentStub {
    return {
      return: (value) => {
        throw new ReturnValue(value);
      },
      emit: (eventName, data) => {
        config.emitCallback?.(eventName, data);
      },
      break: () => {
        throw new BreakRequest();
      },
    };
  }

  private zoneExtras(): Record<string, unknown> | undefined {
    return this.config.extras ? { $agent: this.config.extras } : undefined;
  }

  private mergeCallbacks(event: {
    invokeCallback?: (protoName: string, input?: Record<string, unknown>) => Promise<unknown>;
    spawnCallback?: (protoName: string, input?: Record<string, unknown>) => void;
    emitCallback?: (eventName: string, data?: Record<string, unknown>) => void;
  }): ManagedBehaviorConfig {
    return {
      extras: this.config.extras,
      invokeCallback: event.invokeCallback ?? this.config.invokeCallback,
      spawnCallback: event.spawnCallback ?? this.config.spawnCallback,
      emitCallback: event.emitCallback ?? this.config.emitCallback,
    };
  }

  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    switch (event.type) {
      case "action":
        return this.handleAction(event);

      case "pre_send_action":
        return this.handleZoneExec(event.body, event.isAsync, event.ctx, event.self, this.mergeCallbacks(event));

      case "post_receive_action":
        return this.handleZoneExec(event.body, event.isAsync, event.ctx, event.self, this.mergeCallbacks(event));

      default:
        return { type: "noop" };
    }
  }

  private async handleAction(event: Extract<ProtocolEvent, { type: "action" }>): Promise<AgentResponse> {
    const { body, isAsync, ctx, self: selfRef } = event;
    const mergedConfig = this.mergeCallbacks(event);
    const reagent = this.createReagent(mergedConfig);
    try {
      if (isAsync) {
        await executeZoneAsync(body, ctx, selfRef, reagent, this.zoneExtras());
      } else {
        executeZone(body, ctx, selfRef, reagent, this.zoneExtras());
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

  private async handleZoneExec(
    body: string,
    isAsync: boolean,
    ctx: Record<string, unknown>,
    selfRef: Record<string, unknown>,
    mergedConfig: ManagedBehaviorConfig = this.config,
  ): Promise<AgentResponse> {
    const reagent = this.createReagent(mergedConfig);
    try {
      if (isAsync) {
        await executeZoneAsync(body, ctx, selfRef, reagent, this.zoneExtras());
      } else {
        executeZone(body, ctx, selfRef, reagent, this.zoneExtras());
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
