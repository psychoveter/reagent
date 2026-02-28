"""
CronAgent — system agent that parses cron expressions and emits
cron.tick events to TriggerMatcher via the LocalEventBus (Python mirror).

Supports standard 5-field cron: minute hour dom month dow
Plus common aliases: @hourly, @daily, @weekly, @monthly
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Optional

from .local_event_bus import LocalEventBus, BusEvent

ALIASES: dict[str, str] = {
    "@yearly":   "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly":  "0 0 1 * *",
    "@weekly":   "0 0 * * 0",
    "@daily":    "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly":   "0 * * * *",
}

FIELD_RANGES = [
    (0, 59),  # minute
    (0, 23),  # hour
    (1, 31),  # day of month
    (1, 12),  # month
    (0, 6),   # day of week (0=Sun)
]


def parse_cron_field(field_str: str, lo: int, hi: int) -> set[int]:
    values: set[int] = set()
    for part in field_str.split(","):
        step = 1
        range_str = part
        if "/" in part:
            range_str, step_str = part.rsplit("/", 1)
            step = int(step_str)
        if range_str == "*":
            values.update(range(lo, hi + 1, step))
        elif "-" in range_str:
            a, b = range_str.split("-", 1)
            values.update(range(int(a), int(b) + 1, step))
        else:
            values.add(int(range_str))
    return values


def parse_cron_expression(expr: str) -> list[set[int]]:
    resolved = ALIASES.get(expr.strip().lower(), expr.strip())
    parts = resolved.split()
    if len(parts) != 5:
        raise ValueError(f'Invalid cron expression: "{expr}" — expected 5 fields, got {len(parts)}')
    return [parse_cron_field(p, FIELD_RANGES[i][0], FIELD_RANGES[i][1]) for i, p in enumerate(parts)]


def cron_matches_date(fields: list[set[int]], dt: datetime) -> bool:
    return (
        dt.minute in fields[0]
        and dt.hour in fields[1]
        and dt.day in fields[2]
        and dt.month in fields[3]
        and dt.weekday() in _sunday_zero(fields[4])
    )


def _sunday_zero(dow_set: set[int]) -> set[int]:
    """Python weekday() is 0=Mon. Cron is 0=Sun. Convert."""
    mapping = {0: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5}
    return {mapping.get(d, d) for d in dow_set}


def next_cron_fire(fields: list[set[int]], after: datetime) -> Optional[datetime]:
    """Find the next datetime after `after` that matches cron fields (up to 48h ahead)."""
    cursor = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = after.timestamp() + 48 * 3600
    while cursor.timestamp() < limit:
        if cron_matches_date(fields, cursor):
            return cursor
        cursor += timedelta(minutes=1)
    return None


@dataclass
class CronSchedule:
    id: str
    cron_expr: str
    fields: list[set[int]]
    protocol_name: str
    topic: str
    run_index: int = 0


class CronAgent:
    def __init__(self, bus: LocalEventBus) -> None:
        self._bus = bus
        self._schedules: list[CronSchedule] = []
        self._task: Optional[asyncio.Task[None]] = None
        self._last_tick_minute: int = -1

    def add_schedule(self, protocol_name: str, cron_expr: str) -> str:
        id_ = f"cron:{protocol_name}:{cron_expr}"
        fields = parse_cron_expression(cron_expr)
        topic = f"cron.tick.{protocol_name}"
        self._schedules.append(CronSchedule(id=id_, cron_expr=cron_expr, fields=fields, protocol_name=protocol_name, topic=topic, run_index=0))
        return id_

    def remove_schedule(self, id_: str) -> None:
        self._schedules = [s for s in self._schedules if s.id != id_]

    def start(self, interval_s: float = 15.0) -> None:
        if self._task:
            return

        async def _loop() -> None:
            while True:
                self.tick()
                await asyncio.sleep(interval_s)

        self._task = asyncio.ensure_future(_loop())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    def get_schedules(self) -> list[CronSchedule]:
        return list(self._schedules)

    def tick(self, now: Optional[datetime] = None) -> None:
        dt = now or datetime.now()
        minute_key = int(dt.timestamp()) // 60
        if minute_key == self._last_tick_minute:
            return
        self._last_tick_minute = minute_key

        for schedule in self._schedules:
            if cron_matches_date(schedule.fields, dt):
                schedule.run_index += 1
                next_fire = next_cron_fire(schedule.fields, dt)
                self._bus.publish(schedule.topic, BusEvent(
                    topic=schedule.topic,
                    payload={
                        "runIndex": schedule.run_index,
                        "firedAt": dt.isoformat(),
                        "nextFireAt": next_fire.isoformat() if next_fire else None,
                        "cronExpr": schedule.cron_expr,
                        "protocolName": schedule.protocol_name,
                    },
                    source={"agent": "system:cron", "instanceId": schedule.id},
                    ts=dt.timestamp() * 1000,
                ))
