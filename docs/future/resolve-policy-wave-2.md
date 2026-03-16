# Resolve Policy Wave 2

Status: remaining work only | Date: 2026-03-16

This file tracks only the work that remains after the implemented resolve-policy surface was folded into the canonical current docs:

- `docs/current/02-lang-spec.md`
- `docs/current/03-runtime-core.md`
- `docs/current/04-cluster-and-control-plane.md`
- `docs/current/08-test-spec.md`

Do not use this file to describe already-shipped syntax or current runtime behavior. `current/` is authoritative for that.

---

## 1. Remaining work

### W2-1. Zone-level dynamic resolution

Current gap:

- managed zones do not yet support `reagent.resolve()`
- managed zones do not yet expose `reagent.registry`

Required outcome:

- zone code can resolve dynamic participants through the same policy machinery used by trigger-level resolve
- zone code can inspect a read-only registry view when needed
- runtime docs can promote these APIs into `current/` as stable surface

Minimum proof:

- one focused runtime-core test for `reagent.resolve()`
- one focused runtime-core test for `reagent.registry`
- one story/integration test that uses dynamic resolution in an actual protocol run

### W2-2. `leastLoaded` as real policy

Current gap:

- `leastLoaded` is parsed and emitted, but evaluator behavior is still equivalent to first-candidate selection

Required outcome:

- active protocol load is tracked per candidate agent
- evaluator picks the least-loaded addressable candidate deterministically
- semantics are documented as current behavior rather than planned behavior

Minimum proof:

- evaluator-level test with differing per-agent load
- at least one integration test where load affects selected binding

### W2-3. Cluster-shared policy state semantics

Current gap:

- stateful policy state such as `roundRobin` cursor remains controller-local
- cluster docs intentionally do not claim durable shared policy state yet

Required outcome:

- either persist/share policy state across RCs, or explicitly standardize node-local semantics as the intended model
- document the actual consistency model for stateful resolve in cluster deployments

Minimum proof:

- multi-RC integration test showing the intended behavior
- corresponding update to `03-runtime-core.md` and `04-cluster-and-control-plane.md`

### W2-4. Advanced resolve examples and e2e coverage

Current gap:

- examples still overwhelmingly use `resolve ... = single`
- no canonical story exercises advanced trigger-level resolve in a real protocol path

Required outcome:

- at least one canonical example for filtered multi-candidate resolve
- at least one story or integration test for `from($ctx.input...)`
- at least one story or integration test for `all | filter(...) | roundRobin`

Preferred shapes:

- a buyer/seller or worker-pool example with `many` participants
- a trigger path that binds from explicit agent ids in input

### W2-5. Resolve-policy alignment with `agent type`

Current gap:

- current implementation still uses `agent ... runs ...` plus metadata bodies in the core DSL
- the longer-term direction in `agent-types.md` has not landed

Required outcome:

- either keep resolve-policy permanently anchored to the current DSL, or land the migration to `agent type`
- remove any ambiguity about where resolve-facing metadata is declared

Dependency:

- coordinated with `agent-types.md`

---

## 2. Exit criteria for closing Wave 2

Resolve-policy Wave 2 can be considered complete when all of the following are true:

- `reagent.resolve()` works in managed zones
- `reagent.registry` works in managed zones
- `leastLoaded` is no longer a stub
- cluster semantics for stateful policies are explicit and tested
- current examples and story coverage include at least one non-trivial resolve pipeline
- no future doc is needed to explain the active resolve-policy surface because `current/` fully covers it

---

## 3. Non-goals for this file

- re-documenting parser syntax already covered in `02-lang-spec.md`
- repeating implemented trigger-level evaluator behavior already covered in `03-runtime-core.md`
- keeping a second implementation report in parallel with `current/`
