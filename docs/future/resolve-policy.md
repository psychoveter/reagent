# Resolve Policy — agent platform, participant binding, spawn lifecycle

Status: **RFC draft** | Date: 2026-02-27

Alignment note (2026-03-13):

- This RFC now assumes the direction described in `agent-types.md`.
- `agent ... runs ...` should no longer be treated as core-language syntax.
- Runtime instance inventory, registration metadata, and lifecycle remain part of the platform/runtime model.
- Participant examples that still use `[py]` / `[ts]` should be read as pre-`agent type` syntax sketches unless updated explicitly.

---

## 1. Scope

This RFC covers an interconnected set of features that together define **how protocols discover, bind, and manage their participants at runtime**. These cannot be designed in isolation — agent registration feeds resolve policies, resolve policies govern spawns, spawns require lifecycle management, stateful policies need platform state.

| Area | Summary |
|---|---|
| **ResolvePolicy** | First-class language concept: explicit, composable policies for mapping roles to agents. |
| **Agent registration & metadata** | Platform-level agent registry with labels/capabilities/tags. |
| **Stateful policies** | Policies that maintain state across invocations (`roundRobin`, `leastLoaded`). |
| **Spawn lifecycle** | Agent spawn, persistence, and teardown within protocols. |
| **Static vs dynamic participants** | Compile-time distinction between fixed and runtime-determined participants. |
| **Participant cardinality: `single` / `many`** | Explicit declaration of whether a role binds to one agent or a set. |

---

## 2. Motivation

The trigger system (see `rc-spec.md` §8) leaves participant resolution implicit by default: the runtime picks "the first matching agent" for each role. This works for simple topologies but fails for:

- **Load balancing**: distribute work across a pool of equivalent agents.
- **Dynamic membership**: protocols whose participant list is discovered at runtime (service registries, tagged pools).
- **Multi-instance roles**: scatter over N workers where N is determined by availability, not a static list.
- **Invoke with explicit bindings**: the caller knows exactly which agents to use and passes references.
- **Cron/event triggers**: no caller exists — who plays each role?

We need a **single, explicit, composable** mechanism that covers all cases.

---

## 3. Design: participant declaration

### 3.1 Participant modifiers

Each participant in a protocol can carry **three orthogonal modifiers**:

| Modifier | Values | Default | Meaning |
|---|---|---|---|
| **Binding** | `static` / `dynamic` | `static` | When the agent binding is determined |
| **Cardinality** | `single` / `many` | `single` | How many agents can play this role |
| **Role** | `initiator` | (none) | Marks the protocol entry point |

`initiator` implies `static single` — it is the agent that receives `$ctx.input` and starts the protocol. A protocol must have exactly one `initiator`. The `initiator` keyword replaces the separate `initiator:` directive.

```rg
protocol Auction {
  participants:
    seller [py] initiator,         // static single (implied by initiator)
    buyer [py] dynamic many        // N buyers, determined during protocol

  trigger on invoke with AuctionStart {
    resolve seller = from($ctx.input.sellerId)
  }

  // buyers are resolved/spawned later in protocol body, not in trigger
  // ...
}
```

Full modifier examples:

```rg
participants:
  coordinator [py] initiator,           // static single, entry point
  worker [py] dynamic many,             // N workers, resolved at runtime
  auditor [py] static many,             // N auditors, resolved at trigger time
  backup [py] static single             // one backup, known at trigger time
```

Bare declaration without modifiers (e.g. `coordinator [py]`) defaults to `static single`.

### 3.2 Static vs dynamic

A participant is **static** when the agent bound to it is determined before the protocol body runs and does not change. A participant is **dynamic** when the binding can change or the set of agents playing the role is determined during execution.

**Static participants** are resolved in the trigger's `resolve` block (or by the caller for `invoke` triggers). Their bindings are immutable for the protocol instance lifetime.

**Dynamic participants** are resolved during protocol execution — via `spawns`, `scatter` binding, or explicit `reagent.resolve()` calls in zones. Their set can grow or change.

### 3.3 Cardinality: `single` and `many`

| Modifier | Meaning | Usage |
|---|---|---|
| `single` | Exactly one agent plays this role per protocol instance | Initiators, coordinators, unique resources |
| `many` | Zero or more agents can play this role | Worker pools, bidder sets, subscriber groups |

Compiler rules:
- `scatter` collection variable **must** correspond to a `many` participant.
- `single` participants in messages (`A --> B`) always route to the one bound agent.
- `many` participants in messages require scatter context or explicit indexing.
- `initiator` participant **must** be `single` and `static` (compiler error otherwise).

### 3.4 `initiator` as modifier (replaces `initiator:`)

The separate `initiator:` directive is **removed**. The `initiator` keyword is now a modifier in `participants:`:

```rg
// OLD (removed):
protocol Foo {
  participants: a [py], b [py]
  initiator: a
  ...
}

// NEW:
protocol Foo {
  participants:
    a [py] initiator,
    b [py]
  ...
}
```

The compiler rejects `initiator:` as an unknown directive. All `.rg` files must be updated.

---

## 4. ResolvePolicy — the language concept

### 4.1 Core idea

A `ResolvePolicy` is a **pipeline of steps** that takes the platform's agent registry as input and produces a set of agent references as output. Policies are declared in trigger `resolve` blocks for static participants and in zone-level `reagent.resolve()` for dynamic participants.

### 4.2 Syntax

#### In triggers (static participants)

```rg
trigger on invoke with AuctionStart {
  resolve seller = from($ctx.input.sellerId)
  resolve buyer = all | filter(hasCapability("bidding")) | sample(5)
}

trigger on cron "0 9 * * MON" {
  $ctx.input = { day: $ctx.input.firedAt }
  resolve coordinator = single
  resolve worker = all | filter(hasTag("batch-worker")) | roundRobin
}

trigger on event "order.created" with OrderEvent {
  resolve seller = from($ctx.input.sellerId)
  resolve buyer = all
}
```

#### In zones (dynamic participants)

```rg
coordinator {
  $ctx.workers = reagent.resolve("worker", all | filter(hasTag("gpu")) | sample(3))
}
```

### 4.3 Resolve is mandatory

Every role **must** have a resolve policy. This is a compile-time requirement.

- **Static participants**: resolve in the trigger block.
- **Dynamic participants**: the compiler verifies that a `reagent.resolve()` or `spawns` occurs for the role before first use (message send/receive).

If a role has no `resolve` declaration and is not dynamic, the compiler emits an error.

### 4.4 Pipeline model

A resolve pipeline is a chain of steps separated by `|` (pipe operator). Each step transforms a candidate set:

```
source | filter | ... | selection
```

Three stage categories:

| Stage | Purpose | Cardinality in → out |
|---|---|---|
| **Source** | Produces the initial candidate set | 0 → N |
| **Filter** | Narrows the candidate set | N → M (M ≤ N) |
| **Selection** | Picks from the filtered set | N → K (K ≤ N) |

### 4.5 Built-in policy steps

#### Source steps

| Step | Semantics | Output |
|---|---|---|
| `all` | All registered agents playing this role | Set of AgentRef |
| `single` | The single registered agent for this role (error if 0 or >1) | One AgentRef |
| `from(expr)` | AgentRef(s) extracted from an expression (e.g. `$ctx.input.buyerId`) | One or more AgentRef |

#### Filter steps

| Step | Semantics |
|---|---|
| `filter(expr)` | Keep agents where `expr` evaluates to truthy. The expression has access to `agent` — the candidate's registration record (see §5). |

Inside `filter(...)`, the implicit variable `agent` exposes the `AgentRegistration` fields:

| Field | Type | Example |
|---|---|---|
| `agent.name` | `string` | `agent.name == "Worker1"` |
| `agent.tags` | `string[]` | `"gpu" in agent.tags` |
| `agent.capabilities` | `string[]` | `"bidding" in agent.capabilities` |
| `agent.labels` | `Record<string, string>` | `agent.labels.region == "eu-west"` |
| `agent.metadata` | `Record<string, unknown>` | `agent.metadata.score > 0.8` |

Supported operators: `==`, `!=`, `>`, `<`, `>=`, `<=`, `in`, `&&`, `||`, `!`, parentheses. String literals in double quotes.

Examples:

```rg
// Simple tag check
filter("gpu" in agent.tags)

// Label match
filter(agent.labels.region == "eu-west")

// Compound expression
filter("ml" in agent.capabilities && agent.metadata.score > 0.5)

// Negation
filter(!("deprecated" in agent.tags))
```

Convenience shorthands (sugar, compiled to expressions):

| Shorthand | Expands to |
|---|---|
| `hasTag(tag)` | `tag in agent.tags` |
| `hasCapability(cap)` | `cap in agent.capabilities` |
| `hasLabel(key, value)` | `agent.labels.key == value` |
| `isAlive` | `agent.metadata._alive == true` |

#### Selection steps

| Step | Semantics | Output |
|---|---|---|
| `first` | First agent from the set (deterministic, registration order) | 1 |
| `random` | Uniformly random pick | 1 |
| `sample(n)` | Random sample of N agents | N |
| `roundRobin` | Stateful: rotates through candidates across invocations | 1 |
| `leastLoaded` | Stateful: picks agent with fewest active protocol instances | 1 |
| `fallback(chain)` | Try the inner chain; if empty result, fall through to next pipeline | varies |

#### Passthrough / identity

| Step | Semantics |
|---|---|
| (no selection step) | The entire filtered set is used (all matching agents) |

### 4.6 Pipeline validation (compiler)

The compiler validates resolve pipelines at compile time:

1. **Pipeline must start with a source step** (`all`, `single`, `from(expr)`).
2. **Filters can appear zero or more times** after the source.
3. **At most one selection step**, and it must be last (or absent).
4. **Cardinality check**:
   - `single` participant → pipeline must produce exactly 1 agent. Valid endings: `single`, `first`, `random`, `roundRobin`, `leastLoaded`, or `from(expr)` when expr is scalar.
   - `many` participant → pipeline can produce any number.
5. **`from(expr)` for invoke triggers**: the expression must reference `$ctx.input.*` fields. The compiler checks the `with` type has the referenced field.

### 4.7 Full examples

#### Simple invoke (backward compatible)

```rg
protocol ComputeSquare {
  participants: worker [py] initiator

  trigger on invoke with ComputeRequest {
    resolve worker = single
  }

  worker {
    $ctx.result = $ctx.input.value * $ctx.input.value
    reagent.return($ctx.result)
  }
}
```

#### Multi-party invoke with explicit binding

```rg
message StartAuction {
  itemName: string
  reservePrice: number
  sellerId: string
  buyerIds: string[]
}

protocol Auction {
  participants:
    seller [py] initiator,
    buyer [py] static many

  trigger on invoke with StartAuction {
    resolve seller = from($ctx.input.sellerId)
    resolve buyer = from($ctx.input.buyerIds)
  }

  // ... auction body ...
}
```

#### Cron with load-balanced workers

```rg
protocol DailyBatch {
  participants:
    coordinator [py] initiator,
    worker [py] static many

  trigger on cron "0 9 * * *" {
    $ctx.input = { date: $ctx.input.firedAt }
    resolve coordinator = all | filter(hasTag("batch-coord")) | roundRobin
    resolve worker = all | filter(hasTag("batch-worker"))
  }

  coordinator {
    $ctx.tasks = await $agent.generate_tasks($ctx.input.date)
  }

  scatter ($ctx.tasks as worker) {
    coordinator --> worker: BatchTask = {
      onSend { $ctx.msg.task = $ctx._scatterItem }
    }
    worker --> coordinator: BatchResult = {
      onReceive { $ctx.results.push($ctx.msg.result) }
    }
  }
}
```

#### Dynamic participants with spawn

```rg
protocol ElasticPipeline {
  participants:
    orchestrator [py] initiator,
    processor [py] dynamic many

  trigger on invoke with PipelineConfig {
    resolve orchestrator = single
    // processor is dynamic — no resolve here
  }

  orchestrator {
    $ctx.needed = await $agent.calculate_parallelism($ctx.input)
  }

  // Spawn processors dynamically
  scatter ($ctx.needed as _item) {
    orchestrator spawns ProcessorRole($ctx._scatterItem) as processor
  }

  // Now use the spawned processors
  scatter ($ctx.needed as processor) {
    orchestrator --> processor: Work = {
      onSend { $ctx.msg.chunk = $ctx._scatterItem }
    }
    processor --> orchestrator: Result = {
      onReceive { $ctx.results.push($ctx.msg) }
    }
  }
}
```

---

## 5. Agent registration & metadata

Resolve policies reference agent metadata. This requires a formalized agent registration model.

### 5.1 Agent registration record

When an agent registers with the RC (via `rc.registerAgent()` or deployment), it provides:

```ts
interface AgentRegistration {
  name: string;                    // unique agent identifier
  role: string;                    // role this agent plays
  labels: Record<string, string>;  // arbitrary key-value pairs
  tags: string[];                  // classification tags
  capabilities: string[];          // declared capabilities
  metadata: Record<string, unknown>; // extensible, opaque to RC
}
```

### 5.2 Registration outside the core DSL

With the `agent type` direction, registration metadata should no longer be modeled as an extension of
`agent Name runs Role` inside the protocol language.

Instead, registration lives in runtime/deployment surfaces and is published into the runtime registry.

Illustrative runtime-side shape:

```json
{
  "instanceName": "Auctioneer",
  "role": "SellerRole",
  "agentType": "ManagedPy",
  "tags": ["premium", "eu-region"],
  "capabilities": ["bidding", "settlement"],
  "labels": { "tier": "gold", "region": "eu-west" }
}
```

This RFC intentionally stays focused on resolve/materialization semantics rather than prescribing the
final deployment syntax for such registrations.

### 5.3 Runtime registration API

```ts
rc.registerAgent("Worker1", {
  role: "WorkerRole",
  tags: ["gpu", "batch-worker"],
  capabilities: ["ml-inference"],
  labels: { tier: "standard" },
});
```

```python
rc.register_agent("Worker1", AgentRegistration(
    role="WorkerRole",
    tags=["gpu", "batch-worker"],
    capabilities=["ml-inference"],
    labels={"tier": "standard"},
))
```

### 5.4 Agent registry API (available in resolve predicates)

The `reagent` library exposes a query interface for agent discovery:

```ts
interface AgentRegistry {
  findByRole(role: string): AgentRef[];
  findByTag(tag: string): AgentRef[];
  findByCapability(cap: string): AgentRef[];
  findByLabel(key: string, value: string): AgentRef[];
  getMetadata(agentRef: AgentRef): AgentRegistration;
  count(role: string): number;
}
```

This is the same registry used internally by resolve policy evaluation. In zones it is available as `reagent.registry`.

---

## 6. Stateful policies

Some selection policies maintain state across invocations.

### 6.1 State ownership

Stateful policies (`roundRobin`, `leastLoaded`) need a home for their state. Options:

| Option | Pros | Cons |
|---|---|---|
| **Per-trigger on RC** | Natural scope, automatic cleanup on undeploy | State lost on RC restart |
| **Per-trigger persisted** | Survives restarts | Persistence dependency, complexity |
| **Per-protocol-definition on RC** | Shared across triggers of same protocol | Ambiguous when multiple triggers use different policies |

**Decision: per-trigger on RC (in-memory).**

Rationale: stateful policies are optimization hints, not correctness guarantees. Losing round-robin state on restart is acceptable — the pool reshuffles. If persistence is needed later, it is additive (persist the state blob keyed by `protocolName + triggerId`).

### 6.2 Round-robin state

```ts
interface RoundRobinState {
  cursor: number;       // index into the sorted candidate list
  lastCandidates: string[]; // snapshot of candidate names at last evaluation
}
```

If the candidate set changes (agent joins/leaves), the cursor resets.

### 6.3 Least-loaded state

```ts
interface LeastLoadedState {
  activeInstances: Map<string, number>; // agentName → count of active protocol instances
}
```

Maintained by the RC: incremented on protocol start, decremented on completion/failure.

### 6.4 Custom stateful policies

Users can implement custom policies as host-language functions:

```rg
trigger on event "task.submitted" with Task {
  resolve worker = all | filter(hasTag("available")) | custom("weighted-random")
}
```

The `custom(name)` step delegates to a user-registered policy implementation:

```ts
rc.registerResolvePolicy("weighted-random", {
  select(candidates: AgentRef[], state: unknown, ctx: ResolvePolicyContext): {
    selected: AgentRef[];
    newState: unknown;
  } {
    // custom logic using candidate metadata, state, etc.
  }
});
```

---

## 7. Spawn lifecycle (integration with resolve)

Spawn creates new agents at runtime. It interacts with resolve policies because spawned agents become candidates for `many` participant roles.

### 7.1 Spawn in protocol body

```rg
orchestrator spawns WorkerRole(config) as worker
```

This is role-level spawn (see `lang-spec.md` §1.9). The spawned agent:
1. Is registered in the RC agent registry with the role and any inherited metadata.
2. Becomes routable (can send/receive messages).
3. Is bound to the `worker` participant in the current protocol instance.

### 7.2 Spawn + resolve interaction

Spawned agents are **immediately visible** to subsequent `reagent.resolve()` calls and to resolve policies of child protocols. They appear in `all` queries for their role.

### 7.3 Spawn lifecycle

| Lifetime | Syntax | Semantics |
|---|---|---|
| **Protocol-scoped** (default) | `spawns Role(config) as participant` | Agent is deregistered when the parent protocol instance completes. |
| **Persistent** | `spawns Role(config) as participant persistent` | Agent survives the parent protocol. Must be explicitly stopped via `reagent.stop(ref)`. |

Protocol-scoped is the safe default: no orphan agents. Persistent is opt-in for long-lived workers.

### 7.4 Spawn metadata

Spawned agents inherit the role's default metadata. Additional metadata can be provided:

```rg
orchestrator spawns WorkerRole({
  task: $ctx._scatterItem,
  tags: ["ephemeral", "gpu"],
  labels: { batchId: $ctx.batchId }
}) as worker
```

The runtime separates `tags`/`labels`/`capabilities` from the config payload and applies them as registration metadata.

---

## 8. IR representation

### 8.1 ResolvePolicyIR

```ts
type ResolvePolicyIR = ResolvePipelineStep[];

type ResolvePipelineStep =
  | { step: "all" }
  | { step: "single" }
  | { step: "from"; expr: string }
  | { step: "filter"; predicate: string }
  | { step: "roundRobin" }
  | { step: "leastLoaded" }
  | { step: "random" }
  | { step: "sample"; count: number }
  | { step: "first" }
  | { step: "fallback"; chain: ResolvePipelineStep[] }
  | { step: "custom"; name: string }
  ;
```

### 8.2 TriggerIR extension

```ts
type TriggerIR =
  | { kind: "invoke";  withType: string;  inputExpr?: string; resolveMap: Record<string, ResolvePolicyIR> }
  | { kind: "cron";    cron: string;      inputExpr?: string; resolveMap: Record<string, ResolvePolicyIR> }
  | { kind: "event";   topic: string; withType: string; inputExpr?: string; resolveMap: Record<string, ResolvePolicyIR> }
  ;
```

`resolveMap` keys are role names. Only static participants appear here. Dynamic participants have no trigger-level resolve.

### 8.3 ParticipantIR extension

```ts
interface ParticipantIR {
  name: string;
  lang: string;
  binding: "static" | "dynamic";
  cardinality: "single" | "many";
  initiator: boolean;
}
```

### 8.4 SpawnIR

```ts
interface IRSpawnData {
  kind: "spawn";
  roleName: string;
  config: string;          // expression
  bindAs?: string;         // participant binding
  resultTarget?: string;   // $ctx field for AgentRef
  persistent: boolean;     // default false
}
```

### 8.5 Agent registration record (runtime-side, not protocol IR)

```ts
interface AgentRegistrationRecord {
  agentName: string;
  roleName: string;
  agentType?: string;
  tags?: string[];
  capabilities?: string[];
  labels?: Record<string, string>;
}
```

This record belongs to runtime/deployment state, not to the core protocol IR.

---

## 9. Syntax additions (EBNF)

```
ParticipantDecl  ::= Ident WS* "[" LangTag "]" (WS+ ParticipantMod)*
ParticipantMod   ::= "static" | "dynamic" | "single" | "many" | "initiator"

TriggerBodyOpt   ::= WS* "{" WS* TriggerBodyItem* WS* "}"
TriggerBodyItem  ::= ResolveDecl | InputAssign
ResolveDecl      ::= "resolve" WS+ Ident WS* "=" WS* ResolvePipeline
InputAssign      ::= "$ctx.input" WS* "=" WS* Expr

ResolvePipeline  ::= ResolveStep (WS* "|" WS* ResolveStep)*
ResolveStep      ::= "all"
                   | "single"
                   | "from" "(" Expr ")"
                   | "filter" "(" PredicateExpr ")"
                   | "roundRobin"
                   | "leastLoaded"
                   | "random"
                   | "sample" "(" Number ")"
                   | "first"
                   | "fallback" "(" ResolvePipeline ")"
                   | "custom" "(" StringLiteral ")"

FilterExpr       ::= FilterOr
FilterOr         ::= FilterAnd (WS* "||" WS* FilterAnd)*
FilterAnd        ::= FilterUnary (WS* "&&" WS* FilterUnary)*
FilterUnary      ::= "!" FilterUnary | FilterPrimary
FilterPrimary    ::= FilterComparison | FilterIn | "(" FilterExpr ")" | FilterShorthand
FilterComparison ::= FilterAccess WS* CompOp WS* FilterValue
FilterIn         ::= FilterValue WS+ "in" WS+ FilterAccess
FilterAccess     ::= "agent" ("." Ident)*
CompOp           ::= "==" | "!=" | ">" | "<" | ">=" | "<="
FilterValue      ::= StringLiteral | Number | Bool
FilterShorthand  ::= "hasTag" "(" StringLiteral ")"
                   | "hasCapability" "(" StringLiteral ")"
                   | "hasLabel" "(" StringLiteral "," StringLiteral ")"
                   | "isAlive"

SpawnStmt        ::= Ident WS+ "spawns" WS+ Ident "(" ZoneBody ")" (WS+ "as" WS+ Ident)?
                     (WS+ "persistent")?
                     (WS+ "->" WS+ Target)?
```

`agent` declarations are intentionally omitted here: under the `agent type` direction they are no
longer part of the core language surface.

---

## 10. Runtime architecture

### 10.1 Resolve policy evaluator

A new component in RC: `ResolvePolicyEvaluator`.

```ts
class ResolvePolicyEvaluator {
  constructor(
    private registry: AgentRegistry,
    private stateStore: Map<string, unknown>,  // keyed by triggerId
    private customPolicies: Map<string, CustomResolvePolicy>,
  ) {}

  evaluate(
    pipeline: ResolvePolicyIR,
    role: string,
    ctx: Record<string, unknown>,
    triggerId: string,
  ): AgentRef[] {
    let candidates = this.source(pipeline[0], role, ctx);
    for (const step of pipeline.slice(1)) {
      candidates = this.applyStep(step, candidates, triggerId);
    }
    return candidates;
  }
}
```

### 10.2 Integration with TriggerMatcher

The existing `TriggerMatcher` gains a resolve phase:

```
Trigger fires
  → TriggerMatcher matches trigger
  → ResolvePolicyEvaluator resolves static participants (from resolveMap)
  → RC.instantiateProtocol(resolvedParticipants)
  → Protocol body runs (may resolve dynamic participants via reagent.resolve() / spawns)
```

### 10.3 Integration with zone executor

The `reagent` library gains:

```ts
reagent.resolve(role: string, pipeline: ResolvePipeline): AgentRef | AgentRef[]
reagent.registry: AgentRegistry  // read-only access
```

These delegate to `RC.resolvePolicyEvaluator` via the existing zone-to-runtime bridge.

---

## 11. Migration path

### 11.1 Breaking change — no backward compatibility layer

This RFC is a **breaking language change**. No auto-inject, no auto-convert, no deprecation warnings. The compiler simply requires the new syntax from day one.

What changes for existing `.rg` files:

1. **`initiator:` directive** → removed. Use the `initiator` modifier in `participants:`.
2. **`resolve` declarations** → mandatory for every static participant in every trigger.
3. **`participants:` modifiers** → `static`/`dynamic`/`single`/`many` are available. Default (bare declaration) remains `static single` — no change needed unless the protocol uses pools or dynamic membership.

All existing examples and tests are updated as part of the implementation. No migration tooling, no transitional compiler modes.

### 11.2 Phased rollout

| Phase | What |
|---|---|
| **A** | Parser: participant modifiers (`static`/`dynamic`/`single`/`many`/`initiator`), `resolve` declarations in triggers. `initiator:` removed. Compiler emits `resolveMap` in TriggerIR, `ParticipantIR` with binding/cardinality/initiator. All examples updated. |
| **B** | `AgentRegistration` with tags/capabilities/labels. Runtime API and deployment/registry surface outside core DSL. |
| **C** | `ResolvePolicyEvaluator` in RC. TriggerMatcher uses `resolveMap`. Zone-level `reagent.resolve()`. |
| **D** | Stateful policies (`roundRobin`, `leastLoaded`). Custom policies. |
| **E** | Spawn lifecycle (`persistent` flag, protocol-scoped cleanup). |

---

## 12. Relationship to other RFCs

| Document | Relationship |
|---|---|
| `agent-types.md` | Defines `agent type`, removes `agent ... runs ...` from the core DSL, and makes runtime instance registration a platform concern. This document should follow that split. |
| `rc-spec.md` §8 | ResolvePolicy replaces initiator resolution (§8.5). Triggers gain `resolveMap`. Trigger runtime (TriggerMatcher, policies, cross-node routing) documented there. |
| `lang-spec.md` §1.9 | Spawn syntax (`spawns <RoleName> as <participant> persistent`) documented in the language spec. Spawn lifecycle (§7 here) defines runtime semantics. |
| `composite-agent.md` | Inner agents of a composite are invisible to the outer registry. Resolve policies in the outer RC never see inner agents. The inner RC has its own registry and resolve policies. |
| `backlog.md` runtime platform roadmap | Rust RC must implement `ResolvePolicyEvaluator`. Stateful policy state must be serializable for WASM/PyO3. |

---

## 13. Open questions

| # | Question | Notes |
|---|---|---|
| ~~Q1~~ | **~~Predicate language expressiveness~~** | **Resolved (§4.5).** Full expression language with `agent.*` access, comparisons, `in`, `&&`/`||`/`!`. Shorthands (`hasTag`, etc.) are sugar. |
| ~~Q2~~ | **~~Cross-node resolve + trigger race~~** | **Resolved (§13.1).** Embedded etcd provides consistent agent registry, CAS-based trigger dedup, lease-based cron leader election. See `backlog.md` M11-INFRA. |
| ~~Q3~~ | **~~Resolve failure semantics~~** | **Resolved.** Empty resolve result → protocol instantiation fails with error. `fallback()` step available for explicit handling. Future: trigger supervision system (see `backlog.md`). |
| Q4 | **Dynamic participant first-use verification** | Deferred to formal verification work (see `backlog.md` formal foundations). For now: no compiler enforcement, runtime error if message targets unresolved dynamic participant. |
| Q5 | **Resolve in role lifecycle handlers** | Can `on protocolStarted(Proto) { ... }` use `reagent.resolve()`? Likely yes — handlers run in zone context. |

### 13.1 Cross-node resolve and trigger race (Q2) — solved by embedded etcd

**Decision: embedded etcd** (see `backlog.md` M11-INFRA).

Every RC embeds an etcd node. The RC cluster = etcd raft group. This gives:

1. **Consistent agent registry.** `AgentRegistration` (tags, capabilities, labels, nodeId) stored in etcd `/agents/{name}`. All RCs see the same registry via local cache + watch. Resolve policies produce identical results regardless of which RC evaluates them.

2. **Trigger dedup.** When a trigger fires, the RC performs an etcd CAS (compare-and-swap) on `/triggers/locks/{triggerId}/{eventId}`. First RC wins — others skip. No race.

3. **Cron singleton.** etcd lease-based leader election (`/triggers/cron/leader`). Automatic failover on lease expiry. No split-brain.

4. **Stateful policies.** `roundRobin` cursor, `leastLoaded` counters stored in etcd. Consistent across cluster, survives RC restarts.

5. **No gossip needed.** etcd replaces SWIM gossip for membership and agent routing. `DiscoveryAgent` is removed.

**Scalability:** etcd supports 3-7 voting members. For larger clusters: first N RC nodes are etcd voters, rest are learners/clients. The agent registry scales to thousands of agents (etcd handles millions of keys).

---

## Appendix A: Complete protocol example

```rg
message AuctionStart {
  itemName: string
  reservePrice: number
  sellerId: string
}

message Bid {
  amount: number
}

message BidResult {
  won: boolean
  finalPrice: number
}

protocol Auction {
  participants:
    seller [py] initiator,
    buyer [py] static many

  trigger on invoke with AuctionStart {
    resolve seller = from($ctx.input.sellerId)
    resolve buyer = all | filter(hasCapability("bidding"))
  }

  trigger on cron "0 9 * * MON" {
    $ctx.input = { itemName: "weekly-lot", reservePrice: 0, scheduledAt: $ctx.input.firedAt }
    resolve seller = all | filter(hasTag("auctioneer")) | roundRobin
    resolve buyer = all | filter(hasCapability("bidding"))
  }

  seller {
    $ctx.itemName = $ctx.input.itemName
    $ctx.reservePrice = $ctx.input.reservePrice
  }

  scatter ($ctx.buyerRefs as buyer) {
    seller --> buyer: AuctionStart = {
      onSend {
        $ctx.msg.itemName = $ctx.itemName
        $ctx.msg.reservePrice = $ctx.reservePrice
      }
    }

    buyer {
      $ctx.bidAmount = await $agent.decide_bid($ctx.msg.itemName, $ctx.msg.reservePrice)
    }

    buyer --> seller: Bid = {
      onSend { $ctx.msg.amount = $ctx.bidAmount }
      onReceive { $ctx.bids.push($ctx.msg.amount) }
    }
  }

  seller {
    $ctx.result = await $agent.evaluate_bids($ctx.bids, $ctx.reservePrice)
  }

  scatter ($ctx.buyerRefs as buyer) {
    seller --> buyer: BidResult = {
      onSend {
        $ctx.msg.won = ($ctx._scatterIdx == $ctx.result.winnerIdx)
        $ctx.msg.finalPrice = $ctx.result.finalPrice
      }
    }
  }
}

role SellerRole [py] {
  plays Auction as seller
}

role BuyerRole [py] {
  plays Auction as buyer
}

agent Auctioneer runs SellerRole {
  tags: ["auctioneer", "premium"]
  capabilities: ["settlement"]
}

agent Buyer1 runs BuyerRole {
  tags: ["eu-region"]
  capabilities: ["bidding"]
}

agent Buyer2 runs BuyerRole {
  tags: ["us-region"]
  capabilities: ["bidding"]
}

agent Buyer3 runs BuyerRole {
  tags: ["eu-region"]
  capabilities: ["bidding", "vip"]
}
```

## Appendix B: Elastic spawn example

```rg
message PipelineConfig {
  parallelism: number
  taskType: string
}

message WorkChunk {
  data: any
}

message WorkResult {
  output: any
}

protocol ElasticPipeline {
  participants:
    orchestrator [py] initiator,
    processor [py] dynamic many

  trigger on invoke with PipelineConfig {
    resolve orchestrator = single
  }

  orchestrator {
    $ctx.chunks = await $agent.prepare_work($ctx.input.parallelism, $ctx.input.taskType)
  }

  scatter ($ctx.chunks as _item) {
    orchestrator spawns ProcessorRole({ chunk: $ctx._scatterItem }) as processor
  }

  scatter ($ctx.chunks as processor) {
    orchestrator --> processor: WorkChunk = {
      onSend { $ctx.msg.data = $ctx._scatterItem }
    }
    processor {
      $ctx.output = await $agent.process($ctx.msg.data)
    }
    processor --> orchestrator: WorkResult = {
      onSend { $ctx.msg.output = $ctx.output }
      onReceive { $ctx.results.push($ctx.msg.output) }
    }
  }

  orchestrator {
    reagent.return($ctx.results)
  }
}

role OrchestratorRole [py] {
  plays ElasticPipeline as orchestrator
}

role ProcessorRole [py] {
  plays ElasticPipeline as processor
}
```
