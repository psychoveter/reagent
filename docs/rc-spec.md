# ReagentController (RC) Specification

**Status:** Draft v1

The ReagentController is the routing, registry, and interception core of a Reagent node.
One RC runs per node process. It connects agents to each other via local loopback or
cross-node links, applies message-level interceptors, and delegates agent creation to
pluggable `AgentNode` backends.

---

## 1. Core Model

- **One RC per process.** The RC owns the routing table, protocol registry, and agent
  handles for a single node.
- **Protocol-agnostic.** The RC never interprets IR graphs. It stores them in the
  registry and passes them to `AgentNode` implementations that know what to do with them.
- **Delegated agent creation.** The RC receives one or more `AgentNode` backends
  (keyed by language tag: `"ts"`, `"py"`, …). When `registerAgent()` is called, the RC
  picks the backend matching the agent's `lang` and calls `createAgent()` on it.
- **Loopback + remote routing.** Local agents route through a built-in loopback
  `NodeRef` (direct function-call dispatch). Remote agents route through `NodeLink`-backed
  `NodeRef` objects registered via `addNodeLink()`.

```typescript
interface AgentNode {
  readonly runtimeName: string;
  createAgent(
    agentName: string,
    roleIR: RoleIR,
    graphs: Map<string, IRGraph>,
    transport: ReagentTransport,
    extras?: Record<string, unknown>,
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

---

## 2. State Ownership

| State | Scope | Owner | Lifetime |
|-------|-------|-------|----------|
| `$ctx` | Per protocol instance | `ProtocolEngine` / `ProtocolInstance` | Created at instance start, discarded on completion |
| `$self` | Per agent | `AgentHandle` (via `getSelf()`) | Persistent across protocol instances for the agent's lifetime |
| Routing table | Per RC | `ReagentController.routingTable` | `Map<agentName, NodeRef>` — mutated by `registerAgent`, `registerRemoteAgent`, `applyAddressPage` |
| Protocol registry | Per RC | `ReagentController.registry` (`ProtocolRegistry`) | `Map<protocolName, ProtocolEntry>` — populated during agent registration |

### Routing table internals

```
agentName → NodeRef { nodeId, send(envelope) }
```

- Local agents point to the RC's built-in `loopbackRef`.
- Remote agents point to a `NodeRef` wrapping a `NodeLink`.

### Protocol registry internals

```
protocolName → ProtocolEntry { name, version, fingerprints, dependencies, irGraphs }
protocolName → Set<agentName>  (agent binding)
```

---

## 3. Envelope Format

All inter-agent messages are wrapped in a `MessageEnvelope`:

```typescript
type MessageEnvelope = {
  instanceId: string;
  protocolName: string;
  protocolVersion?: string;
  from: { agent: string; role: string };
  to: { agent: string; role: string };
  messageName: string;
  payload: Record<string, unknown>;
  ts: number;
  idempotencyKey: string;
};
```

- `instanceId` — identifies the protocol instance this message belongs to.
- `from` / `to` — agent name + role within the protocol.
- `idempotencyKey` — UUID generated at creation; enables at-most-once delivery semantics.
- `ts` — millisecond timestamp (`Date.now()`).

Factory: `createMessageEnvelope(instanceId, protocolName, fromAgent, fromRole, toAgent, toRole, messageName, payload)`.

---

## 4. Three Integration Modes

All three modes produce `AgentHandle` objects that the RC manages uniformly.
The RC does not know which mode an agent uses — it only sees the `AgentHandle` interface.

### 4.1 Managed Mode (default)

**Components:** `NativeAgentNode` → `AgentRunner` → `ProtocolInstance`

The RC creates agents whose behavior is defined by `.rg` zone code compiled to IR.
Zones are executed in-process by the `ProtocolInstance` advance loop via `executeZone()`.

- `NativeAgentNode.createAgent()` builds an `AgentRunner` from `AgentIR` + IR graphs.
- `AgentRunner` owns `$self` state and creates `ProtocolInstance` objects for each triggered protocol.
- `ProtocolInstance` walks the IR state machine, executing zone code at action/send/receive states.
- `ManagedAgentAdapter` wraps `executeZone()` behind the `AgentInterface` contract, injecting
  `$ctx`, `$self`, and `$agent` (extras) into the zone execution scope.

```typescript
interface ManagedAgentConfig {
  extras?: Record<string, unknown>;
  invokeCallback?: (protoName: string, input?: Record<string, unknown>) => Promise<unknown>;
  spawnCallback?: (protoName: string, input?: Record<string, unknown>) => void;
  emitCallback?: (eventName: string, data?: Record<string, unknown>) => void;
}
```

### 4.2 Custom Agent Mode

**Components:** `CustomAgentNode` → `CustomAgentHandle` → user's `AgentInterface`

The user provides a class implementing `AgentInterface.handle()`. The RC routes
`ProtocolEvent` objects to it and receives `AgentResponse` objects back.

```typescript
interface AgentInterface {
  handle(event: ProtocolEvent): Promise<AgentResponse>;
}

interface CustomAgentNodeConfig {
  roleToAgent: Record<string, string>;
  agentFactory: (agentName: string, roleIR: RoleIR) => AgentInterface;
  traceHook?: TraceHook;
}
```

- `CustomAgentHandle` creates a `ProtocolEngine` per protocol instance.
- The engine emits `ProtocolEvent`s; the handle calls `agent.handle(event)` for each one.
- No zones — the user implements all logic in `handle()`.
- The engine still validates the FSM and manages `$ctx` / state transitions.

### 4.3 Message Gate Mode

**Components:** `MessageGateNode` → `MessageGateHandle` → `GateTransport` → external process

The agent runs externally (separate process, container, or machine). Communication
happens via a `GateTransport` that serializes `ProtocolEvent` / `AgentResponse` as JSON.

```typescript
interface MessageGateNodeConfig {
  roleToAgent: Record<string, string>;
  transportFactory: (agentName: string) => GateTransport;
}

interface GateTransport {
  send(event: ProtocolEvent): void;
  onResponse(handler: (response: AgentResponse) => void): void;
  close(): void;
}
```

- `MessageGateHandle` manages `GateSession` objects (one per protocol instance).
- `GateSession` wraps the transport with FSM validation, request-response correlation,
  and timeout handling.
- The wire protocol is JSON-serialized `ProtocolEvent` (RC → agent) and
  `AgentResponse` (agent → RC).

Three transport implementations are provided:

| Transport | Mechanism |
|-----------|-----------|
| `WsGateTransport` | WebSocket frames |
| `StdioGateTransport` | Line-delimited JSON on stdin/stdout |
| `HttpGateTransport` | POST request per event, response body = `AgentResponse` |

---

## 5. Infrastructure

### 5.1 Routing

The RC maintains a `Map<string, NodeRef>` routing table.

**`AgentRef`** is the primary addressing primitive (analogous to Akka's `ActorRef`):

```typescript
interface AgentRef {
  readonly agentName: string;
  readonly nodeRef: NodeRef;
  send(messageName: string, payload: Record<string, unknown>): void;
  sendEnvelope(envelope: MessageEnvelope): void;
}
```

**Routing flow:**

1. Agent code calls `transport.ref(targetAgent).send(…)` or `.sendEnvelope(…)`.
2. The RC's `routeEnvelope()` looks up `targetAgent` in the routing table.
3. If the `NodeRef` is the loopback ref → direction is `"loopback"`, deliver locally.
4. Otherwise → direction is `"outbound"`, send via the `NodeLink`-backed `NodeRef`.
5. For inbound envelopes arriving via a `NodeLink` → direction is `"inbound"`.
6. In all three cases the interceptor chain runs before delivery.

**`AddressPage`** — static routing information distributed by the orchestrator:

```typescript
interface AddressPage {
  sourceNodeId: string;
  agents: Array<{ agentName: string; nodeId: string }>;
  nodes: Array<{ nodeId: string; linkType: string; url?: string }>;
  ts: number;
}
```

`rc.applyAddressPage(page)` merges the page into the routing table, mapping remote
agent names to their node's `NodeRef`.

### 5.2 Interceptors

```typescript
type MessageDirection = "outbound" | "inbound" | "loopback";

interface InterceptorContext {
  envelope: MessageEnvelope;
  direction: MessageDirection;
  nodeId: string;
}

type InterceptorFn = (ctx: InterceptorContext, next: () => void) => void;
```

Interceptors form a middleware chain. Every message flowing through the RC — loopback,
inbound, or outbound — passes through all registered interceptors in order.

- Call `next()` to pass the message to the next interceptor (or final delivery).
- Omit `next()` to drop the message silently.
- Interceptors are added via `rc.addInterceptor(fn)` or the `interceptors` config array.

**Built-in interceptors:**

| Interceptor | Purpose |
|-------------|---------|
| `createOTelInterceptor()` | OpenTelemetry span creation per message |
| `DebugInterceptor` | Hold/release messages for step-debugging |

### 5.3 NodeLink

A `NodeLink` is a thin, bidirectional envelope pipe between two RC nodes.
It is not a messaging system — no subjects, no subscriptions, no routing logic.
Just: serialize → send bytes → receive bytes → deserialize.

```typescript
interface NodeLink {
  readonly remoteNodeId: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  send(envelope: MessageEnvelope): void;
  onEnvelope(handler: (envelope: MessageEnvelope) => void): void;
}
```

**Implementations:**

| Implementation | Use case |
|----------------|----------|
| `InMemoryNodeLink` | Testing, single-process multi-node. Created in pairs via `createInMemoryLinkPair(nodeAId, nodeBId)`. Direct function-call delivery, no serialization. |
| `WsNodeLink` | Production cross-node. Client/server modes. Handshake: first message is `{ nodeId: "..." }`. `WsNodeLinkServer` accepts incoming connections and produces `WsNodeLink` instances. |
| `NatsCompatTransport` | Legacy bridge — wraps `NatsTransport` as `ReagentTransport`. Being retired in favor of `InMemoryNodeLink` / `WsNodeLink`. |

**Link lifecycle:**

1. `rc.addNodeLink(link)` — registers the link, creates a `NodeRef`, wires the inbound handler.
2. `rc.start()` — calls `link.connect()` on all links.
3. `rc.stop()` — calls `link.close()` on all links.

---

## 6. Protocol Registry API

The `ProtocolRegistry` tracks deployed protocols, their versions, fingerprints,
and agent bindings.

```typescript
interface ProtocolEntry {
  name: string;
  version: string;
  fingerprints: ProtocolFingerprint;
  dependencies: ProtocolDependency[];
  irGraphs: Map<string, IRGraph>;
  registeredAt: number;
}

type ProtocolFingerprint = {
  structureHash: string;   // choreography topology
  schemaHash: string;      // message types
  implHash: string;        // zone bodies
};
```

| Method | Description |
|--------|-------------|
| `register(entry)` | Add or replace a protocol entry. |
| `get(name)` | Look up a protocol by name. Returns `undefined` if not registered. |
| `list()` | Return all registered protocol entries. |
| `bindAgent(protocolName, agentName)` | Associate an agent with a protocol. |
| `agentsForProtocol(name)` | List all agents bound to a protocol. |
| `canDeploy(entry)` | Compatibility check — returns a `CompatibilityReport`. |

**`CompatibilityReport`:**

```typescript
interface CompatibilityReport {
  compatible: boolean;
  changeLevel: "none" | "patch" | "minor" | "major";
  details: string[];
  requiresAgentRestart: boolean;
  affectedAgents: string[];
  dependencyConflicts: Array<{
    depName: string;
    expectedHash: string;
    actualHash: string;
  }>;
}
```

Change-level semantics:
- **patch** — `implHash` changed (zone bodies only). No restart required.
- **minor** — `schemaHash` changed (message types). No restart required.
- **major** — `structureHash` changed (choreography topology). Agent restart required.

---

## 7. Wire Protocol Schemas

The `ProtocolEngine` communicates with agent implementations via two type unions.

### ProtocolEvent (Engine → Agent)

```typescript
type ProtocolEvent =
  | { type: "protocol_started"; protocolName: string }
  | { type: "protocol_completed"; ctx: Record<string, unknown> }
  | { type: "protocol_failed"; error: string; ctx: Record<string, unknown> }
  | { type: "action"; stateId: string; body: string; lang: string;
      isAsync: boolean; ctx: Record<string, unknown>; self: Record<string, unknown> }
  | { type: "pre_send_action"; stateId: string; body: string;
      isAsync: boolean; ctx: Record<string, unknown>; self: Record<string, unknown> }
  | { type: "post_receive_action"; stateId: string; body: string;
      isAsync: boolean; ctx: Record<string, unknown>; self: Record<string, unknown> }
  | { type: "send_required"; stateId: string; to: string;
      messageName: string; ctx: Record<string, unknown>; scatterItem?: unknown }
  | { type: "receive_required"; stateId: string; from: string; messageName: string }
  | { type: "receive_any_required"; guardId: string;
      expectations: Array<{ messageName: string; targetStateId: string }> }
  | { type: "guard_evaluated"; data: Record<string, unknown> }
  | { type: "timer_required"; stateId: string; durationMs: number }
  | { type: "scatter_required"; stateId: string; items: unknown[];
      branchStartId: string; joinId: string | null }
  | { type: "fork_required"; stateId: string;
      branchStartIds: string[]; joinId: string | null }
  | { type: "invoke_required"; stateId: string; protocolName: string; input: unknown }
  | { type: "spawn_required"; stateId: string; protocolName: string; input: unknown }
  | { type: "advance_hook"; stateId: string; stateKind: string }
  | { type: "state_entered"; stateId: string; stateKind: string };
```

### AgentResponse (Agent → Engine)

```typescript
type AgentResponse =
  | { type: "ctx_update"; ctx: Record<string, unknown> }
  | { type: "send_payload"; payload: Record<string, unknown> }
  | { type: "message_received"; env: MessageEnvelope }
  | { type: "message_any_received"; env: MessageEnvelope; targetStateId: string }
  | { type: "timer_fired" }
  | { type: "invoke_result"; value: unknown }
  | { type: "scatter_complete" }
  | { type: "fork_complete" }
  | { type: "noop" }
  | { type: "break_requested" }
  | { type: "return_value"; value: unknown }
  | { type: "error_thrown"; error: Error | string };
```

For Message Gate agents, these types are JSON-serialized over the `GateTransport`.

---

## 8. Error Handling

### Zone errors (Managed Mode)

Errors thrown in zone code are caught by the `ProtocolInstance` / `CustomAgentHandle`
advance loop. If the current state has a `try/catch` edge in the IR graph:
- The error is caught, `$ctx.error` is set, and the engine transitions to the catch target.
- A `TraceEvent` of kind `"ErrorCaught"` is emitted.

If no catch target exists, the error propagates and the protocol instance is marked `"failed"`.

### Transport errors

Transport-level errors (e.g., `NodeLink` send failures, WebSocket disconnects) are
logged and the message is potentially dropped. The RC does not retry — at-most-once
delivery is the baseline.

### Gate errors

`GateValidationError` is thrown when the `GateSession` detects an invalid FSM transition
(e.g., sending events after protocol completion). It carries session context:

```typescript
class GateValidationError extends Error {
  readonly sessionId: string;
  readonly event: ProtocolEvent;
}
```

`GateSession` also enforces a configurable response timeout (default 30 s). If the
external agent does not respond in time, the session transitions to `"error"` status.

---

## 9. Gate API (Message Gate Details)

### 9.1 WS Gate

```
RC                          External Agent
 │                                │
 │──── WS connect ───────────────→│
 │                                │
 │──── ProtocolEvent (JSON) ─────→│
 │←─── AgentResponse (JSON) ──────│
 │                                │
 │──── ProtocolEvent (JSON) ─────→│
 │←─── AgentResponse (JSON) ──────│
 │                                │
 │──── close ────────────────────→│
```

- Client connects to the RC's WS endpoint (or RC connects to the agent's WS server).
- Each frame is a single JSON-serialized `ProtocolEvent` or `AgentResponse`.
- `WsGateTransport` checks `ws.readyState === OPEN` before sending.

### 9.2 Stdio Gate

```
RC                          Child Process
 │                                │
 │── spawn ──────────────────────→│
 │                                │
 │── stdin: ProtocolEvent\n ─────→│
 │←─ stdout: AgentResponse\n ─────│
 │                                │
 │── stdin: ProtocolEvent\n ─────→│
 │←─ stdout: AgentResponse\n ─────│
 │                                │
 │── stdin.end() ────────────────→│
```

- RC spawns a child process.
- Events written to child's stdin as line-delimited JSON (one JSON object per line, `\n`-terminated).
- Responses read from child's stdout as line-delimited JSON.
- `StdioGateTransport` buffers partial lines and splits on `\n`.

### 9.3 HTTP Gate

```
RC                          Agent HTTP Server
 │                                │
 │── POST /event ────────────────→│
 │   body: ProtocolEvent JSON     │
 │←─ 200 AgentResponse JSON ──────│
 │                                │
 │── POST /event ────────────────→│
 │   body: ProtocolEvent JSON     │
 │←─ 200 AgentResponse JSON ──────│
```

- RC sends an HTTP POST with `Content-Type: application/json` body = `ProtocolEvent`.
- Response body is the `AgentResponse` JSON.
- Stateless — each event is an independent request.
- `HttpGateTransport` uses `fetch()` internally.

---

## 10. Conformance Requirements

1. **Behavioral equivalence.** All three integration modes (Managed, Custom, Message Gate)
   must produce identical trace event sequences for the same protocol IR and input.
   Trace events are compared by `kind`, `agent`, `role`, `protocolName`, and `data` —
   timestamps and event IDs are excluded from comparison.

2. **IR fixture tests.** Conformance tests use pre-compiled IR graphs as fixtures.
   Each test specifies:
   - IR graphs for all roles
   - Agent-to-role mapping
   - Protocol trigger input
   - Expected trace sequence (ordered list of `TraceEventKind` values with relevant data)

3. **Cross-implementation parity.** The TS and Python RC implementations must pass the
   same conformance test suite. Test fixtures are shared across implementations as JSON
   files. The expected trace sequences are implementation-independent.

4. **Gate round-trip fidelity.** JSON serialization of `ProtocolEvent` and `AgentResponse`
   must be lossless. Gate transports must not modify, reorder, or coalesce events.

5. **Interceptor transparency.** Adding or removing interceptors must not change the
   trace output of a protocol execution (interceptors may log or drop messages, but
   the conformance suite runs without message-dropping interceptors).
