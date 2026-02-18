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
│  └──────────────────────────────────────┘             │                 │
├───────────────────────────────────────────────────────┼─────────────────┤
│                      REFERENCE RUNTIMES               │                 │
│                                                       ▼                 │
│  ┌──────────────────┐    ┌──────────────────┐    ┌─────────┐           │
│  │  TS AgentRunner   │    │  Py AgentRunner   │    │  NATS   │           │
│  │  runtime/ts/      │◀──▶│  runtime/py/      │◀──▶│  4222   │           │
│  │                   │    │                   │    └─────────┘           │
│  │  interprets IR    │    │  mirrors TS       │         ▲               │
│  │  zones in JS/TS   │    │  zones in Python  │         │               │
│  └──────────────────┘    └──────────────────┘         │               │
│                                                        │               │
│  ┌─────────────────────────────────────────────────────┘               │
│  │  orchestrator.ts — compile + deploy + trace                         │
│  └─────────────────────────────────────────────────────────────────────│
├─────────────────────────────────────────────────────────────────────────┤
│                    PLANNED: M5-RT (debugger milestone)                   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Reagent Orchestrator Server (ROS) — Node.js, WebSocket          │  │
│  │  Session mgmt │ RAP protocol │ Trace collector │ Source mapping   │  │
│  └──────┬────────────────┬────────────────┬─────────────────────────┘  │
│         │ RAP/WS         │ RAP/WS         │ RAP/WS                     │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐                    │
│  │ TS Adapter   │  │ Py Adapter   │  │ Losos       │ (future)          │
│  │ ref runtime  │  │ ref runtime  │  │ Bridge      │                    │
│  └─────────────┘  └─────────────┘  └─────────────┘                    │
│         │                                                               │
│  ┌──────▼────────────────────────────────────────────────────────────┐ │
│  │  VSCode Extension (RAP client)                                    │ │
│  │  Compile │ Deploy │ Debug │ Graph viz │ Trace timeline            │ │
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

Data plane: NATS (agent ↔ agent messages + trace events)
Control plane: RAP over WebSocket (ROS ↔ adapters ↔ VSCode)
RAP sub-protocols: 7 .rg specs in examples/src/rap/
```

## Current state (2026-02-18)

### Language: v0.0.7

The Reagent DSL is defined in `docs/lang-spec.md`.

Key design commitments:
- **Meta-language**: Reagent describes choreography; actual computation lives in **agent zones** written in a host language (`ts`/`js`/`py`/`kt`).
- **Role-centric design**: `role` is the primary behavioral contract (plays, init, handlers, `$self`, inheritance). `agent` is a thin deployment binding (`agent Name runs RoleName`).
- **`[*]` wildcard lang tag**: marks language-agnostic participants. Zone blocks forbidden for `[*]` roles. Enables wire-only protocol specs.
- **Typed messages**: `message Name { field: type }` top-level construct. Minimal type system (`string`, `number`, `boolean`, `any`, `type[]`, `{ ... }`, `?`). Duck typing. Backward compatible.
- **Protocol-as-function**: `protocol Name { participants: ..., initiator: ..., input: ... }`.
- **Hook zones**: `onSend { ... }` / `onReceive { ... }` inside message props.
- **`reagent.*` runtime library**: `reagent.invoke`, `reagent.spawn`, `reagent.return`, `reagent.emit`.
- **`$ctx`** — per-protocol-instance context. **`$self`** — role-level persistent state.
- **Role definition**: `role Name [langTag]? extends Parent? { plays; init; on ... }` — primary behavioral contract with optional inheritance.
- **Agent definition**: `agent Name [langTag]? runs RoleName` — thin deployment binding.
- **Protocol-level control flow**: `alt`, `loop`, `par`, `wait`, `timeout`, `try/catch`.
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
| — | `task-execution.rg` | Legacy example |
| — | `lib/*.rg` | Shared sub-protocols (3 files) |
| — | `rap/*.rg` | RAP sub-protocol specs (7 files) |

All 23 examples + 3 libs + 7 RAP specs compile and validate successfully.

### Compiler CLI (`@reagent/lang`)

```
reagent-lang parse    <file.rg>               — AST as JSON
reagent-lang ir       <file.rg> [role]         — IR to stdout
reagent-lang validate <file.rg> [role]         — IR + validation diagnostics
reagent-lang compile  <file.rg> <out-dir>      — .ir.json + .agent.json + .role.json + messages.json + deployment.json
```

### Reference runtimes (TS + Python)

Lightweight **reference runners** that interpret IR JSON directly over NATS:

| Component | Language | Path | Status |
|---|---|---|---|
| AgentRunner + ProtocolInstance | TypeScript | `runtime/ts/` | Full IR support |
| AgentRunner + ProtocolInstance | Python | `runtime/py/` | Full IR support (mirrors TS) |
| Orchestrator | TypeScript | `runtime/orchestrator.ts` | Compile + launch + trace |
| Shared protocol types | TypeScript | `runtime/shared/protocol.ts` | Defined |
| E2E test suite | TypeScript | `runtime/tests/e2e.test.ts` | **20/20 passing** (T1–T20) |

All IR constructs supported at runtime: `initial`, `send`, `receive`, `action`, `guard(xor/expression)`, `terminal`, `timer`, `fork`, `join`, `error`.

### Tooling

| Module | Version | Path | Description |
|---|---|---|---|
| `@reagent/lang` | 0.0.7 | `lang/` | Compiler: AST, parser, IR emitter, IR validator, CLI |
| `reagent-vscode` | 0.1.0 | `tools/reagent-vscode/` | TextMate grammar + embedded language support |

### Specs / docs

| Document | Path | Content |
|---|---|---|
| `lang-spec.md` | `docs/lang-spec.md` | Language spec v0.0.7: syntax + EBNF + role-centric design + extends + runs |
| `reagent-spec.md` | `docs_v0.0.1/reagent-spec.md` | Core spec v0.0.1: layers, TraceEvent algebra, legality, runtime |
| `ir-to-losos-mapping.md` | `docs/ir-to-losos-mapping.md` | IR → Losos design doc |
| `reagent-losos-project-plan.md` | `.cursor/reagent-losos-project-plan.md` | Milestones plan |
| RAP architecture plan | `.cursor/plans/multi-runtime_debug_architecture_d3fed9bd.plan.md` | ROS + RAP + debug protocol design |

## Architecture layers

1. **Protocol level** — `.rg` files with DSL choreography + embedded host-language code.
2. **Role level** — per-role IR graphs (IRGraph: directed graph of states + transitions).
3. **Behavioral level** — role definitions (RoleIR: rich behavioral contracts with lifecycle, init, handlers, extends).
4. **Agent level** — per-agent IR (AgentIR: thin deployment binding referencing a role) + resolved behavioral data from RoleIR.
5. **Message level** — typed message schemas (IRMessageSchema) compiled alongside IR.
6. **Connectivity level** (M5-CTRL, planned) — ReagentController + AgentNode: transport abstraction, multi-agent nodes, loopback routing, interceptor chain, adapter pattern. See [design doc](../docs/m5-ctrl-design.md).
7. **Execution level** — runtime engines that interpret agent IR via ReagentAdapter. NativeAdapter wraps reference runners (TS/Python). Losos (Kotlin/etcd) as future production adapter.
8. **Control level** (M6-RT, planned) — Reagent Orchestrator Server (ROS) coordinating adapters via RAP over WebSocket.

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
| M5-CTRL | ⬜ NEXT | Connectivity layer: ReagentTransport interface, AgentNode (multi-agent), LoopbackTransport, ReagentController + interceptors, NativeAdapter. [Design doc](../docs/m5-ctrl-design.md). Phases: A (transport interface), B (loopback + inmemory), C (RC + adapter + node), D (deployment + E2E) |
| M6-RT | ⬜ backlog | Multi-runtime orchestrator (ROS) + debugger + VSCode extension |

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
| Language (lang-spec.md) | **v0.0.7** | Source of truth for language surface |
| `@reagent/lang` package | 0.0.7 | Tracks language version directly |
| `reagent-vscode` extension | 0.1.0 | Tracks language changes; bump minor on syntax changes |
| `reagent-spec.md` (core spec) | v0.0.1 | Bump when TraceEvent algebra / runtime contract changes |

## Intended use in CognOS

- **(a) Language for agent communication**: protocols define interaction patterns between angels/daemons.
- **(b) Knowledge base for planning**: protocols as reusable "procedural knowledge" for agents like comma (communication) and plana (planning).
