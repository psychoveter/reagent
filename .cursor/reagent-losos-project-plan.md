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

Write 7 RAP `.rg` files using `[*]` and typed messages.

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
- 7 `.rg` files with typed messages, `[*]` roles, alt branching / relay patterns
- All compile to IR + message schemas
- Later moved to `tools/rap/` and upgraded with `role` definitions (see below)

---

## M3-LANG — Language v0.0.6: `role` construct + `implements` ✅ DONE

**Intent**: introduce `role` as a named multi-protocol interface contract and `implements` in agent definitions to adopt role bindings. Bumps language to v0.0.6.

**Design constraint**: IR remains a formal intermediate representation with a documented schema. It is also designed to be self-describing enough for coding agents (LLMs) to produce correct agent implementations from IR alone.

### Changes

**AST** (`lang/src/ast.ts`):
- `RoleDef`: `{ kind: "RoleDef", name, plays: PlaysDecl[], loc }`
- `AgentDef.implements: string[]` — list of role names
- `TopLevelItem` union extended with `RoleDef`

**Parser** (`lang/src/parser.ts`):
- `pRoleDef()`: parses `role Name { plays Proto as role ... }`
- `pAgentDef()`: parses `implements RoleName` inside agent body
- Top-level dispatch includes `role` keyword

**IR** (`lang/src/ir.ts`):
- `RoleIR`: `{ roleName, plays: AgentPlaysBinding[] }`
- `AgentIR.implements?: string[]`

**IR Emitter** (`lang/src/ir-emitter.ts`):
- `emitRoleIR()`: converts `RoleDef` → `RoleIR`
- `emitAgentIR()`: expands `implements` into plays bindings (deduplicates), reports error on unknown role names

**CLI** (`lang/src/cli.ts`):
- `compile` outputs `<RoleName>.role.json`
- `deployment.json` includes `roles` array
- `ir` and `validate` commands display role info

**TextMate grammar** (`tools/reagent-vscode/syntaxes/reagent.tmLanguage.json`):
- `roleDef`, `agentImplements` rules
- `role`, `implements` added to keywords

**Lang spec** (`docs/lang-spec.md`):
- §1.15 Role definition, §1.16 `implements` keyword
- EBNF updated: `RoleDef`, `RoleBody`, `ImplementsStmt`, `Program` production
- §4.5 Role IR, §4.6 CLI (renumbered), §4.7 Reference runtimes
- v0.0.6 changelog

**Examples**:
- `12-agent-multi-protocol.rg`: added `role CommaRole { ... }`, agent uses `implements CommaRole`
- All 22 examples + 3 libs + 7 RAP specs validate ✅
- All 20 E2E tests pass ✅

---

## M4-LANG — Language v0.0.7: role-centric refactoring ✅ DONE

**Intent**: promote `role` to the primary behavioral contract (lifecycle, state, inheritance) and reduce `agent` to a thin deployment binding (`agent Name runs RoleName`). Breaking change. Bumps language to v0.0.7.

### Changes

**AST** (`lang/src/ast.ts`):
- `RoleDef` gains: `lang?: LangTag`, `extends?: string`, `init?: RoleInitBlock`, `handlers: RoleOnHandler[]`
- `AgentDef` becomes thin: `{ kind: "AgentDef", name, lang?, runs: string, loc }`
- Old `AgentInitBlock`, `AgentEventKind`, `AgentOnHandler` removed; replaced by `RoleInitBlock`, `RoleEventKind`, `RoleOnHandler`

**Parser** (`lang/src/parser.ts`):
- `pRoleDef()`: parses `role Name [langTag]? extends Parent? { plays, init, on ... }`
- `pAgentDef()`: simplified to `agent Name [langTag]? runs RoleName`

**IR** (`lang/src/ir.ts`):
- `RoleIR`: rich — `{ roleName, lang?, extends?, plays, initAction?, lifecycleHandlers[] }`
- `AgentIR`: thin deployment binding — `{ agentName, lang, roleName, roleFile }` (no behavioral data, references role)

**IR Emitter** (`lang/src/ir-emitter.ts`):
- `emitRoleIR(role, roleMap)`: resolves `extends` chain, merges plays/init/handlers
- `emitAgentIR(agent, roleMap)`: produces thin binding, validates role exists and lang tags are compatible
- Circular extends detection, lang tag conflict detection

**CLI** (`lang/src/cli.ts`):
- All commands updated for new types
- `deployment.json` agents include `roleName`

**TextMate grammar** (`tools/reagent-vscode/syntaxes/reagent.tmLanguage.json`):
- `roleDef` pattern: lang tag, `extends`, `init`, `on` handler support
- `agentDef` pattern: simplified to single-line `agent Name [lang]? runs RoleName`
- `extends`, `runs` added to keywords; `implements` removed
- Old `agentInitBlock`, `agentOnHandler`, `agentImplements` replaced by `roleInitBlock`, `roleOnHandler`

**Lang spec** (`docs/lang-spec.md`):
- §1.13 Agent definition → deployment binding
- §1.15 Role definition → primary behavioral contract with lifecycle
- §1.16 Role inheritance via `extends`
- EBNF v0.0.7: updated `RoleDef`, `AgentDef`, new keywords
- §4.1–4.5 updated for new AST/IR structure
- v0.0.7 changelog

**Examples**:
- 9 examples rewritten: role+agent split (12–20)
- New example 21: `role-inheritance.rg` demonstrating `extends`
- All 23 examples + 3 libs + 7 RAP specs compile ✅
- All 20 E2E tests pass ✅

---

## M5-CTRL — Reagent Connectivity Layer ✅ DONE

**Intent**: decouple the runtime from NATS, introduce multi-agent nodes with loopback routing, a pluggable interceptor chain, and the platform abstraction for alternative runtimes. No separate messaging system underneath — Reagent is the messaging system.

Full design: [m5-ctrl-design.md (draft-3)](../docs/m5-ctrl-design.md).

### Core concepts

- **NodeRef / AgentRef**: two-level addressing. `NodeRef` knows how to deliver to a node; `AgentRef` composes `NodeRef` + agent name. `AgentRef` is the single addressing primitive (ActorRef pattern). `ref.send(messageName, payload)` constructs the envelope automatically.
- **ReagentTransport**: per-agent context from the RC. `transport.ref(agentName)` → `AgentRef`. `transport.onMessage(handler)` for inbound.
- **NodeLink**: thin bidirectional envelope pipe between nodes. No subjects, no pub/sub — just serialized envelopes. Implementations: `InMemoryNodeLink` (tests), `NatsNodeLink` (NATS-backed), `WsNodeLink`, `TcpNodeLink`.
- **ReagentController (RC)**: one per node process. Agent registry, routing table (`agentName → NodeRef`), `AgentRef`/`NodeRef` factory, interceptor chain, `NodeLink` management. Supports **multiple AgentNode backends** keyed by language (`agentNodes: Record<string, AgentNode>`). Does not know agent internals.
- **AgentNode**: platform abstraction (replaces old "ReagentAdapter"). Knows how to create agents from IR. RC calls `createAgent()`, gets opaque `AgentHandle`. Implementations: `NativeAgentNode` (wraps TS `AgentRunner`), `PythonAgentNode` (spawns Python child process with JSON-line IPC).
- **Two-level interception**: message-level interceptors (RC, observes `MessageEnvelope` traffic) + agent-level trace hooks (`TraceHook` callback, observes internal state machine events like `ProtocolStarted`, `ActionFinished`).
- **Address pages**: static routing info distributed by orchestrator. Future: P2P gossip.

### Phase A: Define interfaces + refactor transport usage ✅

- Define `NodeRef`, `AgentRef`, `ReagentTransport`, `NodeLink` in `transport.ts`.
- Define `AgentNode`, `AgentHandle` in `agent-node.ts`.
- Define `InterceptorFn`, `InterceptorContext` in `interceptor.ts`.
- Refactor `ProtocolInstance`: use `ReagentTransport`, send via `ref.send()`, trace via `TraceHook`.
- Refactor `AgentRunner`: accept `ReagentTransport` in config.
- `NatsCompatTransport` shim wraps old `NatsTransport` as `ReagentTransport` for legacy E2E tests.

### Phase B: InMemoryNodeLink + ReagentController ✅

- `InMemoryNodeLink`: in-process envelope dispatch for tests.
- `ReagentController`: agent registry, routing table, ref factory, interceptor chain, `NodeLink` management, `createTransport()`, `triggerProtocol()`, `applyAddressPage()`.

### Phase C: NativeAgentNode + wiring ✅

- `NativeAgentNode` wraps `AgentRunner` as `AgentHandle`.
- Node startup code: reads deployment plan, creates RC + `NativeAgentNode` + `NodeLink`s, registers agents.

### Phase D: E2E validation + multi-node ✅

- All 20 existing E2E tests (T1–T20) pass on new architecture (single-node, all loopback via `NatsCompatTransport` shim).
- New `.rg` example: `22-multi-protocol-agent.rg` (one agent in two concurrent protocols).
- 11 new functional E2E tests (C1–C11) all pass.

### Phase E: Python runtime bridge + multi-AgentNode RC ✅

- `ReagentController` refactored to accept `agentNodes: Record<string, AgentNode>` — multiple backends keyed by language (`"ts"`, `"py"`, etc.). Backward compatible with single `agentNode`.
- `PythonAgentNode` + `PythonAgentHandle`: spawns Python child process running `ipc_agent.py`, bridges stdin/stdout JSON-line IPC to `AgentHandle` interface.
- Python `LocalTransport`: stdout-based transport replacing `NatsTransport` for IPC mode. No NATS needed.
- Python `AgentRunner` refactored: accepts either `natsUrl` or pre-built `transport` object. Public `dispatch_message()` / `trigger_protocol()` API for IPC driver.
- New E2E test **C12**: cross-language TS↔Python via single RC with two `AgentNode` backends, using `20-cross-lang-e2e` fixtures. No NATS.
- Legacy `orchestrator.ts` removed (superseded by `ReagentController`).

### Functional E2E tests

| Test | What it validates |
|---|---|
| C1: Single-node loopback | Two agents, message round-trip via loopback `NodeRef`. |
| C2: Multi-node InMemoryNodeLink | Two agents on separate nodes, message via `NodeLink`. |
| C3: Interceptor spy | Spy interceptor records envelopes, asserts `from`/`to`/`direction`. |
| C4: Interceptor drop | Interceptor skips `next()` → message never delivered. |
| C5: TraceHook fires | `TraceHook` spy captures `ProtocolStarted`, `MessageSent`, etc. |
| C6: AgentRef.send envelope | `ref.send()` auto-populates `from`, `to`, `instanceId`, `ts`, `key`. |
| C7: AddressPage routing | Node-1 routes to "B" on node-2 via `AddressPage` + `NodeLink`. |
| C8: Dynamic spawn | `rc.spawnAgent()` → new agent reachable via loopback. |
| C9: External trigger | `rc.triggerProtocol()` starts and completes a protocol. |
| C10: Multi-protocol node | Two protocols on one node, correct `instanceId` demuxing. |
| C11: Agent in multiple protocols | One agent plays roles in two protocols concurrently. Shared `$self`, lifecycle handlers fire for each. Example: `22-multi-protocol-agent.rg`. |
| C12: Cross-language TS↔Python via RC | TS + Python agents on single RC with `NativeAgentNode` + `PythonAgentNode`. Loopback routing, no NATS. Both agents complete, `$self` verified on both sides. |

### DoD ✅

- All interfaces and types defined (`NodeRef`, `AgentRef`, `ReagentTransport`, `NodeLink`, `AgentNode`, `AgentHandle`, `InterceptorFn`, `AddressPage`).
- `ReagentController` (multi-AgentNode), `NativeAgentNode`, `PythonAgentNode`, `InMemoryNodeLink` implemented.
- `ProtocolInstance` and `AgentRunner` (TS + Python) refactored to use `ReagentTransport`. Trace emission via `TraceHook`.
- All 20 existing E2E tests (T1–T20) pass via `NatsCompatTransport` shim.
- Multi-node routing via `InMemoryNodeLink` + `AddressPage` working.
- Cross-language TS↔Python via single RC working (no NATS).
- All 12 new functional E2E tests (C1–C12) pass.
- Legacy `orchestrator.ts` removed. `NatsNodeLink` deferred (fast follow).

---

## M6-RT — Reagent Orchestrator Service + Debugger ✅ DONE

**Intent**: build the orchestration and debug infrastructure on top of M5-CTRL's connectivity layer. The ROS is a long-lived Node.js process with WebSocket server that compiles, deploys, runs, and debugs protocols. No NATS dependency.

Full design: [m6-ros-design.md (draft-1)](../docs/m6-ros-design.md).

### Core concepts

- **ReagentOrchestratorServer (ROS)**: Node.js process with its own `ReagentController`. Accepts RAP/WS clients (VSCode, CLI). Manages sessions (compile → deploy → run → debug).
- **WsNodeLink**: WebSocket-based `NodeLink` for ROS-to-node and node-to-node communication. JSON text frames carrying `MessageEnvelope`.
- **Session**: one `.rg` program execution context. Holds compiled IR, source map, RC, debug state, traces.
- **DebugInterceptor**: message-level interceptor that holds messages at breakpoints. Works with existing RC interceptor chain. Supports `step`/`continue`/`inspect`.
- **DebugAdvanceHook**: state-level debug hook that pauses before any IR state (including zones). Promise-gate blocking. Supports `stepState`/`stepOver`/`continue`.
- **DebugController**: coordinates debug operations across sessions. Resolves source-level breakpoints via source map. Manages both message-level and state-level debug instruments.
- **Source Map**: compiler-emitted mapping from IR state IDs to `.rg` source locations. Enables breakpoint resolution and current-line visualization.
- **RemoteNode**: standalone agent node process that connects to ROS via WsNodeLink, registers via handshake, receives deploy/trigger commands.

### Phase 1: WsNodeLink + ROS skeleton ✅

- `WsNodeLink` + `WsNodeLinkServer`: WebSocket `NodeLink` implementation (client + server modes).
- `ReagentOrchestratorServer`: WS server, session management, compile on demand via lazy-loaded `@reagent/lang`.
- `Session` + `SessionManager`: per-program execution context (IR, source map, RC, traces, status).
- `ros-cli.ts`: CLI entry point with `--port` flag and graceful shutdown.
- Compile `.rg` → IR + source map via WS.
- Deploy agents in-process (multi-AgentNode RC from M5-CTRL).
- Run protocols, stream trace events to WS clients in real-time.
- **T21** ✅: compile + deploy + run via WS, verify traces and completion.

### Phase 2: Two-level debug infrastructure ✅

- **Message-level**: `DebugInterceptor` in RC interceptor chain — holds messages at breakpoints, supports `stepMessage`/`continue`.
- **State-level**: `AdvanceHook` in `ProtocolInstance.advance()` — pauses before any IR state including zones (`action`). `DebugAdvanceHook` with promise-gate blocking, supports `stepState`/`stepOver`/`continue`.
- `DebugController`: coordinates both levels, session-scoped debug state, breakpoint resolution via source map. Idempotent session creation.
- Compiler emits source maps (IR state ID → `.rg` file:line:col) in `ir-emitter.ts`. CLI writes `source-map.json`.
- Python IPC extended with `pauseBeforeState`/`resume` commands. Python `ProtocolInstance` gains `advance_hook`.
- SetBreakpoints → resolve → RunStart (debug mode) → Stopped (message or state) → GetState → step/continue.
- **T22** ✅: Set breakpoint on message name, run, verify pause at correct point (message-level).
- **T23** ✅: Inspect `$ctx` and `$self` at pause point, verify values match expected.
- **T24** ✅: Step through 3 message-level transitions, verify state after each.
- **T25** ✅: Set breakpoint on `action` state (zone), run, verify pause *before zone executes* (state-level).
- **T26** ✅: `stepState` through receive → action → send, verify `$ctx` changes at each step.

### Phase 3: Remote nodes via WsNodeLink ✅

- `RemoteNode`: standalone TS process with its own RC + NativeAgentNode. Connects to ROS via WebSocket, performs handshake, receives Deploy/TriggerProtocol commands. Sends trace events back to ROS.
- ROS-side adapter management: tracks connected remote nodes, handles handshake + registration, provides deploy/trigger methods.
- **T27** ✅: Remote node handshake + adapter registration via WS.

### Phase 4: VSCode extension (RAP client) ✅

- `RapClient`: WebSocket RAP client with typed listeners, request-response correlation, wildcard listeners.
- `ReagentDebugSession` (DAP adapter): inline debug adapter bridging VS Code DAP ↔ ROS RAP. Handles launch (connect to ROS, compile, run in debug mode), setBreakpoints (resolve via source map), stackTrace (map stateId to .rg line), scopes/variables ($ctx, $self, held messages from GetState), continue/next/stepIn/stepOut, disconnect.
- `ReagentDebugPanelProvider`: WebviewView for debug sidebar — trace timeline (last 50 events, color-coded by kind), agent state cards (JSON), held messages display. Auto-updates on new traces.
- `ReagentInlineValues`: text editor decorations showing `$ctx.key = value` and `$self.key = value` at the current paused line. Clears on session end.
- `package.json`: `debuggers` contribution (type: "reagent", launch config schema, snippets), `breakpoints` for reagent language, `commands` (startDebug, showTraceTimeline, inspectAgent), `views.debug` (reagentDebugPanel).
- Extension `activate()` registers: debug adapter factory, webview view provider, inline values, commands, session termination cleanup.

### New files (M6-RT)

| File | Purpose | Phase |
|---|---|---|
| `runtime/ts/src/ws-node-link.ts` | WebSocket NodeLink (client + server modes) | 1 |
| `runtime/ts/src/ros.ts` | ReagentOrchestratorServer | 1 |
| `runtime/ts/src/session.ts` | Session + SessionManager | 1 |
| `runtime/ts/src/ros-cli.ts` | CLI entry point | 1 |
| `runtime/ts/src/debug-interceptor.ts` | DebugInterceptor (message-level) | 2 |
| `runtime/ts/src/debug-advance-hook.ts` | DebugAdvanceHook (state-level) | 2 |
| `runtime/ts/src/debug-controller.ts` | DebugController (coordinates both levels) | 2 |
| `runtime/ts/src/remote-node.ts` | RemoteNode (standalone agent node) | 3 |
| `tools/reagent-vscode/src/rapClient.ts` | WebSocket RAP client for VSCode | 4 |
| `tools/reagent-vscode/src/reagentDebugAdapter.ts` | DAP debug adapter (inline) | 4 |
| `tools/reagent-vscode/src/debugPanelProvider.ts` | Debug panel webview | 4 |
| `tools/reagent-vscode/src/inlineValues.ts` | Inline value decorations | 4 |
| `runtime/tests/m6-ros.test.ts` | ROS + debug E2E tests (T21–T27) | 1–3 |

### Functional E2E tests

| Test | What it validates |
|---|---|
| T21: Compile + Run via WS | ROS compiles `.rg`, deploys agents, runs protocol, streams traces, reports completion. |
| T22: Message breakpoint → Stopped | DebugInterceptor holds message at breakpoint, emits Stopped event. |
| T23: GetState at pause | State inspection returns $ctx, $self, held messages at pause point. |
| T24: stepMessage sequence | Step through message-level transitions one by one until completion. |
| T25: State breakpoint on action kind | AdvanceHook pauses before action (zone) state. |
| T26: stepState through states | Step through receive → action → send at state level, verify $ctx changes. |
| T27: Remote node handshake | Remote adapter connects, handshakes, registers with ROS. |

### DoD ✅

- ROS boots, accepts WS connections, compiles `.rg`, deploys agents, runs protocols, streams traces.
- `WsNodeLink` works for remote node connectivity.
- **Message-level debug**: `DebugInterceptor` pauses on message breakpoints, supports `stepMessage`/`continue`.
- **State-level debug**: `AdvanceHook` in `ProtocolInstance` pauses before any IR state (including zones). `DebugAdvanceHook` supports `stepState`/`stepOver`/`continue`.
- `DebugController` resolves source-level breakpoints via source map, coordinates both levels.
- `InspectState` returns `$ctx`, `$self`, `currentStateId`, `stateKind`, pending messages for paused agents.
- Remote nodes connect, register, and deploy via WsNodeLink.
- VSCode extension: DAP debug adapter, debug panel, inline values, breakpoint support.
- T21–T27 pass.

---

## Future work (backlog)

Ideas and milestones considered but not yet scheduled.

- **Role multiplicity** (`many` / `foreach`): dynamic participant sets, fan-out/fan-in, subset selection. Needed for auction/CFP protocols. Significant language extension — requires research on dynamic fork/join, convergence semantics.
- **Engine API v0**: extract a formal language-neutral runtime contract from reference runners. Define `StartInstance`, `SubmitEvent`, `StreamTrace`, `ExecuteAction`, `Cancel`. Reference runners become the reference implementation.
- **Losos engine adapter**: map Reagent IR to Losos Guard-Action network + etcd keyspace. Run Engine API conformance suite against Losos.
- **Losos Guards 2.0**: multi-slot, OR/AND/XOR, timeouts — close semantic gaps between IR and Losos.
- **Multi-language execution via Engine API**: Python runner talks to Losos engine through Engine API.
- **Observability**: TraceEvent → OpenTelemetry mapping, trace divergence detection, "why blocked" queries.
- **Delivery guarantees / protocol decorators**: `AgentRef.send()` is fire-and-forget today. At-least-once delivery with retries should be a **protocol decorator** — a standard-library Reagent protocol that wraps user protocols with retry/ack logic. Keeps retry composable, not baked into transport.
- **P2P gossip for node discovery**: nodes exchange `AddressPage`s directly, converging to consistent cluster view without central orchestrator.
- **NatsNodeLink**: wrap NATS as a `NodeLink` implementation. Single subject per node-pair. Fast follow after M5-CTRL.
- ~~**Cross-language loopback**~~: ✅ Done in M5-CTRL / Phase E. `PythonAgentNode` bridges Python child processes via JSON-line IPC. Multi-`AgentNode` RC routes by language.
- **Production hardening**: AuthN/AuthZ on `NodeLink` connections (TLS, mTLS, token auth), quotas, backpressure, operational tooling, crash recovery.

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
| RAP sub-protocols | 7 `.rg` specs in `tools/rap/` with role defs | M2-LANG / D ✅ | — |
| `role` definition | `RoleIR` | M3-LANG ✅ | — |
| `implements` in agent | expanded plays in `AgentIR` | M3-LANG ✅ | — |
| Role-centric design | `role` primary, `agent` thin | M4-LANG ✅ | — |
| Role `extends` | inheritance: plays/init/handlers merged | M4-LANG ✅ | — |
| `agent runs` | deployment binding | M4-LANG ✅ | — |
| NodeRef + AgentRef + ReagentTransport | transport decoupling, ActorRef pattern | M5-CTRL / A ✅ | C1, C6 |
| NodeLink + InMemoryNodeLink | inter-node envelope pipe | M5-CTRL / B ✅ | C2, C7 |
| ReagentController | routing, interceptors, ref factory | M5-CTRL / B ✅ | C3, C4, C9 |
| NativeAgentNode | TS AgentRunner as AgentHandle | M5-CTRL / C ✅ | C1–C11 |
| PythonAgentNode | Python child process via JSON-line IPC | M5-CTRL / E ✅ | C12 |
| Multi-AgentNode RC | RC routes to correct AgentNode by lang | M5-CTRL / E ✅ | C12 |
| Loopback routing | co-located agent direct dispatch | M5-CTRL / D ✅ | C1, C8 |
| Multi-level interception | message interceptors + TraceHook | M5-CTRL / D ✅ | C3, C4, C5 |
| AddressPage + routing table | static discovery | M5-CTRL / D ✅ | C7 |
| Multi-protocol agent | one agent, multiple concurrent protocols | M5-CTRL / D ✅ | C11 |
| Cross-language TS↔Python via RC | multi-runtime loopback, no NATS | M5-CTRL / E ✅ | C12 |
| ROS skeleton | compile, deploy, run, trace streaming via WS | M6-RT / 1 ✅ | T21 |
| WsNodeLink | WebSocket-based NodeLink | M6-RT / 1, 3 ✅ | T27 |
| Message-level debug | DebugInterceptor: hold messages, stepMessage | M6-RT / 2 ✅ | T22, T24 |
| State-level debug | AdvanceHook: pause before any IR state incl. zones | M6-RT / 2 ✅ | T25, T26 |
| Source map | compiler-emitted IR state → .rg line mapping | M6-RT / 2 ✅ | T25 |
| State inspection | $ctx, $self, stateId, stateKind at pause point | M6-RT / 2 ✅ | T23 |
| Remote nodes | RemoteNode + adapter handshake + deploy via WS | M6-RT / 3 ✅ | T27 |
| Debug UI (VSCode) | DAP adapter, debug panel, inline values, breakpoints | M6-RT / 4 ✅ | — |
