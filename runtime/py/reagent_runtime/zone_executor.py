"""
Zone Executor — runs raw Python zone bodies with $ctx, $self, reagent injected.

Zone bodies are raw Python code strings. We use exec() with a controlled namespace.
Variable names use $ in Reagent syntax, which is not valid Python, so we map:
  $ctx  -> ctx  (aliased in the exec namespace)
  $self -> self_state (aliased in the exec namespace)

Both ctx and self_state are wrapped in AttrDict so that attribute-style access
(ctx.msg.text) works alongside dict-style access (ctx["msg"]).
"""

from __future__ import annotations
from typing import Any, Callable
import re


class AttrDict(dict):
    """Dict subclass that supports attribute access.
    Nested dicts are auto-wrapped on read. Writes go directly to the dict."""

    def __getattr__(self, name: str) -> Any:
        try:
            val = self[name]
        except KeyError:
            return None
        if isinstance(val, dict) and not isinstance(val, AttrDict):
            wrapped = AttrDict(val)
            self[name] = wrapped
            return wrapped
        return val

    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value

    def __delattr__(self, name: str) -> None:
        try:
            del self[name]
        except KeyError:
            raise AttributeError(f"AttrDict has no attribute '{name}'")


class InvokeRequest(Exception):
    """Sentinel thrown when a zone calls reagent.invoke()."""
    def __init__(self, proto_name: str, input_data: dict[str, Any] | None = None):
        self.proto_name = proto_name
        self.input_data = input_data
        super().__init__(f"InvokeRequest({proto_name})")


class ReturnValue(Exception):
    """Sentinel thrown when a zone calls reagent.return()."""
    def __init__(self, value: Any):
        self.value = value
        super().__init__(f"ReturnValue({value})")


class BreakRequest(Exception):
    """Sentinel thrown when a zone calls reagent.break()."""
    pass


class ReagentStub:
    """Stub for the `reagent` object available in zone code.
    spawn and emit are set by ProtocolInstance to bound callbacks."""

    def emit(self, event_name: str, data: dict[str, Any] | None = None) -> None:
        pass

    def invoke(self, proto: Any = None, args: dict[str, Any] | None = None) -> Any:
        raise InvokeRequest(str(proto), args)

    def spawn(self, proto: Any = None, args: dict[str, Any] | None = None) -> None:
        pass

    def return_value(self, value: Any) -> None:
        raise ReturnValue(value)

    def break_loop(self) -> None:
        raise BreakRequest()


def _translate_dollar_vars(body: str) -> str:
    """Replace $ctx/$self with Python-safe names, reagent.return/break with
    Python methods, and basic JS literals/patterns with Python equivalents."""
    body = re.sub(r'\$ctx\b', 'ctx', body)
    body = re.sub(r'\$self\b', 'self_state', body)
    body = re.sub(r'\$agent\b', 'agent', body)
    body = re.sub(r'reagent\.return\b', 'reagent.return_value', body)
    body = re.sub(r'reagent\.break\b', 'reagent.break_loop', body)
    body = re.sub(r'===', '==', body)
    body = re.sub(r'!==', '!=', body)
    body = re.sub(r'\btrue\b', 'True', body)
    body = re.sub(r'\bfalse\b', 'False', body)
    body = re.sub(r'\bnull\b', 'None', body)
    body = re.sub(r'\bundefined\b', 'None', body)
    body = re.sub(r'\bconst\s+', '', body)
    body = re.sub(r'\blet\s+', '', body)
    body = re.sub(r'\bvar\s+', '', body)
    body = re.sub(r'\|\|', ' or ', body)
    body = re.sub(r'(?<!=)&&', ' and ', body)
    body = re.sub(r'\.push\(', '.append(', body)
    body = re.sub(r'\.length\b', '.__len__()', body)
    body = _translate_ternary(body)
    return body


def _translate_ternary(body: str) -> str:
    """Translate JS ternary `cond ? then : else` to Python `then if cond else else_`."""
    pattern = re.compile(
        r'([^=!<>:,;\n]+?)\s*\?\s*([^:]+?)\s*:\s*([^\n;,)]+)'
    )
    max_passes = 10
    for _ in range(max_passes):
        m = pattern.search(body)
        if not m:
            break
        cond, then, else_ = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
        body = body[:m.start()] + f"({then} if {cond} else {else_})" + body[m.end():]
    return body


class _DateStub:
    @staticmethod
    def now() -> float:
        import time
        return time.time() * 1000


_JS_COMPAT_BUILTINS: dict[str, Any] = {
    "Date": _DateStub,
    "console": type("Console", (), {"log": staticmethod(print)})(),
    "JSON": type("JSON", (), {
        "stringify": staticmethod(lambda x, *a: __import__("json").dumps(x)),
        "parse": staticmethod(lambda x: __import__("json").loads(x)),
    })(),
    "Math": __import__("math"),
}


def _dedent(body: str) -> str:
    """Remove common leading whitespace from all non-empty lines."""
    import textwrap
    return textwrap.dedent(body)


def execute_zone(
    body: str,
    ctx: dict[str, Any],
    self_state: dict[str, Any],
    reagent: ReagentStub,
    extras: dict[str, Any] | None = None,
) -> bool:
    """Execute a zone body string with ctx, self_state, reagent in scope."""
    translated = _dedent(_translate_dollar_vars(body))

    ctx_wrapper = AttrDict(ctx) if not isinstance(ctx, AttrDict) else ctx
    self_wrapper = AttrDict(self_state) if not isinstance(self_state, AttrDict) else self_state

    namespace: dict[str, Any] = {
        "ctx": ctx_wrapper,
        "self_state": self_wrapper,
        "reagent": reagent,
    }
    if extras:
        namespace.update(extras)
    exec(translated, {"__builtins__": __builtins__, **_JS_COMPAT_BUILTINS}, namespace)

    ctx.update(ctx_wrapper)
    self_state.update(self_wrapper)
    return True


async def execute_zone_async(
    body: str,
    ctx: dict[str, Any],
    self_state: dict[str, Any],
    reagent: ReagentStub,
    extras: dict[str, Any] | None = None,
) -> bool:
    """Async zone executor for zone bodies containing `await`."""
    import textwrap
    translated = _dedent(_translate_dollar_vars(body))

    ctx_wrapper = AttrDict(ctx) if not isinstance(ctx, AttrDict) else ctx
    self_wrapper = AttrDict(self_state) if not isinstance(self_state, AttrDict) else self_state

    namespace: dict[str, Any] = {
        "ctx": ctx_wrapper,
        "self_state": self_wrapper,
        "reagent": reagent,
        "__builtins__": __builtins__,
        **_JS_COMPAT_BUILTINS,
    }
    if extras:
        namespace.update(extras)

    wrapped = f"async def __zone__():\n{textwrap.indent(translated, '    ')}"
    exec(wrapped, namespace)
    await namespace["__zone__"]()

    ctx.update(ctx_wrapper)
    self_state.update(self_wrapper)
    return True
