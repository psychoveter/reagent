# Reagent IR → Losos: translation mapping (design doc)

Version: v0.0.4 (matches language and IR version)
Date: 2026-02-17

## 1. Overview

This document defines how Reagent Agent IR constructs map to Losos runtime primitives. The goal is to compile a Reagent `IRGraph` (per-role state machine) into a Losos `ProcessDef` (Guard–Action Network).

### Key insight: state → guard-action pair

Reagent IR has explicit **states** and **transitions**. Losos has no first-class states — only **guards** (event waiters) and **actions** (executors that emit new guards).

The mapping: each IR state becomes a **guard** (that waits for the preceding transition condition) plus an **action** (that executes the state's logic and emits the next guard).

```
IR:     [state_A] --label--> [state_B] --label--> [state_C]
Losos:  guard_A → action_A → {emits guard_B} → action_B → {emits guard_C} → ...
```

---

## 2. Mapping: IR state kinds → Losos primitives

### 2.1 `initial` → start guard

| IR | Losos |
|----|-------|
| `IRState(initial)` | `ProcessDef.startGuard` — an OR guard with 0 slots (immediately openable) |

The start guard's action initializes the process and emits the first real guard.

### 2.2 `send` → invocation action (put to etcd)

| IR | Losos |
|----|-------|
| `IRState(send, to, messageName, preSendZone?)` | `InvocationAction(ASYNC)` that: (1) executes `preSendZone` code if present, (2) writes the message to the target role's event path |

etcd key for message delivery:
```
/proc/<node>/state/<receiverPid>/invoke/<guardId>/<slotId>
```

The payload is an `InvocationResult { data: messagePayload, status: OK }`.

### 2.3 `receive` → guard with invocation slot

| IR | Losos |
|----|-------|
| `IRState(receive, from, messageName, postReceiveZone?, pattern?)` | `GuardDef` with `InvocationSlot(guardId, slotId)` matching the expected etcd key |

The guard waits for the sender to write to the expected invocation path. When filled:
- The guard opens.
- The associated action executes `postReceiveZone` code (if present) with `$ctx.msg` bound to the slot data.
- If `pattern` is set, the slot matcher should also validate the payload fields before filling.

**Pattern matching gap**: Current `InvocationSlot` only does path matching, not payload content matching. Needs extension for `alt` message guards with value patterns (e.g., `{ code: "TRANSIENT" }`).

### 2.4 `action` → invocation action (code execution)

| IR | Losos |
|----|-------|
| `IRState(action, body, lang)` | `InvocationAction(ASYNC)` that executes the zone body in the appropriate language runtime |

For TypeScript zones: an async task that evaluates the body with `$ctx` injected.
For other languages: delegate to appropriate runtime (Python subprocess, Kotlin direct, etc.).

The action completes by writing `InvocationResult` to its result path, which fills the next guard's slot.

### 2.5 `guard` (expression) → conditional action

| IR | Losos |
|----|-------|
| `IRState(guard, "expression", expr)` | An action that evaluates `expr` against `$ctx` and emits the appropriate next guard |

This is not a Losos guard but a **conditional action**: it runs immediately and based on the expression result, registers one of several possible next guards.

### 2.6 `guard` (xor) → XOR guard relations

| IR | Losos |
|----|-------|
| `IRState(guard, "xor")` with multiple outbound transitions | Multiple `GuardDef`s linked by `GuardRelation(XOR)` |

Each outbound transition from the XOR guard becomes a separate Losos guard. When one fires, the XOR relation cancels the others.

```
IR:   xor_3 --[msg:Accept]--> recv_5
      xor_3 --[msg:Reject]--> recv_7
      xor_3 --[timeout:10s]--> timer_9

Losos: guard_accept(InvocationSlot for Accept) }
       guard_reject(InvocationSlot for Reject) } XOR relation
       guard_timeout(timeout=10000)             }
```

This maps directly to existing Losos XOR semantics.

### 2.7 `fork` → action emitting multiple guards

| IR | Losos |
|----|-------|
| `IRState(fork, branchStartIds)` | An action that emits **N** guards (one per branch) in a single `runGuards` list |

All branch guards become active simultaneously. Each branch proceeds independently.

### 2.8 `join` → AND guard with multiple slots

| IR | Losos |
|----|-------|
| `IRState(join, branchCount)` | `GuardDef(AND)` with N slots, one per branch |

Each branch's final action writes to a distinct slot of the join guard. The AND guard opens only when all slots are filled.

**Gap**: Losos `Guard.result()` currently only supports 1 slot. Multi-slot reduction is needed for join to produce a merged result.

### 2.9 `timer` → guard with timeout

| IR | Losos |
|----|-------|
| `IRState(timer, duration)` | `GuardDef(OR)` with 0 slots and `timeout = duration.toMillis()` |

An OR guard with no slots but a timeout. It immediately starts waiting, fires `timeoutAction` when the timer expires.

### 2.10 `terminal` → finish guard

| IR | Losos |
|----|-------|
| `IRState(terminal, "completed")` | `ProcessDef.finishGuard` |

The terminal action writes `InvocationResult` to the process's `resultEventPath` (for parent protocol invocation) and signals the process to halt.

### 2.11 `error` → error guard / catch handler

| IR | Losos |
|----|-------|
| `IRState(error, label)` | An action registered as the error handler for the try scope |

**Gap**: Losos has no structured try/catch. `FlowStatus.FAILED` halts the process. Compensation requires:
- An error guard that catches FAILED invocation results instead of halting.
- A compensation action chain that runs before either resuming or halting.

---

## 3. Mapping: IR transition labels → Losos guard/slot wiring

| Label | Losos wiring |
|-------|-------------|
| `default` | The preceding action emits a guard for the target state (immediate, OR guard with 0 slots or with an invocation slot from the preceding action's result path) |
| `message(name, pattern?)` | `InvocationSlot` matching the message sender's write path + optional payload predicate |
| `timeout(duration)` | Guard `timeout` field (milliseconds) |
| `expression(expr)` | Conditional logic inside the action; emits one of N possible next guards |
| `else` | Fallback branch: emitted when no other guard fires (modeled as a timeout with 0 duration or a catch-all action) |
| `error` | Error edge: wired to FAILED status handling (requires gap closure) |
| `branch(i)` | Fork: the fork action emits guards for all branches simultaneously |

---

## 4. ProcessDef generation algorithm (sketch)

```
Input: IRGraph for role R
Output: ProcessDef

1. For each IRState, create:
   - A GuardDef (what triggers this state)
   - An ActionDef (what this state does when triggered)

2. startGuard = guard for the initial state (OR, 0 slots)
3. finishGuard = guard for the terminal state

4. For each IRTransition (from, to, label):
   - Wire "from" action to emit the "to" guard
   - Configure slot/timeout on "to" guard based on label

5. For XOR guards:
   - Collect all outbound transitions from the XOR state
   - Create one guard per transition
   - Link them with GuardRelation(XOR)

6. For fork/join:
   - Fork action emits N guards (one per branch)
   - Join guard is AND with N slots

7. Emit ProcessDef with all guards, guard relations, and actions
```

---

## 5. Gaps in current Losos (blockers for faithful IR execution)

### 5.1 CRITICAL: Multi-slot guard result reduction

**Current**: `Guard.result()` throws if `slots.size != 1`.
**Needed**: `join` states need AND guards with N slots. The guard must produce a merged result from all filled slots.
**Fix**: Implement `Guard.results(): List<InvocationResult>` or `Guard.mergedResult(): ObjectNode` that collects data from all slots.

### 5.2 CRITICAL: Structured error handling (try/catch/compensate)

**Current**: `FlowStatus.FAILED` halts the entire process.
**Needed**: Error edges in the IR should route to catch handlers instead of halting. The process should be able to:
- Intercept FAILED status on specific guards/actions.
- Run compensation actions.
- Either resume normal flow or halt with error.
**Fix**: Add an error handler concept to ProcessDef: `onError: { scope: guardId, handler: actionId }`.

### 5.3 HIGH: Payload-level pattern matching on slots

**Current**: `InvocationSlot` matches only by etcd key path.
**Needed**: `alt` message guards with value patterns need to match on message payload fields (e.g., `{ code: "TRANSIENT" }`).
**Fix**: Add a `PayloadPredicate` to slot definition: `InvocationSlot(guardId, slotId, predicate?)`.

### 5.4 HIGH: Process-scoped variable context (`$ctx`)

**Current**: Data flows through `InvocationResult.data: ObjectNode?` per slot, no persistent state.
**Needed**: Reagent protocols need `$ctx` — a persistent key-value store per process instance.
**Fix**: Add a process context map stored in etcd at `/proc/<node>/state/<pid>/ctx`. Actions read/write this map.

### 5.5 MEDIUM: OR guard relations (not implemented)

**Current**: OR relations are declared in the enum but runtime ignores them.
**Needed**: Some patterns (race conditions, parallel branch early exit) need OR semantics.
**Fix**: Implement OR relation handling in `Process.processCommand`.

### 5.6 MEDIUM: Event history / replay

**Current**: `history()` is declared but not implemented. `restoreProcess()` creates from scratch.
**Needed**: Crash recovery should replay the trace to restore `$ctx` and guard state.
**Fix**: Store append-only trace at `/proc/<node>/state/<pid>/trace/<seqno>` and replay on restore.

### 5.7 LOW: Timer resolution

**Current**: 100ms polling interval for guard timeouts.
**Needed**: For protocols with sub-second timeouts, polling may be too coarse.
**Fix**: Use etcd lease TTL or a scheduled executor with finer granularity.

---

## 6. Proposed implementation order

1. **$ctx process variable store** (5.4) — prerequisite for any meaningful protocol execution.
2. **Multi-slot guard result** (5.1) — required for `par`/join.
3. **Payload pattern matching** (5.3) — required for `alt` with message patterns.
4. **Structured error handling** (5.2) — required for `try`/`catch`.
5. **ProcessDef code generator** — takes IRGraph, produces JSON ProcessDef.
6. **Event history / replay** (5.6) — required for production durability.
7. **OR guard relations** (5.5) and **timer resolution** (5.7) — nice-to-have.

---

## 7. Example mapping: AwaitTimeoutAlt (example 02)

### IR (comma role)

```
init_1 → send_2(→sia: SubmitIntent) → xor_3 → [Accept | Reject | timeout 10s] → action → merge → end
```

### Losos ProcessDef (sketch)

```json
{
  "name": "AwaitTimeoutAlt__comma",
  "startGuard": "g_init",
  "finishGuard": "g_end",
  "guards": [
    { "id": "g_init", "slots": [], "action": "a_init", "type": "OR" },
    { "id": "g_send_done", "slots": [{ "type": "invocation", "id": "g_send_done", "slotId": "s0" }], "action": "a_xor_setup" },
    { "id": "g_accept", "slots": [{ "type": "invocation", "id": "g_accept", "slotId": "accept" }], "action": "a_accepted" },
    { "id": "g_reject", "slots": [{ "type": "invocation", "id": "g_reject", "slotId": "reject" }], "action": "a_rejected" },
    { "id": "g_timeout", "slots": [], "action": null, "type": "OR", "timeout": 10000, "timeoutAction": "a_timedout" },
    { "id": "g_merge", "slots": [{ "type": "invocation", "id": "g_merge", "slotId": "s0" }], "action": "a_end" },
    { "id": "g_end", "slots": [{ "type": "invocation", "id": "g_end", "slotId": "s0" }], "action": null }
  ],
  "guardRelations": [
    { "guards": ["g_accept", "g_reject", "g_timeout"], "type": "XOR" }
  ],
  "actions": [
    { "id": "a_init", "type": "invoke", "invocationType": "ASYNC", "task": "reagent_send", "args": { "to": "sia", "msg": "SubmitIntent", "preSendZone": "..." }, "runGuards": ["g_send_done"] },
    { "id": "a_xor_setup", "type": "invoke", "invocationType": "ASYNC", "task": "reagent_noop", "runGuards": ["g_accept", "g_reject", "g_timeout"] },
    { "id": "a_accepted", "type": "invoke", "invocationType": "ASYNC", "task": "reagent_zone", "args": { "body": "$ctx.status = 'accepted'" }, "runGuards": ["g_merge"] },
    { "id": "a_rejected", "type": "invoke", "invocationType": "ASYNC", "task": "reagent_zone", "args": { "body": "$ctx.status = 'rejected'" }, "runGuards": ["g_merge"] },
    { "id": "a_timedout", "type": "invoke", "invocationType": "ASYNC", "task": "reagent_zone", "args": { "body": "$ctx.status = 'timeout'" }, "runGuards": ["g_merge"] },
    { "id": "a_end", "type": "invoke", "invocationType": "ASYNC", "task": "reagent_finish" }
  ]
}
```

This demonstrates:
- XOR guard relation for the three alt branches (accept / reject / timeout).
- Timeout modeled as an OR guard with `timeout: 10000`.
- All branches converge to `g_merge` → `a_end`.

---

## 7. Agent-level mapping (v0.0.5)

Reagent v0.0.5 introduces the `agent` construct, which groups protocol participations under a single entity with persistent state and lifecycle hooks.

### 7.1 Agent → Losos NodeManager

An agent maps to a **Losos NodeManager** — the long-lived entity that manages multiple process instances:

| Reagent concept | Losos primitive | Notes |
|---|---|---|
| `agent Comma [ts]` | `NodeManager("Comma")` | Single NodeManager per agent; orchestrates all processes |
| `plays TaskExecution as comma` | Routing config | When a `TaskExecution` protocol starts, the NodeManager creates a process for the `comma` role |
| `$self` | Agent-scoped etcd prefix | `/agents/<agentId>/self/` — survives across protocol instances |
| `$ctx` | Process-scoped etcd prefix | `/processes/<processId>/ctx/` — per protocol instance (unchanged) |

### 7.2 Agent init → Losos bootstrap action

The `init { ... }` block maps to a **bootstrap action** that runs once when the NodeManager starts:

```
Action {
  id: "a_agent_init",
  type: "invoke",
  invocationType: "SYNC",
  task: "reagent_agent_zone",
  args: { body: "<init body>", selfPrefix: "/agents/Comma/self/" }
}
```

The bootstrap action has no guards — it runs unconditionally on agent startup.

### 7.3 Lifecycle handlers → Guards on trace events

Each `on <event>(<Proto>) { ... }` maps to a **guard-action pair** that watches protocol trace events:

| Lifecycle event | Guard trigger |
|---|---|
| `protocolStarted(TaskExecution)` | Guard on etcd watch: key prefix `/traces/TaskExecution/*/started` |
| `protocolCompleted(TaskExecution)` | Guard on etcd watch: key prefix `/traces/TaskExecution/*/completed` |
| `protocolFailed(TaskExecution)` | Guard on etcd watch: key prefix `/traces/TaskExecution/*/failed` |
| `protocolEvent(eventName)` | Guard on etcd watch: key prefix `/traces/*/events/<eventName>` |

Each lifecycle handler becomes:

```
Guard  { id: "g_on_completed_TaskExecution", slot: "trace_watch", conditions: { event: "completed", protocol: "TaskExecution" } }
Action { id: "a_on_completed_TaskExecution", type: "invoke", task: "reagent_agent_zone", args: { body: "<handler body>", selfPrefix: "/agents/Comma/self/" } }
```

The lifecycle guard-action pairs live at the NodeManager level, not inside any specific process.

### 7.4 `$self` in protocol zones

When a protocol zone references `$self`, the runtime must inject the agent's etcd prefix alongside the process `$ctx`. This requires:

1. The process knows which agent it belongs to (agent binding from `plays` config).
2. The zone execution context receives both `$ctx` (process-local) and `$self` (agent-global).
3. Writes to `$self` must be serialized across concurrent protocol instances (etcd transactions or compare-and-swap).

### 7.5 Agent-level gaps in Losos

| Gap | Severity | Description |
|---|---|---|
| **NodeManager lifecycle hooks** | MEDIUM | Losos NodeManagers currently don't support arbitrary startup actions or trace-event watchers. Need to extend NodeManager with `onInit` and `onTraceEvent` hooks. |
| **Cross-process `$self` serialization** | HIGH | Concurrent protocol instances writing to `$self` need serialized access. Losos needs agent-scoped etcd transactions or a dedicated agent state lock. |
| **Agent-to-protocol routing** | LOW | Losos needs a routing table to map incoming protocol starts to the correct agent and create processes accordingly. This is a configuration concern, not a runtime gap. |
