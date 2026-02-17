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

## Current state (2026-02-17)

### Language: v0.0.5

The Reagent DSL is defined in `lang-spec.md` (version header: v0.0.5).

Key design commitments solidified:
- **Meta-language**: Reagent describes choreography; actual computation lives in **agent zones** written in a host language (`ts`/`js`/`py`/`kt`).
- **Protocol-as-function**: `protocol Name { participants: ..., initiator: ..., input: ... }`.
- **Language tag on participants**: `comma [ts], sia [py]` — agent zones are bare `Name { ... }`.
- **Hook zones**: `onSend { ... }` / `onReceive { ... }` inside message props.
- **`reagent.*` runtime library**: `reagent.invoke`, `reagent.spawn`, `reagent.return`, `reagent.emit` — available in all agent zones, NOT protocol-level constructs.
- **`$ctx`** — per-protocol-instance runtime-injected binding (protocol instance context).
- **`$self`** — agent-level persistent state, accessible in agent zones and protocol zones.
- **Agent definition**: `agent Name [langTag] { plays Proto as role; init { ... }; on event(Proto) { ... } }`.
- **Protocol-level control flow**: `alt`, `loop`, `par`, `wait`, `timeout`, `try/catch`.
- **No `if/else`, `break`, `throw`, `spawn` at protocol level** — these are host-language constructs inside zones.
- **Imports**: `.rg` = protocol imports, `.ts/.js/.py/.kt` = code module imports.
- **Top-level constructs**: `import ...`, `protocol Name { ... }`, and `agent Name [langTag] { ... }` at file top-level.

### Examples corpus

`projects/reagent/examples/` with `src/` (source) and `out/` (compiled IR):

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
| 12 | `agent-multi-protocol.rg` | Agent def, plays, init, lifecycle |
| 13 | `cross-lang-demo.rg` | TS + Python agents, alt branching |
| 14 | `ts-only-demo.rg` | TS-only, E2E test target |
| — | `task-execution.rg` | Legacy example |
| — | `lib/*.rg` | Shared sub-protocols |

### Compiler CLI (`@reagent/lang`)

The `reagent-lang` CLI compiles `.rg` files:

```
reagent-lang parse    <file.rg>               — AST as JSON
reagent-lang ir       <file.rg> [role]         — IR to stdout
reagent-lang validate <file.rg> [role]         — IR + validation diagnostics
reagent-lang compile  <file.rg> <out-dir>      — per-role .ir.json + per-agent .agent.json + deployment.json
```

All 16 example files compile and validate successfully.

### Reference runtimes (TS + Python)

Lightweight **reference runners** that interpret IR JSON directly over NATS:

| Component | Language | Path | Status |
|---|---|---|---|
| AgentRunner + ProtocolInstance | TypeScript | `runtime/ts/` | Working (messages, alt, zones, $self) |
| AgentRunner + ProtocolInstance | Python | `runtime/py/` | Working (mirrors TS) |
| Orchestrator | TypeScript | `runtime/orchestrator.ts` | Working (compile + launch + trace) |
| Shared protocol types | TypeScript | `runtime/shared/protocol.ts` | Defined |
| E2E test suite | TypeScript | `runtime/tests/e2e.test.ts` | 5/5 passing (T1–T5) |

Supported IR constructs at runtime: `initial`, `send`, `receive`, `action`, `guard(xor)`, `terminal`.
Not yet supported: `loop`, `par`, `try/catch`, `wait/timer`, `fork/join`, `reagent.invoke/spawn`.

### Tooling

| Module | Version | Path | Description |
|---|---|---|---|
| `@reagent/lang` | 0.0.5 | `lang/` | Compiler: AST, parser, IR emitter, IR validator, CLI |
| `reagent-vscode` | 0.1.0 | `tools/reagent-vscode/` | TextMate grammar + embedded language support |

### Specs / docs

| Document | Path | Content |
|---|---|---|
| `lang-spec.md` | `projects/reagent/lang-spec.md` | Language spec v0.0.5: syntax + EBNF + agent definition |
| `reagent-spec.md` | `projects/reagent/docs_v0.0.1/reagent-spec.md` | Core spec v0.0.1: layers, TraceEvent algebra, legality, runtime |
| `ir-to-losos-mapping.md` | `projects/reagent/docs/ir-to-losos-mapping.md` | IR → Losos design doc |
| `reagent-losos-project-plan.md` | `.cursor/reagent-losos-project-plan.md` | Milestones plan |

## Architecture layers

1. **Protocol level** — `.rg` files with DSL choreography + embedded host-language code.
2. **Role level** — per-role IR graphs (IRGraph: directed graph of states + transitions).
3. **Agent level** — per-agent IR (AgentIR: plays bindings + init + lifecycle handlers) + its role IRGraphs.
4. **Execution level** — runtime engines that interpret agent IR. Reference runners (TS/Python over NATS) and Losos (Kotlin/etcd) as future production engine.

## Milestone status

| Milestone | Status | Description |
|---|---|---|
| M0 | DONE | Losos test harness on etcd 3.6 |
| M1 | DONE | Language spec hardening (v0.0.4) |
| M2 | DONE | AST + Parser + IR + Agent IR (v0.0.5) |
| M-RT | DONE | Reference runtimes: TS + Python AgentRunners over NATS, E2E tests |
| M-RT2 | NEXT | Extend reference runners: loop, par, wait, try/catch, invoke/spawn |
| M-RT3 | — | Trace validation, legality checking in reference runners |
| M-RT4 | — | Cross-language E2E (TS ↔ Python over NATS) |
| M3 | — | Engine API v0 (language-neutral runtime contract) |
| M4 | — | Losos engine adapter |

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
| Language (lang-spec.md) | **v0.0.5** | Source of truth for language surface |
| `@reagent/lang` package | 0.0.5 | Tracks language version directly |
| `reagent-vscode` extension | 0.1.0 | Tracks language changes; bump minor on syntax changes |
| `reagent-spec.md` (core spec) | v0.0.1 | Bump when TraceEvent algebra / runtime contract changes |

## Intended use in CognOS

- **(a) Language for agent communication**: protocols define interaction patterns between angels/daemons.
- **(b) Knowledge base for planning**: protocols as reusable "procedural knowledge" for agents like comma (communication) and plana (planning).
