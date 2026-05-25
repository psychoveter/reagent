# Retire The Python Runtime

Status: planned | Date: 2026-05-25

---

## 1. Цель

Полностью убрать действующий Python-runtime (`runtime/py/reagent_runtime/...`)
и все его упоминания из кода, тестов, документации и tooling. Это снимает
нагрузку поддержки второй параллельной реализации, пока roadmap явно
сфокусирован на:

1. **TypeScript-первый PoC** — `runtime/ts/...` остаётся единственной
   реализацией протокольного движка на время текущего этапа.
2. **Rust `reagent-core` как следующий шаг** — после стабилизации PoC мы
   переезжаем на Rust-ядро. Python после этого участвует не как отдельный
   runtime, а как **host** для embedded Rust RC (см.
   [`nmmo-python-host.md`](nmmo-python-host.md)).

Текущий Python-runtime не лежит на этом пути и только тянет за собой dead
weight: дублирующиеся семантики, отдельные тесты, fragile relative paths в
тест-runner'ах, отдельный venv, отдельный CI lane.

---

## 2. Non-goals

- Не отказываемся от поддержки Python как **host language**. Замысел
  embedded Rust RC + Python host (NMMO use case) остаётся в roadmap.
- Не удаляем `LangTag = "py"` навсегда из языка как зарезервированный токен
  — он останется как зарезервированный для будущего hosted-Python, но
  парсер/IR не должны эмитить рабочий код под этот тег, пока нет Rust ядра.
  Альтернативно — убрать `"py"` полностью и вернуть его в момент Rust+PyO3
  работ. Конкретный выбор зафиксировать в §6.
- Не трогаем `nmmo-python-host.md` (это будущий дизайн, а не текущая
  реализация).

---

## 3. Inventory того, что надо убрать

### 3.1 Runtime код

- `runtime/py/` целиком (≈ 463 `.py` файлов, ~14 MB), включая:
  - `reagent_runtime/` (полный пакет: `controller`, `protocol_engine`,
    `protocol_instance`, `agent_runner`, `inproc_*`, `ipc_*`, `nats_transport`,
    `state_store*`, `trigger_*`, `resolve_policy_evaluator`,
    `ir_fingerprint`, `otel_interceptor`, `remote_node*`, `cron_agent`, ...),
  - `requirements.txt`,
  - `.venv/` (артефакт окружения, не в git).
- `runtime/ts/src/nodes/python-behavior-factory.ts` (stub) и его экспорт из
  `runtime/ts/src/index.ts`, плюс ссылки в
  `runtime/ts/src/contracts/behavior-factory.ts`.

### 3.2 Тесты

- `runtime/ts/test/python/` целиком:
  - `runtime-core/test_runtime_core.py`,
  - `runtime-core/test_runtime_coverage.py`,
  - `triggers/test_triggers.py`,
  - `parity/test_ts_python_parity.py`,
  - `py_agent_runner.py`.
- В `runtime/ts/test/core/agent-host-boundary.test.ts` убрать `A2` и `A4`
  (зоны с Python-исполнителем через `execSync python3 ...`).
- В `runtime/ts/test/stories/runtime-semantics-nats.test.ts` убрать `T17` и
  `T18` (cross-language TS ↔ Python через NATS) и весь `runPyAgent` helper +
  `CROSSLANG_FIXTURES_DIR` / `PY_VENV_BIN` константы.

### 3.3 Фикстуры

- `examples/protocols/src/13-cross-lang-demo.rg` (`[py]` в обоих
  participant'ах).
- `examples/protocols/src/20-cross-lang-e2e.rg` (`PyAgent` + `PyRole`).
- Соответствующие `examples/out/13-cross-lang-demo/`,
  `examples/out/20-cross-lang-e2e/` (regenerable, но фикстуру `.rg` тоже надо
  убрать).
- `T4` в `runtime-semantics-nats.test.ts` использует `13-cross-lang-demo`
  как "TS-simulated" loader IR — либо переделать на TS-only фикстуру, либо
  удалить вместе с фикстурой.
- Если есть дубли в `examples/protocols/out/` (есть, по grep'у) — выровнять.
- `CR.2 EXPECTED_CR2_UNSUPPORTED` в
  [`lang/test/compiler/compiler-roundtrip.test.ts`](../../lang/test/compiler/compiler-roundtrip.test.ts):
  убрать `20-cross-lang-e2e.rg` из ожидаемого unsupported set вместе с
  удалением фикстуры.

### 3.4 Скрипты и tooling

- `package.json` (root): убрать `test:python:runtime-core`,
  `test:python:coverage`, `test:python:triggers`, `test:python:parity`,
  `test:python`; убрать `&& npm run test:python` из `test:all`.
- Аналогично проверить `runtime/ts/package.json` и
  `runtime/package.json` на python-проксики.
- `tools/reagent-vscode/`:
  - `syntaxes/reagent.tmLanguage.json` — упоминания `[py]` в подсветке
    зон (если зоны больше не валидны под `py`, оставить только грамматику
    тега, без подсветки тела как Python),
  - `server/src/server.ts`, `src/reagentParser.ts`,
    `src/embeddedLanguageMiddleware.ts`,
    `src/virtualDocumentProvider.ts`, `src/runController.ts`,
    `src/extension.ts` — все ветки, обрабатывающие `lang === "py"`,
  - `lang/ast.d.ts`, `lang/parser.js` — синхронизировать с обновлённым
    `LangTag`,
  - `preview.html` — если есть Python-specific preview hooks,
  - `server/test/lsp/compiled-lsp.smoke.test.ts`,
    `server/test/lsp/current-lsp.test.ts` — убрать или адаптировать
    Python-сценарии.

### 3.5 Документация

- `docs/current/00-registry.md`: убрать секцию "Python runtime" и пометки
  про асимметрию TS/Python.
- `docs/current/01-user-guide.md`: убрать предпосылку "Python ≥ 3.10",
  весь раздел `run.py`, примеры с `[py]` participants/roles, инструкции
  по zone-коду на Python.
- `docs/current/02-lang-spec.md`: уточнить статус `[py]` (либо убрать
  тег полностью, либо явно пометить "reserved, not currently executable").
- `docs/current/03-runtime-core.md`: убрать `PythonBehaviorFactory`,
  раздел "Managed, Custom, Python, And Gate Hosts" переименовать в
  "Managed, Custom, And Gate Hosts"; убрать упоминание Python в §1 о
  layered structure и в финальной remark про асимметрию TS/Python.
- `docs/current/04-cluster-and-control-plane.md`,
  `docs/current/05-versioning-and-reconcile.md`,
  `docs/current/06-tooling-overview.md`,
  `docs/current/07-lsp.md` — пройтись и убрать Python ссылки.
- `docs/current/08-test-spec.md`: убрать §3 `runtime/ts/test/python/`
  блок, убрать LSP/Python lane'ы из §2, обновить tier-таблицу и
  recommended validation order.
- `docs/current/09-e2e-usecases.md`: UC4 переоформить как чисто
  cross-mode (TS managed + custom + gate), без cross-language Python.
- `docs/future/test-spec-next.md` §1.5: переименовать "Python boundary"
  в "embedded Rust RC + Python host (см. nmmo-python-host)" или просто
  удалить, поскольку текущая Python boundary исчезает.
- `docs/future/backlog.md`: если есть active items по Python parity,
  закрыть их с пометкой "retired in retire-python-runtime wave".

### 3.6 Прочее

- `.gitignore` — оставить `runtime/py/.venv/` запись, чтобы не
  всплыло артефактов; либо удалить вместе с папкой.
- `mempalace.yaml` и `AGENTS.md` / `CLAUDE.md` — если есть упоминания
  Python runtime, убрать.
- Все `requirements*.txt` под `projects/unin/reagent/` (только
  `runtime/py/requirements.txt` сейчас).

---

## 4. Что НЕ удаляем сразу

- **Сам синтаксис `LangTag` в lang/src** — оставляем поле в AST/IR, чтобы
  IR-формат не ломался; просто `"py"` либо становится "reserved",
  либо временно исключается (см. §6).
- **`docs/future/nmmo-python-host.md`** — это анкер будущей работы с
  Rust + PyO3 host; этот документ останется как roadmap forward.
- **VS Code grammar для Python вообще** — встроенная Python подсветка
  редактора не наша; убираем только наши `[py]` zone-инжекты.

---

## 5. План работ

### Фаза 1 — code removal

1. Удалить `runtime/py/` и `runtime/ts/test/python/` целиком.
2. Удалить `runtime/ts/src/nodes/python-behavior-factory.ts` и убрать
   экспорт из `runtime/ts/src/index.ts` + ссылки в
   `runtime/ts/src/contracts/behavior-factory.ts`.
3. В `runtime/ts/test/core/agent-host-boundary.test.ts` убрать `A2/A4`.
4. В `runtime/ts/test/stories/runtime-semantics-nats.test.ts` убрать
   `T17/T18`, helper `runPyAgent`, константы `CROSSLANG_FIXTURES_DIR` /
   `PY_VENV_BIN` / `PY_RUNTIME_DIR`. Решить судьбу `T4` (cross-lang
   IR-shape sanity check).
5. Удалить `examples/protocols/src/13-cross-lang-demo.rg`,
   `examples/protocols/src/20-cross-lang-e2e.rg` и соответствующие
   `out/` каталоги. Перекомпилировать examples (`npm run compile:examples`).
6. Обновить `CR.2 EXPECTED_CR2_UNSUPPORTED` в
   `lang/test/compiler/compiler-roundtrip.test.ts`.
7. Убрать `test:python:*` скрипты и Python-ссылки из `package.json`
   (root + `runtime/ts` + `runtime/`).

### Фаза 2 — tooling / extension

1. Прогнать VS Code extension по списку §3.4, удалить `lang === "py"`
   ветки, обновить тесты LSP.
2. Решить судьбу `[py]` в TextMate grammar и embedded-language middleware
   (см. §6).

### Фаза 3 — docs

1. Обновить все numbered docs в `docs/current/` по списку §3.5.
2. Перепрогнать тестовую валидацию (`npm run test:default`,
   `test:runtime:cluster`, `test:stories:nats`) и зафиксировать новое
   состояние §5 `docs/current/08-test-spec.md` (без Python lane'ов).
3. Обновить `docs/future/test-spec-next.md` §1.5.
4. Закрыть Python-related пункты в `docs/future/backlog.md`.

### Фаза 4 — verification

1. Полный прогон `test:default` + `test:runtime:cluster` +
   `test:stories:nats` + `test:stories:debug` — всё должно остаться
   зелёным без python-зависимостей.
2. Поиск по репозиторию: `python`, `\[py\]`, `runtime/py`,
   `reagent_runtime`, `PyAgent`, `PyRole`, `Python` — не должно
   остаться нечего, кроме явно вынесенных в `docs/future/nmmo-python-host.md`
   и этого документа.
3. Проверить, что VSIX extension собирается и базовый LSP smoke
   проходит.

---

## 6. Открытые вопросы

- Полностью удалить `"py"` из `LangTag` в [`lang/src/ast.ts`](../../lang/src/ast.ts) и
  парсера, или оставить как зарезервированный токен (без рабочего
  emit-pipeline)?
- `T4` в `runtime-semantics-nats.test.ts` — он проверяет, что IR
  cross-lang протокола имеет правильную форму. Это полезный sanity для
  будущего hosted-Python, но требует фикстуру с `[py]`. Решение:
  переписать на TS-only фикстуру с двумя ролями (тогда тест перестаёт
  быть cross-lang, но остаётся валидным IR shape check), или удалить
  целиком вместе с фикстурой 13-cross-lang-demo.
- UC4 в `docs/current/09-e2e-usecases.md` сейчас фреймлен как "Cross-Language
  / Cross-Mode Orchestration". Удалить cross-language часть из
  формулировки, или явно отметить, что cross-language ветка отложена до
  Rust + PyO3?
- Должны ли мы попутно убрать упоминания `kt` ("kotlin") из `LangTag`,
  если они тоже не реализованы? (Скорее всего да, для симметрии.)

---

## 7. Critical reading order before doing this

- [`../current/00-registry.md`](../current/00-registry.md) — текущий статус runtime
- [`../current/03-runtime-core.md`](../current/03-runtime-core.md) §1, §8 — Python sections
- [`../current/08-test-spec.md`](../current/08-test-spec.md) §3 — test inventory
- [`nmmo-python-host.md`](nmmo-python-host.md) — целевой Python-as-host design,
  ради которого мы освобождаем место
- [`test-spec-next.md`](test-spec-next.md) §1.5 — Python boundary item, который
  нужно переписать в этой же волне

---

## 8. Definition of done

Работа считается завершённой, когда одновременно:

- `runtime/py/`, `runtime/ts/test/python/` и `python-behavior-factory.ts`
  отсутствуют в дереве,
- `npm run test:default && npm run test:runtime:cluster && npm run test:stories:nats && npm run test:stories:debug`
  зелёные, без шага установки Python deps,
- никакой документ в `docs/current/` не упоминает Python runtime как
  текущий компонент (только `nmmo-python-host.md` в `docs/future/`),
- `docs/future/test-spec-next.md` обновлён, чтобы Python boundary item
  отражал embedded Rust RC + Python host (или удалён, если этот пункт
  целиком покрыт `nmmo-python-host.md`),
- репозиторий проходит grep-проверку из Фазы 4 без неожиданных
  Python-следов.
