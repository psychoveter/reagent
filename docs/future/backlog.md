## Reagent — Future backlog

This file tracks only **unfinished work** on top of the current Reagent architecture.

Current conceptual baseline:

- runtime execution is node-local in `ReagentController`
- shared cluster truth lives in `StateStore`
- tool-facing control uses `AdminClient` + per-node control endpoints
- `mcp-gate` and wrapper hosts such as Claude `live-agent` are already part of the current model
- R1 ontology is the sole execution model: `AgentShell`/`AgentShellImpl` (session container), `AgentBehavior` (pluggable behavior), `BehaviorFactory` (replaces removed `AgentNode`), `RoleRun` (unified orchestration), `RoleEngine` (passive FSM with native inbox)
- legacy types removed: `ProtocolInstance`, `AgentRunner`, `AgentNode`, `AgentHandle`, `NativeAgentNode`, `CustomAgentNode`, `MessageGateNode`, `PythonAgentNode`
- **process model** is implemented: protocol/agent process kinds, ownership semantics (strong/scoped/trigger/detached), supervision strategies (`scoped`/`one-for-one`/`all-for-one`/`detached`), fault propagation, distributed cancellation convergence, RC failure detection and orphan adoption via CAS, durable `ProtocolRunRecord` lineage. See `../current/03-runtime-core.md §9`.

Reference documents:

- current architecture: `../current/`
- runtime core: `../current/03-runtime-core.md`
- cluster/control plane: `../current/04-cluster-and-control-plane.md`
- versioning/reconcile: `../current/05-versioning-and-reconcile.md`
- current test inventory: `../current/08-test-spec.md`
- next-step testing plan: `./test-spec-next.md`
- archive of completed waves: `../archive/`

Completed work is intentionally not tracked here. When something lands and is reflected in
`docs/current/`, it should move out of this file.

---

## 1. Active backlog

These are the most practical next steps for the current TS-first runtime line.
Python parity remains valuable, but it is intentionally deprioritized relative to
the TypeScript runtime, control-plane hosts, and test surface.

### Runtime and cluster


| #   | Feature                                              | Status       | Area              | Notes                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------- | ------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Unified engine (R1 Antientropy) + legacy cleanup** | **Complete** | `runtime/ts`      | R1 ontology is the sole execution model. `RoleEngine`, `RoleRun`, `AgentShellImpl`, `AgentBehavior`, `BehaviorFactory`. Legacy types (`ProtocolInstance`, `AgentRunner`, `AgentNode`, `AgentHandle`, all `*-node.ts` files) fully removed. See `docs/archive/r1-runtime-antientropy.md`. |
| R5  | **Unified process model (supervision, ownership, fault propagation)** | **Complete** | `runtime/ts`, `lang` | Protocol/agent process kinds, ownership coupling, supervision strategies (`supervision:` directive end-to-end), distributed cancellation convergence, RC failure and CAS-based orphan adoption, durable `ProtocolRunRecord` lineage. `$self` durability deferred. See `docs/current/03-runtime-core.md §9` and `docs/archive/process-model.md`. |
| R2  | **Scatter semantics: deep clone + gather**           | RFC drafted  | `lang`, `runtime` | Current scatter isolation still has inherited mutable-state caveats. Replace `Object.create()`-style semantics with explicit clone/gather behavior.                                                                                                                                      |
| R3  | **TS-first conformance hardening**                   | Not started  | `tests`           | Strengthen fixture-based conformance around the current TS runtime and use it as the reference baseline for later multi-runtime parity work.                                                                                                                                             |
| R4  | **TS cluster/runtime hardening**                     | Not started  | `runtime/ts`      | Keep tightening lease-backed presence, membership, control-plane wiring, and host/runtime integration in the TS runtime before expanding parity work.                                                                                                                                    |


### Testing and validation

The previous deterministic test wave (`T1-T5`) has been implemented:

- infra presence suites were repaired and stabilized
- `08-test-spec.md` was rewritten around inventory, tiers, status, and use-case coverage
- new deterministic story-level suites under `runtime/ts/test/stories/` were added

Those items are intentionally removed from the unfinished backlog.
Another reviewer still needs to validate real usefulness, stability, and adequacy of the
new/updated suites, but that is now a verification task rather than an implementation gap.


| #   | Feature                                               | Status                 | Area                    | Notes                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------- | ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T6  | **Research swarm live e2e**                           | Deferred / conditional | `runtime/ts/test/stories` | Deterministic wave is done. Remaining gap is the external/live distributed research scenario, likely as `runtime/ts/test/stories/live/research-swarm.test.ts` or as an intentional expansion of `runtime/ts/test/stories/live/task-delegation-claude.test.ts`, and it should stay outside the default smoke path. |
| T7  | **Decompiler catch-up for newer language constructs** | Not started            | `lang/test/compiler`    | `lang/test/compiler/compiler-roundtrip.test.ts` is green again, but `CR.2` still tracks an expected-unsupported set for newer examples using invoke, spawn, scatter-gather, cross-language, and multi-protocol patterns. Bring round-trip/decompile support back in sync with the current language surface. |


### Tooling and DX


| #   | Feature                   | Status      | Area                   | Notes                                                                      |
| --- | ------------------------- | ----------- | ---------------------- | -------------------------------------------------------------------------- |
| D1  | **Diagram trace replay**  | Not started | `tools/reagent-vscode` | Animate execution traces on sequence diagrams and protocol visualizations. |
| D2  | **Live topology diagram** | Not started | `tools/reagent-vscode` | Cluster-aware topology visualization for nodes, agents, and links.         |


### Language and runtime semantics


| #   | Feature                                             | Status      | Area                      | Notes                                                                                                                                                                                                                |
| --- | --------------------------------------------------- | ----------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **Distributed `try/catch` semantics**               | RFC drafted | `lang`, `runtime`         | Clarify fault origin, propagation back to the `try` scope, cancellation of in-flight work across roles and `par`/`scatter`, and centralized catch semantics. See `distributed-try-catch.md`. Foundation: process model (R5) provides the distributed cancellation and fault propagation substrate. |
| L2  | **Explicit decision maker in `alt`**                | RFC drafted | `lang`                    | Add `at <role>` or equivalent explicit chooser semantics so branch ownership is explicit and projection-friendly. See `alt-decision-maker.md`.                                                                        |
| L3  | **Immutable `$ctx` model**                          | Not started | `runtime`                 | Move from mutable shared-object semantics toward framework-enforced immutable step boundaries.                                                                                                                       |
| L4  | **Agent types and instance-free participant model** | RFC drafted | `lang`, `runtime`, `docs` | Replace participant language tags with first-class `agent type`, remove `agent ... runs ...` from core DSL, and shift runtime materialization fully to `resolve`/`spawn` + registry semantics. See `agent-types.md`. |


---

## 2. Long-horizon runtime roadmap

These items are not needed to make the current architecture viable, but they remain
important if Reagent grows beyond the current TS/Py runtime line.

### Python host embedding instead of Python runtime parity

We are explicitly **not** pursuing a second full deferred Python runtime line as the main
direction anymore.

For Python-heavy use cases such as NMMO simulation, the target is:

- one Rust `reagent-core`
- embedded in the Python process via bindings such as `PyO3`
- Python-hosted behaviors and simulation-world access
- no separate Python protocol engine to keep in parity with TS

See `./nmmo-python-host.md`.

| #   | Feature                                              | Status      | Area               | Notes                                                                                                                                                           |
| --- | ---------------------------------------------------- | ----------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Embedded Rust core in Python process**             | RFC drafted | `runtime platform` | Primary Python direction. Run Reagent orchestration in Rust while the simulation world stays in Python. Target use case: NMMO and similar in-process simulators. |
| P2  | **Python-hosted behavior adapter via `PyO3`**        | Not started | `runtime platform` | Expose a narrow host API so Python behavior objects can attach to Rust orchestration without becoming a second runtime.                                         |
| P3  | **Tick-batch API for simulation hosts**              | Not started | `runtime platform` | Optimize Python↔Rust crossings around batched tick inputs, observations, intents, and action bundles rather than per-field or per-message micro-calls.         |
| P4  | **Runtime registration model for Python host mode**  | Not started | `runtime`, `docs`  | Define how Python-backed runtime instances register role, `agent type`, metadata, resolve visibility, and spawn lifecycle without reviving `runtime/py` as a peer engine. |


### Runtime platform


| #   | Feature                                              | Status       | Area                    | Notes                                                                                                                                           |
| --- | ---------------------------------------------------- | ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | **Rust `reagent-core`**                              | Not started  | new runtime core        | Implement a performant core engine and registry/interceptor substrate suitable for multi-host embeddings.                                       |
| W2  | **WASM target**                                      | Not started  | runtime platform        | Run protocol execution in browser/Web Worker contexts while preserving Reagent semantics.                                                       |
| W3  | **Language bindings (`PyO3`, `napi-rs`)**            | Not started  | runtime platform        | Use Rust core as a shared execution engine behind Python and Node integrations.                                                                 |
| W4  | **Composite agent / holonic runtime pattern**        | Not started  | runtime composition     | Introduce a facade agent that internally hosts its own RC while remaining externally addressable as a single agent. See `./composite-agent.md`. |
| W5  | **Hot deploy strategy**                              | Not designed | runtime + control plane | Define upgrade semantics across managed, custom, gate, MCP-hosted, and clustered nodes, including running-instance policy.                      |
| W6  | **Rolling upgrade strategy for multi-node clusters** | Not started  | control plane           | Extend the reconcile/deploy model with staged upgrades rather than naive all-at-once node-directed changes.                                     |


### Notes

- These items should be read against the current control-plane model, not the older
ROS-centric architecture.
- If pursued, they should extend `AdminClient` + `StateStore` + per-node host
architecture rather than replace it with a centralized orchestrator.

---

## 3. Formal foundations backlog

These items remain long-horizon research/product-quality work. They matter if Reagent
wants stronger compile-time guarantees without losing its executable runtime model.


| #   | Feature                                             | Status      | Area                 | Notes                                                                                                                  |
| --- | --------------------------------------------------- | ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| F1  | **MPST-style projection / structural verification** | Not started | `lang`               | Replace ad hoc per-role filtering with a better-defined projection model and stronger cross-role consistency checks.   |
| F2  | **Explicit decision maker in `alt`**                | RFC drafted | `lang`               | Also tracked as `L2` because it is both a practical language feature and a prerequisite for stronger formal semantics. See `alt-decision-maker.md`. |
| F3  | **Optional session-type annotations**               | Not started | `lang`               | Add optional protocol-level type constraints without turning Reagent into a fully static language.                     |
| F4  | **Immutable `$ctx` between steps**                  | Not started | `runtime`            | Also tracked as `L3`; useful both semantically and as a foundation for safer parallel/scatter reasoning.               |
| F5  | **Refinement types / verifier hints**               | Not started | `lang`               | Express protocol invariants such as scatter bounds, loop limits, and domain constraints for verification tools.        |
| F6  | **Formalized exception and compensation semantics** | RFC drafted | `lang`, `runtime`    | Tighten the model around distributed failure handling, catch scopes, and compensation/saga-like flows. First practical step captured in `distributed-try-catch.md`. Foundation: process model (R5) defines fault propagation and cancellation. |
| F7  | **Trigger supervision system**                      | Not started | `runtime`, `cluster` | Supervisory semantics for trigger retries, throttling, cooldown state, and operational visibility across nodes. Foundation: process model (R5) defines the protocol supervisor layer that trigger supervision extends. |
| F8  | **Dynamic participant first-use verification**      | Not started | `lang`, `runtime`    | Detect unresolved dynamic participants earlier than the first runtime send/receive failure.                            |
| F9  | **TLA+ generator refresh**                          | Partial     | `lang`               | Generator exists but needs to catch up with the current trigger/runtime model.                                         |


### Practical framing

- These are not prerequisites for the current architecture to function.
- They are best treated as staged research backlog, not as blockers for current TS runtime work.
- When one of them becomes implementation work, it should move upward into section 1.

