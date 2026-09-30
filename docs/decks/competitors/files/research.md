# Multi-agent orchestration competitors — research notes

Дата среза: 2026-09-30.

## Исследовательский вопрос

Какие платформы одновременно:

1. позволяют **описать сценарий взаимодействия нескольких агентов**;
2. имеют **runtime, который этот сценарий исполняет**;
3. отделяют хотя бы часть coordination logic от внутреннего prompt/tool loop агента?

В анализ не включаются:

- только wire-протоколы (`MCP`, `A2A`, `ACP`) без сценария взаимодействия;
- только single-agent SDK;
- только workflow engines без first-class agent abstractions;
- только sandbox/code runtimes без orchestration runtime.

## Главный вывод

Рынок не пуст. Существуют три зрелые линии:

1. **Graph/workflow runtimes** — LangGraph, Microsoft Agent Framework, Google ADK, CrewAI Flows.
2. **Agent-team/swarm runtimes** — AutoGen, CrewAI Crews, OpenAI Agents SDK, CAMEL, AgentScope.
3. **Protocol/organization systems** — JADE/FIPA interaction protocols, JaCaMo/Moise.

Однако почти все современные системы описывают **execution graph приложения**
или **policy выбора следующего агента**. Редко встречается отдельный глобальный
артефакт, который одновременно задаёт роли, допустимые сообщения, порядок
взаимодействия и проекции поведения для каждого участника.

Это и есть потенциальная ниша Reagent — но не доказательство отсутствия
конкурентов.

## Матрица

| Platform | Как описывается interaction | Runtime | Durability / distribution | Что пересекается с Reagent | Главное отличие |
|---|---|---|---|---|---|
| **LangGraph** | Code-first state graph: nodes, edges, conditional routing, `Command` | Graph runtime, streaming, interrupts, Agent Server | Strong checkpointing; persistent stores; scalable workers | Deterministic + agentic steps, branching, HITL, traces | Application workflow, не global role/message choreography |
| **Microsoft Agent Framework** | Typed executors + edges; Sequential, Concurrent, Handoff, Group Chat, Magentic | BSP/superstep workflow runtime, events, Durable Task extension | Checkpoints; persistent sessions; distributed stateless workers | Typed routing, fan-out/in, durable agents, HITL | Typed workflow graph; protocol не отдельный cross-party contract |
| **Dapr Agents** | Code-first Dapr workflows, child agents, typed message routers, pub/sub | Workflow-backed `DurableAgent`, virtual actors, `AgentRunner` | Checkpointing, retries, recovery, independent distributed services | Durable protocol instances, identity/state, event-driven collaboration | Сильный runtime, но нет concise global choreography / role projection |
| **AutoGen** | Teams: GraphFlow, SelectorGroupChat, Swarm, RoundRobin | AgentChat over Core agent runtime | Local runtime; experimental gRPC distributed runtime | Graph, group chat, handoffs, dynamic teams, message runtime | Graph controls who acts, but by default not what messages they receive |
| **Google ADK** | Graph workflows; Sequential, Parallel, Loop; dynamic workflows | Runner + events/session services + resumable Apps | Persistent sessions; opt-in workflow resume; cloud deployment | Explicit topology, checkpointed nodes, remote participants | Graph/composition code, не global typed conversation |
| **CrewAI** | Crew roles/tasks/process; Flows via decorators, routing, JSONC/YAML config | Crew kickoff + event-driven Flow runtime | Flow state persistence, resume/fork, HITL patterns | Role teams, sequential/hierarchical processes, stateful flows | Task/project model; message choreography и per-role projections отсутствуют |
| **OpenAI Agents SDK** | Handoffs or agents-as-tools, usually code-first | `Runner` loop executes tools and handoffs | Run/session state; no comparable explicit durable workflow runtime in core SDK | Lightweight delegation and manager/specialist patterns | Deliberately minimal; coordination remains in code/model decisions |
| **JADE + FIPA** | Standard interaction protocols, ACL performatives, initiator/responder role behaviours | Distributed Java agent containers, AMS/DF, message queues | Distributed containers; mature messaging; limited modern workflow durability | Explicit interaction FSMs, protocol roles, out-of-sequence handling | Protocol templates implemented as Java behaviours; weak global custom DSL/tooling |
| **JaCaMo + Moise** | XML organizational spec: structural, functional, normative dimensions | Organization artifacts enforce roles, missions, norms | Distributed MAS infrastructure; organizational state | Separate enforceable organization artifact, roles, goals, norms | Organization/mission semantics, not typed message choreography |
| **MetaGPT** | SOP encoded via roles, actions, `_watch` subscriptions and Team | Environment/message runtime, rounds and budgets | Primarily application-local | Roles, structured handoffs, explicit SOP idea | SOP remains Python/prompt architecture; domain-heavy |
| **ChatDev** | JSON-configured ChatChain → phases → two-role dialogues | Phase/ChatChain execution with shared environment | Primarily application-local | Scenario config, roles, prescribed communication phases | Research/domain workflow, not general distributed protocol runtime |
| **CAMEL Workforce** | Dynamic task decomposition + coordinator assignment; RolePlaying workers | Workforce task lifecycle; tool/code sandbox runtimes | Parallel workers; remote runtime mainly for tools/code | Swarm lifecycle, role collaboration, HITL | Planner-driven task graph, not an interaction contract |
| **AgentScope** | Sequential/Fanout pipelines + `MsgHub` broadcast | Async Python pipelines and agent calls | In-process async; no native multi-node orchestration runtime evidenced | Multi-agent pipeline and conversation hub | Lightweight library; scenario semantics live in Python |

## Direct competitors

### 1. LangGraph

**Why direct:** strongest production-oriented graph runtime for long-running,
stateful, branching agent workflows.

- Explicit normal and conditional edges.
- Multi-agent patterns: network, supervisor, hierarchy, custom workflows.
- Checkpoints at graph supersteps; persistent Postgres/SQLite savers.
- Interrupt/resume and Agent Server with durable queue workers.

**Reagent gap vs LangGraph:** durability, deployment, ecosystem, operational
runtime.

**Reagent opportunity:** global role/message choreography as a standalone
artifact rather than application state graph.

### 2. Microsoft Agent Framework

**Why direct:** typed workflow graph plus built-in multi-agent orchestration
patterns and checkpoint runtime.

- Sequential, Concurrent, Handoff, Group Chat, Magentic.
- Typed executor inputs/outputs and edge validation.
- BSP/superstep semantics.
- Checkpoint storage and resume.
- HITL request/response mechanism.

**Reagent gap:** runtime reliability, typed edge enforcement, checkpointing,
enterprise packaging.

**Reagent opportunity:** protocol-first source, role projection, explicit
messages and participant resolution.

### 3. Dapr Agents

**Why direct:** наиболее важный runtime-конкурент, отсутствовавший в ранних
списках Reagent.

- `DurableAgent` исполняется поверх Dapr Workflows.
- LLM/tool interactions и workflow state checkpointed.
- Automatic retries, recovery и deterministic replay semantics.
- Каждый agent может быть independent service с Pub/Sub lifecycle.
- Virtual actors дают distributed identity and state.
- Typed `message_router` schemas валидируют входящие CloudEvents.

**Reagent gap:** Dapr уже закрывает durability, recovery, scaling и
event-driven distribution.

**Reagent opportunity:** дать над Dapr-подобной инфраструктурой concise global
choreography и compiler-generated role contracts.

### 4. AutoGen

**Why direct:** broadest set of agent-team execution patterns on a real message
runtime.

- `GraphFlow`: sequential, parallel, conditional, loops.
- `SelectorGroupChat`: LLM selects next speaker.
- `Swarm`: decentralized handoffs.
- Core runtime supports agent lifecycle and messaging.
- Experimental distributed gRPC runtime.

**Important nuance:** GraphFlow controls which agent executes, but official docs
state that by default all graph messages are broadcast to all agents. It is
therefore an execution graph, not a strict communication protocol.

### 5. Google ADK

**Why direct:** explicit deterministic workflow agents embedded in an agent
runtime.

- Declarative graph workflows with nodes, edges, routes and joins.
- `SequentialAgent`, `ParallelAgent`, `LoopAgent`.
- Dynamic workflows for code-driven orchestration.
- Shared `InvocationContext`, events and session state.
- Persistent database or Vertex session services.
- Opt-in workflow resumption tracks completed nodes/events; interrupted work can
  rerun and therefore requires idempotent side effects.

**Reagent opportunity:** move beyond composition tree into explicit legal
communications and per-role protocol state.

### 6. CrewAI

**Why direct:** roles + tasks + process + runtime, with configuration outside
some agent internals.

- Crews: role-based autonomous teams.
- Sequential and hierarchical processes.
- JSONC/YAML task and agent configuration.
- Flows: event-driven routing, conditions, persistence and resume.

**Important nuance:** CrewAI itself recommends wrapping production Crews in a
Flow. The production abstraction is therefore close to a standard workflow
around agent teams.

### 7. JADE/FIPA and JaCaMo/Moise

Они менее похожи на современный LLM framework, но концептуально ближе многих:

- JADE исполняет FIPA interaction protocols через initiator/responder FSMs.
- Moise хранит отдельную organizational specification и runtime-enforces роли,
  миссии, схемы и нормы.

Игнорировать эту линию нельзя: утверждение «никто раньше не делал
first-class interactions/roles» было бы неверным.

## Adjacent, not direct

### MCP / A2A / ACP

Wire/discovery/tool protocols. Отвечают на вопрос **как соединиться и передать
сообщение**, но не **какой глобальный сценарий разрешён**.

### Scribble / MPST / session types / Choral

Формальные choreography/session-type системы. Они сильнее в projection и
communication safety, но обычно не являются LLM-agent platform с batteries-
included runtime, registry, MCP hosts и operational control plane.

### Temporal / Restate / Camunda

Сильные durable workflow runtimes. Не agent-first, но именно с ними нужно
сравнивать обещания durability, recovery и audit.

## Claims Reagent must not make

- «У Reagent нет конкурентов».
- «Никто не описывает multi-agent workflows».
- «Никто раньше не делал interaction protocols или role organizations».
- «Reagent уже надёжнее LangGraph / Microsoft Agent Framework».
- «Typed messages полностью enforced» — в текущем v0 schemas largely documentary.
- «Формальная верификация покрывает поведение host-language zones».
- «Distributed runtime автоматически означает durable execution».

## Defensible positioning

> Reagent is a protocol layer for agent systems: a standalone global
> choreography that compiles into role-local execution and is enforced by a
> runtime.

Ключевая ось — не «есть ли workflow», а:

1. является ли interaction **отдельным versioned artifact**;
2. описывает ли он **global conversation**, а не только application graph;
3. задаёт ли **legal messages and roles**, а не только порядок вызова функций;
4. может ли runtime **проецировать и enforce** локальное поведение участников;
5. можно ли **inspect / audit / verify** protocol независимо от agent internals.

## Primary sources

### Modern frameworks

- LangGraph overview: https://docs.langchain.com/oss/javascript/langgraph/overview
- LangGraph multi-agent patterns: https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/multi_agent.md
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph checkpointers: https://docs.langchain.com/oss/python/langgraph/checkpointers
- LangGraph Agent Server: https://docs.langchain.com/langsmith/agent-server
- Microsoft Agent Framework orchestrations: https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/
- Microsoft workflow concepts: https://learn.microsoft.com/en-us/agent-framework/concepts/workflows/
- Microsoft builder/execution: https://learn.microsoft.com/en-us/agent-framework/concepts/workflows/builder-and-execution
- Microsoft checkpoints: https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints
- Microsoft Durable Extension: https://learn.microsoft.com/en-us/agent-framework/integrations/durable-extension
- Dapr Agents introduction: https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-introduction/
- Dapr Agents core concepts: https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-core-concepts/
- Why Dapr Agents: https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-why/
- AutoGen GraphFlow: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html
- AutoGen teams: https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.teams.html
- AutoGen Swarm: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html
- AutoGen Core runtime: https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/agent-and-agent-runtime.html
- Google ADK Sequential: https://google.github.io/adk-docs/agents/workflow-agents/sequential-agents/
- Google ADK Parallel: https://google.github.io/adk-docs/agents/workflow-agents/parallel-agents/
- Google ADK Loop: https://google.github.io/adk-docs/agents/workflow-agents/loop-agents/
- Google ADK custom workflows: https://google.github.io/adk-docs/agents/custom-agents/
- Google ADK sessions: https://google.github.io/adk-docs/sessions/session/
- Google ADK graph workflows: https://adk.dev/graphs/
- Google ADK workflow resume: https://adk.dev/runtime/resume/
- CrewAI processes: https://docs.crewai.com/v1.14.7/en/concepts/processes
- CrewAI crews: https://docs.crewai.com/v1.15.17/en/concepts/crews
- CrewAI Flow state: https://docs.crewai.com/v1.15.17/en/guides/flows/mastering-flow-state
- CrewAI production architecture: https://docs.crewai.com/edge/en/concepts/production-architecture
- OpenAI Agents SDK orchestration: https://openai.github.io/openai-agents-python/multi_agent/
- OpenAI Agents SDK runner: https://openai.github.io/openai-agents-python/ref/run/
- AgentScope pipelines: https://doc.agentscope.io/tutorial/task_pipeline.html
- CAMEL Workforce: https://docs.camel-ai.org/key_modules/workforce
- MetaGPT repository: https://github.com/FoundationAgents/MetaGPT
- MetaGPT paper: https://arxiv.org/html/2308.00352v7
- ChatDev paper: https://arxiv.org/html/2307.07924v5

### Classical MAS / formal adjacency

- JADE technical description: https://jade.tilab.com/technical-description/
- JADE protocol API: https://jade-project.gitlab.io/API/jade/proto/package-summary.html
- JADE Contract Net: https://jade-project.gitlab.io/API/jade/proto/ContractNetInitiator.html
- Moise: https://moise-lang.github.io/
- Moise specification: https://www.emse.fr/~boissier/enseignement/maop14/DOC/moise/specification/moise-spec.pdf

