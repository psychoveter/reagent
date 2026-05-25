# Reagent Test Spec Next

Дата: 2026-05-24

Этот документ — узкий бэклог тестовой поверхности Reagent, оставшийся после
ревизии и валидационной волны весны 2026. Источник правды по текущему inventory,
execution tiers, скриптам, и фактическому статусу — [`docs/current/08-test-spec.md`](../current/08-test-spec.md).

Историческая часть про deterministic story-level волну (P0-P4) и её
"pending independent review" — закрыта; всё, что в ней было заявлено как
"implemented", прошло свежий прогон и зелёное, кроме явно перечисленных ниже
gap-ов. Отдельный лог волны держать в этом документе больше не имеет смысла.

---

## 1. Carried-over gaps

Это пункты, которые при последнем прогоне реально не закрыты или закрыты только
частично, и за которыми надо следить отдельно.

### 1.1 Decompiler catch-up для invoke/async-invoke/scatter/multi-protocol

- Файл: [`lang/test/compiler/compiler-roundtrip.test.ts`](../../lang/test/compiler/compiler-roundtrip.test.ts), suite `CR.2`.
- Текущее поведение: тест зелёный, но через закреплённый `EXPECTED_CR2_UNSUPPORTED`
  set:
  - `18-invoke-demo.rg`
  - `19-spawn-emit-demo.rg`
  - `20-cross-lang-e2e.rg`
  - `22-multi-protocol-agent.rg`
  - `23-scatter-gather.rg`
- Что нужно сделать: довести декомпилятор до round-trip поддержки этих форм.
  По мере покрытия — удалять элементы из `EXPECTED_CR2_UNSUPPORTED` и из этого
  пункта.
- Tier: Tier 1 (lang).

### 1.2 `EventEmitted` per-instance trace отсутствует

- Тип `EventEmitted` объявлен в [`runtime/ts/src/contracts/types.ts`](../../runtime/ts/src/contracts/types.ts), но runtime
  не пишет такой trace, когда зона вызывает `reagent.emit(...)`. Хендлер
  `protocolEvent` срабатывает корректно, но per-instance трассировки самого
  emit-события нет.
- Эффект сейчас: `T16` в `runtime/ts/test/stories/runtime-semantics-nats.test.ts`
  проверяет emit по `$self.eventsHandled`, а не по trace.
- Что нужно сделать: добавить запись `EventEmitted` трейса на стороне той роли,
  которая вызвала emit, и, по желанию, отдельный assert в `T16`.
- Tier: Tier 1 (runtime).

### 1.3 Resolve-policy и cluster-resolve покрытие

Из `08-test-spec.md` §5:

- Нет deterministic story или e2e, который прогоняет нетривиальный pipeline
  триггера (например, `all | filter(...) | roundRobin`).
- Зональные `reagent.resolve()` / `reagent.registry` намеренно убраны из v0 zone
  surface; если в будущем появится cluster-side resolve helper, его поверхность
  нужно покрыть behavior-level тестами.
- Политика `leastLoaded` всё ещё застублена, нет behavior-level покрытия.
- Tier: Tier 1 (runtime/cluster).

### 1.4 Negative-branch для UC5 Risk Review

- Файл: [`runtime/ts/test/stories/risk-review-approval.test.ts`](../../runtime/ts/test/stories/risk-review-approval.test.ts).
- Сейчас покрыт happy-path (approve). Полный HITL-сценарий должен также
  включать `reject` ветку и проверять, что отказ корректно завершает протокол и
  не запускает дочерние шаги.
- Tier: Tier 1 (stories deterministic).

### 1.5 Cross-language UC4: реальный Python boundary

- Файл: [`runtime/ts/test/stories/cross-mode-orchestration.test.ts`](../../runtime/ts/test/stories/cross-mode-orchestration.test.ts).
- Сейчас покрыт TS-first cross-mode (managed + custom + gate). Полный
  cross-language вариант с реальной TS↔Py границей внутри одного протокола
  остаётся отдельным шагом. Базовый кросс-язык на уровне messaging
  (`T17`/`T18` в `runtime-semantics-nats.test.ts`) уже зелёный, но это не
  story-level coverage.
- Tier: Tier 2 (нужен NATS + Python venv).

---

## 2. Future work

### 2.1 P5: UC2 Distributed Research Swarm (live)

- Status: intentionally deferred (Tier 3, external/live).
- Цель: e2e на уровне продуктовой истории про распределённый swarm живых агентов.
- Возможные формы:
  - расширить [`runtime/ts/test/stories/live/task-delegation-claude.test.ts`](../../runtime/ts/test/stories/live/task-delegation-claude.test.ts) до
    основы для нескольких live-agent сценариев,
  - либо завести отдельный suite `runtime/ts/test/stories/live/research-swarm.test.ts`.
- Что должен проверять:
  - multi-node cluster,
  - несколько remote/live agents,
  - `scatter` на нескольких исполнителей,
  - human approval / review checkpoint,
  - сбор результатов обратно инициатору.
- Ограничения: должен оставаться Tier 3 (`ANTHROPIC_API_KEY`, Docker, опционально
  `etcd`/`NATS`), а не обязательным default-test.

---

## 3. Possible follow-ups

Это не блокирующие пункты, скорее "хорошо бы пересмотреть":

- Стабильность infra-backed `etcd` suite (`runtime/ts/test/cluster/etcd-cluster.test.ts`,
  `etcd-live-presence.e2e.test.ts`) в реальной developer routine — независимое
  ревью на флейки при повторных прогонах.
- Стабилизировать external/live path: единый стиль чтения env vars, разграничение
  skip vs fail, формат вывода trace/logs, отделение flaky infra failure от
  функциональной регрессии.
- Соглашение по naming для новых suite-ов: `<scenario>-e2e.test.ts`,
  `<subsystem>-integration.test.ts`, `<feature>-regression.test.ts`; в header-комментарии
  явно указывать use case, runtime shape, tier и внешние зависимости.

---

## 4. Связь с backlog-ом

Старая таблица `T1..T6 → P0..P5` из предыдущей версии этого документа закрыта:

- `T1` (etcd membership) — реализовано, зелёное в Tier 2.
- `T2` (rewrite of `08-test-spec.md`) — реализовано и пересмотрено в этой
  волне.
- `T3` (IoT cron/event story-level e2e) — реализовано, зелёное.
- `T4` (cross-mode orchestration e2e) — реализовано в TS-first форме;
  расширение до реального cross-language Python boundary осталось в §1.5.
- `T5` (risk review approval e2e) — реализовано happy-path; `reject` ветка
  осталась в §1.4.
- `T6` (research swarm live e2e) — сознательно отложено, см. §2.1.

Дополнительно из текущей волны:

- Decompiler round-trip catch-up: §1.1.
- `EventEmitted` trace: §1.2.
- Resolve-policy и `leastLoaded`: §1.3.

Любая новая волна должна сначала зафиксировать дельту в [`08-test-spec.md`](../current/08-test-spec.md)
(§5 Known Gaps + §6 Use-Case Coverage Map), и только потом переносить будущие
задачи сюда.
