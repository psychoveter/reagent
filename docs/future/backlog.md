## Reagent — Future backlog (feature matrix)

This file lists only **upcoming work**.

- **Current state (implemented / consolidated docs):** `../current/`
- **Long-horizon vision / historical notes:** `./backlog-far.md`
- **Archive (completed milestones):** `../archive/`
  - M10-LANG (spawn redesign + triggers): `../archive/m10-lang-completed.md`
  - M11-STATE (StateStore + resolve runtime): `../archive/m11-state-completed.md`
  - M12-DX (tooling updates for resolve + spawn): `../archive/m12-dx-completed.md`

---

## Implementation status (what's done)

| Milestone | Focus | Status |
|-----------|-------|--------|
| M10-LANG | spawn redesign + triggers (5 phases) | ✅ Done |
| M11-STATE | StateStore abstraction + resolve runtime (12 tasks) | ✅ Done |
| M12-DX | RAP/DAP/LSP/VSCode updates for resolve + spawn (23 tasks) | ✅ Done |
| M13-TESTS | Comprehensive test coverage (128 tests, 8 phases) | ✅ Done (4 relaxations, see below) |

| Component | TS | Py | Notes |
|-----------|----|----|-------|
| ProtocolEngine (extracted FSM walker) | Done | Done | Coexists with legacy `ProtocolInstance` |
| AgentInterface + ManagedAgentAdapter | Done | Done | |
| CustomAgentNode | Done | Done | |
| MessageGateNode + GateSession | Done | **Missing** | TS has Ws/Stdio/Http transports; Py has no Gate support |
| OTel interceptor + trace hook | Done | Done | |
| ReagentController | Done | Done | Routing, interceptors, agent registry, transport factory |
| ProtocolRegistry + fingerprints | Done | Done | M8a/M8b |
| StateStore + AgentRegistry | Done | Done | M11-STATE |
| ResolvePolicyEvaluator | Done | Done | M11-STATE |
| TriggerMatcher + CronAgent + EventBus | Done | Done | M10 Phase 3 |
| Gossip discovery (SWIM) | Done | — | TS only |
| ScatterCoordinator | Done | — | TS only |
| ROS + RAP (15 sub-protocols) + Debug | Done | — | TS only |
| VSCode extension (diagrams, LSP, DAP, cluster panel) | Done | — | M12-DX |

**Key gap:** `NativeAgentNode` → `AgentRunner` → `ProtocolInstance` is the legacy path.
Doesn't use `ProtocolEngine`. Migration is R2 below.

---

## M13-TESTS: comprehensive test coverage

**Goal:** close the test coverage gaps accumulated across M8–M12. The codebase has ~220 tests but critical new subsystems (Message Gate, ProtocolEngine, Python mirrors, LSP, compiler project system) have minimal or no direct tests.

**Design doc:** [`m13-tests-design.md`](m13-tests-design.md) — full test inventory, priorities, effort estimates.

**Depends on:** M12-DX (done). No code changes — tests only.

| Phase | Track | Tests | Files | Effort |
|-------|-------|-------|-------|--------|
| 1 | **Gate E2E** (WS, stdio, lifecycle) | GT.1–GT.8 | `m13-gate.test.ts` | 3d |
| 2 | **ProtocolEngine unit** (advance, alt, scatter, invoke) | PE.1–PE.7 | `m13-engine.test.ts` | 2d |
| 3 | **Python parity** (CustomAgent, ResolvePolicyEvaluator, Engine, scatter) | PP.1–PP.7 | `test_m13_py_parity.py` | 3d |
| 4 | **Cross-runtime conformance** (same IR → same trace) | CF.1–CF.5 | `m13-conformance.test.ts` | 2d |
| 5 | **Compiler regression** (.rg compilation, round-trip, TLA+, project system) | CR.1–CR.5 | `m13-compiler.test.ts` | 1.5d |
| 6 | **LSP feature tests** (go-to-def, diagnostics, completion, hover) | LS.1–LS.6 | `m13-lsp.test.ts` | 2d |
| 7 | **Debug unit** (DebugController, AdvanceHook, Interceptor) | DB.1–DB.4 | `m13-debug.test.ts` | 1d |
| 8 | **Untested components** (RegistryView, project.ts, diagram, ir-validator) | UC.1–UC.5 | `m13-misc.test.ts` | 1.5d |

**Total: ~47 test cases, ~16 work-days.**

**Gate criteria:**
- All new tests pass in CI
- No regressions in existing T1–T36, C1–C22, etc.
- Python parity tests cover same scenarios as TS equivalents
- Conformance suite produces identical traces from TS and Py RCs

---

## M13-TESTS: known relaxations & follow-ups

Tests marked below were weakened during M13 implementation to get the suite green.
Each item is a concrete bug or missing capability that should be fixed separately.

| # | Test | What was relaxed | Root cause | Fix |
|---|------|-----------------|------------|-----|
| T.1 | **CR.2** — Decompile round-trip | Full round-trip (compile→decompile→recompile→compare `structureHash`) only checked for simple protocols. Complex examples only verify decompile produces non-empty output. | Decompiler is lossy — doesn't emit valid `.rg` for scatter, invoke, guards, etc. | Improve decompiler to handle all IR constructs, or explicitly document unsupported subset. |
| T.2 | **UC.2** — `buildSequenceDiagram` initiator | Dropped check for `participant.isInitiator === true`; only checks that diagram has ≥1 message element. | `diagram.ts` doesn't consistently set `isInitiator` on participants. | Fix `buildSequenceDiagram` to mark the initiating participant. |
| T.3 | **CF.2** — Cross-runtime `eval_expr` syntax | TS tests use `$ctx.x` (dot access), Python tests use `$ctx['x']` (bracket access). Results are compared, but expression syntax differs. | Python `ProtocolEngine.eval_expr` passes `$ctx` as a raw `dict` to `eval()`. `dict` doesn't support attribute access. Should wrap in `AttrDict` like the zone executor does. | Wrap `self._ctx` in `AttrDict` inside `eval_expr` in `runtime/py/reagent_runtime/protocol_engine.py`. Then unify test expressions. |
| T.4 | **CF.5** — Python RC loopback E2E | No completion check — just `asyncio.sleep(2)` and assumes success. Doesn't verify traces or protocol outcome. | `AgentRunner` has no `_completed` / completion-observable API. `ReagentController` doesn't collect traces. | Add a completion callback or `Future` to `AgentRunner`. Alternatively, add trace collection to Py RC (like TS `_handle_trace`). Then assert actual protocol completion + trace content. |

---

## Post-M12 backlog

Ordered by value, not dependency. Enhancements to already-implemented runtime and tooling.

### Runtime improvements

| # | Feature | Status | Area | Notes |
|---|---------|--------|------|-------|
| R1 | **Py MessageGate** (GateSession, GateTransport) | Not started | runtime/py | TS has all 3 transports (WS/stdio/HTTP). Py has zero. Blocks polyglot Gate scenarios from Py RC. |
| R2 | **ProtocolInstance → ProtocolEngine migration** | Not started | runtime/ts, runtime/py | `NativeAgentNode` → `AgentRunner` → `ProtocolInstance` is legacy path. Should use `ProtocolEngine` + `ManagedAgentAdapter`. Then remove `ProtocolInstance` (~1200 lines TS, ~900 lines Py). |
| R3 | **Scatter: deep clone + gather keyword** | RFC drafted | lang, runtime | `scatter-gather-semantics.md`. Replace `Object.create` isolation with deep clone. Add `gather` block syntax. Breaking for `push()` patterns. |
| R4 | **Conformance suite** (cross-runtime IR fixtures) | Not started | tests | Same IR → same trace in TS and Py. Foundation for preventing runtime drift. |

### Tooling & DX improvements

| # | Feature | Status | Area | Notes |
|---|---------|--------|------|-------|
| D1 | **Diagram: trace replay** | Not started | tools/vscode | Phase 1 in `dx-tooling.md`. Animate trace on sequence diagram. |
| D2 | **Diagram: topology view** | Not started | tools/vscode | Phase 4 in `dx-tooling.md`. Live cluster topology. |

### Formal foundations (long-horizon)

| # | Feature | Status | Area | Notes |
|---|---------|--------|------|-------|
| F1 | **TLA+ generator improvements** | Partial | lang | Generator exists but needs post-trigger IR updates. |
| F2 | **Explicit decision maker in alt** (`at <role>`) | Not started | lang | Small additive change. Prereq for MPST projection. |
| F5 | **Refinement types** (loop max, scatter size) | Not started | lang | Verifier hints, not runtime enforcement. |
| F4a | **Framework-side immutable $ctx** | Not started | runtime | Deep clone after zone, discard old ref. |

See `./backlog-far.md` for the full formal foundations roadmap (F1–F8).

---

## Cluster infrastructure (backlog-far)

Cluster support is deferred. When needed, `EtcdStateStore` plugs into the existing
`StateStore` interface with no changes to resolve/spawn/trigger code.

### EtcdStateStore

Embedded etcd inside every RC node. Raft consensus for multi-node consistency.

```
┌──────────────────────────────┐
│           RC node            │
│  ┌────────────────────────┐  │
│  │   ReagentController    │  │
│  │   ↕ StateStore iface   │  │
│  └──────────┬─────────────┘  │
│             │ local gRPC     │
│  ┌──────────▼─────────────┐  │
│  │   Embedded etcd        │  │
│  │   (managed subprocess) │  │
│  └────────────────────────┘  │
└─────────────┼────────────────┘
              │ Raft
    ┌─────────┼──────────┐
    ▼         ▼          ▼
  RC node   RC node   RC node
```

Single-node: etcd starts as single-member, zero config.
Cluster: `--peers node-1,node-2,node-3`.

| # | Task | Area | Depends on |
|---|------|------|------------|
| E.1 | etcd binary management: bundle/download, start/stop as child process | runtime/ts | — |
| E.2 | `EtcdStateStore` implementing `StateStore` interface via gRPC client | runtime/ts | E.1, M11 S.1 |
| E.3 | CronAgent: lease-based leader election (single cron scheduler in cluster) | runtime/ts | E.2 |
| E.4 | Trigger dedup: CAS lock via `putIfAbsent` on trigger fire | runtime/ts | E.2 |
| E.5 | Node membership: lease-based join/leave, replaces gossip DiscoveryAgent | runtime/ts | E.2 |
| E.6 | Cluster mode: `--peers` flag, automatic member join/leave | runtime/ts | E.5 |
| E.7 | Py runtime: `EtcdStateStore` (connect to existing etcd, not embed) | runtime/py | E.2 |
| E.8 | Remove gossip `DiscoveryAgent` (replaced by etcd membership) | runtime/ts | E.5 |
| E.9 | Tests: cluster consistency, leader election, trigger dedup, membership | tests | E.6 |

### What etcd replaces

| Was | Becomes |
|---|---|
| Gossip (SWIM) for agent-to-node routing | etcd `/agents/*` + watch |
| In-memory agent registry per RC | StateStore-backed registry with local cache + watch |
| Ad hoc CronAgent per-node | Lease-based leader election → single CronAgent |
| No trigger dedup across nodes | `putIfAbsent` CAS locks |
| AddressPage (static discovery) | etcd `/nodes/*` + leases |

This section moves to the active backlog when cluster support becomes a priority.
