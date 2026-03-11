"""
ResolvePolicyEvaluator — evaluates resolve pipelines against the agent registry.

Python mirror of runtime/ts/src/triggers/resolve-policy-evaluator.ts.
"""

from __future__ import annotations

import random
import re
from typing import Any, Callable, Optional

from .state_store_agent_registry import AgentRegistration, StateStoreAgentRegistry


class ResolveContext:
    __slots__ = ("trigger_id", "input")

    def __init__(self, trigger_id: Optional[str] = None, input: Optional[dict[str, Any]] = None):
        self.trigger_id = trigger_id
        self.input = input or {}


CustomResolvePolicy = Callable[[list[AgentRegistration], ResolveContext], list[AgentRegistration]]


class ResolvePolicyEvaluator:
    def __init__(self, registry: StateStoreAgentRegistry) -> None:
        self._registry = registry
        self._custom_policies: dict[str, CustomResolvePolicy] = {}
        self._round_robin_cursors: dict[str, int] = {}

    def register_custom_policy(self, name: str, impl: CustomResolvePolicy) -> None:
        self._custom_policies[name] = impl

    def evaluate(
        self,
        pipeline: list[dict[str, Any]],
        role: str,
        ctx: Optional[ResolveContext] = None,
        trigger_id: Optional[str] = None,
    ) -> list[AgentRegistration]:
        ctx = ctx or ResolveContext()
        candidates = self._registry.find_by_role(role)

        for step in pipeline:
            candidates = self._apply_step(step, candidates, role, ctx, trigger_id)

        return candidates

    def reset_round_robin(self, role: Optional[str] = None) -> None:
        if role:
            keys_to_del = [k for k in self._round_robin_cursors if k.startswith(f"rr:{role}:")]
            for k in keys_to_del:
                del self._round_robin_cursors[k]
        else:
            self._round_robin_cursors.clear()

    def _apply_step(
        self,
        step: dict[str, Any],
        candidates: list[AgentRegistration],
        role: str,
        ctx: ResolveContext,
        trigger_id: Optional[str],
    ) -> list[AgentRegistration]:
        kind = step["step"]

        if kind == "all":
            return self._registry.find_by_role(role)

        if kind == "single":
            by_role = self._registry.find_by_role(role)
            return by_role[:1]

        if kind == "from":
            return self._apply_from(step["expr"], ctx)

        if kind == "filter":
            return [a for a in candidates if self.evaluate_filter(step["predicate"], a)]

        if kind == "first":
            return candidates[:1]

        if kind == "random":
            return [random.choice(candidates)] if candidates else []

        if kind == "sample":
            count = min(step["count"], len(candidates))
            return random.sample(candidates, count) if candidates else []

        if kind == "roundRobin":
            if not candidates:
                return []
            key = f"rr:{role}:{trigger_id or 'default'}"
            cursor = self._round_robin_cursors.get(key, 0) % len(candidates)
            self._round_robin_cursors[key] = cursor + 1
            return [candidates[cursor]]

        if kind == "leastLoaded":
            return candidates[:1]

        if kind == "fallback":
            if candidates:
                return candidates
            fb = self._registry.find_by_role(role)
            for fb_step in step["chain"]:
                fb = self._apply_step(fb_step, fb, role, ctx, trigger_id)
            return fb

        if kind == "custom":
            impl = self._custom_policies.get(step["name"])
            return impl(candidates, ctx) if impl else candidates

        return candidates

    def _apply_from(self, expr: str, ctx: ResolveContext) -> list[AgentRegistration]:
        if expr.startswith("$ctx.input."):
            path = expr[len("$ctx.input."):]
            value = _get_nested(ctx.input, path)
            if isinstance(value, str):
                agent = self._registry.get(value)
                return [agent] if agent else []
            if isinstance(value, list):
                return [a for v in value if isinstance(v, str) and (a := self._registry.get(v))]
        return []

    def evaluate_filter(self, predicate: str, agent: AgentRegistration) -> bool:
        try:
            return _evaluate_filter_expr(predicate, agent)
        except Exception:
            return False


def _get_nested(obj: Optional[dict[str, Any]], path: str) -> Any:
    if obj is None:
        return None
    parts = path.split(".")
    current: Any = obj
    for part in parts:
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _evaluate_filter_expr(expr: str, agent: AgentRegistration) -> bool:
    trimmed = expr.strip()

    # Handle ||
    or_parts = _split_top_level(trimmed, "||")
    if len(or_parts) > 1:
        return any(_evaluate_filter_expr(p, agent) for p in or_parts)

    # Handle &&
    and_parts = _split_top_level(trimmed, "&&")
    if len(and_parts) > 1:
        return all(_evaluate_filter_expr(p, agent) for p in and_parts)

    # Handle !
    if trimmed.startswith("!"):
        return not _evaluate_filter_expr(trimmed[1:], agent)

    # Handle parentheses
    if trimmed.startswith("(") and trimmed.endswith(")"):
        return _evaluate_filter_expr(trimmed[1:-1], agent)

    # "value" in agent.tags/capabilities
    m = re.match(r'^"([^"]*)"\s+in\s+agent\.(tags|capabilities)$', trimmed)
    if m:
        value, field = m.group(1), m.group(2)
        if field == "tags":
            return value in agent.tags
        if field == "capabilities":
            return value in agent.capabilities
        return False

    # agent.labels.key == "value"
    m = re.match(r'^agent\.labels\.(\w+)\s*(==|!=)\s*"([^"]*)"$', trimmed)
    if m:
        key, op, val = m.group(1), m.group(2), m.group(3)
        actual = agent.labels.get(key, "")
        return (actual == val) if op == "==" else (actual != val)

    # agent.metadata.key <op> value
    m = re.match(r'^agent\.metadata\.(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)$', trimmed)
    if m:
        key, op, raw_val = m.group(1), m.group(2), m.group(3).strip()
        actual = agent.metadata.get(key)
        expected = _parse_value(raw_val)
        return _compare(actual, op, expected)

    # agent.name == "value"
    m = re.match(r'^agent\.name\s*(==|!=)\s*"([^"]*)"$', trimmed)
    if m:
        op, val = m.group(1), m.group(2)
        return (agent.name == val) if op == "==" else (agent.name != val)

    return False


def _split_top_level(expr: str, delimiter: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    current = ""
    in_str = False
    str_char = ""
    i = 0
    while i < len(expr):
        ch = expr[i]
        if in_str:
            current += ch
            if ch == str_char:
                in_str = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_str = True
            str_char = ch
            current += ch
            i += 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if depth == 0 and expr[i:].startswith(delimiter):
            parts.append(current.strip())
            current = ""
            i += len(delimiter)
            continue
        current += ch
        i += 1
    if current.strip():
        parts.append(current.strip())
    return parts


def _parse_value(raw: str) -> Any:
    if raw == "true":
        return True
    if raw == "false":
        return False
    if raw == "null":
        return None
    if raw.startswith('"') and raw.endswith('"'):
        return raw[1:-1]
    try:
        return float(raw) if "." in raw else int(raw)
    except ValueError:
        return raw


def _compare(actual: Any, op: str, expected: Any) -> bool:
    if op == "==":
        return actual == expected
    if op == "!=":
        return actual != expected
    if op == ">":
        return actual > expected  # type: ignore
    if op == "<":
        return actual < expected  # type: ignore
    if op == ">=":
        return actual >= expected  # type: ignore
    if op == "<=":
        return actual <= expected  # type: ignore
    return False
