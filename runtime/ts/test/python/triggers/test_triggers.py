"""
Phase 3 — Trigger & Event Bus Tests (Python mirror)

T1: LocalEventBus pub/sub and wildcard
T2: CronAgent cron parsing and tick matching
T3: TriggerPolicy — cooldown, maxConcurrent, dedup, circuit breaker
T4: TriggerMatcher — invoke trigger match
T5: TriggerMatcher — event trigger match via bus
T6: TriggerMatcher — cron trigger fires on tick
T7: TriggerMatcher — policy suppression
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "py"))

import time
from datetime import datetime

from reagent_runtime.local_event_bus import LocalEventBus, BusEvent
from reagent_runtime.cron_agent import (
    CronAgent, parse_cron_expression, cron_matches_date, parse_cron_field,
)
from reagent_runtime.trigger_policy import (
    TriggerPolicy, TriggerPolicyState, evaluate_policy,
    record_trigger_fired, record_trigger_completed, DEFAULT_TRIGGER_POLICY,
)
from reagent_runtime.trigger_matcher import TriggerMatcher, TriggerEntry
from reagent_runtime.protocol_registry import ProtocolRegistry, ProtocolEntry


# ── T1: LocalEventBus ──────────────────────────────────────────────

def test_bus_publish_subscribe():
    bus = LocalEventBus()
    received = []
    bus.subscribe("topic.a", lambda ev: received.append(ev))
    bus.publish("topic.a", BusEvent(topic="topic.a", payload={"x": 1}))
    assert len(received) == 1
    assert received[0].payload == {"x": 1}


def test_bus_wildcard():
    bus = LocalEventBus()
    received = []
    bus.subscribe("*", lambda ev: received.append(ev))
    bus.publish("a", BusEvent(topic="a", payload={}))
    bus.publish("b", BusEvent(topic="b", payload={}))
    assert len(received) == 2


def test_bus_dispose():
    bus = LocalEventBus()
    received = []
    sub = bus.subscribe("x", lambda ev: received.append(ev))
    bus.publish("x", BusEvent(topic="x", payload={}))
    assert len(received) == 1
    sub.dispose()
    bus.publish("x", BusEvent(topic="x", payload={}))
    assert len(received) == 1


def test_bus_clear():
    bus = LocalEventBus()
    received = []
    bus.subscribe("x", lambda ev: received.append(ev))
    bus.subscribe("*", lambda ev: received.append(ev))
    bus.clear()
    bus.publish("x", BusEvent(topic="x", payload={}))
    assert len(received) == 0


# ── T2: CronAgent ──────────────────────────────────────────────────

def test_parse_cron_field_wildcard():
    f = parse_cron_field("*", 0, 5)
    assert sorted(f) == [0, 1, 2, 3, 4, 5]


def test_parse_cron_field_range_step():
    f = parse_cron_field("1-10/3", 0, 59)
    assert sorted(f) == [1, 4, 7, 10]


def test_parse_cron_daily():
    fields = parse_cron_expression("@daily")
    assert len(fields) == 5
    assert fields[0] == {0}
    assert fields[1] == {0}


def test_cron_matches():
    fields = parse_cron_expression("30 14 * * *")
    dt = datetime(2025, 1, 15, 14, 30)
    assert cron_matches_date(fields, dt)


def test_cron_no_match():
    fields = parse_cron_expression("30 14 * * *")
    dt = datetime(2025, 1, 15, 14, 31)
    assert not cron_matches_date(fields, dt)


def test_cron_agent_tick():
    bus = LocalEventBus()
    cron = CronAgent(bus)
    received = []
    cron.add_schedule("MyProto", "30 14 * * *")
    bus.subscribe("cron.tick.MyProto", lambda ev: received.append(ev))

    match_date = datetime(2025, 1, 15, 14, 30)
    cron.tick(match_date)
    assert len(received) == 1
    assert received[0].payload["protocolName"] == "MyProto"

    cron.tick(match_date)  # same minute → no double fire
    assert len(received) == 1


# ── T3: TriggerPolicy ──────────────────────────────────────────────

def test_default_policy_allows():
    state = TriggerPolicyState()
    assert evaluate_policy(DEFAULT_TRIGGER_POLICY, state, "h", time.time() * 1000) is None


def test_disabled_policy():
    policy = TriggerPolicy(enabled=False)
    state = TriggerPolicyState()
    assert evaluate_policy(policy, state, "h", time.time() * 1000) == "disabled"


def test_max_concurrent():
    policy = TriggerPolicy(max_concurrent=1)
    state = TriggerPolicyState(running_count=1)
    assert evaluate_policy(policy, state, "h", time.time() * 1000) == "max_concurrent"


def test_cooldown():
    now = time.time() * 1000
    policy = TriggerPolicy(cooldown_ms=1000)
    state = TriggerPolicyState(last_fired_at=now - 500)
    assert evaluate_policy(policy, state, "h", now) == "cooldown"
    assert evaluate_policy(policy, state, "h", now + 600) is None


def test_dedup():
    now = time.time() * 1000
    policy = TriggerPolicy(dedup={"windowMs": 5000})
    state = TriggerPolicyState(recent_payload_hashes=[{"hash": "dup", "ts": now - 1000}])
    assert evaluate_policy(policy, state, "dup", now) == "dedup"
    assert evaluate_policy(policy, state, "other", now) is None


def test_circuit_breaker():
    policy = TriggerPolicy(circuit_breaker={"failureThreshold": 2, "resetMs": 10000})
    state = TriggerPolicyState()

    record_trigger_fired(state, "h", time.time() * 1000)
    record_trigger_completed(state, False, policy)
    assert state.circuit == "closed"

    record_trigger_fired(state, "h", time.time() * 1000)
    record_trigger_completed(state, False, policy)
    assert state.circuit == "open"

    assert evaluate_policy(policy, state, "h", time.time() * 1000) == "circuit_open"


# ── T4–T7: TriggerMatcher ──────────────────────────────────────────

def _make_proto_entry(name, triggers, initiator="Initiator"):
    return ProtocolEntry(
        name=name,
        version="1.0.0",
        fingerprints={"structureHash": "s", "schemaHash": "s", "implHash": "s"},
        dependencies=[],
        ir_graphs={
            f"{name}.{initiator}": {
                "protocolName": name,
                "role": initiator,
                "lang": "py",
                "initiator": initiator,
                "triggers": triggers,
                "invocable": any(t.get("kind") == "invoke" for t in triggers),
                "withType": next((t.get("withType") for t in triggers if t.get("withType")), None),
                "states": [],
                "transitions": [],
                "initialStateId": "s0",
                "terminalStateIds": ["s1"],
            }
        },
        triggers=triggers,
        invocable=any(t.get("kind") == "invoke" for t in triggers),
    )


def test_matcher_invoke():
    registry = ProtocolRegistry()
    bus = LocalEventBus()
    cron = CronAgent(bus)
    fired = []
    traces = []

    matcher = TriggerMatcher(
        registry=registry, bus=bus, cron=cron,
        trigger_callback=lambda a, t: fired.append({"agent": a, "trigger": t}),
        trace_callback=lambda ev: traces.append(ev),
        resolve_initiator=lambda _: "AgentA",
        resolve_role_to_agent=lambda _: {"Initiator": "AgentA"},
    )

    entry = _make_proto_entry("InvokeProto", [{"kind": "invoke", "withType": "start"}])
    registry.register(entry)
    registry.bind_agent("InvokeProto", "AgentA")
    matcher.register_protocol_triggers(entry)

    assert matcher.is_invocable("InvokeProto")
    matched = matcher.match_invoke_trigger("InvokeProto", {"x": 1})
    assert matched
    assert len(fired) == 1
    assert fired[0]["agent"] == "AgentA"
    assert any(t["kind"] == "TriggerMatched" for t in traces)


def test_matcher_event():
    registry = ProtocolRegistry()
    bus = LocalEventBus()
    cron = CronAgent(bus)
    fired = []

    matcher = TriggerMatcher(
        registry=registry, bus=bus, cron=cron,
        trigger_callback=lambda a, t: fired.append({"agent": a, "trigger": t}),
        resolve_initiator=lambda _: "AgentB",
        resolve_role_to_agent=lambda _: {"Initiator": "AgentB"},
    )

    entry = _make_proto_entry("EventProto", [{"kind": "event", "topic": "order.placed", "withType": "start"}])
    registry.register(entry)
    registry.bind_agent("EventProto", "AgentB")
    matcher.register_protocol_triggers(entry)

    bus.publish("order.placed", BusEvent(topic="order.placed", payload={"orderId": "abc"}))

    assert len(fired) == 1
    assert fired[0]["trigger"]["protocolName"] == "EventProto"


def test_matcher_cron():
    registry = ProtocolRegistry()
    bus = LocalEventBus()
    cron = CronAgent(bus)
    fired = []

    matcher = TriggerMatcher(
        registry=registry, bus=bus, cron=cron,
        trigger_callback=lambda a, t: fired.append({"agent": a, "trigger": t}),
        resolve_initiator=lambda _: "AgentC",
        resolve_role_to_agent=lambda _: {"Initiator": "AgentC"},
    )

    entry = _make_proto_entry("CronProto", [{"kind": "cron", "cron": "30 14 * * *"}])
    registry.register(entry)
    registry.bind_agent("CronProto", "AgentC")
    matcher.register_protocol_triggers(entry)

    cron.tick(datetime(2025, 1, 15, 14, 30))
    assert len(fired) == 1
    assert fired[0]["trigger"]["protocolName"] == "CronProto"


def test_matcher_policy_suppression():
    registry = ProtocolRegistry()
    bus = LocalEventBus()
    cron = CronAgent(bus)
    fired = []
    traces = []

    matcher = TriggerMatcher(
        registry=registry, bus=bus, cron=cron,
        trigger_callback=lambda a, t: fired.append(t),
        trace_callback=lambda ev: traces.append(ev),
        resolve_initiator=lambda _: "AgentD",
        resolve_role_to_agent=lambda _: {"Initiator": "AgentD"},
    )

    matcher.set_policy("trigger:invoke:DisabledProto", TriggerPolicy(enabled=False))

    entry = _make_proto_entry("DisabledProto", [{"kind": "invoke", "withType": "start"}])
    registry.register(entry)
    registry.bind_agent("DisabledProto", "AgentD")
    matcher.register_protocol_triggers(entry)

    matched = matcher.match_invoke_trigger("DisabledProto")
    assert not matched
    assert len(fired) == 0
    assert any(t["kind"] == "TriggerSuppressed" for t in traces)


def test_matcher_no_initiator():
    registry = ProtocolRegistry()
    bus = LocalEventBus()
    cron = CronAgent(bus)
    traces = []

    matcher = TriggerMatcher(
        registry=registry, bus=bus, cron=cron,
        trigger_callback=lambda a, t: None,
        trace_callback=lambda ev: traces.append(ev),
        resolve_initiator=lambda _: None,
        resolve_role_to_agent=lambda _: {},
    )

    entry = _make_proto_entry("NoInitProto", [{"kind": "invoke", "withType": "start"}])
    registry.register(entry)
    matcher.register_protocol_triggers(entry)

    assert not matcher.match_invoke_trigger("NoInitProto")
    assert any(
        t["kind"] == "TriggerSuppressed" and t.get("data", {}).get("reason") == "no_initiator"
        for t in traces
    )


if __name__ == "__main__":
    import traceback
    tests = [
        test_bus_publish_subscribe, test_bus_wildcard, test_bus_dispose, test_bus_clear,
        test_parse_cron_field_wildcard, test_parse_cron_field_range_step,
        test_parse_cron_daily, test_cron_matches, test_cron_no_match, test_cron_agent_tick,
        test_default_policy_allows, test_disabled_policy, test_max_concurrent,
        test_cooldown, test_dedup, test_circuit_breaker,
        test_matcher_invoke, test_matcher_event, test_matcher_cron,
        test_matcher_policy_suppression, test_matcher_no_initiator,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
            print(f"  PASS  {t.__name__}")
        except Exception:
            failed += 1
            print(f"  FAIL  {t.__name__}")
            traceback.print_exc()
    print(f"\n{passed}/{passed + failed} passed")
    if failed:
        sys.exit(1)
