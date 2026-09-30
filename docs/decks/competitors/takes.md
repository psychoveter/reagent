# Reagent Competitors — Takes

## Целевое сообщение

Рынок multi-agent orchestration уже насыщен runtime-ами, workflow graphs и
swarm patterns. Ниша Reagent существует не потому, что «никто не умеет
оркестрировать агентов», а потому, что большинство систем описывает
**application workflow** или **policy выбора следующего агента**, тогда как
Reagent стремится сделать отдельным артефактом **глобальный протокол
взаимодействия**, компилируемый в локальное поведение ролей.

## Аудитория

- основатели и технические лидеры agent platforms;
- инвесторы и эксперты, знакомые с LangGraph/AutoGen/CrewAI;
- исследователи multi-agent systems и formal methods;
- потенциальные design partners Reagent.

## Драматургия

Идём от конкретного инженерного выбора к карте категории:

1. **Одна задача, много способов описания.** Команда строит сценарий
   «исследователь → рецензенты → approval». В LangGraph это state graph, в
   AutoGen — team/GraphFlow, в CrewAI — Crew + Flow, в JADE — protocol
   behaviours, в Moise — organization scheme.
2. **Определяем настоящего конкурента.** Нужны одновременно descriptor
   взаимодействия и runtime исполнения; single-agent SDK и wire protocol сами
   по себе не конкуренты.
3. **Показываем три исторические линии.**
   - workflow/graph runtimes;
   - agent teams/swarms;
   - interaction protocol/organization systems.
4. **Разбираем современных лидеров.**
   LangGraph, Microsoft Agent Framework, Dapr Agents, AutoGen, Google ADK,
   CrewAI.
5. **Показываем intellectual lineage.**
   Reagent явно продолжает идеи JADE/FIPA и JaCaMo/Moise, но переносит
   protocol-first coordination в эпоху современных LLM-, human- и tool-agents.
6. **Строим сравнительную карту.**
   Явность interaction contract × зрелость runtime; отдельно сравниваем
   durability, distribution, message semantics и verification.
7. **Делаем поворот.** Рынок умеет хорошо исполнять графы, но редко хранит
   глобальную conversation choreography как самостоятельный versioned
   contract с role-local projection.
8. **Позиционируем Reagent честно.**
   Не «ещё один swarm framework», а protocol layer между agent workflow и wire
   protocols.
9. **Показываем, где Reagent проигрывает сегодня.**
   Durability, typed enforcement, packaging, CI, ecosystem и production ops.
10. **Завершаем стратегическим выбором.**
    Сначала доказать один TS-first protocol-governed workflow; не расширять
    фронт до Rust/cloud/new verticals, пока protocol contract не стал
    надёжнее обычного workflow graph.

## Ключевые тезисы

- **Конкуренты есть, и они сильны.** LangGraph, Microsoft Agent Framework и
  Dapr Agents задают высокую планку durable distributed runtime.
- **AutoGen, Google ADK и CrewAI уже покрывают основные orchestration
  patterns:** sequential, parallel, loops, handoffs, group chat, manager-led
  collaboration.
- **JADE/FIPA и JaCaMo/Moise — концептуальный фундамент и источник
  вдохновения Reagent.** Дифференциация не в изобретении interaction protocol,
  а в его применении к современным агентам, global DSL и актуальному runtime
  stack.
- **Большинство современных платформ workflow-first, а не protocol-first.**
  Их основной артефакт — граф приложения, task plan или team policy.
- **Reagent может занять слой global choreography:** participants, legal
  messages, triggers, branching, resolve/spawn и protocol boundaries в одном
  versioned artifact.
- **Wire protocol не заменяет interaction protocol.** MCP/A2A отвечают «как
  соединиться», Reagent — «какой разговор допустим».
- **Отдельный protocol artifact имеет смысл только при реальном enforcement.**
  Documentary message schemas, неполная projection semantics и отсутствие
  checkpoint/resume размывают дифференциацию.
- **Стратегия — не больше features, а сильнее contract.** Typed messages,
  role projection, deterministic conformance, durability и audit должны
  опережать новые hosts/transports.

## Честные оговорки

- Сравнение качественное, а не benchmark производительности или adoption.
- У современных фреймворков быстро меняются API и product packaging; дата
  среза должна оставаться на слайдах.
- `LangGraph`, `Microsoft Agent Framework`, `AutoGen`, `ADK` и `CrewAI`
  покрывают разные уровни abstraction; прямое сравнение всегда частично.
- JADE/Moise — зрелые идеи из классического MAS, но не готовая замена
  современному LLM-agent stack.
- Reagent пока advanced alpha: `$self`/FSM не checkpointed, message schemas
  largely documentary, а часть runtime paths требует hardening.
- TLA+ generation не верифицирует произвольное поведение host-language zones.
- Эта дека формулирует defensible positioning, а не утверждает технологическое
  лидерство Reagent сегодня.

## Источники

- `files/research.md` — сравнительная матрица и первичные ссылки.
- `../startupcamp/files/competitors.md` — предыдущий problem-oriented анализ.
- `../../current/02-lang-spec.md` — current language surface Reagent.
- `../../current/03-runtime-core.md` — current runtime/process model.
- `../../current/08-test-spec.md` — текущие тесты и известные gaps.

