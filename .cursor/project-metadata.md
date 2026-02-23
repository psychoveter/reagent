# Reagent — project metadata

Path: `/Users/Oleg.Bukhvalov/projects/cyclon/projects/reagent`

## Idea / purpose

Reagent is a **language + toolchain** for implementing *agentic / distributed protocols*.

Core problem:

- In distributed programming there is often **no single artifact** that describes the distributed algorithm ("the protocol").
- Instead you typically have separate implementations per side/role, which makes it harder to review, debug, render, evolve, and reuse the protocol.

Approach:

- Use a **single protocol artifact** written in a dedicated DSL that is both human-readable and renderable.
- Mix protocol choreography and host-language code in one file ("React-like": `jsx` analogy).
- Compile protocol → per-participant **agent-level state machines** (IR) executable by pluggable engines.

## Bird's-eye view

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        LANGUAGE & TOOLCHAIN                             │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────────────────────┐ │
│  │  .rg source  │───▶│  @reagent/   │───▶│  Compiled IR artifacts     │ │
│  │              │    │  lang        │    │                            │ │
│  │  protocol    │    │  ──────────  │    │  Proto.role.ir.json        │ │
│  │  message {}  │    │  parser      │    │  Agent.agent.json          │ │
│  │  role        │    │  ir-emitter  │    │  RoleName.role.json        │ │
│  │  agent       │    │  validator   │    │  messages.json             │ │
│  │  import      │    │              │    │  deployment.json           │ │
│  └──────────────┘    │  CLI         │    └────────────┬───────────────┘ │
│                      └──────────────┘                 │                 │
│  ┌──────────────────────────────────────┐             │                 │
│  │  reagent-vscode (VSIX)               │             │                 │
│  │  TextMate grammar + embedded langs   │             │                 │
│  │  DAP debug adapter + debug panel     │             │                 │
│  └──────────────────────────────────────┘             │                 │
├───────────────────────────────────────────────────────┼─────────────────┤
│                      REFERENCE RUNTIMES               │                 │
│                                                       ▼                 │
│  ┌────────────────────────────────────────────────────────────────────┐│
│  │  ReagentController (TS RC) — routing, interceptors, multi-AgentNode│
│  │  agentNodes: { ts: NativeAgentNode, py: PythonAgentNode }         ││
│  └────────┬───────────────────────────┬──────────────────────────────┘│
│           │                           │                               │
│  ┌────────▼─────────┐    ┌───────────▼─────────┐                    │
│  │  NativeAgentNode  │    │  PythonAgentNode     │                    │
│  │  TS AgentRunner   │    │  child process IPC   │                    │
│  │  runtime/ts/      │    │  JSON-line stdio     │                    │
│  │  zones in JS/TS   │    │  runtime/py/         │                    │
│  └──────────────────┘    └─────────────────────┘                    │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────────┐│
│  │  ReagentController (Python RC) — pure-Python orchestrator          ││
│  │  agentNodes: { py: InprocAgentNode, ipc: IpcAgentNode }           ││
│  │  InprocTransport (per-agent, routes via RC callback)               ││
│  │  Use case: NMMO-style multi-agent simulations, no NATS needed      ││
│  └────────────────────────────────────────────────────────────────────┘│
│                                                                       │
│  ┌───────────────────────────────────────────────────────────────────┐│
│  │  InMemoryNodeLink │ WsNodeLink │ NatsCompatTransport (legacy)     ││
│  └───────────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────────────┤
│                    M6-RT: Orchestrator + Debugger ✅                     │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Reagent Orchestrator Server (ROS) — Node.js, WebSocket          │  │
│  │  Session mgmt │ RAP protocol │ Trace collector │ Source mapping   │  │
│  │  DebugController │ DebugInterceptor │ DebugAdvanceHook           │  │
│  └──────┬────────────────┬────────────────┬─────────────────────────┘  │
│         │ RAP/WS         │ RAP/WS         │ RAP/WS                     │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐                    │
│  │ TS Adapter   │  │ Py Adapter   │  │ Losos       │ (future)          │
│  │ ref runtime  │  │ ref runtime  │  │ Bridge      │                    │
│  └─────────────┘  └─────────────┘  └─────────────┘                    │
│         │                                                               │
│  ┌──────▼────────────────────────────────────────────────────────────┐ │
│  │  VSCode Extension (RAP client)                                    │ │
│  │  DAP debug │ Debug panel │ Inline values │ Trace timeline         │ │
│  └───────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────┤
│                    FUTURE: Production engines                           │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Losos Engine (Kotlin / etcd)                                    │   │
│  │  Guard-Action network │ Multi-slot guards │ Production-grade     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  LangGraph Bridge (Python / LangGraph)                           │   │
│  │  Map IR to LangGraph state machines                              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘

Data plane: ReagentController loopback + NodeLink (NATS demoted to optional NodeLink impl); Python RC uses InprocTransport for zero-overhead in-process routing
Control plane: RAP over WebSocket (ROS ↔ adapters ↔ VSCode)
RAP sub-protocols: 7 .rg specs in tools/rap/ (with role definitions)
```

## Current state (2026-02-21)

### Language: v0.0.8

The Reagent DSL is defined in `docs/lang-spec.md`.

Key design commitments:
- **Meta-language**: Reagent describes choreography; actual computation lives in **agent zones** written in a host language (`ts`/`js`/`py`/`kt`).
- **Role-centric design**: `role` is the primary behavioral contract (plays, init, handlers, `$self`, inheritance). `agent` is a thin deployment binding (`agent Name runs RoleName`).
- **`[*]` wildcard lang tag**: marks language-agnostic participants. Zone blocks forbidden for `[*]` roles. Enables wire-only protocol specs.
- **Typed messages**: `message Name { field: type }` top-level construct. Minimal type system (`string`, `number`, `boolean`, `any`, `type[]`, `{ ... }`, `?`). Duck typing. Backward compatible.
- **Protocol-as-function**: `protocol Name { participants: ..., initiator: ..., input: ... }`.
- **Hook zones**: `onSend { ... }` / `onReceive { ... }` inside message props.
- **`reagent.*` runtime library**: `reagent.return`, `reagent.emit`, `reagent.break`.
- **Context split**: `$ctx` (per-role isolated), `$flow` (message-propagated), `$self` (role-level persistent).
- **Protocol-level `invokes`/`spawns`/`scatter`**: child protocol calls and dynamic multicast at choreography level (`<role> invokes Proto(...)`, `<role> spawns Proto(...)`).
- **`alt where`**: explicit pattern matching in `alt` guards.
- **Role definition**: `role Name [langTag]? extends Parent? { plays; init; on ... }` — primary behavioral contract with optional inheritance.
- **Agent definition**: `agent Name [langTag]? runs RoleName` — thin deployment binding.
- **Protocol-level control flow**: `alt`, `loop`, `par`, `wait`, `timeout`, `try/catch`, `invokes`, `spawns`, `scatter`.
- **Imports**: `.rg` = protocol imports, `.ts/.js/.py/.kt` = code module imports.
- **Top-level constructs**: `import`, `protocol`, `agent`, `message`, `role`.

### Examples corpus

`examples/src/` (source) and `examples/out/` (compiled IR):

| # | File | Key constructs |
|---|---|---|
| 00 | `protocol-wrapper.rg` | Protocol wrapper pattern |
| 01 | `task-execution-basic.rg` | Message steps, agent zones, hooks |
| 02 | `await-timeout-and-alt.rg` | Alt (message + timeout guards) |
| 03 | `loop-retry-backoff.rg` | Loop with guard |
| 04 | `parallel-subtasks.rg` | Par with join |
| 05 | `spawn-subagent.rg` | reagent.spawn |
| 06 | `exception-abort-compensate.rg` | Try/catch |
| 07 | `child-protocol-invoke.rg` | reagent.invoke (child protocol) |
| 08 | `import-and-invoke.rg` | Protocol imports |
| 09 | `invoke-multiparty-child-protocol.rg` | Multi-party child protocol |
| 10 | `external-event-start-and-emit.rg` | External event, reagent.emit |
| 11 | `llmbroka-call-and-return.rg` | LLM broker, reagent.return |
| 12 | `agent-multi-protocol.rg` | Role with lifecycle, agent runs, multi-protocol |
| 13 | `cross-lang-demo.rg` | TS + Python roles, alt branching |
| 14 | `ts-only-demo.rg` | TS-only, E2E test target |
| 15 | `loop-and-wait-demo.rg` | Loop + wait, E2E test target |
| 16 | `parallel-demo.rg` | Par fork/join, E2E test target |
| 17 | `try-catch-demo.rg` | Try/catch, E2E test target |
| 18 | `invoke-demo.rg` | reagent.invoke, E2E test target |
| 19 | `spawn-emit-demo.rg` | reagent.spawn + emit, E2E test target |
| 20 | `cross-lang-e2e.rg` | TS ↔ Python, E2E test target |
| 21 | `role-inheritance.rg` | Role `extends`, plays/init/handler merging |
| 22 | `multi-protocol-agent.rg` | Agent plays two protocols concurrently, shared `$self` |
| 23 | `scatter-gather.rg` | `scatter` / gather, dynamic multicast, `$flow` propagation |
| 24 | `call-for-proposal.rg` | CFP pattern via `scatter`, `alt where` |
| — | `task-execution.rg` | Legacy example |
| — | `lib/*.rg` | Shared sub-protocols (3 files) |

All 26 examples + 3 libs compile and validate successfully.

### RAP sub-protocol specs

`tools/rap/` (source) and `tools/rap/out/` (compiled IR):

| # | File | Participants | Roles | Key constructs |
|---|---|---|---|---|
| 01 | `adapter-handshake.rg` | adapter, orchestrator | `RAPAdapter`, `RAPOrchestrator` | Registration, alt accept/reject |
| 02 | `compile-request.rg` | client, orchestrator | `RAPClient`, `RAPCompiler` | Compile, alt success/error |
| 03 | `deploy-agent.rg` | orchestrator, adapter | `RAPDeployer`, `RAPNode` | Deploy IR to node, alt success/fail |
| 04 | `run-protocol.rg` | orchestrator, adapter | `RAPRunner`, `RAPExecutor` | Trigger + completion |
| 05 | `debug-session.rg` | client, orchestrator, adapter | `RAPDebugClient`, `RAPDebugRelay`, `RAPDebugTarget` | Debug command relay |
| 06 | `inspect-state.rg` | client, orchestrator, adapter | `RAPInspectClient`, `RAPInspectRelay`, `RAPInspectTarget` | State snapshot relay |
| 07 | `set-breakpoints.rg` | client, orchestrator | `RAPBreakpointClient`, `RAPBreakpointResolver` | Breakpoint resolution |

All 7 RAP specs compile with role definitions and message schemas.

### Compiler CLI (`@reagent/lang`)

```
reagent-lang parse    <file.rg>               — AST as JSON
reagent-lang ir       <file.rg> [role]         — IR to stdout
reagent-lang validate <file.rg> [role]         — IR + validation diagnostics
reagent-lang compile  <file.rg> <out-dir>      — .ir.json + .agent.json + .role.json + messages.json + deployment.json
```

### Reference runtimes (TS + Python)

Lightweight **reference runners** that interpret IR JSON. Transport-agnostic via `ReagentTransport` interface.

| Component | Language | Path | Status |
|---|---|---|---|
| AgentRunner + ProtocolInstance | TypeScript | `runtime/ts/` | Full IR support |
| AgentRunner + ProtocolInstance | Python | `runtime/py/` | Full IR support (mirrors TS) |
| ReagentController | TypeScript | `runtime/ts/src/reagent-controller.ts` | Multi-AgentNode routing + interceptors |
| ReagentController | Python | `runtime/py/reagent_runtime/controller.py` | Multi-AgentNode routing + interceptors (mirrors TS) |
| NativeAgentNode | TypeScript | `runtime/ts/src/native-agent-node.ts` | TS agent platform adapter |
| InprocAgentNode | Python | `runtime/py/reagent_runtime/inproc_agent_node.py` | In-process Python agent adapter |
| IpcAgentNode | Python | `runtime/py/reagent_runtime/ipc_agent_node.py` | Subprocess Python agent adapter |
| InprocTransport | Python | `runtime/py/reagent_runtime/inproc_transport.py` | In-process routing via RC callback |
| AgentHandle / AgentNode protocols | Python | `runtime/py/reagent_runtime/agent_node.py` | Platform abstraction protocols |
| PythonAgentNode | TypeScript | `runtime/ts/src/python-agent-node.ts` | Python child process + JSON-line IPC |
| InMemoryNodeLink | TypeScript | `runtime/ts/src/inmemory-node-link.ts` | In-process inter-node pipe |
| WsNodeLink + WsNodeLinkServer | TypeScript | `runtime/ts/src/ws-node-link.ts` | WebSocket-based NodeLink |
| ReagentOrchestratorServer | TypeScript | `runtime/ts/src/ros.ts` | ROS: compile, deploy, run, debug via WS |
| Session + SessionManager | TypeScript | `runtime/ts/src/session.ts` | Per-program execution context |
| DebugInterceptor | TypeScript | `runtime/ts/src/debug-interceptor.ts` | Message-level debug (hold + step) |
| DebugAdvanceHook | TypeScript | `runtime/ts/src/debug-advance-hook.ts` | State-level debug (pause before IR states) |
| DebugController | TypeScript | `runtime/ts/src/debug-controller.ts` | Coordinates message + state debug |
| RemoteNode | TypeScript | `runtime/ts/src/remote-node.ts` | Standalone agent node (connects to ROS) |
| NatsCompatTransport | TypeScript | `runtime/ts/src/nats-compat-transport.ts` | Legacy NATS shim |
| LocalTransport | Python | `runtime/py/reagent_runtime/local_transport.py` | Stdout-based IPC transport |
| IPC Agent | Python | `runtime/py/reagent_runtime/ipc_agent.py` | Stdin/stdout bridge entry point |
| Shared protocol types | TypeScript | `runtime/shared/protocol.ts` | Defined |
| Legacy E2E tests (NATS) | TypeScript | `runtime/tests/e2e.test.ts` | **20/20 passing** (T1–T20) |
| M5-CTRL E2E tests | TypeScript | `runtime/tests/m5-ctrl.test.ts` | **12/12 passing** (C1–C12) |
| M5-LANG E2E tests | TypeScript | `runtime/tests/m5-lang.test.ts` | **9/9 passing** (T28–T36) |
| M6-RT E2E tests | TypeScript | `runtime/tests/m6-ros.test.ts` | **7/7 passing** (T21–T27) |
| M5-COVERAGE E2E tests | TypeScript | `runtime/tests/m5-coverage.test.ts` | **10/10 passing** (C13–C22: par fan-out, alt XOR, break, try/catch, $ctx.msg par isolation, role inheritance, lifecycle, wildcard) |
| Python RC E2E tests | Python | `runtime/tests/test_py_rc.py` | **6/6 passing** (T1–T6: loopback, invoke, spawn, par, $flow, IPC) |
| Python RC Coverage tests | Python | `runtime/tests/test_py_rc_coverage.py` | **8/8 passing** (T7–T14: loop, timer, alt expr, alt XOR, try/catch, break, lifecycle completed/failed) |

All IR constructs supported at runtime: `initial`, `send`, `receive`, `action`, `guard(xor/expression)`, `terminal`, `timer`, `fork`, `join`, `error`, `invoke`, `spawn`, `scatter`.

### Tooling

| Module | Version | Path | Description |
|---|---|---|---|
| `@reagent/lang` | 0.0.8 | `lang/` | Compiler: AST, parser, IR emitter, IR validator, CLI |
| `reagent-vscode` | 0.0.8 | `tools/reagent-vscode/` | TextMate grammar + embedded language support + DAP debug adapter + Run/Debug CodeLens |

### Specs / docs

| Document | Path | Content |
|---|---|---|
| `lang-spec.md` | `docs/lang-spec.md` | Language spec v0.0.8: syntax + EBNF + $ctx/$flow split + invokes/spawns/scatter + alt where |
| `reagent-spec.md` | `docs_v0.0.1/reagent-spec.md` | Core spec v0.0.1: layers, TraceEvent algebra, legality, runtime |
| `ir-losos-mapping.md` | `docs/ir-losos-mapping.md` | IR → Losos engine mapping |
| `backlog.md` | `docs/backlog.md` | Backlog & milestone history |
| `connectivity.md` | `docs/connectivity.md` | Connectivity layer (routing, AgentNode, interceptors) |
| `orchestrator.md` | `docs/orchestrator.md` | Orchestrator service (ROS, debug, VSCode) |
| `dx-tooling.md` | `docs/dx-tooling.md` | M7-DX: visualization, visual debugger, runner, export (draft-1) |

## Architecture layers

1. **Protocol level** — `.rg` files with DSL choreography + embedded host-language code.
2. **Role level** — per-role IR graphs (IRGraph: directed graph of states + transitions).
3. **Behavioral level** — role definitions (RoleIR: rich behavioral contracts with lifecycle, init, handlers, extends).
4. **Agent level** — per-agent IR (AgentIR: thin deployment binding referencing a role) + resolved behavioral data from RoleIR.
5. **Message level** — typed message schemas (IRMessageSchema) compiled alongside IR.
6. **Connectivity level** (M5-CTRL ✅) — `ReagentController` + `AgentNode` + `NodeLink`: `AgentRef`/`NodeRef` addressing (ActorRef pattern), multi-agent nodes, loopback routing, message-level interceptors + agent-level `TraceHook`, static discovery via `AddressPage`. Multi-`AgentNode` RC dispatches by language (`ts` → `NativeAgentNode`, `py` → `PythonAgentNode`). No separate messaging layer — Reagent is the messaging system. See [connectivity.md](../docs/connectivity.md).
7. **Execution level** — runtime engines that interpret agent IR via `AgentNode` platform abstraction. `NativeAgentNode` wraps TS `AgentRunner`. `PythonAgentNode` spawns Python child processes with JSON-line IPC. Python `InprocAgentNode` wraps Python `AgentRunner` in-process (zero-serialization). Python `IpcAgentNode` spawns Python subprocesses from the Python RC. Future: `LososAgentNode` (Kotlin/etcd), `LangGraphAgentNode`.
8. **Control level** (M6-RT ✅) — Reagent Orchestrator Server (ROS): WebSocket service for compile/deploy/run/debug. `WsNodeLink` for network transport. Two-level debug: `DebugInterceptor` (message-level) + `DebugAdvanceHook` (state-level, zone-aware). `DebugController` coordinates both levels with source-map-based breakpoint resolution. `RemoteNode` connects via WsNodeLink for distributed agent nodes. VSCode extension with DAP debug adapter, debug panel, and inline value decorations. See [orchestrator.md](../docs/orchestrator.md).

## Milestone status

| Milestone | Status | Description |
|---|---|---|
| M0 | ✅ DONE | Losos test harness on etcd 3.6 |
| M1 | ✅ DONE | Language spec hardening (v0.0.4) |
| M2 | ✅ DONE | AST + Parser + IR + Agent IR (v0.0.5) |
| M-RT | ✅ DONE | Reference runtimes: TS + Python AgentRunners over NATS (T1–T5) |
| M1-RT | ✅ DONE | Full IR construct support: loop, par, wait, try/catch, invoke, spawn, cross-lang, trace validation (T6–T20) |
| M2-LANG | ✅ DONE | Language v0.1: `[*]` wildcard, typed messages, 25 examples updated, 7 RAP specs |
| M3-LANG | ✅ DONE | Language v0.0.6: `role` construct + `implements` keyword |
| M4-LANG | ✅ DONE | Language v0.0.7: role-centric refactoring (`extends`, `runs`, role as primary contract) |
| M5-CTRL | ✅ DONE | Connectivity layer: `AgentRef`/`NodeRef` addressing, `NodeLink`, `ReagentController` (multi-AgentNode), `NativeAgentNode`, `PythonAgentNode`, loopback, interceptors + `TraceHook`, `AddressPage`. C1–C12 pass. [Design](../docs/connectivity.md) |
| M5-LANG | ✅ DONE | Language v0.0.8: `$ctx`/`$flow` split, protocol-level `invokes`/`spawns`/`scatter`, `alt where`, `reagent.break()`, `$ctx.msg` par isolation, message inbox buffering. T28–T36 pass. Syntax: `<role> invokes/spawns Proto(...)`. |
| M6-RT | ✅ DONE | Orchestrator service (ROS) + two-level debugger + remote nodes + VSCode extension. T21–T27 pass. [Design](../docs/orchestrator.md) |

## Development workflow

Development is **E2E test-driven**:
1. Write or extend a `.rg` example exercising the construct.
2. Compile with `reagent-lang compile`.
3. Add an E2E test case that runs agents, asserts trace and `$self` state.
4. Implement/extend reference runners to pass the test.
5. Update specs/docs.

## Version sync policy

| Component | Current version | Sync rule |
|---|---|---|
| Language (lang-spec.md) | **v0.0.8** | Source of truth for language surface |
| `@reagent/lang` package | 0.0.8 | Tracks language version directly |
| `reagent-vscode` extension | 0.0.8 | Tracks language version directly. |
| `reagent-spec.md` (core spec) | v0.0.1 | Bump when TraceEvent algebra / runtime contract changes |

## Intended use in CognOS

- **(a) Language for agent communication**: protocols define interaction patterns between angels/daemons.
- **(b) Knowledge base for planning**: protocols as reusable "procedural knowledge" for agents like comma (communication) and plana (planning).
