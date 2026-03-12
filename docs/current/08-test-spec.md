# Test Specification And Registry

This document is the canonical current map of the Reagent test surface.

It is not only a file inventory.
It also describes:

- where tests live
- which tests are part of the routine TS-first validation path
- which suites are infra-backed or external/live
- which areas were recently verified
- how the current test surface maps to the product-level use cases in `09-e2e-usecases.md`

## 1. Test Locations

| Area | Path | Notes |
|---|---|---|
| TS runtime integration and architecture tests | `runtime/tests/` | Main TS integration surface and end-to-end scenarios |
| TS runtime package and infra adapter tests | `runtime/ts/test/` | Direct tests of runtime package internals and cluster adapters |
| Python runtime tests | `runtime/tests/*.py` | Python runtime coverage and parity scripts |
| Language/compiler tests | `lang/test/` | Parser, trigger, and compiler regression coverage |
| LSP tests | `tools/reagent-vscode/server/test/` | LSP smoke and feature coverage |

## 2. Full File Inventory

### `runtime/ts/test/`

- `agent-presence-leases.test.ts`
- `etcd-cluster.test.ts`
- `etcd-live-presence.e2e.test.ts`
- `etcd-state-store.test.ts`
- `m11-state-resolve.test.ts`
- `mcp-adapter.test.ts`
- `nats-node-link.test.ts`

### `runtime/tests/` TypeScript

- `e2e.test.ts`
- `m5-ctrl.test.ts`
- `m5-coverage.test.ts`
- `m5-lang.test.ts`
- `m6-admin.test.ts`
- `m8a-decompiler.test.ts`
- `m8a-fingerprints.test.ts`
- `m8a-registry.test.ts`
- `m8b-agent-model.test.ts`
- `m8b-reconciler.test.ts`
- `m8c-rc-lifecycle.test.ts`
- `m9-scatter-async.test.ts`
- `m13-conformance.test.ts`
- `m13-debug-auction-e2e.test.ts`
- `m13-debug.test.ts`
- `m13-engine.test.ts`
- `m13-gate.test.ts`
- `m13-misc.test.ts`
- `m14-task-delegation-claude-live-e2e.test.ts`
- `phase3-triggers.test.ts`
- `wave1-otel.test.ts`
- `wave1-tla.test.ts`
- `wave2-custom.test.ts`
- `wave3-scatter.test.ts`

### `runtime/tests/` Python

- `test_m13_py_parity.py`
- `test_phase3_triggers.py`
- `test_py_rc.py`
- `test_py_rc_coverage.py`

Note:

- `py_agent_runner.py` is helper code, not a test file.

### `lang/test/`

- `m10-phase4a.test.ts`
- `m13-compiler.test.ts`
- `trigger.test.ts`

### `tools/reagent-vscode/server/test/`

- `lsp.test.ts`
- `m13-lsp.test.ts`

## 3. Execution Tiers

The test surface is intentionally split into tiers.
Not every suite belongs in the default smoke path.

Execution policy:

- `Tier 0` is the default fast smoke path
- `Tier 1`, `Tier 2`, and `Tier 3` should also run through explicit automated lanes, not through ad hoc manual commands only
- in practice this means they should be invokable by stable scripts and/or CI jobs, even if some of them remain conditional on environment availability

### Tier 0: Build and fast local smoke

Goal:

- catch obvious compiler/runtime breakage quickly
- validate the main TS runtime line after ordinary refactors

Typical commands:

- `npm run build`
- `npm run test:ctrl`
- `npm run test:lang`
- `npm run test:coverage`
- `npm run test:admin`
- `npm run test:m8a`
- `npm run test:m8c:lifecycle`

Important note:

- `npm test` is **not** the full repository-wide test surface
- it is only the default routine validation path defined in `package.json`

### Tier 1: Routine TS integration

Goal:

- validate the TS runtime surface beyond the default scripts
- especially after runtime-core, trigger, gate, debug, and agent lifecycle changes

Representative suites:

- `runtime/ts/test/m11-state-resolve.test.ts`
- `runtime/ts/test/mcp-adapter.test.ts`
- `runtime/tests/phase3-triggers.test.ts`
- `runtime/tests/wave2-custom.test.ts`
- `runtime/tests/m8c-rc-lifecycle.test.ts`
- `runtime/tests/m13-debug-auction-e2e.test.ts`

Automation expectation:

- this tier should be runnable as an automated validation lane after routine runtime changes
- it should not depend on one-off manual command selection

### Tier 2: Infra-backed integration

Goal:

- validate behavior that depends on real shared infrastructure
- especially etcd-backed presence, membership, and cluster semantics

Representative suites:

- `runtime/ts/test/etcd-state-store.test.ts`
- `runtime/ts/test/etcd-cluster.test.ts`
- `runtime/ts/test/agent-presence-leases.test.ts`
- `runtime/ts/test/etcd-live-presence.e2e.test.ts`

Prerequisites:

- local/dev etcd reachable at `ETCD_HOSTS` or `http://127.0.0.1:2379`

Automation expectation:

- this tier should be runnable automatically when infra prerequisites are present
- it is infra-backed, but it is still part of the intended automated test surface

### Tier 3: External/live validation

Goal:

- validate live external integrations such as Claude-backed nodes and MCP-driven participation

Representative suite:

- `runtime/tests/m14-task-delegation-claude-live-e2e.test.ts`

Prerequisites:

- Docker
- infra bootstrapping for live test
- `ANTHROPIC_API_KEY` or equivalent `.env` source

This tier is **conditional** and is not part of default smoke validation.

Automation expectation:

- this tier should still run through an explicit automated lane when credentials and external prerequisites are available
- "conditional" means environment-gated, not manual-only

## 4. Current Verification Status

This section records current known status from direct execution on 2026-03-08.

### Green (all assertions pass)

`runtime/ts/test/` — all 7 suites green:

- `agent-presence-leases.test.ts`
- `etcd-cluster.test.ts` (requires local etcd)
- `etcd-live-presence.e2e.test.ts` (requires local etcd)
- `etcd-state-store.test.ts` (requires local etcd)
- `m11-state-resolve.test.ts`
- `mcp-adapter.test.ts`
- `nats-node-link.test.ts` (requires local NATS)

`runtime/tests/` TS — 23 of 27 suites green:

- `m5-lang.test.ts` (9/9)
- `m5-coverage.test.ts` (11/11)
- `m5-ctrl.test.ts` (12/12)
- `m6-admin.test.ts` (5/5)
- `m8a-decompiler.test.ts` (1/1)
- `m8a-fingerprints.test.ts` (6/6)
- `m8a-registry.test.ts` (5/5)
- `m8b-reconciler.test.ts` (5/5)
- `m8c-rc-lifecycle.test.ts` (6/6)
- `m9-scatter-async.test.ts` (4/4)
- `m13-engine.test.ts` (7/7)
- `m13-conformance.test.ts` (10/10)
- `m13-misc.test.ts` (23/23)
- `m13-gate.test.ts` (18/18)
- `m13-debug.test.ts` (17/17)
- `m13-debug-auction-e2e.test.ts` (3/3)
- `phase3-triggers.test.ts` (24/24)
- `wave1-otel.test.ts` (3/3)
- `wave1-tla.test.ts` (5/5)
- `wave2-custom.test.ts` (4/4)
- `wave3-scatter.test.ts` (9/9)
- `m15-iot-cron-event-e2e.test.ts` (1/1)
- `m16-cross-mode-orchestration-e2e.test.ts` (1/1)
- `m17-risk-review-approval-e2e.test.ts` (1/1)

`lang/test/` — 2 of 3 suites green:

- `m10-phase4a.test.ts`
- `trigger.test.ts`

`tools/reagent-vscode/server/test/` — 1 of 2 suites green:

- `m13-lsp.test.ts` (6/6)

`runtime/tests/` Python — all 4 suites green:

- `test_py_rc.py` (6/6)
- `test_py_rc_coverage.py` (8/8)
- `test_phase3_triggers.py` (21/21)
- `test_m13_py_parity.py` (7/7)

### Known Red

These suites have persistent failures unrelated to environment or infrastructure:

| Suite | Failing test(s) | Nature |
|---|---|---|
| `runtime/tests/e2e.test.ts` | T7: Wait delays execution (timing too fast: 159ms vs expected 300ms); T8: `$self` state not accumulating across loop iterations; T11/T12: catch block sends `Failure` instead of `ErrorReport` | T7 is possibly flaky timing; T8 and T11/T12 indicate real runtime gaps in `$self` persistence and `try/catch` error-message naming |
| `runtime/tests/m8b-agent-model.test.ts` | A6: Async zone detection in compiled IR | Compiled IR does not mark async zones as expected |
| `lang/test/m13-compiler.test.ts` | CR.2: decompile round-trip fails for 6/26 examples (18-invoke-demo, 19-spawn-emit-demo, 20-cross-lang-e2e, 22-multi-protocol-agent, 23-scatter-gather, 24-call-for-proposal) | Decompiler throws during compile/decompile for newer protocol patterns |

### Conditional / environment-dependent

- `runtime/tests/m14-task-delegation-claude-live-e2e.test.ts` — requires Docker + `ANTHROPIC_API_KEY`
- `tools/reagent-vscode/server/test/lsp.test.ts` — times out on LSP initialize; likely requires a built LSP server or specific environment setup

## 5. Recommended Validation Order

Recommended TS-first order after runtime and cluster refactors:

1. `npm run build`
2. `runtime/ts/test/m11-state-resolve.test.ts`
3. `runtime/tests/m8c-rc-lifecycle.test.ts`
4. `runtime/tests/phase3-triggers.test.ts`
5. `runtime/tests/wave2-custom.test.ts`
6. `runtime/tests/m13-debug-auction-e2e.test.ts`
7. `runtime/ts/test/agent-presence-leases.test.ts`
8. `runtime/ts/test/etcd-cluster.test.ts`
9. `runtime/ts/test/etcd-live-presence.e2e.test.ts`
10. optional Tier 3 live suites

Practical rule:

- for ordinary TS runtime work, Tier 0 + selected Tier 1 is enough
- for state-store, membership, or control-plane changes, include Tier 2
- for MCP/Claude/live-agent changes, include Tier 3 only when the environment is available
- Tier 1-3 should be treated as scriptable/automated lanes, not as undocumented bespoke command sequences

## 6. Use-Case Coverage Map

This maps the current test surface to the reference use cases in `09-e2e-usecases.md`.

| Use case | Current coverage | Quality | Main gaps |
|---|---|---|---|
| UC1 Sealed-Bid Auction Simulation | `m13-debug-auction-e2e.test.ts`, debug/gate/runtime suites | Strong | already has a direct story-level e2e |
| UC2 Distributed LLM Research Swarm | `m14-task-delegation-claude-live-e2e.test.ts` is the closest live path | Partial | no richer distributed research-swarm story-level e2e yet (P5 in backlog) |
| UC3 IoT Sensor Pipeline with Cron and Event Triggers | `m15-iot-cron-event-e2e.test.ts` + `phase3-triggers.test.ts` | Strong | story-level e2e covers cron -> emit -> event chain; green as of 2026-03-08 |
| UC4 Cross-Language / Cross-Mode Orchestration | `m16-cross-mode-orchestration-e2e.test.ts` + custom/gate/conformance primitives | Strong | TS-first cross-mode story-level e2e in place; Python boundary not yet tested |
| UC5 Scheduled Risk Review with Approval and Child Protocols | `m17-risk-review-approval-e2e.test.ts` | Strong | cron + approval + invokes + spawns + persistent state covered; green as of 2026-03-08 |

## 7. Primary Breakage Zones

When changing runtime internals, these areas tend to drift first:

- direct `runtime/ts/src/*` deep imports in tests
- RC ontology split across `AgentTemplate`, `AgentRecord`, `AgentRuntime`, and live presence
- state-store and membership suites
- trigger and cluster leadership behavior
- gate/custom-agent event contracts
- conformance runner assumptions

## 8. Known Reality Notes

- The TS runtime remains the primary and freshest implementation line for architecture changes.
- Python coverage still matters, but it is not the primary reference path for current runtime evolution. All 4 Python suites are green as of 2026-03-08.
- `m14-task-delegation-claude-live-e2e.test.ts` remains the canonical current live Claude integration test but was not run in this pass (Tier 3, external).
- Three known-red areas exist: decompiler round-trip for newer patterns, `e2e.test.ts` gaps around `$self`/`try-catch`/wait timing, and async zone detection in compiled IR.
- `lsp.test.ts` (the older LSP test) times out; `m13-lsp.test.ts` (the newer one) passes cleanly.
- This document should stay aligned with `docs/future/test-spec-next.md` for the next wave of test additions.

## 9. Adjacent Docs

- Runtime architecture: [`03-runtime-core.md`](03-runtime-core.md)
- Cluster/control-plane architecture: [`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md)
- Versioning and reconcile: [`05-versioning-and-reconcile.md`](05-versioning-and-reconcile.md)
- End-to-end use cases: [`09-e2e-usecases.md`](09-e2e-usecases.md)
- Current registry: [`00-registry.md`](00-registry.md)
- Next-step testing plan: [`../future/test-spec-next.md`](../future/test-spec-next.md)
