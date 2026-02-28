/**
 * Phase 3 — Trigger & Event Bus Tests
 *
 * T1: LocalEventBus pub/sub and wildcard
 * T2: CronAgent cron parsing and tick matching
 * T3: TriggerPolicy — cooldown, maxConcurrent, dedup, circuit breaker
 * T4: TriggerMatcher — invoke trigger match
 * T5: TriggerMatcher — event trigger match via bus
 * T6: TriggerMatcher — cron trigger fires on tick
 * T7: TriggerMatcher — policy suppression emits TriggerSuppressed trace
 * T8: RC integration — registerAgent populates triggers, emitEvent propagates
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { LocalEventBus } from "../ts/src/local-event-bus.js";
import type { BusEvent } from "../ts/src/local-event-bus.js";
import { CronAgent, parseCronExpression, cronMatchesDate, parseCronField } from "../ts/src/cron-agent.js";
import {
  evaluatePolicy,
  recordTriggerFired,
  recordTriggerCompleted,
  createPolicyState,
  DEFAULT_TRIGGER_POLICY,
  type TriggerPolicy,
  type TriggerPolicyState,
} from "../ts/src/trigger-policy.js";
import { TriggerMatcher } from "../ts/src/trigger-matcher.js";
import { ProtocolRegistry, type ProtocolEntry } from "../ts/src/protocol-registry.js";
import type { TriggerIR, TraceEvent } from "../ts/src/types.js";

// ── T1: LocalEventBus ──────────────────────────────────────────────

describe("LocalEventBus", () => {
  test("publish delivers to topic subscriber", () => {
    const bus = new LocalEventBus();
    const received: BusEvent[] = [];
    bus.subscribe("test.topic", (ev) => received.push(ev));
    const event: BusEvent = { topic: "test.topic", payload: { x: 1 }, ts: Date.now() };
    bus.publish("test.topic", event);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].payload, { x: 1 });
  });

  test("wildcard subscriber receives all events", () => {
    const bus = new LocalEventBus();
    const received: BusEvent[] = [];
    bus.subscribe("*", (ev) => received.push(ev));
    bus.publish("a", { topic: "a", payload: {}, ts: 0 });
    bus.publish("b", { topic: "b", payload: {}, ts: 0 });
    assert.equal(received.length, 2);
  });

  test("dispose removes subscriber", () => {
    const bus = new LocalEventBus();
    const received: BusEvent[] = [];
    const sub = bus.subscribe("x", (ev) => received.push(ev));
    bus.publish("x", { topic: "x", payload: {}, ts: 0 });
    assert.equal(received.length, 1);
    sub.dispose();
    bus.publish("x", { topic: "x", payload: {}, ts: 0 });
    assert.equal(received.length, 1);
  });

  test("clear removes all subscribers", () => {
    const bus = new LocalEventBus();
    const received: BusEvent[] = [];
    bus.subscribe("x", (ev) => received.push(ev));
    bus.subscribe("*", (ev) => received.push(ev));
    bus.clear();
    bus.publish("x", { topic: "x", payload: {}, ts: 0 });
    assert.equal(received.length, 0);
  });
});

// ── T2: CronAgent ──────────────────────────────────────────────────

describe("CronAgent", () => {
  test("parseCronField: wildcard", () => {
    const f = parseCronField("*", 0, 5);
    assert.deepEqual([...f.values].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  });

  test("parseCronField: range with step", () => {
    const f = parseCronField("1-10/3", 0, 59);
    assert.deepEqual([...f.values].sort((a, b) => a - b), [1, 4, 7, 10]);
  });

  test("parseCronField: comma-separated", () => {
    const f = parseCronField("1,5,15", 0, 59);
    assert.deepEqual([...f.values].sort((a, b) => a - b), [1, 5, 15]);
  });

  test("parseCronExpression: @daily", () => {
    const fields = parseCronExpression("@daily");
    assert.equal(fields.length, 5);
    assert.deepEqual([...fields[0].values], [0]); // minute=0
    assert.deepEqual([...fields[1].values], [0]); // hour=0
  });

  test("parseCronExpression: every 15 minutes", () => {
    const fields = parseCronExpression("*/15 * * * *");
    assert.deepEqual([...fields[0].values].sort((a, b) => a - b), [0, 15, 30, 45]);
  });

  test("cronMatchesDate: match", () => {
    const fields = parseCronExpression("30 14 * * *");
    const date = new Date(2025, 0, 15, 14, 30); // Wed Jan 15, 14:30
    assert.ok(cronMatchesDate(fields, date));
  });

  test("cronMatchesDate: no match", () => {
    const fields = parseCronExpression("30 14 * * *");
    const date = new Date(2025, 0, 15, 14, 31);
    assert.ok(!cronMatchesDate(fields, date));
  });

  test("CronAgent tick emits to bus", () => {
    const bus = new LocalEventBus();
    const cron = new CronAgent(bus);
    const received: BusEvent[] = [];
    cron.addSchedule("MyProto", "30 14 * * *");
    bus.subscribe("cron.tick.MyProto", (ev) => received.push(ev));

    const matchDate = new Date(2025, 0, 15, 14, 30);
    cron.tick(matchDate);
    assert.equal(received.length, 1);
    assert.equal(received[0].payload.protocolName, "MyProto");

    // Same minute → no double fire
    cron.tick(matchDate);
    assert.equal(received.length, 1);
  });
});

// ── T3: TriggerPolicy ──────────────────────────────────────────────

describe("TriggerPolicy", () => {
  test("default policy allows everything", () => {
    const state = createPolicyState();
    assert.equal(evaluatePolicy(DEFAULT_TRIGGER_POLICY, state, "h", Date.now()), null);
  });

  test("disabled policy suppresses", () => {
    const policy: TriggerPolicy = { enabled: false };
    const state = createPolicyState();
    assert.equal(evaluatePolicy(policy, state, "h", Date.now()), "disabled");
  });

  test("maxConcurrent suppresses when at limit", () => {
    const policy: TriggerPolicy = { enabled: true, maxConcurrent: 1 };
    const state = createPolicyState();
    state.runningCount = 1;
    assert.equal(evaluatePolicy(policy, state, "h", Date.now()), "max_concurrent");
  });

  test("cooldown suppresses within window", () => {
    const now = Date.now();
    const policy: TriggerPolicy = { enabled: true, cooldownMs: 1000 };
    const state = createPolicyState();
    state.lastFiredAt = now - 500;
    assert.equal(evaluatePolicy(policy, state, "h", now), "cooldown");
    assert.equal(evaluatePolicy(policy, state, "h", now + 600), null);
  });

  test("dedup suppresses duplicate payload within window", () => {
    const now = Date.now();
    const policy: TriggerPolicy = { enabled: true, dedup: { windowMs: 5000 } };
    const state = createPolicyState();
    state.recentPayloadHashes.push({ hash: "dup", ts: now - 1000 });
    assert.equal(evaluatePolicy(policy, state, "dup", now), "dedup");
    assert.equal(evaluatePolicy(policy, state, "other", now), null);
  });

  test("circuit breaker opens after threshold failures", () => {
    const policy: TriggerPolicy = {
      enabled: true,
      circuitBreaker: { failureThreshold: 2, resetMs: 10000 },
    };
    const state = createPolicyState();

    recordTriggerFired(state, "h", Date.now());
    recordTriggerCompleted(state, false, policy);
    assert.equal(state.circuit, "closed");

    recordTriggerFired(state, "h", Date.now());
    recordTriggerCompleted(state, false, policy);
    assert.equal(state.circuit, "open");

    assert.equal(evaluatePolicy(policy, state, "h", Date.now()), "circuit_open");
  });
});

// ── T4–T7: TriggerMatcher ──────────────────────────────────────────

function makeProtoEntry(name: string, triggers: TriggerIR[], initiator?: string): ProtocolEntry {
  return {
    name,
    version: "1.0.0",
    fingerprints: { structureHash: "s", schemaHash: "s", implHash: "s" },
    dependencies: [],
    irGraphs: new Map([
      [`${name}.Initiator`, {
        protocolName: name,
        role: "Initiator",
        lang: "ts" as const,
        initiator: initiator ?? "Initiator",
        triggers,
        invocable: triggers.some(t => t.kind === "invoke"),
        states: [],
        transitions: [],
        initialStateId: "s0",
        terminalStateIds: ["s1"],
      }],
    ]),
    triggers,
    invocable: triggers.some(t => t.kind === "invoke"),
    registeredAt: Date.now(),
  };
}

describe("TriggerMatcher", () => {
  test("invoke trigger: matchInvokeTrigger returns true and fires callback", () => {
    const registry = new ProtocolRegistry();
    const bus = new LocalEventBus();
    const cron = new CronAgent(bus);
    const fired: Array<{ agent: string; trigger: any }> = [];
    const traces: TraceEvent[] = [];

    const matcher = new TriggerMatcher({
      registry,
      bus,
      cron,
      triggerCallback: (agent, trigger) => fired.push({ agent, trigger }),
      traceCallback: (ev) => traces.push(ev),
      resolveInitiator: () => "AgentA",
      resolveRoleToAgent: () => ({ Initiator: "AgentA" }),
    });

    const entry = makeProtoEntry("InvokeProto", [{ kind: "invoke", withType: "start" }]);
    registry.register(entry);
    registry.bindAgent("InvokeProto", "AgentA");
    matcher.registerProtocolTriggers(entry);

    assert.ok(matcher.isInvocable("InvokeProto"));
    const matched = matcher.matchInvokeTrigger("InvokeProto", { x: 1 });
    assert.ok(matched);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].agent, "AgentA");
    assert.equal(fired[0].trigger.protocolName, "InvokeProto");

    const matchTrace = traces.find(t => t.kind === "TriggerMatched");
    assert.ok(matchTrace);
  });

  test("event trigger: publishes to bus → fires callback", () => {
    const registry = new ProtocolRegistry();
    const bus = new LocalEventBus();
    const cron = new CronAgent(bus);
    const fired: Array<{ agent: string; trigger: any }> = [];

    const matcher = new TriggerMatcher({
      registry,
      bus,
      cron,
      triggerCallback: (agent, trigger) => fired.push({ agent, trigger }),
      resolveInitiator: () => "AgentB",
      resolveRoleToAgent: () => ({ Initiator: "AgentB" }),
    });

    const entry = makeProtoEntry("EventProto", [
      { kind: "event", topic: "order.placed", withType: "start" },
    ]);
    registry.register(entry);
    registry.bindAgent("EventProto", "AgentB");
    matcher.registerProtocolTriggers(entry);

    bus.publish("order.placed", { topic: "order.placed", payload: { orderId: "abc" }, ts: Date.now() });

    assert.equal(fired.length, 1);
    assert.equal(fired[0].trigger.protocolName, "EventProto");
  });

  test("cron trigger: tick → fires callback", () => {
    const registry = new ProtocolRegistry();
    const bus = new LocalEventBus();
    const cron = new CronAgent(bus);
    const fired: Array<{ agent: string; trigger: any }> = [];

    const matcher = new TriggerMatcher({
      registry,
      bus,
      cron,
      triggerCallback: (agent, trigger) => fired.push({ agent, trigger }),
      resolveInitiator: () => "AgentC",
      resolveRoleToAgent: () => ({ Initiator: "AgentC" }),
    });

    const entry = makeProtoEntry("CronProto", [
      { kind: "cron", cron: "30 14 * * *" },
    ]);
    registry.register(entry);
    registry.bindAgent("CronProto", "AgentC");
    matcher.registerProtocolTriggers(entry);

    const matchDate = new Date(2025, 0, 15, 14, 30);
    cron.tick(matchDate);

    assert.equal(fired.length, 1);
    assert.equal(fired[0].trigger.protocolName, "CronProto");
  });

  test("policy suppression emits TriggerSuppressed trace", () => {
    const registry = new ProtocolRegistry();
    const bus = new LocalEventBus();
    const cron = new CronAgent(bus);
    const traces: TraceEvent[] = [];
    const fired: any[] = [];

    const matcher = new TriggerMatcher({
      registry,
      bus,
      cron,
      triggerCallback: (a, t) => fired.push(t),
      traceCallback: (ev) => traces.push(ev),
      resolveInitiator: () => "AgentD",
      resolveRoleToAgent: () => ({ Initiator: "AgentD" }),
    });

    matcher.setPolicy("trigger:invoke:DisabledProto", { enabled: false });

    const entry = makeProtoEntry("DisabledProto", [{ kind: "invoke", withType: "start" }]);
    registry.register(entry);
    registry.bindAgent("DisabledProto", "AgentD");
    matcher.registerProtocolTriggers(entry);

    const matched = matcher.matchInvokeTrigger("DisabledProto");
    assert.ok(!matched);
    assert.equal(fired.length, 0);

    const suppressedTrace = traces.find(t => t.kind === "TriggerSuppressed");
    assert.ok(suppressedTrace);
    assert.equal(suppressedTrace.data?.reason, "disabled");
  });

  test("no initiator → trigger not registered, TriggerSuppressed trace emitted", () => {
    const registry = new ProtocolRegistry();
    const bus = new LocalEventBus();
    const cron = new CronAgent(bus);
    const traces: TraceEvent[] = [];

    const matcher = new TriggerMatcher({
      registry,
      bus,
      cron,
      triggerCallback: () => {},
      traceCallback: (ev) => traces.push(ev),
      resolveInitiator: () => null,
      resolveRoleToAgent: () => ({}),
    });

    const entry = makeProtoEntry("NoInitProto", [{ kind: "invoke", withType: "start" }]);
    registry.register(entry);
    matcher.registerProtocolTriggers(entry);

    assert.ok(!matcher.matchInvokeTrigger("NoInitProto"));
    const suppressed = traces.find(t => t.kind === "TriggerSuppressed" && (t.data as any)?.reason === "no_initiator");
    assert.ok(suppressed);
  });
});
