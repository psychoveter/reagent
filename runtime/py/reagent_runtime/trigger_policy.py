"""
TriggerPolicy — runtime configuration for trigger behavior (Python mirror).
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class TriggerPolicy:
    enabled: bool = True
    max_concurrent: Optional[int] = None
    cooldown_ms: Optional[float] = None
    circuit_breaker: Optional[dict[str, Any]] = None  # failureThreshold, resetMs
    dedup: Optional[dict[str, Any]] = None  # windowMs


DEFAULT_TRIGGER_POLICY = TriggerPolicy()


@dataclass
class TriggerPolicyState:
    running_count: int = 0
    last_fired_at: float = 0
    circuit: str = "closed"  # "closed" | "open" | "half-open"
    consecutive_failures: int = 0
    circuit_opened_at: float = 0
    recent_payload_hashes: list[dict[str, Any]] = field(default_factory=list)


def evaluate_policy(
    policy: TriggerPolicy,
    state: TriggerPolicyState,
    payload_hash: str,
    now: float,
) -> Optional[str]:
    """Returns suppression reason or None if allowed."""
    if not policy.enabled:
        return "disabled"

    if policy.max_concurrent is not None and state.running_count >= policy.max_concurrent:
        return "max_concurrent"

    if policy.cooldown_ms is not None and (now - state.last_fired_at) < policy.cooldown_ms:
        return "cooldown"

    if policy.circuit_breaker:
        if state.circuit == "open":
            reset_ms = policy.circuit_breaker.get("resetMs", 60000)
            if now - state.circuit_opened_at >= reset_ms:
                state.circuit = "half-open"
            else:
                return "circuit_open"

    if policy.dedup:
        window_ms = policy.dedup.get("windowMs", 5000)
        cutoff = now - window_ms
        state.recent_payload_hashes = [e for e in state.recent_payload_hashes if e["ts"] >= cutoff]
        if any(e["hash"] == payload_hash for e in state.recent_payload_hashes):
            return "dedup"

    return None


def record_trigger_fired(state: TriggerPolicyState, payload_hash: str, now: float) -> None:
    state.running_count += 1
    state.last_fired_at = now
    state.recent_payload_hashes.append({"hash": payload_hash, "ts": now})


def record_trigger_completed(state: TriggerPolicyState, success: bool, policy: TriggerPolicy) -> None:
    state.running_count = max(0, state.running_count - 1)
    if success:
        state.consecutive_failures = 0
        if state.circuit == "half-open":
            state.circuit = "closed"
    else:
        state.consecutive_failures += 1
        if (
            policy.circuit_breaker
            and state.consecutive_failures >= policy.circuit_breaker.get("failureThreshold", 5)
        ):
            state.circuit = "open"
            state.circuit_opened_at = time.time() * 1000
