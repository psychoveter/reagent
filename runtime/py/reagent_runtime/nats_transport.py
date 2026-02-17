"""
NATS Transport — wraps nats-py connection with Reagent subject conventions.
"""

from __future__ import annotations
import asyncio
import json
from typing import Any, Callable, Awaitable

import nats
from nats.aio.client import Client as NatsClient
from nats.aio.subscription import Subscription


class NatsTransport:
    def __init__(self, nats_url: str) -> None:
        self._nats_url = nats_url
        self._nc: NatsClient | None = None
        self._subs: list[Subscription] = []

    async def connect(self) -> None:
        self._nc = await nats.connect(self._nats_url)

    async def close(self) -> None:
        if self._nc:
            await self._nc.drain()

    def publish(self, subject: str, data: Any) -> None:
        if not self._nc:
            raise RuntimeError("Not connected")
        payload = json.dumps(data).encode("utf-8")
        asyncio.get_event_loop().create_task(self._nc.publish(subject, payload))

    async def publish_async(self, subject: str, data: Any) -> None:
        if not self._nc:
            raise RuntimeError("Not connected")
        payload = json.dumps(data).encode("utf-8")
        await self._nc.publish(subject, payload)

    async def subscribe(
        self, subject: str, handler: Callable[[Any, str], Awaitable[None] | None]
    ) -> Subscription:
        if not self._nc:
            raise RuntimeError("Not connected")

        sub = await self._nc.subscribe(subject)
        self._subs.append(sub)

        async def _reader() -> None:
            async for msg in sub.messages:
                try:
                    parsed = json.loads(msg.data.decode("utf-8"))
                    result = handler(parsed, msg.subject)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception as e:
                    print(f"[nats-transport] Error processing message on {msg.subject}: {e}")

        asyncio.get_event_loop().create_task(_reader())
        return sub

    @property
    def connection(self) -> NatsClient:
        if not self._nc:
            raise RuntimeError("Not connected")
        return self._nc
