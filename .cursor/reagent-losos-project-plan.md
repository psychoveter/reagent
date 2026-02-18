## Reagent project plan (milestones)

Goal: build a **language + reference runtimes + production engine** stack for agentic protocols.

- **Reagent** is the language and compiler (`lang/`).
- **Reference runners** (TS + Python over NATS) are the test-driven development target.
- **Losos** (Kotlin/etcd) is the future production engine.

Development is **E2E test-driven**: each feature starts with a `.rg` example, compiles to IR, runs on reference runners, and is validated by trace assertions.

---

## M0 — Baseline: reproducible Losos test harness on etcd 3.6 ✅ DONE

Frozen working environment for Losos. Docker-compose harness, etcd v3.6.0.

---

## M1 — Reagent language & spec hardening ✅ DONE (language v0.0.4)

Language surface stable. 13 examples, lang-spec with EBNF, core spec with TraceEvent algebra.

---

## M2 — TypeScript AST + Parser + IR design ✅ DONE (v0.0.5)

Full compiler pipeline: AST types → recursive-descent parser → IR emitter (Protocol IR + Agent IR) → IR validator → CLI.

| Component | Path |
|---|---|
| AST types | `lang/src/ast.ts` |
| Parser | `lang/src/parser.ts` |
| IR types | `lang/src/ir.ts` |
| IR emitter | `lang/src/ir-emitter.ts` |
| IR validator | `lang/src/ir-validator.ts` |
| CLI | `lang/src/cli.ts` |

All 22 examples compile and validate. Agent IR emitted for examples 12–20.

---

## M-RT — Reference runtimes v0 ✅ DONE

Lightweight TS + Python AgentRunners interpreting IR JSON over NATS.

**Implemented:**
- AgentRunner (agent lifecycle, $self, message routing, lifecycle handlers)
- ProtocolInstance (IRGraph state machine interpreter)
- Zone execution (eval/exec with $ctx + $self + reagent)
- NATS transport, message envelope, trace events
- Orchestrator (compile + launch + trace collection)
- CLI: `reagent-lang compile <file.rg> <out-dir>`
- 5 E2E tests passing (linear, alt-accept, alt-reject, cross-lang IR, $self persistence)

**Supported IR states:** `initial`, `send`, `receive`, `action`, `guard(xor/expression)`, `terminal`.

---

## M1-RT — Reference runners: full spec support ✅ DONE

**Intent**: incrementally add every remaining Reagent construct to the reference runners, each driven by a new `.rg` example + E2E tests.

**Result**: all 20 E2E tests pass (T1–T20). Every Reagent language construct is now executable on both TS and Python reference runners, including cross-language interop.

**New components added:**
- `trace-validator.ts` — post-hoc trace legality checker against IR
- `py_agent_runner.py` — Python subprocess harness for cross-language E2E
- 6 new `.rg` examples (15–20)

**Key implementation patterns:**
- **Non-deciding agents**: expression guards (loops) and try/catch use message-wait-fallback — the agent that can't evaluate a guard waits for whichever message arrives from the deciding agent's branch.
- **`reagent.invoke`**: sentinel-and-replay — `invoke()` throws `InvokeRequest`, runtime catches it, runs child protocol, then re-executes the zone with a patched stub that returns the cached result.
- **`reagent.spawn` / `reagent.emit`**: non-throwing — callbacks fire inline within the zone execution, no replay needed.
- **Python zone compatibility**: `AttrDict` wrapper enables `ctx.msg.text` attribute access on dicts; `_dedent` normalizes indentation for `exec()`.

### Phase A: loop + wait ✅

- Example: `15-loop-and-wait-demo.rg`
- IR states: `guard(expression)` with back-edge, `timer`
- Runtime: loop guard re-evaluation, `setTimeout` (TS) / `asyncio.sleep` (Py), `expressionVarsAreDefined` fallback
- **T6** ✅ Loop executes N iterations then exits
- **T7** ✅ Wait delays execution by specified duration
- **T8** ✅ $self accumulates state across loop iterations

### Phase B: par (fork/join) ✅

- Example: `16-parallel-demo.rg`
- IR states: `fork`, `join`
- Runtime: `Promise.all` (TS) / `asyncio.gather` (Py) for concurrent branches
- **T9** ✅ Two parallel branches both complete, join fires once
- **T10** ✅ Parallel branches interact with different agents

### Phase C: try/catch ✅

- Example: `17-try-catch-demo.rg`
- IR states: `error` transitions, catch routing
- Runtime: `tryCatchMap` for error→catch routing, `handleReceiveWithErrorFallback` for non-deciding agents
- **T11** ✅ Zone throws → catch block executes → protocol completes
- **T12** ✅ No error → try body completes normally, catch skipped

### Phase D: reagent.invoke (child protocols) ✅

- Example: `18-invoke-demo.rg`
- Runtime: `InvokeRequest` / `ReturnValue` sentinels, `AgentRunner.invokeChildProtocol`
- **T13** ✅ Parent invokes child → child completes → parent receives return value
- **T14** ✅ Child failure propagates as error to parent

### Phase E: reagent.spawn + reagent.emit ✅

- Example: `19-spawn-emit-demo.rg`
- Runtime: non-throwing `spawn`/`emit` on bound reagent stub, `AgentRunner.spawnChildProtocol` / `handleEmit`
- **T15** ✅ Spawn starts child instance, parent continues without waiting
- **T16** ✅ Emit triggers agent lifecycle handler

### Phase F: cross-language E2E (TS ↔ Py) ✅

- Example: `20-cross-lang-e2e.rg`
- Runtime: Python agent runs as subprocess (`py_agent_runner.py`), NATS message exchange with TS agent
- **T17** ✅ TS → Python → TS message flow, both agents complete
- **T18** ✅ Python agent's $self state persists, lifecycle handler fires

### Phase G: trace validation + legality ✅

- Component: `trace-validator.ts`
- Walks IR state machine, builds expected message sequence, compares against actual trace
- **T19** ✅ Inject illegal message → validator detects violation
- **T20** ✅ Missing message → validator detects incomplete trace

---

## M2-RT — Protocol debugger: UI + debug server for the VSCode extension ⬜ NEXT

**Intent**: build a protocol debugging experience inside Cursor/VSCode. The extension connects to a running (or stepping) reference runtime, collects execution traces in real time, and visualizes the protocol state machine with agent states overlaid.

### Why

Right now we can run protocols and assert on traces in tests, but there is no way to **see** what's happening: which state each agent is in, what messages are in flight, what `$ctx` and `$self` contain at each step. For a distributed protocol language, visual debugging is essential — both for language development and for end users.

### Architecture

```
┌──────────────────────────────────────────────────┐
│  Cursor / VSCode                                 │
│  ┌────────────────────────────────────────────┐  │
│  │  reagent-vscode extension                  │  │
│  │  ┌──────────┐  ┌───────────────────────┐   │  │
│  │  │ .rg      │  │ Debug Panel (webview) │   │  │
│  │  │ editor + │  │ - protocol graph      │   │  │
│  │  │ syntax   │  │ - agent state cards   │   │  │
│  │  │ highlight│  │ - trace timeline      │   │  │
│  │  └──────────┘  │ - $ctx / $self viewer │   │  │
│  │                │ - message log         │   │  │
│  │                └───────┬───────────────┘   │  │
│  └────────────────────────┼───────────────────┘  │
│                           │ WebSocket / DAP       │
└───────────────────────────┼──────────────────────┘
                            │
               ┌────────────▼────────────┐
               │  Reagent Debug Server   │
               │  (Node.js process)      │
               │                         │
               │  - Loads IR + deployment │
               │  - Runs AgentRunners    │
               │  - Controls stepping    │
               │  - Streams traces       │
               │  - Exposes agent state  │
               └────────────┬────────────┘
                            │ NATS
               ┌────────────▼────────────┐
               │  NATS Server            │
               └─────────────────────────┘
```

### Phase 1: Debug server (headless)

A standalone Node.js process that wraps the existing reference runtime with debug controls:

1. **Debug server** (`runtime/debug-server.ts`):
   - Compiles `.rg` → IR.
   - Creates AgentRunners in-process (all TS for v0; Python via child process later).
   - Exposes a WebSocket API for debug clients.
   - Supports execution modes:
     - **Run** — normal execution, streams trace events in real time.
     - **Step** — pause before each state transition; client sends `step` / `stepOver` / `continue`.
     - **Breakpoints** — pause when a named state / message / agent zone is reached.
   - Exposes introspection:
     - Current state per agent per protocol instance.
     - `$ctx` and `$self` snapshots at any pause point.
     - Message queue (pending receives).
     - Full trace so far.

2. **Debug protocol** (WebSocket JSON messages):
   - Client → Server: `launch`, `step`, `stepOver`, `continue`, `pause`, `setBreakpoints`, `getState`, `getTrace`.
   - Server → Client: `stopped` (at breakpoint/step), `traceEvent`, `agentStateChanged`, `protocolCompleted`, `error`.

3. E2E tests for debug server:
   - **T21**: Launch protocol in step mode, step through 3 transitions, verify state after each.
   - **T22**: Set breakpoint on message name, run, verify execution pauses at correct point.
   - **T23**: Inspect `$ctx` and `$self` at pause point, verify values match expected.

### Phase 2: VSCode debug panel (webview)

Extend `reagent-vscode` with a debug experience:

1. **Protocol graph visualization**:
   - Render the IRGraph as a visual state machine (nodes = states, edges = transitions).
   - Highlight the current state per agent in real time.
   - Color-code: active (running), paused (at breakpoint), completed, failed.

2. **Agent state cards**:
   - One card per agent showing: name, language, current protocol instance(s), `$self` snapshot.
   - Click to expand: `$ctx` for each active instance.

3. **Trace timeline**:
   - Vertical timeline of trace events (ProtocolStarted, MessageSent, ActionStarted, ...).
   - Click on event to see full payload.
   - Filter by agent, by event kind, by protocol instance.

4. **Message log**:
   - All messages in flight and delivered.
   - From/to (agent + role), payload, timestamp.

5. **Breakpoint integration**:
   - Set breakpoints in `.rg` source (on message steps, agent zones, alt branches).
   - Extension maps `.rg` source locations to IR state IDs.
   - Gutter markers in `.rg` editor for breakpoints.

6. **Launch configuration**:
   - `launch.json` support: specify `.rg` file, input, NATS URL.
   - "Debug Protocol" button in `.rg` editor title bar.

### Phase 3: Source mapping and step-through in `.rg` editor

1. **Source map**: compiler emits a map from IR state IDs back to `.rg` source locations.
2. **Step-through**: when paused, highlight the current line in the `.rg` editor.
3. **Inline values**: show `$ctx.foo = "bar"` as inline decorations next to the corresponding `.rg` line (similar to debugger inline values).

### DoD
- Debug server runs a protocol with step/continue/breakpoints.
- VSCode panel shows live protocol graph, agent states, trace timeline.
- Breakpoints set in `.rg` source pause execution at the correct IR state.
- T21–T23 pass.

---

## Future work (backlog)

Ideas and milestones considered but not yet scheduled. Will be prioritized after M2-RT.

- **Engine API v0**: extract a formal language-neutral runtime contract from reference runners. Define `StartInstance`, `SubmitEvent`, `StreamTrace`, `ExecuteAction`, `Cancel`. Reference runners become the reference implementation.
- **Losos engine adapter**: map Reagent IR to Losos Guard-Action network + etcd keyspace. Run Engine API conformance suite against Losos.
- **Losos Guards 2.0**: multi-slot, OR/AND/XOR, timeouts — close semantic gaps between IR and Losos.
- **Typed messages + role stubs**: message schemas (JSON Schema / Protobuf), versioning, validation hooks, generated role stubs and test harnesses.
- **Multi-language execution via Engine API**: Python runner talks to Losos engine through Engine API.
- **Observability**: TraceEvent → OpenTelemetry mapping, trace divergence detection, "why blocked" queries.
- **Production hardening**: AuthN/AuthZ, quotas, backpressure, operational tooling, crash recovery.

---

## Reference runner feature matrix

| Construct | IR state(s) | Milestone | E2E tests |
|---|---|---|---|
| Message send/receive | `send`, `receive` | M-RT ✅ | T1 |
| Agent zone (action) | `action` | M-RT ✅ | T1 |
| Alt (expression guard) | `guard(xor)` | M-RT ✅ | T2, T3 |
| Agent $self + lifecycle | AgentIR | M-RT ✅ | T5 |
| Loop | `guard(expression)` + back-edge | M1-RT / A ✅ | T6, T8 |
| Wait/timer | `timer` | M1-RT / A ✅ | T7 |
| Par (fork/join) | `fork`, `join` | M1-RT / B ✅ | T9, T10 |
| Try/catch | `error` + catch routing | M1-RT / C ✅ | T11, T12 |
| reagent.invoke | zone → child instance → return | M1-RT / D ✅ | T13, T14 |
| reagent.spawn + emit | zone → independent instance | M1-RT / E ✅ | T15, T16 |
| Cross-language (TS↔Py) | all | M1-RT / F ✅ | T17, T18 |
| Trace validation | post-hoc IR check | M1-RT / G ✅ | T19, T20 |
| Debug server | step, breakpoints, inspect | M2-RT | T21–T23 |
| Debug UI (VSCode) | graph, timeline, state cards | M2-RT | — |
