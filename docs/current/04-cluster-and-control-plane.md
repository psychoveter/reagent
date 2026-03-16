# Cluster And Control Plane

This document describes the current boundary between the node-local runtime and the cluster control plane in Reagent.

The canonical control-plane API is `AdminClient`, backed by `StateStore` and per-node control endpoints.

## 1. Architecture Summary

Reagent is split into three layers:

- node-local execution in `ReagentController`
- shared cluster truth in `StateStore`
- tool-facing control operations through `AdminClient`

The critical current rule is:

**RC owns runtime execution. `AdminClient` owns control-plane access. Shared cluster truth lives in `StateStore`.**

That means:

- protocol execution starts on the node that owns the initiator
- runtime routing is RC-to-RC via loopback or `NodeLink`
- cluster discovery and addressability come from `StateStore` and membership
- tools do not need a central always-on orchestrator to deploy, inspect, or trigger a cluster

## 2. Current Source Layout

Relevant TypeScript source areas:

| Area | Path | Purpose |
|---|---|---|
| Runtime core | `runtime/ts/src/controller/`, `core/`, `nodes/`, `triggers/` | Node-local protocol execution and agent hosting |
| Cluster infrastructure | `runtime/ts/src/cluster/` | State store, membership, leader election, runtime bootstrap |
| Message plane | `runtime/ts/src/network/` | `NodeLink` implementations |
| Control plane | `runtime/ts/src/admin/` | `AdminClient`, node endpoint client/server, endpoint resolver |
| MCP integration | `runtime/ts/src/nodes/mcp/` | MCP adapter and MCP server |
| Runnable hosts | `runtime/ts/src/nodes/mcp/mcp-gate.ts`, `runtime/ts/src/nodes/claude/claude-node.ts` | Real host entrypoints that embed RCs |

## 3. Shared Cluster Truth

### State store

Cluster state is abstracted through `StateStore`.

Current implementations:

- `InMemoryStateStore`
- `EtcdStateStore`

The state store is the canonical shared truth for:

- node registrations
- agent registrations
- endpoint discovery inputs
- cluster-visible lifecycle state

This is the main architectural shift away from a central orchestrator keeping the authoritative in-memory view.

### Agent registry

Cluster-backed agent presence flows through `StateStoreAgentRegistry`, not through a centralized process map.

Practical consequence:

- tools can list agents from shared state
- node startup can hydrate awareness from shared state
- resolution does not depend on a central server already having seen every node
- trigger-level resolve policies can match against cluster-visible agent metadata (`tags`, `capabilities`, `labels`) rather than only node-local process inventory

Current boundary:

- shared state currently covers agent presence and metadata
- controller-local evaluator state such as `roundRobin` cursors is not yet persisted as cluster-shared policy state

### Protocol run records

Protocol process state is persisted in the state store under the `/protocol-runs/` prefix.

Each running or terminal protocol has a `ProtocolRunRecord` at `/protocol-runs/{instanceId}` (JSON, CAS-updated). Records track:

- home RC (`homeNodeId`), lifecycle status, supervision strategy
- participant roles, parent/child lineage, spawned-agent ownership
- cancellation state and participant-loss history

The `compareAndSwap()` primitive on `StateStore` provides atomic ownership transfer during orphan adoption: exactly one surviving RC wins a CAS race to claim an orphaned record.

These records are the cluster-visible foundation for the process model described in `03-runtime-core.md §9`.

### Membership

`EtcdMembership` provides:

- node presence
- remote agent discovery
- leave callbacks
- **RC failure detection** for orphan adoption — when a node's lease expires, surviving RCs receive a watch notification and scan `/protocol-runs/` for orphaned entries homed on the dead node (see `03-runtime-core.md §9.8`)

Membership is runtime-facing infrastructure. It supports routing, discovery, and supervision, not just admin UX.

### Leader election

`LeaderElection` is used for singleton cluster behaviors such as cron leadership.

### Runtime bootstrap

`runtime/ts/src/cluster/runtime-bootstrap.ts` centralizes host-side infrastructure bootstrap from `RuntimeConfig`.

This matters because hosts such as `mcp-gate` and live-agent wrappers should consume declarative runtime config rather than each hand-building cluster wiring ad hoc.

## 4. Message Plane vs Control Plane

The message plane is based on `NodeLink`.

Current implementations:

- `InMemoryNodeLink`
- `WsNodeLink`
- `NatsNodeLink`

These are runtime delivery mechanisms. They are not the control plane.

The distinction is:

- message plane: runtime envelopes between RCs
- control plane: deploy, trigger, inspect, and stop operations addressed to nodes

In the current architecture:

- RC routes messages by agent name and node ownership
- tools use `AdminClient`
- `AdminClient` resolves nodes from shared state and talks to node control endpoints

## 5. The Control Plane Model

### `AdminClient`

`runtime/ts/src/admin/client.ts` is the canonical tool-facing API.

It supports two modes:

- state-store-backed mode, which is the canonical architecture
- legacy WebSocket RAP mode, which remains as a compatibility path for workflows not yet migrated

In state-store-backed mode, `AdminClient`:

- lists node registrations from `StateStore`
- resolves target nodes using `StoreBackedNodeEndpointResolver`
- sends imperative operations through `NodeControlClient`

This is the current cluster control-plane shape.

### Per-node control endpoints

Each runnable node host may expose a `NodeControlEndpoint`.

The pair is:

- `NodeControlEndpoint` — per-node server
- `NodeControlClient` — tool-side client

This is how imperative control is meant to work in the non-legacy architecture:

- deploy to a node
- trigger on the node that owns an agent
- inspect a specific node
- stop a specific agent

### Endpoint resolution

Node lookup is not hardcoded in tools.

Instead:

- node registration is stored in `StateStore`
- control endpoint URLs are stored with node registration
- `StoreBackedNodeEndpointResolver` finds the right node or agent owner

This removes the need for a central admin host to proxy every operation.

## 6. What Is Still Legacy

Not every control-plane path is fully migrated yet.

Today, `AdminClient` still exposes a legacy compatibility path through `legacyAdminUrl`.

When `stateStoreProvider` is absent, methods fall back to WebSocket RAP requests such as:

- `Compile`
- `DeployProject`
- `TriggerOnCluster`
- `NodeInspect`
- `ClusterStatus`
- `ListProtocols`
- `ListAgents`
- `StopAgent`
- `GetDeployedIR`
- debug commands

This means the current reality is:

- **canonical architecture**: `AdminClient` + `StateStore` + `NodeControlEndpoint`
- **compatibility path**: legacy RAP/WebSocket admin transport

The compatibility path should be described as transitional, not as the target design.

## 7. Runtime Hosts

A host is any runnable process that embeds an RC and translates process-level config into runtime wiring.

Examples:

- `mcp-gate`
- Claude live-agent wrapper
- test bootstraps
- future node kinds that embed `RuntimeConfig`

### `mcp-gate`

`mcp-gate` is the main MCP-facing runtime host.

Current role:

- host a node-local RC
- expose runtime participation to an external MCP client
- bootstrap cluster state and message-plane wiring from `RuntimeConfig`
- attach MCP-driven custom-agent behavior through `McpAgentAdapter`
- participate in cluster routing through membership and `NodeLink`

`mcp-gate` should be understood as a runtime host first, not as a thin proxy to a central admin server.

### Claude node host

`runtime/ts/src/nodes/claude/claude-node.ts` is a standalone host for Claude-backed nodes.

It bootstraps a `ReagentController` directly in-process and registers a `ClaudeBehaviorFactory` — an `AgentBehavior` implementation that calls the Claude API via `handle()`. No MCP child process or polling loop; protocol events are handled synchronously inside the behavior.

The host reads a node wrapper config containing:

- runtime config (embedded `RuntimeConfig`)
- agent name and roles
- Claude SDK options (model, tools, MCP servers, permission mode)

This keeps the core runtime config provider-neutral while the Claude-specific settings stay in the wrapper.

## 8. Deploy Flow

In the canonical architecture, deploy is node-directed, not centrally executed.

Current intended flow:

1. A tool builds deployment artifacts.
2. `AdminClient` reads node registrations from `StateStore`.
3. `AdminClient` sends `DeployProject` to node control endpoints.
4. Each node installs protocol artifacts and agent state locally in its RC.
5. Shared cluster state reflects agent presence and ownership.

In the current compatibility path, deploy may still go through legacy RAP transport.

What matters architecturally is that deploy is node-directed: each node receives and installs its own artifacts.

## 9. Trigger Flow

Current intended cluster trigger flow:

1. A tool calls `AdminClient.triggerProtocol(...)`.
2. `AdminClient` resolves the owning node for the initiator agent.
3. `AdminClient` talks directly to that node's control endpoint.
4. The node-local RC invokes the protocol locally.
5. Participant resolution uses cluster-backed runtime state, not a central startup map.

Important runtime ontology:

- deploy can create logical agent presence and install protocol artifacts
- trigger should target an agent that is actually attached and reachable
- control plane must not assume that "deployed" automatically means "runtime attached"

## 10. Inspect And Cluster Status

Inspect is now conceptually two-layered:

- shared-state query for broad cluster truth
- direct node inspection for deep local runtime detail

`AdminClient.clusterStatus()` in state-store-backed mode already follows this shape:

- nodes come from `StateStore`
- agents come from `StateStore`
- protocol details are aggregated by inspecting node endpoints

`AdminClient.inspectNode(nodeId)` resolves a node endpoint and asks that node directly.

`AdminClient` also exposes protocol run surfaces:

- **list protocol runs** — returns all durable `ProtocolRunRecord`s, including those in `cancelling` state
- **inspect protocol run** — returns the record plus parent and child relationships
- **cancel protocol run** — initiates distributed cancellation convergence (see `03-runtime-core.md §9.7`)

This is the current control-plane model.

## 11. Debug

Debug remains the least migrated part of the control plane.

Today:

- debug commands in `AdminClient` still go through the legacy `send(...)` path
- some extension/debug UX still assumes legacy admin transport

So the accurate current statement is:

- deploy/trigger/inspect/list/stop are moving to the `AdminClient` + node-endpoint model
- debug is still partially tied to the legacy transport path

This should be documented explicitly.

## 12. Runtime Config Boundary

The runtime config boundary matters most for cluster-capable hosts.

`RuntimeConfig` should describe only node-local runtime concerns:

- node identity
- state store backend
- membership
- message plane
- telemetry
- control endpoint settings
- trigger policy defaults

Imperative host code should provide:

- concrete `AgentNode` instances
- host-specific adapters
- MCP or external agent integration
- process lifecycle

`RuntimeConfig` should not be repurposed for Claude-specific or tool-specific launch settings.
Those belong in wrapper configs around the runtime config.

## 13. Python Runtime Asymmetry

The TypeScript runtime and control-plane layers were reorganized to match the current architecture.
The Python runtime was not.

Practical consequence:

- this file describes the current TypeScript control-plane model
- Python support may mirror parts of the behavior, but not the structure or file layout

Do not assume path parity between `runtime/ts/` and `runtime/py/`.

## 14. Primary Files

For the current cluster/control-plane behavior, start with:

- `runtime/ts/src/admin/client.ts`
- `runtime/ts/src/admin/node-control-client.ts`
- `runtime/ts/src/admin/node-control-endpoint.ts`
- `runtime/ts/src/admin/node-endpoint-resolver.ts`
- `runtime/ts/src/cluster/state-store.ts`
- `runtime/ts/src/cluster/state-store-agent-registry.ts`
- `runtime/ts/src/cluster/runtime-config.ts`
- `runtime/ts/src/cluster/runtime-bootstrap.ts`
- `runtime/ts/src/cluster/etcd-membership.ts`
- `runtime/ts/src/network/nats-node-link.ts`
- `runtime/ts/src/network/ws-node-link.ts`
- `runtime/ts/src/nodes/mcp/mcp-server.ts`
- `runtime/ts/src/nodes/mcp/mcp-agent-adapter.ts`
- `runtime/ts/src/nodes/mcp/mcp-gate.ts`
- `runtime/ts/src/nodes/claude/claude-node.ts`

## 15. Short Version

If you remember only one thing from this file, remember this:

**The canonical cluster control-plane architecture is `AdminClient` + `StateStore` + per-node control endpoints.**
