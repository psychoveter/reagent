# Reagent Test Spec Next

Дата: 2026-03-12

Этот документ фиксирует следующий шаг эволюции тестового покрытия Reagent после ревизии
`docs/current/08-test-spec.md` относительно:

- текущего реального test surface в репозитории
- реально запускаемых test suites
- продуктовых историй из `docs/current/09-e2e-usecases.md`

Цель документа: не просто перечислить файлы, а описать, какие именно тестовые
пробелы нужно закрыть, какие suite-ы надо починить, и как привести test-spec к
более полезной структуре.

Текущее состояние этого плана:

- implementation wave для детерминированной части уже выполнена
- foundation around infra presence был починен
- `08-test-spec.md` уже переписан
- `m15`, `m16`, `m17` уже добавлены
- independent review of test usefulness/stability/adequacy is still pending

---

## 1. Контекст

По итогам ревизии выяснилось следующее:

- `08-test-spec.md` больше не совпадает с фактическим inventory тестов
- документ не различает:
  - полный inventory
  - регулярно запускаемый smoke path
  - условные integration/live tests
  - известные красные suites
- связь между test suites и use cases из `09-e2e-usecases.md` почти не отражена
- часть infra coverage уже существует, но не оформлена как story-level e2e

Практический эффект:

- по документу сложно понять, что действительно зелёное
- по документу сложно понять, что требует внешней инфраструктуры
- по документу невозможно быстро ответить, какой use case чем покрыт

---

## 2. Уже подтверждено рабочим прогоном

Полный прогон всех suite-ов выполнен 2026-03-08.

### Зелёные (полностью проходят)

Все 7 suites `runtime/ts/test/`, 23 из 27 suites `runtime/tests/` TS, 2 из 3 `lang/test/`,
1 из 2 `tools/reagent-vscode/server/test/`, все 4 Python suite.

Подробный статус по каждому suite — в `08-test-spec.md` §4.

### Красные (persistent failures)

| Suite | Проблема |
|---|---|
| `runtime/tests/e2e.test.ts` | T7: wait timing flaky (159ms vs 300ms); T8: `$self` state not persisting across loop; T11/T12: catch block sends `Failure` вместо `ErrorReport` |
| `runtime/tests/m8b-agent-model.test.ts` | A6: async zone detection in compiled IR |
| `lang/test/m13-compiler.test.ts` | CR.2: decompile fails for 6 newer examples (invoke-demo, spawn-emit, cross-lang, multi-protocol, scatter-gather, call-for-proposal). This is now also tracked as a separate backlog item for decompiler catch-up. |

### Условные (не запускались)

| Suite | Причина |
|---|---|
| `runtime/tests/m14-task-delegation-claude-live-e2e.test.ts` | Tier 3: Docker + `ANTHROPIC_API_KEY` |
| `tools/reagent-vscode/server/test/lsp.test.ts` | Timeout on LSP initialize; likely needs specific build/env |

### Что подтверждено

- базовый state resolution и addressability filtering
- trigger primitives
- custom agent and gate basics
- lifecycle model RC / AgentTemplate / AgentRecord / AgentRuntime
- single-node debug e2e на `auction-sim`
- lease-backed live presence на уровне in-memory/state-store semantics
- real etcd infra-backed membership/presence behavior
- story-level deterministic coverage for UC3, UC4 (TS-first cross-mode), and UC5
- all Python suites (rc, coverage, triggers, parity)
- MCP adapter, NATS node link
- AdminClient / NodeControlEndpoint
- scatter/async, partitioned scatter
- fingerprints, reconciler, decompiler (basic round-trip)
- OTel interceptor, TLA+ generation
- LSP features (m13-lsp)

### Что НЕ подтверждено

- `$self` persistence across loops (T8)
- `try/catch` error message contract (T11/T12) — связано с backlog L1
- async zone marking в compiled IR (A6)
- decompiler round-trip для patterns с invoke, spawn, scatter, multi-protocol
- live Claude integration path (m14)
- older LSP smoke test (lsp.test.ts)

---

## 3. Статус проблем после implementation wave

### 3.1 Документальная рассинхронизация

Проблема закрыта в текущей волне.

Что было исправлено:

- `08-test-spec.md` приведён к фактическому inventory
- добавлены execution tiers
- добавлены status categories
- добавлена таблица use-case coverage

Что остаётся:

- поддерживать этот документ в актуальном состоянии по мере следующей волны тестов

### 3.2 Infra suite вокруг presence / membership

Проблема закрыта в текущей волне.

Что было исправлено:

- `etcd-cluster.test.ts` переведён на addressable live-agent semantics
- убрана запись устаревших неполных `/agents/*` payloads
- teardown стабилизирован
- `etcd-live-presence.e2e.test.ts` больше не делает глобальный wipe всего etcd и не ломает соседние suites
- `EtcdMembership` / `LeaderElection` получили более clean shutdown behavior

Что остаётся:

- независимая оценка того, насколько этот набор действительно стабилен и не флейкает в реальной routine usage

### 3.3 Дырка между primitives и story-level coverage

Детерминированная часть этого gap закрыта в текущей волне.

Что уже добавлено:

- `m15-iot-cron-event-e2e.test.ts`
- `m16-cross-mode-orchestration-e2e.test.ts`
- `m17-risk-review-approval-e2e.test.ts`

Что остаётся:

- live/distributed research-swarm scenario (`P5`)
- независимая проверка того, что `m15-m17` действительно хорошо представляют product stories, а не только проходят локально

---

## 4. Целевая структура test-spec

Следующая версия test-spec должна быть перестроена вокруг нескольких измерений.

### 4.1 Inventory

Полный список test files по каталогам:

- `runtime/tests/`
- `runtime/ts/test/`
- `lang/test/`
- `tools/reagent-vscode/server/test/`

### 4.2 Execution Tiers

Явно разделить suites по запуску:

- `Tier 0: build + fast local smoke`
- `Tier 1: routine integration`
- `Tier 2: infra-backed integration` (`etcd`, `NATS`, `Docker`)
- `Tier 3: external/live` (`Claude`, MCP, внешние ключи)

### 4.3 Status

Для каждого suite или набора suite-ов нужен живой статус:

- `green`
- `conditional`
- `known red`
- `inventory only / not recently verified`

### 4.4 Use-Case Coverage

Нужна отдельная таблица:

- `Use case`
- `required features`
- `existing suites`
- `coverage quality`
- `missing tests`

---

## 5. Приоритеты доработок

## P0. Привести infra presence suites в актуальное состояние

Status: implemented, pending independent review

### Цель

Сделать test surface вокруг membership/state-store снова надёжным и совместимым с
lease-backed live presence моделью.

### Реализовано

- `runtime/ts/test/etcd-cluster.test.ts` обновлён под addressable `AgentRegistration`
- прямые устаревшие `/agents/*` payloads убраны
- teardown cleaned up
- `runtime/ts/test/etcd-live-presence.e2e.test.ts` сохранён зелёным и больше не ломает другие suites глобальной очисткой etcd
- `runtime/ts/src/cluster/etcd-membership.ts` и `runtime/ts/src/cluster/leader-election.ts` получили safer shutdown behavior

### Что ещё проверить отдельно

- насколько это стабильно в повторных прогонах и в реальной developer routine
- достаточно ли этот coverage действительно описывает intended infra semantics

### Definition of done

- `runtime/ts/test/etcd-cluster.test.ts` стабильно проходит на локальном etcd
- suite завершается чисто без repeated keepAlive errors after close
- `08-test-spec.md` отмечает этот набор как infra-backed integration, а не как
  обычный fast validation step

---

## P1. Переписать `08-test-spec.md` в рабочую форму

Status: implemented, pending independent review

### Цель

Превратить `08-test-spec.md` из исторического file registry в рабочую карту
тестовой поверхности.

### Реализовано

- inventory обновлён по фактическому filesystem
- добавлены execution tiers
- добавлен verified status layer
- default smoke path отделён от полного inventory
- use-case mapping добавлен
- документ превращён из исторического registry в рабочую карту test surface

### Что ещё проверить отдельно

- насколько документ действительно помогает быстро выбирать нужный validation path
- не перегружен ли он и не остались ли в нём скрытые semantic mismatches

---

## P2. Закрыть story-level gap для UC3 IoT Sensor Pipeline

Status: implemented, pending independent review

`docs/current/09-e2e-usecases.md` задаёт use case:

- `trigger on cron`
- `reagent.emit()`
- `trigger on event`
- stateful monitor + diagnostics follow-up

Сейчас это покрыто в основном через trigger primitives, но не через одну связную
историю.

### Реализованный suite

- `runtime/tests/m15-iot-cron-event-e2e.test.ts`

### Что сейчас проверяет suite

- cron-trigger запускает `ScheduledPoll`
- протокол эмитит domain event
- event-trigger запускает `AnomalyInvestigation`
- данные передаются между протоколами через payload / event bus
- persistent `$self.history` реально участвует в обработке follow-up протокола

### Минимальный runtime shape

- single-node
- без внешних LLM
- managed agents
- memory state-store достаточно

### Что ещё проверить отдельно

- достаточно ли правдоподобен этот story как representative use case
- не слишком ли сильно он привязан к test-only shape вместо продуктовой истории

---

## P3. Закрыть story-level gap для UC4 Cross-Language Orchestration

Status: implemented in TS-first cross-mode form, pending independent review

Use case про кросс-языковую оркестрацию сейчас покрыт кусочно:

- есть custom/gate primitives
- есть отдельные parity tests
- есть conformance layers

Но нет явного e2e, который показывает orchestration как продуктовый сценарий.

### Реализованный suite

- `runtime/tests/m16-cross-mode-orchestration-e2e.test.ts`

### Что сейчас проверяет suite

- один protocol instance проходит через роли, реализованные разными host/runtime mode
- хотя бы один agent работает как managed
- хотя бы один agent работает через custom or gate path
- есть реальный message exchange, а не только isolated adapter checks
- проверяется совместимость payloads и status/protocol completion semantics

### Принятое сужение scope

- в этой волне реализован именно TS-first cross-mode scenario
- Python parity не была частью первого milestone
- дальнейшее cross-language расширение остаётся возможным, но уже не блокирует deterministic coverage wave

### Что ещё проверить отдельно

- действительно ли текущий cross-mode story достаточно хорошо представляет UC4
- нужен ли отдельный later suite именно с real TS/Py boundary

---

## P4. Закрыть story-level gap для UC5 Scheduled Risk Review

Status: implemented, pending independent review

Этот use case сейчас покрыт хуже всего относительно заявленной функциональности.

Он требует в одной истории:

- `trigger on cron`
- human approval / HITL
- child protocol через `invokes`
- dynamic role creation через `spawns`
- persistent state между шагами

### Реализованный suite

- `runtime/tests/m17-risk-review-approval-e2e.test.ts`

### Что сейчас проверяет suite

- cron действительно запускает верхнеуровневый протокол
- approval boundary проходит через отдельного approver agent
- child protocol запускается через `invokes`
- spawned role реально создаётся и участвует в протоколе
- persistent coordinator state обновляется согласованно

### Минимальный runtime shape

- TS RC
- managed + custom agents
- по возможности без внешнего Claude, чтобы suite был детерминированным

### Что ещё проверить отдельно

- достаточно ли approval path отражает реальную HITL semantics
- нужен ли follow-up negative branch (`reject`) как отдельное дополнение

---

## P5. Уточнить покрытие UC2 Distributed Research Swarm

Status: still pending / external-live

Сейчас ближайший живой тест к этому направлению:

- `runtime/tests/m14-task-delegation-claude-live-e2e.test.ts`

Но это не полный аналог research swarm:

- он уже проверяет live Claude path
- он не покрывает богатый distributed multi-role research orchestration story
- он не доказывает use case с несколькими удалёнными research agents и human checkpoint loop

### Варианты развития

Вариант A: расширить `m14`

- сделать его не только task-delegation suite, а foundation для нескольких
  live-agent distributed scenarios

Вариант B: оставить `m14` узким и добавить новый suite

- `runtime/tests/m18-research-swarm-live-e2e.test.ts`

### Что должен проверять новый suite

- multi-node cluster
- несколько remote/live agents
- `scatter` на несколько исполнителей
- человеческий approval/review checkpoint
- сбор результатов обратно инициатору

### Ограничение

Это должен быть `Tier 3: external/live` suite, а не обязательный default test.

---

## 6. Что ещё стоит улучшить в существующих тестах

### 6.1 Нормализовать naming

Сейчас test surface смешивает:

- milestone names (`m5`, `m8`, `m13`, `m14`)
- conceptual names (`phase3`, `wave2`)
- scenario names (`debug-auction-e2e`)

Новый план не требует немедленного renaming, но будущие suites лучше называть по
сценарию, а не по исторической волне разработки.

Предпочтительный стиль для новых tests:

- `<scenario>-e2e.test.ts`
- `<subsystem>-integration.test.ts`
- `<feature>-regression.test.ts`

### 6.2 Привязать каждый новый suite к use case и tier

Каждый новый suite должен в header-комментарии явно содержать:

- какой use case он покрывает
- какой runtime shape он использует
- какой tier запуска
- какие внешние зависимости требуются

### 6.3 Стабилизировать external/live path

Для live suites нужно отдельно стандартизовать:

- как читаются env vars
- как определяется, skip или fail
- как печатаются trace/logs
- как отделяется flaky infra failure от реальной функциональной регрессии

---

## 7. Предлагаемый порядок реализации

Implementation order for the deterministic wave has already been completed.
This section remains here as a record of the intended sequencing and for the remaining live step.

### Этап 1. Починить foundation

1. Починить `etcd-cluster.test.ts`
2. Перепроверить `etcd-live-presence.e2e.test.ts`
3. Обновить `08-test-spec.md` inventory и execution tiers

### Этап 2. Закрыть deterministic story-level gaps

4. Добавить IoT cron/event e2e
5. Добавить cross-language orchestration e2e
6. Добавить risk review approval e2e

### Этап 3. Доработать live/distributed scenarios

7. Определить судьбу `m14`: narrow task-delegation vs foundation for live scenarios
8. Добавить отдельный research swarm live e2e при необходимости
9. Описать этот уровень как conditional/external в test-spec

---

## 8. Execution Board

Это компактная связка между `backlog.md` и данным документом:

- `backlog.md` хранит backlog-item'ы `T1-T6`
- этот документ раскрывает их как конкретные test-design priorities `P0-P5`

| Backlog | Priority | Current state | Target files | Main dependencies | Suggested order | Notes |
|---|---|---|---|---|---|---|
| `T1` Repair etcd membership integration tests | `P0` | Implemented, pending independent review | `runtime/ts/test/etcd-cluster.test.ts`, `runtime/ts/test/etcd-live-presence.e2e.test.ts`, `runtime/ts/src/cluster/etcd-membership.ts`, `runtime/ts/src/cluster/leader-election.ts` | current lease-backed presence semantics, addressable `AgentRegistration`, clean teardown | `1` | Foundation repair completed. Another reviewer should judge stability and adequacy. |
| `T2` Rewrite `08-test-spec.md` | `P1` | Implemented, pending independent review | `docs/current/08-test-spec.md` | actual filesystem inventory, runnable commands, tier model, known red/conditional status | `2` | Implemented after `T1`; now needs a usefulness/readability check from another reviewer. |
| `T3` IoT cron/event story-level e2e | `P2` | Implemented, pending independent review | `runtime/tests/m15-iot-cron-event-e2e.test.ts` | stable trigger primitives, single-node deterministic runtime shape | `3` | First new story-level e2e is in place. |
| `T4` Cross-mode orchestration e2e | `P3` | Implemented in TS-first form, pending independent review | `runtime/tests/m16-cross-mode-orchestration-e2e.test.ts` | managed/custom/gate coverage, stable payload/status semantics | `4` | Delivered as cross-mode first; Python can still be added later as a separate extension. |
| `T5` Risk review approval e2e | `P4` | Implemented, pending independent review | `runtime/tests/m17-risk-review-approval-e2e.test.ts` | cron, approval boundary, `invokes`, `spawns`, persistent state | `5` | Deterministic advanced scenario is in place; adequacy of approval semantics still needs separate review. |
| `T6` Research swarm live e2e | `P5` | Not implemented, intentionally deferred | `runtime/tests/m18-research-swarm-live-e2e.test.ts` or expansion of `runtime/tests/m14-task-delegation-claude-live-e2e.test.ts` | live-agent path, multi-node cluster, external/live infra, human checkpoint flow | `6` | Keep last. This remains external/live and should stay conditional. |

### Dependency notes

- `T1 -> T2`:
  `08-test-spec.md` should not be rewritten as authoritative while infra-backed suites are still known-broken or semantically stale.
- `T3 -> T4 -> T5`:
  this order moves from the cheapest deterministic single-node scenario toward denser orchestration scenarios.
- `T6` should stay separate:
  it depends on external/live infrastructure and should not block the deterministic testing wave.

### Relation to TS-first prioritization

- `T4` is intentionally framed as **cross-mode**, not Python-first cross-runtime parity.
- Python participation in `T4` is a later extension after the TS managed/custom/gate scenario is stable.
- `T6` validates live/distributed host integration, not Python parity.

---

## 9. Критерий завершения этой волны

Implementation side of this wave is effectively complete when simultaneously:

- `08-test-spec.md` снова совпадает с реальным test surface
- infra-backed tests вокруг etcd membership стабильны и актуальны
- для каждого use case из `09-e2e-usecases.md` есть либо:
  - прямой story-level e2e
  - либо явно обозначенный и аргументированный gap
- document structure отвечает на практический вопрос:
  - что запускать после изменений в runtime
  - что запускать после изменений в cluster/control-plane
  - что является optional live coverage

Но финально закрытой эту волну стоит считать только после отдельной независимой проверки:

- работоспособности новых suites в чужом прогоне
- разумности сценариев и того, что они действительно покрывают product stories
- приемлемой стабильности и отсутствия очевидной флейковости

---

## 10. Короткая карта целевых новых suite-ов

| Priority | Proposed suite | Purpose |
|---|---|---|
| P2 | `runtime/tests/m15-iot-cron-event-e2e.test.ts` | Story-level cron -> emit -> event flow |
| P3 | `runtime/tests/m16-cross-mode-orchestration-e2e.test.ts` | One real TS-first cross-mode orchestration scenario |
| P4 | `runtime/tests/m17-risk-review-approval-e2e.test.ts` | Cron + approval + invokes + spawns scenario |
| P5 | `runtime/tests/m18-research-swarm-live-e2e.test.ts` | Distributed live-agent research swarm coverage |

Порядок не означает, что все файлы обязаны называться именно так, но смысл и
уровень покрытия должны появиться в test surface в этой последовательности.
