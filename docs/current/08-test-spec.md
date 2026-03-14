# Test Specification And Registry

This document is the canonical current map of the Reagent test surface after the architecture-first taxonomy migration.

## 1. Test Locations

| Area | Path | Notes |
|---|---|---|
| Lang surface tests | `lang/test/surface/` | Parser, trigger, and IR-surface coverage |
| Lang compiler tests | `lang/test/compiler/` | Compiler, decompiler, fingerprint, and round-trip coverage |
| Runtime package cluster tests | `runtime/ts/test/cluster/` | Presence, resolve, etcd, NATS, and cluster adapters |
| Runtime package host tests | `runtime/ts/test/hosts/` | Package-local host adapter coverage |
| Runtime controller tests | `runtime/ts/test/controller/` | RC routing, registry, reconcile, and lifecycle |
| Runtime core tests | `runtime/ts/test/core/` | Role-run, engine, scatter, and agent-host boundary |
| Runtime trigger tests | `runtime/ts/test/triggers/` | Trigger matcher, cron, event, and policy semantics |
| Runtime contract tests | `runtime/ts/test/contracts/` | Surface, conformance, observability, gate/debug, utilities, regressions |
| Runtime story tests | `runtime/ts/test/stories/` | Deterministic scenario-style runtime stories |
| Runtime debug stories | `runtime/ts/test/stories/debug/` | Hosted debug flow coverage |
| Runtime live stories | `runtime/ts/test/stories/live/` | External/live agent coverage |
| Python runtime tests | `runtime/ts/test/python/` | Runtime-core, triggers, and TS/Python parity |
| LSP tests | `tools/reagent-vscode/server/test/lsp/` | Legacy and current language-server suites |

Notes:

- `runtime/ts/test/support/` remains the shared TS test helper layer.
- `runtime/ts/test/py_agent_runner.py` remains helper code, not a test suite.

## 2. Script Lanes

### Root `package.json`

| Lane | Script |
|---|---|
| Fast smoke | `npm run test:fast` |
| Default repo validation | `npm run test:default` |
| Full repo validation | `npm run test:all` |
| Lang surface | `npm run test:lang:surface` |
| Lang compiler | `npm run test:lang:compiler` |
| Runtime fast/package | `npm run test:runtime:fast` |
| Runtime cluster | `npm run test:runtime:cluster` |
| Runtime hosts | `npm run test:runtime:hosts` |
| Runtime controller | `npm run test:runtime:controller` |
| Runtime core | `npm run test:runtime:core` |
| Runtime triggers | `npm run test:runtime:triggers` |
| Runtime contracts | `npm run test:runtime:contracts` |
| Deterministic stories | `npm run test:stories` |
| NATS-backed story | `npm run test:stories:nats` |
| Debug story | `npm run test:stories:debug` |
| Live story | `npm run test:stories:live` |
| Python | `npm run test:python` |
| LSP tooling | `npm run test:tooling:lsp` |

### Package-level ownership

| Package | Scripts |
|---|---|
| `lang` | `test:surface`, `test:compiler`, `test:all` |
| `runtime/ts` | `test:fast`, `test:cluster`, `test:hosts`, `test:controller`, `test:core`, `test:triggers`, `test:contracts`, `test:stories`, `test:stories:nats`, `test:stories:debug`, `test:stories:live`, `test:default`, `test:all` |
| `runtime` | proxy scripts mirroring the `runtime/ts` architecture lanes |
| `tools/reagent-vscode` | `test:lsp:legacy`, `test:lsp:current`, `test:lsp` |

### Lane intent

- `test:fast` is the short smoke path: lang surface plus runtime package-local fast suites.
- `test:default` is the routine non-live validation path.
- `test:runtime:cluster` adds infra-backed etcd and NATS coverage.
- `test:stories` is for deterministic stories with no external live-agent dependency.
- `test:stories:debug` and `test:stories:live` remain separate because they need heavier harnesses or external prerequisites.
- `test:tooling:lsp` is tooling-specific and intentionally not part of default runtime validation.

## 3. File Inventory

### `lang/test/`

- `surface/triggers.test.ts`
- `surface/ir-surface.test.ts`
- `compiler/compiler-roundtrip.test.ts`
- `compiler/fingerprints.test.ts`
- `compiler/decompiler.test.ts`

### `runtime/ts/test/`

- `cluster/agent-presence-leases.test.ts`
- `cluster/state-resolve.test.ts`
- `cluster/etcd-state-store.test.ts`
- `cluster/etcd-cluster.test.ts`
- `cluster/etcd-live-presence.e2e.test.ts`
- `cluster/nats-node-link.test.ts`
- `hosts/mcp-adapter.test.ts`

### `runtime/ts/test/` TypeScript

- `controller/routing-and-orchestration.test.ts`
- `controller/admin-client.test.ts`
- `controller/protocol-registry.test.ts`
- `controller/reconcile.test.ts`
- `controller/protocol-run-lifecycle.test.ts`
- `core/agent-host-boundary.test.ts`
- `core/scatter-async.test.ts`
- `core/protocol-engine.test.ts`
- `core/role-run.test.ts`
- `core/scatter-runtime.test.ts`
- `triggers/trigger-matcher.test.ts`
- `contracts/lang-surface-runtime.test.ts`
- `contracts/lang-spec-coverage.test.ts`
- `contracts/observability-otel.test.ts`
- `contracts/formal-model.test.ts`
- `contracts/custom-hosts.test.ts`
- `contracts/gate-session.test.ts`
- `contracts/debug-session.test.ts`
- `contracts/runtime-conformance.test.ts`
- `contracts/runtime-utilities.test.ts`
- `contracts/runtime-regressions.test.ts`
- `stories/runtime-semantics-nats.test.ts`
- `stories/iot-cron-event.test.ts`
- `stories/cross-mode-orchestration.test.ts`
- `stories/risk-review-approval.test.ts`
- `stories/debug/auction-debug-host.test.ts`
- `stories/live/task-delegation-claude.test.ts`

### `runtime/ts/test/python/`

- `runtime-core/test_runtime_core.py`
- `runtime-core/test_runtime_coverage.py`
- `triggers/test_triggers.py`
- `parity/test_ts_python_parity.py`

### `tools/reagent-vscode/server/test/lsp/`

- `legacy-lsp.test.ts`
- `current-lsp.test.ts`

## 4. Recommended Validation Order

Recommended default order after compiler or runtime work:

1. `npm run build`
2. `npm run test:fast`
3. `npm run test:default`
4. `npm run test:runtime:cluster`
5. `npm run test:stories:nats`
6. `npm run test:stories:debug`
7. optional `npm run test:stories:live`
8. optional `npm run test:python`
9. optional `npm run test:tooling:lsp`

Practical rule:

- For ordinary TS runtime work, `test:fast` or `test:default` is the routine path.
- For cluster, transport, or membership work, include `test:runtime:cluster`.
- For NATS-backed runtime semantics, include `test:stories:nats`.
- For Claude/live or tooling changes, include only the relevant environment-gated lanes.

## 5. Current Known Gaps

Known-red suites that are not purely environment failures:

| Suite | Failing test(s) | Nature |
|---|---|---|
| `runtime/ts/test/stories/runtime-semantics-nats.test.ts` | T7, T8, T11, T12 | Wait timing, `$self` persistence, and `try/catch` naming gaps remain |
| `runtime/ts/test/core/agent-host-boundary.test.ts` | A6 | Async zone detection in compiled IR still diverges from expectation |

Conditional or environment-dependent suites:

- `runtime/ts/test/stories/live/task-delegation-claude.test.ts` requires Docker and `ANTHROPIC_API_KEY`.
- `tools/reagent-vscode/server/test/lsp/legacy-lsp.test.ts` is still timing-sensitive during LSP initialize.

Decompile note:

- `lang/test/compiler/compiler-roundtrip.test.ts` is green again, but `CR.2` currently tracks a fixed expected-unsupported set for newer invoke/spawn/scatter/multi-protocol examples until decompiler catch-up work lands.

## 6. Use-Case Coverage Map

| Use case | Current coverage | Quality | Main gaps |
|---|---|---|---|
| UC1 Sealed-Bid Auction Simulation | `runtime/ts/test/stories/debug/auction-debug-host.test.ts` plus debug/gate contracts | Strong | direct debug story already exists |
| UC2 Distributed LLM Research Swarm | `runtime/ts/test/stories/live/task-delegation-claude.test.ts` is the closest live path | Partial | richer multi-node live swarm story still deferred |
| UC3 IoT Sensor Pipeline with Cron and Event Triggers | `runtime/ts/test/stories/iot-cron-event.test.ts` plus `runtime/ts/test/triggers/trigger-matcher.test.ts` | Strong | good deterministic trigger chain coverage |
| UC4 Cross-Language / Cross-Mode Orchestration | `runtime/ts/test/stories/cross-mode-orchestration.test.ts` plus custom/gate/contracts lanes | Strong | Python boundary is still a separate extension |
| UC5 Scheduled Risk Review with Approval and Child Protocols | `runtime/ts/test/stories/risk-review-approval.test.ts` | Strong | advanced scenario is covered in a deterministic story |

## 7. Primary Breakage Zones

- Deep `runtime/ts/src/*` imports from moved tests remain sensitive to future directory churn.
- Cluster membership and state-store suites are still the most environment-sensitive part of the TS surface.
- Story and live lanes depend on more fixture wiring than controller/core/contract lanes.
- Tooling tests remain coupled to compiled output paths under `tools/reagent-vscode/out/`.

## 8. Adjacent Docs

- Runtime architecture: [`03-runtime-core.md`](03-runtime-core.md)
- Cluster/control-plane architecture: [`04-cluster-and-control-plane.md`](04-cluster-and-control-plane.md)
- Versioning and reconcile: [`05-versioning-and-reconcile.md`](05-versioning-and-reconcile.md)
- End-to-end use cases: [`09-e2e-usecases.md`](09-e2e-usecases.md)
- Current registry: [`00-registry.md`](00-registry.md)
- Next-step testing plan: [`../future/test-spec-next.md`](../future/test-spec-next.md)
