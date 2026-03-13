# Explicit Decision Maker In `alt`

Status: RFC draft | Date: 2026-03-13

---

## 1. Problem

Reagent currently supports two styles of `alt`:

- message-based `alt`
- expression-based `alt`

Examples:

```rg
alt (sia --> comma: Accept) {
  ...
} else (sia --> comma: Reject) {
  ...
}
```

```rg
alt ($ctx.outcome == "done") {
  ...
} else {
  ...
}
```

The message-based form already implies who decides: the role that receives one of the candidate
messages.

The expression-based form is underspecified in distributed settings:

- which role evaluates the expression
- whether other roles are expected to know the result ahead of time
- how non-deciding roles block until a branch is chosen
- how branch selection appears in the trace

This RFC makes the decision maker explicit.

---

## 2. Goals

- Remove ambiguity from expression-based `alt`.
- Preserve current message-based `alt` intuition.
- Make branch choice explicit in the language and trace.
- Improve future formalization work around projection and distributed consistency.

## 3. Non-goals

- Replacing `alt` with a general-purpose logic language
- Adding arbitrary distributed consensus semantics into protocol syntax
- Solving exception semantics here (tracked separately in `distributed-try-catch.md`)

---

## 4. Core decision

### 4.1 Every `alt` has one decision maker

Every `alt` branch point has exactly one deciding role.

That role is responsible for:

- evaluating the guard if it is expression-based
- observing which message branch wins if it is reactive
- committing the chosen branch
- making that choice visible to the rest of the protocol

### 4.2 Syntax

Recommended new surface:

```rg
alt at reviewer ($ctx.approval.approved == true) {
  ...
} else {
  ...
}
```

and for message-based branching:

```rg
alt at comma (sia --> comma: Accept) {
  ...
} else (sia --> comma: Reject) {
  ...
} else (timeout 10s) {
  ...
}
```

Rule:

- `at <role>` is mandatory in the long-term surface
- legacy omission may be tolerated only during migration

---

## 5. Semantics by alt kind

### 5.1 Expression-based `alt`

For:

```rg
alt at reviewer ($ctx.approval.approved == true) {
  ...
} else {
  ...
}
```

the deciding role:

- is `reviewer`
- evaluates the expression against its own local `$ctx`
- chooses branch 0 or branch 1
- emits a branch-selection event into the runtime trace

Other roles do not independently evaluate the expression.
They wait until the branch choice is committed.

This avoids the broken model where multiple roles might each inspect their own incompatible local
context and "decide" differently.

### 5.2 Message-based `alt`

For:

```rg
alt at comma (sia --> comma: Accept) {
  ...
} else (sia --> comma: Reject) {
  ...
}
```

the deciding role:

- is `comma`
- waits for the candidate incoming events
- commits the branch corresponding to the first matching message/timeout

This makes explicit what was previously only implicit.

### 5.3 Timeout branch

Timeout is resolved by the same decision maker:

- the deciding role waits for the message alternatives
- if none arrives before the timeout, the timeout branch is chosen

---

## 6. Runtime model

### 6.1 Branch commitment

`alt` should become a two-step runtime event:

1. decision maker evaluates or observes the winning guard
2. runtime commits a branch id for the current protocol instance and branch point

Conceptually:

```ts
interface AltDecision {
  protocolName: string;
  instanceId: string;
  altId: string;
  decidedByRole: string;
  branchIndex: number;
}
```

### 6.2 Non-deciding roles

Roles that are not the decision maker:

- do not speculate
- do not evaluate expression guards locally
- block until the branch decision is known
- continue only on the committed branch

This is crucial for future projection semantics.

### 6.3 Trace visibility

Branch choice should be visible in the runtime/debug trace as an explicit event, e.g.:

- `AltEvaluated`
- `AltBranchChosen`

This makes debugging much easier than inferring branch choice from later messages.

---

## 7. Why this matters for formalization

Without an explicit decision maker, expression-based `alt` is not projection-friendly:

- there is no canonical owner of the branch predicate
- other roles cannot know why a branch was chosen
- distributed determinism depends on undocumented assumptions

With `alt at <role>`:

- branch ownership is explicit
- projection can treat the deciding role as the branch source
- other roles become followers that react to committed branch choice

This is why backlog `F2` is both a practical feature and a formal prerequisite.

---

## 8. Examples

### 8.1 Approval flow

Current shape:

```rg
alt ($ctx.approval.approved == true) {
  ...
} else {
  ...
}
```

Recommended shape:

```rg
alt at reviewer ($ctx.approval.approved == true) {
  reviewer {
    $self.lastApproved = $ctx.today
  }
} else {
  reviewer {
    $self.lastRejected = $ctx.today
  }
}
```

### 8.2 Message wait

Current shape:

```rg
alt (sia --> comma: Accept) {
  ...
} else (sia --> comma: Reject) {
  ...
} else (timeout 10s) {
  ...
}
```

Recommended shape:

```rg
alt at comma (sia --> comma: Accept) {
  ...
} else (sia --> comma: Reject) {
  ...
} else (timeout 10s) {
  ...
}
```

### 8.3 Why `at` matters

Even when syntax seems obvious, explicitness helps:

- it documents who owns the branch condition
- it gives the runtime one branch authority
- it makes later analysis/projection deterministic

---

## 9. Compatibility and migration

### 9.1 Short-term

The compiler may temporarily allow omitted `at <role>` when it can infer a unique decision maker:

- message-based `alt` where all candidate branches target the same receiver
- expression-based `alt` only in narrow cases where the active role is obvious

### 9.2 Long-term

The intended long-term language surface should require explicit `at <role>`.

This is preferable to magical inference because:

- it survives refactors
- it is easier to explain
- it is easier to project and verify

---

## 10. Runtime impact

### 10.1 Parser / IR

The IR should carry:

```ts
interface AltIR {
  id: string;
  decisionRole: string;
  branches: AltBranchIR[];
}
```

### 10.2 Runtime

The runtime needs:

- one explicit deciding role
- branch-commit events
- blocking follower roles until commitment

### 10.3 Tests

Add or refresh tests for:

- expression-based `alt at <role>`
- message-based `alt at <role>`
- timeout branch with explicit decision maker
- invalid `alt at <role>` when the role cannot observe/evaluate the branch condition
- migration diagnostics for omitted decision maker

---

## 11. Relationship to other docs

| Document | Relationship |
|---|---|
| `../current/02-lang-spec.md` | Current `alt` syntax exists there but should evolve toward explicit `at <role>`. |
| `backlog.md` | Tracks this as both `L2` and `F2`. |
| `../current/09-e2e-usecases.md` | Several current use cases rely on expression-based `alt`; this RFC clarifies who decides those branches. |
| `distributed-try-catch.md` | Try/catch remains separate. `alt` branch choice is not failure handling. |

---

## 12. Recommended first implementation boundary

Keep the first implementation narrow:

- add `at <role>` syntax
- make it mandatory for new expression-based `alt`
- support it for message-based `alt`
- keep runtime branch commitment explicit

That is enough to make the model significantly clearer without redesigning the rest of control flow.
