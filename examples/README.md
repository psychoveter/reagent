## Reagent examples (CognOS-oriented corpus)

These examples are the **source of truth** for language design decisions.

Goals:
- Cover all communicative acts we need in CognOS: `alt`, `loop`, `par`, message await, timeouts, retries, subagent spawning, internal actions, and exception/abort paths.
- Serve as fixtures for:
  - future parser tests,
  - compiler-to-IR tests,
  - runtime legality/trace tests.

Conventions (draft):
- File extension: `.rg`
- Comments: `// ...` (line) and `/* ... */` (block)
- Top-level: only `import ...` and `protocol Name { ... }`
- Each example states:
  - intent,
  - roles,
  - success trace shape,
  - failure/timeout trace shape (when applicable).

Current coverage (as of today):
- `00-protocol-wrapper.rg`: `protocol { participants/initiator/input }`
- `01-task-execution-basic.rg`: basic task execution
- `02-await-timeout-and-alt.rg`: await + timeout + alt (provisional syntax)
- `03-loop-retry-backoff.rg`: loop + retry/backoff (provisional syntax)
- `04-parallel-subtasks.rg`: par + join (provisional syntax)
- `05-spawn-subagent.rg`: spawn subagent (provisional syntax)
- `06-exception-abort-compensate.rg`: try/catch + compensate (provisional syntax)
- `07-child-protocol-invoke.rg`: define child protocol + invoke (provisional syntax)
- `08-import-and-invoke.rg`: import protocols + invoke (provisional syntax)
- `09-invoke-multiparty-child-protocol.rg`: invoke multi-party child protocol (provisional syntax)
- `10-external-event-start-and-emit.rg`: start by external input (unknown sender) + `emit` outward events
- `11-llmbroka-call-and-return.rg`: call `llmbroka` via `invoke` and get a returned value

