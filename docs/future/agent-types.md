# Agent Types

Status: RFC draft | Date: 2026-03-13

---

## 1. Motivation

Reagent currently overloads the participant language tag:

- it names the syntax of agent zones
- it implies the kind of executable subject behind the role
- it leaks runtime-host assumptions into the core language surface

This was acceptable while the language was mostly `ts`/`py` managed execution, but it breaks down as the runtime grows:

- prompt/instruction-driven workers are real participants, not an accidental variant of `[ts]`
- wire-only participants exist and already use `[*]` as a partial escape hatch
- `agent Name runs Role` mixes protocol language with runtime instance inventory
- `resolve` and `spawn` already provide the real semantics for runtime materialization

The result is a language surface that is too narrow semantically and too concrete operationally.

We need a first-class construct that describes **what kind of zone-bearing subject a participant is**, without baking concrete runtime hosting into the language.

---

## 2. Goals

- Replace bracket language tags with first-class `agent type` declarations.
- Make `language` a property of `agent type`, not of participant syntax.
- Remove `agent ... runs ...` from the core language.
- Treat runtime instances as platform state materialized through `resolve` and `spawn`.
- Allow `role` and `participant` to be parameterized by `agent type`.
- Create a path for nominal `agent type` polymorphism.

## 3. Non-goals

- This RFC does not define controller-executed zones.
- This RFC does not define concrete runtime host config such as Docker images, SDK names, URLs, or credentials.
- This RFC does not immediately replace the runtime registry's internal `agent` terminology.
- This RFC does not redesign glue-code-heavy protocol patterns beyond identifying migration targets.

---

## 4. Core model

### 4.1 `agent type` is a language construct

`agent type` becomes a top-level declaration alongside `message`, `protocol`, and `role`.

Its job is to describe the **semantic execution surface** of participant zones:

- which `language` zone bodies use
- whether zones are allowed at all
- which bindings exist in those zones
- whether async zone execution is legal
- which zone forms are valid for that type

It does **not** say:

- which runtime host launches the participant
- whether the participant is backed by MCP, a wrapper host, or a managed executor
- where configuration comes from
- which concrete runtime instances exist

### 4.2 `language` is a property, not the type itself

`ts` and `py` are no longer first-class participant tags.

They become values of `language` inside `agent type`.

Examples:

- `language: ts`
- `language: py`
- `language: instruction`
- `language: none`

### 4.3 Runtime materialization is separate

Concrete runtime instances are outside the core DSL.

The language describes:

- `role`
- `agent type`
- `participant`
- `resolve`
- `spawn`

The platform/runtime owns:

- runtime registry / presence
- instance metadata
- instance liveness
- actual binding of roles to runtime identities

That means `agent ... runs ...` disappears from the core language.

---

## 5. Recommended language shape

### 5.1 Recommended binding model

This RFC recommends a **dual model**:

- `role` carries an `agent type` constraint
- `participant` chooses a concrete `agent type`

Why this model:

- it preserves role reuse
- it leaves space for polymorphism
- it makes compatibility explicit
- it avoids hard-coding one concrete type into every role definition

This is stronger than keeping `agent type` only on `role`, and more reusable than forcing `participant` to carry all semantics alone.

### 5.2 Sketch: `agent type`

Illustrative surface sketch:

```rg
agent type ManagedTs {
  language: ts
  zones: agent
  bindings: [$ctx, $self, reagent, $agent]
  async: allowed
}

agent type ManagedPy {
  language: py
  zones: agent
  bindings: [$ctx, $self, reagent, $agent]
  async: allowed
}

agent type InstructionWorker {
  language: instruction
  zones: agent
  bindings: [$ctx, $self, reagent]
  async: allowed
}

agent type WireParticipant {
  language: none
  zones: none
  bindings: []
  async: forbidden
}
```

Notes:

- `bindings` is semantic surface, not runtime config
- `$agent` is optional by type, but actual availability may still depend on runtime materialization
- `WireParticipant` replaces the current wildcard language-tag escape hatch as the explicit no-zone case

### 5.3 Sketch: `role`

Illustrative role shape with a constrained type parameter:

```rg
role WorkerRole<T: InstructionWorker> {
  plays TaskDelegation as worker
}

role SellerRole<T: ManagedTs> {
  plays Auction as seller
}
```

The exact generic syntax is still open, but the semantics are:

- a role may constrain the family of acceptable `agent type`s
- a role should not need to name concrete runtime instances
- role legality is checked against the chosen participant type

### 5.4 Sketch: `participant`

Recommended participant model:

```rg
protocol TaskDelegation {
  participants:
    human: HumanRole with ManagedTs initiator,
    worker: WorkerRole with InstructionWorker
}
```

Semantics:

- `participant` chooses the concrete `agent type`
- compiler checks that the chosen type satisfies the role constraint
- zone legality and zone `language` are derived from the participant's concrete type

This is the key place where abstract role requirements become concrete protocol semantics.

---

## 6. Minimal semantics of `agent type`

For every `agent type`, the language must define:

- whether standalone agent zones are legal
- whether inline hook zones (`onSend`, `onReceive`) are legal
- the `language` of zone bodies
- the available bindings
- whether async zones are legal
- whether `$agent` may exist semantically

Recommended first-version matrix:

| Agent type | Language | Zones | Bindings | Notes |
|---|---|---|---|---|
| `ManagedTs` | `ts` | allowed | `$ctx`, `$self`, `reagent`, optional `$agent` | TS managed/reference path |
| `ManagedPy` | `py` | allowed | `$ctx`, `$self`, `reagent`, optional `$agent` | Python managed/reference path |
| `InstructionWorker` | `instruction` | allowed | `$ctx`, `$self`, `reagent` | instruction/prompt-oriented zones |
| `WireParticipant` | `none` | forbidden | none | participates in choreography only |
| `CustomCompatible` | type-defined | constrained | type-defined | reserved family for runtime-backed specializations |

Important rule:

- `agent type` does not encode executor/host selection

Runtime host compatibility is checked outside the core language, using runtime metadata and registry/deploy rules.

---

## 7. Removing `agent ... runs ...`

Current surface:

```rg
agent HumanAgent runs HumanRole
agent WorkerAgent runs WorkerRole
```

This construct should be removed from the core DSL.

Rationale:

- it declares concrete runtime instances in the language
- it duplicates runtime materialization concerns already handled by `resolve` and `spawn`
- it confuses protocol semantics with deployment inventory

After removal:

- static participants are materialized by trigger-time `resolve`
- dynamic participants are materialized by `spawn` or runtime-side resolution paths
- runtime registry/presence becomes the source of candidate instances

The language no longer answers "which instances exist?".
It answers only:

- which participants a protocol needs
- which role they play
- which `agent type` they require
- how they are bound or spawned

---

## 8. Polymorphism

### 8.1 Why polymorphism matters

Once `agent type` becomes a first-class language concept, roles quickly want abstraction.

Examples:

- a role may require "any instruction-capable worker"
- a role may allow multiple code-bearing managed types
- a participant may specialize a broader requirement with a concrete runtime-compatible type

### 8.2 Recommended first version

Use **nominal**, not structural, polymorphism.

Recommended shape:

```rg
agent type InstructionWorker {
  language: instruction
  zones: agent
  bindings: [$ctx, $self, reagent]
}

agent type ClaudeWorker extends InstructionWorker
agent type CursorWorker extends InstructionWorker
```

Why nominal first:

- simpler compiler rules
- easier LSP and diagnostics
- more stable migration path
- avoids turning the type system into implicit config matching

### 8.3 Compatibility checks

Compatibility should be checked at three points:

1. when a role declares its `agent type` constraint
2. when a participant chooses a concrete `agent type`
3. when runtime materialization resolves/spawns an instance whose registration claims a concrete type

### 8.4 What first version should avoid

Do not start with:

- structural matching on binding sets
- implicit subtyping based on `language`
- config-driven type compatibility
- user-defined trait algebra

Those can come later if nominal inheritance proves too weak.

---

## 9. Runtime impact

This RFC is language-first, but it has clear runtime consequences.

### 9.1 Parser / AST / compiler

Compiler-facing additions:

- top-level `AgentTypeDecl`
- role-level type parameter / constraint support
- participant-level concrete `agent type` references
- deprecation path for bracket language tags
- deprecation path for `agent ... runs ...`

IR-facing additions:

- participant metadata must carry `agentTypeRef`
- role metadata must carry type constraints
- zone metadata must derive `language` from resolved `agent type`

### 9.2 Runtime core

Current runtime coupling:

- `ReagentController` chooses `BehaviorFactory` backends from language-tag keyed maps in `runtime/ts/src/controller/reagent-controller.ts`
- runtime examples and docs still assume role/agent declarations carry the language surface directly

Future direction:

- runtime instance registrations should carry concrete `agent type` metadata
- host/runtime compatibility should be checked against that type metadata
- role binding and trigger resolution should operate on participants whose required type is known

This does **not** require `agent type` to contain executor config.
It only requires runtime registrations to expose a type identity that the compiler/runtime can compare.

### 9.3 Resolve and spawn

`resolve` and `spawn` become even more central:

- `resolve` binds a participant to compatible runtime instances
- `spawn` creates runtime instances that satisfy the participant's type requirement

The resolve/spawn layer must therefore understand:

- the participant's required concrete `agent type`
- the role's type constraint
- the runtime instance's registered concrete type

### 9.4 Tests and tooling

The following surfaces need targeted updates once implementation starts:

- `lang/test/` for parser, validator, deprecation, and compatibility rules
- `runtime/tests/` and `runtime/ts/test/` for materialization and compatibility behavior
- `tools/reagent-vscode/server/test/` for parsing, symbols, hover, completion, diagnostics
- TextMate grammar for `agent type` declarations and participant syntax

---

## 10. Migration sketches

These are illustrative rewrites for the new model.
They are not current syntax.

### 10.1 Task Delegation

Current shape:

- participants carry `[ts]`
- roles carry `[ts]`
- concrete instances are declared via `agent ... runs ...`

Migration sketch:

```rg
agent type HumanInteractive {
  language: ts
  zones: agent
  bindings: [$ctx, $self, reagent, $agent]
  async: allowed
}

agent type InstructionWorker {
  language: instruction
  zones: agent
  bindings: [$ctx, $self, reagent]
  async: allowed
}

role HumanRole<T: HumanInteractive> {
  plays TaskDelegation as human
}

role WorkerRole<T: InstructionWorker> {
  plays TaskDelegation as worker
}

protocol TaskDelegation {
  participants:
    human: HumanRole with HumanInteractive initiator,
    worker: WorkerRole with InstructionWorker

  trigger on invoke with TaskRequest {
    resolve human = single
    resolve worker = single
  }
}
```

Key semantic shift:

- no concrete instance declarations in the DSL
- human/worker instances come from runtime registry plus `resolve`
- worker zones are typed as instruction-bearing, not "just ts"

### 10.2 Auction

Current shape:

- participants and roles both carry `[ts]`
- `buyer` uses dynamic-many semantics
- concrete seller/buyers are declared explicitly at the bottom of the file
- multiple zones mostly move values between `$ctx`, `$ctx.msg`, and `$self`

Migration sketch:

```rg
agent type ManagedTs {
  language: ts
  zones: agent
  bindings: [$ctx, $self, reagent, $agent]
  async: allowed
}

role SellerRole<T: ManagedTs> {
  plays Auction as seller
}

role BuyerRole<T: ManagedTs> {
  plays Auction as buyer
}

protocol Auction {
  participants:
    seller: SellerRole with ManagedTs initiator,
    buyer: BuyerRole with ManagedTs dynamic many

  trigger on invoke with AuctionStart {
    resolve seller = single
  }
}
```

Key semantic shift:

- seller and buyers are materialized by `resolve` / `spawn`, not file-local `agent` declarations
- glue-code-heavy zones are now easier to identify as candidates for future declarative constructs
- the protocol keeps behavior zones, but instance inventory leaves the core DSL

---

## 11. Spec delta sketch

This RFC implies the following eventual delta to `docs/current/02-lang-spec.md`:

- add top-level `agent type` declaration
- replace participant bracket tags with `agent type` references
- allow roles to constrain acceptable `agent type`s
- define participant specialization of concrete `agent type`s
- remove `agent ... runs ...` from the core syntax
- deprecate `[ts]`, `[py]`, `[kt]`, `[*]` as first-class participant syntax

---

## 12. Open questions

- What is the cleanest surface syntax for role constraints and participant specialization?
- Should roles be generic over `agent type`, or should they declare compatibility in a lighter form?
- How much of `$agent` availability is semantic, and how much remains runtime-materialization detail?
- Should `WireParticipant` be a normal `agent type` or a reserved built-in?
- When runtime registrations expose concrete `agent type`, where should that identity live in deployment/manifests?

---

## 13. Recommended next step

Use this RFC as the semantic anchor for follow-up work:

1. align `resolve-policy.md` with the removal of `agent ... runs ...`
2. choose one concrete surface syntax for role/participant parameterization
3. only then prepare compiler/runtime implementation work
