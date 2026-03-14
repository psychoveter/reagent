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
- browser-based human users, mobile clients, and external services are real participants with distinct interaction contracts
- `agent Name runs Role` mixes protocol language with runtime instance inventory
- `resolve` and `spawn` already provide the real semantics for runtime materialization

The result is a language surface that is too narrow semantically and too concrete operationally.

We need a first-class construct that describes **what kind of zone-bearing subject a participant is**, **what it can consume and produce**, and **how the protocol infrastructure should adapt communication between heterogeneous participants** — without baking concrete runtime hosting into the language.

---

## 2. Goals

- Replace bracket language tags with first-class `agent type` declarations.
- Make `language` a property of `agent type`, not of participant syntax.
- Remove `agent ... runs ...` from the core language.
- Treat runtime instances as platform state materialized through `resolve` and `spawn`.
- Allow `role` and `participant` to be parameterized by `agent type`.
- Create a path for nominal `agent type` polymorphism.
- Define **capabilities** (consume/produce) as a first-class property of `agent type`, enabling content negotiation and target-aware communication.
- Support **consumer agent types** (human users in browsers, mobile apps, IDEs) as explicit protocol participants.
- Support **instruct agent types** with prompt injection driven by type-level templates.

## 3. Non-goals

- This RFC does not define controller-executed zones.
- This RFC does not define concrete runtime host config such as Docker images, SDK names, URLs, or credentials.
- This RFC does not immediately replace the runtime registry's internal `agent` terminology.
- This RFC does not redesign glue-code-heavy protocol patterns beyond identifying migration targets.
- This RFC does not define the rendering/presentation layer for consumer agent types — only the semantic contracts that enable it.

---

## 4. Core model

### 4.1 `agent type` is a language construct

`agent type` becomes a top-level declaration alongside `message`, `protocol`, and `role`.

Its job is to describe the **semantic execution surface** and **communication contract** of a participant:

- which `language` zone bodies use
- whether zones are allowed at all
- which bindings exist in those zones
- whether async zone execution is legal
- which zone forms are valid for that type
- what the participant can **consume** (accept as incoming content)
- what the participant can **produce** (generate as outgoing content or responses)

It does **not** say:

- which runtime host launches the participant
- whether the participant is backed by MCP, a wrapper host, or a managed executor
- where configuration comes from
- which concrete runtime instances exist
- how content is rendered (that is the host's job, guided by the type contract)

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

### 4.4 Capabilities: consume and produce

Every `agent type` declares **capabilities** — what the participant can accept and what it can generate. This is inspired by FIPA ACL's separation of content language and performative, but integrated into the type system rather than stamped on every message.

#### Why capabilities belong on the type

In a heterogeneous protocol, the sender needs to know how to format a message for the receiver. The receiver needs to know what response forms are available. Today this is implicit: a `[ts]` participant gets a JSON payload, a human behind MCP gets whatever the MCP host renders. Capabilities make this contract **explicit and type-checked**.

#### Consume and produce

Capabilities are split into two groups:

- **`consume`** — content formats and interaction forms the participant can accept as input.
- **`produce`** — content formats and interaction forms the participant can generate as output.

Both groups use the same vocabulary. A capability can be:

- A **content format**: `html`, `markdown`, `plaintext`, `json`, `code`, `structured_report`
- An **interaction form**: `text { format: ... }`, `choice { options: ... }`, `file { accepts: ... }`, `code_edit`, `approval { labels: ... }`

Content formats and interaction forms are not separate axes — they are all capabilities. `html` in `consume` means "I can receive HTML content". `choice` in `produce` means "I can generate a selection from options". An `approval` interaction form on a `WebUser` is rendered as HTML buttons; on a `CursorUser` it becomes an MCP tool call. The capability is the same; the host adapts the rendering.

#### Content negotiation

When the runtime processes a message step `A --> B: Msg`, it performs content negotiation:

1. Take `A.capabilities.produce` ∩ `B.capabilities.consume` — the set of mutually understood formats.
2. Select the richest compatible format (preference order is type-defined or runtime-configured).
3. Make the negotiated format available to the sender's zone as `$ctx.target.contentFormat`.
4. If the protocol expects a response (`B --> A` follows), also resolve `B.capabilities.produce` ∩ `A.capabilities.consume` for the return path.

This is analogous to HTTP content negotiation (Accept/Content-Type) but driven by type metadata rather than per-request headers.

#### Locale

Consumer types may declare `locale: runtime` to indicate that the participant is locale-aware. The concrete locale is resolved at runtime (from instance metadata or user preferences) and made available to senders as `$ctx.target.locale`. Instruct-type senders can use this to generate localized content.

#### `expect_produce` on message steps

A message step may declare what capability it expects from the receiver's next response:

```rg
analyst --> human: ReviewPackage = {
  expect_produce: choice { options: [approve, reject, revise] }
}
```

The compiler checks that `human`'s type includes `choice` in `capabilities.produce`. The runtime passes the concrete options to the receiver's host for rendering.

This is optional — most message steps do not constrain the response form. It is useful for approval gates, structured input collection, and form-like interactions.

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

#### Managed code types

```rg
agent type ManagedTs {
  language: ts
  zones: agent
  bindings: [$ctx, $self, reagent, $agent]
  async: allowed

  capabilities: {
    consume: [json, plaintext]
    produce: [json, markdown, html, plaintext]
  }
}

agent type ManagedPy {
  language: py
  zones: agent
  bindings: [$ctx, $self, reagent, $agent]
  async: allowed

  capabilities: {
    consume: [json, plaintext]
    produce: [json, markdown, plaintext]
  }
}
```

#### Instruction/prompt-driven types

```rg
agent type InstructionWorker {
  language: instruction
  zones: agent
  bindings: [$ctx, $self, reagent]
  async: allowed

  capabilities: {
    consume: [markdown, json, plaintext, code]
    produce: [markdown, json, html, plaintext, structured_report]
  }
}
```

Instruct types may also declare **prompt templates** — see §5.5.

#### Consumer types (human participants)

```rg
agent type WebUser {
  language: none
  zones: none

  capabilities: {
    consume: [html, markdown, plaintext]
    produce: [
      text { format: plaintext | markdown },
      choice { options: declared_per_step },
      file { accepts: [image/*, application/pdf], max_size: 10mb }
    ]
    locale: runtime
  }
}

agent type CursorUser {
  language: none
  zones: none

  capabilities: {
    consume: [markdown, plaintext, mcp_tool_call]
    produce: [
      text { format: plaintext | markdown },
      choice { options: declared_per_step },
      code_edit,
      file_read
    ]
  }
}

agent type MobileUser extends WebUser {
  capabilities: {
    consume: [markdown, plaintext, push_card]
    produce: [
      text { format: plaintext },
      choice { options: declared_per_step }
    ]
  }
}
```

#### Wire-only types

```rg
agent type WireParticipant {
  language: none
  zones: none

  capabilities: {
    consume: [json]
    produce: [json]
  }
}
```

Notes:

- `bindings` is semantic surface, not runtime config
- `$agent` is optional by type, but actual availability may still depend on runtime materialization
- `WireParticipant` replaces the current wildcard language-tag escape hatch as the explicit no-zone case
- Consumer types have no zones — they participate through their host's rendering/input layer
- `capabilities` on consumer types inform senders how to format content and what responses to expect

### 5.3 Sketch: `role`

Illustrative role shape with a constrained type parameter:

```rg
role WorkerRole<T: InstructionWorker> {
  plays TaskDelegation as worker
}

role SellerRole<T: ManagedTs> {
  plays Auction as seller
}

role HumanRole<T: WebUser> {
  plays FeatureDevelopment as human
}
```

The exact generic syntax is still open, but the semantics are:

- a role may constrain the family of acceptable `agent type`s
- a role should not need to name concrete runtime instances
- role legality is checked against the chosen participant type

### 5.4 Sketch: `participant` with content negotiation

Recommended participant model:

```rg
protocol FeatureReview {
  participants:
    analyst: AnalystRole with Analyst initiator,
    human: HumanRole with WebUser

  trigger on invoke with ReviewRequest {
    resolve analyst = single
    resolve human = single
  }

  analyst {
    // zone produces the review content
    // $ctx.target is populated by the runtime from the next step's receiver type:
    //   $ctx.target.contentFormat = "html"  (negotiated)
    //   $ctx.target.locale = "ru"           (from WebUser instance)
    //   $ctx.target.produce = ["text", "choice"]
  }

  analyst --> human: ReviewPackage = {
    expect_produce: choice { options: [approve, reject, revise] }
  }

  human --> analyst: ReviewDecision
}
```

Semantics:

- `participant` chooses the concrete `agent type`
- compiler checks that the chosen type satisfies the role constraint
- zone legality and zone `language` are derived from the participant's concrete type
- content negotiation is derived from the sender's and receiver's `capabilities`
- `expect_produce` is checked against the receiver's `capabilities.produce`

This is the key place where abstract role requirements become concrete protocol semantics.

### 5.5 Instruct types: prompt templates

Instruct agent types may declare **prompt templates** that the runtime injects around zone bodies. This separates the agent's identity/behavior (type-level) from the task (zone-level).

#### `prompt_preamble`

A type-invariant system prompt, injected for every zone execution of this type:

```rg
agent type Critic extends InstructionWorker {
  prompt_preamble: """
    You are a critical reviewer. You find flaws,
    inconsistencies, and improvement opportunities.
    Be specific and constructive. Cite exact evidence.
  """
}
```

#### `prompt_zone_wrapper`

A template that wraps each zone body. The runtime substitutes:

- `{{preamble}}` — the resolved `prompt_preamble` (including inherited)
- `{{$ctx}}`, `{{$self}}` — serialized context and persistent state
- `{{zone_body}}` — the raw text from the `.rg` zone
- `{{target.*}}` — receiver type metadata when the zone precedes a message step

```rg
agent type Analyst extends InstructionWorker {
  prompt_preamble: """
    You are a structured analyst. You produce clear,
    well-organized analysis with citations.
  """

  prompt_zone_wrapper: """
    {{preamble}}

    Context: {{$ctx}}
    Persistent memory: {{$self}}

    {{#if target}}
    Your response will be delivered to: {{target.type}}
    Format: {{target.contentFormat}}
    {{#if target.locale}}Respond in: {{target.locale}}{{/if}}
    {{#if target.produce}}Recipient can: {{target.produce}}{{/if}}
    {{/if}}

    Task:
    {{zone_body}}
  """

  capabilities: {
    consume: [markdown, json, plaintext, code]
    produce: [markdown, html, json, structured_report]
  }
}
```

When `analyst` prepares a `ReviewPackage` for `human: WebUser(locale=ru)`, the runtime renders the wrapper with:

```
Your response will be delivered to: WebUser
Format: html
Respond in: ru
Recipient can: text, choice {options: [approve, reject, revise]}
```

When the same `analyst` sends to another `developer: CodeAnalyst`, the wrapper renders:

```
Your response will be delivered to: CodeAnalyst
Format: json
Recipient can: text, json, code
```

The zone body itself stays the same — the adaptation is automatic.

#### Inheritance of prompt templates

Prompt templates follow nominal inheritance:

- A subtype inherits `prompt_preamble` and `prompt_zone_wrapper` from its parent.
- A subtype may override either template.
- If overriding `prompt_preamble`, the subtype can reference `{{super.preamble}}` to compose with the parent's text.

```rg
agent type ClaudeAnalyst extends Analyst {
  prompt_preamble: """
    {{super.preamble}}
    You use Claude as your reasoning engine.
    Prefer structured output with explicit chain-of-thought.
  """
}
```

---

## 6. Minimal semantics of `agent type`

For every `agent type`, the language must define:

- whether standalone agent zones are legal
- whether inline hook zones (`onSend`, `onReceive`) are legal
- the `language` of zone bodies
- the available bindings
- whether async zones are legal
- whether `$agent` may exist semantically
- what the type can **consume** and **produce** (capabilities)
- whether prompt templates exist (instruct types)

Recommended first-version matrix:

| Agent type | Language | Zones | Bindings | Consume | Produce | Notes |
|---|---|---|---|---|---|---|
| `ManagedTs` | `ts` | allowed | `$ctx`, `$self`, `reagent`, optional `$agent` | json, plaintext | json, markdown, html, plaintext | TS managed/reference path |
| `ManagedPy` | `py` | allowed | `$ctx`, `$self`, `reagent`, optional `$agent` | json, plaintext | json, markdown, plaintext | Python managed/reference path |
| `InstructionWorker` | `instruction` | allowed | `$ctx`, `$self`, `reagent` | markdown, json, plaintext, code | markdown, json, html, plaintext, structured_report | instruction/prompt-oriented zones |
| `WebUser` | `none` | forbidden | none | html, markdown, plaintext | text, choice, file | human in browser |
| `CursorUser` | `none` | forbidden | none | markdown, plaintext, mcp_tool_call | text, choice, code_edit, file_read | human in Cursor IDE |
| `MobileUser` | `none` | forbidden | none | markdown, plaintext, push_card | text, choice | human on mobile device |
| `WireParticipant` | `none` | forbidden | none | json | json | choreography-only, no zones |
| `CustomCompatible` | type-defined | constrained | type-defined | type-defined | type-defined | reserved family for runtime-backed specializations |

Important rules:

- `agent type` does not encode executor/host selection
- capabilities are semantic contracts — the host is responsible for actual rendering/parsing
- content negotiation is performed by the runtime at message step boundaries

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
- what capabilities they need
- how they are bound or spawned

---

## 8. Polymorphism

### 8.1 Why polymorphism matters

Once `agent type` becomes a first-class language concept, roles quickly want abstraction.

Examples:

- a role may require "any instruction-capable worker"
- a role may allow multiple code-bearing managed types
- a participant may specialize a broader requirement with a concrete runtime-compatible type
- a role may require "any consumer that supports approval" — `WebUser`, `CursorUser`, and `MobileUser` all qualify

### 8.2 Recommended first version

Use **nominal**, not structural, polymorphism.

Recommended shape:

```rg
agent type InstructionWorker {
  language: instruction
  zones: agent
  bindings: [$ctx, $self, reagent]
  capabilities: {
    consume: [markdown, json, plaintext, code]
    produce: [markdown, json, html, plaintext, structured_report]
  }
}

agent type ClaudeWorker extends InstructionWorker
agent type CursorWorker extends InstructionWorker

agent type WebUser {
  language: none
  zones: none
  capabilities: {
    consume: [html, markdown, plaintext]
    produce: [text, choice, file]
    locale: runtime
  }
}

agent type MobileUser extends WebUser {
  capabilities: {
    consume: [markdown, plaintext, push_card]
    produce: [text, choice]
  }
}
```

Why nominal first:

- simpler compiler rules
- easier LSP and diagnostics
- more stable migration path
- avoids turning the type system into implicit config matching

Capabilities are inherited by default and can be narrowed by subtypes. A `MobileUser` inherits `WebUser` semantics but narrows `consume` (no `html`) and `produce` (no `file`). The compiler can verify that narrowing does not break role constraints: if a role requires `choice` in `produce`, both `WebUser` and `MobileUser` satisfy it.

### 8.3 Compatibility checks

Compatibility should be checked at three points:

1. when a role declares its `agent type` constraint
2. when a participant chooses a concrete `agent type`
3. when runtime materialization resolves/spawns an instance whose registration claims a concrete type

With capabilities, a fourth check becomes possible:

4. when a message step declares `expect_produce`, the compiler verifies the receiver's type includes the required capability in `produce`

### 8.4 What first version should avoid

Do not start with:

- structural matching on binding sets
- implicit subtyping based on `language`
- config-driven type compatibility
- user-defined trait algebra
- structural matching on capability sets (use nominal inheritance for now)

Those can come later if nominal inheritance proves too weak.

---

## 9. Runtime impact

This RFC is language-first, but it has clear runtime consequences.

### 9.1 Parser / AST / compiler

Compiler-facing additions:

- top-level `AgentTypeDecl` with `capabilities` block
- role-level type parameter / constraint support
- participant-level concrete `agent type` references
- `expect_produce` on message step props
- `prompt_preamble` and `prompt_zone_wrapper` on instruct types
- deprecation path for bracket language tags
- deprecation path for `agent ... runs ...`

IR-facing additions:

- participant metadata must carry `agentTypeRef`
- role metadata must carry type constraints
- zone metadata must derive `language` from resolved `agent type`
- message step metadata must carry negotiated `contentFormat` and `expect_produce`
- instruct-type zone metadata must carry resolved prompt templates

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

### 9.3 Content negotiation in the runtime

The runtime performs content negotiation at each message step:

1. Resolve sender's `capabilities.produce` and receiver's `capabilities.consume`.
2. Compute intersection and select preferred format.
3. Populate `$ctx.target` on the sender's side before the zone executes:
   - `$ctx.target.contentFormat` — the negotiated format
   - `$ctx.target.locale` — the receiver's locale (if `locale: runtime`)
   - `$ctx.target.produce` — the receiver's produce capabilities (for response awareness)
   - `$ctx.target.type` — the receiver's agent type name
4. For instruct types: render the `prompt_zone_wrapper` template with `target.*` variables before passing to the LLM backend.
5. For consumer types: the host uses `contentFormat` to choose rendering strategy (iframe, push card, MCP tool call, etc.).

This is a runtime-only concern — the compiler only validates that negotiation is possible (non-empty intersection). The actual format selection, rendering, and delivery are host responsibilities.

### 9.4 Resolve and spawn

`resolve` and `spawn` become even more central:

- `resolve` binds a participant to compatible runtime instances
- `spawn` creates runtime instances that satisfy the participant's type requirement

The resolve/spawn layer must therefore understand:

- the participant's required concrete `agent type`
- the role's type constraint
- the runtime instance's registered concrete type

### 9.5 MessageEnvelope extensions

The `MessageEnvelope` gains optional fields derived from content negotiation:

```
MessageEnvelope {
  ...existing fields...

  contentFormat?: string        // negotiated format: "html", "json", "markdown", etc.
  expectedProduce?: string      // what response form is expected: "choice", "text", etc.
  locale?: string               // receiver's locale: "ru", "en", etc.
}
```

These fields are optional and backward-compatible. Hosts that understand them use them for rendering; hosts that don't ignore them and fall back to raw payload handling.

### 9.6 Tests and tooling

The following surfaces need targeted updates once implementation starts:

- `lang/test/` for parser, validator, deprecation, compatibility rules, and capabilities validation
- `runtime/ts/test/` for materialization, compatibility behavior, and content negotiation
- `tools/reagent-vscode/server/test/` for parsing, symbols, hover, completion, diagnostics
- TextMate grammar for `agent type` declarations, `capabilities` blocks, and participant syntax

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
agent type CursorUser {
  language: none
  zones: none
  capabilities: {
    consume: [markdown, plaintext, mcp_tool_call]
    produce: [text, choice, code_edit]
  }
}

agent type Analyst extends InstructionWorker {
  prompt_preamble: """
    You are an analyst. You decompose tasks,
    identify requirements, and produce structured plans.
  """
  capabilities: {
    consume: [markdown, json, plaintext, code]
    produce: [markdown, json, html, structured_report]
  }
}

role HumanRole<T: CursorUser> {
  plays TaskDelegation as human
}

role WorkerRole<T: InstructionWorker> {
  plays TaskDelegation as worker
}

protocol TaskDelegation {
  participants:
    human: HumanRole with CursorUser initiator,
    worker: WorkerRole with Analyst

  trigger on invoke with TaskRequest {
    resolve human = single
    resolve worker = single
  }

  human --> worker: TaskRequest

  worker {
    // $ctx.target.contentFormat = "markdown" (negotiated with CursorUser)
    // $ctx.target.produce = ["text", "choice", "code_edit"]
    // zone body: analyze the task, prepare response
  }

  worker --> human: TaskResult = {
    expect_produce: choice { options: [accept, revise, reject] }
  }

  human --> worker: TaskDecision
}
```

Key semantic shifts:

- no concrete instance declarations in the DSL
- human is explicitly typed as `CursorUser`, not a fake `[ts]` participant
- worker zones get `$ctx.target` with negotiated format and receiver capabilities
- `expect_produce` enforces that the human can respond with a choice
- worker's prompt template adapts output format to the receiver's type

### 10.2 Feature Development with WebUser

A web-based human reviewer instead of a Cursor user:

```rg
agent type WebUser {
  language: none
  zones: none
  capabilities: {
    consume: [html, markdown, plaintext]
    produce: [text, choice, file]
    locale: runtime
  }
}

agent type Critic extends InstructionWorker {
  prompt_preamble: """
    You are a critical reviewer. You find flaws,
    inconsistencies, and improvement opportunities.
    Be specific and constructive. Cite exact evidence.
  """

  prompt_zone_wrapper: """
    {{preamble}}

    Context: {{$ctx}}
    Persistent memory: {{$self}}

    {{#if target}}
    Deliver as: {{target.contentFormat}}
    {{#if target.locale}}Language: {{target.locale}}{{/if}}
    {{#if target.produce}}Recipient can: {{target.produce}}{{/if}}
    {{/if}}

    Task:
    {{zone_body}}
  """
}

protocol DesignReview {
  participants:
    critic: CriticRole with Critic initiator,
    human: ReviewerRole with WebUser

  trigger on invoke with ReviewRequest {
    resolve critic = single
    resolve human = single
  }

  critic {
    // $ctx.target.contentFormat = "html" (negotiated: critic produces html, WebUser consumes html)
    // $ctx.target.locale = "ru" (from WebUser instance metadata)
    // $ctx.target.produce = ["text", "choice", "file"]
    //
    // prompt_zone_wrapper injects:
    //   "Deliver as: html"
    //   "Language: ru"
    //   "Recipient can: text, choice, file"
    //
    // critic generates an HTML review page with interactive elements
  }

  critic --> human: ReviewPackage = {
    expect_produce: choice { options: [approve, reject, revise] }
  }

  human --> critic: ReviewDecision
}
```

Key semantic shifts:

- `WebUser` is a first-class participant type with explicit capabilities
- content negotiation produces `html` because it is the richest mutual format
- locale is injected into the prompt template — critic generates Russian text
- the HTML review page can include interactive buttons for the `choice` affordance
- the same protocol works with `MobileUser` — negotiation would produce `markdown` instead of `html`, and the push card renderer would handle the choice

### 10.3 Auction (unchanged from original)

```rg
agent type ManagedTs {
  language: ts
  zones: agent
  bindings: [$ctx, $self, reagent, $agent]
  async: allowed
  capabilities: {
    consume: [json, plaintext]
    produce: [json, markdown, plaintext]
  }
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

For machine-to-machine protocols between managed code types, capabilities have minimal impact — both sides speak `json` and content negotiation is trivial. The value of capabilities shows up when the participant mix is heterogeneous.

---

## 11. Spec delta sketch

This RFC implies the following eventual delta to `docs/current/02-lang-spec.md`:

- add top-level `agent type` declaration with `capabilities` block
- replace participant bracket tags with `agent type` references
- allow roles to constrain acceptable `agent type`s
- define participant specialization of concrete `agent type`s
- remove `agent ... runs ...` from the core syntax
- deprecate `[ts]`, `[py]`, `[kt]`, `[*]` as first-class participant syntax
- add `expect_produce` as an optional prop on message steps
- define `$ctx.target` as a runtime-injected binding populated from receiver type metadata
- add `prompt_preamble` and `prompt_zone_wrapper` as optional properties of instruct agent types
- extend `MessageEnvelope` with optional `contentFormat`, `expectedProduce`, `locale` fields

---

## 12. Open questions

- What is the cleanest surface syntax for role constraints and participant specialization?
- Should roles be generic over `agent type`, or should they declare compatibility in a lighter form?
- How much of `$agent` availability is semantic, and how much remains runtime-materialization detail?
- Should `WireParticipant` be a normal `agent type` or a reserved built-in?
- When runtime registrations expose concrete `agent type`, where should that identity live in deployment/manifests?
- What is the vocabulary of capability names? Should it be an open set (user-defined) or a closed set (language-defined)?
- How are capability conflicts resolved when a subtype narrows capabilities that a role constraint requires?
- Should `prompt_zone_wrapper` use a specific template language, or is it free-form text with `{{...}}` substitution?
- How does `$ctx.target` interact with `scatter` — is it re-negotiated per scatter target?
- Should consumer types declare their `capabilities.produce` forms with schemas (linking to `message` definitions), or are named forms sufficient for v1?

---

## 13. Recommended next step

Use this RFC as the semantic anchor for follow-up work:

1. align `resolve-policy.md` with the removal of `agent ... runs ...`
2. choose one concrete surface syntax for role/participant parameterization
3. define the initial closed vocabulary of capability names (content formats + interaction forms)
4. prototype content negotiation in the runtime as a lightweight `$ctx.target` population pass
5. prototype prompt template rendering for one instruct type to validate the `prompt_zone_wrapper` model
6. only then prepare compiler/runtime implementation work
