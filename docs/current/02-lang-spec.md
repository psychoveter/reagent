## Reagent language spec

This document defines the **Reagent protocol language**.

Reagent is a **meta-language**: it describes the choreography of agents, messages, and control flow.
The actual computation happens inside **agent zones** written in a **host language** chosen per participant.

Design goals:

- Human-writable, line-oriented protocol choreography.
- Extensible "props-like" dictionaries on message steps (for runtime hooks).
- **Agent functional zones** are host-language code blocks: `AgentName { ... }` (language from `participants:`).
- Four runtime-injected bindings: `$ctx` (per-role isolated working memory), `$self` (role-level persistent), `reagent` (runtime library), `$agent` (optional native module).
- Produces a well-defined **AST** with source locations, suitable for Cursor plugins.

Non-goals (v0):

- Full typechecking of embedded code (zones are raw text to the Reagent toolchain).
- Full parsing of host languages inside zones (parser only balances braces).

Status note:

- The language is being designed **from examples first**. See `projects/reagent/examples/`.
- Cursor/VSCode syntax highlighting lives in `projects/reagent/tools/reagent-vscode/` (TextMate grammar).

---

## 1. Concrete syntax (informal)

### 1.1 Protocol header

```
protocol Name {
  participants: roleA [ts] static single initiator, roleB [py] dynamic many, roleC [kt]

  trigger on invoke with InputMsg
  trigger on cron "0 9 * * MON"
  trigger on event "order.created" with InputMsg

  ...body...
}
```

- `participants` lists roles. Each role MUST have a **language tag** in `[brackets]`.
Supported tags (v0): `ts`, `js`, `py`, `kt`, `*`.
The language tag declares which host language the agent's zones are written in.
- `[*]` is the **wildcard lang tag**: it marks a role as **language-agnostic**.
Wildcard participants participate in the choreography (sending/receiving messages) but MUST NOT have agent zone blocks (standalone or inline via `onSend`/`onReceive` hooks).
Use `[*]` for roles whose implementation language is not fixed by the protocol — e.g. wire-only control protocols, adapters, or roles that will be bound to a concrete language at deployment time.

#### Participant modifiers

Each participant declaration supports optional modifiers after the language tag:

```
Name [lang] static|dynamic single|many initiator
```

- **Binding**: `static` (default) — the agent is resolved at trigger time. `dynamic` — the agent can be spawned or resolved during protocol execution.
- **Cardinality**: `single` (default) — exactly one agent per role. `many` — multiple agents can play this role (e.g. scatter participants).
- **Initiator**: the `initiator` modifier marks the role that receives `$ctx.input` and starts the protocol body. Exactly one participant MUST be marked `initiator`. This replaces the old `initiator:` directive.

All modifiers are optional. When omitted, the defaults are `static single` (non-initiator). The order of modifiers is flexible but the recommended convention is `binding cardinality initiator`.

**Compiler constraints on modifiers**:

- The `initiator` role MUST be `static single`. The compiler rejects `dynamic initiator` or `many initiator`.
- A participant used as a `scatter` target MUST be declared `many`. Direct sends to a `many` participant outside a `scatter` block are also rejected (ambiguous target).

#### Triggers (protocol entry points)

**Triggers** declare how a protocol can be instantiated: what stimulus starts it and how `$ctx.input` is formed.

A protocol MUST declare at least one trigger. The set of triggers defines the protocol's **activation surface**.

Three trigger kinds:

- `trigger on invoke with MsgType` — the protocol can be called via `<role> invokes Proto(...)` / `<role> async invokes Proto(...)`. If absent, the compiler rejects any `invokes`/`async invokes` references.
- `trigger on cron "expr"` — time-based schedule (cron expression). The `with` clause is **forbidden** for cron; the runtime always provides a system `CronTrigger` payload (`runIndex`, `firedAt`, `nextFireAt`).
- `trigger on event "topic" with MsgType` — reactive: fires when an event is published to the named topic.

The runtime **automatically** sets `$ctx.input` to the trigger data before the protocol body runs:

| Kind | `$ctx.input` contains |
|---|---|
| `invoke` | Caller's payload object |
| `cron` | `{ runIndex, firedAt, nextFireAt, cronExpr, protocolName }` |
| `event` | Event payload object |

An **optional** body block `{ $ctx.input = <expr> }` can be added to any trigger for post-processing. When present, `$ctx.input` is already populated with the raw trigger data, and the expression can reshape it using `$ctx`:

```rg
trigger on cron "0 9 * * MON" { $ctx.input = { day: $ctx.input.firedAt } }
```

`with MsgType` is mandatory for invoke and event triggers — it gives the compiler the input type for validation and tooling.

#### Resolve declarations (participant resolution in triggers)

Triggers for external stimuli (cron, event) must specify how to resolve each participant role to a concrete agent. This is done via `resolve` declarations inside the trigger body:

```rg
trigger on cron "0 9 * * MON" {
  resolve coordinator = all | filter(hasTag("batch-coord")) | roundRobin
  resolve worker = all | filter(hasTag("batch-worker"))
}
```

Syntax: `resolve <role> = <pipeline>` where `<pipeline>` is a sequence of steps separated by `|`:

- **Source step** (first): `all` (all registered agents for this role), `single` (exactly one expected), `from($ctx.input.field)` (agent ref from input payload).
- **Filter steps** (middle, zero or more):
  - `filter(hasTag("tag"))`, `filter(hasCapability("cap"))`, `filter(label("key") == "value")` — generic filter with predicate expression.
  - Shorthand forms are also accepted as direct pipeline steps: `hasTag("tag")`, `hasCapability("cap")`, `hasLabel("key", "value")`, `isAlive`. These desugar to `filter(...)` internally.
- **Selection step** (last, optional): `roundRobin`, `random`, `leastLoaded`, `first`, `sample(N)` (select N agents randomly).
- **Fallback step**: `fallback(<pipeline>)` — if the preceding steps produce an empty result, evaluate the nested pipeline instead.
- **Custom step**: `custom("resolverName")` — delegate to a named resolver function registered in the runtime.

**Resolve rules for participants**:

- Every `static` participant MUST have a `resolve` declaration in every trigger — including `trigger on invoke`. The compiler rejects missing resolve for static participants.
- `dynamic` participants MUST NOT have a `resolve` declaration. They are resolved at runtime (e.g. via `spawns`).

The resolve pipeline is evaluated by `ResolvePolicyEvaluator` in the RC when TriggerMatcher fires.

### 1.2 Message step

```
A --> B: MessageName = { ...props... }
A --> B: MessageName
```

- `A`, `B` are role identifiers.
- `MessageName` is the message type.
- `= { ... }` is an **optional** props dict for hooks (`onSend`, `onReceive`). May be omitted if no hooks needed.

Arrow types:

- `-->` — default message (async delivery). **This is the only arrow used in v0 examples.**
- `->`, `->>`, `-->>` — reserved for future semantics (e.g. sync call, broadcast). Not yet defined.

#### Props in message steps: hooks (inline agent zones)

`onSend` and `onReceive` inside message props open **inline agent zones** — host-language code blocks executed on the sender or receiver side respectively:

```
comma --> sia: SubmitIntent = {
  onSend {
    $ctx.msg.ref = $ctx.dsiBsi
  }
  onReceive {
    $ctx.intent = $ctx.msg.ref
  }
}
```

- `onSend { ... }` opens an agent zone for the **sender** (`A`). Code runs before the message is sent.
- `onReceive { ... }` opens an agent zone for the **receiver** (`B`). Code runs after the message is received.
- The host language of each hook zone is determined by the respective participant's `[LangTag]`.
- Both hooks have access to `$ctx`, `$self`, and `reagent`. `$ctx.msg` is available in `onReceive` (bound to the received payload) and in `onSend` (bound to the outgoing message being constructed).
- Either hook may be omitted. Both may be present in the same message step.

#### Props in `alt` guards: pattern matching (`where`)

Props inside `alt` guards have a **different** semantic — they act as **value patterns** for message dispatch. Use the `where` keyword to introduce patterns:

```
alt (sia --> comma: ValidationError where { code: "TRANSIENT" }) { ... }
```

Here `where { code: "TRANSIENT" }` is a **pattern/guard**: the branch matches only when the incoming message has `code == "TRANSIENT"`. This is NOT a hook.

The `where` keyword disambiguates pattern matching from hook zones (`= { onSend { ... } }`). The `= { key: value }` syntax is deprecated; prefer `where { key: value }`.

### 1.3 Agent functional zone (host-language code)

```
AgentName {
  // code in the host language declared for AgentName in participants
}
```

The language is **not** repeated on the zone — it is declared once in `participants:` (e.g. `comma [ts]`).
The zone body is written in that host language.

Zone body is **raw host-language code** — stored as text by the parser (braces are balanced, strings/comments skipped).

**Runtime injection**: the engine injects four bindings into every zone:

- `$ctx` — **per-role isolated** working memory. Each role has its own `$ctx` that is not shared. Data between roles is passed explicitly via message payload (`$ctx.msg`).
- `$self` — **role-level persistent state**. Survives across protocol instances.
- `reagent` — the **Reagent runtime library** (see §1.4).
- `$agent` — **optional native module binding** (see §1.3.1). Present when the agent has an `agent.json` manifest with a `module` field. Provides access to host-language methods exported by the native module (e.g. `await $agent.think(prompt)`, `$agent.query(id)`). Absent for agents without a native module — zones that reference `$agent` on such agents will get `undefined`.

**Async zones**: if a zone body contains the `await` keyword, the compiler marks the corresponding IR state as asynchronous (`async: true` on `action`, `preSendAsync` on `send`, `postReceiveAsync` on `receive`). The runtime detects this flag and executes the zone with an async executor (`AsyncFunction` in TS, `async def` wrapper in Python). This is transparent to the `.rg` author — no special syntax is needed beyond writing `await` in the host-language code inside the zone. Async zones are typically used with `$agent` methods that perform I/O (LLM calls, database queries, HTTP requests).

**Important constraints**:

- Zones of **different roles** MUST NOT be adjacent without an intervening message (ordering guarantee).
- Multiple consecutive zones of the **same role** are allowed (they execute sequentially on that agent).

### 1.3.1 `$agent` — native module binding

The `$agent` binding exposes a host-language object (the default export of a native module) to all zones executed by that agent. It is the bridge between protocol choreography and external I/O or domain-specific logic that cannot be expressed as inline zone code.

**When available**: an agent has `$agent` if and only if its `agent.json` manifest specifies a `module` field pointing to a host-language file. The runtime loads the module at agent registration time and injects its default export as `$agent` into every zone scope for that agent.

```
// agent.json
{
  "name": "Alice",
  "role": "AliceRole",
  "module": "./impl.py",
  "config": { "apiKey": "${LLM_API_KEY}" }
}
```

```
// impl.py — the default export becomes $agent
class AliceModule:
    def __init__(self, config):
        self.llm = LLMClient(config["apiKey"])

    async def think(self, prompt):
        return await self.llm.call(prompt)
```

```
// In a .rg protocol zone:
alice {
  $ctx.result = await $agent.think("Analyze: " + $self.worldModel)
}
```

**Design principle**: `$agent` should be a **thin I/O wrapper**. It provides access to external resources (LLM APIs, databases, environment handles, hardware interfaces) that zones cannot create or manage inline. All protocol logic — state management, decision making, prompt assembly — belongs in zones using `$ctx` and `$self`. This keeps protocols self-describing and debuggable.

**When absent**: agents without `agent.json` (or without a `module` field) do not have `$agent` in scope. Referencing `$agent` in such zones evaluates to `undefined` (TS/JS) or raises `NameError` (Python). The `.rg` agent declaration (`agent X runs Role`) works as before — `$agent` is purely additive.

See also: `01-user-guide.md` §6.1 for `agent.json` format and native module loading.

### 1.4 Reagent runtime library (`reagent.`*)

Every agent zone has access to the `reagent` runtime library, **auto-imported** by the engine. It provides functions for protocol-level operations, written in native host-language syntax.

The `reagent` library is the **bridge** between host-language code in zones and the Reagent protocol runtime.

#### `reagent.return(value)` — return a value to the invoker

```
reagent.return(expr)
```

Sends a **return message** from the current protocol instance back to the invoker (the role that called `invoke`). Semantically, this is a message from the child's `initiator` to the parent's invoking role. The parent receives the value as the result of `invoke`.

This means `reagent.return()` is not just a control-flow construct — it **generates a message** in the protocol trace (e.g. `ReturnValue` from child initiator to parent invoker).

#### `reagent.emit(eventName, props)` — emit an event outward

```
reagent.emit("TaskSubmitted", { kind: "task.submitted", ref: $ctx.intent })
```

Emits a named event for tracing/observability/external consumers. The zone role is the emitter.

#### `reagent.break()` — exit the enclosing loop

```
reagent.break()
```

Exits the innermost enclosing `loop`. The runtime catches the `BreakRequest` sentinel and advances to the loop's exit state. Must be called from within an agent zone inside a `loop` body. Calling outside a loop is a runtime error.

### 1.5 Built-in context objects — runtime contract

Reagent provides three built-in context bindings with distinct scope and propagation semantics:

#### `$ctx` — per-role isolated working memory

`$ctx` is a **per-role, per-instance** dict/object. Each role has its own `$ctx` — writes by one role are NEVER visible to another role.

Fixed fields (reserved by the runtime):

- `$ctx.instanceId` — protocol instance identifier (stable across restarts).
- `$ctx.input` — the external protocol input message delivered to `initiator`.
- `$ctx.msg` — the "current message" payload. **Binding rules:**
  - Bound when a role **receives** a message (`MessageReceived` event).
  - In `alt` branches: bound to the payload of the **matched** message.
  - **Lifetime**: valid from the point of receive until the next message step (send or receive) involving this role. Deleted after processing.
  - In `onReceive` hooks: always available (the hook runs immediately after receive).
  - In `par` branches: each branch gets its own isolated `$ctx.msg` (via prototype chain in TS, shallow copy in Python). Writes to `$ctx.msg` in one branch do not affect other branches.
- `$ctx.error` — bound inside `catch { ... }` blocks. See §1.9 for details.

User-defined fields: `$ctx.`* MAY contain arbitrary keys for per-role working memory.

#### `$self` — role-level persistent state

`$self` persists across protocol instances within a single agent lifetime. Defined in `role` definitions (see §1.15).

### 1.6 Context propagation (important for analysis)

`$ctx` is **strictly per-role** — never shared, never propagated. Data between roles flows **exclusively** via message payloads (`$ctx.msg`).

In `scatter` blocks, each branch gets its own isolated copy of `$ctx` with `_scatterItem` (the current collection item) and `_scatterIdx` (the current index) injected automatically.

### 1.7 Hooks vs standalone zones (and ordering)

Two ways to attach behaviour to a role:

- **Standalone agent zone** (`RoleName { ... }`): a free-standing host-language code block placed between message steps.
- **Hook zones** (`onSend { ... }`, `onReceive { ... }` inside message props): inline agent zones tied to a specific message step.

Both are agent zones — they contain host-language code with full access to `$ctx` and `reagent`.
The difference is **placement and timing**: hook zones are anchored to a message step.

Execution order for `A --> B: M = { onSend { ... } onReceive { ... } }`:

1. `A` executes `onSend { ... }` zone — code runs on **sender** `A`. `$ctx.msg` refers to the outgoing message.
2. Engine records `MessageSent`
3. Message is delivered to `B`
4. Engine records `MessageReceived`, binds `$ctx.msg` to the received payload
5. `B` executes `onReceive { ... }` zone — code runs on **receiver** `B`. `$ctx.msg` is the received message.

**Important**: `onSend` always runs on the sender's side, `onReceive` always on the receiver's. The host language of each hook zone is that of the respective participant.

### 1.8 Imports (protocol files and code modules)

Reagent supports two kinds of imports:

#### Protocol imports (`.rg` files)

```
import "./lib/derive-dsi-bsi.rg" as derive
```

Makes protocols defined in the file available as `derive.ProtoName`.

#### Code module imports (`.ts`, `.js`, `.py`, `.kt`)

```
import "./lib/helpers.ts" as helpers
```

Makes host-language functions/values available inside agent zones of the matching language.
Code imports are resolved by the engine at zone execution time.

#### Zone helper functions — patterns by language

Zones often need helper functions for domain logic (e.g. `updateWorldModel()`, `translateGoalToAction()`). The mechanism differs by host language:

**Python** (`[py]`): use standard `import` statements inside the zone body. The Python zone executor runs the zone via `exec()`, so top-level imports work:

```
entity {
  from nmmo_helpers import updateWorldModel, translateGoalToAction
  $self.worldModel = updateWorldModel($self.worldModel, $ctx.msg.obs)
  $ctx.action = translateGoalToAction($self.currentGoal, $ctx.msg.obs, $self.worldModel)
}
```

**TypeScript/JavaScript** (`[ts]`, `[js]`): zone code runs inside `new Function(...)`, which does not support `import` statements. Two options:

1. `**$agent` methods** (preferred): put helpers on the native module and call via `$agent`:
  ```
   sender {
     $ctx.result = $agent.computeHash($ctx.data)
   }
  ```
2. **Code module imports** (above): `import "./helpers.ts" as helpers` makes the module available in zones.

**Kotlin** (`[kt]`): follows the same pattern as TypeScript — use `$agent` for external logic.

### 1.9 Protocol-level control flow (reserved syntax)

These constructs operate at the **protocol choreography level** (outside agent zones):

#### `alt` — XOR branching

Two modes:

**Message-based (reactive)**: waits for one of several possible messages. Use `where` for pattern matching:

```
alt (B --> A: Accept) {
  ...
} else (B --> A: Reject) {
  ...
} else (timeout 10s) {
  ...
}
```

With pattern matching (`where` keyword):

```
alt (sia --> comma: ValidationError where { code: "TRANSIENT" }) {
  // transient error — retry
} else (sia --> comma: ValidationError where { code: "FATAL" }) {
  // fatal error — abort
}
```

`where { key: value }` matches only messages where the payload has `key == value`. The `where` keyword disambiguates patterns from hooks.

**Expression-based (evaluative)**: checks `$ctx` predicates.

```
alt ($ctx.outcome == "done") {
  ...
} else {
  ...
}
```

#### `loop` — repetition

```
loop ($ctx.attempt < 3) {
  ...
}
```

Guard expression uses `$ctx` and is evaluated by the runtime before each iteration.

Exit from within a zone using `reagent.break()` (see §1.4).

#### `par` — parallel branches with join

```
par {
  ...
} and {
  ...
}
```

All branches run concurrently. The `par` completes when **all** branches complete (join semantics). `and` is a keyword separating branches.

`**$ctx.msg` isolation**: each parallel branch gets its own isolated `$ctx.msg`. Messages received in one branch do not overwrite `$ctx.msg` in another branch.

#### `wait` — time delay

```
wait 1s
wait 500ms
```

Duration literal format: `<number>(ms|s|m|h)`. Examples: `1s`, `500ms`, `5m`, `1h`.

#### `timeout` — guard timeout (inside `alt`)

```
timeout 10s
```

Used as an `alt` branch guard. If no message matches within the duration, the timeout branch executes.

#### `try/catch` — abort and compensation

```
try {
  ...
} catch (error) {
  // $ctx.error is bound by the runtime to the failure value
  ...
}
```

The `(error)` in `catch (error)` is a **syntactic label** (for readability). The actual error value is always bound to `$ctx.error` by the runtime. Inside the `catch` body, `$ctx.error` contains the exception/failure object.

#### `<role> invokes` — synchronous child protocol call (protocol-level)

```
responder invokes ComputeSquare({ value: $ctx.receivedValue }) -> $ctx.squared
```

- `<role> invokes ProtoName(inputExpr)` calls a child protocol synchronously from the named role.
- `-> $ctx.target` assigns the return value.
- The calling role blocks until the child completes.
- The child's `reagent.return()` value is the result.
- The role is explicit — no ambiguity about which participant initiates the call.

With role mapping for multi-party child protocols:

```
comma invokes v.ValidateIntentWithSia({ intent: $ctx.intent }) {
  sia: sia
} -> $ctx.validation
```

#### `<role> async invokes` — fire-and-forget child protocol (protocol-level)

```
orchestrator async invokes BackgroundTask({ taskName: $ctx.taskName })
```

- `<role> async invokes ProtoName(inputExpr)` creates an independent child protocol instance from the named role.
- **Fire-and-forget**: the parent does not block; no result is captured.
- The role is explicit.
- IR state kind: `async_invoke`.

#### `<role> spawns` — create a new role instance (protocol-level)

```rg
coordinator spawns WorkerRole({ id: $ctx.workerId }) as worker persistent -> $ctx.workerRef
```

- `<role> spawns <RoleName>(config)` creates a new agent running the specified role at runtime.
- `as <participant>` binds the spawned agent to a protocol participant name (for subsequent messaging).
- `persistent` (optional) — the spawned agent survives beyond the parent protocol's lifetime. Without this flag, spawned agents are scoped to the parent protocol instance (stopped when it completes).
- `-> $ctx.ref` (optional) — stores the agent reference in `$ctx` for later use.
- The spawned agent is registered in the RC routing table and can send/receive messages immediately.
- Target is a **role name** (defined via `role ... { ... }`), not a protocol name.
- IR state kind: `spawn` with `roleName`, `config`, `bindAs`, `persistent`, `resultTarget`.

#### `scatter` — dynamic multicast to participant list

```
scatter ($ctx.workers as worker) {
  coordinator --> worker: Subtask = {
    onSend { $ctx.msg.taskId = $ctx._scatterIdx }
  }
  worker --> coordinator: SubtaskDone = {
    onReceive { $ctx.results.push($ctx.msg.result) }
  }
}
```

- `scatter (collection as itemRole) { ... }` dynamically forks execution for each item in the collection.
- `collection` is an expression evaluating to an array (from `$ctx`).
- `itemRole` is a role identifier used as a placeholder within the body.
- All branches execute concurrently and join when all complete (like `par`).
- Designed for patterns like **Call for Proposal** (CFP), map-reduce, and fan-out/fan-in.

**Per-branch variables**: inside each scatter branch, the runtime injects two special `$ctx` fields:

- `$ctx._scatterIdx` — the zero-based index of the current item in the collection.
- `$ctx._scatterItem` — the current item value from the collection.

Each branch gets its own isolated copy of `$ctx` (via prototype chain in TS, shallow copy in Python). Writes in one branch do not affect siblings or parent. Use them to access per-item data:

```
scatter ($ctx.agentIds as worker) {
  coordinator --> worker: Task = {
    onSend {
      $ctx.msg.id = $ctx._scatterItem
      $ctx.msg.index = $ctx._scatterIdx
    }
  }
}
```

---

**Not at protocol level** (handled in zones or by host-language):

- `if/else` — condition branching is done inside agent zones in host-language code.
- `throw` — host-language construct; signals a failure caught by `try/catch` via the reagent bridge.
- `return` — zone-only via `reagent.return()` (see §1.4).
- `emit` — zone-only via `reagent.emit()` (see §1.4).
- `break` — zone-only via `reagent.break()` (see §1.4).

### 1.10 Protocol completion

A protocol instance terminates when:

1. `**reagent.return(value)`** executes inside a zone — the protocol completes by sending a return message to the invoker. The invoking parent (if any) receives this value as the result of `reagent.invoke()`.
2. **End of `ProtocolBody`** is reached — implicit completion with no return value (`undefined`).
3. **Uncaught `throw`** (host-language) — the protocol aborts with an error (propagated to invoking parent as their `$ctx.error`).

There is no explicit "ProtocolCompleted" statement; completion is structural.

### 1.11 Host-language functions vs Reagent runtime library

Inside agent zones, there are two kinds of calls:

- `**reagent.***` functions (`reagent.return`, `reagent.emit`, `reagent.break`) — provided by the auto-imported Reagent runtime library. These interact with the protocol engine.
- **Everything else** (e.g. `compensate(...)`, `taskToDsiBsi(...)`, `merge(...)`) — opaque host-language calls. The Reagent parser treats them as raw code.

Note: `invokes`, `async invokes`, and `spawns` are **protocol-level** constructs (see §1.9), not zone-level `reagent.*` functions. The syntax is `<role> invokes Proto(...)` / `<role> async invokes Proto(...)` / `<role> spawns Role(...)`, making the caller role explicit.

### 1.12 Reagent as a meta-language

Reagent does **not** execute agent logic itself. It is a **meta-language** that:

1. Describes the **choreography** (who sends what to whom, in what order).
2. Embeds **host-language code** inside agent zones (executed by the engine for that language).
3. Provides `**$ctx`** and the `**reagent` runtime library** as bridges between choreography and computation.

The engine is responsible for:

- Parsing zone bodies in the appropriate host language.
- Injecting `$ctx`, `$self`, and `reagent` into zone execution contexts.
- Implementing the `reagent.`* API (`return`, `emit`, `break`).
- Executing protocol-level `invokes`, `async invokes`, `scatter` by managing child instances.
- Bridging host-language `throw` to protocol-level `try` semantics.
- Enforcing message ordering and protocol semantics.

### 1.13 Agent definition (deployment binding)

An **agent** is a thin deployment binding that associates a process name with a role:

```
agent Comma runs CommaRole
```

The `runs` keyword references a defined `role` (see §1.15). The agent inherits all behavior (plays, init, handlers, $self) from its role.

An optional lang tag overrides the role's language when the role uses `[*]`:

```
agent Comma [ts] runs CommaRole
```

#### Agent metadata body

An agent definition may include an optional metadata body with `tags`, `capabilities`, and `labels`. These are used by resolve policies to match agents to protocol roles at trigger time:

```rg
agent BatchCoordinator runs CoordinatorRole {
  tags: ["batch-coord", "production"]
  capabilities: ["schedule", "monitor"]
  labels: { region: "eu-west", tier: "primary" }
}
```

- `tags: [...]` — string array. Matched by `filter(hasTag("..."))` in resolve pipelines.
- `capabilities: [...]` — string array. Matched by `filter(hasCapability("..."))`.
- `labels: { key: value, ... }` — string key-value map. Matched by `filter(label("key") == "value")`.

All three fields are optional. When absent, the agent has empty tags/capabilities and no labels. Metadata is compiled into `AgentRegistrationIR` and written to the `StateStore` agent registry at agent startup.

**Constraints**:

- If the agent specifies a lang tag and the role also specifies a concrete lang tag, they must match.
- If the role has `[*]`, the agent may provide a concrete lang tag for deployment.
- If neither specifies a lang tag, the effective lang is `*` (language-agnostic).
- An agent with a metadata body still has no behavioral content (no plays, no init, no handlers). All behavior comes from the role.

### 1.14 Message types (typed payloads)

`message` is a **top-level construct** that defines the payload schema for a message exchanged in protocols.

```
message Register {
  adapterId: string
  capabilities: string[]
  maxAgents: number
}

message Accepted {}

message Rejected {
  reason: string
}
```

- `message Name { ... }` declares a named payload schema.
- Fields are `name: type` (one per line, optional trailing comma).
- Empty bodies (`message Ack {}`) declare a message with no user-defined payload.

**Dynamic payload construction**: the runtime initializes `$ctx.msg = {}` before every `onSend` zone. The zone populates fields dynamically (e.g. `$ctx.msg.obs = ...`). This means empty `message` declarations are fully usable — the schema is documentary, and the actual payload is whatever the zone writes to `$ctx.msg`. This is by design: Reagent does not enforce message schemas at runtime (v0).

**Type system (minimal)**:

- Scalars: `string`, `number`, `boolean`
- Escape hatch: `any` (gradual typing — no static checks)
- Array: `type[]` (e.g. `string[]`, `{ id: number }[]`)
- Inline object: `{ field: type, ... }`
- Optional: `name?: type` (field may be absent / null)

**Structural (duck) typing**: compatibility is structural, not nominal. A message with `{ amount: number, winner: boolean }` is compatible with a receiver expecting `{ amount: number }`.

#### Base envelope (`MessageEnvelope`)

Every message on the wire is wrapped in a `MessageEnvelope` — the base type all Reagent messages inherit from. User-defined `message` declarations specify only the **payload** portion; the envelope fields are injected by the runtime.

```
MessageEnvelope {
  instanceId:     string          // protocol instance this message belongs to
  protocolName:   string          // protocol that produced this message
  from:           { agent: string, role: string }   // sender identity
  to:             { agent: string, role: string }   // receiver identity
  messageName:    string          // the message type name (matches the `message` definition name)
  payload:        Record<string, unknown>            // user-defined fields from the `message` body
  ts:             number          // timestamp (epoch ms)
  idempotencyKey: string          // unique key for exactly-once delivery
}
```

The `payload` field carries the user-defined fields declared in a `message` definition. For example, given:

```
message Register {
  adapterId: string
  capabilities: string[]
}
```

The wire representation is a `MessageEnvelope` with `messageName: "Register"` and `payload: { adapterId: "...", capabilities: [...] }`.

In agent zones, `$ctx.msg` is bound to the **payload** (not the full envelope). Envelope fields are accessible through `$ctx` fixed fields (`$ctx.instanceId`, etc.) — see §1.5.

**Backward compatible**: messages without a `message` declaration remain valid — payload is `Record<string, unknown>`. Typing is opt-in. Existing untyped protocols continue to work.

**What it enables**:

- JSON Schema generation from `message` definitions (wire validation)
- Code generation: TypeScript interfaces, Python dataclasses, Kotlin data classes from `.rg`
- The `.rg` file becomes a self-contained wire format spec
- Future: `$ctx.msg.` autocomplete in IDE

### 1.15 Role definition (primary behavioral contract)

A **role** is the primary behavioral construct in Reagent. It defines the interaction contract: which protocols to play, persistent state, initialization, and lifecycle event handlers.

```
role CommaRole [ts] {
  plays TaskExecution as comma
  plays HealthCheck as comma

  init {
    $self.ready = true
    $self.tasksCompleted = 0
  }

  on protocolCompleted(TaskExecution) {
    $self.tasksCompleted += 1
    reagent.emit("AgentStats", { completed: $self.tasksCompleted })
  }

  on protocolFailed(TaskExecution) {
    $self.lastError = $ctx.error
  }
}
```

- `role Name [langTag]? { ... }` declares a named behavioral contract with an optional host language.
- `plays Proto as roleName` binds the role to a participant in a protocol.
- `init { ... }` runs once when an agent running this role starts (optional; at most one).
- `on <event>(<Proto>) { ... }` reacts to lifecycle events (multiple handlers allowed).
- `$self` is the role's persistent state, accessible in init, on handlers, and protocol zones.

`**$self` vs `$ctx**`:

- `$self` is the role-level persistent state. It survives across protocol instances and is scoped to the agent's lifetime.
- `$ctx` is the per-role, per-protocol-instance working memory. Strictly isolated to each role. Data between roles flows via message payloads (`$ctx.msg`).
- Inside a protocol zone, both `$self` and `$ctx` are available.

**Lifecycle events**:


| Event                      | When                                                                        |
| -------------------------- | --------------------------------------------------------------------------- |
| `protocolStarted(Proto)`   | A protocol instance this role participates in has started                   |
| `protocolCompleted(Proto)` | Protocol completed normally                                                 |
| `protocolFailed(Proto)`    | Protocol ended with an error                                                |
| `protocolEvent(eventName)` | Custom event emitted via `reagent.emit()` from any protocol this role plays |


### 1.16 Role inheritance via `extends`

A role can extend another role to inherit its plays, init, and handlers:

```
role BaseMonitored [ts] {
  plays HealthCheck as node

  init { $self.healthy = true }
  on protocolFailed(HealthCheck) { $self.healthy = false }
}

role WorkerRole [ts] extends BaseMonitored {
  plays TaskProcessing as worker

  init { $self.tasksCompleted = 0 }
  on protocolCompleted(TaskProcessing) { $self.uptime += 1 }
}
```

**Inheritance semantics**:

- `plays` bindings are merged (parent first, child appended, deduped by protocol+role).
- `init` blocks are chained: parent init runs first, then child init.
- `on` handlers from both parent and child fire for matching events (parent first).
- Lang tag must be consistent: child must match parent, or parent uses `[*]`.
- Single inheritance only (no diamond). Multiple inheritance is deferred.
- If the parent role is not defined, the compiler emits an error.
- Circular extends chains are detected and reported as errors.

**Design note**: the compiled IR artifacts (`RoleName.role.json` with full behavioral contract, `AgentName.agent.json` as thin deployment binding referencing the role) are formal intermediate representations with a documented schema. They are also designed to be self-describing enough for **coding agents** (LLMs) to produce correct agent implementations from IR alone, without reading `.rg` source.

---

## 2. EBNF

```
Program         ::= (WS | Comment | ImportStmt | ProtocolDef | AgentDef | MessageDef | RoleDef)* EOF

ImportStmt      ::= "import" WS+ String (WS+ "as" WS+ Ident)? WS* (";" WS*)?

ProtocolDef     ::= "protocol" WS+ Ident WS* "{" ProtocolBody "}"
ProtocolBody    ::= (WS | Comment | ProtocolDirective | Item | ReservedStmt)*

ProtocolDirective ::= ParticipantsStmt | TriggerDecl
ParticipantsStmt  ::= "participants" WS* ":" WS* ParticipantList
ParticipantList   ::= Participant (WS* "," WS* Participant)*
Participant       ::= Ident (WS* "[" LangTag "]")? ParticipantModifiers?
LangTag           ::= "ts" | "js" | "py" | "kt" | "*"
ParticipantModifiers ::= (WS+ ("static" | "dynamic"))? (WS+ ("single" | "many"))? (WS+ "initiator")?
TriggerDecl       ::= "trigger" WS+ "on" WS+ TriggerKind TriggerType? TriggerBodyOpt?
TriggerKind       ::= "invoke"
                     | "cron" WS+ StringLiteral
                     | "event" WS+ StringLiteral
TriggerType       ::= WS+ "with" WS+ Ident          /* mandatory for invoke/event, forbidden for cron */
TriggerBodyOpt    ::= WS* "{" WS* TriggerBodyItem* WS* "}"
TriggerBodyItem   ::= ResolveDecl | TriggerInputAssign
ResolveDecl       ::= "resolve" WS+ Ident WS* "=" WS* ResolvePipeline
ResolvePipeline   ::= ResolveStep (WS* "|" WS* ResolveStep)*
ResolveStep       ::= "all" | "single"
                     | "from" "(" Expr ")"
                     | "filter" "(" Expr ")"
                     | "hasTag" "(" String ")"         /* shorthand for filter(hasTag(...)) */
                     | "hasCapability" "(" String ")"   /* shorthand for filter(hasCapability(...)) */
                     | "hasLabel" "(" String "," String ")"
                     | "isAlive"                        /* shorthand for filter(agent.metadata._alive) */
                     | "roundRobin" | "random" | "leastLoaded" | "first"
                     | "sample" "(" Number ")"
                     | "fallback" "(" ResolvePipeline ")"
                     | "custom" "(" String ")"
TriggerInputAssign ::= "$ctx.input" WS* "=" WS* Expr  /* optional post-processing; $ctx.input already set */

Item            ::= MessageStmt | AgentZone | InvokeStmt | SpawnStmt

MessageStmt     ::= Ident WS* Arrow WS* Ident WS* ":" WS* MessageName (WS* "=" WS* MessageProps)?

MessageProps    ::= "{" WS* (HookZone | Pair)* WS* "}"
HookZone        ::= ("onSend" | "onReceive") WS* "{" ZoneBody "}"

Arrow           ::= "-->" | "->" | "->>" | "-->>"

MessageName     ::= MessageNameChar+
MessageNameChar ::= any char except '\n' and '='

AgentZone       ::= Ident WS* "{" ZoneBody "}"
ZoneBody        ::= BalancedText   // raw host-language code; braces balanced, strings/comments skipped
                                   // language is determined by the participant's [LangTag] declaration

InvokeStmt      ::= Ident WS+ "invokes" WS+ DottedIdent "(" ZoneBody ")" (WS* RoleMapping)? (WS* "->" WS* Target)?
AsyncInvokeStmt ::= Ident WS+ "async" WS+ "invokes" WS+ DottedIdent "(" ZoneBody ")" (WS* RoleMapping)?
SpawnStmt       ::= Ident WS+ "spawns" WS+ Ident "(" ZoneBody ")" (WS+ "as" WS+ Ident)? (WS+ "persistent")? (WS* "->" WS* Target)?
DottedIdent     ::= Ident ("." Ident)*
RoleMapping     ::= "{" WS* (Ident ":" Ident ("," WS* Ident ":" Ident)*)? WS* "}"
ScatterStmt     ::= "scatter" WS* "(" WS* Expr WS+ "as" WS+ Ident WS* ")" WS* "{" ProtocolBody "}"
Target          ::= "$ctx." Ident

RoleDef         ::= "role" WS+ Ident (WS* "[" LangTag "]")? (WS+ "extends" WS+ Ident)? WS* "{" RoleBody "}"
RoleBody        ::= (WS | Comment | PlaysStmt | RoleInitBlock | RoleOnHandler)*
PlaysStmt       ::= "plays" WS+ Ident WS+ "as" WS+ Ident
RoleInitBlock   ::= "init" WS* "{" ZoneBody "}"
RoleOnHandler   ::= "on" WS+ RoleEvent WS* "{" ZoneBody "}"
RoleEvent       ::= ("protocolStarted" | "protocolCompleted" | "protocolFailed") "(" Ident ")"
                  | "protocolEvent" "(" Ident ")"

AgentDef        ::= "agent" WS+ Ident (WS* "[" LangTag "]")? WS+ "runs" WS+ Ident (WS* "{" AgentMetaBody "}")?
AgentMetaBody   ::= (WS | Comment | AgentMetaField)*
AgentMetaField  ::= ("tags" | "capabilities") WS* ":" WS* Array
                  | "labels" WS* ":" WS* Object

MessageDef      ::= "message" WS+ Ident WS* "{" FieldList "}"
FieldList       ::= (WS | Comment | FieldDef (",")?)*
FieldDef        ::= Ident "?"? WS* ":" WS* TypeExpr
TypeExpr        ::= ScalarType ("[]")*
                  | "any" ("[]")*
                  | "{" FieldList "}" ("[]")*
ScalarType      ::= "string" | "number" | "boolean"

ReservedStmt    ::= AltStmt | LoopStmt | ParStmt | WaitStmt | TryStmt | ScatterStmt
AltStmt         ::= "alt" .*
AltGuard        ::= "(" Ident Arrow Ident ":" MessageName ("where" WS* Object)? ")"
                  | "(" Expr ")"
                  | "(" "timeout" WS+ Duration ")"
LoopStmt        ::= "loop" .*
ParStmt         ::= "par" .*
WaitStmt        ::= "wait" WS+ Duration
Duration        ::= Number ("ms" | "s" | "m" | "h")
TryStmt         ::= "try" .*

// Zone-only: reagent.return, reagent.emit, reagent.break
// throw is a host-language construct bridged by the runtime.

Object          ::= "{" WS* (Pair (WS* "," WS* Pair)*)? WS* "}"
Pair            ::= Key WS* ":" WS* Value
Key             ::= Ident | String

Value           ::= Null | Bool | Number | String | Ident | Object | Array
Array           ::= "[" WS* (Value (WS* "," WS* Value)*)? WS* "]"

Ident           ::= IdentStart IdentPart*
IdentStart      ::= [A-Za-z_]
IdentPart       ::= [A-Za-z0-9_\-\.]

String          ::= DQString | SQString
DQString        ::= '"' ( [^"\\] | Escape )* '"'
SQString        ::= "'" ( [^'\\] | Escape )* "'"
Escape          ::= "\\" ("\\" | '"' | "'" | "n" | "r" | "t")

Number          ::= '-'? ([0-9]+) ('.' [0-9]+)?
Bool            ::= "true" | "false"
Null            ::= "null"

Comment         ::= LineComment | BlockComment
LineComment     ::= "//" [^\n]* "\n"?
BlockComment    ::= "/*" .* "*/"

WS              ::= (" " | "\t" | "\r" | "\n")+
```


## 3. Examples

Protocol-only examples: `projects/reagent/examples/protocols/src/` (25+ files covering all language constructs).

Full project examples: `projects/reagent/examples/projects/` (`auction-sim`, `task-delegation`, `autoscience`).

---

## 4. Compiler and tooling

### 4.1 AST

The parser outputs an AST conforming to the TypeScript types at `lang/src/ast.ts`.

The full AST covers all language constructs:

- `Program` (top-level: imports + protocol definitions + agent definitions + message definitions + role definitions)
- `ImportStmt` (protocol `.rg` imports + code module imports)
- `ProtocolDef` (header + triggers + body), `ParticipantDecl` (name + `LangTag` + optional modifiers: `binding`, `cardinality`, `initiator`), `TriggerDecl` (trigger kind + `withType` + optional cron/topic + input expression + optional `resolveMap`)
- `MessageStmt` (sender, arrow, receiver, message name, optional `MessageProps` with `HookZone` and `PropPair`)
- `AgentZone` (standalone: role name + `lang` resolved from participants + raw body text)
- `AltStmt` (branches with `AltMessageGuard` / `AltExprGuard` / `AltTimeoutGuard` / `AltElseGuard`; message guards support `whereClause`)
- `LoopStmt` (guard expression + body)
- `ParStmt` (branches separated by `and`)
- `WaitStmt` (duration literal)
- `TryStmt` (try body + catch label + catch body)
- `InvokeStmt` (caller role + protocol name + input expression + optional role mapping + optional result target — **protocol-level synchronous call**: `<role> invokes Proto(...)`)
- `InvokeStmt` with `async: true` (caller role + protocol name + input expression + optional role mapping — **protocol-level fire-and-forget**: `<role> async invokes Proto(...)`)
- `SpawnStmt` (caller role + role name + config expression + optional `as` binding + optional `persistent` flag + optional result target — **role instance spawn**: `<role> spawns Role(...) as participant persistent -> $ctx.ref`)
- `ScatterStmt` (collection expression + item role + body — **dynamic multicast**)
- `RoleDef` (role name + optional lang tag + optional extends + plays bindings + init block + lifecycle handlers — **primary behavioral contract**)
- `AgentDef` (agent name + optional lang tag + `runs` role name — **thin deployment binding**)
- `PlaysDecl` (protocol name + role name)
- `RoleInitBlock` (raw zone body)
- `RoleOnHandler` (event name + optional protocol filter + raw zone body)
- `MessageDef` (message name + field definitions — typed payload schema)
- `FieldDef` (field name + type expression + optional flag)
- `TypeExpr` (`ScalarType` | `ArrayType` | `ObjectType` | `AnyType`)

Every node carries `Loc` (source location: `start: {index, line, col}`, `end: {index, line, col}`).

### 4.2 Parser

Hand-written **recursive-descent parser** in TypeScript (`lang/src/parser.ts`).
Zone bodies remain **raw text** (parser only balances braces, does not parse host language).

### 4.3 Protocol IR

The compiler produces per-role **Protocol IR** — directed graphs of states and transitions:

- `IRGraph` per role (local view of the global protocol):
  - `triggers: TriggerIR[]` and `invocable: boolean`
  - `participants?: ParticipantIR[]` — participant declarations with modifiers
  - `version?: string` and `fingerprints?: ProtocolFingerprint` — versioning metadata
  - `dependencies?: ProtocolDependency[]` — cross-protocol dependencies (for `invokes`)
- `ParticipantIR` — per-participant metadata: `{ name, lang, binding, cardinality, initiator }`
- `TriggerIR` — protocol entry point metadata:
  - `{ kind: "invoke", withType, inputExpr?, resolveMap? }`
  - `{ kind: "cron", cron, inputExpr?, resolveMap? }`
  - `{ kind: "event", topic, withType, inputExpr?, resolveMap? }`
  - `resolveMap` is `Record<string, ResolvePolicyIR>` mapping role names to resolve pipelines
- `ResolvePolicyIR` — resolve pipeline: `{ steps: ResolvePipelineStepIR[] }` where each step has a `kind` discriminator (`all`, `single`, `from`, `filter`, `roundRobin`, `random`, `leastLoaded`, `first`, `sample`, `fallback`, `custom`)
- `IRState` types: `initial`, `send`, `receive`, `action`, `guard`, `fork`, `join`, `timer`, `terminal`, `error`, `invoke`, `async_invoke`, `spawn`, `scatter`
- `IRTransition` labels: `default`, `message`, `timeout`, `expression`, `else`, `error`, `branch`
- `send`/`receive` states have the standard message routing fields
- `invoke` state: `protocolName`, `input` expression, optional `resultTarget`
- `async_invoke` state: `protocolName`, `input` expression (fire-and-forget)
- `spawn` state: `roleName`, `config` expression, optional `bindAs`, optional `persistent` flag, optional `resultTarget`
- `scatter` state: `collection` expression, `itemRole`, `branchStartIds`
- `action` states have optional `async: true` flag (zone body contains `await`)
- `send` states have optional `preSendAsync: true` (onSend zone contains `await`)
- `receive` states have optional `postReceiveAsync: true` (onReceive zone contains `await`)

#### Fingerprints and versioning

Protocol and role IR include fingerprint fields for change detection:

- `ProtocolFingerprint { structureHash, schemaHash, implHash }` — three hashes covering protocol structure, message schemas, and zone implementations respectively
- `RoleFingerprint { playsHash, behaviorHash }` — hash of plays bindings and behavioral content
- `ProtocolDependency { protocolName, structureHash, version }` — tracks invoked/composed protocols

These are used by the reconciler and `reagent.lock` for incremental builds and compatibility checking.

### 4.4 Role IR

The compiler produces per-role-definition **Role IR** — the rich behavioral contract:

- `RoleIR`: role name, optional lang tag, optional extends reference, plays bindings, init action (chained from extends), lifecycle handlers (merged from extends).
- Emitted as `<RoleName>.role.json`.
- `extends` is resolved at compile time: the emitted `RoleIR` is the fully flattened behavioral contract.

### 4.5 Agent IR

The compiler produces per-agent **Agent IR** — a thin deployment binding that references the role:

- `AgentIR`: `{ agentName, lang, roleName, roleFile, tags?, capabilities?, labels? }`. No behavioral data (plays, init, handlers).
- When the agent has a metadata body (`tags`, `capabilities`, `labels`), these are included in the `AgentIR`.
- The runtime loads `AgentIR` and then resolves the referenced `RoleIR` to obtain the full behavioral contract (plays, init, lifecycle handlers).
- This eliminates redundancy: behavioral data lives in `RoleIR` only, and `AgentIR` is a pure deployment artifact.

Additionally, the compiler produces `AgentRegistrationIR` per agent — a resolve-policy-facing record that includes the agent name, role name, tags, capabilities, and labels. This is the data written to the `StateStore` agent registry and evaluated by `ResolvePolicyEvaluator`.

### 4.6 Message Schema IR

When the `.rg` file contains `message` definitions, the compiler produces `IRMessageSchema` records:

- `IRMessageSchema`: `{ name, fields: IRFieldSchema[] }`
- `IRFieldSchema`: `{ name, type, optional, isArray }`

These are collected into `messages.json` during compilation.

See `lang/src/ir.ts` for IR type definitions, `lang/src/ir-emitter.ts` for AST→IR, and `lang/src/ir-validator.ts` for validation.

### 4.7 CLI (`reagent-lang`)

The `@reagent/lang` package provides a CLI (`lang/dist/cli.js`):

```
reagent-lang parse      <file.rg>               — parse and print AST as JSON
reagent-lang ir         <file.rg> [role]         — emit IR to stdout (optionally filter by role)
reagent-lang validate   <file.rg> [role]         — emit IR, validate, print diagnostics
reagent-lang compile    <file.rg> <out-dir>      — compile one .rg file to IR JSON files
reagent-lang init       [dir]                    — scaffold a new Reagent project
reagent-lang build      [project-dir]            — build all protocols from reagent.json
reagent-lang decompile  <dir|file.ir.json>       — reconstruct .rg from compiled IR
reagent-lang verify     <file.rg>                — generate TLA+ spec, run TLC model checker
reagent-lang deploy     [project-dir] [url]      — build and deploy to control-plane server
```

#### `build` output

The `build` command reads `reagent.json` (project manifest) and produces:

- `<Proto>.<role>.ir.json` — one IRGraph per role in each protocol
- `<RoleName>.role.json` — one RoleIR per role definition (rich behavioral contract)
- `<Agent>.agent.json` — one AgentIR per agent (thin binding referencing role)
- `messages.json` — message schemas (if any `message` definitions exist)
- `deployment.json` — deployment plan mapping agents to roles, role defs, and IR files
- `source-map.json` — source location mapping from IR states to `.rg` file positions
- `reagent.lock` — version lock file with protocol/role fingerprints for change detection

### 4.8 Reference runtimes

Lightweight **reference runners** (TypeScript and Python) interpret IR JSON directly:

- **AgentRunner** — one instance per agent. Manages `$self`, lifecycle handlers, message routing to ProtocolInstances. Wires `invoke_callback` and `spawn_callback` for IR-level `invoke`/`async_invoke` states.
- **ProtocolInstance** — interprets one IRGraph state machine per protocol instance. Has its own `$ctx`. Includes a **message inbox buffer** for messages arriving before receivers register (critical for synchronous loopback transport).
- **Zone Executor** — executes raw zone body strings with `$ctx`, `$self`, `reagent` in scope. Python executor includes JS→Python compatibility layer (`true`→`True`, `===`→`==`, etc.).

#### TypeScript orchestrator (`ReagentController`)

The TS `ReagentController` (in `runtime/ts/`) manages agent registry, routing table, interceptor chain, and NodeLink management. It supports multiple `AgentNode` backends keyed by language (`ts` → `NativeAgentNode`, `py` → `PythonAgentNode`). Transport is abstracted via `ReagentTransport` — no direct NATS dependency.

#### Python orchestrator (`ReagentController`)

The Python `ReagentController` (in `runtime/py/reagent_runtime/controller.py`) mirrors the TS RC architecture as a pure-Python orchestrator. No NATS or TS parent required. Key components:

- `**InprocAgentNode`** — runs agents in the same process via `AgentRunner` + `InprocTransport`. Zero serialization overhead. Primary mode for NMMO-style multi-agent simulations.
- `**IpcAgentNode**` — runs agents as subprocesses via `ipc_agent.py` with JSON-line stdin/stdout IPC.
- `**InprocTransport**` — per-agent transport that routes envelopes through the RC's routing table via a callback. Traces go to an optional trace callback. Subscriptions are no-ops.

Usage:

```python
rc = ReagentController(node_id="sim")
rc.add_agent_node("*", InprocAgentNode(role_to_agent=rta))
rc.register_agent("Agent0", role_ir, graphs)
await rc.start()
rc.trigger_protocol("Agent0", trigger)
```

See `runtime/py/` for implementations and `runtime/ts/test/python/runtime-core/test_runtime_core.py` for E2E tests.