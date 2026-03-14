"""
Python ReagentController — E2E tests.

Uses inline IR fixtures with Python-compatible zone code.  Tests the full
stack: ReagentController → InprocTransport → AgentRunner → ProtocolInstance.

T1: Inproc loopback — two agents, simple request/response
T2: Inproc invoke — child protocol invocation
T3: Inproc async invokes — fire-and-forget child protocol
T4: Inproc par — parallel branches with join
T5: $ctx and message payload — data passed via messages
T6: IPC agent — subprocess agent via ipc_agent.py
"""

import asyncio
import json
import os
import sys
import uuid

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
RUNTIME_PY = os.path.join(TESTS_DIR, "..", "..", "..", "py")
sys.path.insert(0, RUNTIME_PY)

from reagent_runtime.controller import ReagentController
from reagent_runtime.inproc_agent_node import InprocAgentNode, InprocAgentHandle
from reagent_runtime.ipc_agent_node import IpcAgentNode, IpcAgentHandle


# ── IR fixture builders ───────────────────────────────────────────────

def make_role_ir(role_name: str, plays: list[dict], init_body: str = "", lifecycle: list = None) -> dict:
    ir: dict = {
        "roleName": role_name,
        "lang": "py",
        "plays": plays,
        "lifecycleHandlers": lifecycle or [],
    }
    if init_body:
        ir["initAction"] = {"body": init_body, "lang": "py"}
    return ir


def make_graph(proto: str, role: str, states: list[dict], transitions: list[dict]) -> dict:
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


def s_initial(sid: str) -> dict:
    return {"id": sid, "kind": "initial", "data": {"kind": "initial"}}


def s_action(sid: str, body: str) -> dict:
    return {"id": sid, "kind": "action", "data": {"kind": "action", "body": body, "lang": "py"}}


def s_send(sid: str, to_role: str, msg_name: str, pre_zone: str = "") -> dict:
    d: dict = {"kind": "send", "to": to_role, "arrow": "-->", "messageName": msg_name}
    if pre_zone:
        d["preSendZone"] = pre_zone
    return {"id": sid, "kind": "send", "data": d}


def s_recv(sid: str, from_role: str, msg_name: str, post_zone: str = "") -> dict:
    d: dict = {"kind": "receive", "from": from_role, "messageName": msg_name}
    if post_zone:
        d["postReceiveZone"] = post_zone
    return {"id": sid, "kind": "receive", "data": d}


def s_terminal(sid: str) -> dict:
    return {"id": sid, "kind": "terminal", "data": {"kind": "terminal"}}


def t(from_s: str, to_s: str, label: dict | None = None) -> dict:
    return {"from": from_s, "to": to_s, "label": label or {"kind": "default"}}


def s_invoke(sid: str, proto_name: str, caller_role: str, input_expr: str = "{}", result_target: str = "") -> dict:
    d: dict = {
        "kind": "invoke",
        "protocolName": proto_name,
        "callerRole": caller_role,
        "input": input_expr,
    }
    if result_target:
        d["resultTarget"] = result_target
    return {"id": sid, "kind": "invoke", "data": d}


def s_spawn(sid: str, proto_name: str, caller_role: str, input_expr: str = "{}") -> dict:
    return {"id": sid, "kind": "spawn", "data": {
        "kind": "spawn",
        "protocolName": proto_name,
        "callerRole": caller_role,
        "input": input_expr,
    }}


def s_fork(sid: str, branch_start_ids: list[str]) -> dict:
    return {"id": sid, "kind": "fork", "data": {"kind": "fork", "branchStartIds": branch_start_ids}}


def s_join(sid: str, branch_count: int) -> dict:
    return {"id": sid, "kind": "join", "data": {"kind": "join", "branchCount": branch_count}}


def s_guard(sid: str) -> dict:
    return {"id": sid, "kind": "guard", "data": {"kind": "guard", "guardType": "expression"}}


# ── Helpers ───────────────────────────────────────────────────────────

def get_handle(rc: ReagentController, name: str) -> InprocAgentHandle:
    h = rc.get_agent(name)
    assert isinstance(h, InprocAgentHandle), f"Expected InprocAgentHandle, got {type(h)}"
    return h


results: list[dict] = []


def record(name: str, passed: bool, error: str = "") -> None:
    results.append({"name": name, "passed": passed, "error": error})
    mark = "PASS" if passed else "FAIL"
    msg = f"  {mark}  {name}"
    if error:
        msg += f": {error}"
    print(msg)


# ── T1: Inproc loopback ──────────────────────────────────────────────

async def test_t1_inproc_loopback() -> None:
    """Two agents, simple request → response → done."""
    try:
        rta = {"SimpleProto.sender": "SenderAgent", "SimpleProto.receiver": "ReceiverAgent"}

        sender_graph = make_graph("SimpleProto", "sender", [
            s_initial("init"),
            s_action("act1", "$ctx.greeting = 'hello from sender'"),
            s_send("snd1", "receiver", "Ping", pre_zone="$ctx.msg.text = $ctx.greeting"),
            s_recv("rcv1", "receiver", "Pong", post_zone="$ctx.reply = $ctx.msg.text"),
            s_terminal("end"),
        ], [t("init", "act1"), t("act1", "snd1"), t("snd1", "rcv1"), t("rcv1", "end")])

        receiver_graph = make_graph("SimpleProto", "receiver", [
            s_initial("init"),
            s_recv("rcv1", "sender", "Ping", post_zone="$ctx.received = $ctx.msg.text"),
            s_action("act1", "$ctx.reply = 'pong:' + $ctx.received"),
            s_send("snd1", "sender", "Pong", pre_zone="$ctx.msg.text = $ctx.reply"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "act1"), t("act1", "snd1"), t("snd1", "end")])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t1")
        rc.add_agent_node("*", node)

        rc.register_agent("SenderAgent", make_role_ir("SenderRole", [{"protocolName": "SimpleProto", "roleName": "sender"}]), {"SimpleProto.sender": sender_graph})
        rc.register_agent("ReceiverAgent", make_role_ir("ReceiverRole", [{"protocolName": "SimpleProto", "roleName": "receiver"}]), {"SimpleProto.receiver": receiver_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "SimpleProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("SenderAgent", trigger)
        rc.trigger_protocol("ReceiverAgent", trigger)

        sender_h = get_handle(rc, "SenderAgent")
        receiver_h = get_handle(rc, "ReceiverAgent")
        await asyncio.gather(
            sender_h.wait_for_completion(1, timeout_s=5.0),
            receiver_h.wait_for_completion(1, timeout_s=5.0),
        )

        si = sender_h.instances[iid]
        ri = receiver_h.instances[iid]
        assert si.status == "completed", f"Sender: {si.status}"
        assert ri.status == "completed", f"Receiver: {ri.status}"

        await rc.stop()
        record("T1: Inproc loopback", True)
    except Exception as e:
        record("T1: Inproc loopback", False, str(e))


# ── T2: Inproc invoke ────────────────────────────────────────────────

async def test_t2_inproc_invoke() -> None:
    """Protocol-level invoke: parent protocol calls child synchronously."""
    try:
        rta = {
            "ParentProto.caller": "CallerAgent",
            "ParentProto.worker": "WorkerAgent",
            "ChildProto.worker": "WorkerAgent",
            "ChildProto.caller": "CallerAgent",
        }

        caller_graph = make_graph("ParentProto", "caller", [
            s_initial("init"),
            s_action("act1", "$ctx.x = 5"),
            s_send("snd1", "worker", "StartWork", pre_zone="$ctx.msg.value = $ctx.x"),
            s_recv("rcv1", "worker", "WorkDone", post_zone="$ctx.result = $ctx.msg.value"),
            s_terminal("end"),
        ], [t("init", "act1"), t("act1", "snd1"), t("snd1", "rcv1"), t("rcv1", "end")])

        worker_graph = make_graph("ParentProto", "worker", [
            s_initial("init"),
            s_recv("rcv1", "caller", "StartWork", post_zone="$ctx.val = $ctx.msg.value"),
            s_invoke("inv1", "ChildProto", "worker", input_expr="{'value': $ctx.val}", result_target="$ctx.childResult"),
            s_action("act1", "$ctx.out = $ctx.childResult"),
            s_send("snd1", "caller", "WorkDone", pre_zone="$ctx.msg.value = $ctx.out"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "inv1"), t("inv1", "act1"), t("act1", "snd1"), t("snd1", "end")])

        child_worker_graph = make_graph("ChildProto", "worker", [
            s_initial("init"),
            s_action("act1", "$ctx.computed = ($ctx.input.get('value', 0) if $ctx.input else 0) * 2"),
            s_send("snd1", "caller", "ChildResult", pre_zone="$ctx.msg.value = $ctx.computed"),
            s_terminal("end"),
        ], [t("init", "act1"), t("act1", "snd1"), t("snd1", "end")])

        child_caller_graph = make_graph("ChildProto", "caller", [
            s_initial("init"),
            s_recv("rcv1", "worker", "ChildResult", post_zone="$ctx.retval = $ctx.msg.value"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "end")])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t2")
        rc.add_agent_node("*", node)

        rc.register_agent("CallerAgent", make_role_ir("CallerRole", [
            {"protocolName": "ParentProto", "roleName": "caller"},
            {"protocolName": "ChildProto", "roleName": "caller"},
        ]), {"ParentProto.caller": caller_graph, "ChildProto.caller": child_caller_graph})

        rc.register_agent("WorkerAgent", make_role_ir("WorkerRole", [
            {"protocolName": "ParentProto", "roleName": "worker"},
            {"protocolName": "ChildProto", "roleName": "worker"},
        ]), {"ParentProto.worker": worker_graph, "ChildProto.worker": child_worker_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "ParentProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("CallerAgent", trigger)
        rc.trigger_protocol("WorkerAgent", trigger)

        caller_h = get_handle(rc, "CallerAgent")
        worker_h = get_handle(rc, "WorkerAgent")
        await asyncio.gather(
            caller_h.wait_for_completion(1, timeout_s=5.0),
            worker_h.wait_for_completion(1, timeout_s=5.0),
        )

        ci = caller_h.instances[iid]
        wi = worker_h.instances[iid]
        assert ci.status == "completed", f"Caller: {ci.status}"
        assert wi.status == "completed", f"Worker: {wi.status}"

        w_traces = wi.traces
        assert any(t["kind"] == "InvokeStarted" for t in w_traces), "Worker should have InvokeStarted"

        await rc.stop()
        record("T2: Inproc invoke", True)
    except Exception as e:
        record("T2: Inproc invoke", False, str(e))


# ── T3: Inproc async invokes ──────────────────────────────────────────

async def test_t3_inproc_spawn() -> None:
    """Protocol-level spawn: fire-and-forget child protocol."""
    try:
        rta = {
            "MainProto.orchestrator": "OrchAgent",
            "MainProto.helper": "HelperAgent",
            "BgTask.orchestrator": "OrchAgent",
        }

        orch_graph = make_graph("MainProto", "orchestrator", [
            s_initial("init"),
            s_spawn("sp1", "BgTask", "orchestrator"),
            s_send("snd1", "helper", "Notify"),
            s_recv("rcv1", "helper", "Ack"),
            s_terminal("end"),
        ], [t("init", "sp1"), t("sp1", "snd1"), t("snd1", "rcv1"), t("rcv1", "end")])

        helper_graph = make_graph("MainProto", "helper", [
            s_initial("init"),
            s_recv("rcv1", "orchestrator", "Notify"),
            s_send("snd1", "orchestrator", "Ack"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "snd1"), t("snd1", "end")])

        bg_graph = make_graph("BgTask", "orchestrator", [
            s_initial("init"),
            s_action("act1", "$self.bg_ran = True"),
            s_terminal("end"),
        ], [t("init", "act1"), t("act1", "end")])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t3")
        rc.add_agent_node("*", node)

        rc.register_agent("OrchAgent", make_role_ir("OrchRole", [
            {"protocolName": "MainProto", "roleName": "orchestrator"},
            {"protocolName": "BgTask", "roleName": "orchestrator"},
        ]), {"MainProto.orchestrator": orch_graph, "BgTask.orchestrator": bg_graph})

        rc.register_agent("HelperAgent", make_role_ir("HelperRole", [
            {"protocolName": "MainProto", "roleName": "helper"},
        ]), {"MainProto.helper": helper_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "MainProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("OrchAgent", trigger)
        rc.trigger_protocol("HelperAgent", trigger)

        orch_h = get_handle(rc, "OrchAgent")
        helper_h = get_handle(rc, "HelperAgent")
        await asyncio.gather(
            orch_h.wait_for_completion(1, timeout_s=5.0),
            helper_h.wait_for_completion(1, timeout_s=5.0),
        )

        oi = orch_h.instances[iid]
        assert oi.status == "completed", f"Orchestrator: {oi.status}"

        o_traces = oi.traces
        assert any(t["kind"] == "AsyncInvokeStarted" for t in o_traces), "Orchestrator should have AsyncInvokeStarted trace"

        await rc.stop()
        record("T3: Inproc async invokes", True)
    except Exception as e:
        record("T3: Inproc async invokes", False, str(e))


# ── T4: Inproc par ───────────────────────────────────────────────────

async def test_t4_inproc_par() -> None:
    """Parallel branches with join."""
    try:
        rta = {
            "ParProto.coordinator": "CoordAgent",
            "ParProto.workerA": "WorkerAAgent",
            "ParProto.workerB": "WorkerBAgent",
        }

        coord_graph = make_graph("ParProto", "coordinator", [
            s_initial("init"),
            s_fork("fork1", ["par_a", "par_b"]),
            s_guard("par_a"),
            s_send("sndA", "workerA", "TaskA"),
            s_recv("rcvA", "workerA", "DoneA"),
            s_guard("par_b"),
            s_send("sndB", "workerB", "TaskB"),
            s_recv("rcvB", "workerB", "DoneB"),
            s_join("join1", 2),
            s_action("act1", "$self.both_done = True"),
            s_terminal("end"),
        ], [
            t("init", "fork1"),
            t("fork1", "par_a", {"kind": "branch", "branchIndex": 0}),
            t("fork1", "par_b", {"kind": "branch", "branchIndex": 1}),
            t("par_a", "sndA"),
            t("sndA", "rcvA"),
            t("rcvA", "join1"),
            t("par_b", "sndB"),
            t("sndB", "rcvB"),
            t("rcvB", "join1"),
            t("join1", "act1"),
            t("act1", "end"),
        ])

        wa_graph = make_graph("ParProto", "workerA", [
            s_initial("init"),
            s_recv("rcv1", "coordinator", "TaskA"),
            s_send("snd1", "coordinator", "DoneA"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "snd1"), t("snd1", "end")])

        wb_graph = make_graph("ParProto", "workerB", [
            s_initial("init"),
            s_recv("rcv1", "coordinator", "TaskB"),
            s_send("snd1", "coordinator", "DoneB"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "snd1"), t("snd1", "end")])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t4")
        rc.add_agent_node("*", node)

        rc.register_agent("CoordAgent", make_role_ir("CoordRole", [{"protocolName": "ParProto", "roleName": "coordinator"}]), {"ParProto.coordinator": coord_graph})
        rc.register_agent("WorkerAAgent", make_role_ir("WorkerARole", [{"protocolName": "ParProto", "roleName": "workerA"}]), {"ParProto.workerA": wa_graph})
        rc.register_agent("WorkerBAgent", make_role_ir("WorkerBRole", [{"protocolName": "ParProto", "roleName": "workerB"}]), {"ParProto.workerB": wb_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "ParProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("CoordAgent", trigger)
        rc.trigger_protocol("WorkerAAgent", trigger)
        rc.trigger_protocol("WorkerBAgent", trigger)

        coord_h = get_handle(rc, "CoordAgent")
        wa_h = get_handle(rc, "WorkerAAgent")
        wb_h = get_handle(rc, "WorkerBAgent")
        await asyncio.gather(
            coord_h.wait_for_completion(1, timeout_s=5.0),
            wa_h.wait_for_completion(1, timeout_s=5.0),
            wb_h.wait_for_completion(1, timeout_s=5.0),
        )

        ci = coord_h.instances[iid]
        assert ci.status == "completed", f"Coordinator: {ci.status}"
        assert coord_h.get_self().get("both_done") is True, "both_done should be True"

        await rc.stop()
        record("T4: Inproc par", True)
    except Exception as e:
        record("T4: Inproc par", False, str(e))


# ── T5: $ctx and message payload ─────────────────────────────────────

async def test_t5_ctx_and_message() -> None:
    """$ctx stores local state; data is passed via message payload."""
    try:
        rta = {"MsgProto.a": "AgentA", "MsgProto.b": "AgentB"}

        a_graph = make_graph("MsgProto", "a", [
            s_initial("init"),
            s_action("act1", "$ctx.secret = 42"),
            s_send("snd1", "b", "Msg1", pre_zone="$ctx.msg.secret = $ctx.secret"),
            s_recv("rcv1", "b", "Msg2"),
            s_terminal("end"),
        ], [t("init", "act1"), t("act1", "snd1"), t("snd1", "rcv1"), t("rcv1", "end")])

        b_graph = make_graph("MsgProto", "b", [
            s_initial("init"),
            s_recv("rcv1", "a", "Msg1", post_zone="$self.got_secret = $ctx.msg.secret"),
            s_send("snd1", "a", "Msg2"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "snd1"), t("snd1", "end")])

        node = InprocAgentNode(role_to_agent=rta)
        rc = ReagentController(node_id="test-t5")
        rc.add_agent_node("*", node)

        rc.register_agent("AgentA", make_role_ir("RoleA", [{"protocolName": "MsgProto", "roleName": "a"}]), {"MsgProto.a": a_graph})
        rc.register_agent("AgentB", make_role_ir("RoleB", [{"protocolName": "MsgProto", "roleName": "b"}]), {"MsgProto.b": b_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "MsgProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("AgentA", trigger)
        rc.trigger_protocol("AgentB", trigger)

        a_h = get_handle(rc, "AgentA")
        b_h = get_handle(rc, "AgentB")
        await asyncio.gather(
            a_h.wait_for_completion(1, timeout_s=5.0),
            b_h.wait_for_completion(1, timeout_s=5.0),
        )

        ai = a_h.instances[iid]
        bi = b_h.instances[iid]
        assert ai.status == "completed", f"A: {ai.status}"
        assert bi.status == "completed", f"B: {bi.status}"

        assert b_h.get_self().get("got_secret") == 42, f"Expected 42, got {b_h.get_self().get('got_secret')}"

        await rc.stop()
        record("T5: $ctx and message payload", True)
    except Exception as e:
        record("T5: $ctx and message payload", False, str(e))


# ── T6: IPC agent ────────────────────────────────────────────────────

async def test_t6_ipc_agent() -> None:
    """One inproc + one IPC subprocess agent communicate."""
    try:
        rta = {"IpcProto.a": "InprocAgent", "IpcProto.b": "SubprocAgent"}

        a_graph = make_graph("IpcProto", "a", [
            s_initial("init"),
            s_send("snd1", "b", "Hello", pre_zone="$ctx.msg.text = 'hi'"),
            s_recv("rcv1", "b", "Reply", post_zone="$self.reply = $ctx.msg.text"),
            s_terminal("end"),
        ], [t("init", "snd1"), t("snd1", "rcv1"), t("rcv1", "end")])

        b_graph = make_graph("IpcProto", "b", [
            s_initial("init"),
            s_recv("rcv1", "a", "Hello"),
            s_send("snd1", "a", "Reply", pre_zone="$ctx.msg.text = 'world'"),
            s_terminal("end"),
        ], [t("init", "rcv1"), t("rcv1", "snd1"), t("snd1", "end")])

        inproc_node = InprocAgentNode(role_to_agent=rta)
        ipc_node = IpcAgentNode(role_to_agent=rta)

        rc = ReagentController(node_id="test-t6")
        rc.add_agent_node("py", inproc_node)
        rc.add_agent_node("ipc", ipc_node)

        rc.register_agent("InprocAgent", make_role_ir("RoleA", [{"protocolName": "IpcProto", "roleName": "a"}]), {"IpcProto.a": a_graph})

        b_role_ir = make_role_ir("RoleB", [{"protocolName": "IpcProto", "roleName": "b"}])
        b_role_ir["lang"] = "ipc"
        rc.register_agent("SubprocAgent", b_role_ir, {"IpcProto.b": b_graph})

        await rc.start()

        iid = str(uuid.uuid4())
        trigger = {"instanceId": iid, "protocolName": "IpcProto", "input": {}, "roleToAgent": rta}
        rc.trigger_protocol("InprocAgent", trigger)
        rc.trigger_protocol("SubprocAgent", trigger)

        inproc_h = get_handle(rc, "InprocAgent")
        ipc_h = rc.get_agent("SubprocAgent")
        assert isinstance(ipc_h, IpcAgentHandle)

        await asyncio.gather(
            inproc_h.wait_for_completion(1, timeout_s=10.0),
            ipc_h.wait_for_completion(1, timeout_s=10.0),
        )

        ai = inproc_h.instances[iid]
        assert ai.status == "completed", f"Inproc agent: {ai.status}"
        assert inproc_h.get_self().get("reply") == "world"

        await rc.stop()
        record("T6: IPC agent", True)
    except Exception as e:
        record("T6: IPC agent", False, str(e))


# ── Main ──────────────────────────────────────────────────────────────

async def run_all() -> None:
    print("=== Python ReagentController E2E Tests ===\n")

    await test_t1_inproc_loopback()
    await test_t2_inproc_invoke()
    await test_t3_inproc_spawn()
    await test_t4_inproc_par()
    await test_t5_ctx_and_message()
    await test_t6_ipc_agent()

    print()
    passed = sum(1 for r in results if r["passed"])
    failed = sum(1 for r in results if not r["passed"])
    print(f"{passed} passed, {failed} failed out of {len(results)}")

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run_all())
