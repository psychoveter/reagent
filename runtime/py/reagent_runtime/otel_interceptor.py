"""
OTel interceptor and trace hook for the Python Reagent runtime.

Mirrors the TS otel-interceptor.ts + otel-trace-hook.ts.
Requires `opentelemetry-api` at runtime; falls back to no-op if not installed.
"""
from __future__ import annotations

from typing import Any, Callable, Optional

try:
    from opentelemetry import trace
    from opentelemetry.trace import StatusCode, SpanKind, Tracer, Span
    _HAS_OTEL = True
except ImportError:
    _HAS_OTEL = False

_instance_spans: dict[str, Any] = {}

TRACER_NAME_MESSAGES = "reagent.messages"
TRACER_NAME_TRACES = "reagent.traces"


def _get_tracer(name: str, tracer: Optional[Any] = None) -> Any:
    if tracer is not None:
        return tracer
    if _HAS_OTEL:
        return trace.get_tracer(name)
    return None


def end_instance_span(instance_id: str, error: Optional[str] = None) -> None:
    span = _instance_spans.pop(instance_id, None)
    if span is None:
        return
    if _HAS_OTEL:
        if error:
            span.set_status(StatusCode.ERROR, error)
        span.end()


def _get_or_create_instance_span(tracer: Any, instance_id: str, protocol_name: str) -> Any:
    root = _instance_spans.get(instance_id)
    if root is not None:
        return root
    if not _HAS_OTEL or tracer is None:
        return None
    root = tracer.start_span(
        f"protocol:{protocol_name}",
        kind=SpanKind.INTERNAL,
        attributes={
            "reagent.instance_id": instance_id,
            "reagent.protocol": protocol_name,
        },
    )
    _instance_spans[instance_id] = root
    return root


def create_otel_interceptor(tracer: Optional[Any] = None) -> Callable:
    """Return an InterceptorFn that creates OTel spans per message."""
    t = _get_tracer(TRACER_NAME_MESSAGES, tracer)

    def interceptor(ctx: Any, next_fn: Callable[[], None]) -> None:
        if not _HAS_OTEL or t is None:
            next_fn()
            return

        env = ctx.envelope
        parent_span = _get_or_create_instance_span(t, env["instanceId"], env["protocolName"])

        direction = ctx.direction
        span_kind = SpanKind.SERVER if direction == "inbound" else SpanKind.CLIENT

        parent_ctx = None
        if parent_span is not None:
            parent_ctx = trace.set_span_in_context(parent_span)

        span = t.start_span(
            f"{direction}:{env['messageName']}",
            kind=span_kind,
            attributes={
                "reagent.instance_id": env["instanceId"],
                "reagent.protocol": env["protocolName"],
                "reagent.message": env["messageName"],
                "reagent.direction": direction,
                "reagent.from.agent": env["from"]["agent"],
                "reagent.from.role": env["from"]["role"],
                "reagent.to.agent": env["to"]["agent"],
                "reagent.to.role": env["to"]["role"],
                "reagent.node_id": ctx.node_id,
            },
            context=parent_ctx,
        )
        try:
            next_fn()
        finally:
            span.end()

    return interceptor


def create_otel_trace_hook(tracer: Optional[Any] = None) -> Callable:
    """Return a trace hook callback that creates OTel spans per TraceEvent."""
    t = _get_tracer(TRACER_NAME_TRACES, tracer)

    def hook(event: dict[str, Any]) -> None:
        if not _HAS_OTEL or t is None:
            return

        attrs: dict[str, Any] = {
            "reagent.instance_id": event["instanceId"],
            "reagent.event_id": event["eventId"],
            "reagent.kind": event["kind"],
            "reagent.agent": event["agent"],
        }
        if event.get("role"):
            attrs["reagent.role"] = event["role"]
        if event.get("protocolName"):
            attrs["reagent.protocol"] = event["protocolName"]
        if event.get("cause"):
            attrs["reagent.cause"] = event["cause"]

        span = t.start_span(
            f"trace:{event['kind']}",
            kind=SpanKind.INTERNAL,
            attributes=attrs,
        )

        data = event.get("data") or {}
        for key, value in data.items():
            if isinstance(value, (str, int, float, bool)):
                span.set_attribute(f"reagent.data.{key}", value)

        if event["kind"] == "ProtocolFailed":
            error_msg = data.get("error", "unknown")
            span.set_status(StatusCode.ERROR, str(error_msg))
            end_instance_span(event["instanceId"], str(error_msg))
        elif event["kind"] == "ProtocolCompleted":
            end_instance_span(event["instanceId"])

        span.end()

    return hook
