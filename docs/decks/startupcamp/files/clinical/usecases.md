# Reagent в медицине и фармакологии: практические кейсы протоколов

Материал к startupcamp. Цель — показать **конкретные клинические и
фарм-протоколы**, которые ложатся на модель Reagent, и раскрыть гипотезу о
**модульной сертификации** (сертифицирована платформа → протоколы
валидируются по отдельности, а не всё ПО целиком).

Исходный набросок ролей — [`protocols_narrative.md`](protocols_narrative.md)
(клиницист ведёт протокол и задаёт вопросы; исследователь; клиент). Здесь он
развёрнут до платформы и каталога протоколов.

> ⚠️ Дисклеймер. Регуляторные тезисы (§3) — это **продуктовая гипотеза и
> направление**, а не юридическое заключение. Любую сертификационную стратегию
> нужно валидировать с QA/RA-экспертом (FDA/EMA/Roszdravnadzor) и клиническим
> юристом. Здесь мы фиксируем, *почему архитектура Reagent делает такую
> стратегию правдоподобной*.

---

## 1. Платформа: участники и слои

Представим платформу **«сертифицированный исполнитель клинических
протоколов»**. Reagent — её control plane: протокол (`.rg`) — это
исполняемый клинический/исследовательский регламент, а RC исполняет его как
state machine, не давая никому (включая LLM-агентов) выйти за рамки.

### Участники (роли в терминах Reagent)

| Участник | Кто это | Тип агента / интеграция |
|---|---|---|
| **Client / Patient** | Пациент в мобильном/веб-приложении | Gate-агент (приложение как клиент через WS/HTTP gate) или MCP-агент |
| **Clinician** | Врач/терапевт ведёт протокол, принимает решения, апрувит шаги | Gate-агент (клиницистский интерфейс) с human-in-the-loop |
| **Investigator / PI** | Главный исследователь, sponsor-сторона в КИ | Gate / admin-роль |
| **Autonomous agent** | LLM-ассистент: скрининг, мониторинг, кодирование симптомов, предзаполнение CRF | Managed `[ts]`-зоны или MCP/Claude-агент |
| **Data registry** | EDC/EHR/реестр (REDCap, OMOP CDM, FHIR-store, pharmacovigilance DB) | Custom `BehaviorFactory` или gate к внешней системе |
| **Safety / PV monitor** | Фармаконадзор, DSMB, safety officer | Роль с эскалационной границей |

### Слои платформы

```
┌─────────────────────────────────────────────────────────┐
│  Приложения: пациент, клиницист, PI, safety-officer       │  ← gate / MCP
│   UI авто-генерируется из протокола (см. §1.1)            │
├─────────────────────────────────────────────────────────┤
│  Reagent RC (control plane): исполняет .rg-протоколы       │
│   — protocol-bounded interaction (нельзя вне state machine)│
│   — $self (состояние участника), $ctx (состояние сессии)   │
│   — OTel trace + protocol-run records (полный аудит-трейл) │
├─────────────────────────────────────────────────────────┤
│  Реестры данных: EDC / EHR(FHIR) / OMOP / PV-DB            │  ← custom factory
└─────────────────────────────────────────────────────────┘
```

**Ключевая идея:** клинический протокол перестаёт быть PDF-регламентом,
который каждый сайт реализует по-своему, и становится **единым исполняемым
артефактом**, развёрнутым на сертифицированной платформе.

### 1.1 Авто-генерируемый UI, ведомый протоколом

Приложение человека (пациента, клинициста) **не верстается вручную под каждый
протокол** — его интерфейс выводится из самого `.rg`. Протокол в Reagent — это
типизированные схемы сообщений (`message`) + state machine, поэтому из IR
детерминированно следует:

- **какие поля** показать в форме (из схемы сообщения, которое участник
  должен отправить/получить);
- **что сейчас легально** ввести или отправить (из текущего состояния
  protocol-run — RC всё равно не пропустит шаг вне state machine);
- **порядок шагов** сессии (из choreography: какой `send`/`receive`/`action`
  следующий для данной роли).

Иначе говоря, gate-приложение получает `ProtocolEvent` и **рендерит UI как
проекцию состояния протокола**, а не как отдельную захардкоженную логику.

**Почему это важно именно в клинике:**

1. **Замыкает сертификационный аргумент (§3) на фронтенд.** Если UI —
   *проекция* сертифицированного протокола, а не отдельный custom-код, то он
   не образует отдельную валидационную поверхность. Один артефакт `.rg`
   определяет и бэкенд-исполнение, и форму взаимодействия с человеком.
2. **Убирает implementation gap.** Классическая болезнь КИ — каждый сайт
   реализует визитные формы/опросники по-своему. Авто-UI гарантирует, что все
   видят одну и ту же форму, выведенную из одной спеки.
3. **Снижает per-protocol стоимость.** Новый протокол → рабочий UI «из
   коробки», без отдельного цикла фронтенд-разработки и его валидации.

**Честная оговорка (статус):** это **roadmap-возможность**, а не готовая
фича. Сегодня RC отдаёт `ProtocolEvent` и типы сообщений, но генератора UI в
коде нет. Для богатых клинических форм (валидированные шкалы, виджеты, тексты
вопросов, локализация) схемы сообщений нужно дополнить **UI-аннотациями**
(например, метаданные поля: тип виджета, диапазон, обязательность, текст
вопроса). Это естественное расширение `message`-схем и отдельный пункт в
roadmap платформы.

---

## 2. Почему именно Reagent уместен в клинике

Пять свойств Reagent, которые в медицине из «приятно» превращаются в
«обязательно» (ср. [`competitors.md`](../competitors.md) §4–§7):

1. **Protocol-bounded interaction.** RC advance только по легальным
   переходам. LLM-агент-ассистент **физически не может** отправить пациенту
   сообщение или записать в реестр данные, не предусмотренные протоколом.
   Это снимает класс рисков «агент сгаллюцинировал и сделал недопустимое
   клиническое действие».
2. **Формальная верификация (`reagent verify` → TLA+).** До развёртывания
   доказываем: протокол не зависает, корректно завершается, safety-эскалация
   достижима из любого состояния (например, «из любой точки сессии достижим
   путь к risk-escalation»).
3. **Версионирование + fingerprints.** Каждое изменение протокола —
   классифицированный bump (MAJOR/MINOR/PATCH) в `reagent.lock`. Регулятор
   видит точную историю: что менялось в структуре (MAJOR) vs только в тексте
   зоны (PATCH). Это прямой ответ на требование change control в GxP.
4. **Полный аудит-трейл.** OTel-трассировка + protocol-run records в
   `StateStore` дают неизменяемую запись «кто, что, когда, в каком состоянии
   протокола». Это то, что требует 21 CFR Part 11 (audit trail) и GCP.
5. **Гетерогенные участники под одной choreography.** Пациент (мобильное
   приложение), клиницист (human-in-the-loop), LLM-ассистент, реестр данных —
   все говорят через один протокол с типизированными сообщениями.

---

## 3. Сертификационный аргумент (модульная валидация)

Это центральная коммерческая гипотеза вопроса пользователя. Раскрываю с
опорой на реальные регуляторные рамки.

### Проблема сегодня

Клиническое ПО (SaMD — Software as a Medical Device, или
исследовательская EDC-система) валидируется **целиком**: каждое изменение
кода = повторная валидация всей системы (CSV — Computerized System
Validation). Любая новая клиническая логика — это новый код → новый цикл
валидации. Это медленно и дорого, поэтому клинические протоколы редко
бывают «software-defined».

### Гипотеза Reagent: разделение «платформа» и «протокол»

Архитектура Reagent проводит **жёсткую границу** между:

- **Платформой** (RC, язык, компилятор, верификатор, аудит-слой) — это
  стабильный, верифицированный, **один раз сертифицированный** компонент.
- **Протоколом** (`.rg`-артефакт) — это **конфигурация/данные**, а не код
  платформы. Зоны (`[ts]`/`[py]`) — ограниченные участки логики, исполняемые
  в песочнице RC.

Если регулятор принимает, что:

1. платформа (RC + верификатор + аудит) валидирована и заморожена,
2. протокол не может выйти за её рамки (protocol-bounded execution),
3. каждый протокол проходит формальную верификацию и фиксируется
   fingerprint'ом,

— то **валидация отдельного протокола** сводится к проверке **самого `.rg`**
(его клинического содержания и пройденной верификации), а не всего стека ПО.

### Где это перекликается с реальными фреймворками

- **GAMP 5 «configurable vs custom».** GAMP 5 уже различает валидацию
  конфигурируемых продуктов и кастомной разработки. Reagent позиционирует
  протокол как **configuration item**, а не custom code — это снижает
  валидационную нагрузку по самой логике GAMP 5.
- **FDA PCCP (Predetermined Change Control Plan).** FDA позволяет для
  AI/ML-SaMD заранее согласовать «план предопределённых изменений».
  Fingerprint-классификация изменений протокола (MAJOR/MINOR/PATCH) —
  естественный технический носитель для PCCP: заранее описываем, какие
  классы изменений допустимы без ре-сабмишена.
- **IEC 62304 (software lifecycle).** Разделение на «platform software» и
  «protocol artifacts» с разными процессами изменений ложится на
  segregation концепции 62304.
- **21 CFR Part 11 / EU Annex 11.** Аудит-трейл, электронные подписи,
  контроль изменений — закрываются OTel + protocol-run records + signed
  deploy.
- **ICH GCP E6(R3).** Требует контроль версий протокола и аудируемость
  отклонений — это ровно versioning + trace Reagent.

### Формулировка для питча

> «Сертифицируете платформу один раз. Дальше каждый новый клинический
> протокол — это верифицированный `.rg`-артефакт, который проходит
> **облегчённую протокол-уровневую сертификацию**, а не полную ре-валидацию
> ПО. Reagent даёт регулятору три вещи, которых нет у обычного клинического
> софта: формальное доказательство корректности протокола, неизменяемый
> аудит-трейл и точную классификацию каждого изменения.»

### Честные оговорки

- Регулятор должен **признать** границу «платформа/протокол». Это нужно
  проактивно прорабатывать (pre-submission meeting с FDA, scientific advice
  с EMA).
- Зоны (`[ts]`/`[py]`) — это всё-таки исполняемый код; нужно ограничить их
  выразительность или санд­боксировать так, чтобы «протокол = конфигурация»
  держалось юридически.
- LLM-агенты внутри протокола — отдельный регуляторный объект (их
  недетерминизм), даже если оркестрация верифицирована. Reagent снижает
  риск (protocol-bounded), но не отменяет валидацию самой модели.

---

## 4. Кейсы: клинические испытания

### 4.1 Информированное согласие + скрининг на eligibility

**Зачем:** самый частый источник protocol deviation в КИ — ошибки в
информированном согласии и нарушения критериев включения/исключения.
Software-defined протокол гарантирует, что рандомизация **недостижима** без
подписанного согласия и пройденного скрининга.

```rg
message ConsentForm   { trialId: string, version: string }
message ConsentSigned { signatureId: string, signedAt: string }
message ScreeningData { age: number, labs: any, comorbidities: any[] }
message EligibilityDecision { eligible: boolean, failedCriteria: string[] }
message Enrollment    { subjectId: string, arm: string }

protocol TrialEnrollment {
  participants:
    coordinator [ts] initiator,   // координатор сайта (clinician)
    patient [ts],                 // пациент в приложении
    screeningAgent [ts],          // LLM-ассистент скрининга
    registry [ts]                 // EDC / реестр

  trigger on invoke with ConsentForm {
    resolve coordinator = single
    resolve patient = single
    resolve screeningAgent = single
    resolve registry = single
  }

  // 1. Согласие — обязательный шлюз
  coordinator --> patient: ConsentForm = {
    onSend    { $ctx.msg.trialId = $ctx.input.trialId; $ctx.msg.version = $ctx.input.version }
    onReceive { $self.shownConsentVersion = $ctx.msg.version }
  }

  patient --> coordinator: ConsentSigned = {
    onReceive { $ctx.consent = $ctx.msg }   // зафиксировали подпись
  }

  // 2. Скрининг eligibility (LLM проверяет критерии против протокола)
  coordinator --> screeningAgent: ScreeningData = {
    onSend    { $ctx.msg.age = $ctx.input.age; $ctx.msg.labs = $ctx.input.labs }
    onReceive { $self.screening = $ctx.msg }
  }

  screeningAgent {
    // LLM сверяет данные с inclusion/exclusion criteria протокола.
    $ctx.decision = await $agent.evaluate_eligibility($self.screening)
  }

  screeningAgent --> coordinator: EligibilityDecision = {
    onSend    { $ctx.msg.eligible = $ctx.decision.eligible; $ctx.msg.failedCriteria = $ctx.decision.failed }
    onReceive { $ctx.eligibility = $ctx.msg }
  }

  // 3. Рандомизация — достижима ТОЛЬКО при eligible == true
  alt ($ctx.eligibility.eligible) {
    coordinator {
      $ctx.assignment = await $agent.randomize($ctx.consent.signatureId)
    }
    coordinator --> registry: Enrollment = {
      onSend { $ctx.msg.subjectId = $ctx.assignment.subjectId; $ctx.msg.arm = $ctx.assignment.arm }
    }
  } else {
    coordinator --> registry: EligibilityDecision = {
      onSend { $ctx.msg.eligible = false; $ctx.msg.failedCriteria = $ctx.eligibility.failedCriteria }
    }
  }
}
```

**Что даёт verify:** доказываем, что нет пути `Enrollment` без
предшествующего `ConsentSigned` и `eligible == true`. Это структурная
гарантия, а не «надеемся, что код проверяет».

### 4.2 Эскалация нежелательных явлений (AE/SAE → фармаконадзор)

**Зачем:** SAE-репортинг жёстко регламентирован по срокам (например, 24h для
жизнеугрожающих). Протокол кодирует сроки и обязательность эскалации.

```rg
message AdverseEvent { subjectId: string, term: string, severity: string, onset: string }
message Causality    { related: boolean, assessment: string }
message SAEReport    { caseId: string, expedited: boolean }
message RegulatoryFiling { authority: string, deadline: string }

protocol AdverseEventReporting {
  participants:
    site [ts] initiator,          // сайт/clinician сообщает AE
    pvAgent [ts],                 // pharmacovigilance LLM-ассистент
    safetyOfficer [ts],           // human safety officer
    authority [ts]                // регуляторный реестр

  trigger on event "ae.reported" with AdverseEvent {
    resolve site = single
    resolve pvAgent = single
    resolve safetyOfficer = single
    resolve authority = single
  }

  site --> pvAgent: AdverseEvent = {
    onReceive { $self.event = $ctx.msg }
  }

  pvAgent {
    // LLM: MedDRA-кодирование, оценка seriousness и причинности.
    $ctx.assessment = await $agent.assess_causality($self.event)
    $ctx.isSerious   = await $agent.is_serious($self.event)
  }

  // Серьёзное событие → обязательная человеческая верификация + ускоренный репорт
  alt ($ctx.isSerious) {
    pvAgent --> safetyOfficer: Causality = {
      onSend    { $ctx.msg.related = $ctx.assessment.related; $ctx.msg.assessment = $ctx.assessment.text }
      onReceive { $self.review = $ctx.msg }
    }

    safetyOfficer {
      // Human подтверждает оценку (4-eyes principle).
      $ctx.confirmed = await $agent.confirm_sae($self.review)
    }

    safetyOfficer --> authority: SAEReport = {
      onSend { $ctx.msg.caseId = $ctx.confirmed.caseId; $ctx.msg.expedited = true }
    }
  } else {
    pvAgent --> safetyOfficer: Causality = {
      onSend { $ctx.msg.related = $ctx.assessment.related; $ctx.msg.assessment = $ctx.assessment.text }
    }
  }
}
```

**Что даёт Reagent:** `trigger on event` ловит AE из любой точки системы;
`alt` гарантирует, что SAE **не может** уйти регулятору без подтверждения
человеком (safety officer). Можно добавить `wait`-таймеры и cron-проверку
дедлайнов (см. 4.3).

### 4.3 Контроль визитного графика и дозирования

**Зачем:** protocol adherence — visit windows, dosing schedule. `trigger on
cron` проверяет окна визитов; отклонения логируются автоматически.

Скетч (сокращённо):

```rg
protocol VisitAdherence {
  participants: monitor [ts] initiator, patient [ts], registry [ts]

  trigger on cron "0 8 * * *" {       // ежедневная проверка окон визитов
    resolve monitor = single
    resolve patient = single
    resolve registry = single
  }

  monitor {
    $ctx.due = await $agent.visits_due_today()   // из EDC
  }

  scatter ($ctx.due as patient) {
    monitor --> patient: VisitReminder = { /* напоминание + сбор PRO */ }
    patient --> registry: VisitData     = { /* данные визита в реестр */ }
  }

  monitor {
    // отклонения (пропущенное окно) фиксируются как protocol deviation
    $ctx.deviations = await $agent.detect_deviations($ctx.due)
  }
}
```

### 4.4 Прочие протоколы КИ (каталог)

| Протокол | Что кодирует | Ключевой Reagent-механизм |
|---|---|---|
| **Randomization & blinding** | Распределение по рукам, контроль ослепления | `alt`, изоляция `$ctx` по ролям |
| **Source data verification** | Сверка CRF ↔ исходные данные между сайтом и монитором | invoke под-протокол, типизированные сообщения |
| **Data query resolution** | Запрос-ответ по расхождениям данных | `wait on`, loop до разрешения |
| **DSMB interim analysis** | Триггер промежуточного анализа по накоплению событий | `trigger on event`, scatter по сайтам |
| **Protocol amendment rollout** | Выкатка поправки на все сайты с версионированием | fingerprints + reconcile |
| **eConsent re-consent** | Повторное согласие при amendment | reuse 4.1 как под-протокол |

---

## 5. Кейсы: психотерапия

### 5.1 Структурированная сессия measurement-based care с safety-границей

**Зачем:** измеряемая терапия (routine outcome monitoring) — стандарт
доказательной психотерапии: каждая сессия начинается с валидированных шкал
(PHQ-9 депрессия, GAD-7 тревога), а скрининг суицидального риска (C-SSRS)
должен **всегда** иметь достижимый путь эскалации. Это идеальный кейс для
formal verification: «из любого состояния сессии достижима safety-эскалация».

```rg
message SessionStart   { clientId: string, sessionNo: number }
message PHQ9           { items: number[], total: number }
message RiskScreen     { cssrs: any, riskLevel: string }   // none|low|high
message SafetyPlan     { steps: string[], contacts: any[] }
message SessionPlan    { focus: string, homework: string[] }
message Escalation     { clinicianId: string, reason: string }

protocol TherapySession {
  participants:
    therapist [ts] initiator,     // терапевт (human-in-the-loop)
    client [ts],                  // клиент в приложении
    assistAgent [ts],             // LLM-ко-терапевт (скоринг, подготовка)
    crisisTeam [ts]               // дежурная кризисная служба

  trigger on invoke with SessionStart {
    resolve therapist = single
    resolve client = single
    resolve assistAgent = single
    resolve crisisTeam = single
  }

  // 1. Сбор валидированных шкал
  therapist --> client: PHQ9 = {
    onReceive { $self.phq9 = $ctx.msg.total }
  }

  // 2. Скрининг риска — обязательный шаг перед любым терапевтическим контентом
  therapist --> client: RiskScreen = {
    onReceive { $ctx.risk = $ctx.msg.riskLevel }
  }

  // 3. Safety-граница: высокий риск => немедленная эскалация, минуя обычный поток
  alt ($ctx.risk == "high") {
    assistAgent {
      $ctx.plan = await $agent.build_safety_plan($self.phq9)
    }
    assistAgent --> client: SafetyPlan = {
      onSend { $ctx.msg.steps = $ctx.plan.steps; $ctx.msg.contacts = $ctx.plan.contacts }
    }
    therapist --> crisisTeam: Escalation = {
      onSend { $ctx.msg.reason = "C-SSRS high risk"; $ctx.msg.clinicianId = $ctx.input.clinicianId }
    }
  } else {
    // 4. Обычный терапевтический поток (CBT)
    assistAgent {
      $ctx.plan = await $agent.prepare_session($self.phq9, $ctx.risk)
    }
    assistAgent --> therapist: SessionPlan = {
      onReceive { $self.plan = $ctx.msg }
    }
    therapist --> client: SessionPlan = {
      onSend { $ctx.msg.focus = $self.plan.focus; $ctx.msg.homework = $self.plan.homework }
    }
  }
}
```

**Что даёт verify:** доказываем инвариант «risk-screen всегда исполняется до
терапевтического контента» и «из ветки high-risk достижима `Escalation`».
Для регулятора и страховщика — это формальная гарантия safety, а не
обещание в инструкции.

### 5.2 Между сессиями: мониторинг и ассистент

**Зачем:** домашние задания, дневники настроения, ЕМА (ecological momentary
assessment). Cron-протокол собирает PRO между сессиями и поднимает флаг
терапевту при ухудшении.

```rg
protocol BetweenSessionMonitoring {
  participants: monitor [ts] initiator, client [ts], therapist [ts]

  trigger on cron "0 20 * * *" {        // ежевечерний чек-ин
    resolve monitor = single
    resolve client = single
    resolve therapist = single
  }

  monitor --> client: MoodCheck = { /* короткий дневник + EMA */ }

  monitor {
    $ctx.trend = await $agent.assess_trend($ctx.history)
  }

  alt ($ctx.trend == "deteriorating") {
    monitor --> therapist: Alert = { /* поднять флаг до следующей сессии */ }
  } else { /* тихо записать в реестр */ }
}
```

### 5.3 Прочие психотерапевтические протоколы (каталог)

| Протокол | Что кодирует | Reagent-механизм |
|---|---|---|
| **Collaborative care** | Психиатр + терапевт + ПМСП + пациент вокруг плана лечения | multi-role choreography, invoke |
| **Medication titration (psych)** | Подбор дозы антидепрессанта по шкалам + побочкам | loop + `wait`, feedback от lab/PRO |
| **Exposure therapy hierarchy** | Пошаговая экспозиция с градацией | loop, `$self` прогресс |
| **Group therapy session** | Терапевт + N участников | scatter по участникам |
| **Crisis escalation** | Эскалация кризиса в дежурную службу | `trigger on event`, safety boundary |
| **Relapse prevention** | Долгосрочный мониторинг после курса | cron + долгоживущий protocol-run |

---

## 6. Кейсы: фармакология / фармаконадзор

| Протокол | Что кодирует | Reagent-механизм |
|---|---|---|
| **Signal detection** | Накопление сигналов по препарату из множества источников | `trigger on event`, scatter, агрегация |
| **Drug-interaction check at prescribing** | Проверка взаимодействий перед назначением | синхронный invoke под-протокол, gate к реестру |
| **REMS-style контроль** | Risk Evaluation & Mitigation: допуск к препарату только при выполненных условиях | `alt`-шлюзы (как 4.1) |
| **Dose titration с lab-feedback** | Коррекция дозы по лабораторным маркерам | loop + `wait on` результат лаборатории |
| **Periodic safety report (PSUR/PBRER)** | Сбор и агрегация по расписанию | cron + scatter по сайтам/реестрам |

Эти кейсы переиспользуют те же механизмы, что КИ и психотерапия —
платформа одна, протоколы разные.

---

## 7. Кейс: пространство обмена клиентскими данными (data space)

До сих пор §1 описывал **одну** сертифицированную платформу-исполнитель. Этот
кейс — про другую топологию: **несколько компаний**, каждая собирает данные о
своих клиентах, и между их сервисами нужно выстроить **протокол обмена**. Ни
одна сторона не доверяет другой свои «сырые» данные, но обмен всё равно нужен —
например, чтобы собрать **частную модель пациента** из фрагментов, лежащих в
разных организациях (лаборатория, клиника, носимое устройство, страховая).

Это паттерн **data space** (ср. International Data Spaces / Gaia-X / Eclipse
Dataspace Connector, а в медицине — European Health Data Space, EHDS). Reagent
здесь добавляет то, чего нет у обычных data-space-коннекторов: **сам договор об
обмене — это верифицируемый исполняемый артефакт**, а не политика, зашитая в код
коннектора.

### Что меняется в модели платформы

| Клиническая платформа (§1) | Пространство обмена данными (§7) |
|---|---|
| один сертифицированный исполнитель | несколько взаимно-недоверяющих держателей |
| протокол = клинический регламент | протокол = **соглашение об обмене** между сторонами |
| RC исполняет state machine для всех | у каждого держателя свой **гейт**; протокол — общий контракт |
| данные внутри платформы | сырые данные **не покидают** организацию-держателя |

Три точки контроля, которые задаёт вопрос пользователя:

1. **Консент субъекта.** Согласие — first-class шаг протокола: purpose-bound
   (под конкретную цель), scoped (под конкретный набор полей), с TTL и
   **отзываемое**. До получения валидного гранта `Release` структурно
   недостижим (GDPR consent + purpose limitation; EHDS data permit; FHIR
   `Consent`; GA4GH DUO для health/omics).
2. **Валидация/контроль на гейте держателя.** Каждая компания держит **свой
   гейт** — он проверяет грант, политику доступа, схему и качество данных и
   **минимизирует scope** (выдаётся только пересечение запрошенного и
   разрешённого согласием — data minimization, GDPR Art 5(1)(c)).
3. **Анонимизация на источнике.** Псевдонимизация/обезличивание происходит
   **до выхода за границу организации**: данные читаются локально, наружу
   уходит только обезличенный/минимизированный набор. «Сырой PII не покидает
   держателя».

### Поток обмена

```
   Requester (компания B)                         Subject (клиент/пациент)
        │  1. DataRequest                                 ▲
        │     (purpose, scope)                            │ 2. ConsentPrompt
        ▼                                                 │    → ConsentGrant
   ┌─────────────────────┐   ──────────────────────────────┐  (purpose-bound,
   │  Consent Registry   │ ◀─ source of truth по согласиям  │   scoped, TTL,
   └──────────┬──────────┘                                   │   revocable)
              │ 3. ConsentGrant (granted, scope)
              ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  Holder Gate (компания A)        Privacy Agent (анонимизация)     │
   │   3. policy + минимизация scope   4. read_local → anonymize       │  ← raw PII
   └───────────────────────────────────────────────┬──────────────────┘    остаётся
              5. DataPayload (только обезличенное)   │                       внутри A
              ◀───────────────────────────────────── ┘
                                                      └─ 6. AuditRecord → Audit/регулятор
```

### 7.1 Кросс-организационный обмен с консентом и гейтом

```rg
message DataRequest    { subjectId: string, purpose: string, scope: string[], requesterId: string }
message ConsentPrompt  { purpose: string, scope: string[], requester: string, expiresAt: string }
message ConsentGrant   { granted: boolean, grantId: string, scope: string[], expiresAt: string }
message PolicyDecision { allow: boolean, grantId: string, minimizedScope: string[], reasons: string[] }
message DataPayload    { grantId: string, fields: any, privacy: string }   // pseudonymized | anonymized
message AuditRecord    { grantId: string, requesterId: string, releasedFields: string[] }

protocol CrossOrgDataExchange {
  participants:
    requester [ts] initiator,     // сервис-потребитель (другая компания)
    subject [ts],                 // владелец данных (клиент/пациент)
    consentRegistry [ts],         // реестр согласий — source of truth
    holderGate [ts],              // гейт компании-держателя данных
    privacyAgent [ts],            // анонимизация/минимизация (managed зона)
    audit [ts]                    // аудит / регулятор

  trigger on invoke with DataRequest {
    resolve requester = single
    resolve subject = single
    resolve consentRegistry = single
    resolve holderGate = single
    resolve privacyAgent = single
    resolve audit = single
  }

  // 1. Запрос потребителя: цель + запрошенный набор полей
  requester --> consentRegistry: DataRequest = {
    onSend    { $ctx.msg.subjectId = $ctx.input.subjectId; $ctx.msg.purpose = $ctx.input.purpose;
                $ctx.msg.scope = $ctx.input.scope; $ctx.msg.requesterId = $ctx.input.requesterId }
    onReceive { $ctx.req = $ctx.msg }
  }

  consentRegistry {
    $ctx.existing = await $agent.lookup_consent($ctx.req)   // есть ли действующий грант?
  }

  // 2. Just-in-time consent: если действующего согласия нет — спрашиваем субъекта
  alt (!$ctx.existing.valid) {
    consentRegistry --> subject: ConsentPrompt = {
      onSend { $ctx.msg.purpose = $ctx.req.purpose; $ctx.msg.scope = $ctx.req.scope;
               $ctx.msg.requester = $ctx.req.requesterId }
    }
    subject --> consentRegistry: ConsentGrant = {
      onReceive { $ctx.grant = $ctx.msg }   // субъект может СУЗИТЬ scope или отказать
    }
  } else {
    consentRegistry { $ctx.grant = $ctx.existing.grant }
  }

  // 3. Жёсткий шлюз: без granted == true дальше ничего не происходит
  alt ($ctx.grant.granted) {

    consentRegistry --> holderGate: ConsentGrant = {
      onSend    { $ctx.msg.grantId = $ctx.grant.grantId; $ctx.msg.scope = $ctx.grant.scope; $ctx.msg.granted = true }
      onReceive { $ctx.holderGrant = $ctx.msg }
    }

    holderGate {
      // data minimization: только пересечение запрошенного и разрешённого согласием
      $ctx.minim = await $agent.evaluate_policy($ctx.req, $ctx.holderGrant)
    }

    // 4. Анонимизация ДО выхода за границу организации
    holderGate --> privacyAgent: PolicyDecision = {
      onSend    { $ctx.msg.allow = $ctx.minim.allow; $ctx.msg.grantId = $ctx.grant.grantId;
                  $ctx.msg.minimizedScope = $ctx.minim.scope }
      onReceive { $ctx.policy = $ctx.msg }
    }

    privacyAgent {
      // данные читаются ЛОКАЛЬНО у держателя; наружу уходит только обезличенное
      $ctx.raw  = await $agent.read_local($ctx.policy.minimizedScope)
      $ctx.safe = await $agent.anonymize($ctx.raw, $ctx.policy.minimizedScope)
    }

    // 5. Релиз минимизированного/обезличенного набора потребителю
    privacyAgent --> requester: DataPayload = {
      onSend { $ctx.msg.grantId = $ctx.policy.grantId; $ctx.msg.fields = $ctx.safe.fields;
               $ctx.msg.privacy = $ctx.safe.level }
    }

    // 6. Неизменяемая аудит-запись о факте и составе раскрытия
    privacyAgent --> audit: AuditRecord = {
      onSend { $ctx.msg.grantId = $ctx.policy.grantId; $ctx.msg.requesterId = $ctx.req.requesterId;
               $ctx.msg.releasedFields = $ctx.safe.fieldNames }
    }

  } else {
    consentRegistry --> requester: PolicyDecision = {
      onSend { $ctx.msg.allow = false; $ctx.msg.reasons = ["no valid consent"] }
    }
  }
}
```

**Что даёт verify (privacy-инварианты как теоремы, а не как код-ревью):**

- **I1 — нет данных без согласия:** не существует пути к `DataPayload` у
  `requester` без предшествующего `ConsentGrant{granted: true}`.
- **I2 — нет egress без анонимизации:** любой `DataPayload` достижим только
  через зону `privacyAgent.anonymize` (нет ветки `read_local → requester`,
  минующей обезличивание).
- **I3 — минимизация:** `releasedFields ⊆ minimizedScope ⊆ grant.scope`
  (структурно — через гейт, плюс проверка в зоне).
- **I4 — отзыв достижим:** из любого состояния обмена достижима остановка
  выдачи по гранту (см. 7.2).

### 7.2 Отзыв согласия (right to withdraw)

GDPR Art 7(3): отзыв согласия должен быть так же прост, как его выдача.
Отзыв — отдельный протокол, веером уведомляющий всех держателей с активными
грантами; после него дальнейшая выдача по гранту недостижима.

```rg
message RevokeRequest { subjectId: string, grantId: string }
message RevokeAck     { grantId: string, revokedAt: string }

protocol ConsentRevocation {
  participants:
    subject [ts] initiator,
    consentRegistry [ts],
    holder [ts] many,             // все держатели с активными грантами
    audit [ts]

  trigger on event "consent.revoke" with RevokeRequest {
    resolve subject = single
    resolve consentRegistry = single
    resolve holder = all
    resolve audit = single
  }

  subject --> consentRegistry: RevokeRequest = {
    onReceive { $ctx.revoke = $ctx.msg }
  }

  consentRegistry {
    $ctx.affected = await $agent.revoke_grant($ctx.revoke.grantId)   // грант → revoked, список держателей
  }

  // веерное уведомление: прекратить дальнейшую выдачу по гранту
  scatter ($ctx.affected as holder) {
    consentRegistry --> holder: RevokeRequest = {
      onSend { $ctx.msg.grantId = $ctx.revoke.grantId; $ctx.msg.subjectId = $ctx.revoke.subjectId }
    }
    holder --> audit: RevokeAck = {
      onSend { $ctx.msg.grantId = $ctx.revoke.grantId }
    }
  }
}
```

### 7.3 Чем Reagent отличается от обычного data-space-коннектора

| Сегодня (IDS / EDC / custom) | С Reagent |
|---|---|
| политика обмена — код внутри коннектора | политика **= state machine протокола**, её нельзя обойти |
| «договор об обмене» — PDF/JSON-policy | соглашение об обмене — **исполняемый верифицируемый `.rg`** |
| доверие к коннектору на слово | формальное доказательство I1–I4 до развёртывания |
| лог постфактум | OTel trace + protocol-run records: кто/что/зачем/какие поля |
| версии соглашения вручную | fingerprints (MAJOR/MINOR/PATCH) на сам протокол обмена |

Это ровно **P4 (contract execution between parties)** из
[`competitors.md`](../competitors.md): соглашение об обмене данными — это
исполняемый контракт между взаимно-недоверяющими сторонами, без
trust-overhead блокчейна.

### 7.4 Честные ограничения этого кейса

- **Reagent гарантирует маршрут, а не достаточность анонимизации.** Можно
  доказать, что данные **прошли через privacy-гейт** и что выдан только
  минимизированный scope, но «достаточно ли обезличены» (риск
  ре-идентификации) — статистическое свойство данных и трансформации, а не
  протокола. Это отдельный анализ (k-анонимность, DP-бюджет) внутри зоны.
- **`privacyAgent` — это код в зоне** (как и в §10): чтобы «протокол =
  конфигурация» держалось, анонимизация должна быть сертифицированной
  библиотекой-примитивом платформы, а не произвольной логикой протокола.
- **Транспорт и шифрование** (mTLS, at-rest, data residency) — слой ниже
  протокола; Reagent описывает choreography, но не заменяет secure channel.
- **Консент-реестр как доверенная сторона.** В модели §7.1 `consentRegistry` —
  source of truth; для multi-org без единого доверенного арбитра нужен
  либо нейтральный оператор реестра, либо распределённый журнал согласий.

---

## 8. Что конкретно платформа даёт аудитору/регулятору

| Требование регулятора | Чем закрывает Reagent |
|---|---|
| Контроль версий протокола (GCP E6(R3)) | fingerprints + `reagent.lock`, MAJOR/MINOR/PATCH |
| Audit trail (21 CFR Part 11, Annex 11) | OTel trace + protocol-run records (CAS, неизменяемые) |
| Доказательство корректности логики | `reagent verify` → TLA+/TLC (deadlock-free, safety reachability) |
| Невозможность недопустимых действий | protocol-bounded execution в RC |
| Разделяемость изменений | граница «платформа vs протокол-артефакт» |
| 4-eyes / human-in-the-loop | роли с human-апрувом (safety officer, therapist) |
| Прослеживаемость данных | типизированные сообщения + явные потоки в/из реестра |
| Консистентность форм между сайтами | авто-генерируемый UI как проекция протокола (§1.1) |
| Согласие + целевое ограничение (GDPR, EHDS) | консент как first-class шаг протокола, purpose-bound/scoped/revocable (§7) |
| Минимизация данных (GDPR Art 5) | гейт держателя выдаёт только `minimizedScope ⊆ consent.scope` (§7.1, I3) |
| Обезличивание перед передачей | структурная гарантия прохода через privacy-гейт (§7.1, I2) |

---

## 9. Маппинг на дифференциацию Reagent

Связь с [`competitors.md`](../competitors.md): клиника — это домен, где **все
пять проблем P1–P5 нужны одновременно**, и где обычный agent-фреймворк
(LangGraph/MAF) не проходит регуляторный барьер:

- **P3 (multi-agent)** — пациент/клиницист/ассистент/реестр в одном потоке.
- **P4 (contract execution)** — клинический протокол как **исполняемый
  контракт между сторонами** («executable RFC» для медицины) без
  trust-overhead блокчейна.
- **P5 (verification)** — formal safety guarantees, которые регулятор может
  принять как доказательство.
- **P1/P2** — мультисайтовый кластер и распределённый workflow между ролями.

Кейс **пространства обмена данными (§7)** усиливает именно **P4**: там
протокол — это исполняемое **соглашение об обмене между разными
компаниями**, а консент + privacy-гейт делают P4 + P5 (verification
инвариантов I1–I4) обязательными, а не опциональными.

Это и есть та «узкая вертикаль, где protocol-first + verification —
необходимость, а не nice-to-have», которую искали в открытых вопросах
[`competitors.md`](../competitors.md) §13.

---

## 10. Риски и честные ограничения

1. **LLM-недетерминизм остаётся регуляторным объектом.** Reagent верифицирует
   *оркестрацию*, но не саму модель внутри зоны. Для high-risk решений LLM —
   только ассистент, финальное действие — за человеком (как в 4.2, 5.1).
2. **Граница «платформа/протокол» требует регуляторного признания.** Без
   pre-submission диалога с FDA/EMA модульная сертификация — гипотеза.
3. **Зоны — это код.** Чтобы «протокол = конфигурация» держалось, нужно
   ограничить/санд­боксировать выразительность зон.
4. **Клинические данные = PHI/PII.** Нужны шифрование, контроль доступа,
   data residency — слой, которого в текущем PoC нет.
5. **Maturity.** Сегодня Reagent — PoC TS RC. Клинический прод требует
   высокого уровня надёжности (durable execution на уровне шагов, см.
   [`competitors.md`](../competitors.md) §12).
6. **Авто-UI пока roadmap.** Генерация UI из протокола (§1.1) — направление, а
   не реализованная фича; требует UI-аннотаций в `message`-схемах. До этого
   формы для человека верстаются под протокол вручную (и валидируются
   отдельно).
7. **Анонимизация — не свойство протокола.** В кейсе §7 Reagent гарантирует
   *маршрут* через privacy-гейт и минимизацию scope, но достаточность
   обезличивания (риск ре-идентификации) — отдельный статистический анализ;
   privacy-примитивы должны быть сертифицированной частью платформы (§7.4).
8. **Multi-org доверие.** Пространству обмена нужен либо нейтральный оператор
   консент-реестра, либо распределённый журнал согласий (§7.4).

---

## 11. Открытые вопросы для startupcamp

1. **Первая вертикаль:** КИ (sponsor/CRO платят за скорость и compliance) или
   психотерапия (measurement-based care + safety)? У КИ выше willingness to
   pay, у психотерапии — проще пилот.
2. **Сертификационный путь:** идти за SaMD-классификацией сразу, или сначала
   как «инструмент для исследований» (research use only) для накопления
   кейсов?
3. **Кто первый покупатель:** академический медцентр, CRO, цифровая
   терапевтическая компания (DTx), фарма-PV-отдел?
3a. **Авто-UI как часть оффера?** Делать ли «протокол → готовое приложение»
   ключевым сообщением (это сильно усиливает сертификационную историю и
   снижает per-protocol cost), или сначала довести RC-ядро и подключать UI
   вручную?
4. **Reference-протокол:** какой один протокол довести до демо-готовности?
   Кандидат — **5.1 (measurement-based therapy session с safety-эскалацией)**:
   самодостаточен, ярко показывает verification + safety boundary, не требует
   мультисайтового кластера.
5. **Партнёрство по регуляторике:** нужен QA/RA-эксперт в команду/эдвайзеры
   до того, как заявлять модульную сертификацию инвесторам.
6. **Data space как отдельный заход?** Кейс §7 (обмен данными между
   компаниями с консентом и privacy-гейтами) шире медицины и попадает в
   тренд EHDS/Gaia-X. Делать ли его параллельной вертикалью (data
   intermediary / health-data exchange), или держать как частный случай
   внутри клинической платформы?

---

## Связанные документы

- [`protocols_narrative.md`](protocols_narrative.md) — исходный набросок ролей.
- [`../competitors.md`](../competitors.md) — конкурентный анализ (P1–P5).
- [`../../deep-dive/takes.md`](../../deep-dive/takes.md) — продуктовые тезисы Reagent.
- [`../../../current/02-lang-spec.md`](../../../current/02-lang-spec.md) — синтаксис `.rg` (триггеры, роли, scatter, alt, wait).
- [`../../../current/09-e2e-usecases.md`](../../../current/09-e2e-usecases.md) — образцы оформления e2e-кейсов.
