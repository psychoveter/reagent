## Reagent — Future backlog (feature matrix)

This file lists only **upcoming work**.

- **Current state (implemented / consolidated docs):** `../current/`
  - Test specification & registry: `../current/test-spec.md`
- **Long-horizon vision / historical notes:** `./backlog-far.md`
- **Archive (completed milestones):** `../archive/`
  - M10-LANG (spawn redesign + triggers): `../archive/m10-lang-completed.md`
  - M11-STATE (StateStore + resolve runtime): `../archive/m11-state-completed.md`
  - M12-DX (tooling updates for resolve + spawn): `../archive/m12-dx-completed.md`
  - M13-TESTS (comprehensive test coverage): `../archive/m13-tests-completed.md`

---

## Implementation status (what's done)

| Milestone | Focus | Status |
|-----------|-------|--------|
| M10-LANG | spawn redesign + triggers (5 phases) | ✅ Done |
| M11-STATE | StateStore abstraction + resolve runtime (12 tasks) | ✅ Done |
| M12-DX | RAP/DAP/LSP/VSCode updates for resolve + spawn (23 tasks) | ✅ Done |
| M13-TESTS | Comprehensive test coverage (~92 tests, 8 phases, 4 relaxations) | ✅ Done |

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
| ~~Gossip discovery (SWIM)~~ | Removed | — | Replaced by etcd membership (E.5/E.8) |
| EtcdStateStore + EtcdManager + EtcdMembership | Done | — | TS only; cluster infrastructure |
| LeaderElection + Trigger dedup | Done | — | TS only; CronAgent + TriggerMatcher cluster safety |
| ScatterCoordinator | Done | — | TS only |
| ROS + RAP (15 sub-protocols) + Debug | Done | — | TS only |
| VSCode extension (diagrams, LSP, DAP, cluster panel) | Done | — | M12-DX |
| Test coverage (Gate, Engine, Conformance, LSP, Compiler, Debug, Misc) | Done | Done | M13-TESTS |

**Key gap:** `NativeAgentNode` → `AgentRunner` → `ProtocolInstance` is the legacy path.
Doesn't use `ProtocolEngine`. Migration is R2 below.

**Test relaxations (M13 follow-ups):** 4 items tracked in `../current/test-spec.md` §Known relaxations.

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
| R5 | **MCP Gate** (`McpGateTransport` + AgentLauncher) | RFC drafted | runtime/ts, integration | RC as MCP server — LLM agents (Claude Code, Cursor, OpenClaw) participate in protocols via MCP tools. [`mcp-gate-rfc.md`](mcp-gate-rfc.md) |

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

## Cluster infrastructure (implemented)

Embedded etcd cluster infrastructure. Raft consensus for multi-node consistency.

### Architecture

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
Cluster: `--peers node-1=http://host1:2380,node-2=http://host2:2380`.

### Implementation status

| # | Task | Status | Files |
|---|------|--------|-------|
| E.1 | etcd binary management | ✅ Done | `etcd-manager.ts` |
| E.2 | `EtcdStateStore` via `etcd3` npm client | ✅ Done | `etcd-state-store.ts` |
| E.3 | CronAgent leader election | ✅ Done | `leader-election.ts`, `cron-agent.ts` |
| E.4 | Trigger dedup (CAS locks) | ✅ Done | `trigger-matcher.ts` |
| E.5 | Node membership (lease-based) | ✅ Done | `etcd-membership.ts`, `state-store-agent-registry.ts` |
| E.6 | Cluster mode (`--peers`, bootstrap) | ✅ Done | `cluster-bootstrap.ts` |
| E.7 | Py runtime `EtcdStateStore` | Not started | — |
| E.8 | Remove gossip `DiscoveryAgent` | ✅ Done | Deleted `discovery-agent.ts` |
| E.9 | Integration tests | ✅ Done | `test/etcd-state-store.test.ts`, `test/etcd-cluster.test.ts` |

### What etcd replaced

| Was | Became |
|---|---|
| Gossip (SWIM) for agent-to-node routing | etcd `/agents/*` + watch via `EtcdMembership` |
| In-memory agent registry per RC | StateStore-backed registry with local cache + watch |
| Ad hoc CronAgent per-node | Lease-based leader election (`LeaderElection`) → single CronAgent |
| No trigger dedup across nodes | `putIfAbsent` CAS locks in `TriggerMatcher` |
| AddressPage (static discovery) | etcd `/nodes/*` + leases via `EtcdMembership` |
