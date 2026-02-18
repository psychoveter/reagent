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

## M2-LANG — Language v0.1: wildcard lang tag, typed messages, RAP specs ✅ DONE

**Intent**: extend the Reagent language with two features needed for describing wire-only protocols (RAP, A2A), then update all existing examples and write the RAP sub-protocol specs. Bumps language to v0.1.

### Phase A: `[*]` wildcard lang tag

**Syntax**: `participants: adapter [*], orchestrator [*]`

**Semantics**: `[*]` = language not fixed by the protocol. Zone blocks and `onSend`/`onReceive` hooks are forbidden for `[*]` roles. IR emits `lang: "*"`.

**Changes**:
- `lang/src/parser.ts`: accept `*` as valid lang tag token
- `lang/src/ir.ts`: `LangTag` type gets `"*"` variant
- `lang/src/ir-emitter.ts`: emit `lang: "*"`, skip zone emission for `[*]` roles
- `lang/src/ir-validator.ts`: reject zone blocks on `[*]` roles
- `lang-spec.md`: document in §1.1, update EBNF `LangTag` production
- `tools/reagent-vscode/`: update TextMate grammar

### Phase B: typed messages

**Syntax**: `message Register { adapterId: string, capabilities: string[] }`

**Semantics**: top-level `message` construct defines payload shape. System fields (`instanceId`, `protocolName`, etc.) are implicit (envelope). Types: `string`, `number`, `boolean`, `any`, `type[]`, `{ field: type }`, `type?`. Duck typing. Backward compatible — untyped messages remain valid.

**Changes**:
- `lang/src/parser.ts`: parse `message Name { fields }`
- `lang/src/ast.ts`: `MessageDef`, `FieldDef`, `TypeExpr` nodes
- `lang/src/ir-emitter.ts`: emit `IRMessageSchema[]` alongside graphs
- `lang/src/ir-validator.ts`: warn on undeclared message names (not error)
- `lang-spec.md`: new §1.14 "Message types", update EBNF

### Phase C: update existing examples (22 files)

Migrate all `.rg` examples to use the new features where appropriate:

**`[*]` wildcard** — 13 files have roles with no zones:
- `sia [ts]` → `sia [*]` in: 00, 01, 02, 03, 06, 07, 08, 09, 10, 12, task-execution
- `worker1 [ts]`, `worker2 [ts]` → `[*]` in: 04
- `planner [ts]` → `planner [*]` in: 05
- `llmbroka [ts]` → `llmbroka [*]` in: 11
- `monitor [ts]` → `monitor [*]` in: 12 (HealthCheck)
- Files 13-20: all roles have zones — keep concrete lang tags

**Typed messages** — add `message` definitions for all 22 files. Every `MessageName` used in `A --> B: MessageName` gets a `message` declaration with typed fields.

**Recompile all**: verify all 22 examples compile, IR is valid, existing E2E tests T1-T20 still pass.

### Phase D: RAP sub-protocol specs

Write 7 RAP `.rg` files in `examples/rap/` using `[*]` and typed messages:
- `AdapterHandshake.rg`
- `CompileRequest.rg`
- `DeployAgent.rg`
- `RunProtocol.rg`
- `DebugSession.rg`
- `InspectState.rg`
- `SetBreakpoints.rg`

Compile all to IR. Derive JSON wire format schema from IR message definitions.

### Results

**Phase A** ✅ — `[*]` wildcard lang tag:
- `ast.ts`: `LangTag` union extended with `"*"`
- `parser.ts`: `VALID_LANG_TAGS` includes `"*"`, special-case token parsing for `*` (not a valid ident char), `[*]` rejected in `agent` definitions
- `ir-emitter.ts`: zone blocks on `[*]` roles produce a compile error
- `lang-spec.md` §1.1 + EBNF updated
- `reagent.tmLanguage.json`: langTag + agentDef patterns updated

**Phase B** ✅ — typed messages:
- `ast.ts`: `MessageDef`, `FieldDef`, `TypeExpr` (`ScalarType`/`ArrayType`/`ObjectType`/`AnyType`) types added, `TopLevelItem` extended
- `parser.ts`: `pMessageDef`, `pFieldList`, `pTypeExpr` functions; `parseProgram` dispatches `message` keyword; comma-separated and newline-separated fields supported
- `ir.ts`: `IRMessageSchema`, `IRFieldSchema` types
- `ir-emitter.ts`: `emitMessageSchema()` function
- `cli.ts`: compile outputs `messages.json`, deployment manifest references it
- `lang-spec.md` §1.14 + EBNF updated; v0.1.0 changelog added
- `reagent.tmLanguage.json`: `messageDef` + `messageFieldType` rules, `message` added to keywords

**Phase C** ✅ — 25 files updated (22 examples + 3 libs):
- 14 `[*]` wildcard substitutions across 13 files (sia, monitor, llmbroka)
- `message` definitions added to all 25 files
- All recompiled to `examples/out/`; validation passes on all

**Phase D** ✅ — 7 RAP sub-protocol specs:
- `examples/src/rap/01-adapter-handshake.rg` (2 roles, 3 messages, alt branching)
- `examples/src/rap/02-compile-request.rg` (2 roles, 3 messages, alt branching)
- `examples/src/rap/03-deploy-agent.rg` (2 roles, 3 messages, alt branching)
- `examples/src/rap/04-run-protocol.rg` (2 roles, 2 messages, linear)
- `examples/src/rap/05-debug-session.rg` (3 roles, 2 messages, relay pattern)
- `examples/src/rap/06-inspect-state.rg` (3 roles, 2 messages, relay pattern)
- `examples/src/rap/07-set-breakpoints.rg` (2 roles, 2 messages, linear)
- All compile to IR + message schemas in `examples/out/rap/`

---

## M3-RT — Multi-runtime orchestrator and debugger ⬜ NEXT

**Intent**: build the orchestration and debug infrastructure based on the RAP specs from M2-LANG. Replaces the old M2-RT plan with the new architecture (ROS + RAP adapters + unified debug protocol).

See [multi-runtime debug architecture plan](../.cursor/plans/multi-runtime_debug_architecture_d3fed9bd.plan.md) for full design.

### Phase 1: ROS (Reagent Orchestrator Server)

Node.js process with WebSocket server:
- Adapter registration (`AdapterHandshake` RAP sub-protocol)
- Compilation on demand (`CompileRequest`)
- Session management (deploy, start, trace aggregation)
- Source map management (IR state ID → `.rg` line)
- Breakpoint resolution

### Phase 2: TS + Python reference adapters

Extract `AgentRunner` into adapter processes with WebSocket RAP clients:
- `SteppableProtocolInstance` wrapper: `beforeAdvance` hook for step/breakpoint
- State inspection (already exists: `getTraces()`, `getSelf()`, `ctx`)
- Extend `TraceEventKind` with debug events: `Paused`, `Resumed`, `StateSnapshot`, `BreakpointHit`

E2E tests:
- **T21**: Launch protocol in step mode, step through 3 transitions, verify state after each.
- **T22**: Set breakpoint on message name, run, verify execution pauses at correct point.
- **T23**: Inspect `$ctx` and `$self` at pause point, verify values match expected.

### Phase 3: VSCode extension (RAP client)

WebSocket client + debug panel webview:
- IR graph visualization (render IRGraph as interactive state machine, highlight current state)
- Trace timeline (real-time event stream, filterable)
- Agent state cards (`$ctx` + `$self` viewers)
- Breakpoint gutter markers in `.rg` editor
- `launch.json` integration, "Debug Protocol" button

### Phase 4: Source mapping and step-through

- Compiler emits IR state ID → `.rg` source location map
- Step-through highlights current `.rg` line when paused
- Inline value decorations (`$ctx.foo = "bar"`)

### DoD
- ROS runs, adapters connect via RAP WebSocket.
- Debug server supports step/continue/breakpoints via RAP sub-protocols.
- VSCode panel shows live protocol graph, agent states, trace timeline.
- Breakpoints set in `.rg` source pause execution at the correct IR state.
- T21–T23 pass.

---

## Future work (backlog)

Ideas and milestones considered but not yet scheduled.

- **Role multiplicity** (`many` / `foreach`): dynamic participant sets, fan-out/fan-in, subset selection. Needed for auction/CFP protocols. Significant language extension — requires research on dynamic fork/join, convergence semantics.
- **Engine API v0**: extract a formal language-neutral runtime contract from reference runners. Define `StartInstance`, `SubmitEvent`, `StreamTrace`, `ExecuteAction`, `Cancel`. Reference runners become the reference implementation.
- **Losos engine adapter**: map Reagent IR to Losos Guard-Action network + etcd keyspace. Run Engine API conformance suite against Losos.
- **Losos Guards 2.0**: multi-slot, OR/AND/XOR, timeouts — close semantic gaps between IR and Losos.
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
| `[*]` wildcard lang tag | `lang: "*"` in IR | M2-LANG / A ✅ | — |
| Typed messages | `IRMessageSchema` | M2-LANG / B ✅ | — |
| Examples updated (22+3) | `[*]` + `message` defs | M2-LANG / C ✅ | — |
| RAP sub-protocols | 7 `.rg` specs | M2-LANG / D ✅ | — |
| Debug server (ROS) | step, breakpoints, inspect | M3-RT / 1-2 | T21–T23 |
| Debug UI (VSCode) | graph, timeline, state cards | M3-RT / 3-4 | — |
