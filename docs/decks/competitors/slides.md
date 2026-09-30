---
theme: seriph
title: Multi-Agent Platforms — Scenarios, Protocols, Runtimes
class: text-center
transition: slide-left
exportFilename: competitors
drawings:
  persist: false
---

# Кто управляет разговором агентов?

## Сценарии, протоколы и runtime-ы мультиагентных платформ

<div class="pt-7 text-xl opacity-80">
Конкурентная карта для Reagent
</div>

<div class="abs-br m-6 text-sm opacity-50">
Research snapshot · 30 September 2026
</div>

<!--
Цель деки — не доказать, что Reagent уникален. Цель — точно найти слой,
на котором он может быть полезен и отличим.
-->

---
transition: slide-left
---

# Одна задача — пять разных артефактов

Нужно выполнить один сценарий: **research → parallel review → approval → publish**.

```mermaid {scale: 0.62}
sequenceDiagram
    participant U as Human
    participant R as Researcher
    participant V1 as Reviewer A
    participant V2 as Reviewer B
    participant A as Approver
    U->>R: Research request
    par Independent reviews
      R->>V1: Draft
      R->>V2: Draft
    end
    V1-->>A: Review
    V2-->>A: Review
    A-->>U: Approved result
```

<div class="grid grid-cols-5 gap-2 mt-5 text-center text-sm">
  <div class="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20"><b>LangGraph</b><br/><span class="opacity-65">state graph</span></div>
  <div class="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20"><b>AutoGen</b><br/><span class="opacity-65">team / GraphFlow</span></div>
  <div class="p-3 rounded-lg bg-green-500/10 border border-green-500/20"><b>CrewAI</b><br/><span class="opacity-65">Crew + Flow</span></div>
  <div class="p-3 rounded-lg bg-orange-500/10 border border-orange-500/20"><b>JADE</b><br/><span class="opacity-65">protocol behaviours</span></div>
  <div class="p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20"><b>Moise</b><br/><span class="opacity-65">organization scheme</span></div>
</div>

<!--
Функционально эти системы могут решить одну задачу. Конкуренция начинается
не с feature checklist, а с вопроса: какой артефакт становится source of truth?
-->

---
transition: slide-left
layout: center
---

# Настоящий конкурент = descriptor + runtime

<div class="grid grid-cols-2 gap-8 mt-10">
  <div class="p-6 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="text-xl font-bold text-blue-300">Descriptor</div>
    <div class="mt-3 opacity-75">Как зафиксированы роли, порядок, branching, delegation и допустимые коммуникации?</div>
  </div>
  <div class="p-6 rounded-xl bg-green-500/10 border border-green-500/20">
    <div class="text-xl font-bold text-green-300">Runtime</div>
    <div class="mt-3 opacity-75">Кто исполняет, маршрутизирует, сохраняет состояние, восстанавливает и наблюдает swarm?</div>
  </div>
</div>

<div class="mt-10 text-lg opacity-75">
MCP/A2A без orchestration и single-agent SDK без scenario model — смежные слои, не прямые конкуренты.
</div>

---
transition: slide-left
---

# Три линии развития

<div class="grid grid-cols-3 gap-5 mt-8">
  <div class="p-5 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="font-bold text-blue-300 text-lg">Workflow / graph</div>
    <div class="mt-3 text-sm opacity-75">LangGraph<br/>Microsoft Agent Framework<br/>Dapr Agents<br/>Google ADK<br/>CrewAI Flows</div>
    <div class="mt-4 text-xs opacity-55">Primary artifact: application execution graph</div>
  </div>
  <div class="p-5 rounded-xl bg-purple-500/10 border border-purple-500/20">
    <div class="font-bold text-purple-300 text-lg">Teams / swarms</div>
    <div class="mt-3 text-sm opacity-75">AutoGen<br/>CrewAI Crews<br/>OpenAI Agents SDK<br/>CAMEL / AgentScope</div>
    <div class="mt-4 text-xs opacity-55">Primary artifact: team policy and delegation</div>
  </div>
  <div class="p-5 rounded-xl bg-orange-500/10 border border-orange-500/20">
    <div class="font-bold text-orange-300 text-lg">Protocols / organizations</div>
    <div class="mt-3 text-sm opacity-75">JADE + FIPA<br/>JaCaMo + Moise<br/>Scribble / MPST<br/>Choral</div>
    <div class="mt-4 text-xs opacity-55">Primary artifact: legal interaction or organization</div>
  </div>
</div>

<div class="mt-8 p-4 rounded-lg bg-gray-800/50 text-center">
LLM frameworks дали новую волну автономии. Protocol systems напоминают, что coordination — отдельная инженерная дисциплина.
</div>

---
transition: slide-left
---

# По каким осям сравниваем

<div class="grid grid-cols-2 gap-x-10 gap-y-4 mt-6">
  <div><b class="text-blue-300">1. Source of truth</b><br/><span class="text-sm opacity-70">код, graph, config, SOP или protocol artifact</span></div>
  <div><b class="text-blue-300">2. Global view</b><br/><span class="text-sm opacity-70">виден ли весь разговор или только локальные handlers</span></div>
  <div><b class="text-blue-300">3. Communication semantics</b><br/><span class="text-sm opacity-70">messages/roles enforced или просто function outputs</span></div>
  <div><b class="text-blue-300">4. Control</b><br/><span class="text-sm opacity-70">deterministic edges, model routing, handoff, norms</span></div>
  <div><b class="text-blue-300">5. Durability</b><br/><span class="text-sm opacity-70">checkpoint, resume, queue, crash recovery</span></div>
  <div><b class="text-blue-300">6. Distribution</b><br/><span class="text-sm opacity-70">один process, workers, multi-node agent runtime</span></div>
  <div><b class="text-blue-300">7. Verification</b><br/><span class="text-sm opacity-70">type checks, graph validation, conformance, formal model</span></div>
  <div><b class="text-blue-300">8. Operability</b><br/><span class="text-sm opacity-70">deploy, tracing, HITL, debugging, ecosystem</span></div>
</div>

<div class="mt-7 text-sm opacity-55 text-center">
«Есть multi-agent» — слишком слабый критерий. Важно, что именно runtime обещает сохранить и enforce.
</div>

---
transition: slide-left
---

# Карта рынка

<div class="text-sm opacity-60 mb-4">Качественная карта: не benchmark и не ranking adoption</div>

<div class="grid grid-cols-2 gap-4">
  <div class="p-4 rounded-xl border border-green-500/30 bg-green-500/8">
    <div class="font-bold text-green-300">Сильный production runtime</div>
    <div class="text-sm mt-2">LangGraph · Microsoft Agent Framework · Dapr Agents</div>
    <div class="text-xs mt-2 opacity-60">Durability и workflow control сильнее protocol semantics</div>
  </div>
  <div class="p-4 rounded-xl border border-purple-500/30 bg-purple-500/8">
    <div class="font-bold text-purple-300">Богатые multi-agent patterns</div>
    <div class="text-sm mt-2">AutoGen · Google ADK · OpenAI Agents SDK</div>
    <div class="text-xs mt-2 opacity-60">Teams, handoffs, managers, loops; choreography обычно code-first</div>
  </div>
  <div class="p-4 rounded-xl border border-orange-500/30 bg-orange-500/8">
    <div class="font-bold text-orange-300">Явный interaction / organization contract</div>
    <div class="text-sm mt-2">JADE/FIPA · JaCaMo/Moise · MPST/Scribble</div>
    <div class="text-xs mt-2 opacity-60">Сильные semantics; слабее современный LLM/cloud DX</div>
  </div>
  <div class="p-4 rounded-xl border border-blue-500/30 bg-blue-500/8">
    <div class="font-bold text-blue-300">Целевая позиция Reagent</div>
    <div class="text-sm mt-2">Global choreography + role runtime + agent integrations</div>
    <div class="text-xs mt-2 opacity-60">Позиция убедительна только после hardening durability и enforcement</div>
  </div>
</div>

---
transition: slide-left
---

# LangGraph и Microsoft Agent Framework

## Самые сильные конкуренты на runtime-слое

<div class="grid grid-cols-2 gap-6 mt-5">
  <div class="p-5 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="font-bold text-blue-300 text-lg">LangGraph</div>
    <ul class="text-sm mt-3 opacity-80">
      <li>state graph + conditional routing</li>
      <li>checkpoints на supersteps</li>
      <li>interrupt / resume / time travel</li>
      <li>durable queue workers в Agent Server</li>
    </ul>
    <div class="mt-4 text-xs opacity-55">Граф хранит состояние приложения; agents часто являются nodes/tools.</div>
  </div>
  <div class="p-5 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
    <div class="font-bold text-cyan-300 text-lg">Microsoft Agent Framework</div>
    <ul class="text-sm mt-3 opacity-80">
      <li>typed executors + edges</li>
      <li>Sequential / Concurrent / Handoff / Group Chat / Magentic</li>
      <li>BSP superstep execution</li>
      <li>Durable Task: sessions, recovery, distributed workers</li>
    </ul>
    <div class="mt-4 text-xs opacity-55">Очень близко к typed workflow runtime; global protocol не отдельный artifact.</div>
  </div>
</div>

<div class="mt-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-center text-sm">
Reagent сегодня проигрывает обоим в crash recovery, packaging и operational maturity.
</div>

<div class="abs-br m-5 text-[10px] opacity-45">
Sources: LangGraph persistence · Microsoft Workflow concepts / Durable Extension
</div>

<!--
Не называем эти системы «просто графами». У них серьёзные runtime guarantees.
Отстройка Reagent должна быть на semantic artifact, а не на наличии branching.
-->

---
transition: slide-left
---

# Dapr Agents: сильный runtime без protocol DSL

<div class="grid grid-cols-2 gap-6 mt-6">
  <div class="p-5 rounded-xl bg-green-500/10 border border-green-500/20">
    <div class="font-bold text-green-300 text-lg">Что уже решено</div>
    <ul class="text-sm mt-3 opacity-80">
      <li><code>DurableAgent</code> поверх Dapr Workflows</li>
      <li>checkpointed LLM и tool interactions</li>
      <li>retries, recovery, deterministic execution</li>
      <li>virtual-actor identity and state</li>
      <li>independent services + Pub/Sub</li>
    </ul>
  </div>
  <div class="p-5 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="font-bold text-blue-300 text-lg">Что остаётся code-first</div>
    <ul class="text-sm mt-3 opacity-80">
      <li>Dapr workflows and child calls</li>
      <li>message-router handlers</li>
      <li>topic and service topology</li>
      <li>нет global role/message choreography</li>
      <li>нет compiler-generated local projections</li>
    </ul>
  </div>
</div>

<div class="mt-7 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-center">
Dapr закрывает runtime-часть обещания Reagent лучше, чем Reagent сегодня. Отстройка остаётся только на protocol semantics.
</div>

<div class="abs-br m-5 text-[10px] opacity-45">
Sources: Dapr Agents Introduction · Core Concepts · Why Dapr Agents
</div>

---
transition: slide-left
---

# AutoGen и Google ADK

## Богатый словарь orchestration patterns

<div class="grid grid-cols-2 gap-6 mt-5">
  <div>
    <h3 class="text-purple-300">AutoGen</h3>
    <div class="grid grid-cols-2 gap-2 mt-3 text-sm">
      <div class="p-3 bg-purple-500/10 rounded-lg"><b>GraphFlow</b><br/><span class="opacity-65">edges, parallel, conditions, loops</span></div>
      <div class="p-3 bg-purple-500/10 rounded-lg"><b>SelectorGroupChat</b><br/><span class="opacity-65">model picks next speaker</span></div>
      <div class="p-3 bg-purple-500/10 rounded-lg"><b>Swarm</b><br/><span class="opacity-65">decentralized handoffs</span></div>
      <div class="p-3 bg-purple-500/10 rounded-lg"><b>Core runtime</b><br/><span class="opacity-65">lifecycle + messaging</span></div>
    </div>
  </div>
  <div>
    <h3 class="text-green-300">Google ADK</h3>
    <div class="grid grid-cols-2 gap-2 mt-3 text-sm">
      <div class="p-3 bg-green-500/10 rounded-lg"><b>Graph workflows</b><br/><span class="opacity-65">nodes, edges, routes, joins</span></div>
      <div class="p-3 bg-green-500/10 rounded-lg"><b>Workflow agents</b><br/><span class="opacity-65">sequential, parallel, loop</span></div>
      <div class="p-3 bg-green-500/10 rounded-lg"><b>Dynamic workflows</b><br/><span class="opacity-65">programmatic orchestration</span></div>
      <div class="p-3 bg-green-500/10 rounded-lg"><b>Resume</b><br/><span class="opacity-65">completed nodes restored; idempotency required</span></div>
    </div>
  </div>
</div>

<div class="mt-7 p-3 rounded-lg bg-gray-800/50 text-center text-sm">
AutoGen описывает team dynamics. ADK — graph/composition runtime. Оба исполняют swarm, но не требуют global message choreography.
</div>

<div class="abs-br m-5 text-[10px] opacity-45">
Sources: AutoGen GraphFlow/Swarm/Core · Google ADK graphs/resume
</div>

---
transition: slide-left
---

# CrewAI: роли есть, protocol — нет

<div class="grid grid-cols-2 gap-6 mt-7">
  <div class="p-5 rounded-xl bg-purple-500/10 border border-purple-500/20">
    <div class="font-bold text-purple-300 text-lg">Crews</div>
    <div class="mt-3 opacity-75">Agents + roles + tasks + process</div>
    <div class="mt-4 text-sm">
      <b>Sequential</b> — фиксированный порядок<br/>
      <b>Hierarchical</b> — manager delegates and validates
    </div>
  </div>
  <div class="p-5 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="font-bold text-blue-300 text-lg">Flows</div>
    <div class="mt-3 opacity-75">Event-driven application workflow</div>
    <div class="mt-4 text-sm">
      routing · conditions · state · persistence · resume/fork
    </div>
  </div>
</div>

<div class="mt-8 p-4 rounded-lg bg-green-500/10 border border-green-500/20 text-center">
CrewAI сам рекомендует для production начинать с <b>Flow</b> и встраивать Crew внутрь.
</div>

<div class="mt-5 text-center opacity-65">
Следствие: production abstraction снова становится workflow вокруг agent team.
</div>

<div class="abs-br m-5 text-[10px] opacity-45">
Sources: CrewAI Crews · Processes · Production Architecture · Flow persistence
</div>

---
transition: slide-left
---

# Swarm frameworks: SOP, planning, conversation

<div class="grid grid-cols-4 gap-3 mt-6 text-sm">
  <div class="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="font-bold text-blue-300">MetaGPT</div>
    <div class="mt-2 opacity-70">Code = SOP(Team)</div>
    <div class="mt-3 text-xs opacity-55">Roles watch upstream message/action types.</div>
  </div>
  <div class="p-4 rounded-xl bg-purple-500/10 border border-purple-500/20">
    <div class="font-bold text-purple-300">ChatDev</div>
    <div class="mt-2 opacity-70">ChatChain + phases</div>
    <div class="mt-3 text-xs opacity-55">JSON-configured role dialogues for software process.</div>
  </div>
  <div class="p-4 rounded-xl bg-green-500/10 border border-green-500/20">
    <div class="font-bold text-green-300">CAMEL</div>
    <div class="mt-2 opacity-70">Workforce</div>
    <div class="mt-3 text-xs opacity-55">Planner decomposes and coordinator assigns workers.</div>
  </div>
  <div class="p-4 rounded-xl bg-orange-500/10 border border-orange-500/20">
    <div class="font-bold text-orange-300">AgentScope</div>
    <div class="mt-2 opacity-70">Pipelines + MsgHub</div>
    <div class="mt-3 text-xs opacity-55">Sequential/fanout execution and broadcast context.</div>
  </div>
</div>

<div class="mt-8 text-lg text-center">
Они доказывают спрос на <b>structured collaboration</b>.
</div>

<div class="mt-5 p-4 rounded-lg bg-gray-800/50 text-center text-sm">
Но scenario semantics остаётся в Python/config/prompts и редко становится independently verifiable contract.
</div>

<div class="abs-br m-5 text-[10px] opacity-45">
Sources: MetaGPT · ChatDev paper · CAMEL Workforce · AgentScope pipelines
</div>

---
transition: slide-left
---

# FIPA → Reagent: protocol-first идея для современных агентов

```mermaid {scale: 0.63}
sequenceDiagram
    participant I as Initiator
    participant R1 as Responder 1
    participant R2 as Responder 2
    I->>R1: CFP
    I->>R2: CFP
    R1-->>I: PROPOSE
    R2-->>I: REFUSE
    I->>R1: ACCEPT-PROPOSAL
    R1-->>I: INFORM / FAILURE
```

<div class="grid grid-cols-3 gap-4 mt-5 text-sm">
  <div class="p-3 rounded-lg bg-orange-500/10"><b>ACL semantics</b><br/><span class="opacity-65">performative, conversation-id, ontology</span></div>
  <div class="p-3 rounded-lg bg-orange-500/10"><b>Role behaviours</b><br/><span class="opacity-65">initiator / responder state machines</span></div>
  <div class="p-3 rounded-lg bg-orange-500/10"><b>Distributed runtime</b><br/><span class="opacity-65">containers, AMS, DF, transports</span></div>
</div>

<div class="mt-6 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-center text-sm">
Reagent явно продолжает линию FIPA: переносит explicit interaction protocols в мир <b>LLM-, human- и tool-agents</b>.
</div>

<div class="abs-br m-5 text-[10px] opacity-45">
Sources: JADE Technical Description · jade.proto · ContractNetInitiator
</div>

<!--
JADE/FIPA здесь не как прямой contemporary product competitor, а как
архитектурный предшественник и явный источник вдохновения Reagent.
Новизна Reagent — применение protocol-first модели к современным агентам,
global DSL и интеграция с актуальным agent/runtime stack.
-->

---
transition: slide-left
---

# JaCaMo + Moise: организация как программа

<div class="grid grid-cols-3 gap-5 mt-7">
  <div class="p-5 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="font-bold text-blue-300">Structural</div>
    <div class="text-sm mt-3 opacity-70">roles · groups · links · cardinalities</div>
  </div>
  <div class="p-5 rounded-xl bg-green-500/10 border border-green-500/20">
    <div class="font-bold text-green-300">Functional</div>
    <div class="text-sm mt-3 opacity-70">goals · missions · schemes · sequence/choice/parallel</div>
  </div>
  <div class="p-5 rounded-xl bg-purple-500/10 border border-purple-500/20">
    <div class="font-bold text-purple-300">Normative</div>
    <div class="text-sm mt-3 opacity-70">obligations · permissions · deadlines</div>
  </div>
</div>

<div class="mt-8 text-center text-lg">
Отдельная organization specification используется и агентами, и runtime-ом, который её enforce.
</div>

<div class="mt-6 p-4 rounded-lg bg-gray-800/50 text-center text-sm">
Moise ближе к «constitutional layer». Reagent — к «conversation choreography».
</div>

<div class="abs-br m-5 text-[10px] opacity-45">
Sources: moise-lang.github.io · Moise specification · JaCaMo organization artifacts
</div>

---
transition: slide-left
---

# Сравнение современных runtime-ов

<div class="text-[12px]">

| Platform | Scenario descriptor | Durable resume | HITL | Runtime shape |
|---|---|:---:|:---:|---|
| **LangGraph** | state graph / conditional edges | ●●● | ●●● | graph workers + Agent Server |
| **MS Agent Framework** | typed executors / edges / orchestrations | ●●● | ●●● | superstep workflow runtime |
| **Dapr Agents** | durable workflows / message routers / pubsub | ●●● | ●● | actors + distributed services |
| **AutoGen** | GraphFlow / team policy / handoffs | ● | ●● | AgentChat + Core runtime |
| **Google ADK** | workflow-agent composition | ●● | ●● | Runner + session services |
| **CrewAI** | Crew process + event-driven Flow | ●● | ●● | Flow runtime + Crews |

</div>

<div class="mt-5 text-xs opacity-55">
●●● = first-class documented capability · ●● = available with explicit setup · ● = limited/core-adjacent. Qualitative snapshot, not benchmark.
</div>

<div class="mt-5 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-center text-sm">
Branching, parallelism и handoffs уже commodity. Reagent нельзя позиционировать через этот feature list.
</div>

---
transition: slide-left
---

# Где конкуренты сильнее Reagent сегодня

<div class="grid grid-cols-2 gap-x-8 gap-y-4 mt-6">
  <div class="p-3 rounded-lg bg-red-500/10"><b>Durable execution</b><br/><span class="text-sm opacity-70">checkpoint/resume на уровне шага, а не только process record</span></div>
  <div class="p-3 rounded-lg bg-red-500/10"><b>Runtime trust</b><br/><span class="text-sm opacity-70">стабильные failure semantics и production storage</span></div>
  <div class="p-3 rounded-lg bg-red-500/10"><b>Packaging</b><br/><span class="text-sm opacity-70">installable SDK, version policy, hosted deployment</span></div>
  <div class="p-3 rounded-lg bg-red-500/10"><b>Ecosystem</b><br/><span class="text-sm opacity-70">models, tools, connectors, cloud integrations</span></div>
  <div class="p-3 rounded-lg bg-red-500/10"><b>Typed enforcement</b><br/><span class="text-sm opacity-70">MSAF validates edge compatibility; Reagent message schemas пока documentary</span></div>
  <div class="p-3 rounded-lg bg-red-500/10"><b>Operational surface</b><br/><span class="text-sm opacity-70">queues, workers, auth, managed observability</span></div>
</div>

<div class="mt-8 text-center text-lg opacity-80">
Ширина архитектуры Reagent уже большая. Доверие к guarantees пока меньше.
</div>

---
transition: slide-left
---

# Где остаётся пространство для Reagent

<div class="grid grid-cols-2 gap-6 mt-6">
  <div class="p-5 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="font-bold text-blue-300">Standalone protocol artifact</div>
    <div class="text-sm mt-3 opacity-75">Coordination versioned отдельно от agent code и prompts.</div>
  </div>
  <div class="p-5 rounded-xl bg-green-500/10 border border-green-500/20">
    <div class="font-bold text-green-300">Global choreography</div>
    <div class="text-sm mt-3 opacity-75">Видно, кто кому что может отправить и в какой фазе.</div>
  </div>
  <div class="p-5 rounded-xl bg-purple-500/10 border border-purple-500/20">
    <div class="font-bold text-purple-300">Role-local projection</div>
    <div class="text-sm mt-3 opacity-75">Один protocol компилируется в локальное поведение участников.</div>
  </div>
  <div class="p-5 rounded-xl bg-orange-500/10 border border-orange-500/20">
    <div class="font-bold text-orange-300">Cross-runtime enforcement</div>
    <div class="text-sm mt-3 opacity-75">Managed, custom, gate и MCP agents под одним interaction contract.</div>
  </div>
</div>

<div class="mt-7 p-4 rounded-lg bg-gray-800/50 text-center">
Дифференциация — не «мы тоже запускаем граф», а <b>protocol is the product boundary</b>.
</div>

---
transition: slide-left
---

# Reagent должен занять отдельный слой

```mermaid {scale: 0.62}
flowchart TB
    APP["Domain application<br/>goals, UI, policies"]
    PROTO["Reagent protocol layer<br/>roles · legal messages · choreography · versions"]
    AGENTS["Agent implementations<br/>LangGraph · ADK · CrewAI · custom · humans"]
    WIRE["Connectivity protocols<br/>MCP · A2A · HTTP · NATS"]
    INFRA["Infrastructure<br/>containers · queues · databases · Kubernetes"]
    APP --> PROTO --> AGENTS --> WIRE --> INFRA
    style PROTO fill:#1e3a5f,stroke:#60a5fa,color:#fff
```

<div class="grid grid-cols-2 gap-6 mt-5 text-sm">
  <div class="p-3 rounded-lg bg-green-500/10 border border-green-500/20"><b>Не заменять agent SDK</b><br/><span class="opacity-65">подключать их как behavior hosts</span></div>
  <div class="p-3 rounded-lg bg-green-500/10 border border-green-500/20"><b>Не заменять wire protocols</b><br/><span class="opacity-65">задавать legal conversations поверх них</span></div>
</div>

---
transition: slide-left
---

# Что можно и нельзя заявлять

<div class="grid grid-cols-2 gap-7 mt-6">
  <div>
    <h3 class="text-green-300">Defensible</h3>
    <ul class="text-sm mt-3">
      <li>protocol — отдельный coordination artifact</li>
      <li>global choreography, не только app graph</li>
      <li>одна модель для heterogeneous participants</li>
      <li>путь к independent audit / conformance / verification</li>
      <li>wire-agnostic interaction layer</li>
    </ul>
  </div>
  <div>
    <h3 class="text-red-300">Не заявлять</h3>
    <ul class="text-sm mt-3">
      <li>«конкурентов нет»</li>
      <li>«никто не описывает multi-agent workflows»</li>
      <li>«первые исполняемые interaction protocols»</li>
      <li>«production durability уже решена»</li>
      <li>«typed/formal guarantees покрывают host code»</li>
    </ul>
  </div>
</div>

<div class="mt-8 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20 text-center">
Честная отстройка сильнее широкой претензии на уникальность.
</div>

---
transition: slide-left
---

# Стратегический вывод

<div class="grid grid-cols-3 gap-5 mt-7">
  <div class="p-5 rounded-xl bg-blue-500/10 border border-blue-500/20">
    <div class="text-2xl font-bold text-blue-300">1</div>
    <div class="font-bold mt-2">Сузить wedge</div>
    <div class="text-sm mt-3 opacity-70">TS-first approval-gated workflows для trusted agent teams.</div>
  </div>
  <div class="p-5 rounded-xl bg-green-500/10 border border-green-500/20">
    <div class="text-2xl font-bold text-green-300">2</div>
    <div class="font-bold mt-2">Усилить contract</div>
    <div class="text-sm mt-3 opacity-70">Typed messages, role projection conformance, branch semantics.</div>
  </div>
  <div class="p-5 rounded-xl bg-purple-500/10 border border-purple-500/20">
    <div class="text-2xl font-bold text-purple-300">3</div>
    <div class="font-bold mt-2">Догнать runtime</div>
    <div class="text-sm mt-3 opacity-70">Checkpoint/resume, CI, packaging, auth, one golden path.</div>
  </div>
</div>

<div class="mt-9 text-center text-xl">
Новые hosts и transports — после того, как protocol guarantees стали сильнее обычного workflow graph.
</div>

---
transition: slide-left
layout: center
---

# Рынок уже умеет запускать swarm

<div class="text-2xl mt-7">
Открытый вопрос — кто сможет сделать его взаимодействие
</div>

<div class="text-4xl mt-5 font-bold text-blue-300">
контрактом, а не побочным эффектом кода
</div>

<div class="mt-12 text-sm opacity-55">
Primary sources and full matrix: <code>competitors/files/research.md</code>
</div>

<!--
Финальная формула: Reagent не должен выигрывать количеством orchestration
patterns. Он должен выиграть тем, что coordination становится independently
versioned, inspectable and enforceable artifact.
-->

