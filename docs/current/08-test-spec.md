# Test Specification And Registry

This document is the canonical current test inventory for Reagent.
It replaces `test-spec.md` and is aligned with the current repo layout after the TS runtime tree reorganization.

## 1. Test Locations

| Area | Path | Notes |
|---|---|---|
| TS runtime integration and architecture tests | `runtime/tests/` | Main integration surface, plus Python parity scripts |
| TS runtime package tests | `runtime/ts/test/` | Direct tests of runtime package internals and infra adapters |
| Language/compiler tests | `lang/test/` | Parser, trigger, and compiler regression coverage |
| LSP tests | `tools/reagent-vscode/server/test/` | LSP smoke and feature coverage |

## 2. Current File Inventory

### `runtime/ts/test/`

- `m11-state-resolve.test.ts`
- `mcp-adapter.test.ts`
- `nats-node-link.test.ts`
- `etcd-state-store.test.ts`
- `etcd-cluster.test.ts`

### `runtime/tests/` TypeScript

- `e2e.test.ts`
- `m5-ctrl.test.ts`
- `m5-coverage.test.ts`
- `m5-lang.test.ts`
- `m6-admin.test.ts`
- `m8a-registry.test.ts`
- `m8a-fingerprints.test.ts`
- `m8a-decompiler.test.ts`
- `m8b-agent-model.test.ts`
- `m8b-reconciler.test.ts`
- `m9-scatter-async.test.ts`
- `phase3-triggers.test.ts`
- `wave1-otel.test.ts`
- `wave1-tla.test.ts`
- `wave2-custom.test.ts`
- `wave3-gossip.test.ts`
- `wave3-scatter.test.ts`
- `m13-gate.test.ts`
- `m13-engine.test.ts`
- `m13-debug.test.ts`
- `m13-conformance.test.ts`
- `m13-misc.test.ts`

### `runtime/tests/` Python

- `test_py_rc.py`
- `test_py_rc_coverage.py`
- `test_phase3_triggers.py`
- `test_m13_py_parity.py`

Note:

- `py_agent_runner.py` is helper code, not a test file.

### `lang/test/`

- `m10-phase4a.test.ts`
- `trigger.test.ts`
- `m13-compiler.test.ts`

### `tools/reagent-vscode/server/test/`

- `lsp.test.ts`
- `m13-lsp.test.ts`

## 3. Runtime Reorg Impact

The TS runtime reorganization changed deep import paths under `runtime/ts/src`.
Tests that imported flat paths had to be updated to the new layered structure.

Primary affected areas:

- `runtime/ts/test/*`
- `runtime/tests/m8b-agent-model.test.ts`
- `runtime/tests/m8b-reconciler.test.ts`
- `spec/conformance/runner.ts`

## 4. Validation Order

Recommended fast-to-slower order after runtime refactors:

1. `runtime/ts/test/m11-state-resolve.test.ts`
2. `runtime/ts/test/mcp-adapter.test.ts`
3. `runtime/ts/test/nats-node-link.test.ts`
4. `runtime/tests/m5-ctrl.test.ts`
5. `runtime/tests/m8b-agent-model.test.ts`
6. `runtime/tests/m8c-rc-lifecycle.test.ts`
7. `runtime/tests/m13-gate.test.ts`
8. `runtime/tests/m13-debug.test.ts`
9. `runtime/tests/m13-conformance.test.ts`
10. `runtime/tests/m13-misc.test.ts`
11. `runtime/tests/m6-admin.test.ts`
12. `runtime/ts/test/etcd-state-store.test.ts`
13. `runtime/ts/test/etcd-cluster.test.ts`

## 5. Known Reality Notes

- The TS runtime tree was reorganized in this pass.
- The Python runtime was not structurally reorganized in the same pass.
- Test coverage spans both, but source-layout assumptions are fresher and more reliable on the TS side.
- Older docs underreported the `runtime/ts/test/` surface; this registry is the corrected canonical inventory.

## 6. Primary Consumers

When changing runtime internals, expect these areas to break first:

- direct `runtime/ts/src/*` deep imports in tests
- RC ontology split (`AgentTemplate` / `AgentRecord` / `AgentRuntime`) and addressability filtering
- ROS/control-plane regression suites
- state-store and membership tests
- conformance runner imports

## 7. Adjacent Docs

- Runtime architecture: [`03-runtime-core.md`](03-runtime-core.md)
- Cluster/control-plane architecture: [`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md)
- Current registry: [`00-registry.md`](00-registry.md)
