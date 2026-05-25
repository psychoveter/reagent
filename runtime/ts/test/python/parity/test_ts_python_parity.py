"""
M13 Phase 3: Python parity tests.

PP.1: ProtocolEngine — linear navigation, ctx propagation
PP.2: ProtocolEngine — guard evaluation with eval_expr
PP.3: ProtocolEngine — scatter state detection
PP.4: CustomAgentNode + ManagedAgentAdapter — action handling
PP.5: ResolvePolicyEvaluator — all/single/filter/random pipeline
PP.6: StateStore + AgentRegistry — CRUD + find
PP.7: TriggerPolicy — evaluate cooldown, maxConcurrent

Run: python runtime/ts/test/python/parity/test_ts_python_parity.py
  (from projects/reagent/)
"""

import asyncio
import json
import os
import sys
import traceback
import time

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
RUNTIME_PY = os.path.join(TESTS_DIR, "..", "..", "..", "..", "py")
EXAMPLES_OUT = os.path.join(TESTS_DIR, "..", "..", "..", "..", "..", "examples", "out")
sys.path.insert(0, RUNTIME_PY)


def load_graph(example: str, role: str) -> dict:
    d = os.path.join(EXAMPLES_OUT, example)
    for f in os.listdir(d):
        if f.endswith(f".{role}.ir.json"):
            with open(os.path.join(d, f)) as fh:
                return json.load(fh)
    files = [f for f in os.listdir(d) if f.endswith(".ir.json")]
    raise FileNotFoundError(f"No IR for role '{role}' in {example}. Available: {files}")


# ── PP.1: ProtocolEngine — linear navigation ─────────────────────────

def test_pp1():
    from reagent_runtime.protocol_engine import ProtocolEngine, duration_to_ms

    graph = load_graph("14-ts-only-demo", "client")
    engine = ProtocolEngine(
        graph,
        instance_id="test-1",
        protocol_name=graph["protocolName"],
        agent_name="test-agent",
        role_name=graph["role"],
        self_ref={},
    )

    assert engine.status == "idle", f"Expected idle, got {engine.status}"
    assert engine.current_state_id == graph["initialStateId"]
    assert len(engine.state_map) == len(graph["states"])
    assert len(engine.state_map) > 0

    next_id = engine.follow_default()
    engine.current_state_id = next_id
    assert engine.current_state_id == next_id

    engine.assign_target("$ctx.foo", "bar")
    assert engine.ctx["foo"] == "bar"

    engine.assign_target("$ctx.count", 42)

    assert engine.expression_vars_are_defined("$ctx.foo") is True
    assert engine.expression_vars_are_defined("$ctx.undefined_var") is False

    engine.ctx = {"fresh": True}
    assert engine.ctx.get("foo") is None
    assert engine.ctx["fresh"] is True

    # eval_expr uses raw dict, so bracket access works
    engine.ctx = {"count": 42}
    result = engine.eval_expr("$ctx['count'] + 8")
    assert result == 50, f"eval_expr returned {result}"

    assert duration_to_ms({"value": 1, "unit": "s"}) == 1000
    assert duration_to_ms({"value": 500, "unit": "ms"}) == 500
    assert duration_to_ms({"value": 2, "unit": "m"}) == 120_000
    assert duration_to_ms({"value": 1, "unit": "h"}) == 3_600_000

    engine.status = "completed"
    assert engine.status == "completed"

    return "PP.1: ProtocolEngine — linear navigation + ctx + duration_to_ms"


# ── PP.2: ProtocolEngine — guard evaluation ──────────────────────────

def test_pp2():
    from reagent_runtime.protocol_engine import ProtocolEngine

    graph = load_graph("02-await-timeout-and-alt", "comma")
    engine = ProtocolEngine(
        graph,
        instance_id="test-2",
        protocol_name=graph["protocolName"],
        agent_name="test-agent",
        role_name=graph["role"],
        self_ref={},
    )

    guard_states = [s for s in engine.state_map.values() if s["data"]["kind"] == "guard"]
    assert len(guard_states) > 0, "No guard states in alt protocol"

    engine.ctx = {"approved": True}
    assert engine.eval_expr("$ctx['approved'] == True") is True, "eval failed for True"

    engine.ctx = {"approved": False}
    assert engine.eval_expr("$ctx['approved'] == True") is False, "eval failed for False"

    return "PP.2: ProtocolEngine — guard evaluation with eval_expr"


# ── PP.3: ProtocolEngine — scatter state detection ───────────────────

def test_pp3():
    from reagent_runtime.protocol_engine import ProtocolEngine

    graph = load_graph("23-scatter-gather", "coordinator")
    engine = ProtocolEngine(
        graph,
        instance_id="test-3",
        protocol_name=graph["protocolName"],
        agent_name="test-agent",
        role_name=graph["role"],
        self_ref={},
    )

    scatter_states = [s for s in engine.state_map.values() if s["data"]["kind"] == "scatter"]
    assert len(scatter_states) > 0, "No scatter states"

    sc = scatter_states[0]
    assert sc["data"].get("collection"), "scatter missing collection"
    assert sc["data"].get("branchStartIds"), "scatter missing branchStartIds"

    for bid in sc["data"]["branchStartIds"]:
        assert bid in engine.state_map, f"branchStartId {bid} not in state_map"

    join_states = [s for s in engine.state_map.values() if s["data"]["kind"] == "join"]
    assert len(join_states) > 0, "No join states for scatter"

    return "PP.3: ProtocolEngine — scatter state detection"


# ── PP.4: ManagedAgentAdapter — action handling ──────────────────────

def test_pp4():
    from reagent_runtime.agent_interface import ManagedAgentAdapter

    adapter = ManagedAgentAdapter()

    event = {
        "type": "action",
        "stateId": "s1",
        "body": "ctx['x'] = 42",
        "lang": "py",
        "isAsync": False,
        "ctx": {"x": 0},
        "self": {},
    }

    result = asyncio.run(adapter.handle(event))
    assert result["type"] == "ctx_update", f"Expected ctx_update, got {result['type']}"
    assert result["ctx"]["x"] == 42, f"Expected x=42, got {result['ctx']}"

    error_event = {
        "type": "action",
        "stateId": "s2",
        "body": "raise ValueError('boom')",
        "lang": "py",
        "isAsync": False,
        "ctx": {},
        "self": {},
    }
    result2 = asyncio.run(adapter.handle(error_event))
    assert result2["type"] == "error_thrown", f"Expected error_thrown, got {result2['type']}"
    assert "boom" in result2["error"]

    noop_event = {"type": "receive_required", "stateId": "s3", "from": "a", "messageName": "M"}
    result3 = asyncio.run(adapter.handle(noop_event))
    assert result3["type"] == "noop"

    return "PP.4: ManagedAgentAdapter — action handling"


# ── PP.5: ResolvePolicyEvaluator ─────────────────────────────────────

def test_pp5():
    from reagent_runtime.state_store import InMemoryStateStore
    from reagent_runtime.state_store_agent_registry import StateStoreAgentRegistry, AgentRegistration
    from reagent_runtime.resolve_policy_evaluator import ResolvePolicyEvaluator, ResolveContext

    store = InMemoryStateStore()
    registry = StateStoreAgentRegistry(store)
    evaluator = ResolvePolicyEvaluator(registry)

    agents = [
        AgentRegistration(
            name=f"buyer-{i}",
            role="buyer",
        )
        for i in range(5)
    ]
    async def _register_all():
        for a in agents:
            await registry.register(a)
    asyncio.run(_register_all())

    # all
    result = evaluator.evaluate([{"step": "all"}], "buyer")
    assert len(result) == 5, f"all: expected 5, got {len(result)}"

    # single
    result = evaluator.evaluate([{"step": "single"}], "buyer")
    assert len(result) == 1, f"single: expected 1, got {len(result)}"

    # filter + first
    result = evaluator.evaluate([
        {"step": "filter", "predicate": 'agent.name == "buyer-2"'},
        {"step": "first"},
    ], "buyer")
    assert len(result) == 1
    assert result[0].name == "buyer-2"

    # random
    result = evaluator.evaluate([{"step": "random"}], "buyer")
    assert len(result) == 1

    return "PP.5: ResolvePolicyEvaluator — all/single/filter/random"


# ── PP.6: StateStore + AgentRegistry ─────────────────────────────────

def test_pp6():
    from reagent_runtime.state_store import InMemoryStateStore
    from reagent_runtime.state_store_agent_registry import StateStoreAgentRegistry, AgentRegistration

    store = InMemoryStateStore()
    registry = StateStoreAgentRegistry(store)

    async def _run():
        reg = AgentRegistration(name="agent-a", role="seller", tags=["fast"])
        await registry.register(reg)

        found = registry.find_by_role("seller")
        assert len(found) == 1
        assert found[0].name == "agent-a"

        found2 = registry.find_by_role("nonexistent")
        assert len(found2) == 0

        reg2 = AgentRegistration(name="agent-b", role="seller")
        await registry.register(reg2)
        found3 = registry.find_by_role("seller")
        assert len(found3) == 2

        await registry.deregister("agent-a")
        found4 = registry.find_by_role("seller")
        assert len(found4) == 1
        assert found4[0].name == "agent-b"

        # StateStore direct
        await store.put("key1", json.dumps({"value": 123}))
        val = await store.get("key1")
        assert val is not None
        assert json.loads(val)["value"] == 123

        deleted = await store.delete("key1")
        assert deleted is True
        val2 = await store.get("key1")
        assert val2 is None

    asyncio.run(_run())

    return "PP.6: StateStore + AgentRegistry — CRUD + find"


# ── PP.7: TriggerPolicy ─────────────────────────────────────────────

def test_pp7():
    from reagent_runtime.trigger_policy import TriggerPolicy, TriggerPolicyState, evaluate_policy

    now_ms = time.time() * 1000

    policy = TriggerPolicy(
        enabled=True,
        max_concurrent=2,
        cooldown_ms=100,
    )
    state = TriggerPolicyState()

    # evaluate_policy returns None if allowed, or reason string if suppressed
    result = evaluate_policy(policy, state, "", now_ms)
    assert result is None, f"First call should be allowed, got: {result}"

    state.running_count = 1
    result = evaluate_policy(policy, state, "", now_ms)
    assert result is None, f"Second concurrent should be allowed, got: {result}"

    state.running_count = 2
    result = evaluate_policy(policy, state, "", now_ms)
    assert result is not None, "Third concurrent should be rejected"

    state.running_count = 0
    state.last_fired_at = now_ms
    result = evaluate_policy(policy, state, "", now_ms + 10)  # 10ms after
    assert result is not None, "Should reject during cooldown"

    result = evaluate_policy(policy, state, "", now_ms + 200)  # 200ms after
    assert result is None, f"Should allow after cooldown, got: {result}"

    disabled_policy = TriggerPolicy(enabled=False)
    disabled_state = TriggerPolicyState()
    result = evaluate_policy(disabled_policy, disabled_state, "", now_ms)
    assert result is not None, "Disabled policy should reject"

    return "PP.7: TriggerPolicy — evaluate cooldown + maxConcurrent"


# ── Runner ───────────────────────────────────────────────────────────

def main():
    tests = [test_pp1, test_pp2, test_pp3, test_pp4, test_pp5, test_pp6, test_pp7]
    passed = 0
    failed = 0

    for test_fn in tests:
        try:
            name = test_fn()
            print(f"  ✓ {name}")
            passed += 1
        except Exception:
            print(f"  ✗ {test_fn.__name__}")
            traceback.print_exc()
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
