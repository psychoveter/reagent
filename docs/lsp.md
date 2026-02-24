# Reagent Language Server (LSP)

## Architecture

The Reagent LSP is a **separate Node.js process** using `vscode-languageserver` / `vscode-languageclient`. It reuses the bundled `@reagent/lang` parser for AST-level analysis. The extension starts the server on activation and communicates via stdio.

```
┌──────────────────────────────┐     ┌──────────────────────────────┐
│  VSCode Extension (client)   │     │  Reagent Language Server     │
│                              │     │  (Node.js process)           │
│  vscode-languageclient ──────│────►│  vscode-languageserver       │
│                              │ LSP │                              │
│  TextMate grammar ──────┐    │     │  @reagent/lang parser ──┐    │
│  (syntax coloring,      │    │     │  (AST + source locs)    │    │
│   independent of LSP)   │    │     │                         │    │
└──────────────────────────┘    │     │  Per-doc index ─────────┤    │
                                │     │  (protocols, roles,     │    │
                                │     │   agents, messages)     │    │
                                │     └─────────────────────────┘    │
                                └────────────────────────────────────┘
```

### What TextMate does vs. what LSP does

| Responsibility | Layer | Without it |
|---|---|---|
| Token coloring (keywords, strings, comments, operators) | TextMate grammar | White/monochrome text |
| Hover tooltips, go-to-definition, autocomplete, diagnostics | LSP | No IDE intelligence |
| Advanced semantic coloring (variable origin, scope) | LSP semantic tokens | Falls back to TextMate colors |

Both layers are required. TextMate gives instant visual feedback on every keystroke; LSP gives understanding and navigation. All mature language extensions (TypeScript, Python, Rust) use both.

### Files

| File | Purpose |
|---|---|
| `tools/reagent-vscode/server/src/server.ts` | LSP server — all providers |
| `tools/reagent-vscode/server/tsconfig.json` | Server TypeScript config |
| `tools/reagent-vscode/syntaxes/reagent.tmLanguage.json` | TextMate grammar (syntax coloring) |
| `tools/reagent-vscode/src/extension.ts` | Client side — starts `LanguageClient` |

---

## Current state (v0.0.9)

### Implemented features

| Feature | Description | Status |
|---|---|---|
| **Document symbols** | Outline view: protocols (Class), roles (Struct), agents (Object), messages (Event) with children (participants, plays, fields) | Done |
| **Go-to-definition** | Message name → `message Name {}`, protocol → `protocol Name {}`, role → `role Name {}`, agent → `agent Name`. Single-file only. | Done |
| **Hover** | Message schema with fields, protocol signature (participants, initiator, input), role definition (plays, extends), agent (runs), built-in `$ctx`/`$flow`/`$self`/`$agent` docs | Done |
| **Completion** | Context-aware: top-level keywords, participants after `-->`, messages after `:`, protocols after `invokes`/`spawns`/`plays`, roles after `runs`/`extends`/`as`, `$ctx`/`$flow`/`$self`/`$agent` | Done |
| **Parse diagnostics** | Real-time syntax errors from parser with source locations | Done |
| **Semantic diagnostics** | Undefined participant in message step, initiator not in participants, agent runs undefined role, role plays/extends undefined | Done |
| **TextMate grammar** | Keywords (`protocol`, `message`, `role`, `agent`, `scatter`, `loop`, `alt`, `par`, `invoke`, `spawn`, etc.), arrows, strings, comments, numbers, zone keywords (`$ctx`, `$flow`, `$self`, `$agent`, `await`, Python/JS keywords, operators, builtins). Single-line and multi-line `message` defs. | Done |

### Known issues

- **Parser loading** — the LSP dynamically imports the ESM parser from a CJS server process. Uses `pathToFileURL()` for cross-platform compatibility, but should be verified with a proper test harness (see L-00).
- **No dev/debug workflow** — no `launch.json` for attaching to the server, no integration tests, no health-check command. Tracked as L-00.
- **Single-file scope** — all features (go-to-def, completion, diagnostics) only work within the current document. Cross-file resolution blocked on L-01/L-02.

### Scope

- **Single-file** — the LSP indexes one document at a time. No cross-file resolution via `import`.
- **AST-level** — all features use the parser AST. No IR compilation needed.
- **No semantic tokens** — coloring is purely TextMate-based.

---

## Backlog

### P0 — Critical (blocks daily usage)

| ID | Feature | Description | Effort |
|---|---|---|---|
| L-00 | **LSP dev/debug setup** | The LSP currently has no proper development and debugging workflow. No way to attach a debugger to the server process, no integration tests, no automated way to verify parser loading or feature correctness. Need: (1) `launch.json` config for attaching to the LSP server with breakpoints, (2) a minimal test harness that sends LSP requests and asserts responses (document symbols, go-to-def, hover, completion, diagnostics) against known `.rg` fixtures, (3) structured logging with log levels instead of ad-hoc `connection.console` calls, (4) a health-check command (`Reagent: LSP Status`) that reports parser load state, indexed documents, and server uptime. Without this, every LSP change is a blind deploy-and-pray cycle. | 1d |
| L-01 | **Cross-file go-to-def** | Resolve `import "path"` to target `.rg` file. Go-to-def on imported names (protocols, messages, roles) jumps to the defining file. Requires a workspace index keyed by `reagent.json` glob patterns. | 2d |
| L-02 | **Workspace indexing** | On activation, discover all `.rg` files via `reagent.json` (or fallback glob). Build a global symbol table. Re-index on file create/delete/rename. Used by L-01, L-03, L-08. | 1.5d |
| L-03 | **Cross-file completion** | When typing a protocol/role/message name, suggest names from imported files (not just current document). | 0.5d |
| L-04 | **Semantic tokens** | Provide semantic token types for protocols, roles, agents, messages, participants, built-in variables. Enables theme-aware coloring beyond what TextMate regex can achieve (e.g., distinguish message *definition* from message *reference*). | 1d |

### P1 — Important (significantly improves DX)

| ID | Feature | Description | Effort |
|---|---|---|---|
| L-05 | **Find all references** | For a symbol (message, protocol, role, agent, participant) — find all usages across the workspace. | 1d |
| L-06 | **Rename symbol** | Rename a message, protocol, role, or agent across all files that reference it. Uses workspace index. | 1.5d |
| L-07 | **`where {}` completion** | Inside `alt ... where { }` blocks, suggest field names from the corresponding message type schema. | 0.5d |
| L-08 | **`$flow.field` hover** | Show which role last wrote `$flow.someField` (trace origin tracking across the protocol flow). Requires walking the IR or AST to find the assignment site. | 1d |
| L-09 | **Version/fingerprint hover** | Hover on a protocol name shows its version (from `reagent.lock`) and fingerprint hashes (if compiled IR is available). | 0.5d |
| L-10 | **Diagnostic: scatter type** | Warn if scatter collection variable is not an array/iterable. Warn on undeclared scatter iterator variable. | 0.5d |
| L-11 | **Diagnostic: message field usage** | Warn if `onSend` assigns a field not in the message schema, or if `onReceive` reads an undefined field. | 1d |
| L-12 | **`$agent.method()` completion** | In zones, complete methods from the native module specified in `agent.json`. Requires reading `agent.json` → resolving the Python/TS module → extracting exported function signatures. | 2d |
| L-13 | **Signature help** | Show parameter hints for `reagent.invoke()`, `reagent.spawn()`, `reagent.emit()`, `reagent.break()`, `reagent.return()` calls inside zones. | 0.5d |

### P2 — Nice to have (polish and advanced)

| ID | Feature | Description | Effort |
|---|---|---|---|
| L-14 | **Code actions: quick-fix** | "Add missing participant" when a message step references an undeclared name. "Generate `agent.json`" scaffold for an agent. "Add `import`" for unresolved protocol reference. | 1d |
| L-15 | **Code actions: refactor** | "Extract protocol" — select a section of protocol body, extract into a new `protocol` with `invokes`. | 1.5d |
| L-16 | **Folding ranges** | Semantic folding for `protocol`, `role`, `message`, `loop`, `alt`, `par`, `scatter`, `try/catch` blocks. Currently relies on brace-based folding from `language-configuration.json`. | 0.5d |
| L-17 | **Document formatting** | Auto-format `.rg` files: consistent indentation, alignment of arrows, spacing. | 2d |
| L-18 | **Inlay hints** | Show inferred types or participant names inline: e.g., `scatter ($flow.items as entity)` could show item count from last trace run. | 1d |
| L-19 | **Diagnostic: version mismatch** | Compare compile-time fingerprint with `reagent.lock`; warn if protocol needs recompilation. | 0.5d |
| L-20 | **Call hierarchy** | Incoming/outgoing calls for protocols: which protocols `invoke`/`spawn` this one, and which ones this one `invoke`s/`spawn`s. | 1d |
| L-21 | **Zone embedded language** | Delegate zone bodies to host-language LSPs (TypeScript Server, Pylance) via virtual documents for full host-language intelligence inside zones. | 3d |

---

## Prioritized roadmap

### Sprint 0: Dev infrastructure (L-00)

**Goal**: stop flying blind. Be able to debug, test, and verify the LSP properly.

- Debug launch config, test harness, structured logging, health-check command (`L-00`)
- **Effort**: ~1 day

### Sprint 1: Cross-file foundation (L-02 → L-01 → L-03)

**Goal**: the LSP understands the whole project, not just the current file.

- Build workspace index from `reagent.json` (`L-02`)
- Cross-file go-to-definition (`L-01`)
- Cross-file completion (`L-03`)
- **Effort**: ~4 days

### Sprint 2: Semantic tokens + references (L-04 → L-05)

**Goal**: richer coloring and "find usages".

- Semantic token provider (`L-04`)
- Find all references (`L-05`)
- **Effort**: ~2 days

### Sprint 3: Rename + message intelligence (L-06 → L-07 → L-11)

**Goal**: safe refactoring and message schema awareness.

- Rename symbol (`L-06`)
- `where {}` completion (`L-07`)
- Message field diagnostics (`L-11`)
- **Effort**: ~3 days

### Sprint 4: Flow + agent intelligence (L-08 → L-09 → L-12 → L-13)

**Goal**: deep Reagent-specific intelligence.

- `$flow.field` hover with origin tracking (`L-08`)
- Version/fingerprint hover (`L-09`)
- `$agent.method()` completion (`L-12`)
- Signature help for `reagent.*` (`L-13`)
- **Effort**: ~4 days

### Sprint 5: Quick-fixes + polish (L-10 → L-14 → L-16 → L-19 → L-20)

**Goal**: actionable diagnostics and code actions.

- Scatter diagnostics (`L-10`)
- Quick-fix code actions (`L-14`)
- Semantic folding (`L-16`)
- Version mismatch diagnostic (`L-19`)
- Call hierarchy (`L-20`)
- **Effort**: ~3.5 days

### Future (unscheduled)

- Extract protocol refactoring (`L-15`)
- Document formatting (`L-17`)
- Inlay hints (`L-18`)
- Zone embedded language delegation (`L-21`)

---

## Design notes

### Parser reuse

The LSP dynamically loads the bundled `@reagent/lang` parser (ESM) via `import()`. The parser returns a full AST with source locations (`{ line, col }`) and parse errors. The LSP re-parses on every document change (full sync, not incremental). For typical `.rg` files (< 500 lines), this is < 5ms.

### Per-document index (`DocIndex`)

On each re-parse, the server builds a `DocIndex`:

```typescript
interface DocIndex {
  protocols: ProtocolDef[];
  roles: RoleDef[];
  agents: AgentDef[];
  messages: MessageDef[];
  allMessageNames: Set<string>;
  allParticipantNames: Set<string>;
  allProtocolNames: Set<string>;
  allRoleNames: Set<string>;
  allAgentNames: Set<string>;
}
```

This is used for all single-file features (symbols, hover, completion, diagnostics, go-to-def).

### Workspace index (planned, L-02)

A `WorkspaceIndex` will aggregate `DocIndex` entries from all `.rg` files discovered via `reagent.json` glob patterns. It will provide:

- Global symbol table (protocol → file URI)
- Import resolution (`import "path"` → resolved file)
- Reverse references (which files reference a given symbol)
- File watcher for create/delete/rename

### Semantic tokens (planned, L-04)

Proposed token types:

| Token type | Used for |
|---|---|
| `class` | Protocol names |
| `struct` | Role names |
| `type` | Message names |
| `variable` | Agent names, participant names |
| `parameter` | `$ctx`, `$flow`, `$self`, `$agent` |
| `function` | `reagent.invoke`, `reagent.spawn`, etc. |
| `keyword` | `protocol`, `role`, `agent`, `message`, `scatter`, etc. |

Token modifiers: `definition`, `declaration`, `readonly`.
