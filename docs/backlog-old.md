## Reagent backlog & milestone history

> **Note (v0.0.11)**: `$flow` was removed from the language in v0.0.11. Historical milestone descriptions below reference `$flow` as it existed at the time. All `$flow` usage has been migrated to `$ctx` (per-role working memory) with explicit message payloads for inter-role data transfer.

Goal: build a **language + reference runtimes** stack for agentic protocols.

- **Reagent** is the language and compiler (`lang/`).
- **Reference runners** (TS + Python) are the test-driven development target.

Development is **E2E test-driven**: each feature starts with a `.rg` example, compiles to IR, runs on reference runners, and is validated by trace assertions.

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

Full design: [connectivity.md (draft-3)](connectivity.md).

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

Full design: [orchestrator.md (draft-1)](orchestrator.md).

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

## M5-LANG — Language v0.0.8: dual context, protocol-level orchestration, scatter ✅ DONE

**Intent**: four language-level changes + runtime hardening. Breaking change: `$ctx` becomes per-role isolated; cross-role state travels via `$flow`. Bumps language to v0.0.8.

### Key changes

- **Dual context**: `$ctx` (per-role isolated) + `$flow` (propagated automatically with every message). Zones receive `$ctx`, `$self`, `$flow`, `reagent`.
- **Protocol-level `invoke` / `spawn`**: `<role> invokes <Protocol>(<args>) -> <target>` and `<role> spawns <Protocol>(<args>)`. Bound to a role explicitly. `reagent.invoke()`/`reagent.spawn()` in zones deprecated (validator warning).
- **`scatter`** (dynamic multicast): `scatter ($flow.candidates as seller) { ... }` — dynamic fork/join over a runtime-resolved list. Enables CFP patterns.
- **`alt where`** disambiguation: `alt (B --> A: Err where { code: "TRANSIENT" }) { ... }` — `where` clause separates pattern matching from hook syntax.
- **Hardening**: `$ctx.msg` isolated per `par` branch, `reagent.break()` sentinel, hook zone restrictions (no `invoke`/`spawn`), `$ctx.msg` lifetime formalized.

### Files impacted

- **AST** (`lang/src/ast.ts`): `InvokeStmt`, `SpawnStmt`, `ScatterStmt` added to `ProtocolItem`; `AltMessageGuard` gains `whereClause`.
- **Parser** (`lang/src/parser.ts`): `pInvokeStmt()`, `pSpawnStmt()`, `pScatterStmt()`; keywords `invoke`, `invokes`, `spawn`, `spawns`, `scatter`, `where`.
- **IR** (`lang/src/ir.ts`): `IRInvokeData`, `IRSpawnData`, `IRScatterData`; `propagateFlow` on send/receive states.
- **IR emitter** (`lang/src/ir-emitter.ts`): `emitInvoke()`, `emitSpawn()`, `emitScatter()`; flow propagation on all send states.
- **Runtime TS** (`runtime/ts/src/protocol-instance.ts`): `this.flow` field, `handleSend()` serializes `$flow`, `handleReceive()` deserializes, `handleInvoke()`, `handleScatter()`, `BranchRunner` with `$ctx.msg` isolation.
- **Runtime TS** (`runtime/ts/src/zone-executor.ts`): `$flow` as 4th injected parameter, `BreakRequest` sentinel, `reagent.break()`.
- **Runtime Python** (`runtime/py/reagent_runtime/protocol_instance.py`, `zone_executor.py`): mirror all TS changes.
- **Examples**: all 24 rewritten for `$ctx`/`$flow`; new `23-scatter-gather.rg`, `24-call-for-proposal.rg`.
- **Lang spec** (`docs/lang-spec.md`): §1.5–1.6 ($ctx/$flow), new sections for invoke/spawn/scatter, EBNF updated.
- **TextMate grammar**: `$flow`, `invoke`, `invokes`, `spawn`, `spawns`, `scatter`, `where` highlighted.

### E2E tests

| Test | What it validates |
|---|---|
| T28: $flow propagation | Write on A, message to B, read on B |
| T29: $ctx isolation | Write on A, message to B, B cannot read A's $ctx |
| T30: protocol-level invoke | `<role> invokes <Protocol>` |
| T31: protocol-level spawn | `<role> spawns <Protocol>` |
| T32: scatter/gather | Dynamic multicast |
| T33: CFP pattern | Call-for-proposal via scatter |
| T34: $ctx.msg par isolation | Per-branch $ctx.msg isolation |
| T35: reagent.break() | Break sentinel in loop |
| T36: alt where | Pattern matching with `where` clause |

---

## M6-PYRC — Python ReagentController Library ✅ DONE

**Intent**: build a pure-Python `ReagentController` that can run multi-agent protocols entirely in-process (no NATS, no TS parent), with an option for IPC subprocess agents. Primary use case: Python multi-agent simulations (NMMO, actor-gas).

### Architecture

- **`InprocTransport`**: per-agent transport that routes via RC callback. Zero serialization, shared asyncio event loop.
- **`AgentHandle` / `AgentNode` protocols**: mirror TS pattern. Factory + opaque handle.
- **`InprocAgentNode`**: wraps `AgentRunner` in-process. Messages route synchronously through RC.
- **`IpcAgentNode`**: spawns Python subprocess (`ipc_agent.py`), JSON-line stdin/stdout.
- **`ReagentController`**: routing table, agent registry, interceptors. `register_agent()`, `trigger_protocol()`, `route_envelope()`.

### New files

| File | Purpose |
|---|---|
| `runtime/py/reagent_runtime/controller.py` | ReagentController class |
| `runtime/py/reagent_runtime/agent_node.py` | AgentHandle, AgentNode protocols |
| `runtime/py/reagent_runtime/inproc_agent_node.py` | InprocAgentNode + InprocAgentHandle |
| `runtime/py/reagent_runtime/ipc_agent_node.py` | IpcAgentNode + IpcAgentHandle |
| `runtime/py/reagent_runtime/inproc_transport.py` | InprocTransport |
| `runtime/tests/test_py_rc.py` | E2E tests |

### E2E tests

| Test | What it validates |
|---|---|
| PRC-T1: Inproc loopback | Two inproc agents, linear protocol, completion + traces |
| PRC-T2: Inproc invoke | Invoke child protocol |
| PRC-T3: Inproc spawn | Spawn child protocol |
| PRC-T4: Inproc par | Parallel branches |
| PRC-T5: IPC agent | Cross-process message delivery |
| PRC-T6: $flow propagation | $flow travels with messages between inproc agents |

---

## M7-DX — Developer Experience & Tooling ✅ DONE (foundation)

**Intent**: turn Reagent from a language with test-driven runtimes into a **human-usable tool** — establish the foundation: fix debug wiring, one-click run, ROS management, UX mockups.

Full design: [dx-tooling.md (draft-1)](dx-tooling.md).

**Scope note**: M7-DX originally planned Phases 0–7. Phases 0 and 0.5 are complete, plus the Run/CodeLens items from Phase 1. The remaining Phase 1 items (IR-driven diagrams) and all of Phases 2–7 require revision for M5-LANG (`$flow`, `scatter`, `invoke`/`spawn`), M6-PYRC (Python RC), and M8a (versioning, registry, project structure). These are now **M9-DX**.

### Phase 0: Wire + Quick Wins ✅ DONE

- [x] Wire `ReagentDebugSession` → `debugPanelProvider` (addTrace, updateAgentState, updateHeldMessages) — already wired by M6-RT
- [x] Wire `showInlineValues()` — already wired via `pushStateToSinks()`
- [x] Fix RAP Compile field mismatch (`source` → `rgSource` + `fileName`)
- [x] Fix GetState — pass `agentName` from Stopped event detail
- [x] Implement `inspectAgent` command — GetState → Output channel with InspectError handling
- [x] Enhance `language-configuration.json` — folding markers, indentation rules, word pattern
- [x] RAP protocol alignment — response message names, missing sub-protocols (§7.4 in dx-tooling.md)

### Phase 0.5: DevX + ROS Management ✅ DONE

- [x] Root `package.json` with workspace scripts (`npm run build`, `npm run test`, `npm run test:ros`, etc.)
- [x] `RosManager` — auto-starts ROS as child process when Debug requested, no manual terminal needed
- [x] Status bar indicator (ROS running/stopped) with click-to-toggle
- [x] Commands: `Reagent: Start ROS`, `Reagent: Stop ROS`, `Reagent: Toggle ROS`
- [x] Debug adapter auto-starts ROS on first connection failure
- [x] `ws` module bundled in VSIX (was missing → connection error)
- [x] Extension version synced with language version (0.0.8)

### Phase 1 (partial): One-Click Run ✅ DONE

- [x] `reagent.run` command — in-process compile + RC, no ROS needed (`RunController`)
- [x] CodeLens **▶ Run** / **🔍 Debug** on `protocol` lines
- [x] Editor title ▶ button for `.rg` files

### New files (M7-DX)

| File | Purpose | Phase |
|---|---|---|
| `tools/reagent-vscode/src/runController.ts` | In-process Run (compile + RC, no ROS) | 1 |
| `tools/reagent-vscode/src/codeLensProvider.ts` | Run/Debug CodeLens on `protocol` lines | 1 |
| `tools/reagent-vscode/src/rosManager.ts` | ROS auto-start/stop as child process | 0.5 |
| `projects/reagent/package.json` | Root workspace scripts | 0.5 |

---

## M8a — Protocol Identity, Registry, Project Structure ✅ DONE

**Intent**: give Reagent protocols identity (fingerprints, versions), make RC a knowledge plane (protocol registry), define project structure, and build the IR decompiler. All changes are **non-breaking** — existing code, examples, and tests continue to work unchanged.

Full design: [protocol-versioning.md](protocol-versioning.md).

### Core concepts

- **Three-world separation**: compilation (stateless IR artifacts) vs. cluster state (RC registry) vs. desired state (deploy spec). The compiler does not produce deployment plans; versions and fingerprints live inside IR files.
- **Protocol fingerprints**: three SHA-256 hashes per protocol — `structureHash` (choreography topology), `schemaHash` (message field types), `implHash` (zone bodies). Computed from normalized IR via BFS traversal.
- **Role fingerprints**: two SHA-256 hashes — `playsHash` (protocol bindings), `behaviorHash` (init + lifecycle code).
- **Auto-semver**: compiler compares fingerprints with `reagent.lock` (committed to VCS, not live outDir). Structure change = MAJOR, schema change = MINOR, impl change = PATCH. First compile = 1.0.0. Lock file ensures CI determinism and cross-developer consistency.
- **Dependency tracking**: `invoke`/`spawn` record the `structureHash` of the target protocol at compile time. RC verifies compatibility at deploy time.
- **RC protocol registry**: RC stores deployed protocols with versions, fingerprints, IR graphs. Provides `canDeploy()` for compatibility checks and reverse index (protocol -> agents). Public API for tooling.
- **Reagent project structure**: `reagent.json` manifest, `protocols/` for `.rg` files, `agents/` for agent manifests + native code. Import resolution algorithm for package dependencies.
- **IR decompiler**: IR-to-`.rg` round-trip for runtime introspection. Single-role view and multi-role merge. CLI command `reagent decompile`.

### Phase 1: Fingerprints in IR ✅ DONE

- [x] `ProtocolFingerprint`, `RoleFingerprint`, `ProtocolDependency` types in `lang/src/ir.ts`
- [x] `lang/src/ir-fingerprint.ts` — BFS normalization + SHA-256 hashing (pure functions, no I/O)
- [x] `lang/src/versioning.ts` — `reagent.lock` I/O + auto-semver (major/minor/patch classification)
- [x] Integrate into `cli.ts` — compute fingerprints after emit, compare with `reagent.lock`, write updated lock
- [x] Mirror types in `runtime/ts/src/types.ts` (all optional fields, backward compatible)
- [x] Python mirror: `runtime/py/reagent_runtime/ir_fingerprint.py` — read-only fingerprint/version extraction from IR JSON
- [x] Export fingerprint + versioning functions from `lang/src/index.ts`
- [x] All 29 examples recompiled with fingerprints and `reagent.lock` files

### Phase 2: RC Protocol Registry ✅ DONE

- [x] `runtime/ts/src/protocol-registry.ts` — `ProtocolRegistry` class with `register`, `list`, `canDeploy`, `agentsForProtocol`
- [x] Add `registry` to `ReagentController`, populate in `registerAgent()` with reverse index
- [x] `canDeploy()` — compatibility check: change-level classification + dependency conflict detection
- [x] `protocolVersion` in `MessageEnvelope` and `ProtocolTrigger`, `createMessageEnvelope()` updated
- [x] Python mirror: `runtime/py/reagent_runtime/protocol_registry.py` with `ProtocolRegistry`, `can_deploy()`, wired into Python `ReagentController.register_agent()`

### Phase 4: Project Structure and Decompiler ✅ DONE

- [x] `reagent.json` project manifest format with import resolution (§10.2 in design doc)
- [x] CLI commands: `reagent init` (scaffold), `reagent build` (multi-file compile from manifest, lock update, deployment.json output)
- [x] `deployment.json` as build index (protocol names, versions, fingerprints, IR file paths)
- [x] IR decompiler: single-role view (BFS + pattern detection), multi-role merge, `reagent decompile` CLI

### E2E tests (M8a)

| Test | What it validates | Status |
|---|---|---|
| F1: Fingerprint determinism | Same source → same hashes across compilations | ✅ |
| F2: Fingerprint sensitivity | One-char zone body change → different `implHash`, same `structureHash` | ✅ |
| F3: Auto-semver MAJOR | `structureHash` change bumps major version | ✅ |
| F4: Auto-semver PATCH | Zone-only change bumps patch, structure and schema unchanged | ✅ |
| F5: Dependency tracking | `invokes` records target `structureHash`; recompile with changed target → dependency conflict | ✅ |
| F6: reagent.lock persistence | Compile → lock written; fresh compile from lock → same versions | ✅ |
| R1: Registry register + list | Register protocol via `registerAgent()` → `listProtocols()` returns entry with fingerprints | ✅ |
| R2: canDeploy compatible | PATCH change → compatible, `requiresAgentRestart: false` | ✅ |
| R3: canDeploy incompatible | Dependency `structureHash` conflict → `compatible: false`, conflict details | ✅ |
| R4: protocolVersion in envelope | Triggered protocol → messages carry `protocolVersion` field | ✅ |
| R5: Python registry | Python RC `register_agent()` → `list_protocols()` → `can_deploy()` | ✅ |
| D1: Decompiler round-trip | Compile → decompile → recompile → identical fingerprints | ✅ |

### New files (M8a)

| File | Purpose | Phase | Status |
|---|---|---|---|
| `lang/src/ir-fingerprint.ts` | BFS normalization + SHA-256 fingerprint computation | 1 | ✅ |
| `lang/src/versioning.ts` | `reagent.lock` I/O + auto-semver classification | 1 | ✅ |
| `runtime/ts/src/protocol-registry.ts` | ProtocolRegistry class for RC | 2 | ✅ |
| `runtime/py/reagent_runtime/protocol_registry.py` | Python ProtocolRegistry | 2 | ✅ |
| `runtime/py/reagent_runtime/ir_fingerprint.py` | Python fingerprint reader/validator | 1 | ✅ |
| `runtime/tests/m8a-fingerprints.test.ts` | F1–F6 fingerprint E2E tests | 1 | ✅ |
| `runtime/tests/m8a-registry.test.ts` | R1–R5 registry E2E tests | 2 | ✅ |
| `lang/src/ir-decompiler.ts` | IR-to-.rg decompiler (single-role, multi-role merge) | 4 | ✅ |
| `lang/src/project.ts` | reagent.json loader, glob resolution, import resolution | 4 | ✅ |
| `runtime/tests/m8a-decompiler.test.ts` | D1 decompiler E2E test | 4 | ✅ |
| `docs/protocol-versioning.md` | Design document | — | ✅ |

---

## M8b — Agent Model, ROS Reconciler ✅ DONE

**Intent**: evolve the agent model for native code integration (`$agent` binding, `agent.json` manifests, async zones) and transform ROS into a desired-state reconciliation controller. Changes are **additive** — `agent` keyword remains in `.rg`, async zones are opt-in, reconciler coexists with existing session mode.

Full design: [protocol-versioning.md §9, §13](protocol-versioning.md).

**Prerequisite**: M8a completed.

### Core concepts

- **Agent model evolution**: agents gain an optional `agent.json` manifest for native code, config, and `$agent` binding in zones. `agent` keyword in `.rg` remains (not removed) — `agent.json` takes priority if present, otherwise `.rg` agent declarations work as before. Single `role` in `agent.json` (composition via `role extends` in the language).
- **Async zones**: `executeZoneAsync()` as a **separate code path** (does not replace sync). Compiler detects `await` and marks state as `async: true`. Runtime dispatches accordingly. Backward compatible.
- **ROS as reconciler**: ROS evolves from session-based server into a **desired-state reconciliation controller** (analogous to Kubernetes API server). Holds `DeploySpec`, queries `RegistryView` from connected RC nodes, drives convergence.

### Phase 3: Agent Model Evolution ✅ DONE

- [x] Wire `extras` through NativeAgentNode -> AgentRunner -> ProtocolInstance -> executeZone (TS)
- [x] Wire `extras` through InprocAgentNode -> AgentRunner -> ProtocolInstance -> execute_zone (Python)
- [x] `executeZoneAsync()` as separate path — compiler marks `async: true` on states with `await` in zone body
- [x] Python async zones: `async def` wrapper in `zone_executor.py`
- [x] Agent manifest format (`agent.json`) — single `role` field, `module`, `config`
- [x] `agent` keyword in `.rg` remains optional (not removed). `agent.json` takes priority when present
- [x] `$agent` binding injection from native module exports

### Phase 5: ROS Reconciler ✅ DONE

ROS evolves from a session-centric compile/run/debug server into a **reconciliation controller**. The existing session-based flow (compile → deploy → run → debug) remains as one mode; the reconciler adds a persistent desired-state management loop on top.

**Architectural shift**:

```
 Before (M6-RT):                    After (M8b):
 ┌──────────┐                       ┌───────────────────────────────┐
 │   ROS    │                       │            ROS                │
 │          │                       │                               │
 │ Sessions │                       │  Sessions    Reconciler       │
 │ (compile,│                       │  (compile,   (desired state,  │
 │  run,    │                       │   run,        actual state,   │
 │  debug)  │                       │   debug)      convergence)    │
 └────┬─────┘                       │                               │
      │ WS                          │  DeploySpec   RegistryView    │
      ▼                             └──────┬────────────┬───────────┘
   RC node                                 │ WS         │ RAP
                                    ┌──────▼────┐  ┌────▼──────┐
                                    │ RC node 1 │  │ RC node 2 │
                                    │ (registry) │  │ (registry) │
                                    └───────────┘  └───────────┘
```

**Key components**:

- [x] **`DeploySpec`** — desired-state document: which protocols (by name + version) should be deployed, on which nodes, with which agents. Loaded from `reagent.json` project + deploy plan, or submitted via RAP
- [x] **`RegistryView`** — aggregated snapshot of all connected RC registries. ROS queries each RC for `listProtocols()` + `listAgents()` and builds a cluster-wide view of actual state
- [x] **`Reconciler`** — diff engine: compares `DeploySpec` against `RegistryView`, produces a `ReconciliationPlan` (list of actions: deploy protocol, upgrade protocol, stop agent, create agent, redistribute). Topological sort by dependency graph
- [x] **`ReconciliationPlan`** — ordered list of reconciliation actions with dependency resolution (e.g., deploy child protocol before parent that invokes it). Each action: `{ kind, protocolName, targetNode, ... }`
- [x] **RAP extensions** — new sub-protocols for reconciliation:
  - `10-list-protocols.rg` — query RC registry
  - `11-deploy-protocol.rg` — deploy or upgrade a protocol on an RC
  - `12-cluster-status.rg` — aggregated cluster state for tooling
  - `13-submit-deploy-spec.rg` — submit desired state to ROS
  - `14-stop-agent.rg` — graceful agent teardown
- [x] **ROS RAP handlers** — ListProtocols, DeployProtocol, ClusterStatus, SubmitDeploySpec, StopAgent integrated into ros.ts
- [x] **Backward compatibility** — existing session flow (compile-run-debug via RAP) remains unchanged. Reconciler is an additive feature on top
- [x] **`reagent deploy` CLI** — reads `reagent.json` + deploy plan, connects to ROS, submits `DeploySpec`, waits for reconciliation, reports result. Falls back to local plan if ROS unavailable
- [x] **Python RC participation** — Python RC implements `handle_list_protocols_rap()` so Python nodes participate in reconciliation

### E2E tests (M8b)

| Test | What it validates |
|---|---|
| A1: extras wiring (TS) | `$agent.method()` callable in zone, returns value |
| A2: extras wiring (Python) | `$agent.method()` callable in Python zone |
| A3: async zone (TS) | Zone with `await $agent.asyncMethod()` executes correctly |
| A4: async zone (Python) | Zone with `await $agent.async_method()` via asyncio |
| A5: agent.json loading | Agent manifest loaded, native module injected as `$agent` |
| A6: agent.json + .rg coexistence | `.rg` `agent` + `agent.json` → manifest takes priority |
| REC1: Reconciler plan — deploy new | Empty cluster + DeploySpec → `deploy-protocol` actions |
| REC2: Reconciler plan — upgrade | Existing protocol v1.0.0 + DeploySpec v1.0.1 → `upgrade-protocol` |
| REC3: Reconciler plan — dependency order | Parent invokes child → child deployed before parent |
| REC4: Convergence happy path | Apply plan → verify registry matches DeploySpec |
| REC5: Convergence with disconnect | RC disconnects during apply → retry on reconnect |

### New files (M8b)

| File | Purpose | Phase | Status |
|---|---|---|---|
| `runtime/ts/src/agent-manifest.ts` | agent.json loader + native module binding | 3 | ✅ |
| `runtime/py/reagent_runtime/agent_manifest.py` | Python agent.json loader | 3 | ✅ |
| `runtime/ts/src/reconciler.ts` | Desired-state reconciler (diff engine + plan + topo sort) | 5 | ✅ |
| `runtime/ts/src/deploy-spec.ts` | DeploySpec types + loader from reagent.json | 5 | ✅ |
| `runtime/ts/src/registry-view.ts` | Aggregated cluster registry snapshot | 5 | ✅ |
| `tools/rap/10-list-protocols.rg` | RAP sub-protocol: query RC registry | 5 | ✅ |
| `tools/rap/11-deploy-protocol.rg` | RAP sub-protocol: deploy/upgrade on RC | 5 | ✅ |
| `tools/rap/12-cluster-status.rg` | RAP sub-protocol: aggregated cluster state | 5 | ✅ |
| `tools/rap/13-submit-deploy-spec.rg` | RAP sub-protocol: submit desired state | 5 | ✅ |
| `tools/rap/14-stop-agent.rg` | RAP sub-protocol: graceful agent teardown | 5 | ✅ |
| `runtime/tests/m8b-agent-model.test.ts` | A1–A6 agent model E2E tests | 3 | ✅ |
| `runtime/tests/m8b-reconciler.test.ts` | REC1–REC5 reconciler E2E tests | 5 | ✅ |

---

## M9-DX — NMMO-Driven Developer Experience 🔧 IN PROGRESS

**Intent**: revise and complete M7-DX phases 1–7 to incorporate language changes (M5-LANG: `$flow`, `scatter`, `invoke`/`spawn`, `alt where`), the Python RC library (M6-PYRC), and protocol versioning/registry (M8a). M7-DX was designed before these milestones existed; M9-DX reconciles the tooling with the evolved language and runtime.

**Driving example**: the `nmmo-reagent` project (`montevideo/Montevideo/nmmo-reagent/`) serves as the primary use case for validating and prioritizing DX features. All tooling improvements are validated against NMMO multi-agent protocols.

**Prerequisite**: M8a completed (M8b is not required for DX tooling).

Full design: [dx-tooling.md](dx-tooling.md) — to be updated by this milestone.

### Why a separate milestone

M7-DX Phase 0 and 0.5 are done. The remaining phases (1–7) were designed against language v0.0.7, without `$flow`, `scatter`, protocol-level `invoke`/`spawn`, Python RC, fingerprints, protocol registry, agent manifests, or project structure. Rather than retroactively patching M7-DX (which has a frozen design doc), M9-DX explicitly revises each remaining phase and adds new tasks.

### Delta summary

| Area | What changed | Impact on DX |
|---|---|---|
| `$flow` (M5-LANG) | New cross-role propagated context | Debugger must show `$flow` alongside `$ctx`/`$self`; inline values need `$flow.key = val`; LSP hover on `$flow.field`; diagram tooltips |
| `scatter` (M5-LANG) | Dynamic multicast construct | Sequence diagram: fan-out arrows with participant list; state machine: scatter node with N edges; debugger step-in to scatter branches; LSP completion for scatter syntax |
| Protocol-level `invoke`/`spawn` (M5-LANG) | Moved from agent zones to protocol body | Sequence diagram: nested protocol block; state machine: invoke/spawn nodes with child link; CodeLens on invoke/spawn lines; LSP go-to-def on target protocol |
| `alt where` (M5-LANG) | Pattern matching on messages | LSP: completion inside `where { }`, diagnostics for invalid patterns; diagram: where-clause labels on alt branches |
| Python RC (M6-PYRC) | `ReagentController` + `InprocAgentNode` in Python | Phase 5 (Py simulation) now has a real foundation; Jupyter bridge simplified; topology view connects to Python RC; multi-process scale-out via existing `InprocTransport` |
| Fingerprints + auto-semver (M8a/P1) | Protocol identity | LSP: show version + fingerprint on hover; deployment topology: version badges on protocols; compatibility warnings in diagnostics; CodeLens "v1.2.3" badge |
| RC protocol registry (M8a/P2) | Registry API on each RC | Topology view: query live registry for deployed protocols; protocol list panel; canDeploy() integration in deployment UI |
| Agent model + $agent (M8b/P3, optional) | Native modules, agent.json, $agent binding | LSP: completion for `$agent.method()` in zones (if M8b done); debugger: $agent state inspection; topology: agent manifest info in node inspector |
| Project structure (M8a/P4) | `reagent.json`, `protocols/`, `agents/`, `reagent init` | LSP: workspace-level indexing from reagent.json; Run/Debug use project root; deployment from project; file watcher respects project layout |
| IR decompiler (M8a/P4) | IR → .rg round-trip | New command: "Decompile IR" → open .rg preview; runtime introspection in debugger |

### Phase 1-R: Run + IR-Driven Diagrams (revision) ✅ DONE

**Goal**: same as M7-DX Phase 1, plus `scatter`, protocol-level `invoke`/`spawn`, `$flow` in the diagram pipeline.

**New/revised tasks** (on top of existing Phase 1 items):

- [x] `scatter` in sequence diagram — fan-out arrows from sender to a group (dynamic participant set), labeled with iteration variable; `gather` join-point
- [x] `scatter` in state machine — scatter node (hexagon) with N outgoing edges, join node after all branches complete
- [x] Protocol-level `invoke` in sequence diagram — nested sub-diagram block (or folded box with expand-on-click)
- [x] Protocol-level `spawn` in sequence diagram — dashed nested block (fire-and-forget semantics visualized)
- [x] `alt where` labels — where-clause condition displayed on alt branch edges
- [x] `$flow` in replay mode — when replaying trace, show `$flow` state alongside `$ctx` in tooltip
- [x] Version badge — if IR contains `version` (M8a), show it in diagram header (e.g., "TaskExecution v1.2.0")

**Completed components**:
- `lang/src/diagram.ts` — IR-to-diagram data model with scatter/invoke/spawn support
- `tools/reagent-vscode/src/renderers/sequenceDiagram.ts` — SVG renderer for sequence diagrams
- `tools/reagent-vscode/src/renderers/stateMachineDiagram.ts` — SVG renderer for state machine diagrams
- Live reload: `.rg` save → recompile → re-render via `diagramPanel.ts`

**Pre-requisites completed**:
- Scatter + async zones E2E test (`runtime/tests/m9-scatter-async.test.ts`) — validates async zones within scatter branches
- `rc.load(ir_dir)` in Python `ReagentController` — bulk project loading for simulation workflows

### Phase 1.5-R: Infrastructure + Project Overview ✅ DONE

**Goal**: make the extension self-contained and add project-level architecture visualization.

**Completed tasks**:

- [x] **Self-contained VSIX** — bundled `lang/dist` compiler into extension as `lang/` directory with ESM package.json. Build step: `bundle-lang` copies compiler artifacts. No dependency on source tree.
- [x] **ROS manager hardening** — TCP-level port probe (not WebSocket), adopt existing server on start, `freePort()` kills stale processes via `lsof`, clean exit handler. Fixes EADDRINUSE on reload.
- [x] **File icon** for `.rg` files — benzene hexagon ring SVG (light + dark themes) in `icons/`. Wired via `language.icon` in `package.json`.
- [x] **Project Overview Diagram** — new `projectDiagram.ts` (scanner + renderer) + `projectDiagramPanel.ts` (webview panel):
  - Scans `.rg` files scoped to nearest `reagent.json` (not whole workspace)
  - Three-column layout: Agents (orange pills) → Roles (green hexagons) → Protocols (blue boxes)
  - Edges: `runs` (agent→role) and `plays as` (role→protocol) with bezier curves
  - Click any node to navigate to source file/line
  - Auto-refreshes on `.rg`/`agent.json`/`reagent.json` save
  - Command: `reagent.openProjectDiagram`, toolbar button `$(graph)` on `.rg` editor title
- [x] **Protocol diagram fix** — `selectedRole` resets when switching between `.rg` files with different role sets
- [x] **nmmo-reagent agent restructure** — agents moved to per-agent folders (`agents/coordinator/`, `agents/commander/`, `agents/entity/`), each with `agent.json` + `<name>.rg` + `module.py`

**New files**:
- `tools/reagent-vscode/src/projectDiagram.ts` — project-level scanner (regex-based) + SVG renderer
- `tools/reagent-vscode/src/projectDiagramPanel.ts` — webview panel for project architecture diagram
- `tools/reagent-vscode/icons/reagent-light.svg`, `reagent-dark.svg` — file icons

### Phase 2-R: LSP Core (revision) ✅ DONE (core)

**Goal**: same as M7-DX Phase 2, plus new constructs and project awareness.

Full LSP design and backlog: **[lsp.md](lsp.md)**.

**Completed**: document symbols, go-to-definition, hover, context-aware completion, parse + semantic diagnostics. Single-file scope.

**Remaining**: cross-file indexing, semantic tokens, find references, rename, `$flow` tracking, `$agent.method()` completion — see `lsp.md` backlog (L-01 through L-21).

**Files**: `tools/reagent-vscode/server/src/server.ts`, `tools/reagent-vscode/server/tsconfig.json`

### Phase 2.5-R: Grammar + Diagram Polish (v0.0.9) ✅ DONE

**Goal**: improve TextMate grammar for zone highlighting and polish sequence diagram layout/styling.

**Completed tasks**:

- [x] **TextMate grammar v0.0.9** — expanded zone keyword highlighting:
  - `$agent` added to zone keywords (was missing — only `$ctx`, `$flow`, `$self`)
  - Python/JS keywords in zones: `await`, `return`, `if`, `else`, `for`, `while`, `import`, `from`, `def`, `class`, `try`, `except`, `raise`, `None`, `True`, `False`, `async`, `const`, `let`, `var`, `function`, etc.
  - Builtin functions: `print`, `len`, `range`, `enumerate`, `push`, `append`, `console`, `Math`, `JSON`, etc.
  - Operators: `===`, `!==`, `==`, `!=`, `>=`, `<=`, `=>`, `||`, `&&`
  - Fixed single-line empty `message Name {}` definitions (regex could not match `{` and `}` on same line)
- [x] **Sequence diagram layout** — action boxes no longer overlap control frame borders:
  - `FRAME_OPEN_PAD = 30` (was 20) — vertical space after frame label before first inner element
  - `FRAME_CLOSE_PAD = 16` — breathing room before frame bottom edge
  - Wider columns (`COLUMN_WIDTH = 220`), taller header area, more padding
  - Participant header boxes auto-sized to name length
- [x] **Sequence diagram styling** — cleaner, softer appearance:
  - System font stack, semi-transparent action box fills, thinner strokes
  - Control frames: 50% opacity strokes, colored labels per type (green/orange/red/purple)
  - Tag backgrounds with rounded top corners (tab-like look)
  - Action boxes: smaller (24px height), tighter text

**Example project**: `examples/projects/auction-sim/` — first project-style example using `reagent init`, validates scatter-based bidding protocol with seller + N buyers (all Python).

### Phase 3-R: Visual Debugger (revision) ✅ DONE (core)

**Goal**: same as M7-DX Phase 3, plus `$flow` inspection and scatter stepping.

**New/revised tasks**:

- [x] `$flow` in variable scopes — DAP variables response includes `$flow` alongside `$ctx` and `$self` (`reagentDebugAdapter.ts`: handleScopes adds $flow ref 400, handleVariables reads `snapshot.flow`)
- [x] `$flow` inline values — `showInlineValues()` renders `$flow.key = val` decorations at paused line (`inlineValues.ts`: 3rd decoration line)
- [x] `$flow` hover on diagram — tooltip at any visited node shows `$flow` snapshot (via `pushStateToSinks` → `updateAgentState` with `$flow`)
- [x] Scatter step-in — when paused at a scatter state, "Step In" enters the first branch; "Step Over" completes all branches (`handleStepIn`/`handleStepOver` with `stateKind` dispatch)
- [x] Scatter branch visualization — active branches highlighted, completed branches dimmed, pending branches faint (via `DiagramController` → `updateDebug` with visited state tracking)
- [x] Invoke/spawn step-in — "Step In" on protocol-level invoke enters the child protocol; "Step Out" returns to parent (`handleStepIn`/`handleStepOut` with `protocolStack`)
- [x] Protocol stack display — when inside a child protocol, call stack shows parent → child chain (`handleStackTrace` with `protocolStack` frames)
- [x] **BUG-1 fix (part 1)**: Trigger bar re-render — `onDidChangeTreeData` was calling `render()` (full HTML rebuild every 3s). Fixed: lightweight `updateTriggerBar()` sends `postMessage` to update only trigger bar DOM.
- [x] **BUG-1 fix (part 2, root cause)**: `IRGraph.initiator` was never set by the compiler → `buildSequenceDiagram` couldn't determine the initiator → all `isInitiator` flags were `false` → trigger bar's `initiatorsOnly` filter returned empty → "no agents deployed". Fixed: `findInitiatorRole()` walks the protocol body to find the sender of the first message. Also added defensive fallback: when initiator filtering produces zero results, show all matching agents.
- [x] **BUG-1 fix (part 3)**: ROS `handleDeployProject` never populated `ProtocolInfo.boundAgents` (always `[]`) → fallback matching in trigger bar never worked. Fixed: populate `boundAgents` from `currentView.agents` after deployment, and keep in sync on `handleAdapterDeployed`.
- [x] **Cluster tree navigation**: click agent → opens project diagram; click protocol → opens `.rg` source + diagram view. New command `reagent.clusterOpenProtocol` searches workspace for the protocol definition.
- [ ] `$agent` state inspection — if agent has native module, show `$agent` properties in scopes
- [ ] IR decompiler preview — "Show IR" command opens decompiled `.rg` in read-only editor (from M8/P4)

**Completed components**:
- `reagentDebugAdapter.ts` — scatter/invoke step-in/step-over/step-out, protocol stack, $flow scopes
- `inlineValues.ts` — $flow inline decorations
- `diagramController.ts` — bridges DAP Stopped events → diagram webview (state highlighting, visited states)

### Phase 4-R: Deployment Schema + Topology View (revision) ⬜

**Goal**: same as M7-DX Phase 4, but driven by `reagent.json` project structure and RC registry.

**New/revised tasks**:

- [ ] `reagent.json`-driven deployment — topology reads project manifest to discover protocols, agents, and node configuration
- [ ] Protocol registry in topology — each RC node shows deployed protocols with versions; version conflicts highlighted in red
- [ ] `canDeploy()` integration — before deploying a protocol, run compatibility check; show warnings in UI for fingerprint mismatches
- [ ] Agent manifest cards — topology node inspector shows `agent.json` data: roles, native module status, config
- [ ] Version badges on protocol boxes — each deployed protocol shows auto-semver version (e.g., "v1.2.0")
- [ ] Dependency graph overlay — toggle showing `invoke`/`spawn` dependency arrows between protocols (from M8 dependency tracking)

### Phase 5-R: Python Simulation (revision) ⬜

**Goal**: same as M7-DX Phase 5, but leveraging existing M6-PYRC rather than building from scratch. The `nmmo-reagent` project (`montevideo/Montevideo/nmmo-reagent/`) is the primary validation target: NMMO multi-agent simulation with Python RC driving hundreds of agents.

**Revised foundation**: M6-PYRC already provides `ReagentController`, `InprocAgentNode`, `InprocTransport`, `IpcAgentNode`. Phase 5-R focuses on the integration layer, not the runtime.

**New/revised tasks**:

- [x] `rc.load(ir_dir)` — reads compiled IR artifacts, resolves agent manifests, registers agents. Uses existing `InprocAgentNode` from M6-PYRC (completed as M9-DX pre-requisite)
- [ ] Jupyter convenience wrapper — `from reagent_runtime import ReagentController; rc = ReagentController("sim"); rc.load("./out"); await rc.start()`
- [ ] Multi-process scale-out — `rc.fork(n=4)` splits agents across processes via `InprocTransport` (intra-process) + `IpcAgentNode` (inter-process)
- [ ] VSCode bridge — Python RC pushes agent status, trace events via control socket → extension topology view updates. Protocol: subset of RAP over TCP
- [ ] Topology sim nodes — `type: "sim"` styling, `InprocAgentNode` label. Agent class aggregation when N > 20 (show "Forager ×30" with class-level stats)
- [ ] ~~`$flow` visualization~~ — removed in v0.0.11; `$ctx` state visible in debugger

### Phase 6-R: Multi-Node Deployment (revision) ⬜

**Goal**: same as M7-DX Phase 6, plus protocol registry integration and version-aware deployment.

**New/revised tasks**:

- [ ] SSH provisioning — same as M7-DX, but deploys `reagent.json`-structured project (not bare IR)
- [ ] Browser bundling — same as M7-DX, but bundle includes protocol version metadata
- [ ] Version-aware deployment — when deploying to an RC that already has a protocol, check `canDeploy()` for compatibility; offer upgrade/rollback
- [ ] Registry dashboard — panel showing all protocols across all RCs with versions, fingerprints, last-deployed timestamps
- [ ] Hot deployment preview — when M8 "hot deploy" is ready, topology UI shows blue-green deployment plan before applying
- [ ] Python node deployment — deploy to Python RC nodes (M6-PYRC-based), same SSH provisioning but runs Python entry point
- [ ] Edge/robot/Docker — same as M7-DX Phase 6

### Phase 7-R: Polish + Export (revision) ⬜

**Goal**: same as M7-DX Phase 7, plus scatter/invoke in Mermaid, version stamps, project-level operations.

**New/revised tasks**:

- [ ] Mermaid export: scatter → `par` block with dynamic participant notation
- [ ] Mermaid export: protocol-level invoke → nested `activate`/`deactivate` block
- [ ] Mermaid export: version stamp in diagram header
- [ ] CLI `reagent diagram --from-trace` includes `$ctx` state in annotations
- [ ] LSP advanced: rename across `reagent.json`-linked files
- [ ] Code actions: "Add scatter participants" quick-fix, "Generate agent.json" scaffold
- [ ] Project-level commands: `reagent init` creates scaffold with `reagent.json`, `protocols/`, `agents/`
- [ ] Multi-instance visualization: `invoke`/`spawn` child diagrams as expandable sub-graphs

### New files (M9-DX)

| File | Purpose | Phase | Status |
|---|---|---|---|
| `lang/src/diagram.ts` | IR-to-diagram data model (sequence + state machine) with scatter/invoke/spawn | 1-R | ✅ |
| `tools/reagent-vscode/src/renderers/sequenceDiagram.ts` | SVG renderer for sequence diagrams | 1-R | ✅ |
| `tools/reagent-vscode/src/renderers/stateMachineDiagram.ts` | SVG renderer for state machine diagrams | 1-R | ✅ |
| `tools/reagent-vscode/src/diagramController.ts` | Bridges DAP Stopped events → diagram webview (state highlighting) | 3-R | ✅ |
| `tools/reagent-vscode/src/projectDiagram.ts` | Project-level scanner + SVG renderer (agents/roles/protocols) | 1.5-R | ✅ |
| `tools/reagent-vscode/src/projectDiagramPanel.ts` | Webview panel for project architecture diagram | 1.5-R | ✅ |
| `tools/reagent-vscode/icons/reagent-{light,dark}.svg` | Benzene hexagon file icons for `.rg` files | 1.5-R | ✅ |
| `tools/reagent-vscode/server/src/server.ts` | LSP server (symbols, go-to-def, hover, completion, diagnostics) | 2-R | ✅ |
| `runtime/tests/m9-scatter-async.test.ts` | E2E test for async zones in scatter branches (SA1-SA4) | Pre-req | ✅ |
| ~~`tools/reagent-vscode/server/src/flowTracker.ts`~~ | ~~LSP: $flow field tracking~~ (removed in v0.0.11) | 2-R | N/A |
| `tools/reagent-vscode/server/src/projectIndex.ts` | LSP: reagent.json-based workspace indexing | 2-R | ⬜ |
| `tools/reagent-vscode/src/registryPanel.ts` | Protocol registry dashboard | 4-R | ⬜ |
| `runtime/py/reagent_runtime/vscode_bridge.py` | Python RC → VSCode control socket | 5-R | ⬜ |
| `runtime/py/reagent_runtime/jupyter.py` | Jupyter convenience wrapper | 5-R | ⬜ |

### Use case enablement (cumulative with M7-DX Phase 0/0.5)

| After phase | New capabilities | Status |
|---|---|---|
| **1-R** | Scatter/invoke/spawn in diagrams, version badges, $flow in replay | ✅ |
| **1.5-R** | Project overview diagram, self-contained VSIX, file icons, ROS robustness | ✅ |
| **2-R** | LSP core: symbols, go-to-def, hover, completion, parse+semantic diagnostics | ✅ |
| **2.5-R** | TextMate grammar v0.0.9 (zone keywords, builtins), diagram layout/styling polish, auction-sim example | ✅ |
| **3-R** | $flow in debugger, scatter stepping, invoke drill-down, protocol stack | ✅ (core) |
| **4-R** | Registry-driven topology, version-aware deployment planning, dependency graph |
| **5-R** | Python simulation with live VSCode bridge (built on real M6-PYRC) |
| **6-R** | Version-aware multi-node deployment, registry dashboard, hot deploy preview |
| **7-R** | Full export with scatter/invoke, project scaffolding, advanced refactoring |

### Phase status

| Phase | Status | Parallelizable with |
|---|---|---|
| Phase 1-R: Diagrams revision | ✅ DONE | Phase 2-R |
| Phase 1.5-R: Infra + Project Overview | ✅ DONE | — |
| Phase 2-R: LSP core | ✅ DONE | Phase 1-R |
| Phase 2.5-R: Grammar + Diagram polish | ✅ DONE | — |
| Phase 3-R: Debugger revision | ✅ DONE (core) | — |
| Phase 4-R: Topology revision | ⬜ | — |
| Phase 5-R: Py simulation revision | ⬜ | Phase 6-R |
| Phase 6-R: Multi-node revision | ⬜ | Phase 5-R |
| Phase 7-R: Polish revision | ⬜ | — |

**Remaining critical path**: 2-R → 4-R → 6-R → 7-R.

---

## Future work (backlog)

Ideas and milestones considered but not yet scheduled.

- **Role multiplicity** (`many` / `foreach`): static participant cardinality declarations. `scatter` (M5-LANG) covers dynamic multicast at runtime, but there's no compile-time cardinality constraint yet. Consider `role Seller [many]` or similar syntax for static analysis of fan-out/fan-in patterns.
- **Engine API v0**: extract a formal language-neutral runtime contract from reference runners. Define `StartInstance`, `SubmitEvent`, `StreamTrace`, `ExecuteAction`, `Cancel`. Reference runners become the reference implementation.
- **Observability**: TraceEvent → OpenTelemetry mapping, trace divergence detection, "why blocked" queries.
- **Delivery guarantees / protocol decorators**: `AgentRef.send()` is fire-and-forget today. At-least-once delivery with retries should be a **protocol decorator** — a standard-library Reagent protocol that wraps user protocols with retry/ack logic. Keeps retry composable, not baked into transport.
- **P2P gossip for node discovery**: nodes exchange `AddressPage`s directly, converging to consistent cluster view without central orchestrator.
- **NatsNodeLink**: wrap NATS as a `NodeLink` implementation. Single subject per node-pair. Fast follow after M5-CTRL.
- ~~**Cross-language loopback**~~: ✅ Done in M5-CTRL / Phase E. `PythonAgentNode` bridges Python child processes via JSON-line IPC. Multi-`AgentNode` RC routes by language.
- **RAP as a Reagent project**: extract the 14 RAP sub-protocols from `tools/rap/` into a proper Reagent project (`reagent-rap` or `@reagent/rap`) with its own `reagent.json`, versioned independently. Currently RAP specs live as loose `.rg` files under `tools/`; they should be a first-class package that other projects can depend on via `reagent.json` `dependencies`. This also validates the package/import resolution system (M8a/P4) end-to-end. Concrete steps: (1) `reagent init` a new project, (2) move `tools/rap/*.rg` into `protocols/`, (3) add `reagent.json` with name `@reagent/rap`, (4) verify `reagent build` compiles all 14, (5) update ROS + CLI to resolve RAP protocols from the package instead of hardcoded paths, (6) publish as the first `reagent_packages/` dependency example.
- **Production hardening**: AuthN/AuthZ on `NodeLink` connections (TLS, mTLS, token auth), quotas, backpressure, operational tooling, crash recovery.
- **Hot protocol deployment**: deploy new protocols to a running cluster without stopping existing agents. Depends on M8a fingerprints + registry + M8b reconciler. See [protocol-versioning.md §12-13](protocol-versioning.md).

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
| RAP sub-protocols | 9 `.rg` specs in `tools/rap/` (01–09) with role defs | M2-LANG / D ✅ | — |
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
| One-click Run | In-process compile + RC, no ROS | M7-DX / 0.5 ✅ | — |
| CodeLens Run/Debug | ▶ Run / 🔍 Debug on `protocol` lines | M7-DX / 0.5 ✅ | — |
| ROS auto-management | Auto-start, status bar, toggle | M7-DX / 0.5 ✅ | — |
| RAP alignment | Compile fields, GetState agentName, InspectError | M7-DX / 0 ✅ | — |
| inspectAgent command | GetState → Output channel | M7-DX / 0 ✅ | — |
| $ctx isolation + $flow propagation | propagateFlow on send/receive | M5-LANG ✅ | T28, T29 |
| Protocol-level invoke | `invokes` in protocol body | M5-LANG ✅ | T30 |
| Protocol-level spawn | `spawns` in protocol body | M5-LANG ✅ | T31 |
| Scatter/gather | `scatter` dynamic multicast + join | M5-LANG ✅ | T32, T33 |
| $ctx.msg par isolation | Per-branch message context | M5-LANG ✅ | T34 |
| reagent.break() | Break sentinel in loops | M5-LANG ✅ | T35 |
| alt where | Pattern matching with where clause | M5-LANG ✅ | T36 |
| Python ReagentController | Routing, registry, interceptors (pure Python) | M6-PYRC ✅ | PRC-T1 |
| InprocAgentNode (Python) | In-process agent with zero-serialization | M6-PYRC ✅ | PRC-T1–T4 |
| IpcAgentNode (Python) | Subprocess agent with JSON-line IPC | M6-PYRC ✅ | PRC-T5 |
| $flow in Python RC | Cross-agent flow propagation | M6-PYRC ✅ | PRC-T6 |
| Protocol fingerprints | SHA-256 hashes for structure, schema, impl | M8a / 1 ✅ | F1, F2 |
| Role fingerprints | SHA-256 hashes for plays, behavior | M8a / 1 ✅ | F1 |
| Auto-semver + reagent.lock | Compiler-driven versioning, CI-safe lock file | M8a / 1 ✅ | F3, F4, F6 |
| Dependency tracking | invoke/spawn record structureHash of target | M8a / 1 ✅ | F5 |
| RC protocol registry (TS) | Register, query, canDeploy, reverse index | M8a / 2 ✅ | R1, R2, R3, R4 |
| RC protocol registry (Python) | Python mirror of ProtocolRegistry | M8a / 2 ✅ | R5 |
| protocolVersion in envelope | Messages carry protocol version field | M8a / 2 ✅ | R4 |
| IR decompiler | IR-to-.rg round-trip for introspection | M8a / 4 ✅ | D1 |
| Reagent project structure | reagent.json, import resolution, protocols/, agents/ | M8a / 4 ✅ | — |
| `reagent init` + `reagent build` CLI | Scaffold project, multi-file build from manifest | M8a / 4 ✅ | — |
| Agent model: $agent binding (TS) | Native module access in zones via extras | M8b / 3 ✅ | A1, A3 |
| Agent model: $agent binding (Python) | Native module access in Python zones | M8b / 3 ✅ | A2, A4 |
| Agent manifest (agent.json) | Single-role agent with native module + config | M8b / 3 ✅ | A5, A6 |
| Async zones | Compile-time `async:true` detection, separate executor | M8b / 3 ✅ | A3, A4 |
| ROS reconciler | Desired-state → actual-state convergence loop | M8b / 5 ✅ | REC1–REC5 |
| DeploySpec + RegistryView | Desired/actual state models for reconciliation | M8b / 5 ✅ | REC1 |
| RAP reconciliation protocols | 10-list-protocols through 14-stop-agent | M8b / 5 ✅ | REC1 |
| `reagent deploy` CLI | Submit deploy spec, wait for reconciliation | M8b / 5 ✅ | REC4 |
| Scatter/invoke/spawn in diagrams | IR-driven rendering of v0.0.8 constructs | M9-DX / 1-R ✅ | — |
| Project Overview Diagram | Agents→Roles→Protocols graph scoped to reagent.json | M9-DX / 1.5-R ✅ | — |
| Self-contained VSIX | Bundled lang compiler, no source tree dependency | M9-DX / 1.5-R ✅ | — |
| .rg file icon | Benzene hexagon ring (light + dark) | M9-DX / 1.5-R ✅ | — |
| ROS manager robustness | Port probe, adopt existing, freePort(), TCP probe | M9-DX / 1.5-R ✅ | — |
| LSP core | Document symbols, go-to-def, hover, completion, diagnostics | M9-DX / 2-R ✅ | — |
| $flow in debugger | $flow inspection, inline values, diagram hover | M9-DX / 3-R ✅ | — |
| Scatter/invoke step-in | Branch stepping, child protocol drill-down | M9-DX / 3-R ✅ | — |
| Diagram ↔ debug sync | DiagramController: DAP events → diagram state highlighting | M9-DX / 3-R ✅ | — |
| Registry-driven topology | Version badges, canDeploy, dependency graph | M9-DX / 4-R ⬜ | — |
| Python simulation bridge | Python RC → VSCode live topology | M9-DX / 5-R ⬜ | — |
| Version-aware deployment | Fingerprint checks, registry dashboard, hot deploy | M9-DX / 6-R ⬜ | — |
| Scatter/invoke in Mermaid | Export v0.0.8 constructs to Mermaid/SVG | M9-DX / 7-R ⬜ | — |
| Project scaffolding | `reagent init`, reagent.json-driven workspace | M9-DX / 7-R ⬜ | — |
