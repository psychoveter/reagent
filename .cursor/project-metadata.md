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

### Language: v0.0.4

The Reagent DSL is defined in `lang-spec.md` (version header: v0.0.4).

Key design commitments solidified:
- **Meta-language**: Reagent describes choreography; actual computation lives in **agent zones** written in a host language (`ts`/`js`/`py`/`kt`).
- **Protocol-as-function**: `protocol Name { participants: ..., initiator: ..., input: ... }`.
- **Language tag on participants**: `comma [ts], sia [py]` — agent zones are bare `Name { ... }`.
- **Hook zones**: `onSend { ... }` / `onReceive { ... }` inside message props.
- **`reagent.*` runtime library**: `reagent.invoke`, `reagent.spawn`, `reagent.return`, `reagent.emit` — available in all agent zones, NOT protocol-level constructs.
- **`$ctx`** — single runtime-injected binding (protocol instance context).
- **Protocol-level control flow**: `alt`, `loop`, `par`, `wait`, `timeout`, `try/catch`.
- **No `if/else`, `break`, `throw`, `spawn` at protocol level** — these are host-language constructs inside zones.
- **Imports**: `.rg` = protocol imports, `.ts/.js/.py/.kt` = code module imports.

### Examples corpus

`projects/reagent/examples/` — 13 `.rg` fixtures covering:
- `00` protocol wrapper
- `01` basic task execution
- `02` await/timeout/alt
- `03` loop/retry/backoff
- `04` parallel subtasks
- `05` spawn subagent
- `06` exception/abort/compensate
- `07` child protocol invoke
- `08` import and invoke
- `09` multiparty child protocol
- `10` external event start + emit
- `11` LLM broker call and return
- `task-execution` — legacy example

### Tooling

| Module | Version | Path | Description |
|---|---|---|---|
| `reagent-vscode` | 0.1.0 | `tools/reagent-vscode/` | VSCode/Cursor extension: TextMate grammar + embedded language support for `.rg` files |
| `reagentParser.ts` | — | `tools/reagent-vscode/src/reagentParser.ts` | Lightweight zone-extraction parser used by the extension (NOT the full AST parser) |
| `reagent.tmLanguage.json` | — | `tools/reagent-vscode/syntaxes/` | TextMate grammar for syntax highlighting |

### Specs / docs

| Document | Path | Content |
|---|---|---|
| `lang-spec.md` | `projects/reagent/lang-spec.md` | Language spec v0.0.4: informal syntax + EBNF + reserved constructs |
| `reagent-spec.md` | `projects/reagent/docs_v0.0.1/reagent-spec.md` | Core spec v0.0.1: layers, TraceEvent algebra, legality, runtime |
| `reagent-losos-project-plan.md` | `.cursor/reagent-losos-project-plan.md` | Milestones plan (M0–M9) |

## Architecture layers

1. **Protocol level** — `.rg` files with DSL choreography + embedded host-language code.
2. **Role level** — per-role message boundary interfaces (planned, not yet generated).
3. **Agent level** — per-role state machines (IR). The key compilation target.
4. **Execution level** — runtime engines that execute agent IR. Losos (Kotlin/etcd) is the primary target engine.

## Next phase: AST + Parser + Translation (→ M2)

The immediate next milestone is building a proper **TypeScript AST** and **parser** for the full Reagent language, and designing the **translation** from Reagent constructs to Losos agent-level primitives.

Key deliverables:
1. **TypeScript AST types** — typed node hierarchy covering all language constructs (`Program`, `ImportStmt`, `ProtocolDef`, `MessageStmt`, `AgentZone`, `AltStmt`, `LoopStmt`, `ParStmt`, `WaitStmt`, `TryStmt`, etc.) with source locations.
2. **Parser** — recursive-descent parser in TypeScript producing the AST. Replaces the current regex-based zone extractor with a full parse.
3. **IR design** — define the agent-level intermediate representation (`states/nodes → edges/transitions`) that captures per-role execution semantics.
4. **Translation mapping** — how each Reagent construct maps to IR nodes and ultimately to Losos primitives (guards, actions, events).

See `reagent-losos-project-plan.md` for detailed milestone breakdown.

## Intended use in CognOS

- **(a) Language for agent communication**: protocols define interaction patterns between angels/daemons.
- **(b) Knowledge base for planning**: protocols as reusable "procedural knowledge" for agents like comma (communication) and plana (planning).

## Version sync policy

All Reagent modules share the language version as their baseline reference:

| Component | Current version | Sync rule |
|---|---|---|
| Language (lang-spec.md) | **v0.0.4** | Source of truth for language surface |
| `reagent-vscode` extension | 0.1.0 | Tracks language changes; bump minor on syntax changes |
| `reagent-spec.md` (core spec) | v0.0.1 | Bump when TraceEvent algebra / runtime contract changes |
| AST / Parser (planned) | — | Will track language version directly |
| IR / Compiler (planned) | — | Will have own version once M2 is reached |
