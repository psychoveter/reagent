# Reagent Language Docs ↔ Implementation Gap Analysis

Status: Analysis (read-only audit) | Date: 2026-05-05

This document audits the alignment between the canonical language documentation
under `docs/current/` (anchored by `00-registry.md`, with `02-lang-spec.md`
as the language reference) and the actual implementation in
`lang/src/`, `runtime/ts/src/`, `examples/`, and `tools/`.

The goal is to surface **gaps** where the docs and the code disagree, so that
future doc-cleanup or implementation passes have a single shared list.

Conventions:

- **Doc-only**: documented as current behavior, but not implemented (or
  implemented as a stub).
- **Impl-only**: implemented and used, but not documented in `current/` (or
  documented only in `future/` / `archive/`).
- **Drift**: doc and code disagree on details (signature, layout, naming).
- **Soft**: minor inconsistency that does not affect correctness, but blocks
  external readers (LLM agents, contributors) from forming an accurate model
  from `current/` alone.

---

## 1. Top-level summary

| # | Area | Severity | Class |
|---|---|---|---|
| G1 | `supervision:` directive (protocol-level) | High | Impl-only |
| G2 | `trigger on … as MsgType` accepted alongside `with` | Medium | Impl-only |
| G3 | `runtime/ts/src` layout in `00-registry.md` is stale | Medium | Drift |
| G4 | `reagent.invoke` / `reagent.spawn` zone stubs still live | Medium | Drift |
| G5 | `reagent.stop()` zone sentinel exists, undocumented | Medium | Impl-only |
| G6 | `reagent.return()` is not actually a wire message | Medium | Drift |
| G7 | `reagent.resolve()` / `reagent.registry` placeholders | Low | Doc-aware drift |
| G8 | `leastLoaded` resolver is a first-candidate stub | Low | Already noted, repeat for clarity |
| G9 | Code-module imports (`import "./foo.ts" as foo`) lack examples & runtime wiring evidence | Medium | Doc-only-ish |
| G10 | Reserved arrow kinds (`->`, `->>`, `-->>`) have no semantics anywhere | Low | Soft |
| G11 | `break` at protocol level is silently consumed by the parser | Medium | Drift |
| G12 | `MessageEnvelope` has an extra `protocolVersion` field | Low | Drift |
| G13 | Spawn “DEPRECATED” parser comment contradicts shipped `IRSpawnData` | Low | Soft |
| G14 | `agent.json` `module` loader returns the module export but spec is loose on factory contract | Low | Soft |
| G15 | `currentLangMap` is process-global state in the parser | Low | Implementation hygiene |
| G16 | `messages.json` and `reagent.lock` schemas are doc-described but not normatively typed | Low | Soft |

The remainder of this document expands each item.

---

## 2. Detailed gaps

### G1. `supervision:` is a documented protocol-level directive in code, but absent from `02-lang-spec.md`

**Implementation**

- AST: `ProtocolDef.supervisionStrategy?: SupervisionStrategy` and the
  `SupervisionStrategy = "scoped" | "one-for-one" | "all-for-one" | "detached"`
  union live in `lang/src/ast.ts`.
- Parser: `pProtocolDef` in `lang/src/parser.ts` recognizes a top-level
  `supervision: <strategy>` directive inside the protocol header and dispatches
  to `readSupervisionStrategy`.
- IR: `IRGraph.supervisionStrategy` is emitted by `emitIR` with a default of
  `"scoped"` (`lang/src/ir-emitter.ts`).
- Runtime: the controller (`runtime/ts/src/controller/reagent-controller.ts`)
  branches on `adoptingRecord.supervisionStrategy === "one-for-one" |
  "all-for-one"` for orphan adoption and cancellation. The `AgentShellImpl`
  threads the strategy through to `ProtocolRunRecord` lifecycle.
- Backlog `R5` is marked **Complete** in `docs/future/backlog.md`.

**Documentation**

- `docs/current/02-lang-spec.md` has **no mention** of `supervision`,
  `SupervisionStrategy`, or any of the four strategy keywords.
- `docs/future/distributed-try-catch.md` discusses supervision strategy as part
  of the (also marked-complete) distributed try/catch RFC.

**Impact**

- A reader of `current/` cannot construct a valid `.rg` file that opts into
  anything other than the default strategy, even though the runtime branches
  on the explicit strategies.
- Conformance/diagnostics tooling has no normative reference.

**Recommended fix**

- Add a `1.x Supervision strategy` subsection under §1 of `02-lang-spec.md`
  describing the four strategies and the default, and extend the EBNF with the
  `supervision: <strategy>` directive.
- Add the `SupervisionStrategy` field to the IR description in §4.3.

---

### G2. Trigger types accept both `with` and `as` keywords

**Implementation**

In `lang/src/parser.ts`, `pTriggerDecl`:

```ts
} else if (consumeKeyword(c, "with") || consumeKeyword(c, "as")) {
  ...
}
```

Both `trigger on invoke with InputMsg` and `trigger on invoke as InputMsg`
parse and produce identical AST/IR.

**Documentation**

`02-lang-spec.md` only documents `with` and the EBNF only lists `with`.

**Impact**

- Examples in the wild may use either form, confusing readers.
- Tooling (LSP, formatters, examples) may emit the deprecated form.

**Recommended fix**

- Decide which is canonical (`with` per the spec).
- Either deprecate `as` with a parser warning or remove the alternative.
- Update the EBNF to match.

---

### G3. `00-registry.md` describes a `runtime/ts/src` layout that no longer matches reality

**Documentation**

`docs/current/00-registry.md` claims:

- Top-level under `runtime/ts/src`: `contracts/`, `core/`, `controller/`,
  `nodes/`, `gate/`, `mcp/`, `cluster/`, `triggers/`, `network/`, `admin/`,
  `observability/`, `support/`.
- Root entry-point files: `index.ts`, `main.ts`, `mcp-gate.ts`.

**Implementation**

Actual directory listing of `runtime/ts/src`:

```
admin/  cluster/  contracts/  controller/  core/  network/  nodes/
observability/  support/  triggers/  index.ts  main.ts  rgctl.ts
```

- `gate/` and `mcp/` do **not** exist at the top level. They live as
  `nodes/gate/` and `nodes/mcp/`.
- `mcp-gate.ts` does not exist; the third root file is `rgctl.ts`.
- This matches `03-runtime-core.md §2`, which (correctly) describes `nodes/`
  as “managed, custom, Python, and gate-backed agents”.

**Impact**

- `00-registry.md` is the navigation entry point; new contributors and LLM
  agents will look for non-existent top-level folders.
- It also disagrees with its sibling `03-runtime-core.md`.

**Recommended fix**

- Update `00-registry.md` so its “TypeScript runtime” bullet list matches the
  filesystem and `03-runtime-core.md`.
- Document `rgctl.ts` (CLI binary) explicitly, and either remove the
  `mcp-gate.ts` mention or describe its replacement.

---

### G4. `reagent.invoke` and `reagent.spawn` zone stubs contradict the spec

**Documentation**

`02-lang-spec.md §1.4` says the **stable** in-zone `reagent.*` surface is:

- `reagent.return(...)`
- `reagent.emit(...)`
- `reagent.break()`

§1.11 explicitly says `invokes`, `async invokes`, and `spawns` are
**protocol-level constructs**, not zone-level `reagent.*` calls.

**Implementation**

`runtime/ts/src/core/zone-executor.ts` exposes:

```ts
export type ReagentStub = {
  emit, invoke, spawn, return, break, resolve, registry, stop
};
```

with `InvokeRequest` / `SpawnRequest` sentinels. They are wired in:

- `nodes/managed/managed-behavior.ts` imports `InvokeRequest`, `ReturnValue`,
  `BreakRequest`.
- `core/role-run.ts` does **not** translate `reagent.invoke` into a child
  `RoleRun`; it is effectively dead code today, but reachable from any zone.

**Impact**

- A user can write `reagent.invoke("Foo", {...})` in a zone and the runtime
  will throw `InvokeRequest`. Whether that is caught and turned into a child
  protocol depends on which behavior is in front; the spec promises this
  surface is unsupported.
- `examples/README.md` line 21 still says “`reagent.*` runtime library:
  `reagent.invoke`, `reagent.spawn`, `reagent.return`, `reagent.emit` —
  zone-only,” directly contradicting the spec.

**Recommended fix**

- Either remove `invoke`, `spawn`, `resolve`, `registry`, and `stop` from
  `createReagentStub` and the `ReagentStub` type, or document them as
  experimental in `02-lang-spec.md` with explicit "not stable" wording.
- Bring `examples/README.md` into line with the chosen surface.

---

### G5. `reagent.stop()` exists in the runtime but is never documented

**Implementation**

`zone-executor.ts` defines `StopRequest` and `stop()` on `ReagentStub`.

**Documentation**

There is no mention of `reagent.stop` in `current/` or `future/`.

**Impact**

- Either it is intentional and should be documented (and constraints stated:
  who can call it, what it cancels), or it should be removed.

**Recommended fix**

- Decide intent. If kept, document under §1.4. If experimental, document
  under `future/`.

---

### G6. `reagent.return()` is described as a wire message, but the runtime does not emit one

**Documentation**

`02-lang-spec.md §1.4`:

> Sends a return message from the current protocol instance back to the
> invoker … This means `reagent.return()` is not just a control-flow
> construct — it generates a message in the protocol trace (e.g. `ReturnValue`
> from child initiator to parent invoker).

**Implementation**

- The zone throws a `ReturnValue` sentinel (`zone-executor.ts`).
- `core/role-run.ts` and `core/agent-shell-impl.ts` capture the value via
  `engine.setReturnValue(value)` and surface it through
  `run.getReturnValue()`.
- A grep for `messageName.*ReturnValue` or any wire message representation
  finds **nothing**. There is no `MessageEnvelope` with `messageName:
  "ReturnValue"` synthesized at return time.
- The trace event surface is `ProtocolStarted`, `ProtocolCompleted`,
  `ProtocolFailed`, `MessageSent`, `MessageReceived`, `ActionStarted`/
  `Finished`, etc. (`runtime/ts/src/contracts/types.ts`). Return is reflected
  in `ProtocolCompleted` payload, not a separate message event.

**Impact**

- The spec creates a wrong mental model: external observers (debug UIs, MCP
  consumers, LLM agents reading the docs) will look for a `ReturnValue` wire
  message in traces and not find it.

**Recommended fix**

- Either implement a synthesized return envelope (semantically clean for
  cross-runtime traces), or rewrite §1.4 to describe `reagent.return` as a
  control-flow value capture surfaced through `ProtocolCompleted`.

---

### G7. `reagent.resolve()` / `reagent.registry` are still in the stub but the spec calls them deferred

**Documentation**

`02-lang-spec.md §1.4`:

> Do not treat `reagent.resolve()` or `reagent.registry` as part of the
> stable current surface yet. They remain deferred runtime work rather than
> shipped language-facing behavior.

**Implementation**

`zone-executor.ts` `ReagentStub`:

```ts
resolve: (_role, _pipeline) => { throw new ResolveRequest(_role, _pipeline); },
registry: { findByRole: () => [], get: () => undefined, all: () => [] },
```

- `resolve` throws a sentinel that no current `RoleRun` path handles.
- `registry` is a no-op shell (not backed by `state-store-agent-registry`).

**Impact**

- A user-written zone calling `reagent.resolve(...)` will surface as an
  unhandled `ResolveRequest` thrown from the zone.
- `reagent.registry.findByRole(...)` silently returns an empty array, which
  is worse than throwing — failures are hidden.

**Recommended fix**

- Either remove these from the stub (and the `ReagentStub` type) until they
  ship, or implement them and update the spec.
- If kept as placeholders, make them throw an explicit "not implemented" error
  instead of returning empty arrays.

---

### G8. `leastLoaded` resolver step is a stub (already noted, but listed for completeness)

**Documentation**

`02-lang-spec.md §1.1`:

> `leastLoaded` is parsed and emitted in IR, but its current evaluator
> behavior is still a stub equivalent to first-candidate selection.

**Implementation**

`runtime/ts/src/triggers/resolve-policy-evaluator.ts`:

```ts
case "leastLoaded":
  return candidates.length > 0 ? [candidates[0]] : [];
```

**Status**

Doc and code agree on the limitation; this is **not a gap**, only a backlog
item for `resolve-policy-wave-2.md`. Keeping it here so any future "gap
audit" knows it has been considered and intentionally left.

---

### G9. Code-module imports (`import "./foo.ts" as foo`) are documented but not exercised

**Documentation**

`02-lang-spec.md §1.8`:

> Code module imports (.ts, .js, .py, .kt) … `import "./lib/helpers.ts"
> as helpers` … Code imports are resolved by the engine at zone execution
> time.

`§1.8` further claims TS zones run inside `new Function(...)`, which does
**not** support import statements, so users should rely on either `$agent`
methods or this `import "./foo.ts" as foo` syntax.

**Implementation**

- Parser: `pImportStmt` happily accepts `import "./foo.ts" as foo` — the
  string content is opaque to it.
- IR / runtime: a workspace search for `\.ts.*as.* import` style usage finds
  **zero** examples. No runtime path resolves a code import alias and injects
  it into the `extras` argument of `executeZone` / `executeZoneAsync`.
- `executeZone` accepts an `extras` map but the only extra ever populated is
  `$agent` (`agent-shell-impl.ts`, `nodes/managed/managed-behavior.ts`).

**Impact**

- The documented escape hatch for TS/JS zones (alongside `$agent`) is not
  actually wired. Users will fall back to `$agent` exclusively, contrary to
  what §1.8 implies.

**Recommended fix**

- Either implement code-module import resolution and inject the alias into the
  zone scope (it is a small change in `executeZone` plumbing plus a manifest
  layer), or downgrade §1.8 to clearly state that today only `$agent` and
  Python `import` are supported.

---

### G10. Reserved arrow kinds have no defined semantics

**Documentation**

`02-lang-spec.md §1.2`:

> `-->` — default message (async delivery). This is the only arrow used in v0
> examples.
> `->`, `->>`, `-->>` — reserved for future semantics … Not yet defined.

**Implementation**

- AST: `ArrowKind = "-->" | "->" | "->>" | "-->>"`.
- Parser accepts all four (`readArrow`).
- IR: `IRSendData.arrow` and `IRReceiveData.arrow` carry the kind.
- Runtime: `protocol-engine.ts` and friends never branch on `arrow`. Every
  arrow is treated as the default.

**Impact**

- Soft. A user can write `A ->> B: M` and get the default semantics. They
  may then build incorrect mental models.

**Recommended fix**

- Either reject non-`-->` arrows at parse/IR time with an explicit
  "reserved" error, or delete the reservation from the language until at
  least one alternative kind ships.

---

### G11. `break` at protocol level is silently consumed by the parser

**Implementation**

`lang/src/parser.ts` (`pProtocolItem`), comment + behavior:

```ts
if (id.name === "break") {
  // Treat as a pseudo-statement. We don't have a BreakStmt node,
  // so we model it as an agent zone with empty body on the current role.
  // For now, return null and let it be silently consumed.
  return null;
}
```

**Documentation**

`02-lang-spec.md §1.4`:

> `reagent.break()` … Exits the innermost enclosing `loop`. … Must be called
> from within an agent zone inside a `loop` body. Calling outside a loop is a
> runtime error.

**Impact**

- The parser silently swallows protocol-level `break` tokens, producing no
  AST node and no diagnostic. A user's typo (e.g. omitting `reagent.`) is
  not flagged.
- The behavior also disagrees with `02-lang-spec.md §1.9`, which lists `break`
  among "not at protocol level" zone-only constructs.

**Recommended fix**

- Emit a parse error for protocol-level `break` (E_PROTOCOL_BREAK) so users
  see a clear message: "use `reagent.break()` inside an agent zone".

---

### G12. `MessageEnvelope` has an undocumented `protocolVersion` field

**Documentation**

`02-lang-spec.md §1.14` lists envelope fields as:

```
instanceId, protocolName, from, to, messageName, payload, ts, idempotencyKey
```

**Implementation**

`runtime/ts/src/contracts/types.ts`:

```ts
export type MessageEnvelope = {
  instanceId: string;
  protocolName: string;
  protocolVersion?: string;   // <-- undocumented in 02-lang-spec.md
  from: { agent: string; role: string };
  to: { agent: string; role: string };
  messageName: string;
  payload: Record<string, unknown>;
  ts: number;
  idempotencyKey: string;
};
```

**Impact**

- Wire-format documentation does not match the on-the-wire shape. Code
  generation from the spec will produce a too-narrow envelope type.

**Recommended fix**

- Add `protocolVersion?: string` to the §1.14 envelope description and
  explain its semantics (presumably set by the reconciler when a versioned
  protocol is in effect).

---

### G13. Parser comment claims `spawns` is "DEPRECATED" but IR/runtime still support it as first-class

**Implementation**

`lang/src/parser.ts`:

```ts
// `<role> spawns <Proto>(...)` — DEPRECATED: compiles as async invoke
if (startsWithKeyword(c, "spawns")) {
  return pSpawnStmtFromIdent(c, id.name, id.loc.start);
}
```

But:

- `IRSpawnData` (`lang/src/ir.ts`) is a distinct kind separate from
  `IRAsyncInvokeData`, with its own `roleName`, `config`, `bindAs`,
  `persistent`, `resultTarget`.
- `02-lang-spec.md §1.9` explicitly documents `<role> spawns <RoleName>(config) as participant persistent -> $ctx.ref`
  with full semantics.

**Impact**

- Soft. The stale parser comment may mislead future contributors into
  removing what is in fact a shipped, tested feature.

**Recommended fix**

- Remove or rewrite the comment to reflect that `spawns` is the current
  language-level role-instantiation construct.

---

### G14. `agent.json` `module` loader has implicit factory contract

**Implementation**

`runtime/ts/src/support/agent-manifest.ts`:

```ts
const exported = mod.default ?? mod;
if (typeof exported === "function") {
  return exported(manifest.config ?? {});
}
return exported;
```

That is: if `default` (or the bare module) is a function, it is treated as a
factory and invoked with `config`; otherwise the export is used as-is.

**Documentation**

`02-lang-spec.md §1.3.1` shows a Python class example
(`AliceModule(self, config)`), implying construction with config, but does
not document the JS/TS case where the export may be a factory or a static
object. There is no statement about whether the factory is sync vs async.

**Impact**

- Soft. Users writing TS modules may not know whether to export an instance,
  a class, or a factory.

**Recommended fix**

- In §1.3.1, add a note describing the resolution rule: if the default export
  is callable, it is invoked with `config` and the return value becomes
  `$agent`; otherwise the export itself is used.

---

### G15. `currentLangMap` is module-global state in the parser

**Implementation**

`lang/src/parser.ts`:

```ts
let currentLangMap: Map<string, LangTag> = new Map();
```

It is set inside `pProtocolDef` and consumed when emitting an `AgentZone` in
`pProtocolItem` to attach the participant lang. The state is **not** scoped
per parse call.

**Impact**

- Concurrent / nested parse calls (e.g. LSP reusing the parser) can race and
  attach the wrong lang to zones. This is a latent bug, not currently
  observed because all current callers parse one file at a time.

**Recommended fix**

- Move `currentLangMap` into a parser-context object passed through the
  recursive descent, instead of module-global state.

---

### G16. `messages.json` and `reagent.lock` have no normative schema in `current/`

**Documentation**

`02-lang-spec.md §4.7` lists build outputs:

> `<Proto>.<role>.ir.json`, `<RoleName>.role.json`, `<Agent>.agent.json`,
> `messages.json`, `deployment.json`, `source-map.json`, `reagent.lock`.

But schemas for `messages.json`, `deployment.json`, `source-map.json`, and
`reagent.lock` are not given as IR types in §4.

**Impact**

- Soft. Tooling (LSP, decompiler, visualizers) has to read code to reproduce
  these formats.

**Recommended fix**

- Add a §4.x subsection enumerating the schemas of these auxiliary build
  artifacts (or link to the relevant TS types).

---

## 3. Cross-doc gaps (not language proper)

These are documentation-vs-documentation issues uncovered while auditing,
listed separately so they can be resolved by a docs-only pass.

| # | Doc(s) | Issue |
|---|---|---|
| D1 | `00-registry.md` vs `03-runtime-core.md` | Disagree on top-level `runtime/ts/src` layout (see G3). |
| D2 | `02-lang-spec.md` vs `examples/README.md` | `examples/README.md` line 21 still lists `reagent.invoke` / `reagent.spawn` as part of the stable surface. Spec says they are not. |
| D3 | `02-lang-spec.md §1.9` vs parser | Spec says "Not at protocol level: break". Parser silently consumes protocol-level `break`. (See G11.) |
| D4 | `02-lang-spec.md §1.4` vs runtime | Spec says `reagent.return` produces a wire message. Runtime captures it as engine state. (See G6.) |
| D5 | `00-registry.md` vs reality | `mcp-gate.ts` listed at root; actually `rgctl.ts`. (See G3.) |

---

## 4. Suggested ordering of fixes

**Round 1 — high-leverage doc fixes (no code changes)**

1. G3 / D1 / D5: Rewrite the "TypeScript runtime" subsection of
   `00-registry.md` to match the actual filesystem.
2. G1: Add `supervision:` directive to `02-lang-spec.md` §1 and §4.3 EBNF.
3. G6 / D4: Rewrite `02-lang-spec.md §1.4` to match what the runtime actually
   does for `reagent.return`.
4. G12: Add `protocolVersion?: string` to §1.14 envelope schema.
5. D2: Rewrite the `examples/README.md` runtime-library bullet.

**Round 2 — small implementation cleanups**

6. G11: Make protocol-level `break` a parse error.
7. G13: Rewrite stale "DEPRECATED" parser comment for `spawns`.
8. G15: Plumb `currentLangMap` through parser context instead of module
   state.
9. G2: Decide between `with` / `as` and emit a deprecation warning for the
   non-canonical form.

**Round 3 — design decisions, then ship+doc**

10. G4 / G5 / G7: Decide whether `reagent.invoke`, `reagent.spawn`,
    `reagent.stop`, `reagent.resolve`, `reagent.registry` are part of the
    surface. Either remove from the stub or document them.
11. G9: Decide whether code-module imports are part of v0. Either implement
    the alias plumbing in `executeZone` or downgrade §1.8 to current reality.
12. G10: Either reserve non-`-->` arrows with a parse error or remove the
    reservation from the language.
13. G16: Add normative schemas for the auxiliary build artifacts.

---

## 5. What is already aligned (sanity check)

For symmetry and to avoid future re-audits, the following language features
were checked and **do** match between `02-lang-spec.md` and the
implementation:

- Participant declaration syntax, modifiers (`static|dynamic`,
  `single|many`, `initiator`), and compiler constraints (initiator must be
  `static single`; `many` participants only via `scatter`).
- Wildcard `[*]` participants forbid agent zones (enforced in
  `ir-emitter.ts` lines 171–178).
- Resolve pipelines: `all`, `single`, `from`, `filter`, `roundRobin`,
  `random`, `sample`, `first`, `fallback`, `custom`, plus shorthands
  (`hasTag`, `hasCapability`, `hasLabel`, `isAlive`).
- `dynamic` participants reject `resolve` declarations.
- `static` participants require `resolve` in every trigger, including
  `invoke`.
- Trigger kinds (`invoke`, `cron`, `event`); `with` mandatory for
  invoke/event, forbidden for cron; optional `$ctx.input = <expr>`
  post-processing.
- Agent zones as raw host-language text with brace balancing.
- `$ctx`, `$self`, `reagent`, `$agent` injection (the four bindings).
- Async-zone heuristic: `await` in body sets `async`/`preSendAsync`/
  `postReceiveAsync` and selects the `AsyncFunction` executor.
- `alt`, `loop`, `par`, `wait`, `try/catch`, `scatter` IR state kinds
  and their fail-fast semantics inside `try`.
- `<role> invokes`, `<role> async invokes`, `<role> spawns` AST/IR shapes
  (modulo G13).
- Role definitions: `plays`, `init`, lifecycle handlers, single-inheritance
  `extends` flattening (`emitRoleIR`).
- Agent definitions: thin deployment binding, optional `tags`,
  `capabilities`, `labels`; lang-tag compatibility checks against role.
- Message definitions and the documented "type system minimal" surface
  (`string`, `number`, `boolean`, `any`, `[]`, inline objects, `?`).
- `where { … }` pattern matching in `alt` message guards (`v0.0.8+`).

---

## 6. Out of scope

This document deliberately does **not** audit:

- `03-runtime-core.md` (runtime), `04-cluster-and-control-plane.md`,
  `05-versioning-and-reconcile.md`, `06-tooling-overview.md`, `07-lsp.md`,
  `08-test-spec.md`, `09-e2e-usecases.md` against their respective
  implementations beyond the layout cross-check that affects `00-registry.md`.
- The Python runtime (`runtime/py/`), per the explicit "not reorganized"
  caveat in `00-registry.md`.
- Examples beyond the imports / `reagent.*` usage scan.

A follow-up audit of `03–05` against runtime/cluster code is a natural next
step and should reuse the same severity classification.
