"""
Python ReagentController — coverage E2E tests.

Closes Python-side lang-spec gaps with inline IR fixtures.

T7:  Loop with guard expression (3 iterations then exit)
T8:  Timer/wait (sleep 50ms per iteration)
T9:  Alt expression-based guard (branching on $ctx value)
T10: Alt message-based XOR guard (dispatch by incoming message)
T11: try/catch — zone throw routes to error path
T12: reagent.break() exits loop early
T13: protocolCompleted lifecycle handler
T14: protocolFailed lifecycle handler
"""

import asyncio
import os
import sys
import uuid

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
RUNTIME_PY = os.path.join(TESTS_DIR, "..", "py")
sys.path.insert(0, RUNTIME_PY)

from reagent_runtime.controller import ReagentController
from reagent_runtime.inproc_agent_node import InprocAgentNode, InprocAgentHandle


# ── IR fixture builders ───────────────────────────────────────────────

def make_role_ir(role_name, plays, init_body="", lifecycle=None):
    ir = {
        "roleName": role_name,
        "lang": "py",
        "plays": plays,
        "lifecycleHandlers": lifecycle or [],
    }
    if init_body:
        ir["initAction"] = {"body": init_body, "lang": "py"}
    return ir


def make_graph(proto, role, states, transitions):
    initial_id = next(s["id"] for s in states if s["kind"] == "initial")
    terminal_ids = [s["id"] for s in states if s["kind"] == "terminal"]
    return {
        "protocolName": proto,
        "role": role,
        "lang": "py",
        "states": states,
        "transitions": transitions,
        "initialStateId": initial_id,
        "terminalStateIds": terminal_ids,
    }


def s_initial(sid):
    return {"id": sid, "kind": "initial", "data": {"kind": "initial"}}


def s_action(sid, body):
    return {"id": sid, "kind": "action", "data": {"kind": "action", "body": body, "lang": "py"}}


def s_send(sid, to_role, msg_name, pre_zone="", propagate_flow=True):
    d = {"kind": "send", "to": to_role, "arrow": "-->", "messageName": msg_name, "propagateFlow": propagate_flow}
    if pre_zone:
        d["preSendZone"] = pre_zone
    return {"id": sid, "kind": "send", "data": d}


def s_recv(sid, from_role, msg_name, post_zone="", propagate_flow=True, pattern=None):
    d = {"kind": "receive", "from": from_role, "messageName": msg_name, "propagateFlow": propagate_flow}
    if post_zone:
        d["postReceiveZone"] = post_zone
    if pattern:
        d["pattern"] = pattern
    return {"id": sid, "kind": "receive", "data": d}


def s_terminal(sid):
    return {"id": sid, "kind": "terminal", "data": {"kind": "terminal"}}


def s_guard_expr(sid, expr=None):
    d = {"kind": "guard", "guardType": "expression"}
    if expr:
        d["expr"] = expr
    return {"id": sid, "kind": "guard", "data": d}


def s_guard_xor(sid):
    return {"id": sid, "kind": "guard", "data": {"kind": "guard", "guardType": "xor"}}


def s_timer(sid, value, unit):
    return {"id": sid, "kind": "timer", "data": {"kind": "timer", "duration": {"value": value, "unit": unit}}}


def s_error(sid):
    return {"id": sid, "kind": "error", "data": {"kind": "error", "label": "error"}}


def t(from_s, to_s, label=None):
    return {"from": from_s, "to": to_s, "label": label or {"kind": "default"}}


# ── Helpers ───────────────────────────────────────────────────────────

def get_handle(rc, name):
    h = rc.get_agent(name)
    assert isinstance(h, InprocAgentHandle), f"Expected InprocAgentHandle, got {type(h)}"
    return h


results = []


def record(name, passed, error=""):
    results.append({"name": name, "passed": passed, "error": error})
    mark = "PASS" if passed else "FAIL"
    msg = f"  {mark}  {name}"
    if error:
        msg += f": {error}"
    print(msg)


# ── T7: Loop with guard expression ───────────────────────────────────

async def test_t7_loop():
    """Loop runs 3 iterations controlled by guard expression."""
    try:
        rta = {"LoopProto.poller": "PollerAgent", "LoopProto.responder": "ResponderAgent"}

        poller_graph = make_graph("LoopProto", "poller", [
            s_initial("init"),
            s_action("setup", "$ctx.attempt = 0"),
            s_guard_expr("loop_guard", '$ctx["attempt"] < 3'),
            s_send("snd1", "responder", "Ping", pre_zone="$ctx.msg.n = $ctx.attempt"),
            s_recv("rcv1", "responder", "Pong"),
            s_action("inc", "$ctx.attempt = $ctx.attempt + 1"),
            s_guard_expr("merge"),
            s_guard_expr("loop_exit"),
            s_action("finish", "$self.loops_done = $ctx.attempt"),
            s_terminal("end"),
        ], [
            t("init", "setup"),
            t("setup", "loop_guard"),
            t("loop_guard", "snd1"),
            t("snd1", "rcv1"),
            t("rcv1", "inc"),
            t("inc", "merge"),
            t("merge", "loop_guard"),
            t("loop_guard", "loop_exit", {"kind": "else"}),
            t("loop_exit", "finish"),
            t("finish", "end"),
        ])

        responder_graph = make_graph("LoopProto", "responder", [
            s_initial("init"),
            s_action("setup", "$ctx.attempt = 0"),
            s_guard_expr("loop_guard", '$ctx["attempt"] < 3'),
            s_recv("rcv1", "poller", "Ping"),
            s_action("act1", "$ctx.attempt = $ctx.attempt + 1"),
            s_send("snd1", "poller", "Pong"),
            s_guard_expr("merge"),
            s_guard_expr("loop_exit"),
            s_terminal("end"),
        ], [
            t("init", "setup"),
            t("setup", "loop_guard"),
            t("loop_guard", "rcv1"),
            t("rcv1", "act1"),
            t("act1", "snd1"),
            t("snd1", "merge"),
            t("merge", "loop_guard"),
            t("loop_guard", "loop_exit", {"kind": "else"}),
            t("loop_exit", "end"),
        ])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t7")
        rc.add_agent_node("*", node)

        rc.register_agent("PollerAgent", make_role_ir("PollerRole", [
            {"protocolName": "LoopProto", "roleName": "poller"},
        ]), {"LoopProto.poller": poller_graph})

        rc.register_agent("ResponderAgent", make_role_ir("ResponderRole", [
            {"protocolName": "LoopProto", "roleName": "responder"},
        ]), {"LoopProto.responder": responder_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "LoopProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("ResponderAgent", trigger)
        rc.trigger_protocol("PollerAgent", trigger)

        poller_h = get_handle(rc, "PollerAgent")
        responder_h = get_handle(rc, "ResponderAgent")
        await asyncio.gather(
            poller_h.wait_for_completion(1, timeout_s=10.0),
            responder_h.wait_for_completion(1, timeout_s=10.0),
        )

        pi = poller_h.instances[iid]
        assert pi.status == "completed", f"Poller: {pi.status}"
        assert poller_h.get_self().get("loops_done") == 3, f"Expected loops_done=3, got {poller_h.get_self().get('loops_done')}"

        pings = [t for t in pi.traces if t.get("kind") == "MessageSent" and t.get("data", {}).get("messageName") == "Ping"]
        assert len(pings) == 3, f"Expected 3 Pings, got {len(pings)}"

        await rc.stop()
        record("T7: Loop with guard expression", True)
    except Exception as e:
        record("T7: Loop with guard expression", False, str(e))


# ── T8: Timer/wait ───────────────────────────────────────────────────

async def test_t8_timer():
    """Timer state delays execution."""
    try:
        rta = {"TimerProto.sender": "SenderAgent", "TimerProto.receiver": "ReceiverAgent"}

        sender_graph = make_graph("TimerProto", "sender", [
            s_initial("init"),
            s_timer("wait1", 50, "ms"),
            s_send("snd1", "receiver", "Delayed"),
            s_recv("rcv1", "receiver", "Ack"),
            s_terminal("end"),
        ], [t("init", "wait1"), t("wait1", "snd1"), t("snd1", "rcv1"), t("rcv1", "end")])

        receiver_graph = make_graph("TimerProto", "receiver", [
            s_initial("init"),
            s_recv("rcv1", "sender", "Delayed"),
            s_send("snd1", "sender", "Ack"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "snd1"), t("snd1", "end")])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t8")
        rc.add_agent_node("*", node)

        rc.register_agent("SenderAgent", make_role_ir("SenderRole", [
            {"protocolName": "TimerProto", "roleName": "sender"},
        ]), {"TimerProto.sender": sender_graph})
        rc.register_agent("ReceiverAgent", make_role_ir("ReceiverRole", [
            {"protocolName": "TimerProto", "roleName": "receiver"},
        ]), {"TimerProto.receiver": receiver_graph})

        await rc.start()

        import time
        start = time.monotonic()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "TimerProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("SenderAgent", trigger)
        rc.trigger_protocol("ReceiverAgent", trigger)

        sender_h = get_handle(rc, "SenderAgent")
        receiver_h = get_handle(rc, "ReceiverAgent")
        await asyncio.gather(
            sender_h.wait_for_completion(1, timeout_s=5.0),
            receiver_h.wait_for_completion(1, timeout_s=5.0),
        )

        elapsed_ms = (time.monotonic() - start) * 1000
        assert elapsed_ms >= 40, f"Too fast: {elapsed_ms:.0f}ms (expected >= 50ms)"

        si = sender_h.instances[iid]
        assert si.status == "completed", f"Sender: {si.status}"

        timer_started = [t for t in si.traces if t.get("kind") == "TimerStarted"]
        timer_fired = [t for t in si.traces if t.get("kind") == "TimerFired"]
        assert len(timer_started) == 1, f"Expected 1 TimerStarted, got {len(timer_started)}"
        assert len(timer_fired) == 1, f"Expected 1 TimerFired, got {len(timer_fired)}"

        await rc.stop()
        record("T8: Timer/wait", True)
    except Exception as e:
        record("T8: Timer/wait", False, str(e))


# ── T9: Alt expression-based guard ───────────────────────────────────

async def test_t9_alt_expression():
    """Alt with expression guard — deciding agent takes expression branch,
    non-deciding agent falls through to message-wait-fallback."""
    try:
        rta = {"AltExprProto.decider": "DeciderAgent", "AltExprProto.peer": "PeerAgent"}

        # Decider: receives Request, evaluates expression, sends High or Low
        decider_graph = make_graph("AltExprProto", "decider", [
            s_initial("init"),
            s_recv("rcv1", "peer", "Request", post_zone="$ctx.value = $ctx.msg.get('value', 0) if $ctx.msg else 0"),
            s_guard_xor("xor1"),
            s_send("sndHi", "peer", "High"),
            s_send("sndLo", "peer", "Low"),
            s_guard_expr("merge1"),
            s_terminal("end"),
        ], [
            t("init", "rcv1"),
            t("rcv1", "xor1"),
            t("xor1", "sndHi", {"kind": "expression", "expr": '$ctx["value"] > 50'}),
            t("xor1", "sndLo", {"kind": "else"}),
            t("sndHi", "merge1"),
            t("sndLo", "merge1"),
            t("merge1", "end"),
        ])

        # Peer: sends Request, then XOR with expression that throws (ctx.result.x
        # is undefined), so falls through to message-wait, receives High or Low
        peer_graph = make_graph("AltExprProto", "peer", [
            s_initial("init"),
            s_send("snd1", "decider", "Request", pre_zone="$ctx.msg.value = 75"),
            s_guard_xor("xor1"),
            s_guard_expr("guardHi"),
            s_recv("rcvHi", "decider", "High", post_zone="$self.got = 'high'"),
            s_guard_expr("guardLo"),
            s_recv("rcvLo", "decider", "Low", post_zone="$self.got = 'low'"),
            s_guard_expr("merge1"),
            s_terminal("end"),
        ], [
            t("init", "snd1"),
            t("snd1", "xor1"),
            t("xor1", "guardHi", {"kind": "expression", "expr": '$ctx["result"]["status"] == "high"'}),
            t("xor1", "guardLo", {"kind": "else"}),
            t("guardHi", "rcvHi"),
            t("rcvHi", "merge1"),
            t("guardLo", "rcvLo"),
            t("rcvLo", "merge1"),
            t("merge1", "end"),
        ])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t9")
        rc.add_agent_node("*", node)

        rc.register_agent("DeciderAgent", make_role_ir("DeciderRole", [
            {"protocolName": "AltExprProto", "roleName": "decider"},
        ]), {"AltExprProto.decider": decider_graph})
        rc.register_agent("PeerAgent", make_role_ir("PeerRole", [
            {"protocolName": "AltExprProto", "roleName": "peer"},
        ]), {"AltExprProto.peer": peer_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "AltExprProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("DeciderAgent", trigger)
        rc.trigger_protocol("PeerAgent", trigger)

        decider_h = get_handle(rc, "DeciderAgent")
        peer_h = get_handle(rc, "PeerAgent")
        await asyncio.gather(
            decider_h.wait_for_completion(1, timeout_s=5.0),
            peer_h.wait_for_completion(1, timeout_s=5.0),
        )

        di = decider_h.instances[iid]
        assert di.status == "completed", f"Decider: {di.status}"
        assert peer_h.get_self().get("got") == "high", f"Expected 'high', got '{peer_h.get_self().get('got')}'"

        await rc.stop()
        record("T9: Alt expression-based guard", True)
    except Exception as e:
        record("T9: Alt expression-based guard", False, str(e))


# ── T10: Alt message-based XOR guard ─────────────────────────────────

async def test_t10_alt_message():
    """Alt with expression-based XOR — non-deciding waiter uses message-wait-fallback."""
    try:
        rta = {"AltMsgProto.sender": "SenderAgent", "AltMsgProto.waiter": "WaiterAgent"}

        # Sender: receives Ask, decides, sends Yes or No
        sender_graph = make_graph("AltMsgProto", "sender", [
            s_initial("init"),
            s_recv("rcv1", "waiter", "Ask"),
            s_action("decide", "$ctx.choice = 'yes'"),
            s_guard_xor("xor1"),
            s_send("sndY", "waiter", "Yes"),
            s_send("sndN", "waiter", "No"),
            s_guard_expr("merge"),
            s_terminal("end"),
        ], [
            t("init", "rcv1"),
            t("rcv1", "decide"),
            t("decide", "xor1"),
            t("xor1", "sndY", {"kind": "expression", "expr": '$ctx["choice"] == "yes"'}),
            t("xor1", "sndN", {"kind": "else"}),
            t("sndY", "merge"),
            t("sndN", "merge"),
            t("merge", "end"),
        ])

        # Waiter: sends Ask, then expression-based XOR with throwing expr
        # falls through to message-wait
        waiter_graph = make_graph("AltMsgProto", "waiter", [
            s_initial("init"),
            s_send("snd1", "sender", "Ask"),
            s_guard_xor("xor1"),
            s_guard_expr("guardY"),
            s_recv("rcvY", "sender", "Yes", post_zone="$self.answer = 'yes'"),
            s_guard_expr("guardN"),
            s_recv("rcvN", "sender", "No", post_zone="$self.answer = 'no'"),
            s_guard_expr("merge"),
            s_terminal("end"),
        ], [
            t("init", "snd1"),
            t("snd1", "xor1"),
            t("xor1", "guardY", {"kind": "expression", "expr": '$ctx["decision_result"]["value"] == "yes"'}),
            t("xor1", "guardN", {"kind": "else"}),
            t("guardY", "rcvY"),
            t("rcvY", "merge"),
            t("guardN", "rcvN"),
            t("rcvN", "merge"),
            t("merge", "end"),
        ])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t10")
        rc.add_agent_node("*", node)

        rc.register_agent("SenderAgent", make_role_ir("SenderRole", [
            {"protocolName": "AltMsgProto", "roleName": "sender"},
        ]), {"AltMsgProto.sender": sender_graph})
        rc.register_agent("WaiterAgent", make_role_ir("WaiterRole", [
            {"protocolName": "AltMsgProto", "roleName": "waiter"},
        ]), {"AltMsgProto.waiter": waiter_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "AltMsgProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("SenderAgent", trigger)
        rc.trigger_protocol("WaiterAgent", trigger)

        sender_h = get_handle(rc, "SenderAgent")
        waiter_h = get_handle(rc, "WaiterAgent")
        await asyncio.gather(
            sender_h.wait_for_completion(1, timeout_s=5.0),
            waiter_h.wait_for_completion(1, timeout_s=5.0),
        )

        wi = waiter_h.instances[iid]
        assert wi.status == "completed", f"Waiter: {wi.status}"
        assert waiter_h.get_self().get("answer") == "yes", f"Expected 'yes', got '{waiter_h.get_self().get('answer')}'"

        await rc.stop()
        record("T10: Alt message-based XOR guard", True)
    except Exception as e:
        record("T10: Alt message-based XOR guard", False, str(e))


# ── T11: try/catch — zone throw routes to error path ─────────────────

async def test_t11_try_catch():
    """Zone throw triggers catch block, $ctx error is set."""
    try:
        rta = {"TryCatchProto.sender": "SenderAgent", "TryCatchProto.processor": "ProcessorAgent"}

        sender_graph = make_graph("TryCatchProto", "sender", [
            s_initial("init"),
            s_send("snd1", "processor", "Request", pre_zone="$ctx.msg.text = 'fail'"),
            s_guard_xor("xor1"),
            s_guard_expr("guardOk"),
            s_recv("rcvOk", "processor", "Result", post_zone="$self.got = 'ok'"),
            s_guard_expr("guardFail"),
            s_recv("rcvFail", "processor", "Failure", post_zone="$self.got = 'fail:' + str($ctx.msg.get('reason', '') if $ctx.msg else '')"),
            s_guard_expr("merge"),
            s_terminal("end"),
        ], [
            t("init", "snd1"),
            t("snd1", "xor1"),
            t("xor1", "guardOk", {"kind": "expression", "expr": '$ctx["proc_result"]["status"] == "ok"'}),
            t("xor1", "guardFail", {"kind": "else"}),
            t("guardOk", "rcvOk"),
            t("rcvOk", "merge"),
            t("guardFail", "rcvFail"),
            t("rcvFail", "merge"),
            t("merge", "end"),
        ])

        processor_graph = make_graph("TryCatchProto", "processor", [
            s_initial("init"),
            s_recv("rcv1", "sender", "Request", post_zone="$ctx.text = $ctx.msg.get('text', '')"),
            s_action("process", "if $ctx.text == 'fail':\n    raise Exception('processing_failed')\n$ctx.result = 'done'"),
            s_send("sndOk", "sender", "Result", pre_zone="$ctx.msg.data = $ctx.result"),
            s_error("catch1"),
            s_action("errAct", "$ctx.err_msg = 'caught error'"),
            s_send("sndFail", "sender", "Failure", pre_zone="$ctx.msg.reason = $ctx.err_msg"),
            s_guard_expr("try_merge"),
            s_terminal("end"),
        ], [
            t("init", "rcv1"),
            t("rcv1", "process"),
            t("process", "sndOk"),
            t("sndOk", "try_merge"),
            t("rcv1", "catch1", {"kind": "error"}),
            t("catch1", "errAct"),
            t("errAct", "sndFail"),
            t("sndFail", "try_merge"),
            t("try_merge", "end"),
        ])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t11")
        rc.add_agent_node("*", node)

        rc.register_agent("SenderAgent", make_role_ir("SenderRole", [
            {"protocolName": "TryCatchProto", "roleName": "sender"},
        ]), {"TryCatchProto.sender": sender_graph})
        rc.register_agent("ProcessorAgent", make_role_ir("ProcessorRole", [
            {"protocolName": "TryCatchProto", "roleName": "processor"},
        ]), {"TryCatchProto.processor": processor_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "TryCatchProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("ProcessorAgent", trigger)
        rc.trigger_protocol("SenderAgent", trigger)

        sender_h = get_handle(rc, "SenderAgent")
        proc_h = get_handle(rc, "ProcessorAgent")
        await asyncio.gather(
            sender_h.wait_for_completion(1, timeout_s=5.0),
            proc_h.wait_for_completion(1, timeout_s=5.0),
        )

        si = sender_h.instances[iid]
        assert si.status == "completed", f"Sender: {si.status}"
        assert sender_h.get_self().get("got", "").startswith("fail:"), f"Expected 'fail:...', got '{sender_h.get_self().get('got')}'"

        pi = proc_h.instances[iid]
        assert pi.status == "completed", f"Processor: {pi.status}"
        error_caught = [t for t in pi.traces if t.get("kind") == "ErrorCaught"]
        assert len(error_caught) >= 1, f"Expected ErrorCaught trace, got {len(error_caught)}"

        await rc.stop()
        record("T11: try/catch", True)
    except Exception as e:
        record("T11: try/catch", False, str(e))


# ── T12: reagent.break() exits loop early ────────────────────────────

async def test_t12_break():
    """reagent.break() in a zone exits the enclosing loop."""
    try:
        rta = {"BreakProto.counter": "CounterAgent", "BreakProto.peer": "PeerAgent"}

        counter_graph = make_graph("BreakProto", "counter", [
            s_initial("init"),
            s_action("setup", "$ctx.i = 0"),
            s_guard_expr("loop_guard", '$ctx["i"] < 10'),
            s_send("snd1", "peer", "Tick", pre_zone="$ctx.msg.n = $ctx.i"),
            s_recv("rcv1", "peer", "Tock"),
            s_action("inc", "$ctx.i = $ctx.i + 1\nif $ctx.i >= 3:\n    reagent.break_loop()"),
            s_guard_expr("merge"),
            s_guard_expr("loop_exit"),
            s_action("finish", "$self.final_count = $ctx.i"),
            s_terminal("end"),
        ], [
            t("init", "setup"),
            t("setup", "loop_guard"),
            t("loop_guard", "snd1"),
            t("snd1", "rcv1"),
            t("rcv1", "inc"),
            t("inc", "merge"),
            t("merge", "loop_guard"),
            t("loop_guard", "loop_exit", {"kind": "else"}),
            t("loop_exit", "finish"),
            t("finish", "end"),
        ])

        peer_graph = make_graph("BreakProto", "peer", [
            s_initial("init"),
            s_action("setup", "$ctx.i = 0"),
            s_guard_expr("loop_guard", '$ctx["i"] < 3'),
            s_recv("rcv1", "counter", "Tick"),
            s_action("act1", "$ctx.i = $ctx.i + 1"),
            s_send("snd1", "counter", "Tock"),
            s_guard_expr("merge"),
            s_guard_expr("loop_exit"),
            s_terminal("end"),
        ], [
            t("init", "setup"),
            t("setup", "loop_guard"),
            t("loop_guard", "rcv1"),
            t("rcv1", "act1"),
            t("act1", "snd1"),
            t("snd1", "merge"),
            t("merge", "loop_guard"),
            t("loop_guard", "loop_exit", {"kind": "else"}),
            t("loop_exit", "end"),
        ])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t12")
        rc.add_agent_node("*", node)

        rc.register_agent("CounterAgent", make_role_ir("CounterRole", [
            {"protocolName": "BreakProto", "roleName": "counter"},
        ]), {"BreakProto.counter": counter_graph})
        rc.register_agent("PeerAgent", make_role_ir("PeerRole", [
            {"protocolName": "BreakProto", "roleName": "peer"},
        ]), {"BreakProto.peer": peer_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "BreakProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("PeerAgent", trigger)
        rc.trigger_protocol("CounterAgent", trigger)


        counter_h = get_handle(rc, "CounterAgent")
        peer_h = get_handle(rc, "PeerAgent")
        await asyncio.gather(
            counter_h.wait_for_completion(1, timeout_s=10.0),
            peer_h.wait_for_completion(1, timeout_s=10.0),
        )

        ci = counter_h.instances[iid]
        assert ci.status == "completed", f"Counter: {ci.status}"
        fc = counter_h.get_self().get("final_count")
        assert fc == 2, f"Expected 2 (break interrupts before ctx copy-back), got {fc}"

        ticks = [t for t in ci.traces if t.get("kind") == "MessageSent" and t.get("data", {}).get("messageName") == "Tick"]
        assert len(ticks) == 3, f"Expected 3 Ticks, got {len(ticks)}"

        await rc.stop()
        record("T12: reagent.break()", True)
    except Exception as e:
        record("T12: reagent.break()", False, str(e))


# ── T13: protocolCompleted lifecycle handler ──────────────────────────

async def test_t13_lifecycle_completed():
    """protocolCompleted handler fires and updates $self."""
    try:
        rta = {"LcProto.alpha": "AlphaAgent", "LcProto.beta": "BetaAgent"}

        alpha_graph = make_graph("LcProto", "alpha", [
            s_initial("init"),
            s_send("snd1", "beta", "Ping"),
            s_recv("rcv1", "beta", "Pong"),
            s_terminal("end"),
        ], [t("init", "snd1"), t("snd1", "rcv1"), t("rcv1", "end")])

        beta_graph = make_graph("LcProto", "beta", [
            s_initial("init"),
            s_recv("rcv1", "alpha", "Ping"),
            s_send("snd1", "alpha", "Pong"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "snd1"), t("snd1", "end")])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t13")
        rc.add_agent_node("*", node)

        rc.register_agent("AlphaAgent", make_role_ir("AlphaRole", [
            {"protocolName": "LcProto", "roleName": "alpha"},
        ], init_body="$self.completed_count = 0", lifecycle=[
            {"event": "protocolCompleted", "protocolFilter": "LcProto",
             "action": {"body": "$self.completed_count = $self.completed_count + 1", "lang": "py"}},
        ]), {"LcProto.alpha": alpha_graph})

        rc.register_agent("BetaAgent", make_role_ir("BetaRole", [
            {"protocolName": "LcProto", "roleName": "beta"},
        ]), {"LcProto.beta": beta_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "LcProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("BetaAgent", trigger)
        rc.trigger_protocol("AlphaAgent", trigger)

        alpha_h = get_handle(rc, "AlphaAgent")
        beta_h = get_handle(rc, "BetaAgent")
        await asyncio.gather(
            alpha_h.wait_for_completion(1, timeout_s=5.0),
            beta_h.wait_for_completion(1, timeout_s=5.0),
        )

        ai = alpha_h.instances[iid]
        assert ai.status == "completed", f"Alpha: {ai.status}"
        assert alpha_h.get_self().get("completed_count") == 1, f"Expected 1, got {alpha_h.get_self().get('completed_count')}"

        await rc.stop()
        record("T13: protocolCompleted lifecycle", True)
    except Exception as e:
        record("T13: protocolCompleted lifecycle", False, str(e))


# ── T14: protocolFailed lifecycle handler ─────────────────────────────

async def test_t14_lifecycle_failed():
    """protocolFailed handler fires when zone throws (no try/catch)."""
    try:
        rta = {"FailProto.doer": "DoerAgent", "FailProto.peer": "PeerAgent"}

        doer_graph = make_graph("FailProto", "doer", [
            s_initial("init"),
            s_recv("rcv1", "peer", "Go"),
            s_action("act1", "raise Exception('boom')"),
            s_send("snd1", "peer", "Done"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "act1"), t("act1", "snd1"), t("snd1", "end")])

        peer_graph = make_graph("FailProto", "peer", [
            s_initial("init"),
            s_send("snd1", "doer", "Go"),
            s_recv("rcv1", "doer", "Done"),
            s_terminal("end"),
        ], [t("init", "snd1"), t("snd1", "rcv1"), t("rcv1", "end")])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t14")
        rc.add_agent_node("*", node)

        rc.register_agent("DoerAgent", make_role_ir("DoerRole", [
            {"protocolName": "FailProto", "roleName": "doer"},
        ], init_body="$self.fail_count = 0", lifecycle=[
            {"event": "protocolFailed", "protocolFilter": "FailProto",
             "action": {"body": "$self.fail_count = $self.fail_count + 1", "lang": "py"}},
        ]), {"FailProto.doer": doer_graph})

        rc.register_agent("PeerAgent", make_role_ir("PeerRole", [
            {"protocolName": "FailProto", "roleName": "peer"},
        ]), {"FailProto.peer": peer_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "FailProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("DoerAgent", trigger)  # receives Go first
        rc.trigger_protocol("PeerAgent", trigger)   # sends Go

        doer_h = get_handle(rc, "DoerAgent")
        await asyncio.sleep(2.0)

        di = doer_h.instances.get(iid)
        assert di is not None, "Doer instance not found"
        assert di.status == "failed", f"Expected 'failed', got '{di.status}'"
        assert doer_h.get_self().get("fail_count") == 1, f"Expected 1, got {doer_h.get_self().get('fail_count')}"

        fail_traces = [t for t in di.traces if t.get("kind") == "ProtocolFailed"]
        assert len(fail_traces) == 1, f"Expected 1 ProtocolFailed, got {len(fail_traces)}"

        await rc.stop()
        record("T14: protocolFailed lifecycle", True)
    except Exception as e:
        record("T14: protocolFailed lifecycle", False, str(e))


# ── Main ──────────────────────────────────────────────────────────────

async def run_all():
    print("=== Python RC Coverage E2E Tests ===\n")

    await test_t7_loop()
    await test_t8_timer()
    await test_t9_alt_expression()
    await test_t10_alt_message()
    await test_t11_try_catch()
    await test_t12_break()
    await test_t13_lifecycle_completed()
    await test_t14_lifecycle_failed()

    print()
    passed = sum(1 for r in results if r["passed"])
    failed = sum(1 for r in results if not r["passed"])
    print(f"{passed} passed, {failed} failed out of {len(results)}")

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run_all())
