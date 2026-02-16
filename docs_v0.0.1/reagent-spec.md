# Reagent v0.0.1

Reagent is a language, compiler and runtime for hybrid distributed multiagent protocols.

**Core problem:**

- In distributed programming there is often **no single artifact** that describes the distributed algorithm (“the protocol”).
- Instead you typically have separate implementations per side/role (client/server/worker/etc.), which makes it harder to:
  - review the whole protocol,
  - debug the communcation,
  - render it,
  - evolve it safely,
  - reuse it as knowledge.

**Approach:**

- Use a **single protocol artifact** written in a DSL that is both human-readable and renderable.
- Mix protocol text and code, “React-like”: **protocol + function blocks** in one file (analogy: `jsx` mixing HTML + JS).
- Several logical layers which can be used separately
  - Protocol level. Language level -- rgx files with protocol DSL and code inserts.
  - Role level. Role definition files. Describes interfaces for participants in the given role. What messages in what format to emit and to expect.
  - Agent level. Here we have state machine description with functional code blocks of event (message) processing.
  - Execution level. Here we have a state machine engine which can execute agent level state machine description.

## Language Specification

### **Protocol level**

- .rgx file with protocol description
- **participants** and language they operate in (for v0.1, for v0.2 we can use autotranslation during compiling)
- The protocol defines
  - sequence of communication acts,
  - control flow,
  - message structures
- Communication act can be
  - Container
    - Alt
    - Loop
    - Parallel
  - Invocation
    - Run child protocol
  - Atomic
    - Subagent creation
    - Message send
    - Message await
    - Inner operation
- The **protocol** language itself follows mermaid sequence diagram syntax
- **Code blocks**: optional (absense makes not implemented sections during compilation) **code blocks** (functions/handlers) used by the protocol
- The protocol defines message schema (similar to FIPA ACL)

### **Role level**

At the participant interface level protocol is translated into boundary events: awaiting and emitting messages.

* rgxr file and corresponding ReagentRole interface

### **Agent level**

Protocol is translated into event flow inside an agent. Receiving of message is an event, sending of message is an event, starting or finishing inner operation is an event. Protocol synchronizes event flow of several agents. Event flow at the other hand defines a state machine inside and agent.

Agent may play (implement) several roles. It will dictate event flow structure of the agents and will define the graph of state transitions. After each event there can be event handler. For some events they are default (e.g. income_message leads to on_message_receive, message_send leads to on_message_send).

This logic defines language abstract event based state machine. This is not formal FSM, bu an event driven processing engine.

.rgxa file contains formal specification of that state machine.

List of blocks in the state machine:

- Send message
- Receive message
- If
- Action -- action is any executable operation
- Guard -- guard is an awaiting operation block which allows to write complicated conditions on starting actions

List of event types:

- custom_event -- custom user event
- message_received
- message_send

### **Execution level**

At the execution level we have a runtime engine and compiled implementation of .rgxa file into specified language.

## Runtime

We want to use losos as an agent runtime. It is kotlin based executing engine. 

**Conceptually:**

- Protocol = *distributed algorithm specification*.
- Functions = *local computations/tools used at steps*.

Reagent is inspired by Gaya methodology of MAS design (https://www.cs.ox.ac.uk/people/michael.wooldridge/pubs/jaamas2000b.pdf)

Разобрать дополнительно:

В идеале Reagent runtime должен уметь:

- логировать шаги как event trace,
- валидировать, что шаг легален,
- обнаруживать расхождение между “спекой” и “реальностью”.
  Это прямой канал данных для habita (оптимизация) и для отладки

тут какая то поддержка OpenTelemtry с кастомной интеграцией с этими слоями movie/protocol?

5.1. Строгая типизация сообщений и версионирование схем

Протокол без строгих контрактов превращается в чат.
Тебе нужен слой:
•	MessageType + schema (json schema / protobuf / pydantic),
•	versioning,
•	backward compatibility.

5.2. Генерация:
•	stub’ов ролей,
•	тест-харнесов,
•	симулятора протокола.

Чтобы можно было запускать “протокол в песочнице” без LLM и смотреть:
•	тупики,
•	таймауты,
•	некорректные ветки.

Очень логично сделать “movie” частным случаем протокола (?):
•	план = протокол “исполнение интента”
•	шаги = сообщения/действия
•	у каждого шага есть preconditions/effects/rollback

Тогда твой стек становится единым: и коммуникация, и планы, и сценарии.

## Tracing

- Message in reagent protocols has their own traice id
- Causal sequence may include several computations and protocol instances, some of them may be mixed

## M1 — Formal core (runtime contract)

This section formalizes the **engine-neutral** core needed to execute and validate Reagent protocols.
It defines:
- a **core data model**,
- a unified **TraceEvent algebra** (the observable truth),
- what “**legal** step” means,
- minimal assumptions about **time** and **failures**,
- **idempotency** rules required for durable, restartable execution.

### Core entities

- **ProtocolSpec**: a versioned, human-authored protocol artifact (global view).
- **Role**: a named participant type (e.g. `buyer`, `seller`).
- **ParticipantId**: concrete runtime identity implementing a role.
- **ProtocolInstance**: one execution of a ProtocolSpec with bound participants.

For each protocol instance `i`:
- `instanceId`: globally unique id (UUID recommended).
- `specId`, `specVersion`: identify the ProtocolSpec.
- `bindings`: map `Role -> ParticipantId`.
- `trace`: an **append-only** sequence of TraceEvents.

### Message types and schema/versioning

Each message has:
- `messageType`: stable name (string).
- `schemaRef`: pointer to schema (JSON Schema / Protobuf / etc.).
- `version`: semantic version.
- `compatPolicy`: at minimum one of:
  - `backward` (newer can read older),
  - `forward` (older can read newer),
  - `none` (exact match required).

**Runtime rule:** if an incoming message is not compatible with the expected `(messageType, version)` at the current instance state,
the engine MUST record a violation TraceEvent (`ProtocolViolated`) and MUST NOT advance the protocol state.

### TraceEvent algebra (observable truth)

All engines MUST be able to emit these events (or a compatible superset) and persist them durably.

Event kinds (minimum set):
- `ProtocolStarted`
- `ProtocolCompleted`
- `MessageSent`
- `MessageReceived`
- `ActionStarted`
- `ActionFinished`
- `GuardOpened`
- `GuardSatisfied`
- `GuardTimedOut`
- `TimerScheduled`
- `TimerFired`
- `ProtocolViolated`

Each TraceEvent MUST include:
- `instanceId`
- `eventId` (unique within instance; UUID or monotonic sequence)
- `kind`
- `ts` (timestamp)
- optional `role`, `participantId`
- optional `cause` links (see below)

**Causality links:** an event MAY reference one or more prior events as its `causes`.
For example, `MessageReceived` is caused by the transport delivering a message; `ActionFinished` is caused by `ActionStarted`, etc.

### Legality (what steps are allowed)

Execution is modeled as a labeled transition system (LTS):

\[
\langle i, \sigma, T \rangle \xrightarrow{e} \langle i, \sigma', T \cdot e \rangle
\]

Where:
- `i` is a ProtocolInstance,
- `σ` is engine state (program counter(s), open guards, pending waits, timers, etc.),
- `T` is the current trace,
- `e` is a TraceEvent.

**Legal step:** a step is legal iff there exists a transition rule from `σ` producing `e`.
If a step is attempted that is not legal, the engine MUST emit:
- `ProtocolViolated(ruleId, evidence)` and MUST NOT advance `σ`.

### Time and failure model (minimum)

Engines MUST support timeouts as first-class:
- scheduling a timer produces `TimerScheduled`,
- firing produces `TimerFired`,
- guard timeouts produce `GuardTimedOut` (or `ProtocolViolated` if timeout is illegal in that context).

Engines MUST assume crashes/restarts can happen between any two events.
Therefore, action execution must be at-least-once unless explicitly stronger guarantees are provided.

### Idempotency and deduplication

To make restarts safe, engines MUST support idempotency keys for:
- messages (dedupe by `messageId` within `instanceId`),
- actions (dedupe by `actionId` + `idempotencyKey` within `instanceId`).

**Rule:** re-submitting the same action completion with the same idempotency key MUST NOT create a second logical completion in trace/state.

## M1 — Language specification (protocol level)

**Update:** Reagent v0 **does not** follow Mermaid as the surface language.
We keep Mermaid compatibility as an optional *rendering* target later, but the canonical source syntax is a dedicated Reagent DSL.

See `projects/reagent/lang-spec.md` for:
- BNF/EBNF,
- AST JSON Schema,
- TypeScript parser prototype.

### Design principles

- **Reagent-first**: protocol source is written in Reagent DSL.
- **Props dict**: steps carry a dict payload (for compiler/runtime hooks).
- **Compilation target**: protocol-level is compiled into agent-level IR (see next milestones).

### Message step syntax

Canonical syntax:

```reagent
A --> B: MessageName = { onSend: {...}, onReceive: {...} }
```

Semantics:
- `onSend` runs in role `A` after `MessageSent` is recorded.
- `onReceive` runs in role `B` after `MessageReceived` is recorded.

### Example: “task execution” protocol (user → comma → sia)

Textual protocol artifact example (Reagent DSL).
Scenario:
1) `user` sends a task request to `comma`.
2) `comma` greets and acknowledges.
3) `comma` runs an internal action: convert user task into `DSI/BSI`.
4) `comma` sends the resulting structured intent to `sia`.

```reagent
protocol TaskExecution {
  participants: user, comma, sia
  initiator: user
  input: TaskRequest

  user { ctx.taskText = $input.text }
  user --> comma: TaskRequest = { }

comma --> user: Greeting = {
  onSend: { call: "comma.onAck", args: { text: "Hi! I'll do it now." } }
}

comma {
  // internal step: turn user task into DSI/BSI
  const dsiBsi = taskToDsiBsi(ctx.taskText)
}

comma --> sia: SubmitIntent = {
  onSend: { call: "comma.onSubmitIntent", args: { ref: "$ctx.dsiBsi" } },
  onReceive: { call: "sia.onIntent", args: { ref: "$msg.intent" } }
}
}
```

Notes:
- `$msg.*` and `$ctx.*` are placeholders for compile-time-defined variable binding rules (to be fixed in M2 IR).
- `comma { ... }` is an agent functional zone (stored as raw text in AST v0); it must compile into one or more `ActionStarted/ActionFinished` steps.

