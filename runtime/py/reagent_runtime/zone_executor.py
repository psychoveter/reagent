"""
Zone Executor — runs raw Python zone bodies with $ctx, $self, reagent injected.

Zone bodies are raw Python code strings. We use exec() with a controlled namespace.
Variable names use $ in Reagent syntax, which is not valid Python, so we map:
  $ctx  -> ctx  (aliased in the exec namespace)
  $self -> self_state (aliased in the exec namespace)
"""

from __future__ import annotations
from typing import Any, Callable
import re


class ReagentStub:
    """Stub for the `reagent` object available in zone code."""

    def emit(self, event_name: str, data: dict[str, Any] | None = None) -> None:
        print(f"[reagent.emit] {event_name} {data or ''}")

    def invoke(self, proto: Any = None, args: dict[str, Any] | None = None) -> Any:
        print("[reagent.invoke] stub — not implemented in test runtime")
        return {}

    def spawn(self, proto: Any = None, args: dict[str, Any] | None = None) -> None:
        print("[reagent.spawn] stub — not implemented in test runtime")

    def return_value(self, value: Any) -> None:
        print("[reagent.return] stub — not implemented in test runtime")


def _translate_dollar_vars(body: str) -> str:
    """Replace $ctx and $self with Python-safe names."""
    body = re.sub(r'\$ctx\b', 'ctx', body)
    body = re.sub(r'\$self\b', 'self_state', body)
    return body


def execute_zone(
    body: str,
    ctx: dict[str, Any],
    self_state: dict[str, Any],
    reagent: ReagentStub,
    extras: dict[str, Any] | None = None,
) -> bool:
    """Execute a zone body string with ctx, self_state, reagent in scope."""
    try:
        translated = _translate_dollar_vars(body)
        namespace: dict[str, Any] = {
            "ctx": ctx,
            "self_state": self_state,
            "reagent": reagent,
        }
        if extras:
            namespace.update(extras)
        exec(translated, {"__builtins__": __builtins__}, namespace)
        return True
    except Exception as e:
        print(f"[zone-executor] Error executing zone: {e}")
        return False
