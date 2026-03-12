# Runtime Core

This document describes the current TypeScript runtime core and its public execution model.
It replaces the older split between `rc-spec.md`, runtime parts of `connectivity.md`, and the standalone runtime-layering note.

## 1. Runtime Boundary

The runtime core is the node-local execution layer.
It owns protocol execution, local agent lifecycle, routing, trigger evaluation, and cluster-backed resolution.

It may depend on abstractions such as `StateStore`, `NodeLink`, trace hooks, and interceptors, but it should remain usable without the control plane.

## 2. Current Source Layout

The TypeScript runtime core is now reflected directly in `runtime/ts/src`:

| Layer | Path | Responsibility |
|---|---|---|
| Contracts | `runtime/ts/src/contracts/` | Shared runtime interfaces and wire-level types |
| Core | `runtime/ts/src/core/` | Protocol execution, zone execution, agent interface model |
| Controller | `runtime/ts/src/controller/` | `ReagentController`, protocol registry, local bus, role bindings |
| Nodes | `runtime/ts/src/nodes/` | `AgentNode` implementations for managed, custom, Python, and gate-backed agents |
| Triggers | `runtime/ts/src/triggers/` | Trigger matching, trigger policy, cron, resolve policy |
| Network | `runtime/ts/src/network/` | `NodeLink` implementations and transport compatibility |
| Cluster | `runtime/ts/src/cluster/` | State store, membership, leader election, runtime bootstrap |

## 3. Main Runtime Objects

### `ReagentController`

`ReagentController` is the per-node runtime core.

Responsibilities:

- register local agents and their graphs
- maintain the local routing table
- create per-agent transports
- route envelopes through loopback or `NodeLink`
- manage message interceptors
- expose protocol registry and node inspection
- host the trigger subsystem
- use cluster-backed agent state to resolve initiators and role bindings

Important current properties:

- One RC per node process.
- RC startup loads agent state from the configured `StateStore` when present.
- `invokeProtocol()` is a node-local runtime entry point.
- distributed runtime startup is handled by each node's RC, not a centralized server.

### `ProtocolRegistry`

The registry is the node-local knowledge plane for deployed protocols.

It tracks:

- protocol name and version
- fingerprints and dependencies
- role graphs
- trigger metadata
- reverse bindings from protocol to agent names

The registry is used by:

- trigger matching
- compatibility checks
- local introspection
- local protocol invocation

### `ProtocolInstance`

`ProtocolInstance` remains the managed execution wrapper around a compiled role graph.

It owns:

- per-instance `$ctx`
- message send/receive progression
- invoke/spawn/return/break integration
- zone execution via the zone executor
- trace emission hooks

Role-to-agent lookup now accepts a generalized role-binding source rather than assuming a flat map only.

### `ProtocolEngine`

`ProtocolEngine` is the pure state-machine walker used primarily by the custom-agent path.
It is transport-agnostic and does not own RC routing.

### `AgentRunner`

`AgentRunner` is the managed-agent host.

It owns:

- persistent `$self`
- lifecycle handlers
- local instance map
- managed `ProtocolInstance` creation

Current behavior worth calling out:

- receive-side lazy materialization is implemented
- a role can begin participating when the first inbound message arrives
- protocol startup happens locally, not via a centralized fanout path

### `AgentNode`

`AgentNode` is the host/runtime abstraction used by RC.
Current TS runtime implementations live in `runtime/ts/src/nodes/`:

- `NativeAgentNode`
- `CustomAgentNode`
- `PythonAgentNode`
- `MessageGateNode`

This keeps RC agnostic to whether behavior is managed, custom, Python subprocess-backed, or gate-backed.

## 4. Routing Model

### Core types

The routing contract lives in `runtime/ts/src/contracts/`:

- `types.ts`
- `transport.ts`
- `agent-node.ts`
- `interceptor.ts`

Key abstractions:

- `MessageEnvelope`
- `NodeRef`
- `AgentRef`
- `ReagentTransport`
- `NodeLink`
- `AgentNode`
- `AgentHandle`

### Delivery rules

- Local agents route through RC loopback.
- Remote agents route through a `NodeRef` backed by a `NodeLink`.
- Every message passes through interceptors with direction `loopback`, `outbound`, or `inbound`.
- RC routes by target agent name, not by subjects or topics.

## 5. Role Binding And Resolution

Role binding support now lives explicitly in `runtime/ts/src/controller/role-bindings.ts`.

Supported forms:

- flat maps
- protocol-qualified role bindings
- resolver functions

Current runtime consequences:

- RC can resolve a protocol initiator from cluster-backed registry state
- RC can synthesize a `roleToAgent` map for local invocation
- nodes can override or merge role bindings locally without a cluster-global map

This is a key architectural change from the older model.

## 6. Trigger Subsystem

The trigger subsystem is part of the runtime core, not the control plane.

Current parts:

- `LocalEventBus`
- `CronAgent`
- `TriggerMatcher`
- `ResolvePolicyEvaluator`
- `TriggerPolicy`

Location:

- `runtime/ts/src/controller/local-event-bus.ts`
- `runtime/ts/src/triggers/cron-agent.ts`
- `runtime/ts/src/triggers/trigger-matcher.ts`
- `runtime/ts/src/triggers/resolve-policy-evaluator.ts`
- `runtime/ts/src/triggers/trigger-policy.ts`

Current behavior:

- invoke, event, and cron triggers are registered from protocol metadata
- trigger firing can use cluster-backed dedup and leader coordination when the state store provides it
- participant resolution is no longer implicitly "first matching local agent only"

## 7. Cluster-Aware Runtime State

The runtime core can operate without cluster infrastructure, but it is now designed to benefit from it directly.

Current cluster-facing runtime pieces:

- `StateStore`
- `InMemoryStateStore`
- `EtcdStateStore`
- `StateStoreAgentRegistry`
- `EtcdMembership`
- `LeaderElection`

They live in `runtime/ts/src/cluster/`.

### What cluster state changes

With a configured cluster state backend, RC can:

- learn existing agent registrations on startup
- resolve protocol roles against node-local and remote registrations
- support cron singleton leadership
- support membership-driven remote agent discovery

Protocol launch is a node-local RC responsibility, not a centralized server concern.

## 8. Managed, Custom, Python, And Gate Hosts

### Managed agents

`NativeAgentNode` wraps `AgentRunner` and `ProtocolInstance`.

### Custom agents

`CustomAgentNode` wraps `ProtocolEngine` plus a user `AgentInterface`.
It also supports receive-side lazy engine materialization.

### Python agents

`PythonAgentNode` runs Python agents through JSON-line IPC to the Python runtime.
The Python runtime itself was not structurally reorganized in this refactor, but the TS-side node host was moved into `runtime/ts/src/nodes/`.

### Message Gate and MCP Gate

- Message Gate host logic lives in `nodes/` plus `gate/`
- MCP-facing pieces live in `mcp/`
- `mcp-gate.ts` remains a root entrypoint because it is a runnable host, not just a library file

### RC ontology

The runtime now distinguishes several layers that older docs often collapsed:

- `ProtocolArtifacts` — compiled protocol/role payload loaded into the node
- `AgentTemplate` — create-spec that describes how an agent can be materialized
- `AgentRecord` — logical agent identity/slot in the RC and cluster state
- `AgentRuntime` — attached executor/session/runner that makes the record addressable
- `ProtocolInstance` — one live execution owned by an attached runtime

This distinction matters for cluster behavior:

- deploy can install `ProtocolArtifacts` and `AgentTemplate` without creating a live runtime
- an `AgentRecord` can exist before an agent is actually attached and ready
- routing and trigger resolution should only target records that currently have attached runtime presence
- `spawnRoleInstance()` should mean live spawn of a ready agent runtime; pure logical-slot creation belongs to lower-level record APIs

### Lifecycle entities around RC

The runtime model is easier to reason about if we separate logical records,
live runtimes, and cluster-visible presence.

The main lifecycle-bearing entities around `ReagentController` are:

- `ReagentController` itself as the node-local orchestrator
- `EtcdMembership` and the leased `/nodes/{nodeId}` presence record
- `AgentRecord` as logical agent identity tracked by the controller
- `AgentRuntime` / `AgentHandle` as the live attached executor
- leased `/agents/{agentName}` as live cluster-visible presence
- `ProtocolInstance` as one execution of one role graph

Secondary operational lifecycle entities also exist:

- `CronAgent`
- `NodeLink`
- spawned-agent sets tracked per protocol instance

#### `ReagentController`

`ReagentController` has an operational lifecycle even though it does not expose a
formal status enum. The important transitions are `startMembership()`,
`start()`, and `stop()`.

```mermaid
stateDiagram-v2
    [*] --> Constructed
    Constructed --> MembershipStarted: startMembership()
    Constructed --> Running: start()
    MembershipStarted --> Running: start()
    Running --> Running: deploy/create/invoke/addNodeLink
    Running --> Stopping: stop()
    MembershipStarted --> Stopping: stop()
    Stopping --> Stopped: cron stopped\nmembership stopped\nagent handles stopped\nlinks closed
    Stopped --> [*]
```

#### Node presence: `EtcdMembership` and `/nodes/{nodeId}`

Cluster-visible node presence is lease-based. A node is considered live only
while its membership lease is alive.

```mermaid
stateDiagram-v2
    [*] --> Inactive
    Inactive --> LeaseGranted: start()
    LeaseGranted --> Published: put /nodes/{nodeId} with lease
    Published --> Alive: keepAlive loop running
    Alive --> Alive: updateNodeMetadata()
    Alive --> Stopping: stop()
    Stopping --> Revoked: lease.revoke()
    Revoked --> Inactive: /nodes key deleted
```

#### Logical agent identity: `AgentRecord`

`AgentRecord` is the controller's logical view of an agent slot. It can exist
before any live runtime is attached.

```mermaid
stateDiagram-v2
    [*] --> Declared: createAgentRecord()
    Declared --> RuntimeAttached: attachAgentRuntime()
    RuntimeAttached --> Ready: markAgentRuntimeReady()
    RuntimeAttached --> Detached: detachAgentRuntime()
    Ready --> Detached: detachAgentRuntime()
    Detached --> RuntimeAttached: createAgentFromTemplate()/reattach
    Declared --> Destroyed: destroyAgentRecord()
    Detached --> Destroyed: destroyAgentRecord()
    Ready --> Destroyed: destroyAgent()
    Destroyed --> [*]
```

This is intentionally distinct from cluster-visible liveness. A declared or
detached `AgentRecord` does not imply that `/agents/{agentName}` exists.

#### Live runtime: `AgentRuntime` / `AgentHandle`

The runtime embodiment of an agent is created by an `AgentNode` and tracked by
RC through an `AgentHandle`. This is the layer that makes the record
addressable.

```mermaid
stateDiagram-v2
    [*] --> Created: createAgentFromTemplate()
    Created --> Attached: attachAgentRuntime()
    Attached --> Ready: handle.start() + markAgentRuntimeReady()
    Attached --> Detached: detachAgentRuntime()
    Ready --> Detached: detachAgentRuntime()
    Attached --> Stopped: rc.stop() / handle.stop()
    Ready --> Stopped: rc.stop() / handle.stop()
    Stopped --> [*]
```

In the managed path this runtime is usually `AgentRunner`; in the custom path it
is `CustomAgentHandle` with one or more `ProtocolEngine` instances.

#### Live cluster-visible presence: `/agents/{agentName}`

The `/agents/` keyspace is live presence, not durable inventory. Presence is
published only for addressable attached/ready runtimes and is tied to the node
lease.

```mermaid
stateDiagram-v2
    [*] --> Absent
    Absent --> Published: runtime_attached / ready
    Published --> Refreshed: markAgentRuntimeReady()\npublishAgentPresence()
    Refreshed --> Published
    Published --> Absent: detachAgentRuntime()
    Published --> Absent: rc.stop()
    Published --> Absent: node lease revoked
```

This is the cluster-facing lifecycle that remote resolution and membership
watches care about.

#### `ProtocolInstance`

`ProtocolInstance` is the lifecycle of one concrete execution of one role graph.

```mermaid
stateDiagram-v2
    [*] --> Created: new ProtocolInstance(...)
    Created --> Running: run()
    Running --> Running: advance()\nsend/receive/action/guard\ninvoke/spawn/scatter
    Running --> Completed: terminal(status=completed)
    Running --> Failed: terminal(status=error)
    Running --> Failed: fatal exception
    Completed --> [*]
    Failed --> [*]
```

Instances are typically created by `AgentRunner` either from an explicit
trigger/invocation or by receive-side lazy materialization when the first
message arrives.

#### `AgentRunner`

`AgentRunner` is the managed runtime host for one agent. It owns persistent
`$self`, lifecycle handlers, and the map of active/completed `ProtocolInstance`
objects.

```mermaid
stateDiagram-v2
    [*] --> Constructed
    Constructed --> Started: start()
    Started --> Started: triggerProtocol()
    Started --> Started: materialize receive-side instance
    Started --> Started: instance completion callbacks
    Started --> Stopped: stop()
    Stopped --> [*]
```

`AgentRunner` is coarse-grained lifecycle-wise; most execution detail lives in
the child `ProtocolInstance` objects it creates and observes.

#### Secondary operational entities

These have real lifecycle too, but they are supporting infrastructure rather
than the primary RC ontology:

- `CronAgent`: idle -> started -> ticking -> stopped
- `NodeLink`: added -> connected -> active routing -> closed
- spawned agents: requested -> declared -> attached -> ready -> cleaned up or persisted

Together these layers explain why the runtime distinguishes:

- logical declaration (`AgentRecord`)
- live execution (`AgentRuntime`)
- cluster-visible liveness (`/agents/*`)
- node-visible liveness (`/nodes/*`)
- per-run execution (`ProtocolInstance`)

## 9. Runtime Config Boundary

The runtime config boundary is now explicit.

Declarative runtime config should describe:

- node identity
- state store backend
- membership settings
- message-plane backend
- telemetry settings
- trigger policy defaults

In code, this boundary lives in:

- `runtime/ts/src/cluster/runtime-config.ts`
- `runtime/ts/src/cluster/runtime-bootstrap.ts`

This config is intentionally about the node-local RC host only.
It should not be extended with Claude-specific or other external agent-runner
settings.

Imperative host code should provide:

- concrete `AgentNode` instances
- host-specific callbacks
- control-plane transport connections
- process lifecycle integration

When a node is launched through an external live-agent wrapper, the wrapper
config should embed `RuntimeConfig` rather than mutate its meaning. In the
current Claude path, the UX-facing launch file is a wrapper config of the form:

- `kind: "claude_live_agent_node"`
- `runtime: RuntimeConfig`
- `agent: { name, roles }`
- `claude: { ...Claude SDK settings... }`

That wrapper is a launch artifact for a specific node kind. It is not part of
the core RC runtime model itself.

## 10. What Changed Relative To Older Docs

- RC now owns local protocol invocation through `invokeProtocol()`.
- cluster state is part of runtime behavior, not just an orchestration side-channel.
- receive-side instance materialization is implemented in both managed and custom paths.
- `AgentRecord` and `AgentRuntime` are now separate concepts in the TS runtime model.
- the TS runtime filesystem now matches the architecture described here.
- the Python runtime remains implemented but structurally asymmetric relative to TS.

## 11. Primary Files

For the current runtime core, start with:

- `runtime/ts/src/controller/reagent-controller.ts`
- `runtime/ts/src/controller/protocol-registry.ts`
- `runtime/ts/src/controller/role-bindings.ts`
- `runtime/ts/src/core/agent-runner.ts`
- `runtime/ts/src/core/protocol-instance.ts`
- `runtime/ts/src/core/protocol-engine.ts`
- `runtime/ts/src/nodes/native-agent-node.ts`
- `runtime/ts/src/nodes/custom-agent-node.ts`
- `runtime/ts/src/triggers/trigger-matcher.ts`
- `runtime/ts/src/cluster/runtime-config.ts`
- `runtime/ts/src/cluster/runtime-bootstrap.ts`
