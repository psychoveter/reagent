# Versioning And Reconcile

This document describes the current protocol identity model, runtime registry, and desired-state reconciliation layer.

It replaces `protocol-versioning.md` as the canonical current-state document.

## 1. Problem Space

Reagent needs three distinct planes:

- compilation output
- actual cluster state
- desired deployment state

Without that separation, hot deploy, compatibility checks, and convergence become ambiguous.

## 2. Three-Plane Model

| Plane | Meaning | Current owner |
|---|---|---|
| Compilation | What the compiler emitted | `lang/` + IR artifacts + `reagent.lock` |
| Cluster state | What is actually present and reachable | node-local RC registries + cluster-visible state in `StateStore` |
| Desired state | What should be running | `DeploySpec` + reconciliation inputs |

This three-plane split still holds after the runtime and control-plane reorganization.

The important current correction is:

- desired state is declarative input for the reconciler
- desired state is a first-class model consumed by control-plane tooling such as `AdminClient`

## 3. Fingerprints

Each compiled protocol carries independent hashes for:

- structure
- schema
- implementation

Each role carries independent hashes for:

- plays
- behavior

These hashes are used to:

- classify changes
- assign versions
- check compatibility
- drive deploy and reconciliation decisions

## 4. Auto-Versioning

The compiler derives version bumps from fingerprint changes.

Protocol bump rules:

- structure change => major
- schema change => minor
- implementation-only change => patch
- no change => keep version

Role bump rules:

- plays change => major
- behavior change => minor

The canonical memory of prior versions lives in `reagent.lock`.

## 5. Where Version Data Lives

Current sources of truth:

- compiled IR files contain version and fingerprint metadata
- `reagent.lock` stores prior known versions and hashes
- `ProtocolRegistry` stores deployed protocol identity for runtime use
- shared cluster state stores node and agent presence for control-plane lookup

This allows the runtime and control plane to reason about deployed compatibility without a central orchestrator owning cluster truth.

## 6. Runtime Registry

The runtime registry is implemented through `ProtocolRegistry` and exposed by `ReagentController`.

It tracks:

- protocol version
- fingerprints
- dependencies
- bound agents
- registered graphs

Current TypeScript implementation lives in:

- `runtime/ts/src/controller/protocol-registry.ts`
- `runtime/ts/src/controller/reagent-controller.ts`

This registry is critical for:

- `listProtocols()`
- compatibility checks
- trigger registration
- local invoke flow
- node inspection

## 7. Dependency Tracking

When a protocol invokes or spawns another protocol, the compiler records dependency information.

That dependency data is used during deploy-time reasoning to detect cases where:

- the caller expects one structure hash
- the cluster currently hosts another

This is why reconciliation cannot be a blind “copy artifacts to node” process.

## 8. Desired State

Desired state is expressed through deploy-spec structures rather than through compiled IR alone.

Core concepts:

- protocols desired in the cluster
- agents desired in the cluster
- optional node placement intent

Current TypeScript structures live in:

- `runtime/ts/src/admin/deploy-spec.ts`
- `runtime/ts/src/admin/registry-view.ts`
- `runtime/ts/src/admin/reconciler.ts`

Important current behavior:

- `DeploySpec.agents[].targetNode` is optional
- if omitted, the reconciler or deploy tool can assign placement
- desired state is therefore about intent, not just a hardcoded topology dump

## 9. Actual State

Actual state for reconciliation is modeled as `RegistryView`.

`RegistryView` aggregates:

- nodes
- protocols
- agents
- timestamp

It is the “what currently exists” side of the comparison.

Conceptually, actual state comes from a mix of:

- shared cluster truth in `StateStore`
- direct node inspection when deeper local detail is needed

Some comments in `registry-view.ts` still mention older RAP collection patterns; those should be read as implementation-history residue, not as the architectural model.

## 10. Reconciliation

Reconciliation compares desired state against actual state to produce a `ReconciliationPlan`.

Current reconciliation job:

- compare `DeploySpec` against `RegistryView`
- generate deploy, upgrade, create-agent, and stop-agent actions
- preserve dependency ordering
- surface conflicts rather than silently forcing incompatible updates

This logic lives in:

- `runtime/ts/src/admin/reconciler.ts`

The reconciler is a control-plane function. It is not the runtime.

## 11. Current Operational Model

In the current architecture, the operational story should be read like this:

- the compiler produces versioned artifacts and fingerprints
- RCs hold node-local deployed protocol identity
- shared cluster state exposes node and agent presence
- `AdminClient` and other control-plane tooling build or consume desired state
- reconciliation compares desired vs actual and then drives node-directed actions

This is the important correction relative to older docs:

- reconciliation is a control-plane function, not tied to any single server process
- the canonical model is `AdminClient` + shared cluster state + per-node control

## 12. What Reconciliation Must Not Do

Reconciliation must not:

- become the owner of runtime execution
- become the permanent source of truth for role bindings
- replace node-local protocol registries
- assume “deployed” implies “runtime attached and ready”

Those are runtime concerns, not desired-state-planning concerns.

## 13. Python Runtime Note

The versioning and reconciliation model is shared conceptually across TS and Python runtimes.
However, only the TS runtime tree was structurally reorganized in this pass.

Implication:

- conceptual parity exists in parts of the registry/versioning model
- structural parity in source layout does not
- when reading implementation paths in this document, prefer TS paths as canonical current references

## 14. Primary Files

- `lang/src/ir.ts`
- `lang/src/ir-fingerprint.ts`
- `lang/src/versioning.ts`
- `runtime/ts/src/controller/protocol-registry.ts`
- `runtime/ts/src/controller/reagent-controller.ts`
- `runtime/ts/src/admin/deploy-spec.ts`
- `runtime/ts/src/admin/registry-view.ts`
- `runtime/ts/src/admin/reconciler.ts`
- `runtime/ts/src/admin/client.ts`
- `runtime/tests/m8a-fingerprints.test.ts`
- `runtime/tests/m8a-registry.test.ts`
- `runtime/tests/m8b-reconciler.test.ts`

## 15. Short Version

If you remember only one thing from this file, remember this:

**Versioning is compiler-driven, actual state is runtime- and cluster-driven, and reconciliation is a control-plane comparison between desired and actual state. It is not a central runtime owner.**
