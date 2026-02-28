/**
 * TriggerMatcher — loads TriggerIR from ProtocolRegistry and builds a match table.
 *
 * Embedded in ReagentController. On startup it reads compiled TriggerIR metadata
 * from deployed protocols and registers:
 * - invoke triggers: verified at deploy-time, dispatched via RC.triggerProtocol()
 * - event triggers: subscribed to LocalEventBus topics, instantiate on match
 * - cron triggers: registered with CronAgent, which emits cron.tick events
 */

import type { TriggerIR, ProtocolTrigger, TraceEvent } from "./types.js";
import { createTraceEvent } from "./types.js";
import type { ProtocolRegistry, ProtocolEntry } from "./protocol-registry.js";
import { LocalEventBus, type BusEvent, type Disposable } from "./local-event-bus.js";
import { CronAgent } from "./cron-agent.js";
import {
  type TriggerPolicy,
  type TriggerPolicyState,
  DEFAULT_TRIGGER_POLICY,
  createPolicyState,
  evaluatePolicy,
  recordTriggerFired,
  recordTriggerCompleted,
  type SuppressionReason,
} from "./trigger-policy.js";
import { ResolvePolicyEvaluator, type ResolveContext } from "./resolve-policy-evaluator.js";

// ── Match table entry ───────────────────────────────────────────────

export interface TriggerEntry {
  id: string;
  protocolName: string;
  trigger: TriggerIR;
  initiatorAgent: string;
  policy: TriggerPolicy;
  policyState: TriggerPolicyState;
}

export interface InvokeTriggerEntry extends TriggerEntry {
  trigger: TriggerIR & { kind: "invoke" };
}

export interface EventTriggerEntry extends TriggerEntry {
  trigger: TriggerIR & { kind: "event" };
  subscription: Disposable;
}

export interface CronTriggerEntry extends TriggerEntry {
  trigger: TriggerIR & { kind: "cron" };
  scheduleId: string;
}

// ── Trigger callback (called to instantiate protocol) ───────────────

export type TriggerCallback = (agentName: string, trigger: ProtocolTrigger) => void;
export type TraceCallback = (event: TraceEvent) => void;

// ── TriggerMatcher ──────────────────────────────────────────────────

export class TriggerMatcher {
  private registry: ProtocolRegistry;
  private bus: LocalEventBus;
  private cron: CronAgent;

  private invokeTriggers = new Map<string, InvokeTriggerEntry>();
  private eventTriggers: EventTriggerEntry[] = [];
  private cronTriggers: CronTriggerEntry[] = [];

  private policies = new Map<string, TriggerPolicy>();
  private triggerCb: TriggerCallback;
  private traceCb: TraceCallback | null = null;

  private resolveInitiator: (protocolName: string) => string | null;
  private resolveRoleToAgent: (protocolName: string) => Record<string, string>;
  private resolvePolicyEvaluator: ResolvePolicyEvaluator | null = null;

  constructor(opts: {
    registry: ProtocolRegistry;
    bus: LocalEventBus;
    cron: CronAgent;
    triggerCallback: TriggerCallback;
    traceCallback?: TraceCallback;
    resolveInitiator: (protocolName: string) => string | null;
    resolveRoleToAgent: (protocolName: string) => Record<string, string>;
    resolvePolicyEvaluator?: ResolvePolicyEvaluator;
  }) {
    this.registry = opts.registry;
    this.bus = opts.bus;
    this.cron = opts.cron;
    this.triggerCb = opts.triggerCallback;
    this.traceCb = opts.traceCallback ?? null;
    this.resolveInitiator = opts.resolveInitiator;
    this.resolveRoleToAgent = opts.resolveRoleToAgent;
    this.resolvePolicyEvaluator = opts.resolvePolicyEvaluator ?? null;
  }

  setResolvePolicyEvaluator(evaluator: ResolvePolicyEvaluator): void {
    this.resolvePolicyEvaluator = evaluator;
  }

  // ── Policy configuration ──────────────────────────────────────────

  setPolicy(triggerId: string, policy: TriggerPolicy): void {
    this.policies.set(triggerId, policy);
    const all = this.allEntries();
    for (const entry of all) {
      if (entry.id === triggerId) {
        entry.policy = policy;
        break;
      }
    }
  }

  setPolicies(map: Record<string, TriggerPolicy>): void {
    for (const [id, policy] of Object.entries(map)) {
      this.setPolicy(id, policy);
    }
  }

  // ── Build match table from registry ───────────────────────────────

  buildMatchTable(): void {
    this.clearSubscriptions();

    for (const entry of this.registry.list()) {
      this.registerProtocolTriggers(entry);
    }
  }

  /**
   * Register triggers for a single protocol. Called during buildMatchTable()
   * or incrementally when a new protocol is deployed.
   */
  registerProtocolTriggers(protoEntry: ProtocolEntry): void {
    for (const trigger of protoEntry.triggers) {
      const id = this.makeTriggerId(protoEntry.name, trigger);
      const initiator = this.resolveInitiator(protoEntry.name);
      if (!initiator) {
        this.emitTrace(protoEntry.name, "TriggerSuppressed", {
          triggerId: id,
          reason: "no_initiator",
          triggerKind: trigger.kind,
        });
        continue;
      }

      const policy = this.policies.get(id) ?? DEFAULT_TRIGGER_POLICY;
      const policyState = createPolicyState();
      const base: TriggerEntry = { id, protocolName: protoEntry.name, trigger, initiatorAgent: initiator, policy, policyState };

      switch (trigger.kind) {
        case "invoke":
          this.invokeTriggers.set(protoEntry.name, { ...base, trigger } as InvokeTriggerEntry);
          break;

        case "event": {
          const sub = this.bus.subscribe(trigger.topic, (ev) => {
            this.handleEventTrigger(protoEntry.name, trigger, base, ev);
          });
          this.eventTriggers.push({ ...base, trigger, subscription: sub } as EventTriggerEntry);
          break;
        }

        case "cron": {
          const scheduleId = this.cron.addSchedule(protoEntry.name, trigger.cron);
          const cronTopic = `cron.tick.${protoEntry.name}`;
          const sub = this.bus.subscribe(cronTopic, (ev) => {
            this.handleCronTrigger(protoEntry.name, trigger, base, ev);
          });
          this.cronTriggers.push({
            ...base,
            trigger,
            scheduleId,
            // piggyback: store sub for cleanup
          } as CronTriggerEntry & { subscription?: Disposable });
          (this.cronTriggers[this.cronTriggers.length - 1] as any)._sub = sub;
          break;
        }
      }
    }
  }

  // ── Invoke trigger dispatch ───────────────────────────────────────

  /**
   * Try to match an invoke trigger for the given protocol name.
   * Returns true if matched and fired, false otherwise.
   * Called from the invoke/async_invoke execution path.
   */
  async matchInvokeTrigger(protocolName: string, input?: Record<string, unknown>): Promise<boolean> {
    const entry = this.invokeTriggers.get(protocolName);
    if (!entry) return false;
    const resolved = this.buildInput(input ?? {}, entry.trigger.inputExpr);
    return this.fireTrigger(entry, resolved);
  }

  /**
   * Check if a protocol is invocable (has invoke trigger or is marked invocable).
   * Used for deploy-time verification.
   */
  isInvocable(protocolName: string): boolean {
    if (this.invokeTriggers.has(protocolName)) return true;
    const proto = this.registry.get(protocolName);
    return proto?.invocable === true;
  }

  // ── Event trigger handler ─────────────────────────────────────────

  private handleEventTrigger(
    _protocolName: string,
    trigger: TriggerIR & { kind: "event" },
    entry: TriggerEntry,
    event: BusEvent,
  ): void {
    const input = this.buildInput(event.payload as Record<string, unknown>, trigger.inputExpr);
    void this.fireTrigger(entry, input);
  }

  // ── Cron trigger handler ──────────────────────────────────────────

  private handleCronTrigger(
    _protocolName: string,
    trigger: TriggerIR & { kind: "cron" },
    entry: TriggerEntry,
    event: BusEvent,
  ): void {
    const input = this.buildInput(event.payload as Record<string, unknown>, trigger.inputExpr);
    void this.fireTrigger(entry, input);
  }

  // ── Common fire logic ─────────────────────────────────────────────

  private async fireTrigger(entry: TriggerEntry, input: Record<string, unknown>): Promise<boolean> {
    const now = Date.now();
    const hash = this.hashPayload(input);

    const suppression = evaluatePolicy(entry.policy, entry.policyState, hash, now);
    if (suppression) {
      const traceKind = suppression === "dedup" ? "TriggerDedupSkipped" : "TriggerSuppressed";
      this.emitTrace(entry.protocolName, traceKind, {
        triggerId: entry.id,
        reason: suppression,
        triggerKind: entry.trigger.kind,
        payload: input,
      });
      return false;
    }

    recordTriggerFired(entry.policyState, hash, now);

    const instanceId = crypto.randomUUID();

    // Use resolve policies if available, otherwise fall back to legacy resolution
    let roleToAgent: Record<string, string>;
    const resolveMap = entry.trigger.resolveMap;

    if (resolveMap && this.resolvePolicyEvaluator && Object.keys(resolveMap).length > 0) {
      roleToAgent = {};
      const ctx: ResolveContext = { triggerId: entry.id, input };
      for (const [role, pipeline] of Object.entries(resolveMap)) {
        const resolved = await this.resolvePolicyEvaluator.evaluate(pipeline, role, ctx, entry.id);
        if (resolved.length > 0) {
          roleToAgent[role] = resolved[0].name;
        }
      }
    } else {
      roleToAgent = this.resolveRoleToAgent(entry.protocolName);
    }

    this.emitTrace(entry.protocolName, "TriggerMatched", {
      triggerId: entry.id,
      triggerKind: entry.trigger.kind,
      instanceId,
      initiator: entry.initiatorAgent,
    });

    this.triggerCb(entry.initiatorAgent, {
      instanceId,
      protocolName: entry.protocolName,
      input,
      roleToAgent,
    });

    return true;
  }

  // ── Completion callback (for policy tracking) ─────────────────────

  reportTriggerCompleted(protocolName: string, success: boolean): void {
    for (const entry of this.allEntries()) {
      if (entry.protocolName === protocolName) {
        recordTriggerCompleted(entry.policyState, success, entry.policy);
      }
    }
  }

  // ── Input builder (two-step: raw data → optional transform) ──────

  private buildInput(rawInput: Record<string, unknown>, inputExpr?: string): Record<string, unknown> {
    if (!inputExpr) return rawInput;
    try {
      const $ctx = { input: rawInput };
      return new Function("$ctx", `return (${inputExpr})`)($ctx) as Record<string, unknown>;
    } catch {
      return rawInput;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private makeTriggerId(protocolName: string, trigger: TriggerIR): string {
    switch (trigger.kind) {
      case "invoke": return `trigger:invoke:${protocolName}`;
      case "event": return `trigger:event:${protocolName}:${trigger.topic}`;
      case "cron": return `trigger:cron:${protocolName}:${trigger.cron}`;
    }
  }

  private hashPayload(input: Record<string, unknown>): string {
    try {
      return JSON.stringify(input);
    } catch {
      return "";
    }
  }

  private emitTrace(protocolName: string, kind: "TriggerMatched" | "TriggerSuppressed" | "TriggerDedupSkipped" | "CronTick", data: Record<string, unknown>): void {
    if (!this.traceCb) return;
    this.traceCb(createTraceEvent("system", kind, "system:trigger-matcher", {
      protocolName,
      data,
    }));
  }

  private allEntries(): TriggerEntry[] {
    return [
      ...this.invokeTriggers.values(),
      ...this.eventTriggers,
      ...this.cronTriggers,
    ];
  }

  private clearSubscriptions(): void {
    for (const entry of this.eventTriggers) {
      entry.subscription.dispose();
    }
    for (const entry of this.cronTriggers) {
      this.cron.removeSchedule(entry.scheduleId);
      (entry as any)._sub?.dispose();
    }
    this.invokeTriggers.clear();
    this.eventTriggers = [];
    this.cronTriggers = [];
  }

  // ── Introspection ─────────────────────────────────────────────────

  getInvokeTriggers(): Map<string, InvokeTriggerEntry> {
    return new Map(this.invokeTriggers);
  }

  getEventTriggers(): EventTriggerEntry[] {
    return [...this.eventTriggers];
  }

  getCronTriggers(): CronTriggerEntry[] {
    return [...this.cronTriggers];
  }

  destroy(): void {
    this.clearSubscriptions();
    this.cron.stop();
  }
}
