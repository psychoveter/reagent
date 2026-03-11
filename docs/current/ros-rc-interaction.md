# Admin / RC Interaction

This note captures the current transitional boundary between the legacy ROS-shaped control plane and the node-local `ReagentController` runtime.

## Core Rule

`ReagentController` owns runtime truth.

That means:

- protocol invocation is decided and executed on the node-local RC
- role binding resolution comes from RC-local knowledge plus cluster-backed state
- attached `AgentRuntime` presence determines whether an agent is actually addressable

The admin layer must not become a second runtime.

## Current Shape

Today the control plane still exposes a long-lived WebSocket server implementation for compatibility.

Canonical TS paths now live under:

- `runtime/ts/src/admin/ros.ts`
- `runtime/ts/src/admin/remote-node.ts`
- `runtime/ts/src/admin/session.ts`
- `runtime/ts/src/admin/debug-controller.ts`
- `runtime/ts/src/admin/reconciler.ts`

The older `orchestrator/` namespace is now legacy compatibility surface.

## Responsibilities Split

### RC responsibilities

- host `ProtocolArtifacts`, `AgentTemplate`, `AgentRecord`, `AgentRuntime`, and `ProtocolInstance`
- attach and detach runtimes
- route envelopes
- resolve role bindings
- invoke protocols
- surface inspectable local runtime state

### Admin responsibilities

- accept control-plane requests from tools
- compile source for local debug/run workflows
- aggregate cluster inspection views
- forward deploy / trigger / inspect / debug commands to the correct node
- coordinate debug UX across nodes
- compute desired-vs-actual reconciliation plans

## Trigger Flow

The intended cluster trigger flow is:

1. A tool such as `rgctl` issues an admin request.
2. The admin layer identifies the initiator node.
3. The request is forwarded to the owning node host.
4. The node-local RC invokes the protocol.
5. Runtime message delivery proceeds RC-to-RC, not through the admin layer.

## Deploy Flow

Deploy should be understood as preparing runtime capability, not forcing immediate execution.

The normal order is:

1. deploy `ProtocolArtifacts`
2. deploy `AgentTemplate`
3. create `AgentRecord` if needed
4. attach `AgentRuntime` when a real executor/client/process is present
5. only then consider the agent addressable

This is why the admin layer must not assume that "deployed" means "running".

## `rgctl` Direction

`reagent-rgctl` is the tool-facing direction for cluster administration.

Current state:

- `runtime/ts/src/rgctl.ts` is the CLI entrypoint
- `runtime/ts/src/admin/ws-admin-client.ts` is the shared client transport
- the client still talks to the legacy WebSocket server shape underneath

Target state:

- `rgctl` should speak an explicit cluster/admin API
- the API should be reusable by IDE tooling and automation
- the old ROS naming should become compatibility-only terminology
