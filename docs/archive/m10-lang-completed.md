## M10-LANG: spawn redesign + triggers — COMPLETED

Completed as part of lang-spec v0.0.14. All 5 phases done.

### Phase 1: `async invokes` + deprecate old `spawns` — ✅ DONE

All 15 tasks completed. Summary of changes:

- **AST**: `InvokeStmt` gained `async?: boolean` flag; `SpawnStmt` retained for backward compat (deprecated).
- **Parser**: recognizes `<role> async invokes <Proto>(...)` syntax; `<role> spawns` still parses (deprecated).
- **IR**: new `async_invoke` state kind + `IRAsyncInvokeData` type. Both `async invokes` and `spawns` compile to `async_invoke` IR.
- **Tooling**: fingerprint, decompiler, diagram, TLA+ generator all handle `async_invoke`.
- **TS runtime**: `ProtocolInstance.handleAsyncInvoke()`, `ProtocolEngine` `async_invoke_required` event, `CustomAgentNode` dispatches `async_invoke`/`spawn` states.
- **Py runtime**: `protocol_instance._handle_async_invoke_state()`.
- **Trace events**: `AsyncInvokeStarted` (replaces `Spawned` for protocol-level spawn).
- **Examples**: 05, 19 updated to use `async invokes`.
- **Tests**: T31 (TS), T3 (Py) updated to check `AsyncInvokeStarted` trace. All passing.
- **VSCode grammar**: `async` added as keyword.
- **lang-spec**: §1.9, EBNF, changelog, IR section all updated.

### Phase 2: triggers — syntax, compiler, IR ✅ DONE

All 14 subtasks complete:

- **AST**: `TriggerDecl` node in `ast.ts` with `triggerKind`, `withType?`, `cronExpr?`, `topic?`, `inputExpr?`.
- **Parser**: `trigger on invoke|cron|event` syntax; `input:` auto-converts; `readStringLiteral` helper for cron/event args.
- **IR**: `TriggerIR` union type in `ir.ts`; `IRGraph.triggers[]` + `IRGraph.invocable` fields.
- **Emitter**: `emitIR()` compiles `TriggerDecl[]` → `TriggerIR[]`; validates "at least one trigger".
- **Cross-protocol validation**: `validateInvocability()` in CLI rejects `invokes` targets without `trigger on invoke`.
- **Fingerprint**: triggers included in structure hash via `canonicalizeTrigger()`.
- **Decompiler**: `decompileTrigger()` reconstructs `.rg` trigger syntax from `TriggerIR`.
- **Diagram**: `trigger` SeqElementKind; trigger annotations emitted before protocol body in sequence diagram.
- **VSCode**: `trigger`, `invoke`, `cron`, `event` keywords; `triggerDecl` TextMate scope.
- **Examples**: all 46 `input:` occurrences migrated to `trigger on invoke` across examples/ and packages/.
- **Docs**: lang-spec v0.0.12 — §1.1 triggers section, EBNF `TriggerDecl`, changelog, IR §4.3.
- **Tests**: 16 tests (parsing, IR emission, validation, fingerprint stability) in `test/trigger.test.ts`.

**v0.0.13 refinements**: `$trigger` removed — runtime auto-sets `$ctx.input` from raw trigger data. Trigger body is optional (post-processing transform). `with` replaces `as`. `with` forbidden on cron. `inputExpr` is optional in IR.

### Phase 3: triggers — runtime (TriggerMatcher, system agents) ✅ DONE

All 12 tasks completed. Runtime components implemented in both TS and Python:

- **TriggerMatcher**: loads `TriggerIR` from `ProtocolRegistry`, builds match table (invoke/event/cron). Two-step input: raw data → optional `inputExpr` transform with `$ctx` scope.
- **LocalEventBus**: in-process pub/sub with topic/wildcard subscriptions
- **CronAgent**: 5-field cron parser + tick scheduler, emits to bus
- **TriggerPolicy**: `enabled`, `maxConcurrent`, `cooldownMs`, `circuitBreaker`, `dedup` enforcement
- **`system.trigger.suppressed`** / **`TriggerMatched`** trace events
- **Initiator resolution**: finds initiator agent from IRGraph metadata + registry bindings
- **`reagent.emit()`** zone calls propagate through `AgentRunner` → `RC.emitEvent()` → `LocalEventBus`
- **Py mirror**: all components ported (trigger_matcher.py, local_event_bus.py, cron_agent.py, trigger_policy.py)
- **Tests**: 23 TS + 21 Py tests passing (bus, cron, policy, matcher invoke/event/cron, suppression)

### Phase 4a: resolve + spawn — language (no runtime deps) ✅ DONE

All 10 tasks completed. Language-only changes for resolve policies and new `spawns`:

- **Parser**: `static`/`dynamic`/`single`/`many`/`initiator` participant modifiers; `resolve role = pipeline` in trigger bodies; `agent Name runs Role { tags, capabilities, labels }` metadata body; new `spawns <RoleName>(config) as <participant> persistent -> $ctx.ref` syntax.
- **IR**: `ParticipantIR` with `binding`/`cardinality`/`initiator`; `resolveMap` in `TriggerIR`; `AgentRegistrationIR`; redesigned `spawn` IR state (`roleName`, `config`, `bindAs`, `persistent`, `resultTarget`).
- **Tooling**: fingerprint, decompiler, diagram handle new constructs. VSCode TextMate grammar updated with new keywords.
- **Validation**: mandatory resolve for cron/event triggers, cardinality checks, pipeline validation.
- **Tests**: parsing, IR emission, validation for all new constructs.
- **Docs**: lang-spec v0.0.14 updated.

### Phase 4b: cleanup + legacy removal (breaking) ✅ DONE

All 7 tasks completed:

- Removed deprecated `spawns <ProtocolName>` path (compile error).
- Removed `reagent.spawn("Proto", ...)` in zones.
- Removed old `SpawnRequest` sentinel and old trace event names.
- Removed `input:` and `initiator:` from parser entirely.
- IR format major version bump.
- All examples + tests updated (new participant syntax, resolve declarations).
- Final sweep: docs and compiled outputs updated.

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | `async invokes` + deprecate old `spawns` | ✅ Done |
| 2 | Trigger syntax + compiler + IR | ✅ Done |
| 3 | Trigger runtime (TriggerMatcher, CronAgent, policies) | ✅ Done |
| 4a | Resolve + spawn — language (AST, IR, parser, validation) | ✅ Done |
| 4b | Cleanup + legacy removal (breaking) | ✅ Done |
