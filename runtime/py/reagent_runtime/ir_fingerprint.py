"""
Reagent IR Fingerprint reader — M8a

Read-only module for extracting fingerprint data from compiled IR JSON.
No hashing logic here — the TS compiler computes all hashes.
"""

from __future__ import annotations

from typing import TypedDict, Optional


class ProtocolFingerprint(TypedDict):
    structureHash: str
    schemaHash: str
    implHash: str


class RoleFingerprint(TypedDict):
    playsHash: str
    behaviorHash: str


class ProtocolDependency(TypedDict):
    protocolName: str
    structureHash: str
    version: str


def read_protocol_fingerprint(ir_json: dict) -> Optional[ProtocolFingerprint]:
    """Extract protocol fingerprint from a compiled IRGraph JSON dict."""
    fp = ir_json.get("fingerprints")
    if fp is None:
        return None
    return ProtocolFingerprint(
        structureHash=fp["structureHash"],
        schemaHash=fp["schemaHash"],
        implHash=fp["implHash"],
    )


def read_protocol_version(ir_json: dict) -> Optional[str]:
    """Extract protocol version from a compiled IRGraph JSON dict."""
    return ir_json.get("version")


def read_protocol_dependencies(ir_json: dict) -> list[ProtocolDependency]:
    """Extract protocol dependencies from a compiled IRGraph JSON dict."""
    deps = ir_json.get("dependencies")
    if deps is None:
        return []
    return [
        ProtocolDependency(
            protocolName=d["protocolName"],
            structureHash=d["structureHash"],
            version=d["version"],
        )
        for d in deps
    ]


def read_role_fingerprint(role_json: dict) -> Optional[RoleFingerprint]:
    """Extract role fingerprint from a compiled RoleIR JSON dict."""
    fp = role_json.get("fingerprints")
    if fp is None:
        return None
    return RoleFingerprint(
        playsHash=fp["playsHash"],
        behaviorHash=fp["behaviorHash"],
    )


def read_role_version(role_json: dict) -> Optional[str]:
    """Extract role version from a compiled RoleIR JSON dict."""
    return role_json.get("version")
