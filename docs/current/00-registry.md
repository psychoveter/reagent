# Reagent Current Docs Registry

This directory is the canonical, current-state documentation set for Reagent.
It is intentionally organized as a numbered reading order rather than as a flat topic dump.

## Status

- TypeScript runtime was structurally reorganized in this pass.
- `runtime/ts/src` now reflects the runtime architecture through layer folders.
- Python runtime was **not** structurally reorganized in the same pass.
- The language layer remains stable and is documented here without a matching structural rewrite.

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

`runtime/ts/src` is now split into explicit layers:

- `contracts/` for shared runtime interfaces and types
- `core/` for protocol execution primitives
- `controller/` for `ReagentController` and runtime registry logic
- `nodes/` for language/runtime host adapters
- `gate/` for Message Gate session and transport support
- `mcp/` for MCP-facing adapter and server code
- `cluster/` for state store, membership, leader election, and runtime bootstrap
- `triggers/` for trigger matching and resolve policy evaluation
- `network/` for `NodeLink` implementations and legacy NATS transport compatibility
- `admin/` for admin server, remote node, debug, registry view, and reconciler
- `observability/` for OTel hooks
- `support/` for runtime support utilities such as agent manifest loading

The root of `runtime/ts/src` now keeps only true entrypoints and package surface files:

- `index.ts`
- `main.ts`
- `mcp-gate.ts`

### Python runtime

The Python runtime remains implemented and tested, but its filesystem layout was not reorganized to mirror the new TS tree.
Where the docs describe TS and Python together, treat TS as the freshly refactored implementation and Python as a partially mirrored implementation with deliberate asymmetry.

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
