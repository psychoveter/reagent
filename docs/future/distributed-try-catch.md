# Distributed Try/Catch Semantics

Status: RFC draft | Date: 2026-03-13

---

## 1. Problem

Reagent already has surface syntax for protocol-level `try/catch`:

```rg
try {
  ...
} catch (error) {
  ...
}
```

This works as a local intuition, but becomes underspecified as soon as failures may originate on
different roles or inside parallel/distributed execution.

Today the language leaves several critical questions open:

- which role is considered the fault originator
- how the failure reaches the `catch` scope
- what happens to in-flight work on sibling roles
- whether the `catch` body runs only on the home/deciding role or as a distributed compensation path
- how `par`, `scatter`, `invokes`, and `spawns` interact with failure

This RFC defines a practical first version of distributed `try/catch`.

---

## 2. Goals

- Preserve `try/catch` as a protocol-level construct.
- Make failure origin explicit in runtime semantics, even if not explicit in syntax.
- Keep catch execution deterministic.
- Define what gets cancelled when one branch faults.
- Make the model compatible with current `RoleRun` / `AgentShell` / distributed process semantics.

## 3. Non-goals

- Full saga/compensation algebra
- User-defined supervision trees
- Recovering arbitrary partially completed side effects automatically
- Rich typed exception hierarchies in v1

---

## 4. Core decision

### 4.1 `try/catch` is owned by one protocol control scope

A `try/catch` block belongs to the protocol control flow, not to any one agent zone.

Its execution is anchored at a **control role**:

- by default, the role that enters the `try` block first in the protocol flow
- for child protocols, the role that issued the `invokes`
- for top-level protocol execution, usually the initiator-side active role run

This role is the one that decides whether the `catch` path is taken.

### 4.2 Faults become protocol failures, not raw host exceptions

Any host-language throw or runtime error inside the `try` region is normalized into a protocol fault:

```ts
interface ProtocolFault {
  sourceRole: string;
  sourceAgent?: string;
  phase: "action" | "send" | "receive" | "guard" | "invoke" | "spawn" | "parallel" | "scatter";
  code: string;
  message: string;
  detail?: unknown;
}
```

That normalized fault is what flows into `$ctx.error`.

### 4.3 Fault propagation is out-of-band relative to protocol messages

The transition from `try` to `catch` does **not** require the faulting role to send an ordinary
protocol message.

This is a critical distinction:

- protocol messages are part of the choreography
- fault propagation is a runtime/control event

So if role `B` fails, the runtime may move the protocol into the `catch` continuation without any
explicit `B --> ...: Error` step having occurred.

This is what allows a catch body such as:

```rg
try {
  ...
} catch (error) {
  A --> C: FailureNotice = { ... }
}
```

even when the original fault originated on `B`.

---

## 5. Proposed semantics

### 5.1 Single-origin failure

If any operation inside the `try` region fails:

1. the runtime records the originating role/agent and failure phase
2. the enclosing `try` scope becomes `failing`
3. sibling work inside that same `try` scope is cancelled
4. the control role enters the `catch` path
5. `$ctx.error` is bound to the normalized `ProtocolFault`

Important point:

- `catch (error)` remains syntactic sugar
- the actual value always lives in `$ctx.error`

### 5.2 Catch path is deterministic and centralized

The `catch` body executes as a normal protocol path after cancellation settles.

First-version rule:

- the `catch` path is **single control path**
- the transition into `catch` is triggered by runtime fault propagation, not by an ordinary protocol message from the faulting role
- roles named in the catch body execute their message steps and zones only if they are still available after the fault transition
- but the decision to enter catch is centralized at the control role

This avoids the ambiguity where multiple roles independently "notice" the error and race into
different recoveries.

### 5.3 Recoverable role fault vs participant loss

Not every failure means the faulting role is gone.

The runtime should distinguish at least two classes:

#### Recoverable role fault

Examples:

- zone code throws
- a guard evaluation fails
- a synchronous child invoke fails and propagates
- a send/receive handler fails, but the host runtime for that role remains attached

Meaning:

- the role caused the fault
- the role may still be available for subsequent catch-path work

So a catch such as:

```rg
catch (error) {
  B --> A: FailureReport = { ... }
}
```

may be legal if `B` is still attached and routable.

#### Participant loss / unavailable role

Examples:

- agent shell stops
- host process dies
- RC loses the participant
- transport/attachment loss makes the role unavailable

Meaning:

- the role cannot be relied upon inside the catch path

So the catch body must not require that role to take further protocol actions.

This is the case your mental model should treat as:

- error on `B`
- runtime propagates `ProtocolFault(sourceRole=B, ...)`
- catch continuation may still do `A --> C`
- but catch must not depend on `B` replying unless availability says it can

---

## 6. Interaction with concurrency

### 6.1 `par`

Inside:

```rg
try {
  par { ... } and { ... }
} catch (error) { ... }
```

if any branch fails:

- the entire `par` inside the `try` is considered failed
- all sibling branches are cancelled
- no branch may continue producing visible protocol effects after cancellation is acknowledged
- the `catch` path begins only after the runtime completes branch cancellation bookkeeping

This gives `par` fail-fast semantics inside `try`.

### 6.2 `scatter`

Scatter branches inside a `try` are treated similarly:

- one branch fault fails the enclosing `try`
- remaining scatter branches are cancelled
- the failure is reported with the failing branch's concrete participant/agent identity

Future extension may add per-item tolerant scatter, but v1 should stay fail-fast.

### 6.3 `timeout` and `alt`

Timeout is **not** a fault by itself.

- `timeout` remains a normal `alt` branch outcome
- only actual runtime/zone/protocol failures trigger `catch`

This keeps "no message arrived" separate from "something failed".

---

## 7. Interaction with child protocols and spawn

### 7.1 `invokes`

If a synchronous child protocol invoked inside the `try` fails without handling the fault internally:

- the child returns a propagated `ProtocolFault`
- the parent `try` fails
- the parent enters `catch`

This makes `invokes` the natural fault-propagation boundary.

### 7.2 `async invokes`

`async invokes` is detached from the parent synchronous control flow.

First-version rule:

- failure of an `async invokes` child does **not** automatically trigger the parent's `catch`
- it is handled through lifecycle events / emitted error protocols / future supervision work

Reason:

- otherwise the parent would need to remain implicitly coupled to all async descendants

### 7.3 `spawns`

If `spawn` itself fails inside the `try`, it triggers the catch path normally.

If a spawned participant later fails while still executing inside the parent's active `try` scope:

- it counts as a fault of that scope
- the parent `try` fails and enters catch

If a persistent spawned agent outlives the scope and fails later, that is not retroactively part of the old `try`.

---

## 8. Cancellation semantics

When `try` fails, the runtime must cancel all still-running work in the same scope:

- active `par` siblings
- active `scatter` siblings
- blocking receives waiting inside the same try region
- protocol-local timers belonging to the same region

Cancellation is cooperative at the runtime level:

- waiting states are aborted
- no new protocol-visible sends may start from cancelled siblings
- already delivered messages remain real historical effects

This is important:

- `try/catch` is not transactional rollback
- it is structured failure containment + compensation

---

## 9. What `catch` is allowed to do

The `catch` body is just normal protocol flow, so it may:

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

Here the fault originates on `B`, but `A --> C` is still legal because catch entry is driven by
runtime fault propagation, not by an explicit failure message from `B`.

What it should not imply:

- automatic rollback of already completed remote side effects
- re-entry into unfinished sibling branches

### 9.1 Catch-body legality depends on post-fault availability

The catch body is validated/executed under one additional rule:

- a role may participate in the catch path only if it is still available after the fault transition

Implications:

- `A --> C` after a fault on `B` is fine if `A` and `C` remain available
- `B --> A` in catch is only valid for recoverable faults where `B` is still attached
- hard participant loss on `B` makes any required catch-path step involving `B` semantically invalid

This keeps the model realistic: `catch` is a continuation of the protocol, but not a magical
ability to force actions from a dead participant.

---

## 10. Example

### 10.1 Current intuition

The current demo:

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

### 10.2 Meaning under this RFC

- `processor` is the fault originator
- the enclosing try scope fails
- no further success-path send occurs
- control transfers to catch
- `$ctx.error = { sourceRole: "processor", code: "processing_failed", ... }`
- `Failure` is sent as part of the catch path

---

## 11. Runtime impact

### 11.1 IR

The IR needs explicit try-scope metadata:

```ts
interface TryScopeIR {
  id: string;
  catchTargetStateId: string;
}
```

Failures inside any state tagged with the scope propagate to that catch target.

### 11.2 Runtime

The runtime needs:

- normalized `ProtocolFault`
- scope-local cancellation of sibling work
- fault propagation from child `invokes`
- deterministic catch entry on the control role

### 11.3 Tests

At minimum add/refresh:

- single-role throw -> catch
- remote role throw -> catch on another role's control path
- `par` branch failure cancels sibling branch
- `scatter` branch failure cancels siblings
- child `invokes` failure propagates to parent catch
- `async invokes` failure does not automatically trip parent catch

---

## 12. Relationship to other docs

| Document | Relationship |
|---|---|
| `../current/02-lang-spec.md` | Current surface syntax exists there, but semantics need this RFC. |
| `../archive/process-model.md` | Provides the larger ownership/failure model this RFC plugs into. Current docs: `../current/03-runtime-core.md §9`. |
| `../current/09-e2e-usecases.md` | Payment use case explicitly avoids `try/catch` today because this semantics is not yet settled. |
| `backlog.md` | Tracks this as `L1` and `F6`. |

---

## 13. Recommended first implementation boundary

Keep v1 narrow:

- fail-fast `par`
- fail-fast `scatter`
- synchronous `invokes` propagate faults
- `async invokes` do not
- centralized catch decision

That gives a coherent model without forcing immediate compensation/saga design.
