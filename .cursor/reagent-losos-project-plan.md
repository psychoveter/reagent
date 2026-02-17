## Reagent ↔ Losos: project plan (milestones)

Goal: make **Losos** one of the **Reagent Agent Runtime engines** (etcd-backed, Kotlin implementation) while keeping Reagent **engine-neutral** and enabling **multiple engines** and **multiple target languages** (Python-first for Reagent MVP).

This plan is written as a sequence of milestones. For each milestone:
- **Tasks**: ordered work items.
- **DoD**: crisp acceptance criteria expressible as functional tests (black-box where possible).

Glossary (minimal):
- **Protocol artifact**: the user-authored Reagent file (protocol + optional code blocks).
- **IR (Agent-level)**: compiled, engine-neutral representation of per-role executable state machine.
- **Engine**: runtime backend that executes IR and emits an append-only trace.
- **TraceEvent**: engine-emitted event in a unified algebra (used for legality checks and debugging).

---

## M0 — Baseline: reproducible Losos test harness on etcd 3.6 ✅ DONE

**Intent**: freeze a working, reproducible environment for Losos so future changes have a stable safety net.

### Tasks
- Keep docker-compose harness for etcd `v3.6.0` + Gradle test runner.
- Ensure etcd endpoints are configurable for tests.
- Ensure secure-cluster test is skipped by default.
- Ensure test logs are persisted to `projects/losos/tmp/`.

### DoD (functional tests)
- **F0.1**: `docker compose up --abort-on-container-exit --exit-code-from tests` exits with code `0`.
- **F0.2**: `projects/losos/tmp/process-test.log` exists after the run and contains:
  - all tests are `PASSED`,
  - at least one Losos test log line (e.g. `io.losos.process.LososPlatformTest`).

---

## M1 — Reagent language & spec hardening ✅ DONE (language v0.0.4)

**Intent**: define the Reagent DSL surface from examples-first, formalize the core model and TraceEvent algebra.

**Status**: Language surface is stable at v0.0.4. Examples corpus covers all major constructs. Lang-spec has informal syntax + EBNF. Core spec (`reagent-spec.md`) has TraceEvent algebra and legality model.

### Completed
- ✅ **Examples corpus** (`projects/reagent/examples/`): 13 fixtures covering protocol wrapper, message steps, alt, loop, par, wait/timeout, spawn, invoke, try/catch, imports, external events, LLM broker.
- ✅ **Language spec** (`lang-spec.md` v0.0.4): informal syntax + EBNF. Key decisions: meta-language, `$ctx`, `reagent.*` runtime library, hook zones, language tags on participants.
- ✅ **Core spec** (`reagent-spec.md` v0.0.1): TraceEvent algebra, legality LTS, time/failure model, idempotency keys.
- ✅ **Syntax highlighting** (`reagent-vscode` v0.1.0): TextMate grammar + embedded language support.

### Remaining (deferred to later milestones)
- Spec conformance test suite (F1.1, F1.2, F1.3) — will be built when parser+IR exist.
- Formal violation/timeout fixtures — need IR execution to validate.

---

## M2 — TypeScript AST + Parser + IR design 🔜 NEXT

**Intent**: build the proper parsing infrastructure and design the agent-level IR. This is the bridge between "language on paper" and "compilable protocol".

### Phase 2a — TypeScript AST (typed node hierarchy)

**Tasks**:
1. Define AST node types in TypeScript covering the full language surface:
   - `Program` (top-level: imports + protocol definitions)
   - `ImportStmt` (protocol `.rg` imports + code module imports)
   - `ProtocolDef` (header: participants, initiator, input + body)
   - `ParticipantDecl` (name + language tag)
   - `MessageStmt` (sender, arrow, receiver, message name, optional props)
   - `MessageProps` (hook zones + key-value pairs)
   - `HookZone` (`onSend` / `onReceive` with raw body text)
   - `AgentZone` (standalone: role name + raw body text + resolved language)
   - `AltStmt` (branches: message-guard / expression-guard / timeout-guard + body)
   - `LoopStmt` (guard expression + body)
   - `ParStmt` (branches separated by `and`)
   - `WaitStmt` (duration literal)
   - `TryStmt` (try body + catch label + catch body)
   - `Comment` (line + block)
2. Every node carries `SourceLocation` (`start: {line, col, offset}`, `end: {line, col, offset}`).
3. Define AST in `projects/reagent/lang/ast.ts` (replace or supersede `lang/ast.schema.json` if it exists).
4. Export AST types as a standalone module (no runtime deps).

**DoD**:
- **F2a.1**: AST types compile. Each example `.rg` file has a corresponding expected AST shape (snapshot fixtures).
- **F2a.2**: AST covers all constructs used in examples `00`–`11`.

### Phase 2b — Recursive-descent parser

**Tasks**:
1. Implement a **recursive-descent parser** in TypeScript: `string → AST`.
   - Path: `projects/reagent/lang/parser.ts`.
   - Hand-written (not generated) for full control over error recovery and source locations.
   - Must handle: imports, protocol header, message steps (with optional props and hooks), agent zones (brace-balanced raw text), all control-flow constructs (`alt`, `loop`, `par`, `wait`, `try/catch`), comments.
   - Zone bodies remain **raw text** (parser only balances braces, does not parse host language).
2. Error reporting: each parser error carries `SourceLocation` + error code + human message.
3. Roundtrip property: `parse(source).errors.length === 0` for all example files.
4. Migrate `reagent-vscode` extension to use the new parser (replace regex-based `reagentParser.ts`).

**DoD**:
- **F2b.1**: All 13 example files parse without errors.
- **F2b.2**: Parser produces AST matching snapshot fixtures from F2a.1.
- **F2b.3**: Invalid input produces error with location and stable error code.
- **F2b.4**: VSCode extension uses new parser for zone extraction.

### Phase 2c — Agent IR v0 (per-role state machine model)

**Tasks**:
1. Define IR schema in TypeScript:
   - **IRGraph**: per-role directed graph of states and transitions.
   - **IRState**: node (types: `initial`, `send`, `receive`, `action`, `guard`, `join`, `final`, `error`).
   - **IRTransition**: labeled edge (event type + guard predicate + actions).
   - **IRAction**: callable block reference (zone body + language).
   - **IRGuard**: predicate over `$ctx` / incoming message / timer.
   - **IRTimer**: timeout configuration.
2. Define compilation mapping from AST constructs to IR:
   - `MessageStmt` → `send` state (for sender) + `receive` state (for receiver) + transitions.
   - `AgentZone` → `action` state with zone body.
   - `AltStmt` → branching with XOR guard semantics.
   - `LoopStmt` → back-edge to guard state.
   - `ParStmt` → fork into concurrent tokens + join state.
   - `TryStmt` → normal path + error path with compensation.
   - `WaitStmt` → timer state.
3. Implement **IR emitter**: `AST → Map<RoleName, IRGraph>`.
   - Path: `projects/reagent/lang/ir-emitter.ts`.
   - One IRGraph per role = the **local view** of the global protocol.
4. Implement **IR validator** (static checks): well-formed graph, no dangling refs, determinism where required.

**DoD**:
- **F2c.1**: Compile "hello protocol" (example `00`) → IR for each role; IR validates; snapshot test.
- **F2c.2**: Compile `alt` protocol (example `02`) → IR with branch guards; validator accepts.
- **F2c.3**: Compile `par` protocol (example `04`) → IR with concurrent branches + join; validator accepts.
- **F2c.4**: Invalid protocol fixture → compiler error with stable error code + location.

### Phase 2d — Translation design: Reagent IR → Losos primitives

**Tasks**:
1. Document the mapping from IR concepts to Losos runtime primitives:
   - `IRState(receive)` → Losos **Guard** (await event on etcd key).
   - `IRState(send)` → Losos **Action** (write message to etcd key).
   - `IRState(action)` → Losos **Action** (invoke zone code).
   - `IRGuard` → Losos guard predicate registration.
   - `IRTimer` → Losos timer/TTL.
   - `IRTransition` → Losos process state transition.
   - `par` fork/join → Losos concurrent guard set + join action.
   - `alt` XOR → Losos alternative guards (first-to-fire).
   - `try/catch` → Losos error guard + compensation action.
2. Identify **gaps** in current Losos that block faithful IR execution (input for M5).
3. Write a design doc: `projects/reagent/docs/ir-to-losos-mapping.md`.

**DoD**:
- **F2d.1**: Design doc exists and covers all IR node types → Losos mapping.
- **F2d.2**: Gap list identifies at least: multi-slot guards, timer support, XOR resolution.

---

## M3 — Engine API v0: language-neutral runtime contract (MULTI-ENGINE ENABLER)

**Intent**: a stable interface so engines can be swapped and non-Kotlin languages can integrate.

### Tasks
- Specify an **Engine API** (suggested: gRPC + protobuf; alternative: HTTP+JSON):
  - `StartInstance(IR, bindings) -> instanceId`
  - `SubmitExternalEvent(instanceId, event)` (message arrivals, custom events)
  - `Poll(instanceId)` / `StreamTrace(instanceId)` for trace consumption
  - `GetNextEnabledSteps(instanceId, role)` (optional but powerful for debugging/UI)
  - `ExecuteAction(instanceId, actionId, input, idempotencyKey)`
  - `Cancel(instanceId, reason)`
  - `Snapshot(instanceId)` / `Restore(snapshot)`
- Define engine obligations:
  - trace is **append-only** and **durable**,
  - at-least-once action execution semantics + idempotency keys,
  - ordering model (per-instance total order trace is recommended).
- Provide **reference "in-memory engine"** (simulator) for deterministic tests.

### DoD (functional tests)
- **F3.1**: start instance, submit message events, observe trace stream containing expected `MessageReceived` events.
- **F3.2**: execute the same action twice with same idempotency key → second call is deduped; trace shows one logical completion.
- **F3.3**: crash/restart the reference engine process → instance restored; trace continues without losing prior events.
- **F3.4**: `GetNextEnabledSteps` matches expected set for a known IR fixture.

---

## M4 — Losos Engine Adapter v0: execute Reagent IR on Losos (KOTLIN ENGINE)

**Intent**: map Reagent IR semantics to Losos primitives (Guard–Action network + etcd keyspace).

### Tasks
- Define Losos ↔ Reagent mapping:
  - IR state → Losos process state + guard registrations,
  - TraceEvent → etcd append-only trace keys (per instance),
  - external message arrival → Losos event write,
  - action execution → Losos action invocation records + completion writes.
- Implement trace persistence as first-class:
  - per-instance `trace/` prefix with monotonic sequence numbers or etcd revisions,
  - include correlation ids.
- Implement legality checking surface:
  - on each external event, either advance legally or emit `ProtocolViolated`.
- Provide "Losos Engine Service" wrapper (local process) that implements Engine API (from M3).

### DoD (functional tests)
- **F4.1**: run Engine API conformance suite against Losos engine (the same tests as F3.1–F3.4).
- **F4.2**: restart Losos engine service (and/or the node) mid-instance:
  - instance resumes,
  - trace remains append-only and consistent.
- **F4.3**: inject out-of-order message → trace contains `ProtocolViolated` with evidence referencing msgId/correlationId.
- **F4.4**: two concurrent `par` branches both complete → join transition fires exactly once (no double-commit).

---

## M5 — Guards 2.0 in Losos: multi-slot, OR/AND/XOR, timeouts (SEMANTICS GAP CLOSURE)

**Intent**: remove current Losos limitations that block faithful compilation of Reagent protocols.

### Tasks
- Extend guard model:
  - allow guards to depend on **multiple slots/events**,
  - implement explicit boolean structure (AND/OR/XOR) in runtime semantics.
- Add first-class timers:
  - schedule timer,
  - produce `TimerFired` events,
  - support guard timeouts leading to alternative branches / violations.
- Define deterministic resolution rules for XOR:
  - when one branch commits, how others are cancelled/closed,
  - what is recorded in trace.

### DoD (functional tests)
- **F5.1**: IR fixture "wait for (A AND B)" only fires after both events; trace shows both receipts then guard satisfied.
- **F5.2**: IR fixture "wait for (A OR B)" fires after first; second event later does not re-fire; trace shows closure semantics.
- **F5.3**: IR fixture "ALT (XOR)" commits exactly one branch; competing branch arrival after commit yields either ignored-with-trace or violation (as specified).
- **F5.4**: timeout fixture: if event not received within T, timer fires and correct branch/violation is produced.

---

## M6 — Role boundary + typed messages: schema, versioning, harness (RUNTIME SAFETY)

**Intent**: stop "protocol becomes chat" by making message contracts explicit and testable.

### Tasks
- Pick schema system for v0:
  - JSON Schema (engine-neutral) or Protobuf (stronger, also fits gRPC).
- Add schema registry concept (per protocol artifact):
  - msgType → schemaRef + version.
- Implement validation hooks:
  - `MessageSent` validated before emission,
  - `MessageReceived` validated before being accepted.
- Add version/compat policy:
  - explicit in spec and enforced at runtime (or explicit "no negotiation" rule).
- Generate:
  - role stubs,
  - protocol test harness that can simulate peer roles.

### DoD (functional tests)
- **F6.1**: sending invalid payload (schema mismatch) fails locally and produces a trace violation.
- **F6.2**: receiving invalid payload produces `ProtocolViolated(schema=...)`.
- **F6.3**: version mismatch fixture is rejected per compat policy.
- **F6.4**: generated harness can run protocol "sandbox" without LLM and detect:
  - deadlock,
  - timeout,
  - illegal branch.

---

## M7 — Multi-language execution: Python-first runtime uses Engine API (NON-KOTLIN PATH)

**Intent**: Reagent's primary target (Python) can run agent-level state machines by talking to an engine (Losos or others).

### Tasks
- Build Python runner that:
  - loads compiled per-role artifact (or IR + bindings),
  - communicates with Engine API,
  - executes local code blocks/tools,
  - emits/receives boundary message events.
- Define tool invocation protocol (engine-neutral):
  - action request → tool call → action completion.
- Add TS/Go minimal clients (optional, after Python).

### DoD (functional tests)
- **F7.1**: run a 2-role protocol where role A is Python runner, role B is simulated:
  - A progresses, sends message, awaits reply, completes.
- **F7.2**: restart Python runner mid-instance:
  - continues from trace/state (no duplicated side-effects due to idempotency keys).
- **F7.3**: run same IR on two different engines (in-memory vs Losos):
  - traces are equivalent up to allowed nondeterminism (ordering rules specified in M1).

---

## M8 — Observability + divergence detection: OTel + spec-vs-real validator (DEBUGGING CORE)

**Intent**: make "legality + divergence" a first-class debugging product: traces are queryable, comparable, actionable.

### Tasks
- Standardize TraceEvent → OpenTelemetry mapping:
  - trace/span ids, attributes, links.
- Implement trace validator:
  - given ProtocolSpec/IR and a trace, produce:
    - violations,
    - first divergence point,
    - minimal counterexample.
- Add queries:
  - "show enabled steps at time t",
  - "why did we block".

### DoD (functional tests)
- **F8.1**: known bad trace fixture yields deterministic divergence report.
- **F8.2**: OTel exporter produces spans with required attributes (snapshot test).
- **F8.3**: "blocked protocol" fixture yields actionable explanation (missing event, which role, which message type).

---

## M9 — Production hardening (SECURITY + OPERATIONS)

**Intent**: make Losos engine service safe to run as shared infrastructure.

### Tasks
- AuthN/AuthZ for Engine API (mTLS/JWT) + per-tenant isolation.
- Quotas, backpressure, max trace size / retention policies.
- Operational tooling:
  - migrations,
  - compatibility checks,
  - upgrade playbooks.

### DoD (functional tests)
- **F9.1**: unauthorized Engine API calls are denied.
- **F9.2**: per-tenant access: cannot read other tenant's trace/state.
- **F9.3**: load test: N instances, bounded memory, bounded latency for trace streaming.
