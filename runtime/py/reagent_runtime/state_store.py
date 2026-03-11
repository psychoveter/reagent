"""
StateStore — abstract key-value interface for all Reagent runtime state.

Python mirror of runtime/ts/src/cluster/state-store.ts.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class StoreEntry:
    key: str
    value: str


@dataclass
class WatchEvent:
    kind: str  # "put" | "delete"
    key: str
    value: Optional[str] = None


class Disposable:
    def __init__(self, dispose_fn: Callable[[], None]):
        self._dispose = dispose_fn

    def dispose(self) -> None:
        self._dispose()


@dataclass
class Lease:
    id: str
    keep_alive: Callable[[], None]
    revoke: Callable[[], None]


class StateStore(ABC):
    @abstractmethod
    async def get(self, key: str) -> Optional[str]:
        ...

    @abstractmethod
    async def put(self, key: str, value: str, *, lease_id: Optional[str] = None) -> None:
        ...

    @abstractmethod
    async def delete(self, key: str) -> bool:
        ...

    @abstractmethod
    async def list(self, prefix: str) -> list[StoreEntry]:
        ...

    @abstractmethod
    async def put_if_absent(self, key: str, value: str, *, lease_id: Optional[str] = None) -> bool:
        ...

    @abstractmethod
    def watch(self, prefix: str, cb: Callable[[WatchEvent], None]) -> Disposable:
        ...

    @abstractmethod
    async def create_lease(self, ttl_seconds: float) -> Lease:
        ...

    @abstractmethod
    async def close(self) -> None:
        ...


class InMemoryStateStore(StateStore):
    def __init__(self) -> None:
        self._data: dict[str, str] = {}
        self._watchers: list[tuple[str, Callable[[WatchEvent], None]]] = []
        self._leases: dict[str, _LeaseRecord] = {}
        self._key_to_lease: dict[str, str] = {}
        self._lease_counter = 0

    async def get(self, key: str) -> Optional[str]:
        return self._data.get(key)

    async def put(self, key: str, value: str, *, lease_id: Optional[str] = None) -> None:
        self._data[key] = value
        if lease_id and lease_id in self._leases:
            self._leases[lease_id].keys.add(key)
            self._key_to_lease[key] = lease_id
        self._emit(WatchEvent(kind="put", key=key, value=value))

    async def delete(self, key: str) -> bool:
        if key not in self._data:
            return False
        del self._data[key]
        lid = self._key_to_lease.pop(key, None)
        if lid and lid in self._leases:
            self._leases[lid].keys.discard(key)
        self._emit(WatchEvent(kind="delete", key=key))
        return True

    async def list(self, prefix: str) -> list[StoreEntry]:
        result = [StoreEntry(key=k, value=v) for k, v in self._data.items() if k.startswith(prefix)]
        result.sort(key=lambda e: e.key)
        return result

    async def put_if_absent(self, key: str, value: str, *, lease_id: Optional[str] = None) -> bool:
        if key in self._data:
            return False
        await self.put(key, value, lease_id=lease_id)
        return True

    def watch(self, prefix: str, cb: Callable[[WatchEvent], None]) -> Disposable:
        entry = (prefix, cb)
        self._watchers.append(entry)
        return Disposable(lambda: self._watchers.remove(entry) if entry in self._watchers else None)

    async def create_lease(self, ttl_seconds: float) -> Lease:
        self._lease_counter += 1
        lid = f"lease_{self._lease_counter}"
        record = _LeaseRecord(id=lid, ttl=ttl_seconds, keys=set(), task=None)
        self._leases[lid] = record
        record.task = asyncio.get_event_loop().call_later(ttl_seconds, lambda: self._expire_lease(lid))

        def keep_alive() -> None:
            r = self._leases.get(lid)
            if r and r.task:
                r.task.cancel()
                r.task = asyncio.get_event_loop().call_later(r.ttl, lambda: self._expire_lease(lid))

        def revoke() -> None:
            self._expire_lease(lid)

        return Lease(id=lid, keep_alive=keep_alive, revoke=revoke)

    async def close(self) -> None:
        for lid in list(self._leases):
            self._expire_lease(lid)
        self._watchers.clear()

    def _emit(self, event: WatchEvent) -> None:
        for prefix, cb in self._watchers:
            if event.key.startswith(prefix):
                cb(event)

    def _expire_lease(self, lid: str) -> None:
        record = self._leases.pop(lid, None)
        if not record:
            return
        if record.task:
            record.task.cancel()
        for key in list(record.keys):
            self._data.pop(key, None)
            self._key_to_lease.pop(key, None)
            self._emit(WatchEvent(kind="delete", key=key))


@dataclass
class _LeaseRecord:
    id: str
    ttl: float
    keys: set[str]
    task: Any = None
