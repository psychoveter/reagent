# M6-RT: Reagent Orchestrator Service (ROS) — Design

**Status**: draft-1
**Depends on**: M5-CTRL (done)

---

## 1. Overview

The Reagent Orchestrator Service (ROS) is a long-lived Node.js process that replaces the old monolithic `orchestrator.ts`. It provides:

- **Compile**: `.rg` → IR on demand
- **Deploy**: create agent nodes, distribute IR, configure routing
- **Run**: trigger protocols, collect traces, report results
- **Debug**: breakpoints, stepping, state inspection

External tools (VSCode extension, CLI, web UI) connect to the ROS via **WebSocket** using the **RAP protocol** (7 sub-protocols already specced as `.rg` files in `examples/src/rap/`).

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Reagent Orchestrator Service (ROS)                  │
│                                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  WS      │  │ Session      │  │ Debug        │  │ Trace      │  │
│  │  Server  │  │ Manager      │  │ Controller   │  │ Collector  │  │
│  └────┬─────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │
│       │               │                 │                 │          │
│  ┌────▼───────────────▼─────────────────▼─────────────────▼──────┐  │
│  │                 ReagentController (orchestrator node)          │  │
│  │  agentNodes: { ts: NativeAgentNode, py: PythonAgentNode }     │  │
│  └──────────┬─────────────────────────────┬──────────────────────┘  │
│             │ NodeLink (WS or InMemory)    │                         │
└─────────────┼─────────────────────────────┼─────────────────────────┘
              │                             │
     ┌────────▼─────────┐        ┌─────────▼────────┐
     │  Agent Node 1     │        │  Agent Node 2     │
     │  (in-process RC)  │        │  (remote via WS)  │
     └──────────────────┘        └──────────────────┘
```

---

## 2. Components

### 2.1 WsNodeLink — WebSocket-based NodeLink

The first real network `NodeLink` implementation. Enables ROS-to-node and node-to-node communication over WebSocket.

```typescript
interface WsNodeLinkConfig {
  remoteNodeId: string;
  url: string;              // ws://host:port/link
  role: "client" | "server";
}

class WsNodeLink implements NodeLink {
  readonly remoteNodeId: string;

  connect(): Promise<void>;   // WS handshake
  close(): Promise<void>;     // graceful close
  send(envelope: MessageEnvelope): void;  // JSON serialize + ws.send
  onEnvelope(handler: (envelope: MessageEnvelope) => void): void;
}
```

The `NodeLink` interface from M5-CTRL is symmetric — both ends call `connect()`. The WS implementation decides client vs. server based on `role` config. Envelopes are serialized as JSON text frames.

### 2.2 ReagentOrchestratorServer

The main service class.

```typescript
interface ROSConfig {
  port: number;              // WS listen port (default 18789)
}

class ReagentOrchestratorServer {
  private wss: WebSocketServer;
  private sessions: Map<string, Session>;
  private rc: ReagentController;

  async start(): Promise<void>;
  async stop(): Promise<void>;
}
```

The ROS:

1. Boots a WebSocket server on the configured port.
2. Creates its own `ReagentController` — the orchestrator is itself a Reagent node.
3. Accepts RAP client connections (VSCode, CLI). Each connection is a RAP session.
4. Manages debug sessions: one session per `.rg` program being run/debugged.

### 2.3 Session — one protocol execution context

```typescript
interface Session {
  sessionId: string;
  rgSource: string;
  compiledIR: {
    irGraphs: Map<string, IRGraph>;
    roleIRs: Map<string, RoleIR>;
    deployment: DeploymentPlan;
    sourceMap: SourceMap;
  };
  rc: ReagentController;                // the session's RC (may be the ROS's own RC for local execution)
  debugState: DebugState;
  traces: TraceEvent[];
  status: "created" | "deploying" | "running" | "paused" | "completed" | "failed";
}
```

A session represents one `.rg` program being run or debugged. Sessions are created via the `CompileRequest` RAP sub-protocol and populated via `DeployAgent` + `RunProtocol`.

### 2.4 DebugInterceptor — message-level breakpoints

The existing interceptor chain from M5-CTRL already supports dropping messages (interceptor doesn't call `next()`). For debugging, we extend this to **hold** messages in a queue for later release.

```typescript
interface HeldMessage {
  envelope: MessageEnvelope;
  direction: MessageDirection;
  release: () => void;       // call to deliver the message
  drop: () => void;          // call to permanently discard
}

class DebugInterceptor {
  private breakpoints: Set<string>;            // message names or state IDs
  private heldMessages: HeldMessage[];
  private paused: boolean;

  /** The InterceptorFn installed in the RC's chain. */
  interceptor: InterceptorFn;

  setBreakpoints(bps: string[]): void;
  continue(): void;                            // release all held, resume
  step(): void;                                // release one, then pause again
  getHeld(): HeldMessage[];
}
```

The `DebugInterceptor` is injected into the RC's interceptor chain. When a message matches a breakpoint, the interceptor:
1. Stores the envelope + a `release` callback (which calls `next()`) in `heldMessages`.
2. Emits a `Paused` event to the debug client.
3. Does **not** call `next()` — the message is held.

When the client sends `continue` or `step`, the controller calls `release()` on held messages.

### 2.5 DebugController — coordinates debug operations

```typescript
class DebugController {
  private sessions: Map<string, DebugInterceptor>;

  setBreakpoints(sessionId: string, locations: BreakpointLocation[]): ResolvedBreakpoint[];
  continue(sessionId: string): void;
  step(sessionId: string): void;
  inspectState(sessionId: string, agentName: string): StateSnapshot;
}
```

Breakpoints can be set on:

- **Message names**: pause when a message with that name is about to be delivered.
- **Source locations**: `.rg` file + line → resolved to IR state ID via source map.
- **IR state IDs**: direct low-level breakpoint.

### 2.6 Source map

The compiler emits a mapping from IR state IDs to `.rg` source locations:

```typescript
interface SourceMap {
  entries: Array<{
    stateId: string;
    protocolName: string;
    role: string;
    file: string;
    line: number;
    column: number;
  }>;
}
```

This enables the VSCode extension to show "current line" indicators and resolve breakpoints from `.rg` source lines to IR state IDs.

### 2.7 StateSnapshot

```typescript
interface StateSnapshot {
  agentName: string;
  currentStateId: string;       // current IR state in the active protocol instance
  ctx: Record<string, unknown>;
  self: Record<string, unknown>;
  pendingMessages: string[];    // message names being waited for
  recentTraces: TraceEvent[];   // last N trace events for this agent
  instanceStatuses: Record<string, string>;  // instanceId → status
}
```

Returned by `InspectState` RAP sub-protocol. For TS agents, this is assembled from `AgentHandle.getSelf()`, `ProtocolInstance.getCtx()`, `ProtocolInstance.getTraces()`. For Python agents, it's fetched via the IPC bridge (`getSelf` command + trace collection).

---

## 3. RAP wire protocol

The WebSocket carries RAP messages as JSON text frames. Each message has a `rap` field identifying the sub-protocol and an `id` for request-response correlation.

### 3.1 Envelope format

```json
{
  "rap": "CompileRequest",
  "id": "req-1",
  "payload": { ... }
}
```

Response:

```json
{
  "rap": "CompileSuccess",
  "id": "req-1",
  "payload": { ... }
}
```

### 3.2 Sub-protocol mapping

The 7 existing RAP `.rg` specs map directly to WS message types:

| RAP Protocol | Request | Response(s) | Direction |
|---|---|---|---|
| `CompileRequest` | `Compile` | `CompileSuccess` / `CompileError` | client → ROS |
| `DeployAgent` | `Deploy` | `Deployed` / `DeployFailed` | ROS → adapter (or internal) |
| `RunProtocol` | `RunStart` | `RunCompleted` | ROS → adapter (or internal) |
| `SetBreakpoints` | `SetBreakpointsRequest` | `BreakpointsResolved` | client → ROS |
| `DebugSession` | `DebugCommand` | `Stopped` | client → ROS → adapter |
| `InspectState` | `GetState` | `StateSnapshot` | client → ROS → adapter |
| `AdapterHandshake` | `Register` | `Accepted` / `Rejected` | adapter → ROS |

### 3.3 Streaming events

In addition to request-response, the ROS pushes real-time events to connected clients:

```json
{"rap": "TraceEvent", "payload": { "instanceId": "...", "kind": "MessageSent", ... }}
{"rap": "SessionStatus", "payload": { "sessionId": "...", "status": "paused", "reason": "breakpoint" }}
```

---

## 4. Implementation phases

### Phase 1: WsNodeLink + ROS skeleton

**Goal**: a usable orchestrator service that can compile, deploy, run, and stream traces — all without NATS.

**New files**:
- `runtime/ts/src/ws-node-link.ts` — WebSocket `NodeLink` implementation
- `runtime/ts/src/ros.ts` — `ReagentOrchestratorServer` class
- `runtime/ts/src/session.ts` — `Session` management

**What works after Phase 1**:
1. Client connects via WS.
2. Client sends `Compile` with `.rg` source → ROS compiles → returns IR + deployment + source map.
3. Client sends `RunStart` → ROS creates a session, deploys agents in-process (using the existing multi-AgentNode RC), triggers the protocol.
4. Trace events stream to the client in real-time via WS.
5. `RunCompleted` sent when the protocol finishes.

**E2E test**: T21 — compile + deploy + run via WS, verify traces arrive and protocol completes.

### Phase 2: Debug infrastructure

**Goal**: breakpoints, stepping, and state inspection.

**New files**:
- `runtime/ts/src/debug-interceptor.ts` — `DebugInterceptor` with held-message queue
- `runtime/ts/src/debug-controller.ts` — `DebugController` coordinating sessions
- Compiler enhancement: source map emission

**What works after Phase 2**:
1. Client sends `SetBreakpointsRequest` with `.rg` source locations → ROS resolves to IR state IDs.
2. Client sends `RunStart` with `mode: "debug"` → protocol runs until breakpoint hit.
3. When a message hits a breakpoint, ROS sends `Stopped` event with state ID and reason.
4. Client sends `DebugCommand` with `command: "continue"` or `command: "step"` → execution resumes.
5. Client sends `GetState` → ROS returns `StateSnapshot` with `$ctx`, `$self`, pending messages, recent traces.

**E2E tests**:
- T22: Set breakpoint on message name, run, verify pause at correct point.
- T23: Inspect `$ctx` and `$self` at pause point, verify values match expected.
- T24: Step through 3 transitions, verify state after each.

### Phase 3: Remote nodes via WsNodeLink

**Goal**: agents can run on remote nodes connected via WebSocket.

**What works after Phase 3**:
1. A node process starts with a `WsNodeLink` config pointing to the ROS.
2. It registers via `AdapterHandshake`.
3. ROS deploys agents to the remote node via `DeployAgent`.
4. Messages route between local and remote nodes via `WsNodeLink`.

### Phase 4: VSCode extension (RAP client)

**Goal**: rich IDE experience for protocol debugging.

**Components**:
- WebSocket RAP client
- Debug panel webview: IR graph visualization, trace timeline, agent state cards
- Breakpoint gutter markers in `.rg` editor
- `launch.json` integration for "Debug Protocol" command
- Inline value decorations (`$ctx.foo = "bar"`) at current `.rg` line

---

## 5. Message flow examples

### 5.1 Compile + run (Phase 1)

```
Client                          ROS
  │                              │
  │─── Compile ─────────────────▶│  compile .rg → IR
  │◀── CompileSuccess ───────────│  return IR + sourceMap
  │                              │
  │─── RunStart ────────────────▶│  create Session
  │                              │  deploy agents (in-process RC)
  │                              │  trigger protocol
  │◀── TraceEvent (stream) ──────│  ProtocolStarted
  │◀── TraceEvent (stream) ──────│  MessageSent
  │◀── TraceEvent (stream) ──────│  MessageReceived
  │◀── TraceEvent (stream) ──────│  ProtocolCompleted
  │◀── RunCompleted ─────────────│
```

### 5.2 Debug session (Phase 2)

```
Client                          ROS
  │                              │
  │─── Compile ─────────────────▶│
  │◀── CompileSuccess ───────────│
  │                              │
  │─── SetBreakpoints ──────────▶│  resolve line 15 → state recv_7
  │◀── BreakpointsResolved ──────│  [{stateId: "recv_7", file: "demo.rg", line: 15}]
  │                              │
  │─── RunStart (mode: debug) ──▶│  deploy + trigger
  │◀── TraceEvent ───────────────│  ProtocolStarted
  │◀── TraceEvent ───────────────│  MessageSent (Greeting)
  │◀── Stopped ──────────────────│  {stateId: "recv_7", reason: "breakpoint"}
  │                              │
  │─── GetState ────────────────▶│
  │◀── StateSnapshot ────────────│  {ctx: {receivedGreeting: "hello"}, self: {...}}
  │                              │
  │─── DebugCommand (step) ─────▶│  release Greeting, pause after next state
  │◀── TraceEvent ───────────────│  MessageReceived
  │◀── TraceEvent ───────────────│  ActionStarted
  │◀── Stopped ──────────────────│  {stateId: "act_8", reason: "step"}
  │                              │
  │─── DebugCommand (continue) ─▶│  release all, run to completion
  │◀── TraceEvent (stream) ──────│  ...
  │◀── RunCompleted ─────────────│
```

---

## 6. Key design decisions

### 6.1 ROS as a Reagent node

The ROS runs its own `ReagentController`. In the future, infrastructure operations (trace collection, debug control, deployment management) can be modeled as Reagent protocols with dedicated infrastructure agents. This is the "self-describing infrastructure" endgame, but for Phase 1 the ROS uses direct API calls to the RC.

### 6.2 DebugInterceptor vs. SteppableProtocolInstance

Two approaches were considered:

**Option A: Message-level (DebugInterceptor)**
- Intercept messages in the RC's pipeline.
- Hold messages to pause execution.
- Coarse-grained: pauses at message boundaries.

**Option B: State-level (SteppableProtocolInstance)**
- Hook into `ProtocolInstance._advance()`.
- Pause before each state transition.
- Fine-grained: pauses at every IR state.

**Decision**: Phase 2 implements **Option A** (message-level) first. It works with the existing interceptor chain, requires no `ProtocolInstance` changes, and covers the most useful debug scenarios (pause on message X, inspect state, step through messages). Option B can be layered on later for sub-state stepping if needed.

### 6.3 Source map format

Source maps are emitted by the compiler (not the runtime). The compiler knows the mapping from AST nodes to IR states. The ROS loads the source map at session creation time and uses it for breakpoint resolution.

### 6.4 No NATS dependency

The ROS uses `ReagentController` + `NativeAgentNode`/`PythonAgentNode` + `InMemoryNodeLink`/`WsNodeLink`. NATS is not required. Existing NATS-based tests continue to work via `NatsCompatTransport` but are not part of the M6 architecture.

---

## 7. Files inventory (planned)

| File | Purpose | Phase |
|---|---|---|
| `runtime/ts/src/ws-node-link.ts` | WebSocket NodeLink | 1 |
| `runtime/ts/src/ros.ts` | ReagentOrchestratorServer | 1 |
| `runtime/ts/src/session.ts` | Session management | 1 |
| `runtime/ts/src/debug-interceptor.ts` | DebugInterceptor with held-message queue | 2 |
| `runtime/ts/src/debug-controller.ts` | DebugController (breakpoints, step, inspect) | 2 |
| `lang/src/source-map.ts` | Source map emission from compiler | 2 |
| `runtime/tests/m6-ros.test.ts` | ROS E2E tests (T21–T24) | 1-2 |

---

## 8. DoD

- ROS boots, accepts WS connections, compiles `.rg`, deploys agents in-process, runs protocols, streams traces.
- `WsNodeLink` works for remote node connectivity.
- `DebugInterceptor` pauses on message breakpoints, supports step/continue.
- `DebugController` resolves source-level breakpoints via source map.
- `InspectState` returns `$ctx`, `$self`, pending messages for paused agents.
- T21 (compile + run via WS), T22 (breakpoint pause), T23 (state inspection), T24 (step-through) pass.
