# M13-TESTS: test coverage design doc

**Date:** 2026-02-28
**Status:** Draft
**Depends on:** M12-DX (done)

---

## Motivation

The codebase has ~220 tests across 25 files, covering core E2E (T1–T20), controller (C1–C12), lang features (T28–T36), ROS/debug (T21–T27), and component-specific suites (registry, fingerprints, reconciler, triggers, scatter, gossip, OTel, custom agents, state store, resolve). This is solid for the legacy and first-gen components.

However, the M8b–M12 additions created significant new subsystems that are under-tested or untested:

| Component | LOC | Direct tests | Gap |
|-----------|-----|-------------|-----|
| GateSession + GateTransport (Ws/Stdio/Http) + MessageGateNode | ~390 | 2 (GA1–GA2: unit only) | No E2E through real transports; no lifecycle; no scatter-through-gate |
| ProtocolEngine | 316 | 0 direct (only via CA1) | No isolated advance/alt/scatter/invoke tests |
| Python CustomAgentNode + ManagedAgentAdapter + ProtocolEngine | ~540 | 0 | TS equivalents have CA1–CA2; Py has nothing |
| Python ResolvePolicyEvaluator | 267 | 0 | TS has 12 tests in m11-state-resolve |
| Cross-runtime conformance | — | 0 | R4 in post-M12 backlog, never started |
| Compiler: project.ts (resolveImport, loadReagentJson) | 273 | 0 | Package system foundation, untested |
| Compiler: ir-validator.ts | 174 | 0 direct | Only indirect via compilation tests |
| Compiler: diagram.ts | 629 | 0 | Sequence + state-machine diagram generation |
| All 30 .rg examples compile | — | Partial (00–03 in TLA5) | 26 examples have no compilation test |
| LSP feature tests | 1,686 server LOC | 4 smoke (capabilities, parse, keywords, status) | No go-to-def, hover, completion, diagnostics feature tests |
| Debug: DebugController, AdvanceHook, Interceptor | ~570 | 0 direct (via ROS E2E only) | No unit tests; all debug testing is through T21–T27 |
| RegistryView | 123 | 0 | buildView, findAgents, findProtocols |
| DAP adapter | 1,137 | 0 | Launch, attach, breakpoints, variables — all manual |

---

## Test inventory

### Phase 1: Message Gate E2E (3 days)

**File:** `runtime/tests/m13-gate.test.ts`

Tests the full Gate pipeline: RC → GateSession → Transport → external agent → response → RC. Each transport is tested with a real (or realistic) implementation.

| ID | Test | Description | Priority |
|----|------|-------------|----------|
| GT.1 | WsGateTransport E2E | Start WS server, RC sends events through WsGateTransport, mock agent on other end responds. Full protocol cycle (action → send_required → receive → complete). Verify trace matches expected. | **P0** |
| GT.2 | StdioGateTransport E2E | RC spawns a child process (simple Node.js script that reads stdin JSON lines and writes responses to stdout). Full protocol cycle through stdin/stdout. | **P0** |
| GT.3 | HttpGateTransport E2E | Start HTTP server, RC sends events via POST, server responds with AgentResponse JSON. Verify request/response cycle. | P1 |
| GT.4 | GateSession timeout | sendAndWait with 100ms timeout, no response sent → expect timeout error. Verify session transitions to error state. | P1 |
| GT.5 | GateSession error recovery | After error state (e.g., timeout), subsequent sendAndWait should immediately reject. | P2 |
| GT.6 | MessageGateNode lifecycle | createAgent → run protocol to completion → destroyAgent. Verify session cleanup, transport closed. | **P0** |
| GT.7 | Gate + scatter | 3 gate-connected agents participate in a scatter protocol. Each receives their scatter branch event, responds. Coordinator accumulates results. | **P0** |
| GT.8 | StdioGateTransport buffer edge cases | (a) Partial JSON line split across two data chunks. (b) Multiple JSON lines in one chunk. (c) Non-JSON output on stdout (should be ignored). | P1 |

**Fixtures:** Use example `14-ts-only-demo` IR (already used by wave2-custom). For GT.2, write a 20-line Node.js agent script in `runtime/tests/fixtures/stdio-agent.mjs`. For GT.7, use `23-scatter-gather` IR.

### Phase 2: ProtocolEngine unit tests (2 days)

**File:** `runtime/tests/m13-engine.test.ts`

Isolate ProtocolEngine from RC, AgentNode, transport. Feed IR + events directly, verify emitted ProtocolEvents and state transitions.

| ID | Test | Description | Priority |
|----|------|-------------|----------|
| PE.1 | Linear advance | Load linear protocol IR. Call advance() → expect `action` event. Feed `ctx_update` response → advance → expect `send_required`. Feed `send_payload` → advance → expect `protocol_completed`. Verify status = completed. | **P0** |
| PE.2 | Alt branching | Load alt protocol IR. Advance to alt state → engine emits event for guard evaluation. Feed response choosing branch A → verify engine takes branch A. Repeat test choosing branch B. | **P0** |
| PE.3 | Loop with guard | Load loop protocol IR. advance() through 3 iterations (guard true), then guard false → engine exits loop. Verify iteration count matches. | P1 |
| PE.4 | $ctx propagation | After each zone execution, verify $ctx contains expected keys. Verify $ctx.msg is populated for receive events and cleared after consumption. | **P0** |
| PE.5 | Scatter events | Load scatter IR. advance() → engine emits `scatter_required` with items. Simulate per-branch execution. Feed gathered results → engine continues past scatter. | **P0** |
| PE.6 | Invoke events | Load invoke IR. advance() → engine emits `invoke_required` with target protocol. Feed invoke result → engine resumes with return value in $ctx. | P1 |
| PE.7 | Engine status transitions | Verify: idle → running (after first advance), running → completed (after terminal state), running → failed (after unhandled error). Advance after completed → throws. | P1 |

**Fixtures:** Compile examples 00 (linear), 02 (alt), 03 (loop), 23 (scatter), 07 (invoke) to IR JSON. Load directly into ProtocolEngine.

### Phase 3: Python parity tests (3 days)

**File:** `runtime/tests/test_m13_py_parity.py`

Mirror the TS tests that have no Python equivalent. These validate that the Python runtime produces the same behavior as TS for the new M8b–M12 abstractions.

| ID | Test | Description | Priority |
|----|------|-------------|----------|
| PP.1 | Python ProtocolEngine unit (linear) | Same as PE.1 but in Python. Load IR JSON, call engine.advance(), verify events. | **P0** |
| PP.2 | Python ProtocolEngine unit (alt) | Same as PE.2 in Python. | P1 |
| PP.3 | Python ManagedAgentAdapter | Create adapter with zone executor, feed ActionRequired event → adapter executes zone → returns ctx_update. | **P0** |
| PP.4 | Python CustomAgentNode + RC | Register a CustomAgentNode with a Python AgentInterface impl. Run linear protocol through RC. Verify handle() called with correct events. | **P0** |
| PP.5 | Python ResolvePolicyEvaluator | Mirror TS m11-state-resolve tests: all, first, filter by tag, filter by label, roundRobin, sample, fallback, from(). Register agents in StateStoreAgentRegistry, evaluate pipelines. | **P0** |
| PP.6 | Python StateStore + AgentRegistry | Mirror TS m11 tests: get/put/delete, list prefix, putIfAbsent, watch events, register/find/deregister agents. | P1 |
| PP.7 | Python scatter through RC | Load scatter IR, run through Py RC with InprocAgentNode. Verify all scatter branches execute and results accumulate. | **P0** |

**Fixtures:** Same IR JSON files as Phase 2 tests.

### Phase 4: Cross-runtime conformance (2 days)

**File:** `runtime/tests/m13-conformance.test.ts`

Load the same IR JSON into both TS RC and Py RC (via subprocess), run the same protocol, capture traces, compare. This is R4 from the post-M12 backlog.

| ID | Test | Description | Priority |
|----|------|-------------|----------|
| CF.1 | Conformance: linear | Run 14-ts-only-demo IR on TS RC and Py RC. Normalize traces (strip timestamps, nodeIds). Compare: same state sequence, same messages, same $ctx snapshots. | **P0** |
| CF.2 | Conformance: alt (both branches) | Run 02-await-timeout-and-alt IR. Force same branch in both RCs. Compare traces. | **P0** |
| CF.3 | Conformance: loop | Run 03-loop-retry-backoff IR. Verify same iteration count and exit condition. | P1 |
| CF.4 | Conformance: invoke | Run 07-child-protocol-invoke IR. Verify child protocol trace + return value identical. | P1 |
| CF.5 | Conformance: scatter | Run 23-scatter-gather IR. Verify branch count, per-branch events, gathered results identical. | P1 |

**Mechanism:** TS test spawns `python -m reagent_runtime` as subprocess, sends IR + input via IPC (JSON-line protocol already exists in `ipc_agent.py`). Both RCs write traces to temp files. Test loads and compares.

### Phase 5: Compiler regression (1.5 days)

**File:** `lang/test/m13-compiler.test.ts`

| ID | Test | Description | Priority |
|----|------|-------------|----------|
| CR.1 | All .rg examples compile | Iterate all 30 files in `examples/protocols/src/*.rg` + `examples/projects/auction-sim/protocols/auction.rg`. Each must compile without errors. Assert: no thrown exceptions, IR output has states and transitions. | **P0** |
| CR.2 | Compile → decompile → recompile: all examples | Extension of D1. For each example: compile → decompile → recompile → compare fingerprints. At least 25 of 30 must round-trip (some may have known limitations). | P1 |
| CR.3 | TLA+ generation: scatter + par | Generate TLA+ for examples 04 (parallel), 16 (parallel-demo), 23 (scatter-gather). Verify output is syntactically valid (parse with regex for `MODULE` / `VARIABLES` / `Init` / `Next`). | P1 |
| CR.4 | project.ts: resolveImport | Unit tests for `resolveImport()`: relative path (`./messages.rg`), package path (`@reagent/system/protocols/rap/...`), bare import. Verify resolved file path. | **P0** |
| CR.5 | project.ts: loadReagentJson + compileProject | Load `auction-sim/reagent.json`, call `compileProject()`, verify all protocol IR outputs exist with expected role names. | **P0** |

**Fixtures:** Existing `examples/` directory. For CR.4, create a minimal `reagent_packages/` temp directory.

### Phase 6: LSP feature tests (2 days)

**File:** `tools/reagent-vscode/server/test/m13-lsp.test.ts`

Extend the existing LSP test harness (from M12 P.5). Each test opens a .rg document, sends an LSP request, asserts the response.

| ID | Test | Description | Priority |
|----|------|-------------|----------|
| LS.1 | Go-to-definition: message reference | Open a .rg file with `seller --> buyer: Bid`. Send textDocument/definition on `Bid`. Expect location pointing to `message Bid { ... }` definition. | **P0** |
| LS.2 | Go-to-definition: protocol reference in invoke | Open a .rg file with `reagent.invoke("ChildProtocol")`. Send definition on `ChildProtocol`. Expect location of `protocol ChildProtocol { ... }`. | P1 |
| LS.3 | Diagnostics: undefined message | Open a .rg file referencing `UndefinedMsg`. Expect diagnostic with "undefined message" severity error. | **P0** |
| LS.4 | Diagnostics: missing resolve for dynamic participant | Define `dynamic many buyer` without `resolve:` in trigger. Expect diagnostic warning. | P1 |
| LS.5 | Completion: after `$ctx.` | Open a .rg file, cursor after `$ctx.` inside a zone. Expect completions containing fields set earlier in the protocol (e.g., `itemName`, `reservePrice`). | P1 |
| LS.6 | Hover: message definition | Hover on `Bid` in a send statement. Expect hover content showing message fields (`amount: number`). | P2 |

**Fixtures:** Create `server/test/fixtures/` with 2-3 small .rg files tailored for LSP testing.

### Phase 7: Debug unit tests (1 day)

**File:** `runtime/tests/m13-debug.test.ts`

Isolate DebugController, DebugAdvanceHook, DebugInterceptor from ROS. Test the debug infrastructure directly.

| ID | Test | Description | Priority |
|----|------|-------------|----------|
| DB.1 | DebugAdvanceHook: stateId breakpoint | Create hook with breakpoint on state "s3". Feed advance contexts. Verify: pauses on s3, continues on others. | P1 |
| DB.2 | DebugAdvanceHook: stateKind breakpoint | Create hook with breakpoint on kind "action". Feed advance contexts with various kinds. Verify: pauses only on action kind. | P1 |
| DB.3 | DebugInterceptor: message breakpoint | Create interceptor with breakpoint on messageName "Bid". Feed message envelopes. Verify: pauses on Bid, passes others. | P1 |
| DB.4 | DebugController: set/remove/step | Create controller. Set 2 breakpoints. Verify they fire. Remove one. Verify only remaining fires. Call step → advances one state. | P1 |

**Fixtures:** Minimal IR graph with 5 states. No ROS, no WebSocket.

### Phase 8: Untested components (1.5 days)

**File:** `runtime/tests/m13-misc.test.ts` + `lang/test/m13-misc.test.ts`

Grab-bag of components with 0 direct tests. Each gets 1-2 focused tests.

| ID | Test | Description | Priority | Component |
|----|------|-------------|----------|-----------|
| UC.1 | RegistryView: buildView | Create RC with 2 protocols, 4 agents. Build RegistryView. Verify protocols, agents, nodes arrays contain correct entries. | P1 | `registry-view.ts` |
| UC.2 | RegistryView: findAgents / findProtocols | Build view, query by protocolName/roleName. Verify correct subset returned. | P2 | `registry-view.ts` |
| UC.3 | ir-validator: reachability | Create IR graph with an orphan state (no path from init). Run validator. Expect warning/error about unreachable state. | P1 | `ir-validator.ts` |
| UC.4 | ir-validator: missing terminal | Create IR graph with no terminal state. Run validator. Expect error. | P1 | `ir-validator.ts` |
| UC.5 | diagram.ts: sequence diagram output | Compile a 2-role protocol, generate sequence diagram data. Verify: participant list, message arrows, state labels are present and correctly ordered. | P2 | `diagram.ts` |

---

## Priority summary

| Priority | Count | Definition |
|----------|-------|------------|
| **P0** | 21 | Must-have. Covers critical untested paths: Gate E2E, Engine core, Python parity, conformance, compiler project system, LSP go-to-def/diagnostics. |
| P1 | 19 | Should-have. Covers secondary scenarios: edge cases, additional protocol patterns, debug unit, ir-validator. |
| P2 | 7 | Nice-to-have. Polish: hover, diagram output, RegistryView queries, GateSession error recovery. |

## Effort summary

| Phase | P0 tests | Total tests | Effort | Blocks |
|-------|----------|-------------|--------|--------|
| 1. Gate E2E | 4 | 8 | 3d | — |
| 2. ProtocolEngine unit | 4 | 7 | 2d | — |
| 3. Python parity | 5 | 7 | 3d | — |
| 4. Conformance | 2 | 5 | 2d | Phase 3 (Py RC must pass parity first) |
| 5. Compiler regression | 3 | 5 | 1.5d | — |
| 6. LSP feature | 2 | 6 | 2d | — |
| 7. Debug unit | 0 | 4 | 1d | — |
| 8. Untested components | 0 | 5 | 1.5d | — |
| **Total** | **21** | **47** | **16d** | |

## Parallelization

Phases 1, 2, 5, 6, 7, 8 are fully independent — different files, different subsystems.

Phase 3 (Python parity) is independent of TS phases but requires Python runtime to be functional.

Phase 4 (Conformance) depends on Phase 3: Python RC must pass basic parity tests before cross-runtime comparison makes sense.

```
                Phase 1 (Gate E2E)
                Phase 2 (Engine)
                Phase 5 (Compiler)      ──→  all phases merge into CI
                Phase 6 (LSP)
                Phase 7 (Debug)
                Phase 8 (Misc)
                Phase 3 (Py parity) ──→ Phase 4 (Conformance)
```

With 2 parallel tracks: **~10 calendar days** (TS track + Py track).

## Test file naming convention

Following existing pattern: `<milestone>-<topic>.test.ts` for TS, `test_<milestone>_<topic>.py` for Python.

| File | Location |
|------|----------|
| `m13-gate.test.ts` | `runtime/tests/` |
| `m13-engine.test.ts` | `runtime/tests/` |
| `m13-conformance.test.ts` | `runtime/tests/` |
| `m13-debug.test.ts` | `runtime/tests/` |
| `m13-misc.test.ts` | `runtime/tests/` |
| `test_m13_py_parity.py` | `runtime/tests/` |
| `m13-compiler.test.ts` | `lang/test/` |
| `m13-lsp.test.ts` | `tools/reagent-vscode/server/test/` |
| `fixtures/stdio-agent.mjs` | `runtime/tests/fixtures/` |

## Fixture strategy

No new .rg protocols needed. All tests use existing compiled IR from `examples/out/`:

| IR fixture | Used by | Example source |
|------------|---------|----------------|
| `14-ts-only-demo/` | GT.1–GT.6, PE.1, PE.4, CF.1 | Linear two-role protocol |
| `02-await-timeout-and-alt/` | PE.2, CF.2 | Alt branching |
| `03-loop-retry-backoff/` | PE.3, CF.3 | Loop with guard |
| `07-child-protocol-invoke/` | PE.6, CF.4 | Invoke child protocol |
| `23-scatter-gather/` | PE.5, GT.7, CF.5, PP.7 | Scatter pattern |

For LSP tests: small inline .rg strings or dedicated fixtures in `server/test/fixtures/`.

## Exit criteria

1. All 47 tests pass in a single CI run
2. No regressions: existing ~220 tests still pass
3. Python conformance (CF.1–CF.2) produces identical normalized traces
4. Gate E2E tests (GT.1–GT.2) exercise real transports (WS, stdio), not just mocks
5. Coverage delta: at minimum, GateSession, ProtocolEngine, Python CustomAgentNode, `resolveImport()` each have ≥1 direct test
