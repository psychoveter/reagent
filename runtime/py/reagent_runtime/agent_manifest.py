"""
Agent manifest (agent.json) — defines an agent's identity, role binding,
native module, and static config.

Format:
  { "name": "alice", "role": "GreeterRole", "module": "./impl.py", "config": { ... } }
"""

from __future__ import annotations

import importlib.util
import json
import os
from typing import Any, Optional


class AgentManifest:
    __slots__ = ("name", "role", "module", "config")

    def __init__(self, name: str, role: str, module: Optional[str] = None, config: Optional[dict[str, Any]] = None):
        self.name = name
        self.role = role
        self.module = module
        self.config = config or {}


def load_agent_manifest(manifest_path: str) -> AgentManifest:
    if not os.path.exists(manifest_path):
        raise FileNotFoundError(f"Agent manifest not found: {manifest_path}")
    with open(manifest_path) as f:
        raw = json.load(f)
    _validate(raw, manifest_path)
    return AgentManifest(
        name=raw["name"],
        role=raw["role"],
        module=raw.get("module"),
        config=raw.get("config"),
    )


def _validate(raw: Any, path: str) -> None:
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: expected JSON object")
    if not isinstance(raw.get("name"), str) or not raw["name"]:
        raise ValueError(f'{path}: "name" is required (string)')
    if not isinstance(raw.get("role"), str) or not raw["role"]:
        raise ValueError(f'{path}: "role" is required (string)')
    if "module" in raw and not isinstance(raw["module"], str):
        raise ValueError(f'{path}: "module" must be a string path')


def load_agent_module(manifest_path: str, manifest: AgentManifest) -> Optional[dict[str, Any]]:
    """Load the native module and return its exported object as $agent."""
    if not manifest.module:
        return None

    base_dir = os.path.dirname(os.path.abspath(manifest_path))
    module_path = os.path.normpath(os.path.join(base_dir, manifest.module))

    spec = importlib.util.spec_from_file_location("_agent_module", module_path)
    if not spec or not spec.loader:
        raise ImportError(f"Cannot load agent module: {module_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    exported = getattr(mod, "default", None)
    if exported is None:
        exported = {k: getattr(mod, k) for k in dir(mod) if not k.startswith("_")}

    if callable(exported):
        return exported(manifest.config)
    return exported
