"""
ProtocolEngine — pure FSM walker for Reagent protocol instances (Python mirror).

Owns the IR graph, state machine state, and $ctx. The orchestrating layer
handles zone execution, transport, and trace emission.
"""
from __future__ import annotations

import re
from typing import Any, Optional


class ProtocolEngine:
    """Pure FSM walker. Does not execute zones or talk to transport."""

    def __init__(
        self,
        graph: dict[str, Any],
        *,
        instance_id: str,
        protocol_name: str,
        agent_name: str,
        role_name: str,
        self_ref: dict[str, Any],
        input_data: Optional[dict[str, Any]] = None,
    ) -> None:
        self.instance_id = instance_id
        self.protocol_name = protocol_name
        self.agent_name = agent_name
        self.role_name = role_name

        self._graph = graph
        self._self_ref = self_ref

        self._ctx: dict[str, Any] = {}
        if input_data:
            self._ctx["input"] = input_data

        self._current_state_id: str = graph["initialStateId"]
        self._status: str = "idle"

        self._return_value: Any = None
        self._has_return_value: bool = False

        self._state_map: dict[str, dict[str, Any]] = {}
        for s in graph["states"]:
            self._state_map[s["id"]] = s

        self._transitions_from: dict[str, list[dict[str, Any]]] = {}
        for t in graph["transitions"]:
            self._transitions_from.setdefault(t["from"], []).append(t)

        self._try_catch_map: dict[str, str] = {}
        for t in graph["transitions"]:
            if t["label"]["kind"] == "error":
                self._try_catch_map[t["from"]] = t["to"]
        self._catch_stack: list[str] = []

    @property
    def ctx(self) -> dict[str, Any]:
        return self._ctx

    @ctx.setter
    def ctx(self, val: dict[str, Any]) -> None:
        self._ctx = val

    @property
    def self_ref(self) -> dict[str, Any]:
        return self._self_ref

    @property
    def status(self) -> str:
        return self._status

    @status.setter
    def status(self, val: str) -> None:
        self._status = val

    @property
    def current_state_id(self) -> str:
        return self._current_state_id

    @current_state_id.setter
    def current_state_id(self, val: str) -> None:
        self._current_state_id = val

    @property
    def state_map(self) -> dict[str, dict[str, Any]]:
        return self._state_map

    @property
    def transitions_from(self) -> dict[str, list[dict[str, Any]]]:
        return self._transitions_from

    @property
    def graph(self) -> dict[str, Any]:
        return self._graph

    def get_return_value(self) -> tuple[Any, bool]:
        return (self._return_value, self._has_return_value)

    def set_return_value(self, value: Any) -> None:
        self._return_value = value
        self._has_return_value = True
        self._status = "completed"

    def eval_expr(self, expr: str) -> Any:
        translated = re.sub(r'\$ctx\b', 'ctx', expr)
        translated = re.sub(r'\$self\b', 'self_state', translated)
        return eval(translated, {"__builtins__": {}}, {"ctx": self._ctx, "self_state": self._self_ref})

    def expression_vars_are_defined(self, expr: str) -> bool:
        ctx_refs = re.findall(r'\$ctx\.(\w+)', expr)
        self_refs = re.findall(r'\$self\.(\w+)', expr)
        for prop in ctx_refs:
            if prop not in self._ctx:
                return False
        for prop in self_refs:
            if prop not in self._self_ref:
                return False
        return True

    def find_first_receive_in_branch(self, state_id: str) -> Optional[str]:
        current = state_id
        visited: set[str] = set()
        while current not in visited:
            visited.add(current)
            st = self._state_map.get(current)
            if st is None:
                return None
            if st["data"]["kind"] == "receive":
                return current
            trans = self._transitions_from.get(current, [])
            default = next((t for t in trans if t["label"]["kind"] == "default"), None)
            if default:
                current = default["to"]
            else:
                return None
        return None

    def find_join_for_fork(self, fork_id: str) -> Optional[str]:
        transitions = self._transitions_from.get(fork_id, [])
        branch_starts = [t["to"] for t in transitions if t["label"]["kind"] == "branch"]

        for start_id in branch_starts:
            current = start_id
            visited: set[str] = set()
            while current not in visited:
                visited.add(current)
                st = self._state_map.get(current)
                if st is None:
                    break
                if st["data"]["kind"] == "join":
                    return current
                trans = self._transitions_from.get(current, [])
                default = next((t for t in trans if t["label"]["kind"] == "default"), None)
                if default:
                    current = default["to"]
                else:
                    break
        return None

    def find_loop_exit(self, from_state_id: str) -> Optional[str]:
        visited: set[str] = set()
        queue = [from_state_id]
        while queue:
            sid = queue.pop(0)
            if sid in visited:
                continue
            visited.add(sid)
            for t in self._graph["transitions"]:
                if t["to"] == sid:
                    source_state = self._state_map.get(t["from"])
                    if (source_state and
                        source_state["data"]["kind"] == "guard" and
                        source_state["data"].get("guardType") == "expression"):
                        from_trans = self._transitions_from.get(t["from"], [])
                        else_trans = next((tr for tr in from_trans if tr["label"]["kind"] == "else"), None)
                        if else_trans:
                            return else_trans["to"]
                    queue.append(t["from"])
        return None

    def find_alternate_error_receive(self, current_recv_state: dict[str, Any]) -> Optional[dict[str, Any]]:
        if not self._catch_stack:
            return None

        for try_entry_id, catch_target_id in self._try_catch_map.items():
            try_default_recv_id = self.find_first_receive_in_branch(try_entry_id)
            if try_default_recv_id != current_recv_state["id"]:
                continue

            error_recv_id = self.find_first_receive_in_branch(catch_target_id)
            if error_recv_id:
                error_recv_state = self._state_map.get(error_recv_id)
                if error_recv_state and error_recv_state["data"]["kind"] == "receive":
                    return {
                        "stateId": error_recv_id,
                        "messageName": error_recv_state["data"]["messageName"],
                    }
        return None

    def follow_default(self) -> str:
        transitions = self._transitions_from.get(self._current_state_id, [])
        default = next((t for t in transitions if t["label"]["kind"] == "default"), None)
        if default:
            return default["to"]
        if transitions:
            return transitions[0]["to"]
        raise RuntimeError(f"No outgoing transition from state {self._current_state_id}")

    def assign_target(self, target: str, value: Any) -> None:
        if target.startswith("$ctx."):
            key = target[5:]
            self._ctx[key] = value

    def push_catch_target(self, target: str) -> None:
        self._catch_stack.append(target)

    def pop_catch_target(self) -> Optional[str]:
        return self._catch_stack.pop() if self._catch_stack else None

    def has_catch_targets(self) -> bool:
        return len(self._catch_stack) > 0

    def get_catch_target(self, state_id: str) -> Optional[str]:
        return self._try_catch_map.get(state_id)


def duration_to_ms(duration: dict[str, Any]) -> int:
    value = duration["value"]
    unit = duration.get("unit", "ms")
    if unit == "ms":
        return value
    if unit == "s":
        return value * 1000
    if unit == "m":
        return value * 60_000
    if unit == "h":
        return value * 3_600_000
    return value
