# Scatter / Gather Semantics

Status: RFC draft | Date: 2026-03-13

---

## 1. Problem

Reagent already has `scatter` as a first-class protocol construct:

```rg
scatter ($ctx.items as worker) {
  ...
}
```

The intended meaning is clear:

- fork one branch per item
- execute branch-local logic
- join after all branches complete

But the current semantics are not strong enough.

Today, branch `$ctx` isolation is only approximate:

- TS runtime uses `Object.create(parentCtx)`
- Python runtime uses shallow `dict(parentCtx)`
- current docs describe this as "isolated copy" even though nested mutable values are still shared

That creates three practical problems:

1. branch-local writes can leak into shared parent structures such as arrays and objects
2. fan-in currently depends on implicit shared mutation (`$ctx.results.push(...)`) instead of an explicit contract
3. failure, cancellation, and ownership semantics are underspecified once scatter interacts with `try/catch`, distributed execution, and the newer process model

This RFC defines a narrow first version that fixes the semantic mismatch without trying to solve every future scaling problem at once.

---

## 2. Goals

- Replace prototype/shallow-copy branch semantics with true branch-local clone semantics.
- Make branch result fan-in explicit through a `gather` contract.
- Define deterministic ordering for gathered branch results.
- Align scatter semantics with the current process model and future control-flow RFCs.
- Make `scatter` fail-fast inside `try`, consistent with `par`.
- Provide a migration path away from implicit shared-mutation fan-in.

## 3. Non-goals

- Quorum scatter
- Deadline/partial-result scatter
- Partitioned/distributed scatter execution strategy
- Checkpointed resume of branch-local `$ctx`
- Automatic rollback or compensation of side effects
- Arbitrary host-object cloning guarantees for opaque runtime values

---

## 4. Inputs and dependencies

This RFC should be read together with:

- `docs/current/02-lang-spec.md` for the current language surface
- `docs/current/03-runtime-core.md` for the implemented process model
- `docs/future/distributed-try-catch.md` for fail-fast cancellation and centralized catch semantics
- `docs/archive/alt-decision-maker.md` for the completed explicit control ownership design at distributed branch points
- `docs/archive/scatter-gather-semantics.md` as useful prior art, but not canonical semantics

Important dependency framing:

- the process model in `docs/current/03-runtime-core.md` is normative
- `distributed-try-catch.md` defines how branch failure escalates and how cancellation settles
- `../archive/alt-decision-maker.md` establishes the design rule that distributed control points have one owner

This RFC adopts those constraints rather than redefining them.

---

## 5. Current mismatch

### 5.1 Spec mismatch

The current language spec says:

- each scatter branch gets an isolated copy of `$ctx`
- writes do not affect siblings or parent

But the runtime implementation does not currently provide that guarantee for nested mutable values.

### 5.2 Runtime reality

Current TS runtime shape in `runtime/ts/src/core/role-run.ts`:

```ts
const branchCtx = Object.create(this.engine.ctx);
branchCtx._scatterItem = item;
branchCtx._scatterIdx = idx;
await this.runBranch(branchStartId, joinId, branchCtx);
```

This means a branch that does:

```ts
$ctx.results.push(x)
```

may mutate an inherited parent array rather than a branch-local value.

So current scatter fan-in is often:

- implicit
- mutation-based
- order-sensitive
- semantically fragile

That mismatch should be fixed explicitly rather than explained away in docs.

---

## 6. Core decision

Scatter becomes a two-phase construct:

1. **branch phase**: each branch executes with a cloned branch-local `$ctx`
2. **gather phase**: branch outputs are merged explicitly on one control path

This RFC keeps v1 narrow:

- branch isolation is strengthened
- gather becomes explicit in the language model
- failure semantics are fail-fast under `try`
- ownership follows the same single-owner principle as `alt`

---

## 7. Proposed surface

### 7.1 Recommended shape

```rg
scatter ($ctx.items as worker) {
  ...
} gather(results) {
  ...
}
```

Semantics:

- `scatter (...) { ... }` runs one branch per item
- `gather(results) { ... }` runs once after successful completion of all branches
- `results` is an ordered array of per-branch outputs

### 7.2 No-gather form

The language may continue to allow:

```rg
scatter ($ctx.items as worker) {
  ...
}
```

But in the semantic model this is just shorthand for:

- run scatter branches
- collect branch results into a default runtime value
- continue with no explicit gather zone

Recommended v1 rule:

- default collected results are placed in `$ctx._scatterResults`
- ordering is still deterministic by original `_scatterIdx`

This preserves a migration bridge without preserving implicit shared mutation.

### 7.3 Branch locals

Each scatter branch still gets:

- `$ctx._scatterItem`
- `$ctx._scatterIdx`

These remain runtime-injected special fields.

---

## 8. Branch context semantics

### 8.1 Clone semantics

Each branch receives a clone of the parent `$ctx` as it existed at scatter entry.

Conceptually:

```ts
const branchCtx = clone(parentCtxAtScatterEntry);
branchCtx._scatterItem = item;
branchCtx._scatterIdx = idx;
```

Required semantic guarantee:

- writes in one branch do not affect siblings
- writes in one branch do not affect parent `$ctx` directly

### 8.2 Scope of the guarantee

This RFC defines clone semantics at the language level for **plain protocol data**.

It does **not** promise that arbitrary host-language objects inside `$ctx` are clonable or portable across runtimes.

First-version practical rule:

- `$ctx` should be treated as protocol data, not a bag of opaque live host objects
- plain objects, arrays, scalars, and JSON-like data are within the intended model
- opaque handles, functions, class instances, sockets, and other host-specific values are outside the guarantee

This keeps the semantics portable across TS and Python without inventing a full object-graph contract.

### 8.3 Branch output

A branch result is the branch's final `$ctx` snapshot after the branch body completes successfully.

V1 result model:

- branch result = final branch-local `$ctx`
- gather receives an ordered array of those snapshots

Future versions may allow narrower or typed branch outputs, but v1 should not add that complexity.

---

## 9. Gather semantics

### 9.1 Gather owner

`gather` executes on one control path only.

This RFC reuses the same design rule as `alt`:

- a distributed control point has one owner
- other roles do not invent their own merge decisions

For scatter/gather, the owner is:

- the protocol control path that entered the scatter
- in practice, the active control role run on the home RC

This RFC does not add a new hidden coordinator abstraction.

### 9.2 Gather input

For:

```rg
scatter ($ctx.items as worker) {
  ...
} gather(results) {
  ...
}
```

the runtime binds:

- `results` = ordered array of branch-local `$ctx` snapshots

Equivalent conceptual shape:

```ts
type ScatterResult = Array<{
  _scatterIdx: number;
  _scatterItem: unknown;
  // ...final branch-local ctx fields...
}>;
```

### 9.3 Ordering

Gather ordering is deterministic and defined by original scatter index:

- `results[0]` corresponds to `_scatterIdx == 0`
- not completion order
- not message-arrival order

This avoids nondeterminism when branches complete at different times.

### 9.4 Zero-branch case

If the collection is empty:

- no branch bodies execute
- gather still executes, with `results = []`
- if no explicit gather exists, `$ctx._scatterResults = []`

This keeps scatter semantics total and predictable.

### 9.5 Parent mutation point

The parent `$ctx` is only updated on the gather/control path:

- branch bodies mutate branch-local `$ctx`
- gather transforms those outputs into parent-state updates

This is the key semantic shift away from implicit shared fan-in.

---

## 10. Failure semantics

### 10.1 Scatter outside `try`

Outside `try`, a branch fault fails the enclosing protocol path according to normal runtime fault handling.

This RFC does not invent a special tolerant scatter mode outside `try`.

### 10.2 Scatter inside `try`

Inside `try`, scatter is fail-fast, matching `par`:

1. one branch fault marks the enclosing `try` as failing
2. sibling scatter branches are cancelled
3. normal gather does not execute
4. `catch` begins only after cancellation bookkeeping settles
5. `$ctx.error` carries the normalized `ProtocolFault`

This is intentionally aligned with `docs/future/distributed-try-catch.md`.

### 10.3 Fault origin

Branch faults are normalized the same way as other protocol faults:

- `sourceRole`
- `sourceAgent` when known
- `phase`
- `code`
- `message`

For scatter failures, `phase` should identify scatter participation clearly, e.g.:

- `phase: "scatter"`
- or a more specific nested branch phase if the runtime already distinguishes action/send/receive inside the scatter branch

The exact normalized shape should remain consistent with the try/catch RFC.

### 10.4 Partial results

V1 does **not** define partial-success gather.

That means:

- if a scatter branch faults in a fail-fast context, successful sibling outputs are not passed to normal gather
- partial result harvesting is deferred work

This keeps the first version simple and compatible with centralized catch semantics.

---

## 11. Interaction with `alt`

Scatter does not itself choose among semantic alternatives, but gather-time logic often leads into branching:

```rg
scatter (...) {
  ...
} gather(results) {
  $ctx.count = results.length
}

alt at coordinator ($ctx.count > 0) {
  ...
} else {
  ...
}
```

Rule:

- if post-gather logic branches, ownership of that branch is governed by `alt at <role>`
- gather does not become a second hidden decision mechanism

This RFC therefore adopts the single-owner vocabulary from `../archive/alt-decision-maker.md`.

---

## 12. Interaction with the process model

The process model from `docs/current/03-runtime-core.md` is the runtime foundation.

### 12.1 Cancellation is convergent, not rollback

If a scatter branch is cancelled or a sibling fault causes cancellation:

- execution stops cooperatively
- already-visible side effects are not undone
- gather must not assume transactional rollback

### 12.2 Participant loss vs recoverable branch fault

Scatter semantics must distinguish:

- branch-local failure while the participant remains attached
- participant loss / detachment / host death

Both may fail the enclosing try/path, but catch-path legality still depends on participant availability exactly as described in `distributed-try-catch.md`.

### 12.3 No checkpointed resume

Current runtime does not checkpoint branch-local `$ctx`, RoleRun continuation points, or per-branch progress.

So this RFC explicitly does **not** promise:

- resuming in-flight scatter branches after RC loss
- reconstructing branch-local state across orphan adoption

### 12.4 `many` durability remains limited

Current durable process storage still assumes one live owner entry per role name.

So this RFC should not pretend that scatter already has:

- fully durable per-branch ownership records
- fully general distributed many-participant branch supervision

Those concerns are deferred.

---

## 13. Migration

### 13.1 Breaking semantic change

The following current pattern is no longer a valid fan-in mechanism:

```rg
scatter ($ctx.items as worker) {
  worker {
    $ctx.results.push($ctx.value)
  }
}
```

Why:

- `results` now belongs to branch-local cloned state
- branch writes do not flow back to parent implicitly

### 13.2 Recommended rewrite

Before:

```rg
scatter ($ctx.items as worker) {
  worker {
    $ctx.bids.push($ctx.bidAmount)
  }
}
```

After:

```rg
scatter ($ctx.items as worker) {
  worker {
    $ctx.bid = $ctx.bidAmount
  }
} gather(results) {
  $ctx.bids = results.map(r => r.bid)
}
```

### 13.3 Compatibility bridge

For scatter blocks without explicit gather:

- runtime collects ordered branch snapshots into `$ctx._scatterResults`
- later code may inspect that value directly

This is a migration bridge, not the preferred long-term style.

### 13.4 Known current surfaces to migrate

Current examples/docs/tests likely affected:

- `examples/protocols/src/23-scatter-gather.rg`
- `examples/projects/auction-sim/protocols/auction.rg`
- `docs/current/09-e2e-usecases.md`
- `runtime/ts/test/core/scatter-async.test.ts`
- `runtime/ts/test/core/role-run.test.ts`
- `runtime/tests/contracts/lang-surface-runtime.test.ts`
- `runtime/tests/contracts/runtime-conformance.test.ts`
- `runtime/tests/python/parity/test_ts_python_parity.py`

Any example that currently relies on branch-local `push`, `append`, or nested object mutation as a shared merge channel must be rewritten.

---

## 14. IR and runtime consequences

This RFC is semantic-first, but it implies concrete implementation directions.

### 14.1 Language / IR

The language/IR likely needs:

- `gather` as an optional companion to `scatter`
- branch result metadata in IR
- decompiler support for explicit gather
- validator rules around gather placement and bindings

### 14.2 Runtime

The runtime likely needs:

- real branch-local cloning in TS and Python
- ordered branch result collection
- explicit handoff of gathered branch results to the control path
- failure/cancellation behavior aligned with try/catch semantics

### 14.3 Tooling

The following tooling will need to stay in sync once syntax lands:

- parser / decompiler
- TextMate grammar
- VS Code language server diagnostics
- diagrams and trace visualization

This RFC intentionally does not specify the implementation order in detail.

---

## 15. Deferred work

The following are intentionally deferred:

- tolerant scatter with partial gather
- deadline/quorum semantics
- distributed partitioning of scatter across nodes
- per-branch retry policy
- typed gather inputs/outputs
- checkpointed continuation for branch-local state
- richer durable ownership for `many`-cardinality process records

These should be addressed only after v1 semantics are stable.

---

## 16. Spec delta sketch

This RFC implies the following future updates to `docs/current/02-lang-spec.md`:

- replace the current prototype/shallow-copy wording with true clone semantics
- define `gather(results) { ... }` as the explicit merge phase for scatter
- define `$ctx._scatterResults` as the default no-gather compatibility result
- clarify deterministic ordering by `_scatterIdx`
- clarify zero-branch behavior
- align scatter failure text with fail-fast `try/catch`

It also implies a runtime-note update to `docs/current/03-runtime-core.md`:

- scatter cancellation and fault handling should reference the process model and distributed cancellation rules directly

---

## 17. Open questions

- Should `gather` be required in the long-term surface, or remain optional with `_scatterResults` fallback?
- Should gather receive full branch `$ctx` snapshots or a narrower runtime-defined result envelope?
- How strict should the runtime be about non-clonable `$ctx` values?
- Should scatter branch fault reporting use `phase: "scatter"` or preserve the inner branch phase precisely?
- When distributed/partitioned scatter is added later, should result transport still be defined as ordered branch snapshots?

---

## 18. Recommended next step

Use this RFC as the semantic anchor for follow-up work:

1. make this file the canonical `R2` reference in `docs/future/backlog.md`
2. decide whether `gather` is merely recommended in v1 or should become mandatory in the long-term surface
3. update examples that currently depend on implicit shared mutation
4. only then prepare parser/IR/runtime implementation work
