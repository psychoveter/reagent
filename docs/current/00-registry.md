# Reagent Current Docs Registry

This directory is the canonical, current-state documentation set for Reagent.
It is intentionally organized as a numbered reading order rather than as a flat topic dump.

## Status

- TypeScript is the only first-class runtime today (Reagent Controller, AgentShell, BehaviorFactory layer).
- The parallel Python runtime has been retired; only the `[py]`-zone executor remains as RC virtual-language scaffolding under `runtime/ts/zone-execs/py/`.
- `runtime/ts/src` is organized into explicit layer folders (see below).
- The language layer remains stable; `LangTag` (including `"py"`) is preserved at the syntax/IR level even though only `[ts]` zones are natively executable on the TS RC today.
- The future Rust Release Candidate (with a Python host model based on PyO3 / equivalent FFI) is tracked in [`docs/future/`](../future/).

## Recommended Reading Order

| Doc | Purpose |
|---|---|
| [`01-user-guide.md`](01-user-guide.md) | How to create, build, run, debug, and deploy Reagent projects |
| [`02-lang-spec.md`](02-lang-spec.md) | Current language surface and runtime-facing semantics |
| [`03-runtime-core.md`](03-runtime-core.md) | Node-local runtime model: RC, protocol execution, triggers, nodes |
| [`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md) | Cluster state, message plane, AdminClient, MCP gate, and runtime config boundary |
| [`05-versioning-and-reconcile.md`](05-versioning-and-reconcile.md) | Fingerprints, registry, desired state, and reconciliation |
| [`06-tooling-overview.md`](06-tooling-overview.md) | IDE tooling, diagrams, debug UX, control-plane lifecycle, observability |
| [`07-lsp.md`](07-lsp.md) | Reagent language server architecture, current features, and backlog |
| [`08-test-spec.md`](08-test-spec.md) | Test inventory, execution surface, and known gaps |
| [`09-e2e-usecases.md`](09-e2e-usecases.md) | Representative end-to-end use cases spanning managed, cluster, MCP, custom, and hybrid runtime shapes |

## Current Runtime Reality

### TypeScript runtime

`runtime/ts/src` is split into explicit layers:

- `contracts/` for shared runtime interfaces, R1 ontology types, and wire-level types
- `core/` for protocol execution primitives (`RoleEngine`, `RoleRun`, `AgentShell`, zone executor, scatter coordinator)
- `controller/` for `ReagentController` and runtime registry logic
- `nodes/` for `BehaviorFactory` implementations: `nodes/managed/`, `nodes/claude/`, `nodes/gate/` (Message Gate session and transport support), and `nodes/mcp/` (MCP-facing adapter and server code), plus the `custom-behavior-factory.ts` entry point
- `cluster/` for state store, membership, leader election, and runtime bootstrap
- `triggers/` for trigger matching, cron, and resolve policy evaluation
- `network/` for `NodeLink` implementations and legacy NATS transport compatibility
- `admin/` for admin server, remote node, debug, registry view, and reconciler
- `observability/` for OTel hooks
- `support/` for runtime support utilities such as agent manifest loading

The root of `runtime/ts/src` keeps only true entrypoints and package surface files:

- `index.ts` — package surface
- `main.ts` — RC bootstrap entrypoint
- `rgctl.ts` — `rgctl` CLI binary (deploy, inspect, debug)

Note: there is no top-level `gate/` or `mcp/` directory; both live under `nodes/`.
This matches the layer description in [`03-runtime-core.md`](03-runtime-core.md) §2.

### `[py]` zone executor (RC virtual-language scaffolding)

`runtime/ts/zone-execs/py/reagent_runtime/zone_executor.py` is a self-contained Python helper invoked by the TS RC to execute `[py]`-tagged zone bodies (sync and async). It is *not* a runtime — there is no `ReagentController`, `AgentRunner`, or transport on the Python side. The TS RC currently exercises this path only in `runtime/ts/test/core/agent-host-boundary.test.ts` (tests `A2` / `A4`).

Whole-agent-on-`[py]` dispatch (`agent X runs Role[py]`) is unsupported until the Rust RC lands with PyO3 / equivalent host bindings; see [`docs/future/retire-python-runtime.md`](../future/retire-python-runtime.md) and [`docs/future/nmmo-python-host.md`](../future/nmmo-python-host.md).

## Scope Rules For `current/`

- Only numbered canonical docs live here.
- Historical drafts, niche notes, and superseded thematic docs should not be treated as authoritative.
- If a future RFC disagrees with these docs, `current/` wins for implemented behavior.

## Fast Navigation

- Runtime users: start with [`01-user-guide.md`](01-user-guide.md), then [`03-runtime-core.md`](03-runtime-core.md)
- Runtime implementers: start with [`03-runtime-core.md`](03-runtime-core.md), [`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md), and [`05-versioning-and-reconcile.md`](05-versioning-and-reconcile.md)
- Tooling work: start with [`06-tooling-overview.md`](06-tooling-overview.md) and [`07-lsp.md`](07-lsp.md)
- Test updates: start with [`08-test-spec.md`](08-test-spec.md)
- Product / solution framing: read [`20-usecases-gpt.md`](20-usecases-gpt.md) after the core runtime and cluster docs
