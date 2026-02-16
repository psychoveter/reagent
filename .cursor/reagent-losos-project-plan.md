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

## M0 — Baseline: reproducible Losos test harness on etcd 3.6 (DONE)

**Intent**: freeze a working, reproducible environment for Losos so future changes have a stable safety net.

### Tasks
- Keep docker-compose harness for etcd `v3.6.0` + Gradle test runner.
- Ensure etcd endpoints are configurable for tests.
- Ensure secure-cluster test is skipped by default.
- Ensure test logs are persisted to `projects/losos/tmp/`.

### DoD (functional tests)
- **F0.1**: `docker compose up --abort-on-container-exit --exit-code-from tests` exits with code `0`.
- **F0.2**: `projects/losos/tmp/process-test.log` exists after the run and contains:
  - at least one `PASSED` line,
  - at least one Losos test log line (e.g. `io.losos.process.LososPlatformTest`).

---

## M1 — Reagent spec hardening: formal core model + TraceEvent algebra + legality (SPEC)

**Intent**: define what “engine must do” independently of Losos. This is the contract enabling multiple engines.

### Tasks
- Define **core entities** (ProtocolSpec, Role, ProtocolInstance, ParticipantId).
- Define **message type system** (schema ref, versioning rules, compatibility).
- Define unified **TraceEvent algebra**:
  - protocol lifecycle,
  - message send/receive,
  - actions start/finish,
  - guards open/satisfy/timeout,
  - timer events,
  - violation events.
- Define **operational semantics** at the boundary:
  - what transitions are legal from a given IR state,
  - what constitutes a **ProtocolViolation**.
- Define **time + failure model** (timeouts, retries, cancellation, at-least-once vs exactly-once claims).
- Define **idempotency keys** for message and action events.

### DoD (functional tests)
- **F1.1 (spec conformance tests)**: a small suite of “protocol snippets” (fixtures) + expected trace properties:
  - For each fixture, there is an expected set of legal next steps (by role) and expected TraceEvent sequence shape.
- **F1.2**: a “violation fixture” where an out-of-order `MessageReceived` yields `ProtocolViolated(ruleId=...)` in the expected trace.
- **F1.3**: a “timeout fixture” where no message arrives and a `TimerFired` → `GuardTimedOut` (or equivalent) is produced.

Notes:
- This milestone outputs spec text + fixtures; engines implement later milestones.

---

## M2 — Reagent Agent IR v0: engine-neutral executable model (COMPILER OUTPUT)

**Intent**: make the agent-level layer concrete: `.rgxa` (or internal IR) becomes the stable input to engines.

### Tasks
- Define IR schema (JSON/proto) for:
  - roles and bindings,
  - states/nodes,
  - edges/transitions labeled by event types,
  - actions (callable blocks) and parameters,
  - guards (predicates over events/slots),
  - timers/timeouts,
  - correlation/cause links.
- Define compilation mapping from protocol-level constructs (`alt/loop/par`) to IR:
  - token model for parallelism (or explicit concurrent branches),
  - join semantics,
  - XOR commit semantics for `alt`.
- Add an **IR validator** (static checks):
  - well-formed graph,
  - no dangling references,
  - deterministic constraints where required.

### DoD (functional tests)
- **F2.1**: compile a “hello protocol” to IR; IR validates; IR can be rendered as a simple graph (snapshot test).
- **F2.2**: compile `alt` protocol; IR expresses branch guards; IR validator accepts it.
- **F2.3**: compile `par` protocol; IR produces two concurrent tokens/branches; join is explicit; validator accepts it.
- **F2.4**: invalid protocol fixture produces a compiler error with stable error code + location.

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
- Provide **reference “in-memory engine”** (simulator) for deterministic tests.

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
- Provide “Losos Engine Service” wrapper (local process) that implements Engine API (from M3).

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
- **F5.1**: IR fixture “wait for (A AND B)” only fires after both events; trace shows both receipts then guard satisfied.
- **F5.2**: IR fixture “wait for (A OR B)” fires after first; second event later does not re-fire; trace shows closure semantics.
- **F5.3**: IR fixture “ALT (XOR)” commits exactly one branch; competing branch arrival after commit yields either ignored-with-trace or violation (as specified).
- **F5.4**: timeout fixture: if event not received within T, timer fires and correct branch/violation is produced.

---

## M6 — Role boundary + typed messages: schema, versioning, harness (RUNTIME SAFETY)

**Intent**: stop “protocol becomes chat” by making message contracts explicit and testable.

### Tasks
- Pick schema system for v0:
  - JSON Schema (engine-neutral) or Protobuf (stronger, also fits gRPC).
- Add schema registry concept (per protocol artifact):
  - msgType → schemaRef + version.
- Implement validation hooks:
  - `MessageSent` validated before emission,
  - `MessageReceived` validated before being accepted.
- Add version/compat policy:
  - explicit in spec and enforced at runtime (or explicit “no negotiation” rule).
- Generate:
  - role stubs,
  - protocol test harness that can simulate peer roles.

### DoD (functional tests)
- **F6.1**: sending invalid payload (schema mismatch) fails locally and produces a trace violation.
- **F6.2**: receiving invalid payload produces `ProtocolViolated(schema=...)`.
- **F6.3**: version mismatch fixture is rejected per compat policy.
- **F6.4**: generated harness can run protocol “sandbox” without LLM and detect:
  - deadlock,
  - timeout,
  - illegal branch.

---

## M7 — Multi-language execution: Python-first runtime uses Engine API (NON-KOTLIN PATH)

**Intent**: Reagent’s primary target (Python) can run agent-level state machines by talking to an engine (Losos or others).

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

**Intent**: make “legality + divergence” a first-class debugging product: traces are queryable, comparable, actionable.

### Tasks
- Standardize TraceEvent → OpenTelemetry mapping:
  - trace/span ids, attributes, links.
- Implement trace validator:
  - given ProtocolSpec/IR and a trace, produce:
    - violations,
    - first divergence point,
    - minimal counterexample.
- Add queries:
  - “show enabled steps at time t”,
  - “why did we block”.

### DoD (functional tests)
- **F8.1**: known bad trace fixture yields deterministic divergence report.
- **F8.2**: OTel exporter produces spans with required attributes (snapshot test).
- **F8.3**: “blocked protocol” fixture yields actionable explanation (missing event, which role, which message type).

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
- **F9.2**: per-tenant access: cannot read other tenant’s trace/state.
- **F9.3**: load test: N instances, bounded memory, bounded latency for trace streaming.

