# Versioning And Reconcile

This document describes the current protocol identity model, RC registry, and desired-state reconciliation layer.
It replaces `protocol-versioning.md` as the canonical current-state spec.

## 1. Problem Space

Reagent needs three distinct planes:

- compilation output
- actual cluster state
- desired deployment state

Without that separation, hot deploy, compatibility checks, and reconciliation become ambiguous.

## 2. Three-Plane Model

| Plane | Meaning | Current owner |
|---|---|---|
| Compilation | What the compiler emitted | `lang/` + IR artifacts |
| Cluster state | What is actually deployed | node-local RC registries and cluster-visible agent state |
| Desired state | What should be running | deploy specs and ROS reconciliation inputs |

This separation still holds after the runtime tree reorganization.

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
- drive deploy/reconcile decisions

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
- RC registry stores deployed protocol identity for runtime use

This lets the runtime reason about deployed compatibility without turning ROS into the global runtime owner.

## 6. RC Registry

The runtime registry is implemented through `ProtocolRegistry` and exposed by RC.

It tracks:

- protocol version
- fingerprints
- dependencies
- bound agents
- registered graphs

Current TS implementation lives in:

- `runtime/ts/src/controller/protocol-registry.ts`
- `runtime/ts/src/controller/reagent-controller.ts`

This registry is critical for:

- `listProtocols()`
- compatibility checks
- trigger registration
- local invoke path
- cluster inspection

## 7. Dependency Tracking

When a protocol invokes or spawns another protocol, the compiler records dependency information.

That dependency data is used during deploy-time reasoning to detect cases where:

- the caller expects one structure hash
- the cluster currently hosts another

This is why reconciliation cannot be a blind "copy files to node" process.

## 8. Desired State

Desired state is expressed through deploy-spec structures rather than through compiled IR alone.

Core concepts:

- protocols desired in the cluster
- agents desired in the cluster
- node placement intent

Current TS structures live in:

- `runtime/ts/src/admin/deploy-spec.ts`
- `runtime/ts/src/admin/registry-view.ts`
- `runtime/ts/src/admin/reconciler.ts`

## 9. Reconciliation

ROS is the natural place for reconciliation because it already sees:

- connected nodes
- cluster-facing inspection results
- deploy requests from clients

But reconciliation should not be confused with runtime ownership.

Current reconciliation job:

- compare desired deploy spec against observed registry view
- generate deploy, upgrade, create-agent, and stop-agent actions
- preserve dependency ordering
- surface conflicts rather than silently forcing incompatible updates

## 10. Current Operational Model

### What ROS should do

- collect cluster status
- compare desired and actual state
- compute a plan
- drive deploy and stop actions

### What ROS should not do

- own cluster-wide protocol startup sequencing for all nodes
- assemble the runtime's final role bindings as a permanent source of truth
- replace node-local RC registry and cluster-backed state

## 11. Python Runtime Note

The versioning and reconcile model is shared conceptually across TS and Python runtimes.
However, only the TS runtime tree was structurally reorganized in this pass.

Implication:

- conceptual parity exists in parts of the registry/versioning model
- structural parity in source layout does not
- when reading implementation paths in this doc, prefer TS paths as canonical current references

## 12. Primary Files

- `lang/src/ir.ts`
- `lang/src/ir-fingerprint.ts`
- `lang/src/versioning.ts`
- `runtime/ts/src/controller/protocol-registry.ts`
- `runtime/ts/src/controller/reagent-controller.ts`
- `runtime/ts/src/admin/deploy-spec.ts`
- `runtime/ts/src/admin/registry-view.ts`
- `runtime/ts/src/admin/reconciler.ts`
- `runtime/tests/m8a-fingerprints.test.ts`
- `runtime/tests/m8a-registry.test.ts`
- `runtime/tests/m8b-reconciler.test.ts`
