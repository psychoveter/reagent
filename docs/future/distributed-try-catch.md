# Distributed Try/Catch Semantics

Status: Implemented in TS-first MVP | Date: 2026-03-13

---

## 1. Problem

Reagent already has protocol-level `try/catch` syntax:

```rg
try {
  ...
} catch (error) {
  ...
}
```

The current surface is clear, but the distributed semantics are still underspecified when failures
originate on other roles or inside concurrent execution.

The unresolved questions are no longer purely theoretical:

- which role is the fault originator
- how the failure reaches the enclosing `try`
- what happens to in-flight `par` / `scatter` siblings
- whether `catch` entry is a local guess or a protocol control decision
- how child `invokes`, `async invokes`, and `spawns` interact with the failure boundary
- whether catch-path steps may still involve the faulting role

The current TS runtime already supports local `try/catch` intuition, but it still behaves largely as:

- local exceptions
- local catch stacks
- ordinary protocol messages for other roles

That is not yet a good distributed model.

This RFC defines the first practical distributed `try/catch` semantics on top of the current
process model.

---

## 2. Goals

- Preserve `try/catch` as a protocol-level construct.
- Make fault origin explicit in runtime semantics, even if not explicit in syntax.
- Keep catch entry deterministic and centralized.
- Define fail-fast behavior for `par` and `scatter` inside `try`.
- Normalize failures into a structured runtime fault object.
- Align the model with the current process model in `../current/03-runtime-core.md`.

## 3. Non-goals

- Full saga/compensation algebra
- Automatic rollback of already visible remote side effects
- User-defined supervision trees as part of `try/catch`
- Rich typed exception hierarchies in v1
- Tolerant per-item scatter semantics in v1
- Checkpointed resume of in-flight `try` state across RC failure
- Automatic propagation from `async invokes` child failure into the parent `catch`

---

## 4. Dependencies and framing

This RFC should be read together with:

- `../current/02-lang-spec.md` for the current `try/catch` surface
- `../current/03-runtime-core.md` for the implemented process model, cancellation, and participant-loss model
- `backlog.md` where this work is tracked as `L1` and `F6`

Important framing rules:

- the process model in `../current/03-runtime-core.md` is the runtime foundation
- `try/catch` is a protocol control feature, not a convenience wrapper around local exceptions
- failure propagation is a runtime/control event, not an ordinary protocol message
- `catch (error)` remains syntactic sugar; the runtime value lives in `$ctx.error`

---

## 5. Core semantic contract

### 5.1 `try/catch` belongs to one protocol control scope

A `try/catch` block belongs to the protocol control flow, not to any single agent zone.

Its execution is anchored at one **control scope** on the protocol control path:

- for ordinary protocol flow, the scope that first enters the `try`
- for synchronous child calls, the parent scope that issued the `invokes`
- for distributed execution, the branch commitment remains owned by the protocol's home RC / supervisor path

This means:

- many roles may execute steps inside the `try`
- exactly one enclosing protocol control scope decides that the `catch` transition is taken

### 5.2 Any in-scope failure becomes a normalized protocol fault

Any host-language throw or runtime error inside the active `try` region is normalized into a
runtime fault object:

```ts
interface ProtocolFault {
  sourceRole: string;
  sourceAgent?: string;
  phase:
    | "action"
    | "send"
    | "receive"
    | "guard"
    | "invoke"
    | "spawn"
    | "parallel"
    | "scatter";
  code: string;
  message: string;
  detail?: unknown;
}
```

That normalized object is what becomes `$ctx.error`.

Minimum v1 requirements:

- `sourceRole`
- `sourceAgent` when known
- `phase`
- `message`
- implementation-defined `code`
- optional `detail`

### 5.3 Catch entry is out-of-band relative to choreography messages

The transition from `try` to `catch` does **not** require the faulting role to send an ordinary
protocol message.

This distinction is essential:

- choreography messages remain part of the protocol surface
- fault propagation is a runtime control event

Therefore, if role `B` faults, the runtime may move the enclosing protocol scope into `catch`
without any explicit `B --> ...: Error` step.

This is what makes a catch like the following well-defined:

```rg
try {
  ...
} catch (error) {
  A --> C: FailureNotice = { ... }
}
```

even when the original fault originated on `B`.

---

## 6. Proposed v1 semantics

### 6.1 Single-origin failure

If any operation inside the active `try` region fails:

1. the runtime records the originating role/agent and failure phase
2. the enclosing `try` scope becomes `failing`
3. sibling in-scope work is cancelled
4. the control path enters the `catch` continuation
5. `$ctx.error` is bound to the normalized `ProtocolFault`

Important point:

- `catch (error)` stays only a syntactic label
- the actual runtime value is always `$ctx.error`

### 6.2 Catch path is deterministic and centralized

The `catch` body executes as a normal protocol continuation after the failure has been committed
and in-scope cancellation bookkeeping has been applied.

First-version rule:

- the `catch` path is one centralized control continuation
- the transition into `catch` is driven by runtime failure propagation, not by ordinary protocol messaging
- roles mentioned in the `catch` body execute only if they remain available after the fault transition

This avoids the broken model where multiple roles independently \"notice\" the same fault and race
into different recoveries.

### 6.3 Recoverable role fault vs participant loss

Not every fault means the faulting role is gone.

The runtime must distinguish at least two classes:

#### Recoverable role fault

Examples:

- zone code throws
- a guard evaluation fails
- synchronous child `invokes` fails and propagates
- a send/receive hook fails, but the role's host runtime remains attached

Meaning:

- the role caused the fault
- the role may still be available for catch-path work

So a catch such as:

```rg
catch (error) {
  B --> A: FailureReport = { ... }
}
```

may be legal if `B` is still attached and routable after the fault transition.

#### Participant loss / unavailable role

Examples:

- `AgentShell` stops
- the host process dies
- RC detects participant loss
- transport/attachment loss makes the role unavailable

Meaning:

- the role cannot be relied upon inside the catch path

So the catch body must not require that role to take further protocol actions.

This is the intended mental model:

- fault on `B`
- runtime propagates `ProtocolFault(sourceRole = B, ...)`
- `A --> C` in `catch` may still be legal
- but `B --> A` in `catch` is only legal if `B` is still available

---

## 7. Interaction with concurrency

### 7.1 `par`

Inside:

```rg
try {
  par { ... } and { ... }
} catch (error) { ... }
```

if any branch fails:

- the enclosing in-scope `par` is considered failed
- all sibling branches are cancelled
- no sibling branch may continue producing new protocol-visible effects after cancellation is acknowledged
- the `catch` path begins only after branch cancellation bookkeeping completes

This gives `par` fail-fast semantics inside `try`.

### 7.2 `scatter`

Scatter branches inside a `try` behave similarly:

- one branch fault fails the enclosing `try`
- remaining scatter branches are cancelled
- the propagated `ProtocolFault` reports the concrete failing participant/agent identity when known

Future work may introduce tolerant scatter semantics, but v1 should remain fail-fast.

### 7.3 `timeout` and `alt`

Timeout is **not** a fault by itself.

- `timeout` remains a normal `alt` branch outcome
- only actual runtime/zone/protocol failures trigger `catch`

This keeps \"no message arrived\" separate from \"something failed\".

---

## 8. Interaction with child protocols and spawn

### 8.1 `invokes`

If a synchronous child protocol invoked inside the `try` fails without handling the fault internally:

- the child returns or propagates a normalized `ProtocolFault`
- the parent `try` fails
- the parent enters `catch`

This makes synchronous `invokes` the main fault-propagation boundary.

### 8.2 `async invokes`

`async invokes` is detached from the parent synchronous control flow.

First-version rule:

- failure of an `async invokes` child does **not** automatically trigger the parent's `catch`
- it is handled through lifecycle events, emitted error protocols, or later supervision work

Reason:

- otherwise the parent would remain implicitly coupled to all async descendants

### 8.3 `spawns`

If `spawn` itself fails inside the `try`, it triggers the catch path normally.

If a spawned participant later fails while still executing inside the parent's active `try` scope:

- it counts as a fault of that scope
- the parent `try` fails and enters `catch`

If a persistent spawned agent outlives that scope and fails later, it is not retroactively part of
the old `try`.

---

## 9. Cancellation semantics

When a `try` scope fails, the runtime must cancel all still-running work in the same scope:

- active `par` siblings
- active `scatter` siblings
- blocking receives waiting inside the same try region
- protocol-local timers belonging to the same region

Cancellation is cooperative at the runtime level:

- waiting states are aborted
- no new protocol-visible sends may start from cancelled siblings
- already delivered messages remain real historical effects

This is crucial:

- `try/catch` is not transactional rollback
- it is structured failure containment plus controlled catch continuation

---

## 10. What `catch` is allowed to do

The `catch` body remains ordinary protocol flow, so it may:

- execute zones
- send error or compensation messages
- call `reagent.emit()`
- call `reagent.return()`
- invoke child protocols

This enables patterns like:

```rg
try {
  ...
} catch (error) {
  coordinator {
    $ctx.failedRole = $ctx.error.sourceRole
  }

  coordinator --> auditor: FailureReport = {
    onSend {
      $ctx.msg.role = $ctx.error.sourceRole
      $ctx.msg.message = $ctx.error.message
    }
  }
}
```

and also:

```rg
try {
  A --> B: Request
  B { throw new Error("boom") }
  B --> C: Result
} catch (error) {
  A --> C: FailureNotice = {
    onSend {
      $ctx.msg.failedRole = $ctx.error.sourceRole
      $ctx.msg.reason = $ctx.error.message
    }
  }
}
```

Here the fault originates on `B`, but `A --> C` remains legal because catch entry is driven by
runtime fault propagation rather than by an explicit failure message from `B`.

What this should **not** imply:

- automatic rollback of already completed remote side effects
- re-entry into unfinished sibling branches

### 10.1 Catch-body legality depends on post-fault availability

The `catch` body is executed under one additional rule:

- a role may participate in the catch path only if it is still available after the fault transition

Implications:

- `A --> C` after a fault on `B` is fine if `A` and `C` remain available
- `B --> A` in catch is only valid for recoverable faults where `B` remains attached
- hard participant loss on `B` makes any required catch-path step involving `B` semantically invalid

This keeps the model realistic: `catch` is a protocol continuation, but not a magical ability to
force actions from a dead participant.

---

## 11. Example

### 11.1 Current intuition

The current demo shape:

```rg
try {
  processor {
    if ($ctx.requestText === "fail") {
      throw new Error("processing_failed")
    }
    $ctx.result = "processed:" + $ctx.requestText
  }

  processor --> sender: Result = { ... }
} catch (error) {
  processor {
    $ctx.errorMsg = "error occurred"
  }

  processor --> sender: Failure = { ... }
}
```

### 11.2 Meaning under this RFC

- `processor` is the fault originator
- the enclosing try scope fails
- no further success-path send occurs
- control transfers to `catch`
- `$ctx.error = { sourceRole: "processor", code: "processing_failed", ... }`
- `Failure` is sent as part of the catch path

---

## 12. Runtime and IR impact

### 12.1 IR

The IR needs explicit try-scope metadata, not just a local `error` edge:

```ts
interface TryScopeIR {
  id: string;
  catchTargetStateId: string;
}
```

Failures inside any state tagged with that scope should propagate to the same catch target under one
centralized try-scope decision.

### 12.2 Runtime

The runtime needs:

- normalized `ProtocolFault`
- try-scope metadata and catch ownership
- scope-local cancellation of sibling work
- fault propagation from synchronous child `invokes`
- deterministic catch entry on the protocol control path

### 12.3 Current implementation gap

The current TS runtime already has:

- parser and surface syntax
- local catch stacks
- catch-path execution

But it does **not** yet fully provide:

- structured `$ctx.error`
- centralized distributed catch entry
- fail-fast `par` / `scatter` cancellation under `try`
- out-of-band distributed fault propagation as a first-class control event

---

## 13. Test surface required for v1

At minimum, add or refresh tests for:

- single-role throw -> catch with structured `$ctx.error`
- remote role throw -> catch on another role's control path
- `par` branch failure cancels sibling branch
- `scatter` branch failure cancels siblings
- child `invokes` failure propagates to parent catch
- `async invokes` failure does not automatically trip parent catch
- uncaught in-scope failure still ends as protocol failure

---

## 14. Relationship to other docs

| Document | Relationship |
|---|---|
| `../current/02-lang-spec.md` | Current syntax exists there, but distributed semantics are not yet fully current-doc material. |
| `../current/03-runtime-core.md` | Process model foundation: control path, cancellation, participant loss, supervisor behavior, and non-checkpointed continuation assumptions. |
| `../current/08-test-spec.md` | Current test inventory already notes try/catch naming and coverage gaps. |
| `../current/09-e2e-usecases.md` | Payment use case explicitly avoids distributed `try/catch` today because these semantics are not settled in current docs yet. |
| `backlog.md` | Tracks this as `L1` and `F6`. |

---

## 15. Recommended first implementation boundary

Keep v1 narrow and TS-first:

- no syntax change
- normalized `ProtocolFault` in `$ctx.error`
- centralized catch decision
- fail-fast `par`
- fail-fast `scatter`
- synchronous `invokes` propagate faults
- `async invokes` do not
- participant availability still constrains catch-body legality

That boundary is large enough to make distributed `try/catch` coherent, but small enough to avoid
premature compensation or supervision-language design.
