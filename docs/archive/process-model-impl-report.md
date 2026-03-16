# Process Model — Implementation Report

> **Archived 2026-03-08.** The process model is now reflected in canonical
> documentation at `../current/03-runtime-core.md §9`. This report is retained
> for historical reference alongside its source RFC `process-model.md`.

Date: 2026-03-13  
Source RFC: `process-model.md`

---

## 1. Executive status

The first post-review implementation wave is complete for:

- `G1` record-level CAS adoption
- `G2` participant-loss supervision paths
- `G3` distributed cancellation convergence
- `G4` protocol-level supervision syntax/IR/runtime persistence
- `G6` bounded local finished-run retention
- `G7` explicit home-RC supervision semantics

`G5` remains intentionally deferred. `$self` is still in-memory only.

The runtime is still an MVP in one important sense: it now models supervision,
ownership, cancellation, and protocol-run durability correctly enough for the
corrected RFC, but it still does **not** attempt checkpointed resume or full
RoleRun continuation after RC death.

---

## 2. Implementation status

### 2.1 Phase 1 — Durable protocol-process records

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| `ProtocolRunRecord` / `ProtocolRunStatus` / lineage types | Done | `runtime/ts/src/contracts/protocol-run.ts` | Includes `homeNodeId`, `parentInstanceId`, `rootInstanceId`, `childInstanceIds`, `spawnedAgents`, `participantLosses`, `cancellation` |
| `/protocol-runs/{instanceId}` state-store prefix | Done | `runtime/ts/src/controller/reagent-controller.ts` | Durable protocol-process records persisted in `StateStore` |
| Root run record creation | Done | `ReagentController.handleShellRunLifecycleEvent()` | Trigger-created runs materialize durable records |
| Child protocol lineage (`invoke` / `async_invoke`) | Done | `AgentShellImpl` + `ReagentController` | Parent-child links recorded through lifecycle events |
| Spawn ownership recording | Done | `AgentShellImpl.performRoleSpawn()` + `ReagentController` | Scoped spawned agents recorded on parent protocol record |
| Record-level CAS primitive | Done | `runtime/ts/src/cluster/state-store.ts`, `runtime/ts/src/cluster/etcd-state-store.ts` | `compareAndSwap()` added for memory + etcd stores |
| Atomic orphan adoption on the record itself | Done | `ReagentController.handleNodeDeparture()` | Separate adoption-lock key removed; ownership transfer is CAS on `/protocol-runs/{id}` |

### 2.2 Phase 2 — Local lifecycle correctness

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| `RoleRun.cancel()` | Done | `runtime/ts/src/core/role-run.ts` | Cooperative cancellation path |
| Interruptible waits/timers | Done | `RoleRun.sleep()` and cancellation waiters | Waits/timers reject cleanly on cancel |
| Shell stop cancels hosted runs | Done | `runtime/ts/src/core/agent-shell-impl.ts` | `stop()` cancels active runs and now resolves from terminal status without a brittle timeout race |
| Scoped spawn cleanup | Done | `ReagentController.cleanupSpawnedAgents()` | Called on terminal protocol outcomes and orphan failover |
| Child-run bookkeeping surfaced to RC | Done | `AgentShellRunLifecycleEvent` | RC receives `run_created`, `run_completed`, `spawn_recorded` |
| Bounded local finished-run retention | Done | `AgentShellImpl` | `finishedRunRetentionLimit` bounds `finishedRuns` and `completedRunResults` |

### 2.3 Phase 3 — Cluster supervision MVP

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| Node-loss detection | Done | `runtime/ts/src/cluster/etcd-membership.ts` | Lease-backed membership watches |
| Orphan handling entrypoint | Done | `ReagentController.handleNodeDeparture()` | Invoked from membership/bootstrap callbacks |
| Strategy-aware orphan adoption | Done | `ReagentController.handleNodeDeparture()` | `scoped` cancels conservatively, `detached` fails conservatively, `one-for-one`/`all-for-one` attempt first-wave re-resolve/rebind |
| Home-RC ownership explicit in runtime logic | Done | `ReagentController` helpers and supervision paths | Supervision is no longer tied to initiator-shell lifetime |
| Local participant-loss path | Done | `ReagentController.handleAgentUnavailable()` | Distinguishes local participant loss from RC/node loss |
| Remote participant-loss path | Done | `ReagentController.handleNodeDeparture()` + route failure path | Home RC can fail or re-resolve affected roles |
| Narrow re-resolve/rebind for lost participants | Done | `ReagentController.handleParticipantLoss()` | Rebinds local live send paths, updates durable ownership, and redirects undeliverable sends to the replacement agent when available |
| Restart-safe scoped spawned cleanup | Done | `ReagentController.cleanupSpawnedAgents()` + startup reconciliation | Durable `record.spawnedAgents` can drive cleanup after RC restart |

### 2.4 Phase 4 — Control plane and convergence

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| List protocol runs | Done | `runtime/ts/src/admin/client.ts`, `runtime/ts/src/nodes/mcp/mcp-gate.ts` | Includes `cancelling` records |
| Inspect protocol run | Done | `runtime/ts/src/admin/client.ts`, `runtime/ts/src/nodes/mcp/mcp-gate.ts` | Returns record + parent + children |
| Cancel protocol run | Done | `runtime/ts/src/admin/client.ts`, `ReagentController` | Cancellation now enters convergence path |
| `cancelling` protocol-run state | Done | `runtime/ts/src/contracts/protocol-run.ts` | Non-terminal convergence state added |
| Cancellation acknowledgements on durable record | Done | `ProtocolCancellationState` | Stores `requestedByNodeId`, reason, acked roles, acked nodes |
| Prefix-watch cancellation convergence | Done | `ReagentController` + `StateStore.watch("/protocol-runs/")` | Uses prefix watch, not per-instance watch explosion |

### 2.5 Language / IR supervision surface

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| Protocol-level `supervision:` directive | Done | `lang/src/parser.ts`, `lang/src/ast.ts` | Syntax is protocol-header level, not trigger-body level |
| IR field emission | Done | `lang/src/ir.ts`, `lang/src/ir-emitter.ts` | Emitted onto every role graph |
| Runtime type alignment | Done | `runtime/ts/src/contracts/types.ts`, `runtime/ts/src/contracts/protocol-run.ts` | Unified strategy enum: `scoped | one-for-one | all-for-one | detached` |
| Decompile support | Done | `lang/src/ir-decompiler.ts` | Round-trips `supervision: ...` |
| Fingerprint support | Done | `lang/src/ir-fingerprint.ts` | Strategy changes affect protocol structure hash |
| Runtime persistence | Done | `AgentShellImpl` + `ReagentController` | Declared strategy is persisted to `ProtocolRunRecord` |

Note: strategy **declaration and persistence** are implemented, and the runtime
now branches in a first-wave MVP:

- `scoped` orphan adoption terminates conservatively as `cancelled`
- `detached` orphan adoption terminates conservatively as `failed`
- `one-for-one` / `all-for-one` currently share the same narrow re-resolve/rebind
  path and do not yet perform checkpointed restart/resume or full sibling restart

---

## 3. RFC alignment after proposal feedback

The corrected RFC model is now reflected in implementation as follows:

- Home RC supervision is independent from initiator-shell lifetime. Initiator loss is treated as participant loss while the RC survives.
- The protocol-process lifecycle is distinct from the agent-process lifecycle. The runtime still preserves the existing `AgentRecord` / `AgentShell` lifecycle separately.
- Supervision strategy is no longer "TBD" in the implementation surface: `.rg` syntax, AST, IR, decompile, fingerprint, runtime contract, and persistence now exist.
- Participant-local failure while the home RC remains alive is distinct from RC/node failure, and has its own supervision path.
- Distributed cancellation uses a single prefix watch on `/protocol-runs/` with client-side filtering/convergence.
- Orphan adoption now uses CAS on the protocol-process record itself, not a separate lock key.
- Leader-election-oriented bootstrap assumptions remain aligned with the corrected RFC.
- Local `finishedRuns` growth is now bounded by explicit shell retention policy.
- `$self` durability remains an open design choice and is still deferred.

---

## 4. Gap status

| Gap | Status | Notes |
|-----|--------|-------|
| `G1` Adoption CAS | Done | `StateStore.compareAndSwap()` added; adoption lock key scheme removed |
| `G2` Participant-loss supervision | Done | Home RC now handles local detach, remote disappearance, route loss, and narrow re-resolve |
| `G3` Distributed cancellation convergence | Done | `cancelling` state + durable acknowledgement metadata + prefix watch convergence |
| `G4` Supervision strategy syntax/IR | Done | Protocol-level `supervision:` directive implemented end-to-end |
| `G5` `$self` durability | Deferred | Still intentionally in-memory only |
| `G6` Finished-run retention | Done | Local shell history is bounded; durable protocol records remain inspectable |
| `G7` Explicit home-RC ownership | Done | Home-RC supervision semantics are explicit in controller behavior and tests |

---

## 5. Test coverage

### Added / updated coverage

| Test file | Coverage |
|-----------|----------|
| `runtime/ts/test/m8c-rc-lifecycle.test.ts` | durable protocol-run records, strategy-aware orphan adoption, spawn lineage, `cancelling` state, initiator loss with surviving home RC, participant re-resolve, watch-driven distributed cancellation, restart-safe spawned cleanup, bounded local retention |
| `runtime/ts/test/m6-admin.test.ts` | list/inspect/cancel protocol-run flows, `cancelling` records, acknowledgement metadata surfaces |
| `runtime/ts/test/r1-regression-fixes.test.ts` | bounded shell-local finished-run retention (`RF5b`) + `AgentShellImpl.stop()` race regression (`RF5c`) |
| `runtime/ts/test/m11-state-resolve.test.ts` | in-memory `compareAndSwap()` semantics |
| `runtime/ts/test/etcd-cluster.test.ts` | etcd-backed `compareAndSwap()` semantics + record-level orphan adoption path |
| `lang/test/m10-phase4a.test.ts` | protocol-level `supervision:` parse/IR/default/fingerprint coverage |
| `runtime/ts/test/m8a-decompiler.test.ts` | decompile round-trip preserves `supervision:` directive |

### Validated behaviors

- CAS adoption is atomic on `/protocol-runs/{id}`
- initiator-shell loss does not imply orphaning while the home RC survives
- participant loss can re-resolve to a replacement participant and update live routing/bindings
- cancellation progresses through `cancelling` and converges through shared durable state
- startup reconciliation can clean non-persistent spawned agents from durable lineage after restart
- local finished-run history evicts predictably without deleting durable protocol-run records
- supervision directive is preserved across parse -> IR -> decompile -> runtime persistence

---

## 6. Remaining work after this wave

### `G5` — `$self` durability policy

**RFC reference:** `process-model.md` §10.4  
**Current state:** `$self` is still in-memory only in `AgentShellImpl`.  
**Deferred by decision:** yes.

Still needed later:

- decide whether `$self` stays in-memory by default or gets durable backing
- if durable, define size limits, consistency model, and write cadence
- if in-memory remains the default, document the operational implications clearly in current docs

### Optional follow-ups beyond first-wave closure

- differentiate `all-for-one` from `one-for-one` with real sibling restart semantics
- define TTL / archive / sweeper policy for durable terminal `/protocol-runs/*` records
- add broader multi-node cancellation and participant-loss scenarios beyond current targeted coverage
- design checkpoint/resume separately from the completed orphan/fail/rebind MVP
