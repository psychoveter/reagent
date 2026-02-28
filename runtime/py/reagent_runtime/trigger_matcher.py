"""
TriggerMatcher — loads TriggerIR from ProtocolRegistry and builds a match table (Python mirror).

Embedded in ReagentController. On startup it reads compiled TriggerIR metadata
from deployed protocols and registers invoke, event, and cron triggers.
"""

from __future__ import annotations

import json
import uuid
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .local_event_bus import LocalEventBus, BusEvent, Disposable
from .cron_agent import CronAgent
from .trigger_policy import (
    TriggerPolicy,
    TriggerPolicyState,
    DEFAULT_TRIGGER_POLICY,
    evaluate_policy,
    record_trigger_fired,
    record_trigger_completed,
)
from .types import create_trace_event

# avoid circular import
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from .protocol_registry import ProtocolRegistry, ProtocolEntry


@dataclass
class TriggerEntry:
    id: str
    protocol_name: str
    trigger: dict[str, Any]
    initiator_agent: str
    policy: TriggerPolicy
    policy_state: TriggerPolicyState


TriggerCallback = Callable[[str, dict[str, Any]], None]
TraceCallback = Callable[[dict[str, Any]], None]


class TriggerMatcher:
    def __init__(
        self,
        registry: ProtocolRegistry,
        bus: LocalEventBus,
        cron: CronAgent,
        trigger_callback: TriggerCallback,
        trace_callback: Optional[TraceCallback] = None,
        resolve_initiator: Optional[Callable[[str], Optional[str]]] = None,
        resolve_role_to_agent: Optional[Callable[[str], dict[str, str]]] = None,
    ) -> None:
        self._registry = registry
        self._bus = bus
        self._cron = cron
        self._trigger_cb = trigger_callback
        self._trace_cb = trace_callback
        self._resolve_initiator = resolve_initiator or (lambda _: None)
        self._resolve_role_to_agent = resolve_role_to_agent or (lambda _: {})

        self._invoke_triggers: dict[str, TriggerEntry] = {}
        self._event_triggers: list[tuple[TriggerEntry, Disposable]] = []
        self._cron_triggers: list[tuple[TriggerEntry, str, Optional[Disposable]]] = []
        self._policies: dict[str, TriggerPolicy] = {}

    # ── Policy configuration ──────────────────────────────────────────

    def set_policy(self, trigger_id: str, policy: TriggerPolicy) -> None:
        self._policies[trigger_id] = policy
        for entry in self._all_entries():
            if entry.id == trigger_id:
                entry.policy = policy
                break

    def set_policies(self, mapping: dict[str, TriggerPolicy]) -> None:
        for id_, policy in mapping.items():
            self.set_policy(id_, policy)

    # ── Build match table ────────────────────────────────────────────

    def build_match_table(self) -> None:
        self._clear_subscriptions()
        for entry in self._registry.list():
            self.register_protocol_triggers(entry)

    def register_protocol_triggers(self, proto_entry: ProtocolEntry) -> None:
        for trigger in proto_entry.triggers:
            kind = trigger.get("kind")
            id_ = self._make_trigger_id(proto_entry.name, trigger)
            initiator = self._resolve_initiator(proto_entry.name)
            if not initiator:
                self._emit_trace(proto_entry.name, "TriggerSuppressed", {
                    "triggerId": id_, "reason": "no_initiator", "triggerKind": kind,
                })
                continue

            policy = self._policies.get(id_, DEFAULT_TRIGGER_POLICY)
            pstate = TriggerPolicyState()
            base = TriggerEntry(
                id=id_, protocol_name=proto_entry.name, trigger=trigger,
                initiator_agent=initiator, policy=policy, policy_state=pstate,
            )

            if kind == "invoke":
                self._invoke_triggers[proto_entry.name] = base
            elif kind == "event":
                topic = trigger.get("topic", "")
                sub = self._bus.subscribe(topic, lambda ev, _pn=proto_entry.name, _t=trigger, _b=base: self._handle_event_trigger(_pn, _t, _b, ev))
                self._event_triggers.append((base, sub))
            elif kind == "cron":
                cron_expr = trigger.get("cron", "")
                schedule_id = self._cron.add_schedule(proto_entry.name, cron_expr)
                cron_topic = f"cron.tick.{proto_entry.name}"
                sub = self._bus.subscribe(cron_topic, lambda ev, _pn=proto_entry.name, _t=trigger, _b=base: self._handle_cron_trigger(_pn, _t, _b, ev))
                self._cron_triggers.append((base, schedule_id, sub))

    # ── Invoke trigger dispatch ──────────────────────────────────────

    def match_invoke_trigger(self, protocol_name: str, input_data: Optional[dict[str, Any]] = None) -> bool:
        entry = self._invoke_triggers.get(protocol_name)
        if not entry:
            return False
        resolved = self._build_input(input_data or {}, entry.trigger.get("inputExpr"))
        return self._fire_trigger(entry, resolved)

    def is_invocable(self, protocol_name: str) -> bool:
        if protocol_name in self._invoke_triggers:
            return True
        proto = self._registry.get(protocol_name)
        return proto is not None and proto.invocable

    # ── Event/Cron handlers ──────────────────────────────────────────

    def _handle_event_trigger(
        self, protocol_name: str, trigger: dict[str, Any], entry: TriggerEntry, event: BusEvent,
    ) -> None:
        raw = dict(event.payload) if event.payload else {}
        input_data = self._build_input(raw, trigger.get("inputExpr"))
        self._fire_trigger(entry, input_data)

    def _handle_cron_trigger(
        self, protocol_name: str, trigger: dict[str, Any], entry: TriggerEntry, event: BusEvent,
    ) -> None:
        raw = dict(event.payload) if event.payload else {}
        input_data = self._build_input(raw, trigger.get("inputExpr"))
        self._fire_trigger(entry, input_data)

    # ── Common fire logic ────────────────────────────────────────────

    def _fire_trigger(self, entry: TriggerEntry, input_data: dict[str, Any]) -> bool:
        now = time.time() * 1000
        payload_hash = self._hash_payload(input_data)
        suppression = evaluate_policy(entry.policy, entry.policy_state, payload_hash, now)
        if suppression:
            self._emit_trace(entry.protocol_name, "TriggerSuppressed", {
                "triggerId": entry.id, "reason": suppression,
                "triggerKind": entry.trigger.get("kind"), "payload": input_data,
            })
            return False

        record_trigger_fired(entry.policy_state, payload_hash, now)
        instance_id = str(uuid.uuid4())
        role_to_agent = self._resolve_role_to_agent(entry.protocol_name)

        self._emit_trace(entry.protocol_name, "TriggerMatched", {
            "triggerId": entry.id, "triggerKind": entry.trigger.get("kind"),
            "instanceId": instance_id, "initiator": entry.initiator_agent,
        })

        self._trigger_cb(entry.initiator_agent, {
            "instanceId": instance_id,
            "protocolName": entry.protocol_name,
            "input": input_data,
            "roleToAgent": role_to_agent,
        })
        return True

    # ── Completion callback (for policy tracking) ────────────────────

    def report_trigger_completed(self, protocol_name: str, success: bool) -> None:
        for entry in self._all_entries():
            if entry.protocol_name == protocol_name:
                record_trigger_completed(entry.policy_state, success, entry.policy)

    # ── Input builder (two-step: raw data → optional transform) ─────

    @staticmethod
    def _build_input(raw_input: dict[str, Any], input_expr: Optional[str] = None) -> dict[str, Any]:
        if not input_expr:
            return raw_input
        try:
            ctx = {"input": raw_input}
            return eval(input_expr, {"__builtins__": {}}, {"$ctx": ctx})  # noqa: S307
        except Exception:
            return raw_input

    # ── Helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _make_trigger_id(protocol_name: str, trigger: dict[str, Any]) -> str:
        kind = trigger.get("kind", "")
        if kind == "invoke":
            return f"trigger:invoke:{protocol_name}"
        elif kind == "event":
            return f"trigger:event:{protocol_name}:{trigger.get('topic', '')}"
        elif kind == "cron":
            return f"trigger:cron:{protocol_name}:{trigger.get('cron', '')}"
        return f"trigger:{kind}:{protocol_name}"

    @staticmethod
    def _hash_payload(input_data: dict[str, Any]) -> str:
        try:
            return json.dumps(input_data, sort_keys=True, default=str)
        except Exception:
            return ""

    def _emit_trace(self, protocol_name: str, kind: str, data: dict[str, Any]) -> None:
        if not self._trace_cb:
            return
        self._trace_cb(create_trace_event(
            "system", kind, "system:trigger-matcher",
            protocol_name=protocol_name, data=data,
        ))

    def _all_entries(self) -> list[TriggerEntry]:
        entries = list(self._invoke_triggers.values())
        entries.extend(e for e, _ in self._event_triggers)
        entries.extend(e for e, _, _ in self._cron_triggers)
        return entries

    def _clear_subscriptions(self) -> None:
        for _, sub in self._event_triggers:
            sub.dispose()
        for _, schedule_id, sub in self._cron_triggers:
            self._cron.remove_schedule(schedule_id)
            if sub:
                sub.dispose()
        self._invoke_triggers.clear()
        self._event_triggers.clear()
        self._cron_triggers.clear()

    # ── Introspection ────────────────────────────────────────────────

    @property
    def invoke_triggers(self) -> dict[str, TriggerEntry]:
        return dict(self._invoke_triggers)

    @property
    def event_triggers(self) -> list[TriggerEntry]:
        return [e for e, _ in self._event_triggers]

    @property
    def cron_triggers(self) -> list[TriggerEntry]:
        return [e for e, _, _ in self._cron_triggers]

    def destroy(self) -> None:
        self._clear_subscriptions()
        self._cron.stop()
