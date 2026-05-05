# Explicit Decision Maker In `alt`

Status: Implemented and archived | Date: 2026-03-13

This RFC is archived because explicit `alt at <role>` support has landed in the language,
runtime, tooling, examples, and current docs.

Canonical current references:

- `../current/02-lang-spec.md`
- `../current/09-e2e-usecases.md`

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

The message-based form often looks intuitive because the receiver of the candidate messages seems to
be the obvious chooser.

The expression-based form is much less clear in distributed execution:

- which role evaluates the expression
- whether other roles are supposed to evaluate it too
- where the decision lives in the runtime model
- how non-deciding roles wait for the result
- how the branch choice survives trace/debug inspection

That ambiguity became more important after the process model work:

- protocol execution now has an explicit home RC / protocol supervisor model
- cancellation and fault propagation are explicitly centralized
- branch ownership and control points should no longer be left as folklore

This RFC makes the decision maker explicit and aligns `alt` with the current process/runtime model.

---

## 2. Goals

- Remove ambiguity from expression-based `alt`.
- Preserve the core intuition of message-based `alt`.
- Make branch choice explicit in the language, runtime, and trace.
- Align `alt` with the current process model vocabulary: control path, home RC, protocol supervisor, cancellation.
- Improve future projection and formalization work by giving every branch point one owner.

## 3. Non-goals

- Replacing `alt` with a general-purpose logic language
- Adding arbitrary distributed consensus semantics into protocol syntax
- Solving exception semantics here (tracked separately in `distributed-try-catch.md`)
- Promising checkpointed resume of in-flight branch decisions across RC failure
- Redesigning the entire runtime control plane around `alt`

---

## 4. Dependencies and framing

This RFC should be read together with:

- `../current/02-lang-spec.md` for the current `alt` surface
- `../current/03-runtime-core.md` for the process model, supervision, fault propagation, cancellation, and re-homing
- `../future/distributed-try-catch.md` for failure semantics around branch points
- `../future/backlog.md` where this work was tracked as both `L2` and `F2`

Important framing rules:

- the process model in `../current/03-runtime-core.md` is the runtime foundation
- `alt` branch choice is a protocol control event, not a free-floating local guess
- explicit ownership should use the same vocabulary that now exists elsewhere in Reagent: control role, protocol control path, home RC, branch commitment

---

## 5. Core decision

### 5.1 Every `alt` has one decision maker

Every `alt` branch point has exactly one deciding role.

That role is responsible for:

- evaluating the guard if the `alt` is expression-based
- observing which branch wins if the `alt` is message-based
- resolving timeout competition for timeout branches
- committing the chosen branch into protocol control state
- making that choice visible to the rest of the runtime

### 5.2 `alt` is owned by the protocol control path

The deciding role is a language-level notion.

The actual branch commitment happens on the protocol control path:

- node-locally, as part of the active protocol execution owned by the runtime
- in distributed execution, under the protocol's home RC / protocol supervisor

This matters because `alt` is not just "who looked at `$ctx` first".
It is a control decision that other roles must follow.

### 5.3 Syntax

Recommended surface:

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

- `at <role>` is the intended long-term surface
- temporary migration inference may exist, but should not remain the semantic model

---

## 6. Semantics by alt kind

### 6.1 Expression-based `alt`

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
- emits a branch-selection decision into runtime trace/control state

Other roles:

- do not independently evaluate the expression
- do not speculate
- wait until the branch choice is committed

This avoids the broken model where multiple roles inspect incompatible local state and "decide" differently.

### 6.2 Message-based `alt`

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
- commits the branch corresponding to the first matching message

This makes explicit what was previously only implicit.

### 6.3 Timeout branch

Timeout belongs to the same deciding role:

- the deciding role waits for the message alternatives
- if none arrives before the timeout, the timeout branch wins
- timeout is still a branch outcome, not a fault by itself

This is important so that timeout ownership stays consistent with both `alt` and `try/catch`.

### 6.4 Else branch

`else` is not independently chosen by another role.

It is simply:

- the fallback branch under the same decision owner
- committed when no earlier branch guard wins

---

## 7. Runtime model

### 7.1 Branch commitment as a control event

`alt` should be modeled as a two-step runtime action:

1. the deciding role evaluates or observes the winning alternative
2. the protocol control path commits a branch id for the current instance and `alt`

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

This is not an ordinary protocol message.
It is a runtime/control event.

### 7.2 Control ownership and the process model

Under the current process model:

- the protocol has a home RC / protocol supervisor
- cancellation and fault propagation are coordinated there
- other RCs and roles follow committed control outcomes rather than inventing their own

So `alt` branch choice should be thought of as:

- **decided by one role**
- **committed by the protocol control path**
- **observed by followers**

This matches the same centralized-control intuition used by `distributed-try-catch.md`.

### 7.3 Non-deciding roles

Roles that are not the decision maker:

- do not evaluate expression guards locally
- do not race each other to choose a branch
- block until the branch decision is known
- continue only on the committed branch

This is the core projection-friendly property.

### 7.4 Trace visibility

Branch choice should appear in runtime/debug trace as explicit events, for example:

- `AltEvaluated`
- `AltBranchChosen`

This is much easier to debug than inferring branch choice from later messages.

V1 requirement:

- explicit trace event in the live/debug trace
- durable persistence into `ProtocolRunRecord` is not required in v1

The process model already says branch-local execution state is not checkpointed; `alt` should not over-promise beyond that.

---

## 8. Interaction with failure, cancellation, and adoption

### 8.1 `alt` is not failure handling

`alt` chooses among protocol branches.
It does not replace `try/catch`.

That separation should remain crisp:

- branch choice is a normal control event
- faults are normalized into protocol failures
- `distributed-try-catch.md` defines what happens when something fails

### 8.2 Fault while deciding

If the deciding role faults while:

- evaluating an expression guard
- waiting for candidate messages
- committing the decision

then normal protocol fault handling applies:

- inside `try`, control passes through the centralized try/catch model
- outside `try`, the run fails under normal runtime semantics

This RFC does not define a special recovery path for a half-decided `alt`.

### 8.3 Cancellation wins over speculative branching

If the enclosing protocol process is already cancelling:

- no new branch should be treated as a normal committed branch decision
- follower roles should not continue on stale speculative assumptions

This follows the current cancellation model in `../current/03-runtime-core.md`, where cancellation is coordinated by the home RC / protocol supervisor.

### 8.4 RC death and adoption

The process model explicitly says:

- `$ctx` is not checkpointed
- RoleRun continuation state is not checkpointed
- adoption provides narrow re-resolve/rebind or conservative fail/cancel

So this RFC should **not** claim:

- exact resume of an in-flight undecided `alt`
- durable replay of a not-yet-committed local branch decision

V1 safe rule:

- once an `AltDecision` is committed, followers observe that commitment normally
- if home RC death occurs before a durable branch commitment exists, adoption may conservatively fail/cancel or reevaluate only if runtime state still makes that legal

That preserves consistency with the process model instead of inventing hidden guarantees.

---

## 9. Why this matters for formalization

Without an explicit decision maker, expression-based `alt` is not projection-friendly:

- there is no canonical owner of the predicate
- other roles cannot know why a branch was chosen
- distributed determinism depends on undocumented assumptions

With `alt at <role>`:

- branch ownership is explicit
- projection can treat the deciding role as the branch source
- other roles become followers reacting to committed branch choice

This is why backlog `F2` is both a practical feature and a formal prerequisite.

---

## 10. Examples

### 10.1 Approval flow

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

Why this is better:

- the reader knows who evaluates the predicate
- the runtime knows who owns branch commitment
- later projection/debug tooling has one canonical branch source

### 10.2 Message wait

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

### 10.3 Gather-time branching

This RFC also clarifies later designs such as scatter/gather:

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

The gather owner does not become a hidden branch chooser.
The explicit `alt at coordinator` still owns the decision.

---

## 11. Compatibility and migration

### 11.1 Short-term

The compiler may temporarily allow omitted `at <role>` when it can infer a unique decision maker:

- message-based `alt` where all candidate branches target the same receiver
- expression-based `alt` only in narrow cases where the active role is obvious

But that inference should be treated as migration help, not normative semantics.

### 11.2 Long-term

The intended long-term language surface should require explicit `at <role>`.

This is preferable to magical inference because:

- it survives refactors
- it is easier to explain
- it is easier to project and verify
- it maps cleanly onto the process-model notion of one control owner

---

## 12. Runtime and language impact

### 12.1 Parser / IR

The IR should carry something like:

```ts
interface AltIR {
  id: string;
  decisionRole: string;
  branches: AltBranchIR[];
}
```

At the language level this implies:

- parser support for `alt at <role>`
- validator checks that the named role can actually observe/evaluate the branch condition
- decompiler support for preserving explicit `at <role>`

### 12.2 Runtime

The runtime needs:

- one explicit deciding role
- branch-commit events
- follower roles blocking until branch commitment
- branch commitment represented as protocol control state, not as guessed local behavior

### 12.3 Tests

Add or refresh tests for:

- expression-based `alt at <role>`
- message-based `alt at <role>`
- timeout branch with explicit decision maker
- invalid `alt at <role>` when the role cannot observe/evaluate the branch condition
- migration diagnostics for omitted decision maker
- interaction with cancellation/failure so branch choice is not treated as independent local speculation

---

## 13. Relationship to other docs

| Document | Relationship |
|---|---|
| `../current/02-lang-spec.md` | Current `alt` syntax exists there but should evolve toward explicit `at <role>`. |
| `../current/03-runtime-core.md` | Process model foundation: protocol supervisor, cancellation, fault propagation, adoption, and runtime ownership vocabulary used by this RFC. |
| `../future/backlog.md` | Tracked this as both `L2` and `F2` before implementation. |
| `../current/09-e2e-usecases.md` | Several current use cases rely on expression-based `alt`; this RFC clarifies who decides those branches. |
| `../future/distributed-try-catch.md` | Try/catch remains separate. `alt` branch choice is not failure handling, but both rely on centralized control-path semantics. |
| `../future/scatter-gather-semantics.md` | Scatter/gather should reuse the same one-owner branch/merge control vocabulary. |

---

## 14. Recommended first implementation boundary

Keep the first implementation narrow:

- add `at <role>` syntax
- support it for both expression-based and message-based `alt`
- make branch commitment explicit in runtime/debug traces
- treat omitted `at <role>` as migration-only compatibility

That is enough to make the model significantly clearer without redesigning the rest of control flow.
