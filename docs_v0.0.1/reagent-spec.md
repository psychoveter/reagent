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

At the execution level for a given language 


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
