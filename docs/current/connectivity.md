# Reagent Connectivity Layer

Version: 3.0
Date: 2026-03-08
Status: Implemented (M5-CTRL)

---

## 1. Overview

The Reagent connectivity layer decouples the runtime from any specific transport, enables multi-agent nodes, local routing, and a pluggable interceptor chain.

### Design principles

1. **No separate messaging layer**: agents communicate via `AgentRef` — the single addressing primitive everywhere. There is no pub/sub transport underneath; inter-node communication uses thin `NodeLink` pipes that carry envelopes. Reagent is the messaging system.
2. **Multi-agent nodes**: a single process hosts multiple named agents. Agents can be created statically at startup or dynamically during protocol execution (spawn).
3. **Loopback routing**: messages between co-located agents bypass the network while still passing through the interceptor chain.
4. **Multi-level interception**: message-level interceptors observe agent-to-agent traffic; agent-level trace hooks observe internal state machine events. Both are configurable per deployment.
5. **Scoped agent identity**: agents are identified as `nodeId/agentName`, enabling multiple nodes to coexist without name collisions.
6. **Platform abstraction**: the `ReagentController` delegates agent creation to an opaque `AgentNode` that knows how to map IR to its hidden agent runtime. The RC knows nothing about agent internals.
7. **Self-describing infrastructure**: Reagent's own infrastructure (tracing, debug, orchestration) can be described as Reagent protocols with dedicated agents, not as a separate hidden system.

### Implementation status

All M5-CTRL targets are implemented:

**Interfaces and types**: `NodeRef`, `AgentRef`, `ReagentTransport`, `NodeLink` in `transport.ts`; `AgentNode`, `AgentHandle` in `agent-node.ts`; `InterceptorFn`, `InterceptorContext` in `interceptor.ts`; `AddressPage` type defined.

**Core components**: `ReagentController` (agent registry, routing table, `NodeRef`/`AgentRef` factory, interceptor chain, `NodeLink` management, `createTransport()`, `triggerProtocol()`, `applyAddressPage()`, `startMembership()`); `NativeAgentNode` wrapping `AgentRunner` as `AgentHandle`; `InMemoryNodeLink` for in-process envelope dispatch; `NatsNodeLink` for inter-node NATS transport.

**Runtime**: `ProtocolInstance` uses `ReagentTransport`; `AgentRunner` accepts `ReagentTransport` in config; `roleToAgent` loaded by `AgentRunner`.

**Single-node mode**: all E2E tests pass using `ReagentController` + `NativeAgentNode` + loopback (no NATS, no `NodeLink`). Single-node startup from `deployment.json` (no `nodes` section) is backward compatible.

**Multi-node mode**: routing table populated via etcd-based membership (`EtcdMembership`) or static `AddressPage`.

**Multi-AgentNode per RC**: both TS and Python RCs support multiple `AgentNode` backends keyed by language.

**Cluster infrastructure**: `EtcdManager`, `EtcdStateStore`, `EtcdMembership`, `LeaderElection`, `bootstrapCluster()` — etcd-based node presence, agent discovery, cron leader election, and trigger deduplication.

**E2E test coverage**: C1–C11 (connectivity), GT.1–GT.8 (Message Gate), etcd-state-store (14 tests), etcd-cluster (8 tests).

**Remaining deferred items**:
- Delivery guarantees / retries.
- Cross-agent spawn (case b in §6.3).
- Debug/telemetry/RAP interceptors (only test spy implemented).
- Cross-node event routing (EventHubAgent).

---

## 2. Core concepts

### 2.1 Addressing: NodeRef and AgentRef

The addressing model has two levels:

**NodeRef** — a reference to a remote node. Created by the RC from `NodeLink` metadata. It knows how to deliver an envelope to that node.

```typescript
interface NodeRef {
  readonly nodeId: string;
  send(envelope: MessageEnvelope): void;
}
```

For local delivery, the RC uses a built-in loopback `NodeRef` (direct dispatch, no serialization). For remote delivery, the `NodeRef` wraps a `NodeLink`.

**AgentRef** — a reference to a specific agent. This is the primary addressing primitive in Reagent — the equivalent of Akka's `ActorRef`. It composes a `NodeRef` with an agent name.

```typescript
interface AgentRef {
  readonly agentName: string;
  readonly nodeRef: NodeRef;

  /** Send a message to this agent. Constructs the envelope and routes through the RC. */
  send(messageName: string, payload: Record<string, unknown>): void;

  /** Send a pre-built envelope. */
  sendEnvelope(envelope: MessageEnvelope): void;
}
```

`AgentRef` is used everywhere agents address each other. `ProtocolInstance` resolves `roleToAgent` to get an agent name, then gets an `AgentRef` from its transport, and sends through it. The ref carries protocol context (source agent, protocol instance) so the caller doesn't construct envelopes manually:

```typescript
// ProtocolInstance resolves role to ref once:
const handlerRef = this.transport.ref(roleToAgent["Proto.handler"]);

// Sends build the envelope automatically (from, to, instanceId, ts, idempotencyKey):
handlerRef.send("SubmitTask", { taskId: 42 });
```

The `send(messageName, payload)` convenience constructs a `MessageEnvelope` using:
- `from`: the owning agent's identity (baked into the transport at creation time)
- `to`: `{ agent: ref.agentName, role: ... }` (role resolved from context)
- `instanceId`, `ts`, `idempotencyKey`: from the protocol instance context

For raw envelope forwarding (interceptors, infrastructure), `sendEnvelope()` passes through without modification.

**ReagentTransport** — the per-agent context provided by the RC. Used to obtain `AgentRef`s and to receive inbound messages.

```typescript
interface ReagentTransport {
  /** The identity of the agent this transport belongs to. */
  readonly agentName: string;

  /** Get a ref to another agent. The RC resolves local vs. remote. */
  ref(agentName: string): AgentRef;

  /** Register a handler for inbound messages addressed to this agent. */
  onMessage(handler: (envelope: MessageEnvelope) => void): void;
}
```

### 2.2 NodeLink (inter-node pipe)

There is no `WireTransport` abstraction with its own publish/subscribe semantics. Reagent already defines how agents communicate — there is no reason to reinvent a second messaging system underneath.

The RC uses **NodeLinks** — thin, bidirectional pipes between nodes that carry `MessageEnvelope`s. A `NodeLink` is not a messaging system; it is a connection. It serializes envelopes, sends bytes, receives bytes, deserializes envelopes. No subjects, no subscriptions, no routing logic — just a pipe.

```typescript
interface NodeLink {
  readonly remoteNodeId: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  send(envelope: MessageEnvelope): void;
  onEnvelope(handler: (envelope: MessageEnvelope) => void): void;
}
```

Implementations are physical transports:

| Implementation | Backing | Status |
|---|---|---|
| `NatsNodeLink` | NATS — single subject per node-pair (`reagent.node.{nodeId}`) | Implemented |
| `WsNodeLink` | WebSocket (client/server modes) | Implemented |
| `TcpNodeLink` | Raw TCP socket | Planned |
| `InMemoryNodeLink` | In-process (for tests, single-process multi-node) | Implemented |

The RC wraps each `NodeLink` into a `NodeRef`. When a remote `AgentRef.send()` fires, the envelope flows through the RC's interceptor chain and then through the `NodeRef` (which delegates to the `NodeLink`). On the receiving end, the remote RC's `link.onEnvelope()` fires, it runs inbound interceptors, and dispatches to the local agent.

**Loopback** remains a routing decision inside the RC. When the target agent is local, the RC dispatches directly (same object reference, no serialization). The loopback `NodeRef` is a built-in that delivers without any `NodeLink`.

**Infrastructure traffic** (traces, events, triggers) is also carried as envelopes — either to dedicated infrastructure agents or to external observers via a `NodeLink`. The interceptor chain can emit trace envelopes to a trace collector agent, which itself participates in a Reagent protocol.

### 2.3 ReagentController (RC)

The **ReagentController** is the routing and interception core. There is **one RC per node process**.

The RC does **not** know how to create agents, interpret IR, or run protocol state machines. It is purely infrastructure. Agent creation is delegated to the `AgentNode` (see §2.4).

Responsibilities:
1. **Agent registry**: knows which agents live on this node.
2. **Transport factory**: each agent gets a `ReagentTransport` instance. The transport's `ref(name)` returns an `AgentRef` backed by the appropriate `NodeRef` (loopback or remote). The transport's `onMessage()` registers the agent for inbound delivery.
3. **AgentRef and NodeRef creation**: when `ref(agentName)` is called, the RC looks up the target in its routing table, finds the `NodeRef` (loopback or remote), and creates an `AgentRef` composing that `NodeRef` with the agent name. The ref routes through the interceptor chain on send.
4. **NodeLink management**: the RC maintains `NodeLink`s — one per connected remote node — and wraps each in a `NodeRef`. When an envelope arrives on a link, the RC runs the inbound interceptor chain and dispatches to the local target agent.
5. **Routing table**: maps `agentName → NodeRef`. Local agents map to the loopback `NodeRef`. Remote agents map to the `NodeRef` wrapping the appropriate `NodeLink`. Populated from the deployment plan or via address pages (see §10).
6. **Interceptor chain**: manages an ordered list of message-level interceptors. Every message (local or remote, inbound or outbound) passes through.
7. **Lifecycle**: owns `NodeLink` connections (`connect`/`close`) and agent start/stop ordering.

### 2.4 AgentNode (platform abstraction)

The **AgentNode** is the platform-specific component that knows how to create and manage agents from IR artifacts. It is the merge of what was previously called "AgentNode" and "ReagentAdapter" — they are the same concern: mapping IR to a concrete agent runtime.

The RC receives an `AgentNode` as a dependency. When the RC needs to register or spawn an agent, it delegates to the `AgentNode`, which:
1. Loads or receives `RoleIR` + `IRGraph` artifacts.
2. Creates the agent using its internal runtime (e.g., `AgentRunner` for the native TS runtime, LangGraph for Python).
3. Returns an `AgentHandle` — an opaque interface the RC uses for message dispatch and lifecycle.

The `AgentNode` is a **plugin**. Different platforms provide different implementations:

| AgentNode implementation | Runtime | Language |
|---|---|---|
| `NativeAgentNode` | Current `AgentRunner`-based runtime | TS, Python |
| `LangGraphAgentNode` | LangGraph | Python |

```typescript
interface AgentNode {
  readonly runtimeName: string;

  createAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    transport: ReagentTransport,
  ): AgentHandle;

  destroyAgent(handle: AgentHandle): Promise<void>;
}

interface AgentHandle {
  readonly agentName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getSelf(): Record<string, unknown>;
  triggerProtocol(trigger: ProtocolTrigger): void;
  dispatchMessage(env: MessageEnvelope): void;
}
```

Note: `roleToAgent` is **not** passed to `AgentNode.createAgent()`. It is a protocol-instance-level concern (see §3.3).

For the `NativeAgentNode`, `AgentHandle` wraps the existing `AgentRunner`. The `createAgent()` instantiates an `AgentRunner` with the provided `ReagentTransport` (instead of a raw NATS URL).

### 2.5 Interception: two levels

Interception operates at two distinct levels:

#### Message-level interceptors (RC-managed)

These observe agent-to-agent `MessageEnvelope` traffic flowing through the RC. Every `AgentRef.send()` and every inbound delivery passes through this chain.

```typescript
type MessageDirection = "outbound" | "inbound" | "loopback";

interface InterceptorContext {
  envelope: MessageEnvelope;
  direction: MessageDirection;
  nodeId: string;
}

type InterceptorFn = (
  ctx: InterceptorContext,
  next: () => void,
) => void;
```

The context is minimal: the envelope already carries `from`, `to`, `messageName`, `ts`. No redundant fields. The interceptor reads source/target from `envelope.from.agent` / `envelope.to.agent`.

The chain runs in order. Each interceptor calls `next()` to pass control. If an interceptor does not call `next()`, the message is **dropped** (useful for debug breakpoints).

#### Agent-level trace hooks (ProtocolInstance-managed)

The `ProtocolInstance` emits 12 kinds of `TraceEvent` for internal state machine transitions: `ProtocolStarted`, `ActionStarted`, `ActionFinished`, `GuardEvaluated`, `TimerStarted`, `TimerFired`, `ForkStarted`, `JoinCompleted`, `ErrorCaught`, etc. These are **not** messages between agents — they are internal events within a single agent's execution.

These events flow through a **trace callback** on the `ProtocolInstance` config, not through the RC interceptor chain:

```typescript
type TraceHook = (event: TraceEvent) => void;
```

The `AgentRunner` (inside `NativeAgentNode`) provides this hook. The hook can:
- Forward trace events to a `TraceCollector` agent via an `AgentRef` (making traces part of the Reagent messaging fabric).
- Write to a local log.
- Send to an external system.

This separation is intentional: message-level interception is a routing concern (RC); agent-level tracing is a runtime concern (AgentNode/AgentRunner). Both are configurable per deployment — which interceptors and which trace hooks are active is determined by the deployment plan, not hard-coded.

Standard message-level interceptors:

| Interceptor | Purpose |
|---|---|
| `DebugInterceptor` | Breakpoints, step-through, message inspection |
| `TelemetryInterceptor` | Metrics, latency tracking, message counts |
| `RAPBridge` | Bridges the RC to the Reagent Orchestrator Server |

Standard trace hooks:

| Hook | Purpose |
|---|---|
| `TraceCollectorHook` | Forwards `TraceEvent`s to a `TraceCollector` agent via `AgentRef` |
| `LogTraceHook` | Writes trace events to local log file |

---

## 3. Agent identity and routing

### 3.1 Scoped identity

Every agent has a two-part identity:

```
nodeId / agentName
```

- `nodeId`: globally unique identifier for the node (UUID or config-assigned string).
- `agentName`: unique within the node. Matches the `agentName` from the compiled `AgentIR`.

The full qualified name `nodeId/agentName` is globally unique across the entire Reagent deployment.

### 3.2 Envelope routing (no subject scheme)

There is no subject scheme. The `MessageEnvelope` carries all routing information:

```typescript
MessageEnvelope {
  instanceId:     string
  protocolName:   string
  from:           { agent: string, role: string }   // source identity
  to:             { agent: string, role: string }    // target identity
  messageName:    string
  payload:        Record<string, unknown>
  ts:             number
  idempotencyKey: string
}
```

The RC routes by `envelope.to.agent` — it looks up the agent name in its routing table, finds the `NodeRef`, and dispatches. No subjects, no topic matching.

For NATS-backed `NatsNodeLink`, the link uses a single subject per node-pair (e.g., `reagent.node.{targetNodeId}`) rather than per-agent wildcard subscriptions. NATS is just a byte pipe.

### 3.3 roleToAgent resolution

The `roleToAgent` map (from `deployment.json`) maps `"Protocol.roleName"` to agent names (e.g., `"TsDemo.client" -> "ClientAgent"`). This is a **`ProtocolInstance`-level concern** — the RC does not know about it.

Resolution flow:
1. `ProtocolInstance` resolves `roleToAgent["Proto.roleB"]` → `"AgentB"` (using its per-instance `roleToAgent`, which can be overridden for child protocols via `reagent.invoke()` / `reagent.spawn()`).
2. `ProtocolInstance` calls `this.transport.ref("AgentB")` to get an `AgentRef`.
3. The RC creates the `AgentRef` with the appropriate `NodeRef` baked in.
4. `ProtocolInstance` calls `ref.send("MessageName", payload)`.

The RC only sees agent names. It does not know about roles or protocols.

### 3.4 Routing decision flow

```
ProtocolInstance resolves roleToAgent → agentName
  |
  v
transport.ref(agentName) → RC looks up routing table
  |
  v
agentName in local registry?
  |-- YES → AgentRef wrapping loopback NodeRef
  |          ref.send() → interceptors (loopback) → agentHandle.dispatchMessage()
  |
  |-- NO  → AgentRef wrapping remote NodeRef (backed by NodeLink)
             ref.send() → interceptors (outbound) → nodeLink.send(envelope)
             Remote RC: link.onEnvelope() → interceptors (inbound) → agentHandle.dispatchMessage()
```

### 3.5 Inbound message path (RC → agent → protocol instance)

When a message arrives (via loopback or `NodeLink`):

1. RC reads `envelope.to.agent`, finds the local `AgentHandle`.
2. RC runs inbound interceptor chain.
3. RC calls `agentHandle.dispatchMessage(envelope)`.
4. Inside `NativeAgentNode`, the `AgentRunner` demuxes by `envelope.instanceId` to the correct `ProtocolInstance`.
5. `ProtocolInstance.dispatchMessage(envelope)` resolves the waiting message promise.

The RC dispatches to the agent level. The agent (via its runtime) routes to the correct protocol instance. This is a clean separation: the RC knows agents, not protocol instances.

---

## 4. Layered architecture diagram

```
+-------------------------------------------------------------------+
|                      Compiled IR artifacts                         |
|  RoleIR + AgentIR + IRGraph + deployment.json                     |
+-----------------------------+-------------------------------------+
                              |
                              v
+-------------------------------------------------------------------+
|                    Node process (nodeId: "node-1")                 |
|                                                                   |
|  +------------------+     +-------------------+                   |
|  | ReagentController|<--->| InterceptorChain  |                   |
|  |                  |     |  - DebugIntercept |                   |
|  |  agent registry  |     |  - TelemetryHook  |                   |
|  |  routing table   |     |  - RAPBridge      |                   |
|  |  ref factory     |     +-------------------+                   |
|  +--------+---------+                                             |
|           |                                                       |
|    +------+------+                                                |
|    |             |                                                |
|    v             v                                                |
|  Loopback     NodeLinks (one per remote node)                     |
|  NodeRef      → NodeRef → NodeLink                                |
|                                                                   |
|  +------------------+                                             |
|  | AgentNode        |  (NativeAgentNode / ...)                    |
|  |  createAgent()   |                                             |
|  |  destroyAgent()  |                                             |
|  +--------+---------+                                             |
|           |                                                       |
|    +------+------+------+                                         |
|    v             v      v                                         |
|  AgentHandle:  AgentHandle: AgentHandle:                          |
|  "worker"      "disp"       "monitor"                             |
|  (AgentRunner) (AgentRunner) (AgentRunner)                        |
|    |             |      |                                         |
|    v             v      v                                         |
|  TraceHook → TraceCollector agent (via AgentRef)                  |
+-------------------------------------------------------------------+
         |                            ^
         | NodeLink (envelope pipe)   | NodeLink (envelope pipe)
         v                            |
+-------------------------------------------------------------------+
|                    Node process (nodeId: "node-2")                 |
|  +------------------+                                             |
|  | ReagentController|                                             |
|  +------------------+                                             |
|  | AgentHandle:     |                                             |
|  | "pyAgent"        |                                             |
+-------------------------------------------------------------------+
```

---

## 5. Interface definitions (TypeScript)

### 5.1 NodeRef and AgentRef

```typescript
interface NodeRef {
  readonly nodeId: string;
  send(envelope: MessageEnvelope): void;
}

interface AgentRef {
  readonly agentName: string;
  readonly nodeRef: NodeRef;

  /** Convenience: constructs envelope from protocol context and sends. */
  send(messageName: string, payload: Record<string, unknown>): void;

  /** Forwards a pre-built envelope without modification. */
  sendEnvelope(envelope: MessageEnvelope): void;
}

interface ReagentTransport {
  readonly agentName: string;
  ref(agentName: string): AgentRef;
  onMessage(handler: (envelope: MessageEnvelope) => void): void;
}
```

`AgentRef.send(messageName, payload)` is a convenience that constructs a `MessageEnvelope` using the protocol context (source agent, instance ID, timestamp, idempotency key) baked into the ref at creation time. `sendEnvelope()` passes through a pre-built envelope for infrastructure use.

**Delivery semantics**: `send()` and `sendEnvelope()` are fire-and-forget (best-effort, non-blocking). If the underlying connection has backpressure or the buffer is full, the send may silently drop. Delivery guarantees (at-least-once with retries) are a future concern — see §9 backlog.

### 5.2 NodeLink

```typescript
interface NodeLink {
  readonly remoteNodeId: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  send(envelope: MessageEnvelope): void;
  onEnvelope(handler: (envelope: MessageEnvelope) => void): void;
}
```

A thin, bidirectional envelope pipe between two node RCs. Only the RC uses `NodeLink`s. The RC wraps each link in a `NodeRef`.

**Connection asymmetry**: for TCP/WS-backed links, one side listens and the other connects. The `NodeLink` interface is symmetric (both ends call `connect()`), but the implementation decides client vs. server based on config. For NATS, both sides connect to the same broker — no asymmetry. This detail is hidden inside the `NodeLink` implementation.

### 5.3 AgentNode (platform abstraction)

```typescript
interface AgentNode {
  readonly runtimeName: string;

  createAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    transport: ReagentTransport,
  ): AgentHandle;

  destroyAgent(handle: AgentHandle): Promise<void>;
}
```

The `AgentNode` is the RC's handle to the platform. It knows how to create agents from IR. The RC calls `createAgent()` and gets back an opaque `AgentHandle`. The RC never sees inside the handle.

### 5.4 AgentHandle

```typescript
interface AgentHandle {
  readonly agentName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getSelf(): Record<string, unknown>;
  triggerProtocol(trigger: ProtocolTrigger): void;
  dispatchMessage(env: MessageEnvelope): void;
}
```

### 5.5 ReagentController

```typescript
interface ReagentControllerConfig {
  nodeId: string;
  agentNode: AgentNode;
  interceptors?: InterceptorFn[];
}

interface ReagentController {
  readonly nodeId: string;

  /** Register a local agent. RC delegates to AgentNode.createAgent(). */
  registerAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
  ): void;

  /** Dynamically spawn a local agent (e.g., during protocol execution). */
  spawnAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
  ): void;

  /** Remove an agent. */
  destroyAgent(agentName: string): Promise<void>;

  /** Check if an agent is local. */
  hasAgent(agentName: string): boolean;

  /** Add a message-level interceptor. */
  addInterceptor(interceptor: InterceptorFn): void;

  /** Add a link to a remote node. Creates a NodeRef wrapping it. */
  addNodeLink(link: NodeLink): void;

  /** Register where a remote agent lives (populate routing table). */
  registerRemoteAgent(agentName: string, remoteNodeId: string): void;

  /** Update the routing table from an address page (see §10). */
  applyAddressPage(page: AddressPage): void;

  /** Start the controller: connect NodeLinks, start all agents. */
  start(): Promise<void>;

  /** Stop everything: stop agents, close NodeLinks. */
  stop(): Promise<void>;

  /** Create a per-agent transport (ref factory + inbound handler). */
  createTransport(agentName: string): ReagentTransport;

  /** Trigger a protocol on a local agent (external entry point). */
  triggerProtocol(agentName: string, trigger: ProtocolTrigger): void;
}
```

Note: `roleToAgent` is absent from `registerAgent()`. The RC does not know about role-to-agent mapping — that is `ProtocolInstance`'s concern. The `roleToAgent` map is loaded by the `AgentRunner` (inside the `AgentNode`) when it starts a protocol instance.

### 5.6 Interceptor

```typescript
type MessageDirection = "outbound" | "inbound" | "loopback";

interface InterceptorContext {
  envelope: MessageEnvelope;
  direction: MessageDirection;
  nodeId: string;
}

type InterceptorFn = (
  ctx: InterceptorContext,
  next: () => void,
) => void;
```

Minimal context: the envelope carries source, target, timestamp. `direction` and `nodeId` are the only additions.

### 5.7 Trace hook (agent-level)

```typescript
type TraceHook = (event: TraceEvent) => void;
```

Configured per `AgentRunner` (inside `NativeAgentNode`). Not part of the RC interface — the RC doesn't know about trace events.

### 5.8 Address page

```typescript
interface AddressPage {
  /** Which node produced this page. */
  sourceNodeId: string;
  /** Agent-to-node mappings known by the source. */
  agents: Array<{ agentName: string; nodeId: string }>;
  /** Known nodes with link hints. */
  nodes: Array<{ nodeId: string; linkType: string; url?: string }>;
  /** Timestamp for staleness detection. */
  ts: number;
}
```

See §10 for how address pages are exchanged.

### 5.9 NodeConfig

Configuration for starting a node from a deployment plan.

```typescript
interface NodeConfig {
  nodeId: string;
  links: Array<{
    remoteNodeId: string;
    type: "nats" | "ws" | "tcp" | "inmemory";
    url?: string;
  }>;
  agents: Array<{
    agentName: string;
    agentIRFile: string;
    roleIRFile: string;
    graphFiles: string[];
  }>;
  interceptors?: string[];
  traceHooks?: string[];
  roleToAgent: Record<string, string>;
}
```

Note: `roleToAgent` is in `NodeConfig` because the `AgentRunner` (inside the `AgentNode`) needs it to start protocol instances. But it is **not** passed through the RC — the node startup code loads it and passes it directly to the `AgentRunner` config.

---

## 6. Message flow walkthrough

### 6.1 Remote send: Agent A on node-1 sends to Agent B on node-2

```
1. Agent A (on node-1) is running a protocol instance.
   ProtocolInstance resolves roleToAgent["Proto.roleB"] = "AgentB".
   const refB = this.transport.ref("AgentB");

2. RC looks up "AgentB" in routing table → remote NodeRef (node-2).
   RC creates AgentRef { agentName: "AgentB", nodeRef: remoteNodeRef }.

3. ProtocolInstance calls refB.send("TaskResult", { value: 42 }).
   The ref constructs a MessageEnvelope with from/to/instanceId/ts/key.

4. RC runs message-level interceptor chain (direction: "outbound"):
   - DebugInterceptor: checks breakpoints, calls next() (or blocks).
   - TelemetryInterceptor: increments counters, calls next().

5. NodeRef.send(envelope) → nodeLink.send(envelope) to node-2.

6. On node-2, the NodeLink's onEnvelope() fires on the RC.

7. RC on node-2 reads envelope.to.agent = "AgentB".
   Runs interceptor chain (direction: "inbound").

8. RC on node-2 calls agentHandle.dispatchMessage(envelope).

9. Inside AgentRunner, message is routed by envelope.instanceId
   to the correct ProtocolInstance.

10. ProtocolInstance receives the message and continues.
```

### 6.2 Local send (loopback): Agent A and Agent B on same node

```
1. ProtocolInstance on Agent A resolves roleToAgent → "AgentB".
   const refB = this.transport.ref("AgentB");

2. RC sees "AgentB" is local → AgentRef with loopback NodeRef.

3. Agent A calls refB.send("Response", { ok: true }).
   Envelope is constructed.

4. RC runs interceptor chain (direction: "loopback"):
   - All interceptors fire (debug, telemetry).

5. Loopback delivery:
   - agentHandle.dispatchMessage(envelope) directly.
   - No serialization. Same object reference (in Node.js).

6. AgentRunner demuxes by instanceId → ProtocolInstance receives.
```

Total cost: one interceptor chain pass, zero network I/O, zero serialization.

### 6.3 Spawn during protocol

```
1. Agent A's zone code calls reagent.spawn("ChildProtocol", input).

2. AgentRunner.spawnChildProtocol() is invoked.
   In the current runtime, this creates a new ProtocolInstance
   within the same AgentRunner.

3. In the new architecture, spawn has two cases:

   a) Same-agent spawn (current behavior): the child protocol runs
      within the same AgentRunner. No new agent is created.
      The child ProtocolInstance uses the same transport (same ref pool).

   b) Cross-agent spawn (future): the protocol requires a new agent.
      The AgentRunner calls up to the RC:
      rc.spawnAgent("ChildAgent", roleIR, graphs).
      The RC delegates to AgentNode.createAgent() → AgentHandle.
      The new agent is immediately routable via loopback.

4. For case (b), existing AgentRefs pointing to the new agent
   resolve at send time (lazy), or the RC updates existing refs.
```

### 6.4 External trigger entry

External triggers (e.g., from an orchestrator or CLI) enter the system via:

1. **Direct API call**: `rc.triggerProtocol("AgentName", trigger)` — used when the orchestrator runs in the same process or has a handle to the RC.
2. **Envelope over NodeLink**: the orchestrator sends a `MessageEnvelope` with a special `messageName` (e.g., `"__trigger"`) and the `ProtocolTrigger` as payload. The RC recognizes it and calls `agentHandle.triggerProtocol()`.
3. **Orchestrator as a Reagent agent**: the orchestrator itself is an agent on a node, connected via `NodeLink`. It sends trigger messages through normal `AgentRef.send()`. This is the long-term target — self-describing infrastructure.

For M5-CTRL, option 1 (direct API) is sufficient. Options 2 and 3 are elaborated in §10.

---

## 7. Implementation history

The connectivity layer was built incrementally. Each step produced a working system:

1. **Interfaces**: `NodeRef`, `AgentRef`, `ReagentTransport`, `NodeLink` (`transport.ts`); `AgentNode`, `AgentHandle` (`agent-node.ts`); `InterceptorFn`, `InterceptorContext` (`interceptor.ts`).
2. **ProtocolInstance + AgentRunner refactor**: both now use `ReagentTransport` instead of `NatsTransport`. Trace emission via `TraceHook` callback.
3. **InMemoryNodeLink**: in-process envelope dispatch for tests and single-process multi-node setups (`inmemory-node-link.ts`).
4. **ReagentController**: agent registry, routing table, per-agent `ReagentTransport` factory, interceptor chain, `NodeLink` management (`reagent-controller.ts`).
5. **NativeAgentNode**: wraps `AgentRunner` as `AgentHandle` (`native-agent-node.ts`).
6. **NatsNodeLink**: wraps a NATS connection to carry envelopes between two node RCs (`nats-node-link.ts`). `NatsTransport` is retired.
7. **E2E tests**: use `InMemoryNodeLink` for fast, NATS-free testing; integration tests use `NatsNodeLink` for full-stack validation.
8. **Etcd cluster**: `EtcdManager`, `EtcdStateStore`, `EtcdMembership`, `LeaderElection`, `bootstrapCluster()` for node presence, agent discovery, cron singleton, and trigger dedup.

---

## 8. Deployment model

### 8.1 Deployment plan extension

The current `deployment.json` gains a `nodes` section:

```json
{
  "nodes": [
    {
      "nodeId": "node-1",
      "agents": ["ClientAgent", "HandlerAgent"],
      "links": [
        { "remoteNodeId": "node-2", "type": "nats", "url": "nats://localhost:4222" }
      ]
    },
    {
      "nodeId": "node-2",
      "agents": ["MonitorAgent"],
      "links": [
        { "remoteNodeId": "node-1", "type": "nats", "url": "nats://localhost:4222" }
      ]
    }
  ],
  "agents": [
    {
      "agentName": "ClientAgent",
      "lang": "ts",
      "roleName": "ClientRole",
      "agentIRFile": "ClientAgent.agent.json",
      "roleIRFile": "ClientRole.role.json",
      "roles": [...]
    }
  ],
  "roleToAgent": { ... },
  "roles": [ ... ]
}
```

Each node declares its `links` — which remote nodes it needs to connect to and via what backing. The RC creates a `NodeLink` for each entry and wraps it in a `NodeRef`.

If `nodes` is absent, the runtime defaults to a single node containing all agents (backward compatible, all loopback).

### 8.2 Startup sequence

```
1. Read deployment.json.
2. For this node's nodeId, filter the agents and links assigned to it.
3. Create AgentNode implementation (e.g., NativeAgentNode).
4. Create ReagentController with the AgentNode.
5. For each link entry, create the appropriate NodeLink and call rc.addNodeLink(link).
6. Populate routing table from deployment plan:
   for each remote node's agents, call rc.registerRemoteAgent(agentName, remoteNodeId).
7. For each assigned agent:
   a. Load AgentIR (thin) + RoleIR + IRGraphs.
   b. Call rc.registerAgent(agentName, roleIR, graphs).
   c. RC calls agentNode.createAgent() → AgentHandle.
   d. RC creates a ReagentTransport for the agent (used by the AgentHandle internally).
   e. AgentHandle.start() is called.
8. RC connects all NodeLinks.
9. Node is ready.
```

### 8.3 Single-node shortcut

For development and testing, all agents can run on a single node:
- All agent-to-agent messages go through loopback (zero network cost).
- No `NodeLink`s are needed.
- An optional `NodeLink` can be added for observability tools or an orchestrator.
- No `nodes` section needed in deployment.json.

---

## 9. Backlog / deferred

### Delivery guarantees and protocol decorators

`AgentRef.send()` is currently fire-and-forget. For production use, at-least-once delivery with retries is needed. This should be implemented as a **protocol decorator** or **closure** — a system-level Reagent protocol that wraps user protocols with retry/ack logic. This avoids baking retry into the transport layer and keeps it composable.

Example concept:
```
// A retry wrapper defined as a Reagent protocol
protocol ReliableDelivery {
  participants: sender [*], receiver [*]
  // ... retry loop with ack/nack ...
}
```

Deferred. When implemented, it should be a standard library protocol, not a transport concern.

### Multi-AgentNode per RC ✅

A single node might host agents in different languages (e.g., TS + Python). This requires multiple `AgentNode` implementations registered with the RC (one per language). The RC would select the right `AgentNode` based on the agent's `lang` tag.

**Implemented**: both TS and Python RCs support multiple `AgentNode` backends keyed by language. TS RC: `{ ts: NativeAgentNode, py: PythonAgentNode }`. Python RC: `{ py: InprocAgentNode, ipc: IpcAgentNode }` (plus wildcard `"*"` fallback).

### Agent migration between nodes

Moving a running agent from one node to another (e.g., for load balancing). Requires state serialization and handoff. Not in scope.

### RAP as a Reagent protocol

The RAP protocol between the RC and the Reagent Orchestrator Server should itself be described as a Reagent protocol. The ROS becomes an agent (or set of agents) that the RC connects to via a `NodeLink`. Details deferred to M6-RT.

### Infrastructure protocols in Reagent

Trace collection, debug control, and telemetry can be modeled as Reagent protocols with dedicated infrastructure agents. For example, a `TraceCollector` agent that receives trace envelopes via normal `AgentRef.send()`. The trace hook emits trace events to the collector's ref. This is the "self-describing infrastructure" principle — details to be elaborated in M6-RT.

### Authentication and authorization

`NodeLink` connections are currently unauthenticated. Adding TLS, token auth, or mTLS is important for production but deferred.

### Cross-language loopback ✅

When TS and Python agents are on the same node (different OS processes), loopback requires IPC rather than in-process dispatch.

**Implemented**: TS RC uses `PythonAgentNode` (JSON-line IPC) for Python agents on the same node. Python RC uses `InprocAgentNode` for zero-cost same-process loopback, and `IpcAgentNode` for subprocess-based agents.

---

## 10. Orchestrator and node connectivity

### 10.1 Orchestrator role

The orchestrator (`orchestrator.ts`, exposed as the Reagent Orchestrator Server / ROS) is a **node launcher and coordinator**:

1. **Compile**: compiles `.rg` → IR artifacts.
2. **Plan**: reads the `nodes` section of `deployment.json` to determine which agents run on which nodes.
3. **Launch nodes**: starts local node processes (dev/test) or connects to already-running nodes via `NodeLink`.
4. **Inject triggers**: calls `rc.triggerProtocol()` on the initiator's node (direct API or via `NodeLink`).
5. **Collect results**: trace events flow to the orchestrator via trace hooks → `TraceCollector` agent → `NodeLink`.

### 10.2 Node discovery

Two discovery mechanisms are available:

**Etcd-based discovery (primary)**: nodes register in etcd via `EtcdMembership` and discover each other through watches on `/nodes/` and `/agents/` prefixes. Agent registrations include `nodeId`, so routing tables are auto-populated. See "Etcd-based Node Discovery" section for details.

**Static `AddressPage` (fallback)**: the orchestrator distributes an `AddressPage` containing the full agent→node mapping. Each node calls `rc.applyAddressPage(page)` to populate its routing table. Used for simple scripted deployments.

```typescript
interface AddressPage {
  sourceNodeId: string;
  agents: Array<{ agentName: string; nodeId: string }>;
  nodes: Array<{ nodeId: string; linkType: string; url?: string }>;
  ts: number;
}
```

### 10.3 How RCs connect to each other

The connectivity model is **hub-free, link-based**:

1. Each node is started with a `NodeConfig` that lists its `links`.
2. Each link specifies a `remoteNodeId` and connection details (`type`, `url`).
3. At startup, the RC creates a `NodeLink` for each entry and calls `connect()`.
4. Discovery populates the routing table (via etcd membership or `AddressPage`).
5. All inter-node traffic flows through `NodeLink`s — NATS is a link implementation detail, not a global bus.

For small deployments (2–5 nodes), full mesh is typical. For larger deployments, the orchestrator determines optimal link topology.

### 10.4 Future: Orchestrator as a Reagent node

Long-term, the orchestrator itself becomes a Reagent node — it runs its own RC, hosts infrastructure agents (trace collector, debug controller, deployment manager), and connects to other nodes via `NodeLink`s. Currently, the orchestrator remains a special-purpose process that uses the RC API but is not itself a full Reagent node.

---

## Appendix: Python ReagentController

The Python RC (`runtime/py/reagent_runtime/controller.py`) is a parallel implementation of the TS `ReagentController` for use cases where a pure-Python orchestrator is preferred (e.g., NMMO-style multi-agent simulations, reinforcement learning environments, Jupyter notebooks).

### Architecture

The Python RC mirrors the TS RC's core abstractions:

| TS concept | Python equivalent | Notes |
|---|---|---|
| `ReagentController` | `ReagentController` (`controller.py`) | Agent registry, routing, interceptors |
| `NativeAgentNode` | `InprocAgentNode` (`inproc_agent_node.py`) | In-process agent execution, zero serialization |
| `PythonAgentNode` | `IpcAgentNode` (`ipc_agent_node.py`) | Subprocess agent via `ipc_agent.py` |
| `ReagentTransport` | `InprocTransport` (`inproc_transport.py`) | Per-agent, routes via RC callback |
| `AgentNode` / `AgentHandle` | `AgentNode` / `AgentHandle` protocols (`agent_node.py`) | `typing.Protocol` |

### Key differences from TS RC

1. **No NodeLink abstraction**: the Python RC routes all messages through the single-process routing table. Inter-node communication (via `WsNodeLink` or similar) is not yet implemented.
2. **InprocTransport instead of ReagentTransport**: `InprocTransport` is a simpler transport that calls the RC's `_route_envelope()` directly. No `AgentRef`/`NodeRef` addressing — envelopes carry `toAgent` fields.
3. **Wildcard agent node**: `rc.add_agent_node("*", node)` registers a fallback for any language tag not explicitly mapped.
4. **No NATS dependency**: the `nats` package import is deferred (lazy) so the Python runtime works without it installed.

### Runtime enhancements (both TS and Python)

During Python RC development, several core runtime components were enhanced:

- **Message inbox buffer** (`ProtocolInstance`): messages arriving before a receiver's resolver is registered are buffered in `_message_inbox`. Without this, synchronous in-process routing (where send completes before the receiving `ProtocolInstance` registers its wait) would deadlock.
- **Invoke/spawn callbacks** (`AgentRunner`): Python `AgentRunner` now wires `invoke_callback` and `spawn_callback` on each `ProtocolInstance` so IR-level `invoke` and `spawn` states create and execute child protocol instances.
- **JS→Python zone compatibility** (`ZoneExecutor`): basic translation of JS literals and operators (`true`→`True`, `===`→`==`, `||`→`or`, `const`/`let` removal) plus built-in stubs (`Date`, `console`, `JSON`, `Math`) so compiled JS zones can execute in the Python runtime.

### E2E tests

`runtime/tests/test_py_rc.py` (6 tests, inline IR fixtures with Python-compatible zone code):

| # | Test | Constructs |
|---|---|---|
| T1 | Inproc loopback | Two inproc agents, send/receive/action |
| T2 | Inproc invoke | Parent protocol invokes child synchronously |
| T3 | Inproc spawn | Fire-and-forget child protocol |
| T4 | Inproc par | fork/join parallel branches |
| T5 | $ctx and message payload | Data passed via messages (was $flow, removed v0.0.11) |
| T6 | IPC agent | One inproc + one subprocess agent via IpcAgentNode |

`runtime/tests/test_py_rc_coverage.py` (8 tests, lang-spec gap coverage):

| # | Test | Constructs |
|---|---|---|
| T7 | Loop with guard expression | 3-iteration loop, expression guard, counter in $self |
| T8 | Timer/wait | Timer state delays 50ms |
| T9 | Alt expression-based guard | XOR dispatch by expression evaluation |
| T10 | Alt message-based XOR | Non-deciding agent uses message-wait fallback |
| T11 | try/catch | Zone throw routes to error path, ErrorCaught trace |
| T12 | reagent.break() | Break exits loop early, peer exits independently |
| T13 | protocolCompleted lifecycle | Handler fires and updates $self |
| T14 | protocolFailed lifecycle | Handler fires on zone throw (no try/catch) |

### TS coverage E2E tests

`runtime/tests/m5-coverage.test.ts` (10 tests, lang-spec gap coverage using TS RC + NativeAgentNode):

| # | Test | Constructs |
|---|---|---|
| C13 | Par fan-out (scatter pattern via fork/join) | Fork/join with 3 parallel branches, 3 worker agents |
| C14 | Alt message-based (reactive XOR) | Non-deciding sender uses message-wait fallback |
| C15 | Alt XOR message-wait fallback | Expression guard throws → fallback to receive matching |
| C16 | reagent.break() exits loop mid-iteration | Counter breaks at 3, peer loops independently |
| C17 | try/catch + $ctx.error verification | Compiled fixture, fail and success paths |
| C18 | $ctx.msg isolation in par | Each par branch sees its own $ctx.msg |
| C19 | Role inheritance (extends) | Compiler-flattened, init chained, handlers merged |
| C20 | protocolCompleted lifecycle across instances | 3 sequential instances, $self accumulation |
| C21 | protocolFailed lifecycle on zone throw | Zone throw, no try/catch, handler fires |
| C22 | Wildcard [*] lang tag participant | Message-only participant, no zones |

---

## Appendix A: Current code mapping

| Current code | New role |
|---|---|
| `NatsTransport` class | Low-level NATS wrapper, still used by `NatsCompatTransport` shim. `NatsNodeLink` is the target `NodeLink` implementation for inter-node NATS transport. |
| `AgentRunner` class | Internal to `NativeAgentNode`, wrapped as `AgentHandle` |
| `AgentRunnerConfig.natsUrl` | Replaced by `transport: ReagentTransport` |
| `ProtocolInstance` constructor `transport: NatsTransport` | Changes to `transport: ReagentTransport` (uses `ref` + `ref.send`) |
| `ProtocolInstance.emitTrace()` via `transport.publish(traceSubject)` | Replaced by `TraceHook` callback (agent-level, not RC-level) |
| `ProtocolInstance` message sends via `transport.publish(msgSubject)` | Replaced by `ref.send(messageName, payload)` |
| `AgentRunner.getTransport(): NatsTransport` | Returns `ReagentTransport` |
| `main.ts` | Creates `ReagentController` + `NativeAgentNode` instead of raw `AgentRunner` |
| `orchestrator.ts` | Evolves into node launcher + address page distributor (see §10) |
| `deployment.json` | Extended with optional `nodes` section (with `links`) |
| `types.ts` subject helpers (`msgSubject`, etc.) | Removed — no subject scheme; RC routes by agent name |
| `roleToAgent` map | Loaded by `AgentRunner`, not passed through RC |

## Appendix B: File inventory (new files)

| File | Purpose |
|---|---|
| `runtime/ts/src/transport.ts` | `NodeRef`, `AgentRef`, `ReagentTransport`, `NodeLink` interfaces |
| `runtime/ts/src/interceptor.ts` | `InterceptorFn`, `InterceptorContext`, chain runner |
| `runtime/ts/src/agent-node.ts` | `AgentNode`, `AgentHandle` interfaces |
| `runtime/ts/src/native-agent-node.ts` | `NativeAgentNode` wrapping `AgentRunner` |
| `runtime/ts/src/reagent-controller.ts` | `ReagentController` implementation (routing, refs, interceptors) |
| `runtime/ts/src/inmemory-node-link.ts` | `InMemoryNodeLink` for tests |
| `runtime/ts/src/nats-node-link.ts` | `NatsNodeLink` for inter-node communication over NATS |
| `runtime/ts/src/mcp-agent-adapter.ts` | `McpAgentAdapter` — pull-based `AgentInterface` for MCP clients |
| `runtime/ts/src/mcp-server.ts` | `ReagentMcpServer` — MCP tool server (stdio transport) |
| `runtime/ts/src/mcp-gate.ts` | Standalone subprocess entry point for MCP Gate mode |
| `runtime/ts/src/async-queue.ts` | `AsyncQueue` — promise-based queue for event buffering |
| `runtime/py/reagent_runtime/controller.py` | Python `ReagentController` implementation |
| `runtime/py/reagent_runtime/agent_node.py` | Python `AgentHandle`, `AgentNode` protocol types |
| `runtime/py/reagent_runtime/inproc_agent_node.py` | `InprocAgentNode` — in-process Python agents |
| `runtime/py/reagent_runtime/ipc_agent_node.py` | `IpcAgentNode` — subprocess Python agents |
| `runtime/py/reagent_runtime/inproc_transport.py` | `InprocTransport` — per-agent routing via RC callback |
| `runtime/tests/test_py_rc.py` | Python RC E2E tests (6 tests) |
| `runtime/tests/test_py_rc_coverage.py` | Python RC coverage tests (8 tests) |
| `runtime/tests/m5-coverage.test.ts` | TS coverage E2E tests (10 tests, C13–C22) |

---

## Appendix C: Message Gate

The **Message Gate** is an `AgentNode` integration mode for agents that run as separate processes or on remote machines. Instead of executing zone code in-process, the RC communicates with the external agent over a wire protocol — the agent receives `ProtocolEvent` objects and returns `AgentResponse` objects as JSON.

### Architecture

```
RC (ReagentController)
  └── MessageGateNode (implements AgentNode)
        └── MessageGateHandle (implements AgentHandle)
              └── GateSession (FSM validation + event/response framing)
                    └── GateTransport (wire adapter)
                          ├── WsGateTransport   (WebSocket)
                          ├── StdioGateTransport (stdin/stdout JSON lines)
                          └── HttpGateTransport  (POST per event)
```

### Components

**GateTransport** (`gate-transport.ts`) — bidirectional adapter that sends `ProtocolEvent` to the external agent and receives `AgentResponse`. Three implementations:

| Transport | Backing | Framing |
|---|---|---|
| `WsGateTransport` | WebSocket connection | JSON per WS message |
| `StdioGateTransport` | Child process stdin/stdout | Newline-delimited JSON |
| `HttpGateTransport` | HTTP endpoint | JSON POST, response body is `AgentResponse` |

```typescript
interface GateTransport {
  send(event: ProtocolEvent): void;
  onResponse(handler: (response: AgentResponse) => void): void;
  close(): void;
}
```

**GateSession** (`gate-session.ts`) — wraps a `GateTransport` with per-protocol-instance state:

- **FSM validation**: ensures the external agent follows the expected event sequence (e.g., no events after `protocol_completed`). Invalid transitions raise `GateValidationError`.
- **Request-response correlation**: `sendAndWait(event)` sends a `ProtocolEvent` and returns a `Promise<AgentResponse>` with configurable timeout.
- **Event log**: records all emitted events for debugging.
- **Status tracking**: `idle → active → completed | error`.

```typescript
interface GateSessionConfig {
  sessionId: string;
  agentName: string;
  protocolName: string;
  transport: GateTransport;
  validateFSM?: boolean;  // default: true
}
```

**MessageGateNode** (`message-gate-node.ts`) — implements the `AgentNode` interface (`runtimeName: "gate"`). On `createAgent()`, it obtains a `GateTransport` from the configured `transportFactory` and returns a `MessageGateHandle`.

**MessageGateHandle** — implements `AgentHandle`. On `triggerProtocol()`, creates a `GateSession` for the new instance and sends a `protocol_started` notification. On `dispatchMessage()`, forwards the message as a `receive_required` event to the active session.

### Wire protocol

The wire protocol is symmetric JSON serialization of the existing `ProtocolEvent` / `AgentResponse` types. The external agent reads JSON from its input (WebSocket message, stdin line, or HTTP POST body), parses it as a `ProtocolEvent`, computes a response, and writes it back as a JSON-encoded `AgentResponse`.

Event examples:
```json
{ "type": "action", "stateId": "s3", "body": "...", "lang": "py", "isAsync": false, "ctx": {}, "self": {} }
{ "type": "receive_required", "stateId": "s5", "from": "ClientAgent", "messageName": "TaskResult" }
{ "type": "protocol_completed", "ctx": { "result": 42 } }
```

Response examples:
```json
{ "type": "ctx_update", "ctx": { "counter": 1 } }
{ "type": "noop" }
{ "type": "error_thrown", "error": "something went wrong" }
```

### Use case

Message Gate is the primary mode for:
- Agents implemented in languages other than TS/Python (any language that can read/write JSON).
- Agents running as long-lived microservices (connected via WebSocket or HTTP).
- Agents running as child processes (connected via stdio).
- Testing and mocking — a stub process that responds to events with canned responses.

### Configuration

```typescript
const gateNode = new MessageGateNode({
  roleToAgent: { "Proto.worker": "WorkerAgent" },
  transportFactory: (agentName) => new WsGateTransport(wsConnection),
});
```

The `transportFactory` is called once per agent, allowing different agents to use different transports.

---

## Appendix D: Custom Agent Interface

The **Custom Agent** mode allows users to implement agent logic directly in code — via the `AgentInterface.handle()` method — instead of writing `.rg` zone code. The `ProtocolEngine` drives the FSM and emits `ProtocolEvent` objects; the user's `handle()` implementation consumes them and returns `AgentResponse` objects.

### Architecture

```
RC (ReagentController)
  └── CustomAgentNode (implements AgentNode, runtimeName: "custom")
        └── CustomAgentHandle (implements AgentHandle)
              ├── ProtocolEngine (FSM walker, emits ProtocolEvent)
              └── AgentInterface.handle() (user-provided logic)
```

### Components

**AgentInterface** (`agent-interface.ts`) — the contract between the engine and agent logic:

```typescript
interface AgentInterface {
  handle(event: ProtocolEvent): Promise<AgentResponse>;
}
```

The user implements `handle()` to respond to protocol events. The method receives the full event context (`$ctx`, `$self`, zone body, state ID) and returns an `AgentResponse` indicating how to proceed (update context, throw error, break from loop, return a value, etc.).

**ManagedAgentAdapter** (`agent-interface.ts`) — the default `AgentInterface` implementation. It executes zone code from `.rg` files using the existing `ZoneExecutor`, providing the same behavior as the `NativeAgentNode`/`AgentRunner` path. Supports `reagent.invoke()`, `reagent.spawn()`, `reagent.break()`, `reagent.return()`, and `reagent.emit()` via configurable callbacks.

```typescript
class ManagedAgentAdapter implements AgentInterface {
  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    // Executes zone body via executeZone()/executeZoneAsync()
    // Returns ctx_update, return_value, break_requested, or error_thrown
  }
}
```

**ProtocolEngine** (`protocol-engine.ts`) — a pure FSM walker that owns the IR graph and state machine state. It does **not** execute zones, talk to transport, or manage traces. It exposes:
- `followDefault()` — advance along the default transition.
- `evalExpr(expr)` — evaluate a guard expression against `$ctx`/`$self`.
- `findLoopExit()`, `findJoinForFork()`, `getCatchTarget()` — structural graph queries.
- `ctx` / `selfRef` — mutable state accessible by the agent.

The engine is instantiated per protocol instance. The orchestrating layer (`CustomAgentHandle`) steps through the graph, calls `agent.handle(event)` for action/send/receive states, applies the response, and advances.

**CustomAgentNode** (`custom-agent-node.ts`) — implements the `AgentNode` interface. On `createAgent()`, it calls the user-provided `agentFactory(agentName, roleIR)` to obtain an `AgentInterface`, then wraps it in a `CustomAgentHandle` together with a `ProtocolEngine`.

**CustomAgentHandle** — implements `AgentHandle`. It runs the engine loop:

1. `triggerProtocol()` creates a `ProtocolEngine` for the protocol instance and starts the `runEngine()` loop.
2. The loop reads the current state from the engine and dispatches by state kind:
   - `action` → calls `agent.handle({ type: "action", ... })`, applies the response.
   - `send` → optionally calls `handle()` for the pre-send zone, constructs and sends the envelope via `ReagentTransport`.
   - `receive` → waits for an inbound `MessageEnvelope` (buffered by `dispatchMessage()`), optionally calls `handle()` for the post-receive zone.
   - `timer` → sleeps for the specified duration.
   - `guard`, `join`, `error` → the engine follows transitions directly.
   - `terminal` → marks the instance completed or failed.
3. `dispatchMessage()` buffers inbound messages and resolves pending waiters.

### ProtocolEvent / AgentResponse lifecycle

```
ProtocolEngine walks IRGraph
    ↓ emits ProtocolEvent
AgentInterface.handle(event)
    ↓ returns AgentResponse
CustomAgentHandle applies response (ctx_update, break, return, error)
    ↓
ProtocolEngine advances to next state
```

### Use case

Custom Agent mode is for:
- Programmatic agents where behavior is easier to express in code than in `.rg` zones (e.g., RL policies, LLM-backed decision loops).
- Testing — mock agents that return deterministic responses.
- Embedding Reagent protocols in existing applications where the agent logic already exists.

### Configuration

```typescript
const customNode = new CustomAgentNode({
  roleToAgent: { "Proto.worker": "WorkerAgent" },
  agentFactory: (agentName, roleIR) => ({
    async handle(event) {
      if (event.type === "action") {
        // Custom logic instead of zone execution
        return { type: "ctx_update", ctx: { ...event.ctx, processed: true } };
      }
      return { type: "noop" };
    },
  }),
  traceHook: (event) => console.log(event),
});
```

### Relationship to other integration modes

| Mode | AgentNode | Zone execution | Agent logic |
|---|---|---|---|
| **Native** (default) | `NativeAgentNode` | `AgentRunner` + `ProtocolInstance` | `.rg` zones (JS/TS/Python) |
| **Custom Agent** | `CustomAgentNode` | `ProtocolEngine` + user `handle()` | User code via `AgentInterface` |
| **Message Gate** | `MessageGateNode` | External process | Remote process via `GateTransport` |

All three modes implement the same `AgentNode`/`AgentHandle` contract. The RC does not know which mode is in use — it only interacts through `AgentHandle.dispatchMessage()`, `triggerProtocol()`, and `getSelf()`.

---

## Etcd-based Node Discovery

### Overview

Node and agent discovery uses embedded etcd (replacing the previous SWIM gossip `DiscoveryAgent`).
Each node registers itself at `/nodes/{nodeId}` with a lease, and agents register at `/agents/{name}`
with their `nodeId`. The `EtcdMembership` class watches both prefixes and auto-populates the RC
routing table when remote agents appear or disappear.

### Components

| Component | File | Purpose |
|---|---|---|
| `EtcdManager` | `etcd-manager.ts` | Download, cache, start/stop etcd binary as child process |
| `EtcdStateStore` | `etcd-state-store.ts` | `StateStore` implementation via `etcd3` npm client |
| `EtcdMembership` | `etcd-membership.ts` | Node presence + agent routing via StateStore watch |
| `LeaderElection` | `leader-election.ts` | Lease-based leader lock (used by CronAgent) |
| `bootstrapCluster` | `cluster-bootstrap.ts` | Ties EtcdManager + EtcdStateStore + LeaderElection |

### Configuration

```typescript
import { bootstrapCluster, ReagentController, NativeAgentNode } from "@reagent/runtime";

// Bootstrap etcd cluster
const cluster = await bootstrapCluster({
  nodeId: "node-1",
  peers: ["node-1=http://host1:2380", "node-2=http://host2:2380"],
});

// Create RC with etcd-backed StateStore
const rc = new ReagentController({
  nodeId: "node-1",
  stateStore: cluster.stateStore,
  cronLeaderElection: cluster.cronLeaderElection,
  agentNode: new NativeAgentNode({ roleToAgent: {} }),
});

// Start membership (auto-populates routing table from etcd watches)
await rc.startMembership();

// Shutdown
await rc.stop();
await cluster.shutdown();
```

### Node lifecycle

1. Node calls `bootstrapCluster()` — starts embedded etcd (or connects to external)
2. RC uses `EtcdStateStore` — all state operations go through etcd
3. `rc.startMembership()` — registers node at `/nodes/{nodeId}` with lease, watches for remote agents
4. Agent registration includes `nodeId` — other nodes detect and route via watch callbacks
5. On shutdown: lease expires, node and agent keys are auto-deleted

### Scatter Scaling

Wave 3.3 introduced streaming and partitioned scatter for scaling beyond single-process limits.

#### Streaming scatter

Results are emitted incrementally as each branch completes, rather than waiting for all branches (await-all join):

```typescript
import { streamingScatter } from "@reagent/runtime";

const results = await streamingScatter(
  items,
  async (branch) => processBranch(branch.item),
  (result) => console.log(`Branch ${result.index} done in ${result.durationMs}ms`),
  { concurrencyLimit: 10 },
);
```

#### Partitioned scatter

When branch count exceeds a threshold, items are automatically partitioned for distribution:

```typescript
import { partitionedScatter } from "@reagent/runtime";

const results = await partitionedScatter(
  largeItemList, // e.g., 500 items
  async (branch) => processBranch(branch.item),
  (result) => onResult(result),
  { partitionThreshold: 50, partitionSize: 25 },
);
// Automatically creates 20 partitions, executes in parallel
```

---

## Appendix E: MCP Gate

The **MCP Gate** is an integration mode for LLM agents and MCP-compatible clients. Unlike Message Gate (push — RC sends events to the agent), MCP Gate uses a pull model: the agent actively requests events via MCP tool calls.

### Architecture

```
Agent (MCP client: Claude Code / Cursor)
  │
  │  stdin/stdout JSON-RPC (MCP protocol)
  │
  └── mcp-gate subprocess
        ├── ReagentMcpServer (MCP tool server)
        ├── McpAgentAdapter (AgentInterface — event queue + response bridge)
        ├── CustomAgentNode → CustomAgentHandle → ProtocolEngine
        └── ReagentController (routing, NodeLinks, interceptors)
              └── NatsNodeLink / WsNodeLink (inter-node transport)
```

### Relationship to other modes

MCP Gate builds on Custom Agent mode. The `McpAgentAdapter` implements `AgentInterface` (same as any user-provided class in Custom Agent mode), but instead of executing logic directly, it:

1. Queues `ProtocolEvent`s into an `AsyncQueue`
2. Blocks the engine loop (returns a pending `Promise<AgentResponse>`)
3. Waits for the MCP client to pull events and submit responses

This lets the agent reason asynchronously between protocol steps — essential for LLM agents that need to inspect context, call tools, and formulate responses.

### Key difference from Message Gate

| Aspect | Message Gate | MCP Gate |
|--------|-------------|----------|
| **Direction** | Push (RC → agent) | Pull (agent → RC) |
| **Transport** | `GateTransport` (WS/stdio/HTTP) | MCP JSON-RPC over stdio |
| **AgentNode** | `MessageGateNode` | `CustomAgentNode` |
| **AgentInterface** | N/A (GateSession handles framing) | `McpAgentAdapter` |
| **Use case** | Simple external processes, polyglot | LLM agents, MCP clients |

### Components

- `mcp-gate.ts` — standalone subprocess entry point
- `mcp-server.ts` — `ReagentMcpServer` wrapping `@modelcontextprotocol/sdk`
- `mcp-agent-adapter.ts` — `McpAgentAdapter` implementing `AgentInterface`
- `async-queue.ts` — `AsyncQueue<T>` for bridging push (engine) to pull (MCP client)

### MCP tools

| Tool | Description |
|------|-------------|
| `reagent/register` | Register agent identity and declare roles |
| `reagent/unregister` | Leave discovery |
| `reagent/wait_for_events` | Long-poll for protocol events |
| `reagent/respond` | Submit `AgentResponse` for a protocol event |
| `reagent/invoke` | Start a new protocol instance |
| `reagent/list_protocols` | List available protocols |
| `reagent/list_instances` | List active protocol instances |
| `reagent/get_state` | Get instance state |

### Configuration

The agent starts `mcp-gate` as a subprocess. Example MCP client config:

```json
{
  "mcpServers": {
    "reagent": {
      "command": "node",
      "args": ["mcp-gate.js", "--ros-url", "ws://localhost:7400", "--node-id", "my-agent"]
    }
  }
}
```

The `mcp-gate` process creates its own `ReagentController`, connects to ROS for deploy/trigger commands, and serves MCP tools on stdio. Inter-node envelope transport uses `NatsNodeLink` or `WsNodeLink`.
