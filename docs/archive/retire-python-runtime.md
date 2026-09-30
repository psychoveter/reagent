# Retire The Python Runtime

Status: executed | Date: 2026-05-25

---

## 1. Цель

Полностью убрать параллельный Python-runtime (`runtime/py/reagent_runtime/...`)
и все его упоминания из кода, тестов, документации и tooling. Это снимает
нагрузку поддержки второй реализации движка, пока roadmap фокусируется на:

1. **TypeScript-первый PoC** — `runtime/ts/...` остаётся единственной
   реализацией протокольного движка.
2. **Rust `reagent-core` как следующий шаг** — после стабилизации PoC мы
   переезжаем на Rust-ядро. Python после этого участвует не как отдельный
   runtime, а как **host** для embedded Rust RC (см.
   [`nmmo-python-host.md`](nmmo-python-host.md)).

---

## 2. Что сохраняется

`LangTag` (включая `"py"`) — это **отвязанная** от линии runtime тема, она
описывает, как RC исполняет инъектированный код по тегу. Поэтому:

- `LangTag = "ts" | "js" | "py" | "kt"` остаётся в синтаксисе и в IR.
- `[py]` зональный executor сохраняется как RC virtual-language scaffolding
  и переезжает из `runtime/py/reagent_runtime/zone_executor.py` в
  [`runtime/ts/zone-execs/py/reagent_runtime/zone_executor.py`](../../runtime/ts/zone-execs/py/reagent_runtime/zone_executor.py)
  (self-contained, без зависимостей от удалённого Python runtime).
- Тесты `A2` / `A4` в
  [`runtime/ts/test/core/agent-host-boundary.test.ts`](../../runtime/ts/test/core/agent-host-boundary.test.ts)
  переехали на новый путь и остаются зелёными.

Не трогаем:

- `nmmo-python-host.md` — это будущая работа по embedded Rust+PyO3 host.
- VS Code grammar и embedded Python-подсветка зон — `[py]` всё ещё валидный
  language tag, синтаксис body остаётся Python.

---

## 3. Что удалено

### 3.1 Runtime код

- [x] `runtime/py/` целиком, включая `reagent_runtime/` (controller,
  protocol_engine, protocol_instance, agent_runner, inproc/ipc nodes,
  nats_transport, state_store*, trigger_*, resolve_policy_evaluator,
  ir_fingerprint, otel_interceptor, remote_node*, cron_agent, …) и
  `requirements.txt`.
- [x] `runtime/ts/src/nodes/python-behavior-factory.ts` (stub).
- [x] Export `PythonBehaviorFactory` из `runtime/ts/src/index.ts`.
- [x] Упоминание `PythonBehaviorFactory` в комментарии
  `runtime/ts/src/contracts/behavior-factory.ts`.

### 3.2 Тесты

- [x] `runtime/ts/test/python/` целиком (`runtime-core/test_runtime_core.py`,
  `runtime-core/test_runtime_coverage.py`, `triggers/test_triggers.py`,
  `parity/test_ts_python_parity.py`, `py_agent_runner.py`).
- [x] `runtime/ts/test/contracts/runtime-conformance.test.ts` (TS↔Py
  ProtocolEngine parity) удалён целиком.
- [x] `R5` в `runtime/ts/test/controller/protocol-registry.test.ts` удалён.
- [x] `C12` в `runtime/ts/test/controller/routing-and-orchestration.test.ts`
  удалён вместе с `CROSS_LANG_DIR` / `PY_RUNTIME_DIR` константами и
  `PythonBehaviorFactory` импортом.
- [x] `T4` (cross-lang IR-shape sanity), `T17`, `T18`, `runPyAgent` helper,
  `CROSSLANG_FIXTURES_DIR`, `PY_RUNTIME_DIR`, `PY_VENV_BIN` константы в
  `runtime/ts/test/stories/runtime-semantics-nats.test.ts` удалены.

### 3.3 Фикстуры

- [x] `examples/protocols/src/13-cross-lang-demo.rg` и
  `examples/protocols/src/20-cross-lang-e2e.rg` удалены.
- [x] Соответствующие `examples/out/13-cross-lang-demo/`,
  `examples/out/20-cross-lang-e2e/`,
  `examples/protocols/out/13-cross-lang-demo/`,
  `examples/protocols/out/20-cross-lang-e2e/` удалены.
- [x] `EXPECTED_CR2_UNSUPPORTED` в
  [`lang/test/compiler/compiler-roundtrip.test.ts`](../../lang/test/compiler/compiler-roundtrip.test.ts)
  очищен от `20-cross-lang-e2e.rg`.
- [x] `CrossLangDemo` / `CrossLangE2E` записи удалены из
  `examples/protocols/src/reagent.lock`.

### 3.4 Скрипты и tooling

- [x] `package.json` (root): убраны `test:python:runtime-core`,
  `test:python:coverage`, `test:python:triggers`, `test:python:parity`,
  `test:python`; `test:all` не вызывает `test:python`.
- [x] `tools/reagent-vscode/src/extension.ts`: удалён `findRuntimePyDir`
  helper (искал `runtime/py/reagent_runtime/remote_node_cli.py`).
- [x] `tools/reagent-vscode/preview.html`: убраны "cross-lang" и "py-sim"
  scenarios и dropdown options; `NativeAgentNode + PythonAgentNode` →
  `NativeAgentNode` в оставшихся mock-данных.
- [x] `.gitignore`: убраны Python-tooling entries (`.venv/`,
  `.pytest_cache/`, `.ruff_cache/`, `.mypy_cache/`); сохранён
  `__pycache__/` под релокированный zone executor.

### 3.5 Документация

- [x] `docs/current/00-registry.md`: секция "Python runtime" заменена на
  "`[py]` zone executor (RC virtual-language scaffolding)".
- [x] `docs/current/01-user-guide.md`: убрана предпосылка обязательного
  Python ≥ 3.10 (теперь optional для `[py]` zones), удалён раздел
  `run.py`, обновлены примеры `auction-sim` и `module.py` → TypeScript.
- [x] `docs/current/02-lang-spec.md` §4.8: "Reference runtimes" → одна
  TypeScript-реализация; параграф про Python `ReagentController` удалён.
- [x] `docs/current/03-runtime-core.md`: "Python agents" → "`[py]` zone
  executor", раздел "Managed, Custom, Python, And Gate Hosts" →
  "Managed, Custom, And Gate Hosts".
- [x] `docs/current/04-cluster-and-control-plane.md` §13: "Python Runtime
  Asymmetry" → "Python Runtime Retired".
- [x] `docs/current/05-versioning-and-reconcile.md` §13: переписан в
  "Runtime Scope" с указанием TS как единственного first-class runtime.
- [x] `docs/current/06-tooling-overview.md`: обновлено упоминание о Python
  asymmetry → retirement.
- [x] `docs/current/08-test-spec.md`: убран `runtime/ts/test/python/` блок,
  `test:python` lane, `contracts/runtime-conformance.test.ts`,
  `20-cross-lang-e2e` из CR.2 expected-unsupported set; UC4
  переформулирован вокруг `[py]`-zone executor `A2`/`A4`.
- [x] `docs/current/09-e2e-usecases.md`: UC1 (auction-sim) переключён на
  TypeScript runtime; UC3 (IoT) переключён на TS RC; UC4 (Payment)
  отмечен как Future с `[py]` agents через будущий Rust+PyO3 host;
  deployment matrix — "Single-process (Python RC)" удалён.
- [x] `docs/future/test-spec-next.md` §1.5 переименован в "Cross-language
  UC4: реальный Python boundary (gated on Rust RC)", `20-cross-lang-e2e`
  убран из `EXPECTED_CR2_UNSUPPORTED` блока.

---

## 4. Outcome

После исполнения работы:

- `runtime/py/`, `runtime/ts/test/python/`, `python-behavior-factory.ts` и
  cross-language e2e фикстуры отсутствуют в дереве.
- `LangTag` (включая `"py"`) сохранён в синтаксисе и IR.
- `[py]` зональное исполнение продолжает работать через релокированный
  zone executor в `runtime/ts/zone-execs/py/` и тесты `A2`/`A4`.
- Whole-agent dispatch `agent X runs Role[py]` явно отложен до Rust
  Release Candidate с PyO3 / эквивалентным host'ом
  (см. [`nmmo-python-host.md`](nmmo-python-host.md)).
- Грэп-проверка `PythonBehaviorFactory|reagent_runtime\.|runtime/py` по
  репозиторию возвращает только `runtime/ts/zone-execs/py/`,
  `docs/future/retire-python-runtime.md` и `docs/future/nmmo-python-host.md`.

---

## 5. Adjacent docs

- [`../current/00-registry.md`](../current/00-registry.md) — текущий статус
  runtime и расположение zone executor scaffolding.
- [`../current/03-runtime-core.md`](../current/03-runtime-core.md) §1, §8 —
  обновлённая архитектура без Python runtime.
- [`../current/08-test-spec.md`](../current/08-test-spec.md) §3 — обновлённый
  test inventory.
- [`nmmo-python-host.md`](nmmo-python-host.md) — целевой Python-as-host
  design (Rust RC + PyO3), ради которого освобождено место.
- [`test-spec-next.md`](test-spec-next.md) §1.5 — backlog item для
  cross-language UC4, gated на Rust RC.
