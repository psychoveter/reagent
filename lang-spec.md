## Reagent language spec (v0.0.5)

This document defines the **Reagent protocol language**.

Reagent is a **meta-language**: it describes the choreography of agents, messages, and control flow.
The actual computation happens inside **agent zones** written in a **host language** chosen per participant.

Design goals:
- Human-writable, line-oriented protocol choreography.
- Extensible "props-like" dictionaries on message steps (for runtime hooks).
- **Agent functional zones** are host-language code blocks: `AgentName { ... }` (language from `participants:`).
- `$ctx` is the single runtime-injected binding — the protocol instance context.
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
  participants: roleA [ts], roleB [py], roleC [kt]
  initiator: roleA
  input: SomeMessage
  ...body...
}
```

- `participants` lists roles. Each role MUST have a **language tag** in `[brackets]`.
  Supported tags (v0): `ts`, `js`, `py`, `kt`, `*`.
  The language tag declares which host language the agent's zones are written in.
- `[*]` is the **wildcard lang tag**: it marks a role as **language-agnostic**.
  Wildcard participants participate in the choreography (sending/receiving messages) but MUST NOT have agent zone blocks (standalone or inline via `onSend`/`onReceive` hooks).
  Use `[*]` for roles whose implementation language is not fixed by the protocol — e.g. wire-only control protocols, adapters, or roles that will be bound to a concrete language at deployment time.
- `initiator` is the role that receives the external `input` message.
- `input: SomeMessage` declares the protocol's input type (protocol-as-function).

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
- Both hooks have access to `$ctx` and `reagent`. `$ctx.msg` is available in `onReceive` (bound to the received payload) and in `onSend` (bound to the outgoing message being constructed).
- Either hook may be omitted. Both may be present in the same message step.

#### Props in `alt` guards: pattern matching

Props inside `alt` guards have a **different** semantic — they act as **value patterns** for message dispatch:

```
alt (sia --> comma: ValidationError = { code: "TRANSIENT" }) { ... }
```

Here `{ code: "TRANSIENT" }` is a **pattern/guard**: the branch matches only when the incoming message has `code == "TRANSIENT"`. This is NOT a hook.

### 1.3 Agent functional zone (host-language code)

```
AgentName {
  // code in the host language declared for AgentName in participants
}
```

The language is **not** repeated on the zone — it is declared once in `participants:` (e.g. `comma [ts]`).
The zone body is written in that host language.

Zone body is **raw host-language code** — stored as text by the parser (braces are balanced, strings/comments skipped).

**Runtime injection**: the engine injects two bindings into every zone:
- `$ctx` — the protocol instance context object. `$ctx.foo` reads/writes protocol state.
- `reagent` — the **Reagent runtime library** (see §1.4).

**Important constraints**:
- Zones of **different roles** MUST NOT be adjacent without an intervening message (ordering guarantee).
- Multiple consecutive zones of the **same role** are allowed (they execute sequentially on that agent).

### 1.4 Reagent runtime library (`reagent.*`)

Every agent zone has access to the `reagent` runtime library, **auto-imported** by the engine. It provides functions for protocol-level operations, written in native host-language syntax.

The `reagent` library is the **bridge** between host-language code in zones and the Reagent protocol runtime.

#### `reagent.invoke(Proto, roles?, input)` — synchronous child protocol call

Full form (multi-party child protocol):
```
$ctx.result = reagent.invoke(ProtoName, { childRole: parentRole, ... }, inputExpr)
```

Short form (solo child or no extra roles to map):
```
$ctx.result = reagent.invoke(ProtoName, inputExpr)
```

- The zone role is the implicit invoker (mapped to the child's `initiator`).
- The roles dict maps other child roles to parent roles. **May be omitted** if the child has no other roles or all roles match by name.
- `inputExpr` is passed as `$ctx.input` to the child instance.
- The child's `reagent.return()` value is returned to the caller.
- **Synchronous**: the zone blocks until the child protocol completes.

#### `reagent.spawn(Proto, roles?, input)` — fire-and-forget child protocol

```
$ctx.handle = reagent.spawn(ProtoName, { childRole: parentRole, ... }, inputExpr)
```

Short form:
```
$ctx.handle = reagent.spawn(ProtoName, inputExpr)
```

- Same argument conventions as `reagent.invoke()`.
- **Fire-and-forget**: creates an independent protocol instance. The parent does **not** block.
- Returns a handle (for correlation/tracing). Communication happens via subsequent messages.

#### `reagent.return(value)` — return a value to the invoker

```
reagent.return(expr)
```

Sends a **return message** from the current protocol instance back to the invoker (the role that called `reagent.invoke()`). Semantically, this is a message from the child's `initiator` to the parent's invoking role. The parent receives the value as the result of `reagent.invoke()`.

This means `reagent.return()` is not just a control-flow construct — it **generates a message** in the protocol trace (e.g. `ReturnValue` from child initiator to parent invoker).

#### `reagent.emit(eventName, props)` — emit an event outward

```
reagent.emit("TaskSubmitted", { kind: "task.submitted", ref: $ctx.intent })
```

Emits a named event for tracing/observability/external consumers. The zone role is the emitter.

### 1.5 Built-in context object (`$ctx`) — runtime contract

Reagent provides **one** built-in binding: `$ctx`.

`$ctx` is an **engine-owned dict/object** representing the protocol instance state.
This is the **contract** between the Reagent language and the runtime engine.

Fixed fields (reserved by the runtime):
- `$ctx.instanceId` — protocol instance identifier (stable across restarts).
- `$ctx.input` — the external protocol input message delivered to `initiator`.
- `$ctx.msg` — the "current message" payload. **Binding rules:**
  - Bound when a role **receives** a message (`MessageReceived` event).
  - In `alt` branches: bound to the payload of the **matched** message.
  - **Lifetime**: valid from the point of receive until the next message step (send or receive) involving this role, or until the next zone boundary for this role. After that, `$ctx.msg` is `undefined`.
  - In `onReceive` hooks: always available (the hook runs immediately after receive).
  - In a zone following a receive: available if no intervening message step occurred.
- `$ctx.error` — bound inside `catch { ... }` blocks. See §1.9 for details.

User-defined fields:
- `$ctx.*` MAY contain arbitrary keys written by zone code.
  It is the protocol instance's local memory.

**Scope**: `$ctx` is lexically scoped to the protocol instance (not to an agent instance).
Inside an agent zone, the engine injects `$ctx` as a binding accessible from the host language.

### 1.6 Context propagation (important for analysis)

`$ctx` is **not broadcast** to all roles.

Operational intuition:
- A role only observes relevant `$ctx` changes when it receives a message that carries that state.
- If `A` mutates `$ctx`, then sends a message to `B` but not to `C`, `C` MUST NOT be assumed to know about that mutation.

This matters for future linters/static analysis (data-flow of knowledge/state).

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

### 1.9 Protocol-level control flow (reserved syntax)

These constructs operate at the **protocol choreography level** (outside agent zones):

#### `alt` — XOR branching

Two modes:

**Message-based (reactive)**: waits for one of several possible messages.
```
alt (B --> A: Accept = { }) {
  ...
} else (B --> A: Reject = { }) {
  ...
} else (timeout 10s) {
  ...
}
```
Props in `alt` guards act as **pattern/value matching** (not hooks). E.g. `{ code: "TRANSIENT" }` matches only messages with `code == "TRANSIENT"`.

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

#### `par` — parallel branches with join

```
par {
  ...
} and {
  ...
}
```
All branches run concurrently. The `par` completes when **all** branches complete (join semantics). `and` is a keyword separating branches.

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

---

**Not at protocol level** (handled in zones or by host-language):
- `if/else` — condition branching is done inside agent zones in host-language code.
- `break` — host-language construct; exits the runtime's `loop` via the reagent bridge.
- `throw` — host-language construct; signals a failure caught by `try/catch` via the reagent bridge.
- `spawn` — zone-only via `reagent.spawn()` (see §1.4).
- `invoke` — zone-only via `reagent.invoke()` (see §1.4).
- `return` — zone-only via `reagent.return()` (see §1.4).
- `emit` — zone-only via `reagent.emit()` (see §1.4).

### 1.10 Protocol completion

A protocol instance terminates when:
1. **`reagent.return(value)`** executes inside a zone — the protocol completes by sending a return message to the invoker. The invoking parent (if any) receives this value as the result of `reagent.invoke()`.
2. **End of `ProtocolBody`** is reached — implicit completion with no return value (`undefined`).
3. **Uncaught `throw`** (host-language) — the protocol aborts with an error (propagated to invoking parent as their `$ctx.error`).

There is no explicit "ProtocolCompleted" statement; completion is structural.

### 1.11 Host-language functions vs Reagent runtime library

Inside agent zones, there are two kinds of calls:
- **`reagent.*`** functions (`reagent.invoke`, `reagent.spawn`, `reagent.return`, `reagent.emit`) — provided by the auto-imported Reagent runtime library. These interact with the protocol engine.
- **Everything else** (e.g. `compensate(...)`, `taskToDsiBsi(...)`, `merge(...)`) — opaque host-language calls. The Reagent parser treats them as raw code.

### 1.12 Reagent as a meta-language

Reagent does **not** execute agent logic itself. It is a **meta-language** that:
1. Describes the **choreography** (who sends what to whom, in what order).
2. Embeds **host-language code** inside agent zones (executed by the engine for that language).
3. Provides **`$ctx`** and the **`reagent` runtime library** as bridges between choreography and computation.

The engine is responsible for:
- Parsing zone bodies in the appropriate host language.
- Injecting `$ctx` and `reagent` into zone execution contexts.
- Implementing the `reagent.*` API (`invoke`, `spawn`, `return`, `emit`).
- Bridging host-language `break`/`throw` to protocol-level `loop`/`try` semantics.
- Enforcing message ordering and protocol semantics.

### 1.13 Agent definition

An **agent** is a named entity that participates in one or more protocols under specific roles. Agents have:
- **Own persistent state** (`$self`) — survives across protocol instances.
- **Host language** (`[langTag]`) — all agent zones execute in this language.
- **Protocol bindings** (`plays Proto as role`) — declares which role this agent plays in each protocol.
- **Init block** (`init { ... }`) — runs once when the agent starts.
- **Lifecycle handlers** (`on <event>(<Proto>) { ... }`) — react to protocol events.

Syntax:

```
agent Comma [ts] {
  plays TaskExecution as comma
  plays HealthCheck as comma

  init {
    $self.ready = true
    $self.tasksCompleted = 0
  }

  on protocolCompleted(TaskExecution) {
    $self.tasksCompleted += 1
  }

  on protocolFailed(TaskExecution) {
    $self.lastError = $ctx.error
  }
}
```

**`$self` vs `$ctx`**:
- `$self` is the agent-level persistent state. It is accessible in `init`, `on` handlers, and also inside protocol zones where this agent participates. `$self` is scoped to the agent lifetime.
- `$ctx` is the per-protocol-instance context (unchanged from v0.0.4). `$ctx` is scoped to a single protocol run.
- Inside a protocol zone, both `$self` and `$ctx` are available, allowing the protocol to read agent config (`$self.config`) or write results back (`$self.lastResult = $ctx.result`).

**Lifecycle events**:
| Event | When |
|---|---|
| `protocolStarted(Proto)` | A protocol instance this agent participates in has started |
| `protocolCompleted(Proto)` | Protocol completed normally |
| `protocolFailed(Proto)` | Protocol ended with an error |
| `protocolEvent(eventName)` | Custom event emitted via `reagent.emit()` from any protocol this agent plays |

**Constraints**:
- An agent cannot play two different roles in the same protocol.
- Each `plays` directive binds exactly one role in exactly one protocol.
- The `init` block is optional; at most one per agent.
- Multiple `on` handlers for the same event are allowed (they run sequentially).
- `reagent.spawn()` inside an `on` handler starts a new protocol instance.

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

**Type system (minimal)**:
- Scalars: `string`, `number`, `boolean`
- Escape hatch: `any` (gradual typing — no static checks)
- Array: `type[]` (e.g. `string[]`, `{ id: number }[]`)
- Inline object: `{ field: type, ... }`
- Optional: `name?: type` (field may be absent / null)

**Structural (duck) typing**: compatibility is structural, not nominal. A message with `{ amount: number, winner: boolean }` is compatible with a receiver expecting `{ amount: number }`.

**System fields**: every message on the wire carries system fields (`instanceId`, `protocolName`, `from`, `to`, `messageName`, `ts`, `idempotencyKey`). These are implicit — the `message` definition specifies only the **user-defined payload**, the envelope is injected by the runtime.

**Backward compatible**: messages without a `message` declaration remain valid — payload is `Record<string, unknown>`. Typing is opt-in. Existing untyped protocols continue to work.

**What it enables**:
- JSON Schema generation from `message` definitions (wire validation)
- Code generation: TypeScript interfaces, Python dataclasses, Kotlin data classes from `.rg`
- The `.rg` file becomes a self-contained wire format spec
- Future: `$ctx.msg.` autocomplete in IDE

---

## 2. EBNF (v0.0.5)

```
Program         ::= (WS | Comment | ImportStmt | ProtocolDef | AgentDef | MessageDef)* EOF

ImportStmt      ::= "import" WS+ String (WS+ "as" WS+ Ident)? WS* (";" WS*)?

ProtocolDef     ::= "protocol" WS+ Ident WS* "{" ProtocolBody "}"
ProtocolBody    ::= (WS | Comment | ProtocolDirective | Item | ReservedStmt)*

ProtocolDirective ::= ParticipantsStmt | InitiatorStmt | InputStmt
ParticipantsStmt  ::= "participants" WS* ":" WS* ParticipantList
ParticipantList   ::= Participant (WS* "," WS* Participant)*
Participant       ::= Ident (WS* "[" LangTag "]")?
LangTag           ::= "ts" | "js" | "py" | "kt" | "*"
InitiatorStmt     ::= "initiator" WS* ":" WS* Ident
InputStmt         ::= "input" WS* ":" WS* Ident

Item            ::= MessageStmt | AgentZone

MessageStmt     ::= Ident WS* Arrow WS* Ident WS* ":" WS* MessageName (WS* "=" WS* MessageProps)?

MessageProps    ::= "{" WS* (HookZone | Pair)* WS* "}"
HookZone        ::= ("onSend" | "onReceive") WS* "{" ZoneBody "}"

Arrow           ::= "-->" | "->" | "->>" | "-->>"

MessageName     ::= MessageNameChar+
MessageNameChar ::= any char except '\n' and '='

AgentZone       ::= Ident WS* "{" ZoneBody "}"
ZoneBody        ::= BalancedText   // raw host-language code; braces balanced, strings/comments skipped
                                   // language is determined by the participant's [LangTag] declaration

AgentDef        ::= "agent" WS+ Ident WS* "[" LangTag "]" WS* "{" AgentBody "}"
AgentBody       ::= (WS | Comment | PlaysStmt | AgentInitBlock | AgentOnHandler)*
PlaysStmt       ::= "plays" WS+ Ident WS+ "as" WS+ Ident
AgentInitBlock  ::= "init" WS* "{" ZoneBody "}"
AgentOnHandler  ::= "on" WS+ AgentEvent WS* "{" ZoneBody "}"
AgentEvent      ::= ("protocolStarted" | "protocolCompleted" | "protocolFailed") "(" Ident ")"
                  | "protocolEvent" "(" Ident ")"

MessageDef      ::= "message" WS+ Ident WS* "{" FieldList "}"
FieldList       ::= (WS | Comment | FieldDef (",")?)*
FieldDef        ::= Ident "?"? WS* ":" WS* TypeExpr
TypeExpr        ::= ScalarType ("[]")*
                  | "any" ("[]")*
                  | "{" FieldList "}" ("[]")*
ScalarType      ::= "string" | "number" | "boolean"

ReservedStmt    ::= AltStmt | LoopStmt | ParStmt | WaitStmt | TryStmt
AltStmt         ::= "alt" .*
LoopStmt        ::= "loop" .*
ParStmt         ::= "par" .*
WaitStmt        ::= "wait" WS+ Duration
Duration        ::= Number ("ms" | "s" | "m" | "h")
TryStmt         ::= "try" .*

// Zone-only: reagent runtime library functions (reagent.invoke, reagent.spawn, reagent.return, reagent.emit)
// Also: break, throw are host-language constructs bridged by the runtime.

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

**Key changes from v0**:
- `Participant` in `ParticipantList` now carries a required `[LangTag]` (language declared per role, once).
- `AgentZone` is bare `Ident { ... }` — language is resolved from `participants:`.
- `IfStmt`, `SpawnStmt`, `BreakStmt`, `ThrowStmt` removed from protocol-level `ReservedStmt`.
- `= Object` in `MessageStmt` is now optional (bare `A --> B: Name` allowed).
- `MessageProps` replaces plain `Object` in message steps: supports `onSend { ... }` / `onReceive { ... }` as inline agent zones (host-language code blocks), in addition to key-value pairs for pattern matching in `alt` guards.
- `reagent.*` runtime library replaces magic keywords in zones (`reagent.invoke`, `reagent.spawn`, `reagent.return`, `reagent.emit`).
- `break`, `throw` are host-language constructs bridged by the runtime.

**Changes in v0.0.5**:
- `AgentDef` added as a new top-level construct (`agent Name [langTag] { ... }`).
- `PlaysStmt` binds an agent to a protocol role (`plays Proto as role`).
- `AgentInitBlock` and `AgentOnHandler` provide agent lifecycle logic.
- `$self` variable added for agent-level persistent state (accessible in agent zones and protocol zones).
- `Program` production now includes `AgentDef` alongside `ImportStmt` and `ProtocolDef`.

**Changes in v0.1.0 (M2-LANG)**:
- `[*]` **wildcard lang tag**: marks a participant as language-agnostic. Zone blocks are forbidden for `[*]` roles. Enables wire-only protocol specs (RAP, A2A).
- `MessageDef` added as a new top-level construct (`message Name { fields }`). Defines typed payload schemas with minimal type system (`string`, `number`, `boolean`, `any`, `type[]`, `{ ... }`, `name?: type`). Backward compatible — untyped messages remain valid.
- `Program` production now includes `MessageDef`.

---

## 3. Example: task execution protocol (user → comma → sia)

See `projects/reagent/examples/src/01-task-execution-basic.rg`.

---

## 4. Compiler and tooling (v0.0.5)

### 4.1 AST

The parser outputs an AST conforming to the TypeScript types at `lang/src/ast.ts`.

The full AST covers all language constructs:
- `Program` (top-level: imports + protocol definitions + agent definitions)
- `ImportStmt` (protocol `.rg` imports + code module imports)
- `ProtocolDef` (header + body), `ParticipantDecl` (name + `LangTag`)
- `MessageStmt` (sender, arrow, receiver, message name, optional `MessageProps` with `HookZone` and `PropPair`)
- `AgentZone` (standalone: role name + `lang` resolved from participants + raw body text)
- `AltStmt` (branches with `AltMessageGuard` / `AltExprGuard` / `AltTimeoutGuard` / `AltElseGuard`)
- `LoopStmt` (guard expression + body)
- `ParStmt` (branches separated by `and`)
- `WaitStmt` (duration literal)
- `TryStmt` (try body + catch label + catch body)
- `AgentDef` (agent name + lang + plays bindings + init block + lifecycle handlers)
- `PlaysDecl` (protocol name + role name)
- `AgentInitBlock` (raw zone body)
- `AgentOnHandler` (event name + optional protocol filter + raw zone body)
- `MessageDef` (message name + field definitions — typed payload schema)
- `FieldDef` (field name + type expression + optional flag)
- `TypeExpr` (`ScalarType` | `ArrayType` | `ObjectType` | `AnyType`)

Every node carries `Loc` (source location: `start: {index, line, col}`, `end: {index, line, col}`).

### 4.2 Parser

Hand-written **recursive-descent parser** in TypeScript (`lang/src/parser.ts`).
Zone bodies remain **raw text** (parser only balances braces, does not parse host language).

### 4.3 Protocol IR (v0.0.5)

The compiler produces per-role **Protocol IR** — directed graphs of states and transitions:
- `IRGraph` per role (local view of the global protocol)
- `IRState` types: `initial`, `send`, `receive`, `action`, `guard`, `fork`, `join`, `timer`, `terminal`, `error`
- `IRTransition` labels: `default`, `message`, `timeout`, `expression`, `else`, `error`, `branch`

### 4.4 Agent IR (v0.0.5)

The compiler also produces per-agent **Agent IR** — agent-level metadata that ties protocols together:
- `AgentIR`: agent name, language tag, plays bindings, init action body, lifecycle handler action bodies.
- `AgentPlaysBinding`: protocol name → role name mapping.
- `AgentLifecycleHandler`: event type + optional protocol filter + action body.
- References to protocol `IRGraph`s for each role the agent plays.

See `lang/src/ir.ts` for IR type definitions, `lang/src/ir-emitter.ts` for AST→IR, and `lang/src/ir-validator.ts` for validation.

### 4.5 CLI (`reagent-lang`)

The `@reagent/lang` package provides a CLI (`lang/dist/cli.js`) for compiling `.rg` files:

```
reagent-lang parse    <file.rg>               — parse and print AST as JSON
reagent-lang ir       <file.rg> [role]         — emit IR to stdout (optionally filter by role)
reagent-lang validate <file.rg> [role]         — emit IR, validate, print diagnostics
reagent-lang compile  <file.rg> <out-dir>      — compile to per-role and per-agent IR JSON files
```

The `compile` command produces:
- `<Proto>.<role>.ir.json` — one IRGraph per role in each protocol
- `<Agent>.agent.json` — one AgentIR per agent definition
- `deployment.json` — deployment plan mapping agents to roles and IR files

### 4.6 Reference runtimes

Lightweight **reference runners** (TypeScript and Python) interpret IR JSON directly over NATS:

- **AgentRunner** — one instance per agent. Manages `$self`, lifecycle handlers, message routing to ProtocolInstances.
- **ProtocolInstance** — interprets one IRGraph state machine per protocol instance. Has its own `$ctx`.
- **Zone Executor** — executes raw zone body strings with `$ctx`, `$self`, `reagent` in scope.
- **NATS transport** — message subjects: `reagent.msg.<instanceId>.<toAgent>.<messageName>`.

See `runtime/ts/` (TypeScript) and `runtime/py/` (Python) for implementations.

For the mapping from IR to Losos runtime primitives, see `docs/ir-to-losos-mapping.md`.
