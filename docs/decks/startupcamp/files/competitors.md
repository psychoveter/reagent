# Конкурентный анализ: какие проблемы адресует Reagent

Документ собран для startupcamp как материал к разговорам о позиционировании.
Структура построена **от проблем, которые Reagent решает**, а не от кластеров
похожих инструментов: для каждой проблемы есть свой пул инкумбентов, и
основная гипотеза — что Reagent уникален не на одной оси, а в **пересечении**
пяти.

Тезис Reagent (по [`docs/decks/deep-dive/takes.md`](../deep-dive/takes.md)):

> **Протокол — первичный артефакт координации.** Хореография взаимодействия
> агентов описывается в виде языка (Reagent) и исполняется Reagent
> Controller (RC) как state machine. Цель — управляемый, верифицируемый и
> наблюдаемый control plane для агентских сетей, в противовес «свободному
> ReAct-циклу».

---

## 1. TL;DR

Reagent одновременно адресует **пять разных проблем**, каждая из которых
сегодня решается отдельной семьёй инструментов. Ни один существующий
продукт не закрывает все пять.

| Проблема | Кто решает сегодня | Что у Reagent |
|---|---|---|
| **P1. Cluster management** для агентов | Kubernetes, Nomad, бытовые DIY на etcd | RC-кластер на etcd + `StateStore` + `NodeLink` + `AdminClient` |
| **P2. Workflow management** между ролями | LangGraph, n8n, Airflow, Temporal, **Camunda/BPMN** | `.rg` как **role-specified distributed workflow** с компиляцией в IR |
| **P3. Multi-agent orchestration** | LangGraph, CrewAI, **MS Agent Framework 1.0**, AutoGen→MAF, OpenAI/Claude SDKs | Протокол-state-machine с типизированными ролями и зонами |
| **P4. Contract execution** между сторонами | Smart contracts (Solidity, CosmWasm), human RFCs (IETF, W3C), OpenAPI/AsyncAPI | Исполняемый протокол: «RFC, который сам себя исполняет» — без trust-assumptions блокчейна |
| **P5. Interaction verification** | TLA+/PlusCal вручную, session types (research), **TraceFix**, **Pact**, Choral/Accompanist | `reagent verify` → TLA+/TLC встроен в pipeline; runtime advance только по легальным переходам |

И ещё две оси, где Reagent **не конкурирует, а интегрируется**:

| Адъяцентная ось | Кто там | Reagent |
|---|---|---|
| **Agent communication protocols** (wire-формат) | MCP, A2A, ACP-client, ANP | MCP уже native; A2A — must-have, в roadmap |
| **Stateful agent runtimes / memory** | Letta (бывш. MemGPT), mem0, Zep | Ортогонально; Letta как `BehaviorFactory` |

**Главный тезис позиционирования:** конкуренты сильны на одной оси из P1-P5
каждый, но **никто не закрывает все пять одновременно одним артефактом**.
Это и есть wedge Reagent. Стоимость интеграции пяти разрозненных
инструментов (k8s + LangGraph + MAF + smart contract + TLA+) в продакшен —
это то, что Reagent сжимает в один `.rg` + RC.

---

## 2. Оси сравнения

Когда говорим «лучше/хуже», имеем в виду эти оси (по которым строится
сводная матрица в §10):

| Ось | Что в ней важно |
|---|---|
| **Coordination primitive** | Контейнер / DAG / граф узлов / роль-«персона» / разговор / **протокол** / workflow / choreography |
| **Control model** | Свободный ReAct / скриптованный DSL / state machine / verifiable contract |
| **Multi-agent first-class** | Мультиагент — фундамент или поздняя надстройка? |
| **Cross-process / multi-node** | Один процесс / кластер / federation across orgs |
| **Heterogeneous host languages** | Один язык / билингвально / зоны с языковыми тегами |
| **Verification** | TLA+/формальные модели / runtime guards / отсутствует |
| **Observability** | OTel / вендорные трасеры / нет |
| **Durability / state** | Journal шагов / `$self`+state store / нет |
| **Interop** | MCP / A2A / ACP / ANP / OpenAPI / gRPC |
| **Maturity / adoption** | Прод / RC / PoC / research |

Reagent на этих осях (по состоянию [`docs/current/`](../../current/)):

- **Primitive**: протокол-state-machine + роли + зоны.
- **Control**: state machine, advance только по легальным переходам.
- **Multi-agent**: фундамент.
- **Multi-node**: etcd + `StateStore` + `NodeLink` (in-mem / WS / NATS) + `AdminClient`.
- **Heterogeneous hosts**: `LangTag` ∈ `{ts, js, py, kt, *}`; нативно `[ts]`,
  через zone-executor `[py]`; whole-agent `Role[py]` — после Rust RC + PyO3.
- **Verification**: `reagent verify` → TLA+/TLC.
- **Observability**: OTel interceptor + trace hook.
- **Durability**: `$self` + `StateStore` (etcd) + protocol-run records (CAS).
- **Interop**: MCP — есть; A2A / ACP / ANP — **отсутствуют**.
- **Maturity**: PoC TS RC; Rust RC впереди.

---

## 3. P1 — Cluster management для агентов

**Проблема:** агенты живут на разных нодах, нужно знать кто где, маршрутизировать
сообщения, переживать падения, координировать cron-тики, делать rolling
deploy без потери состояния.

### Инкумбенты

**Kubernetes** — индустриальный стандарт для контейнерного оркестратора.
Уровень абстракции — **под** (контейнер), не **агент**. У k8s нет понятия
«агент A1 умеет роль R, должен получать сообщения с тегом X». Все
агент-специфические концепции (роутинг по имени роли, lifecycle агента,
ресолв capability) — реализуются поверх отдельным слоем.

**Nomad** — то же самое, чуть проще. Hashi-стек.

**DIY на etcd / Consul / ZooKeeper** — то, что большинство мультиагентных
команд сегодня вынуждены строить сами поверх k8s: registry агентов, lease
для cron-leader, routing tables.

### Reagent

- Кластер встроен в RC: `bootstrapCluster` поднимает etcd-управляемого
  member, `EtcdStateStore` — shared truth, `EtcdMembership` — node presence
  + agent routing через watch, `LeaderElection` — для CronAgent.
- **Уровень абстракции — агент и его роль**, не контейнер. RC знает, что
  агент A играет роль R протокола P, и роутит envelope-ы по логическому
  имени, а не сетевому адресу.
- Совместим с k8s — Reagent-нода может быть подом, а кластер Reagent
  отдельным от k8s control plane (мы про *что бежит внутри*, k8s про *где
  бежит*).

### Differentiator

| Параметр | k8s | Reagent |
|---|---|---|
| Уровень | контейнер | агент / роль / протокол |
| Routing | service IP / DNS | имя агента → роль → нода через `StateStore` |
| State plane | etcd под капотом | etcd как явная разделяемая правда `StateStore` |
| Lifecycle hooks | контейнерные | агент + протокол-run |
| Reconcile loop | под/deployment | desired-state по агентам (см. [`05-versioning-and-reconcile.md`](../../current/05-versioning-and-reconcile.md)) |

**Ответ на вопрос «зачем не k8s + DIY»:** Reagent даёт **готовую** агент-aware
прослойку поверх etcd. То, что у DIY-команд занимает 6 месяцев интеграции,
у Reagent — встроенный модуль `cluster/`. k8s остаётся снизу как
infrastructure layer.

**Где Reagent догоняющий:** mature ops-tooling, multi-cluster federation,
established security model — у k8s огромное преимущество. Мы не претендуем
на замену k8s, мы про слой агентов *внутри* k8s.

---

## 4. P2 — Workflow management между ролями

**Проблема:** многошаговый процесс с условиями, циклами, параллелизмом,
ретраями и состоянием. В классическом workflow — одна машина состояний для
одного процесса. В мультиагентном случае — **распределённый workflow**, где
каждая роль исполняет свою часть.

**Слоган Reagent (твой):** «**protocol is a role-specified distributed
workflow**».

### Инкумбенты

**LangGraph (LangChain).** Граф узлов с состоянием, чекпойнтингом,
человеком-в-петле. Сегодня «production default» для LLM-workflow. Граф
описывается **как Python-код**, не как отдельный артефакт. Стейт — у графа,
не у ролей. Бенчмарки: лучшая latency и минимальный token overhead (~9%)
среди тройки LG/CrewAI/AutoGen.

**n8n.** Визуальный workflow-builder для интеграций. Drag-and-drop, тысячи
готовых интеграций, low-code. Workflow — одна машина, не распределённая.
LLM-узлы добавлены, но не первичны.

**Airflow / Prefect / Dagster.** Data-pipeline ориентация. DAG-первая
модель, batch/scheduled, плохо подходит под reactive multi-agent.

**Temporal / Restate / DBOS / Inngest.** Durable workflows как код.
Многоязычные SDK (TS/Python/Java/Go/Rust), journal каждого шага, recovery
после краша. **Replit** перенесли свой coding agent на Temporal. Temporal
Cloud Serverless (Replay 2026) убирает ops-overhead. Restate — single
self-contained бинарь, durable agents middleware.

**Camunda / BPMN choreography.** Самый старый и зрелый прецедент **именно
choreography между несколькими сторонами**: BPMN 2.0 имеет
choreography-диаграммы, которые описывают взаимодействие между несколькими
участниками. Camunda 8 — enterprise-grade исполнитель. Camunda и есть
ближайший индустриальный аналог Reagent — но без AI-агентов и без
формальной верификации, только нотация + workflow engine.

### Reagent

- `.rg` — **читаемый артефакт**, не код-внутри-кода. Компилируется в IR.
- Workflow распределён **по ролям**: каждая роль — своя часть процесса,
  типизированные сообщения связывают их.
- `alt`, `par`, `loop`, `scatter`, `invoke`, `spawn`, `try/catch`, `wait`,
  `wait on` — все стандартные workflow-примитивы есть в языке.
- Durable execution есть на уровне protocol-run records в `StateStore`
  (recovery после RC-краша), **но не на уровне отдельных шагов внутри зоны**
  (см. §13).
- Версионирование (fingerprints + `reagent.lock` + MAJOR/MINOR/PATCH bump).

### Differentiator

| Параметр | LangGraph | n8n | Temporal | Camunda | Reagent |
|---|---|---|---|---|---|
| Workflow — артефакт | код Python | визуальный JSON | код в SDK | BPMN XML | `.rg` DSL |
| Multi-role distributed | — | — | через child workflows | ✅ choreography | ✅ first-class |
| State per-role | — (state у графа) | — | — (state у workflow) | — | ✅ `$self` per agent |
| Verification | — | — | — | — | ✅ TLA+ |
| LLM/AI-first | ✅ | ⚠ узлы | ⚠ activity wrappers | — | ✅ |
| Multi-node runtime | внеш. | вертикальное | ✅ | ✅ | ✅ |
| Ecosystem maturity | прод | прод | прод 10+ лет | прод 15+ лет | PoC |

**Сильный wedge Reagent в P2:** уникально то, что **workflow распределён по
ролям**, а сами роли — типизированные коммуникационные контракты. LangGraph
этого не делает (граф — одна машина). Temporal требует моделировать
multi-party как родительские/дочерние workflows. Camunda умеет
choreography, но не AI-first.

**Где Reagent догоняющий:** Temporal/Camunda — это десятилетия операционной
зрелости. Если задача — «retry конкретного LLM-вызова через 2 часа после
краша», Temporal победит. У нас задача шире — координация *между*
агентами, а не надёжность одного длинного workflow.

---

## 5. P3 — Multi-agent orchestration

**Проблема:** заставить несколько LLM-агентов с разными ролями коллективно
решать задачу — с прозрачным контролем, отладкой и предсказуемым
поведением.

### Инкумбенты

**LangGraph.** См. P2; для мультиагентных задач — наиболее зрелый.
Мультиагентность реализуется как граф с агент-узлами; нет языкового
описания «протокола между ними».

**CrewAI.** Ролевая абстракция («исследователь», «писатель», «редактор»),
sequential by default, очень быстрый prototyping (~25 мин до первого
агента). Слабая observability, sequential execution caveats в проде, token
overhead ~18%.

**Microsoft Agent Framework 1.0 (MAF).** Конвергенция AutoGen + Semantic
Kernel в один production SDK (**GA 3 апреля 2026**). .NET/Python,
graph-based workflows, middleware, **native MCP**, **A2A 1.0 coming soon**,
OpenTelemetry, Magentic-One и др. multi-agent patterns. AutoGen теперь в
maintenance, SK — foundation layer внутри MAF.

**OpenAI Agents SDK / Anthropic Claude Agent SDK.** Вендорные SDK с
handoff-паттернами и встроенной памятью. Vendor-нативные, ограничены
своими провайдерами.

**AutoGen (legacy)** — конверсационный multi-agent; теперь maintenance
mode в пользу MAF.

### Reagent

- Мультиагент — **фундамент языка**, не паттерн. `participants:` декларирует
  все роли явно, типы сообщений — schema, не свободная JSON-вода.
- Гетерогенные `BehaviorFactory` (managed-зоны, custom-TS, gate-WS/HTTP/stdio,
  Claude live-agent, MCP-gate) подключаются под одну protocol-machine. Один
  протокол может смешать managed-TS-агента, custom-Python-агента (через
  Rust RC + PyO3 в будущем), и MCP-LLM-агента.
- Verification — see P5.

### Differentiator

| Параметр | LangGraph | CrewAI | MAF 1.0 | Reagent |
|---|---|---|---|---|
| Multi-agent first-class | ✅ | ✅ | ✅ | ✅ |
| Protocol как объект | — | — | — | ✅ DSL |
| Type-safe messages | ⚠ | — | ✅ | ✅ |
| Heterogeneous host runtimes | — | — | .NET+Python | `[ts]`/`[py]` + gate/MCP/Claude |
| Native MCP | ⚠ адаптеры | ⚠ | ✅ | ✅ |
| Native A2A | — | — | ✅ coming | **—** |
| Maturity 2026 | прод default | prototyping default | GA enterprise | PoC |
| Vendor lock-in | LangChain ecosystem | низкий | Microsoft stack | OSS |

**Сильный wedge Reagent в P3:** протокол как **первичный артефакт + типизация
сообщений между ролями + heterogeneous host runtimes**. MAF — самый
опасный игрок (enterprise backing, MCP/A2A native), но привязан к .NET/Python
и Microsoft-стеку.

**Где Reagent догоняющий:** track record. LangGraph и MAF — тысячи продов.
Reagent — PoC. Нужны кейсы, которые можно показать.

---

## 6. P4 — Contract execution между сторонами

**Проблема:** несколько сторон договариваются о порядке взаимодействия и
хотят, чтобы исполнение было **верифицируемым** и **enforced**, а не
оставалось на честном слове или интерпретации каждой стороны.

Это самая необычная категория конкурентов и одновременно **самый сильный
эмоциональный угол для enterprise-разговора**.

### Инкумбенты

**Smart contracts (Blockchain).** Solidity на EVM, CosmWasm на Cosmos,
Move на Aptos/Sui. Контракт = код, исполняемый децентрализованной сетью с
trustless-семантикой. Подходит, когда стороны **не доверяют друг другу** и
готовы платить за консенсус.

- **+** Strong enforcement: исполнение невозможно подменить.
- **+** Audit trail: всё на блокчейне.
- **−** Trust assumption инвертирован: нужна децентрализованная сеть, gas-цены,
  high-latency финализация, ограниченная вычислительная мощность.
- **−** Off-chain состояние / I/O — oracle problem, не подходит для агентов,
  которые ходят в LLM-API.

**Human-readable RFCs (IETF, W3C, OASIS).** Текстовая спецификация, которую
команды реализуют у себя. SMTP, OAuth, FIX (financial), HL7 (healthcare),
SWIFT — всё это RFC-style контракты.

- **+** Понятно человеку, аудитируется юристами/архитекторами.
- **+** Любой стек может реализовать.
- **−** **Implementation gap**: реализации расходятся (см. историю SMTP-extensions
  и OAuth-implementations).
- **−** Не машинно-проверяется. Нет автоматического enforcement.

**OpenAPI / AsyncAPI / Protobuf IDL.** Сильнее формализуют контракт интерфейса
(типы, методы, события), но **не описывают workflow** — только синхронные
вызовы или per-message события.

### Reagent

- `.rg` — **исполняемый контракт**. Это одновременно:
  - спецификация (читается людьми и юристами как BPMN choreography);
  - формальная модель (IR + TLA+);
  - исполняемый артефакт (RC исполняет именно эту спеку).
- Reagent — **«RFC, который сам себя исполняет»**: спека и runtime — один
  и тот же файл.
- Enforcement через RC: RC advance только по легальным переходам state
  machine. Агенты не могут «выкинуть» сообщение, не предусмотренное
  протоколом — RC просто не пропустит его.
- Без блокчейна / без gas / без consensus latency. Доверие к одному RC
  (или federation RC) — это слабее блокчейна, но **подходящий компромисс
  для intra-organisation и trusted-partner inter-organisation сценариев**.

### Differentiator

| Параметр | Blockchain | RFC | OpenAPI | Reagent |
|---|---|---|---|---|
| Машинно-проверяется | ✅ | — | ⚠ schema only | ✅ |
| Verification до запуска | ⚠ (audit code) | — | — | ✅ TLA+ |
| Trustless | ✅ | — | — | — |
| Описывает workflow | ⚠ через state vars | ✅ текстом | — | ✅ first-class |
| Multi-party native | ✅ | ✅ | — | ✅ |
| AI-агенты / LLM | ⚠ (oracle problem) | n/a | ⚠ tools only | ✅ first-class |
| Latency | секунды-минуты | n/a | мс | мс |
| Audit trail | ✅ on-chain | manual | logs | OTel + protocol-run records |

**Сильный wedge Reagent в P4:** машинно-исполняемый контракт **без
trustless-overhead блокчейна**, описывающий **workflow между сторонами с AI-
агентами**. Это уникальное место. Smart contracts слишком тяжелы и не
работают с off-chain агентами; RFC + OpenAPI не дают enforcement.

**Целевые домены:** banking, insurance, healthcare, B2B-цепочки поставок,
cross-org workflow между трастовыми партнёрами.

**Где Reagent догоняющий:** legal/regulatory framework — у блокчейна и RFC
есть established legal precedents (DAO, smart-contract law, IETF process).
Нам нужен мост между `.rg` и юридическим языком.

---

## 7. P5 — Interaction verification

**Проблема:** доказать **до запуска**, что взаимодействие не виснет, не
зацикливается, корректно завершается, не нарушает инварианты. Это **другая**
проблема, чем P4: P4 — про *enforcement в runtime*; P5 — про *proof до
deployment*.

### Инкумбенты

**TLA+ / PlusCal (Lamport).** Промышленный стандарт верификации
распределённых систем. AWS использует TLA+ для S3/DynamoDB. Но: TLA+
пишется отдельно от runtime-кода, две параллельные модели, drift гарантирован.

**Session types** (research). Тип-система для коммуникации; компилятор
проверяет, что каждая сторона следует «session». Зрелые реализации:
Multiparty Session Types (Mungo, Scribble). Не массовый продукт.

**TraceFix** ([arXiv 2605.07935](https://arxiv.org/html/2605.07935), 2026).
Verification-first pipeline для LLM multi-agent координации: synthesises
topology IR → PlusCal → TLC repair → runtime monitor, отвергающий
out-of-topology операции. На 48 задачах: 100 % verified, 62.5 % с первого
прохода, ≤ 4 итерации. **Прямая идейная параллель Reagent**, но
academic, не платформа.

**Pact** ([arXiv 2605.03143](https://arxiv.org/html/2605.03143v1)).
Choreographic DSL с game-theoretic preferences. Каждая Pact-программа
мапится в формальную игру. Embedded в Python поверх `effectful`.

**Choral / Accompanist** ([arXiv 2603.20942](https://ar5iv.labs.arxiv.org/html/2603.20942)).
Choreographic programming language + sidecar resilient runtime под
decentralised saga transactions. Correct-by-construction (deadlock-free, all-succeed-or-all-compensate).

**VMAO** ([arXiv 2603.11445](https://arxiv.org/pdf/2603.11445)).
Plan-Execute-Verify-Replan, LLM-судья как orchestration-level coordination
signal. Семантическая верификация (completeness), не формальная.

### Reagent

- `reagent verify` встроен в CLI: компилирует протокол в TLA+, запускает
  TLC, проверяет deadlock freedom + protocol completion.
- Verification **в одном репозитории и pipeline** с runtime — TLA+ модель
  компилируется из того же IR, который исполняет RC. Нет drift между
  спекой и кодом.
- В планах (см. [`docs/future/`](../../future/)): расширение safety свойств
  (схема сообщений, инварианты ролей, scatter/gather семантика).

### Differentiator

| Параметр | TLA+ ручной | Session types | TraceFix | Choral | Reagent |
|---|---|---|---|---|---|
| Verified before run | ✅ | ✅ | ✅ | ✅ by construction | ✅ |
| Один артефакт со спекой и runtime | — (две модели) | ⚠ компилятор | ⚠ research | ⚠ research | ✅ |
| LLM-агенты | n/a | n/a | ✅ | n/a | ✅ |
| Production runtime | — | — | research monitor | sidecar | ✅ RC |
| Maturity | research/AWS | research | research | research | PoC |

**Сильный wedge Reagent в P5:** **verification + runtime — один артефакт**.
TLA+ всегда страдал от того, что модель и код разъезжаются. У Reagent
модель — это IR, и тот же IR исполняется RC. У TraceFix эта же идея, но
без всего остального продукта (RC, cluster, observability, version).

**Где Reagent догоняющий:** глубина свойств. AWS-уровень TLA+-моделей
проверяет десятки безопасных свойств; у нас сегодня только deadlock + completion.

---

## 8. Адъяцентные оси (не конкуренты — интеграция)

### 8.1 Agent communication protocols (wire-формат)

**MCP** (Anthropic → AAIF/Linux Foundation). Стандарт agent ↔ tools
(JSON-RPC). ~97M ежемесячных SDK-загрузок. **Reagent native** —
`mcp-gate`, `McpAgentAdapter`, `ReagentMcpServer`.

**A2A** (Google → Linux Foundation, v1.0 2026). Интероп agent ↔ agent с
**подписанными Agent Cards**, task lifecycle, gRPC/HTTP/SSE. 150+
организаций. **Reagent не поддерживает — критическая дыра.** В roadmap.

**ACP Agent Client Protocol** (Zed/JetBrains) — client ↔ agent для
IDE/CLI. Не путать со старым IBM ACP (deprecated, merged in A2A в конце 2025).

**ANP** (Agent Network Protocol) — W3C DIDs, federation в открытом
интернете. Long-term для cross-org Reagent-сетей.

**Стратегия:** Reagent **должен говорить** на этих протоколах, не строить
альтернативный wire-формат. Они — слой ниже Reagent (transport), а не
конкурент (coordination semantics).

### 8.2 Service mesh / inter-service contracts

**Istio / Linkerd** — service mesh для микросервисов. Mutual TLS, observability,
traffic shaping. У Reagent `NodeLink` + RC routing — фактически
«service mesh для агентов».

**gRPC / OpenAPI / AsyncAPI** — IDL для интерфейсов. Reagent IR содержит
сравнимую schema-информацию (message types), но плюс workflow.

**Reagent не строит свой service mesh** — может работать поверх Istio для
mTLS / observability на сетевом уровне.

### 8.3 Stateful agent runtimes / memory

**Letta** (бывш. MemGPT) — «LLM-as-OS» с self-editing memory tiers (core,
recall, archival). MCP-нативный. **Ортогонально** Reagent: Letta — про
*индивидуального* агента с памятью, Reagent — про *координацию* N агентов.
Идеально как `BehaviorFactory`-бэкенд в Reagent.

**mem0 / Zep / Cognee** — memory-as-a-library. Ортогонально.

---

## 9. Vendor enterprise platforms (каналы дистрибуции)

Эти платформы — **не конкуренты по технологии**, а каналы дистрибуции:
все они хостят чужих агентов через MCP/A2A.

| Платформа | Стек | Reagent роль |
|---|---|---|
| Microsoft Copilot Studio + MAF | Azure / .NET / Python | конкурент-канал |
| Salesforce Agentforce | CRM-вертикаль | потенциальный канал |
| AWS Bedrock AgentCore | AWS-нативно, A2A inside | канал |
| Azure AI Foundry | Azure stack + MAF + A2A | канал |
| Google Vertex AI Agent Builder / Agent Engine | GCP + A2A | канал |
| IBM watsonx Orchestrate | Энтерпрайз orchestrator | канал banking/insurance |

**Распространение:** деплоим Reagent-RC внутри Bedrock AgentCore / Azure
AI Foundry; экспонируем протоколы наружу через A2A; используем MCP для
tools.

---

## 10. Сводная матрица

«✅ first-class» / «⚠ частично/late add-on» / «—» / «n/a».

| Возможность | Reagent | k8s | LangGraph | Camunda | MAF 1.0 | Temporal | TraceFix | Choral | Smart contract | Letta |
|---|---|---|---|---|---|---|---|---|---|---|
| Cluster mgmt (P1) | ✅ агент-aware | ✅ контейнер | — | ⚠ | ⚠ Azure | ✅ workflow | — | ✅ sidecar | ✅ network | ⚠ |
| Workflow mgmt (P2) | ✅ DSL | — | ✅ код | ✅ BPMN | ✅ граф | ✅ код | ⚠ research | ✅ код | ⚠ через state | — |
| Multi-agent (P3) | ✅ | — | ✅ | ⚠ humans | ✅ | — | ✅ research | ✅ | ✅ DAO-style | ⚠ memory |
| Contract execution (P4) | ✅ runtime | — | — | ⚠ business contracts | — | — | ⚠ topology monitor | ⚠ saga | ✅ trustless | — |
| Verification (P5) | ✅ TLA+ | — | — | — | — | — | ✅ TLA+ | ✅ by construction | ⚠ audit code | — |
| Heterogeneous hosts | ✅ langs+gate | language-agnostic | Python | Java | .NET+Python | многоязычно | Python | JVM | EVM/Move | Python/TS |
| Durable execution | ⚠ run records | ✅ pods | ⚠ checkpoint | ✅ | ✅ first-class | ✅ first-class | — | ✅ | ✅ on-chain | ⚠ |
| OTel observability | ✅ | ✅ | ✅ LangSmith | ✅ | ✅ | ✅ | — | — | ✅ chain | ⚠ |
| Native MCP | ✅ | n/a | ⚠ адаптеры | — | ✅ | — | — | — | — | ✅ |
| Native A2A | **—** | n/a | — | — | ✅ coming | — | — | — | — | — |
| Versioning + reconcile | ✅ fingerprints | ✅ rolling | — | ✅ versions | ⚠ | ⚠ workflow ver | — | — | ✅ contract versions | — |
| Maturity 2026 | **PoC TS RC** | 10+ лет прод | прод default | 15+ лет прод | GA enterprise | 10+ лет прод | research | research | прод | прод |

---

## 11. Где у Reagent реальный wedge

Три точки, которые **не закрыты ни одним конкурентом одновременно**:

1. **Один артефакт `.rg` закрывает P2 + P3 + P4 + P5 сразу.**
   - LangGraph закрывает P2 + P3, но не P4/P5.
   - Camunda закрывает P2 + P4 (business contracts), но не P3/P5.
   - Smart contracts закрывают P4, но не P2/P3/P5 (для AI-агентов).
   - TraceFix закрывает P5, но не остальное.
   - **Reagent — единственный, кто пытается закрыть всё разом.**

2. **«RFC, который сам себя исполняет».** Это самое сильное метафорическое
   позиционирование для enterprise. Сегодняшний enterprise-стек —
   спецификация (Word/Confluence) + workflow engine (Camunda/MAF) + LLM-агенты
   (LangGraph/MAF) + аудит (manual) + верификация (none). Reagent сжимает
   это в один файл.

3. **Heterogeneous control plane.** `BehaviorFactory` + `LangTag` позволяют
   одной choreography подключать managed (TS-зоны), custom (произвольный TS),
   gate (внешние процессы), MCP-агентов, Claude-агентов — и в будущем
   `[py]`/`[rs]` через Rust RC + PyO3. Ближайший аналог — MAF, но он
   завязан на .NET/Python-стек Microsoft.

Все три тезиса **исполнимы** на текущем коде, но **не доказаны** на
реальных enterprise-кейсах. Это и есть точка, которую startupcamp должен
помочь зафиксировать.

---

## 12. Где Reagent сейчас догоняющий

Чтобы не закрашивать красное:

1. **A2A нет.** В 2026 это must-have. План: `A2ABehaviorFactory` (внешние
   A2A-агенты → `[*]`-роли) и обратная сторона (Reagent-агент → A2A Agent
   Card).
2. **Production track record нулевой.** Temporal — 10 лет; LangGraph и MAF —
   тысячи продов; Camunda — 15+ лет; smart contracts — DeFi уже 5+ лет.
   Reagent — PoC. Нужны кейсы.
3. **Durable execution на уровне шагов отсутствует.** У нас есть
   protocol-run records в `StateStore` (CAS, recovery on RC restart), но не
   journal на уровне отдельных шагов внутри зоны. Если клиенту важно
   «retry конкретного LLM-вызова через 2 часа после краша», Temporal/Restate
   победят.
4. **Ecosystem.** LangGraph + LangSmith + langchain-providers = тысячи
   готовых tools/integrations. У Reagent — пустая экосистема за пределами
   ядра. MCP-нативность частично закрывает.
5. **Python developer UX слабее.** Сейчас Reagent — TS-first; `[py]`-зоны
   работают, но whole-agent дисптач на `Role[py]` отложен до Rust RC. Для
   рынка, где >70 % AI-разработчиков сидят в Python, это болевая точка.
6. **No managed cloud.** LangSmith Cloud, Temporal Cloud, Letta Cloud, Azure
   AI Foundry, Camunda 8 SaaS — у всех есть SaaS. У Reagent нет.
7. **Legal / regulatory framework.** Для P4 у smart contracts уже есть
   established legal precedents (DAO, smart contract law). У RFCs — IETF
   process. У Reagent — пока ничего. Это критично для banking/insurance.

---

## 13. Открытые стратегические вопросы

Это то, на что startupcamp должен помочь ответить.

1. **Каков самый узкий вертикальный кейс**, где «протокол как первичный
   объект + верификация + runtime enforcement» — это *необходимость*?
   Кандидаты: banking, insurance, healthcare, cross-org B2B-цепочки
   поставок, DAO-light для trusted partners. Нужно выбрать один и сделать
   reference-кейсом.
2. **Building blocks или платформа?** Идти как библиотека внутри MAF/LangGraph
   (Reagent как «формальный план + RC под LangGraph») или как
   stand-alone OSS-платформа со своим dev-experience? Первый путь даёт
   моментальную дистрибуцию, второй — контроль над сценой.
3. **Когда вкладываемся в A2A.** До или после Rust RC? Аргумент «до»: рынок
   ждёт интероп; аргумент «после»: Rust RC даёт нам преимущество в
   performance.
4. **Стратегия с MCP.** MCP уже в Reagent. Достаточно ли «MCP-native» как
   маркетинг-якорь, или нужен видимый MCP-server / клиентский MCP-агент,
   живущий поверх Reagent протокола, как референс?
5. **Языковая стратегия для зон.** TS-first сегодня окей; нужно ли публично
   двигать `[py]` как «equal first» через Rust RC + PyO3, или принять, что
   `[ts]` + MCP-агенты — достаточно?
6. **Где брать первых пользователей.** OSS developer community (LangChain
   crowd) vs enterprise proof-of-concepts через системных интеграторов?
7. **Verification как мессадж — для кого?** Финансы/медицина — да. Стартапы и
   AI-engineering teams — обычно нет. Нужно ли вообще тянуть TLA+ в
   первый разговор, или это «вторая страница»?
8. **«Executable RFC» как метафора.** Это самый сильный нарратив для P4. Стоит
   ли строить вокруг неё всё позиционирование («Reagent = executable RFC for
   AI-augmented business processes»)?

---

## 14. Источники

- LangGraph / CrewAI / AutoGen / MAF benchmarks 2026:
  [turion.ai](https://turion.ai/blog/langgraph-vs-crewai-vs-autogen-comparison-2026/),
  [agent-harness.ai benchmark](https://agent-harness.ai/blog/multi-agent-orchestration-frameworks-benchmark-crewai-vs-langgraph-vs-autogen-performance-cost-and-integration-complexity/),
  [pecollective.com](https://pecollective.com/blog/ai-agent-frameworks-compared/),
  [automationswitch.com](https://automationswitch.com/ai-workflows/langchain-vs-crewai-vs-autogen-vs-langgraph).
- Microsoft Agent Framework 1.0 GA (3 April 2026):
  [devblogs.microsoft.com](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0/),
  [Visual Studio Magazine](https://visualstudiomagazine.com/articles/2026/04/06/microsoft-ships-production-ready-agent-framework-1-0-for-net-and-python.aspx),
  [learn.microsoft.com Overview](https://learn.microsoft.com/en-us/agent-framework/overview/).
- Agent protocols MCP / A2A / ACP / ANP:
  [agentmarketcap.ai survey](https://agentmarketcap.ai/blog/2026/05/19/four-protocol-agent-interoperability-mcp-a2a-acp-anp),
  [casys.ai](https://casys.ai/blog/mcp-a2a-acp-agent-protocols),
  [zylos.ai production report](https://zylos.ai/research/2026-04-18-agent-to-agent-interoperability-protocols),
  [neosalpha.com](https://neosalpha.com/blogs/ai-agent-protocols-acp-vs-mcp-vs-a2a/).
- Temporal / Restate durable AI:
  [temporal.io/solutions/ai](https://temporal.io/solutions/ai),
  [docs.restate.dev durable agents](https://docs.restate.dev/ai/patterns/durable-agents),
  [restate.dev](https://www.restate.dev/).
- Choreographic / verification research:
  [TraceFix arXiv 2605.07935](https://arxiv.org/html/2605.07935),
  [Pact arXiv 2605.03143](https://arxiv.org/html/2605.03143v1),
  [Accompanist arXiv 2603.20942](https://ar5iv.labs.arxiv.org/html/2603.20942),
  [VMAO arXiv 2603.11445](https://arxiv.org/pdf/2603.11445).
- Letta / stateful agents:
  [callsphere.ai](https://callsphere.ai/blog/vw3g-letta-memgpt-agent-memory-layer-deep-dive-2026),
  [letta-ai/letta-node](https://www.github.com/letta-ai/letta-node).
- BPMN / Camunda choreography — industrial precedent for multi-party
  process modeling (Camunda 8, BPMN 2.0 choreography diagrams).

---

## Связанные документы

- [`competitors_ideas.md`](competitors_ideas.md) — исходный набросок проблем,
  адресуемых Reagent (P1–P5 в текущей структуре).
- [`docs/decks/deep-dive/takes.md`](../deep-dive/takes.md) — продуктовые тезисы Reagent.
- [`docs/current/00-registry.md`](../../current/00-registry.md) — карта current docs.
- [`docs/current/03-runtime-core.md`](../../current/03-runtime-core.md) — текущая модель RC.
- [`docs/current/04-cluster-and-control-plane.md`](../../current/04-cluster-and-control-plane.md) — кластер + control plane.
- [`docs/current/05-versioning-and-reconcile.md`](../../current/05-versioning-and-reconcile.md) — fingerprints + reconcile.
- [`docs/current/09-e2e-usecases.md`](../../current/09-e2e-usecases.md) — референс-кейсы.
- [`docs/future/retire-python-runtime.md`](../../future/retire-python-runtime.md) — отказ от Python runtime.
