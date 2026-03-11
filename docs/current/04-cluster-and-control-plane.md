# Cluster And Control Plane

This document describes the current boundary between node-local runtime ownership and the Reagent control plane.
It replaces the older split across `connectivity.md`, `orchestrator.md`, `ros-rc-interaction.md`, and the standalone runtime-layering note.

## 1. Architecture Summary

Reagent now has a cleaner separation between:

- node-local runtime ownership in `ReagentController`
- cluster infrastructure for discovery and message transport
- control-plane tooling in ROS

The critical current rule is:

**ROS deploys, debugs, inspects, and proxies; node-local RCs own runtime execution.**

## 2. Current Source Layout

Relevant TS source areas:

| Area | Path | Purpose |
|---|---|---|
| Cluster infrastructure | `runtime/ts/src/cluster/` | State store, membership, leader election, bootstrap |
| Network transport | `runtime/ts/src/network/` | `NodeLink` implementations |
| Control plane | `runtime/ts/src/admin/` | admin server, remote node, debug, reconciler, registry view |
| MCP integration | `runtime/ts/src/mcp/` and `mcp-gate.ts` | MCP adapter, MCP server, node host entrypoint |

## 3. Cluster Infrastructure

### State store

Cluster state is abstracted through `StateStore`.
Current implementations:

- `InMemoryStateStore`
- `EtcdStateStore`

Cluster-backed agent knowledge flows through `StateStoreAgentRegistry`, not through ROS-owned global memory.

### Membership

`EtcdMembership` provides:

- node presence
- remote agent discovery
- node leave callbacks

This supports the architectural shift away from ROS needing to assemble a cluster-wide runtime map before protocols can start.

### Leader election

`LeaderElection` is used for singleton cluster behaviors such as cron leadership.

### Runtime bootstrap

`runtime/ts/src/cluster/runtime-bootstrap.ts` centralizes the runtime-side infrastructure bootstrap for hosts that embed RCs.

This is important because hosts such as `mcp-gate` should consume runtime config declaratively instead of hand-building infra wiring ad hoc.

## 4. Message Plane

The message plane is based on `NodeLink`.
Current implementations:

- `InMemoryNodeLink`
- `WsNodeLink`
- `NatsNodeLink`

The message plane is distinct from the control plane:

- Control plane commands are RAP over ROS WebSocket connections.
- Runtime message delivery is RC-to-RC envelope routing through `NodeLink` or loopback.

`NatsTransport` and `NatsCompatTransport` still exist, but they are legacy compatibility pieces rather than the primary architecture.

## 5. Runtime Hosts

### Local RC hosts

A host is any runnable process that embeds an RC and translates process-level config into runtime wiring.

Examples:

- local in-process session RC inside ROS
- `RemoteNode`
- `mcp-gate`
- test bootstraps

### `RemoteNode`

`RemoteNode` remains the ROS-managed adapter host.

Current role:

- connect to ROS
- register as an adapter node
- receive deploy, trigger, inspect, and debug commands
- translate those commands into local RC operations

Important caveat:

`RemoteNode` is still more tightly coupled to ROS transport than the target architecture wants.
It remains a partially transitional host.

### `mcp-gate`

`mcp-gate` is the strongest example of the new direction.

Current role:

- host its own node-local RC
- expose the runtime to an external MCP client
- bootstrap cluster state and message-plane infrastructure from runtime config
- deploy `AgentTemplate` / `AgentRecord` locally and attach `AgentRuntime` when the MCP client registers
- invoke protocols locally through RC
- use ROS primarily for deploy, inspect, and debug/control compatibility

This means `mcp-gate` already treats ROS more as control plane than as runtime owner.

## 6. ROS Responsibilities

The current legacy-compatible admin server lives in `runtime/ts/src/admin/ros.ts`.

Current responsibilities:

- compile `.rg` sources for local session workflows
- manage local run/debug sessions
- accept RAP client connections
- track connected adapter nodes
- distribute deploy requests
- proxy trigger/debug/inspect requests to node hosts
- maintain registry and reconciliation views for the cluster

No central admin host should be treated as the owner of distributed protocol startup.

Current implementation note:

- `AdminClient` is the canonical tool-facing entrypoint over the cluster/admin API surface
- declarative cluster truth lives in `StateStore`
- imperative control happens through per-node control endpoints
- docs that still mention ROS or a central admin host elsewhere are historical and no longer describe the canonical architecture

### What changed

Older docs described ROS as more deeply involved in protocol startup and cluster-wide role binding assembly.
That is no longer the intended runtime model.

Current direction:

- deploy should resolve through `StateStore` and per-node control endpoints
- debug should attach directly to the owning node endpoint
- inspect should query shared state first and then the specific node endpoint when deeper runtime detail is needed
- actual protocol invocation should happen through the node-local RC that owns the initiator

## 7. Trigger Flow In Cluster Mode

Current intended flow:

1. A client asks ROS to trigger a protocol.
2. ROS identifies the initiator node.
3. ROS forwards the request to that node as a control-plane proxy.
4. The node-local RC invokes the protocol locally.
5. Participant resolution is derived from cluster-backed runtime state, not from a ROS-built global startup map.

In terms of runtime ontology, this means:

- deploy can create `AgentTemplate` and `AgentRecord`
- trigger/invoke should only target records that currently have attached `AgentRuntime`
- control plane must not assume that “deployed” implies “runtime attached”

This is the architectural consequence of adding reliable cluster state to RC.

## 8. Debug And Inspect

Debug infrastructure lives under `runtime/ts/src/admin/`:

- `debug-controller.ts`
- `debug-interceptor.ts`
- `debug-advance-hook.ts`
- `session.ts`

Current debugging model:

- ROS coordinates the client-facing debug session
- RC-level interceptors and advance hooks perform the actual runtime pauses
- remote hosts surface stop/inspect information back through ROS

This keeps runtime stepping local to the node while preserving centralized UX.

## 9. Registry View And Reconciliation Inputs

Cluster control-plane state is modeled through:

- `registry-view.ts`
- `deploy-spec.ts`
- `reconciler.ts`

These structures exist so ROS can reason about:

- what is currently deployed
- what should be deployed
- how to converge the two

They are not a substitute for node-local runtime ownership.

## 10. Runtime Config Boundary

The runtime config boundary matters most in cluster-capable hosts.

RC-facing declarative config should cover:

- node id
- state store backend
- membership
- message plane
- telemetry
- trigger policy defaults

RC-facing imperative code should cover:

- concrete `AgentNode` instances
- host wiring
- MCP or RAP adapters
- process lifecycle

This lets RC remain ROS-agnostic while still being embeddable in ROS-connected hosts.

## 11. Python Runtime Asymmetry

The TS runtime and its hosts were structurally reorganized in this pass.
The Python runtime was not.

Practical consequence:

- TS docs in this file describe the current architectural boundary with freshly reorganized source layout
- Python runtime behavior may mirror parts of the model, but its file structure and host layering are not yet aligned the same way

Do not assume path parity between `runtime/ts/` and `runtime/py/`.

## 12. Primary Files

For current cluster/control-plane behavior, start with:

- `runtime/ts/src/admin/ros.ts`
- `runtime/ts/src/admin/remote-node.ts`
- `runtime/ts/src/admin/session.ts`
- `runtime/ts/src/admin/debug-controller.ts`
- `runtime/ts/src/admin/registry-view.ts`
- `runtime/ts/src/admin/reconciler.ts`
- `runtime/ts/src/cluster/runtime-config.ts`
- `runtime/ts/src/cluster/runtime-bootstrap.ts`
- `runtime/ts/src/cluster/etcd-membership.ts`
- `runtime/ts/src/network/nats-node-link.ts`
- `runtime/ts/src/network/ws-node-link.ts`
- `runtime/ts/src/mcp/mcp-server.ts`
- `runtime/ts/src/mcp/mcp-agent-adapter.ts`
- `runtime/ts/src/mcp-gate.ts`
