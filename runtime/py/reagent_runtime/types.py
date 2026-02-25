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
