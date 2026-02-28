"""
StateStoreAgentRegistry — agent registry backed by StateStore.

Python mirror of runtime/ts/src/state-store-agent-registry.ts.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .state_store import StateStore, Disposable, WatchEvent

AGENTS_PREFIX = "/agents/"


@dataclass
class AgentRegistration:
    name: str
    role: str
    tags: list[str] = field(default_factory=list)
    capabilities: list[str] = field(default_factory=list)
    labels: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


class StateStoreAgentRegistry:
    def __init__(self, store: StateStore) -> None:
        self._store = store
        self._cache: dict[str, AgentRegistration] = {}
        self._change_listeners: list[Callable[[str, Optional[AgentRegistration]], None]] = []
        self._watcher = store.watch(AGENTS_PREFIX, self._handle_watch)

    async def register(self, agent: AgentRegistration) -> None:
        key = AGENTS_PREFIX + agent.name
        data = json.dumps({
            "name": agent.name,
            "role": agent.role,
            "tags": agent.tags,
            "capabilities": agent.capabilities,
            "labels": agent.labels,
            "metadata": agent.metadata,
        })
        await self._store.put(key, data)
        self._cache[agent.name] = agent

    async def deregister(self, name: str) -> bool:
        key = AGENTS_PREFIX + name
        deleted = await self._store.delete(key)
        if deleted:
            self._cache.pop(name, None)
        return deleted

    def get(self, name: str) -> Optional[AgentRegistration]:
        return self._cache.get(name)

    def find_by_role(self, role: str) -> list[AgentRegistration]:
        return [a for a in self._cache.values() if a.role == role]

    def all(self) -> list[AgentRegistration]:
        return list(self._cache.values())

    def on_changed(self, cb: Callable[[str, Optional[AgentRegistration]], None]) -> Disposable:
        self._change_listeners.append(cb)
        return Disposable(lambda: self._change_listeners.remove(cb) if cb in self._change_listeners else None)

    async def load_from_store(self) -> None:
        entries = await self._store.list(AGENTS_PREFIX)
        self._cache.clear()
        for entry in entries:
            try:
                data = json.loads(entry.value)
                agent = AgentRegistration(
                    name=data["name"],
                    role=data["role"],
                    tags=data.get("tags", []),
                    capabilities=data.get("capabilities", []),
                    labels=data.get("labels", {}),
                    metadata=data.get("metadata", {}),
                )
                self._cache[agent.name] = agent
            except (json.JSONDecodeError, KeyError):
                pass

    def dispose(self) -> None:
        self._watcher.dispose()
        self._change_listeners.clear()

    def _handle_watch(self, event: WatchEvent) -> None:
        name = event.key[len(AGENTS_PREFIX):]
        if not name:
            return

        if event.kind == "put" and event.value is not None:
            try:
                data = json.loads(event.value)
                agent = AgentRegistration(
                    name=data["name"],
                    role=data["role"],
                    tags=data.get("tags", []),
                    capabilities=data.get("capabilities", []),
                    labels=data.get("labels", {}),
                    metadata=data.get("metadata", {}),
                )
                self._cache[name] = agent
                for cb in self._change_listeners:
                    cb(name, agent)
            except (json.JSONDecodeError, KeyError):
                pass
        elif event.kind == "delete":
            self._cache.pop(name, None)
            for cb in self._change_listeners:
                cb(name, None)
