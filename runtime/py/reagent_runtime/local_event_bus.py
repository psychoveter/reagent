"""
LocalEventBus — in-process pub/sub for single-node event triggers (Python mirror).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class BusEvent:
    topic: str
    payload: dict[str, Any]
    source: Optional[dict[str, str]] = None
    ts: float = field(default_factory=lambda: time.time() * 1000)


class Disposable:
    def __init__(self, fn: Callable[[], None]) -> None:
        self._fn = fn

    def dispose(self) -> None:
        self._fn()


class LocalEventBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[Callable[[BusEvent], None]]] = {}
        self._wildcard_subs: set[Callable[[BusEvent], None]] = set()

    def publish(self, topic: str, event: BusEvent) -> None:
        handlers = self._subs.get(topic)
        if handlers:
            for h in list(handlers):
                h(event)
        for h in list(self._wildcard_subs):
            h(event)

    def subscribe(self, topic: str, handler: Callable[[BusEvent], None]) -> Disposable:
        if topic == "*":
            self._wildcard_subs.add(handler)
            return Disposable(lambda: self._wildcard_subs.discard(handler))
        subs = self._subs.setdefault(topic, set())
        subs.add(handler)

        def _dispose() -> None:
            subs.discard(handler)
            if not subs:
                self._subs.pop(topic, None)

        return Disposable(_dispose)

    def clear(self) -> None:
        self._subs.clear()
        self._wildcard_subs.clear()
