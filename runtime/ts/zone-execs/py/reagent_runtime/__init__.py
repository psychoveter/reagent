"""Reagent `[py]` zone executor — RC virtual-language scaffolding.

This package contains the Python helper used by the TS Reagent Controller to
execute `[py]`-tagged zone bodies. It is intentionally minimal: there is no
parallel Python runtime, no agent runner, no transport — only the zone
executor primitives needed when a zone is tagged with `[py]`.
"""

from .zone_executor import (
    AttrDict,
    BreakRequest,
    InvokeRequest,
    ReagentStub,
    ReturnValue,
    execute_zone,
    execute_zone_async,
)

__all__ = [
    "AttrDict",
    "BreakRequest",
    "InvokeRequest",
    "ReagentStub",
    "ReturnValue",
    "execute_zone",
    "execute_zone_async",
]
