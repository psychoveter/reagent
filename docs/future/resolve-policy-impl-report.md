# Resolve Policy — Implementation Report

Date: 2026-03-13  
Source RFC: `resolve-policy.md`

---

## 1. Implementation status

### 1.1 Phase A — Language (parser, AST, IR)

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| Participant modifiers `static`/`dynamic`/`single`/`many`/`initiator` | Done | `parser.ts:388–435`, `ast.ts:86–97` | All five parsed in any order |
| `initiator:` directive removed | Done | No parse path exists | Treated as unknown body element |
| `resolve` declarations in trigger blocks | Done | `parser.ts:1326–1403` | Parses role + pipeline |
| Pipeline pipe operator `\|` | Done | `parser.ts:1405–1421` | |
| All 11 pipeline steps | Done | `parser.ts:1423–1568` | `all`, `single`, `from`, `filter`, `roundRobin`, `leastLoaded`, `random`, `sample`, `first`, `fallback`, `custom` |
| Shorthand desugaring | Done | `parser.ts:1518–1566` | `hasTag` → `filter("x" in agent.tags)`, `hasCapability`, `hasLabel`, `isAlive` |
| `ParticipantIR` with `binding`/`cardinality`/`initiator` | Done | `ir.ts:42–48`, `ir-emitter.ts:86–92` | Defaults applied: `static`, `single`, `false` |
| `resolveMap` in `TriggerIR` | Done | `ir-emitter.ts:113–139` | Record<role, ResolvePolicyIR> |
| Validation: initiator must be static single | Done | `ir-emitter.ts:98–111` | Compile error otherwise |
| Validation: static participant must have resolve | Done | `ir-emitter.ts:146–157` | |
| Validation: dynamic participant must NOT have resolve | Done | `ir-emitter.ts:146–157` | |
| Validation: direct send to `many` participant is error | Done | `ir-emitter.ts` (send validation) | Must use `scatter` |
| Validation: scatter target must be `many` | Done | `ir-emitter.ts` (scatter validation) | |
| `SpawnStmt` with `as`, `persistent`, `-> $ctx.ref` | Done | Parser + `ir.ts:IRSpawnData` | |

### 1.2 Phase B — Agent registration & metadata

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| `AgentRecord` with `tags`, `capabilities`, `labels`, `metadata` | Done | `contracts/types.ts:229–240` | |
| Agent metadata in `.rg` (`agent X runs R { tags: [...] }`) | Done | Parser `pAgentDef`, `ir-emitter.ts:emitAgentRegistrationIR` | |
| `StateStoreAgentRegistry` | Done | `cluster/state-store-agent-registry.ts` | CRUD, watch, findByRole, findByTag, etc. |
| `rc.registerAgent()` with metadata | Done | `reagent-controller.ts:createAgentRecord` | Populates tags/capabilities/labels from extras |

### 1.3 Phase C — ResolvePolicyEvaluator

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| `ResolvePolicyEvaluator` class | Done | `triggers/resolve-policy-evaluator.ts` | |
| Wired into RC | Done | `reagent-controller.ts:143` | |
| Wired into TriggerMatcher | Done | `trigger-matcher.ts:283–297` | evaluates `resolveMap` at fire time |
| `all` step | Done | Returns all agents for role | |
| `single` step | Done | Returns first agent | |
| `from($ctx.input.*)` | Done | Resolves scalar or array from context | `resolve-policy-evaluator.ts:164–180` |
| `filter(predicate)` | Done | Full expression evaluator | Supports `==`, `!=`, `>`, `<`, `>=`, `<=`, `in`, `&&`, `\|\|`, `!`, parens, `agent.*` access |
| `roundRobin` | Done | Stateful per-role cursor | `resolve-policy-evaluator.ts:135–141` |
| `random` | Done | Uniform random pick | |
| `sample(N)` | Done | Random sample of N | |
| `first` | Done | First from set | |
| `fallback(chain)` | Done | Falls back when primary yields empty | |
| `custom("name")` | Done | `registerCustomPolicy` + evaluation | |
| `reagent.resolve()` in zones | **Not functional** | `zone-executor.ts:34–36`, `agent-interface.ts:58` | Sentinel `ResolveRequest` thrown but never caught; managed behavior returns `[]` |
| `reagent.registry` in zones | **Stub only** | `zone-executor.ts:37–41`, `agent-interface.ts:59–63` | All methods return empty values; not wired to real registry |

### 1.4 Phase D — Stateful & custom policies

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| `roundRobin` with per-trigger cursor | Done | `resolve-policy-evaluator.ts:135–141` | Cursor resets implicitly when candidate set changes |
| `leastLoaded` | **Stub** | `resolve-policy-evaluator.ts:143–145` | Returns `candidates[0]`; comment: "needs instance tracking" |
| `custom()` registration + evaluation | Done | `resolve-policy-evaluator.ts:51–53, 156–161` | `rc.registerResolvePolicy()` exposed |

### 1.5 Phase E — Spawn lifecycle

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| `persistent` flag parsed + IR | Done | Parser, `ir.ts:IRSpawnData` | |
| `persistent` flag plumbed through RC spawn | Done | `reagent-controller.ts:spawnRoleInstance` | |
| Non-persistent spawn tracking | Done | `reagent-controller.ts:spawnedAgents` map | Keyed by instanceId |
| `cleanupSpawnedAgents(instanceId)` | **Defined but not wired** | `reagent-controller.ts:1099–1106` | Method exists; never called on protocol completion |

---

## 2. Test coverage

### 2.1 Parser / IR tests (`lang/test/surface/ir-surface.test.ts`)

| Test | What it covers |
|------|----------------|
| "parses static single initiator" | All 5 modifiers in one declaration, `dynamic many` |
| "defaults binding=static, cardinality=single" | Bare participant + `initiator` modifier |
| "initiator: directive is no longer parsed" | Old syntax rejected |
| "parses simple resolve: all \| first" | Basic pipeline, pipe operator |
| "parses filter() with predicate" | `filter("ml" in agent.tags)` raw text capture |
| "parses from() with expression" | `from($ctx.input.agentName)` |
| "parses roundRobin, random, sample..." | `roundRobin`, `sample(3)` steps |
| "parses shorthands (hasTag, hasCapability)" | `hasTag("gpu")` desugars to filter |
| "emits ParticipantIR with correct defaults" | `binding`, `cardinality`, `initiator` in IR |
| "emits resolveMap in TriggerIR" | resolveMap structure with 3-step pipeline |
| "emits spawn IR with roleName" | SpawnNode IR: roleName, config, bindAs, persistent |
| "requires exactly one initiator" | No-initiator error |
| "errors on multiple initiators" | Multi-initiator error |
| "errors when static participant missing resolve" | Static without resolve → error |
| "errors when dynamic participant has resolve" | Dynamic with resolve → error |
| "errors on direct send to many participant" | Send to `many` without scatter → error |
| "errors when scatter target is not many" | Scatter on `single` → error |
| "allows scatter when target is many" | Valid scatter-many compiles |

**Parser gaps:**
- `hasCapability` shorthand: test title mentions it but only `hasTag` is actually tested
- `hasLabel`, `isAlive` shorthands: not tested
- `leastLoaded`, `fallback(...)`, `custom("name")` parsing: not tested (only `roundRobin` and `sample`)
- Agent metadata parsing: tested in separate "agent metadata body" group (with/without body, IR emission)

### 2.2 Runtime evaluator tests (`runtime/ts/test/cluster/state-resolve.test.ts`)

| Test | What it covers |
|------|----------------|
| "all returns all agents for role" | `all` step |
| "single returns first" | `single` step |
| "all \| first returns one" | Chained pipeline |
| "filter by tag" | `"eu" in agent.tags` |
| "filter by label" | `agent.labels.tier == "premium"` |
| "filter by metadata comparison" | `agent.metadata.score > 0.5` |
| "filter compound (&&)" | `"eu" in agent.tags && agent.metadata.score > 0.5` |
| "roundRobin cycles through candidates" | 3 sequential calls rotate b1→b2→b3 |
| "sample returns N items" | `sample(2)` returns 2 |
| "fallback when primary yields empty" | Empty filter → fallback chain |
| "custom policy integration" | `registerCustomPolicy("topScorer", ...)` |
| "from($ctx.input.agentName)" | Resolves specific agent from context |

**Evaluator gaps:**
- `random` step: not tested in TS (only Python parity test)
- `leastLoaded` step: not tested (stub implementation)
- `filter` with `||`, `!`, parentheses, `in agent.capabilities`: not tested
- `from()` with array input: not tested (only scalar)
- Empty pipeline / no candidates: not tested
- Error cases (unknown step, invalid predicate): not tested

### 2.3 E2E / integration tests

| Test file | Resolve-relevant coverage |
|-----------|--------------------------|
| `runtime/ts/test/contracts/lang-spec-coverage.test.ts` C23 | Send to `many` → runtime error "resolved to many agents" |
| `runtime/ts/test/controller/protocol-run-lifecycle.test.ts` L4 | `spawnRoleInstance` from deployed template |
| `runtime/ts/test/controller/protocol-run-lifecycle.test.ts` L6 | Protocol-level spawn with `bindAs` + message exchange |
| `runtime/ts/test/stories/risk-review-approval.test.ts` | Persistent spawn survives protocol |
| `runtime/ts/test/stories/runtime-semantics-nats.test.ts` T15/T16 | `reagent.spawn()` runtime, emit lifecycle |

**E2E gaps:**
- **No E2E test for any non-trivial resolve pipeline.** All E2E protocols use `resolve X = single`.
- No test exercises `all | filter(...) | roundRobin` through a real protocol run.
- No test for `from($ctx.input.*)` in a real invoke trigger.
- Non-persistent spawn cleanup on protocol completion: not tested.
- `reagent.resolve()` in zone: not tested (not functional).
- Cross-node resolve: not tested.

### 2.4 Example `.rg` files

All 34 example `.rg` files use only `resolve X = single`. No example demonstrates advanced pipeline steps (`all | filter | roundRobin`, `from(...)`, `sample`, `custom`, `fallback`).

---

## 3. Gap analysis

### G1 (High) — `reagent.resolve()` in zones is non-functional

**RFC reference:** §4.2, §10.3  
**Current state:** `createReagentStub()` throws `ResolveRequest` sentinel but `ManagedAgentBehavior` does not catch it → runtime error. The managed behavior's own stub returns `[]`.  
**What's needed:**
- Intercept `ResolveRequest` in `ManagedAgentBehavior.handle()` or in `RoleRun`
- Route through shell → RC → `ResolvePolicyEvaluator`
- Return resolved `AgentRef[]` to the zone
- Tests: zone calls `reagent.resolve("worker", pipeline)` and gets real results

### G2 (High) — `reagent.registry` in zones is stub-only

**RFC reference:** §5.4, §10.3  
**Current state:** Type defined; all methods (`findByRole`, `get`, `all`) return empty values.  
**What's needed:**
- Wire real `StateStoreAgentRegistry` into zone executor via shell callback
- Tests: zone queries `reagent.registry.findByRole("Worker")` and gets real agents

### G3 (Medium) — Protocol-scoped spawn cleanup not wired

**RFC reference:** §7.3  
**Current state:** `cleanupSpawnedAgents(instanceId)` exists in RC but is never called.  
**What's needed:**
- Call `cleanupSpawnedAgents(instanceId)` from `AgentShellImpl.handleRunComplete()` or via a lifecycle hook on protocol completion
- Tests: non-persistent spawned agent is destroyed when parent protocol completes

### G4 (Medium) — `leastLoaded` is a stub

**RFC reference:** §6.3  
**Current state:** Returns `candidates[0]`; functionally identical to `first`.  
**What's needed:**
- Track active protocol instances per-agent in RC (increment on start, decrement on complete/fail)
- `leastLoaded` step queries this count and picks the agent with fewest active instances
- Tests: 3 agents with different load → `leastLoaded` picks the least loaded

### G5 (Low) — No E2E test for non-trivial resolve pipeline

**RFC reference:** §4.7 (full examples)  
**Current state:** All E2E tests and all 34 examples use `resolve X = single`.  
**What's needed:**
- At least one E2E test that uses `all | filter(...) | roundRobin` in a real protocol with multiple agents
- At least one E2E test that uses `from($ctx.input.agentId)` in an invoke trigger
- Example `.rg` file demonstrating advanced resolve (e.g. auction with filtered buyers)

### G6 (Low) — Parser shorthand and edge-case test gaps

**RFC reference:** §4.5  
**Current state:** Only `hasTag` shorthand is tested. `hasCapability`, `hasLabel`, `isAlive` are parsed but untested. Filter expressions with `||`, `!`, nested parens, `in agent.capabilities` are evaluated but untested.  
**What's needed:**
- Parser tests for `hasCapability("x")`, `hasLabel("k", "v")`, `isAlive`
- Evaluator tests for `||`, `!`, parenthesized sub-expressions, `in agent.capabilities`
- Evaluator test for `from()` with array input (`$ctx.input.buyerIds`)

### G7 (Low) — Cross-node resolve untested

**RFC reference:** §13.1  
**Current state:** Evaluator always works against local in-memory registry. Etcd-backed registry exists but no test verifies distributed resolve or trigger dedup.  
**What's needed:**
- Integration test with 2+ RCs and etcd-backed `StateStore`
- Verify resolve pipeline produces consistent results across nodes
- Verify trigger CAS dedup

---

## 4. Summary by RFC phase

| Phase | Description | Status |
|-------|-------------|--------|
| **A** | Parser: modifiers, resolve, initiator removed, IR | **Complete** |
| **B** | AgentRegistration with metadata | **Complete** |
| **C** | ResolvePolicyEvaluator in RC + TriggerMatcher | **Complete for trigger-level resolve** |
| **C** | Zone-level `reagent.resolve()` + `reagent.registry` | **Not functional** (G1, G2) |
| **D** | `roundRobin` | **Complete** |
| **D** | `leastLoaded` | **Stub** (G4) |
| **D** | `custom()` policies | **Complete** |
| **E** | `persistent` flag | **Complete** (plumbed through) |
| **E** | Protocol-scoped spawn cleanup | **Not wired** (G3) |
