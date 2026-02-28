# Reagent support for NMMO-style multi-agent simulations

Language and runtime requirements derived from the NMMO+LLM use case.

The NMMO-specific project (protocols, agents, runner) lives in
`montevideo/Montevideo/nmmo-reagent/`. This document tracks what Reagent
itself needs to fully support tick-based multi-agent environments.

Status: **DRAFT** | Author: Oleg Bukhvalov | Date: 2026-02-20

---

## 1. Use case summary

The target is a multi-agent LLM system in Neural MMO where Reagent orchestrates
a team of agents. This stresses several Reagent features simultaneously:

- **Tick-based synchronous execution**: all agents must produce actions every env step
- **Long-running behavioral goals**: protocols spanning many ticks
- **LLM integration**: async I/O from zone code via `$agent`
- **Scatter/gather**: fan-out observations to N agents, collect actions
- **Cross-protocol state**: `$self.currentGoal` set by behavioral protocols, read by tick protocol
- **Python-first**: NMMO is Python, agents are Python, LLM clients are Python

---

---

## 2. Reagent features exercised

The NMMO use case exercises these Reagent features simultaneously:

| Feature | How used | Status |
|---|---|---|
| `$agent` binding | Env I/O, LLM I/O | Implemented (M8b) |
| Async zones (`await`) | LLM calls, env step | Implemented (M8b) |
| `scatter` | Fan-out observations to N entities | Implemented (M5-LANG) |
| `loop (true)` | Game loop, behavioral polling | Implemented (M1-RT) |
| `wait` | Polling interval in behavioral protocols | Implemented (M1-RT) |
| `alt` expression guards | Completion/condition checks | Implemented (M-RT) |
| `invokes` | Strategic → behavioral protocol dispatch | Implemented (M5-LANG) |
| `spawns` | Fire-and-forget survival override | Implemented (M5-LANG) |
| `$self` persistence | Cross-protocol state (worldModel, currentGoal) | Implemented (M-RT) |
| `$ctx` per-branch isolation | Accumulate actions in scatter via `$ctx` | Updated (v0.0.11, $flow removed) |
| Python RC + InprocAgentNode | Zero-serialization execution | Implemented (M6-PYRC) |

---

## 3. Gap analysis — Reagent language/runtime requirements

### 3.1 Confirmed working

| Feature | Status | Used by |
|---|---|---|
| `$agent` binding | Implemented (M8b) | All protocols — LLM calls, env access |
| Async zones (`await`) | Implemented (M8b) | LLM calls, env I/O |
| `scatter` | Implemented (M5-LANG) | TickCycle — fan-out to agents |
| `loop` | Implemented (M1-RT) | TickCycle game loop, behavioral polling |
| `wait` | Implemented (M1-RT) | Behavioral protocols — polling interval |
| `alt` with expression guards | Implemented (M-RT) | Behavioral protocols — completion check |
| `invokes` | Implemented (M5-LANG) | TeamStrategy → behavioral protocols |
| `spawns` | Implemented (M5-LANG) | SurvivalOverride — fire-and-forget |
| `$self` persistence | Implemented (M-RT) | Cross-protocol state (worldModel, currentGoal) |
| `$ctx` per-branch isolation | Updated (v0.0.11) | TickCycle — accumulate via `$ctx` |
| Python RC + InprocAgentNode | Implemented (M6-PYRC) | Runtime execution environment |

### 3.2 Gaps and risks

| Gap | Severity | Description | Mitigation |
|---|---|---|---|
| **Async scatter** | Medium | `scatter` with async zones inside (agent zones containing `await`). TS runtime runs branches via `Promise.all` of `BranchRunner`; Python uses `asyncio.gather`. Both should support async zones in branches, but **untested in combination**. | Write E2E test: scatter with async zones in branches. |
| **Behavioral protocol concurrency** | Medium | Multiple behavioral protocols (`ExploreRegion` + `CollectResource`) running simultaneously for the same agent. Both write `$self.currentGoal`. Last writer wins — no conflict resolution. | Convention: one active behavioral goal per agent. TeamStrategy serializes goals. Or: add `$self.goalStack` with priority. |
| **scatter + message correlation** | Low | In TickCycle scatter, each branch sends `ActionResponse` back. The runtime must correctly correlate responses to the coordinator's inbox across N branches. This works in example 23, but not tested with async zones. | Covered by scatter E2E test. |
| **`wait` semantics in behavioral protocols** | Low | `wait 50` means 50ms in current runtime. For NMMO we need tick-based waiting, not wall-clock. | Option 1: use `wait 0ms` + explicit counter in `$self`. Option 2: add tick-based wait to runtime. Option 1 is simpler. |
| **Agent death mid-protocol** | Low | If NMMO entity dies, the Reagent agent still exists. Behavioral protocols polling `$self.goalStatus` will loop forever. | Coordinator detects dead agents from observations, sends `AgentDied` message or stops protocol. |
| **LLM latency in scatter** | Low | If agent zones call `await $agent.think()` inside scatter, the entire tick blocks on the slowest LLM call. N agents × LLM latency = slow ticks. | LLM calls only in behavioral/strategic protocols, not in TickCycle. TickCycle zones use only `$self` (sync reads). |
| **Zone helper imports** | Low | Zone code references functions like `updateWorldModel()`, `translateGoalToAction()`, `buildPrompt()`. These must be importable in the zone execution context. Python zones can import modules; TS zones cannot (no `import` in `new Function`). | Python-first for NMMO agents. Or: register helpers on `$agent` (breaks thin-$agent principle). |
| **`agent` keyword** | None | `agent` is a reserved keyword in the parser (`PROTOCOL_KEYWORDS`). Participant names cannot be `agent`. | Use `entity`, `member`, `worker`, or `survivor` as participant names. |
| **`loop` guard required** | None | Parser requires `loop (expr) { }` — bare `loop { }` is not valid. | Use `loop (true) { }` for infinite loops. |
| **`alt` branch syntax** | None | `alt` uses `(expr)` guard, not `[expr]` brackets. Multi-branch `alt` uses `} else (expr) {` pattern. | Match existing syntax from examples. |

### 3.3 Recommendations

1. **Do not call LLM in TickCycle zones.** Keep tick zones synchronous (read `$self`, write `$ctx`). LLM calls go in behavioral/strategic protocols only.
2. **One active goal per agent.** `$self.currentGoal` is a single object, not a stack. TeamStrategy serializes goal assignment.
3. **Use tick counters, not `wait` timers.** Behavioral protocols track ticks via `$self.ticksSinceGoalSet` incremented by TickCycle, not via `wait` timer.
4. **Python-first.** NMMO is Python, agents are Python, LLM clients are Python. Use Python RC with InprocAgentNode.
5. **Write scatter+async E2E test** before building the full system.

---

## 4. Patterns validated by this use case

These design patterns emerged from the NMMO work and should be documented as
canonical Reagent patterns:

1. **Coordinator-as-protocol**: an ephemeral role that owns the environment loop,
   not a domain entity. Its `$agent` wraps the environment.

2. **Thin `$agent`, fat zones**: `$agent` is a pure I/O wrapper (env, LLM).
   All decision logic, state management, and prompt assembly live in zones.

3. **Two temporal scales**: tick protocols (synchronous, per-step) coexist with
   behavioral protocols (long-running, cross-tick). Decoupled via `$self.currentGoal`.

4. **Scatter/gather for observation distribution**: use `scatter` to fan-out
   per-agent data and collect results.

5. **Goal-based action translation**: behavioral protocols set `$self.currentGoal`,
   tick-level zones read it and translate to concrete actions.

---

## 5. Reference implementation

The NMMO-specific project lives at `montevideo/Montevideo/nmmo-reagent/`:
- `reagent.json` — project manifest
- `protocols/` — all `.rg` protocol files
- `agents/` — agent definitions, native modules, agent manifests
- `docs/` — architecture and gap analysis specific to NMMO
- `run_simulation.py` — entry point

The protocols serve as a canonical example of a complete Reagent project.
