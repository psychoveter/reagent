"""
Reagent Runtime types — Python mirror of the TypeScript types.

Mirrors:
  - lang/src/ir.ts (IRGraph, AgentIR)
  - runtime/shared/protocol.ts (MessageEnvelope, TraceEvent)
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Optional
import uuid
import time


def normalize_role_binding_value(value: Any, preferred_cardinality: Optional[str] = None) -> dict[str, Any]:
    if isinstance(value, dict) and "cardinality" in value and "agents" in value:
        agents = list(dict.fromkeys([a for a in value.get("agents", []) if a]))
        return {"cardinality": value["cardinality"], "agents": agents}
    if isinstance(value, str):
        return {
            "cardinality": preferred_cardinality or "single",
            "agents": [value] if value else [],
        }
    if isinstance(value, list):
        agents = list(dict.fromkeys([a for a in value if isinstance(a, str) and a]))
        return {
            "cardinality": preferred_cardinality or ("single" if len(agents) <= 1 else "many"),
            "agents": agents,
        }
    return {"cardinality": preferred_cardinality or "single", "agents": []}


def normalize_role_bindings(source: Optional[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    normalized: dict[str, dict[str, Any]] = {}
    if not source:
        return normalized
    for key, value in source.items():
        if value is None:
            continue
        normalized[key] = normalize_role_binding_value(value)
    return normalized


def resolve_role_binding(source: dict[str, dict[str, Any]], protocol_name: str, role_name: str) -> Optional[dict[str, Any]]:
    return source.get(f"{protocol_name}.{role_name}")


def resolve_single_role_binding(source: dict[str, dict[str, Any]], protocol_name: str, role_name: str) -> Optional[str]:
    binding = resolve_role_binding(source, protocol_name, role_name)
    if not binding:
        return None
    if binding.get("cardinality") == "many":
        return None
    agents = binding.get("agents") or []
    return agents[0] if agents else None


# ── Subject helpers ──────────────────────────────────────────────────

def msg_subject(instance_id: str, to_agent: str, message_name: str) -> str:
    return f"reagent.msg.{instance_id}.{to_agent}.{message_name}"


def msg_subscribe_pattern(agent_name: str) -> str:
    return f"reagent.msg.*.{agent_name}.>"


def trace_subject(instance_id: str) -> str:
    return f"reagent.trace.{instance_id}"


def trace_subscribe_all() -> str:
    return "reagent.trace.>"


def trigger_subject(agent_name: str) -> str:
    return f"reagent.trigger.{agent_name}"


# ── Message Envelope ─────────────────────────────────────────────────

def create_message_envelope(
    instance_id: str,
    protocol_name: str,
    from_agent: str,
    from_role: str,
    to_agent: str,
    to_role: str,
    message_name: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "instanceId": instance_id,
        "protocolName": protocol_name,
        "from": {"agent": from_agent, "role": from_role},
        "to": {"agent": to_agent, "role": to_role},
        "messageName": message_name,
        "payload": payload,
        "ts": int(time.time() * 1000),
        "idempotencyKey": str(uuid.uuid4()),
    }


# ── Trace Events ─────────────────────────────────────────────────────

def create_trace_event(
    instance_id: str,
    kind: str,
    agent: str,
    *,
    role: Optional[str] = None,
    protocol_name: Optional[str] = None,
    data: Optional[dict[str, Any]] = None,
    cause: Optional[str] = None,
) -> dict[str, Any]:
    return {
        "instanceId": instance_id,
        "eventId": str(uuid.uuid4()),
        "kind": kind,
        "ts": int(time.time() * 1000),
        "agent": agent,
        "role": role,
        "protocolName": protocol_name,
        "data": data,
        "cause": cause,
    }
