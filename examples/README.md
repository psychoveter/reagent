## Reagent examples (CognOS-oriented corpus)

These examples are the **source of truth** for language design decisions.

Goals:
- Cover all communicative acts we need in CognOS: `alt`, `loop`, `par`, message await, timeouts, retries, subagent spawning, internal actions, and exception/abort paths.
- Serve as fixtures for:
  - future parser tests,
  - compiler-to-IR tests,
  - runtime legality/trace tests.

Conventions (v0.1):
- File extension: `.rg`
- Comments: `// ...` (line) and `/* ... */` (block)
- Top-level: only `import ...` and `protocol Name { ... }`
- **Reagent is a meta-language**: agent zones contain code in a **host language** (ts/js/py/kt).
- Language tag declared once per participant: `participants: comma [ts], sia [ts]`.
- Standalone agent zone syntax: `RoleName { ... host-language code ... }` (bare, no lang tag).
- **Hook zones**: `onSend { ... }` / `onReceive { ... }` inside message props open inline agent zones for the sender/receiver respectively.
- `$ctx` is the only bridge between choreography and host code (injected by runtime).
- `reagent.*` runtime library (zone-only stable surface): `reagent.return`, `reagent.emit`, `reagent.break`. Child protocols and role spawning are protocol-level constructs: `<role> invokes Proto(...)`, `<role> async invokes Proto(...)`, `<role> spawns Role(...)`.
- **No `if/else` at protocol level**: condition branching lives in agent zone code.
- Imports: `.rg` files for protocols, `.ts/.js/.py/.kt` files for code modules.

Current coverage:
- `00-protocol-wrapper.rg`: `protocol { participants [lang] / initiator / input }`
- `01-task-execution-basic.rg`: basic task execution
- `02-await-timeout-and-alt.rg`: await + timeout + alt (message-based branching)
- `03-loop-retry-backoff.rg`: loop + retry/backoff
- `04-parallel-subtasks.rg`: par + join
- `05-spawn-subagent.rg`: spawn subagent
- `06-exception-abort-compensate.rg`: try/catch + compensate
- `07-child-protocol-invoke.rg`: define child protocol + invoke (zone-only)
- `08-import-and-invoke.rg`: import protocols + invoke
- `09-invoke-multiparty-child-protocol.rg`: invoke multi-party child protocol + alt-based routing
- `10-external-event-start-and-emit.rg`: start by external input + `emit` (zone-only)
- `11-llmbroka-call-and-return.rg`: call `llmbroka` via `invoke` and `return` value

Library protocols:
- `lib/call-llm.rg`: canonical LLM request/response via `llmbroka`
- `lib/derive-dsi-bsi.rg`: derive DSI/BSI from task text
- `lib/validate-intent-with-sia.rg`: multi-party validation (comma ↔ sia)
