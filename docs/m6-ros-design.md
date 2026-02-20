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

External tools (VSCode extension, CLI, web UI) connect to the ROS via **WebSocket** using the **RAP protocol** (7 sub-protocols specced as `.rg` files with role definitions in `tools/rap/`).

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

### 2.4 Two-level debug: DebugInterceptor + AdvanceHook

Debugging operates at two levels, matching the two-level interception model from M5-CTRL:

1. **Message-level** (`DebugInterceptor`) — intercepts `MessageEnvelope` traffic in the RC pipeline. Pauses *before delivery* to an agent.
2. **State-level** (`AdvanceHook`) — intercepts IR state transitions *inside* `ProtocolInstance.advance()`. Pauses before each state executes, including agent zones (`action` states).

Both levels are needed because message-level alone cannot see what happens inside an agent after a message is delivered — zone execution, guard evaluation, internal state transitions are invisible at the RC layer.

#### 2.4.1 DebugInterceptor — message-level breakpoints

The existing interceptor chain from M5-CTRL already supports dropping messages (interceptor doesn't call `next()`). For debugging, we extend this to **hold** messages in a queue for later release.

```typescript
interface HeldMessage {
  envelope: MessageEnvelope;
  direction: MessageDirection;
  release: () => void;       // call to deliver the message
  drop: () => void;          // call to permanently discard
}

class DebugInterceptor {
  private breakpoints: Set<string>;            // message names
  private heldMessages: HeldMessage[];
  private paused: boolean;

  /** The InterceptorFn installed in the RC's chain. */
  interceptor: InterceptorFn;

  setBreakpoints(bps: string[]): void;
  continue(): void;                            // release all held, resume
  stepMessage(): void;                         // release one message, then pause again
  getHeld(): HeldMessage[];
}
```

The `DebugInterceptor` is injected into the RC's interceptor chain. When a message matches a breakpoint, the interceptor:
1. Stores the envelope + a `release` callback (which calls `next()`) in `heldMessages`.
2. Emits a `Paused` event to the debug client with `reason: "message-breakpoint"`.
3. Does **not** call `next()` — the message is held.

When the client sends `continue` or `stepMessage`, the controller calls `release()` on held messages.

#### 2.4.2 AdvanceHook — state-level breakpoints (zone-aware)

The `ProtocolInstance.advance()` method is a `while` loop that walks the IR state machine. It processes states in sequence: `initial` → `send` → `receive` → `action` → `guard` → ... → `terminal`. Currently it runs to completion or until it awaits a message.

We introduce an **AdvanceHook** — an async callback injected into `ProtocolInstance` that fires *before each state is processed*:

```typescript
type AdvanceHook = (context: AdvanceHookContext) => Promise<void>;

interface AdvanceHookContext {
  instanceId: string;
  agentName: string;
  stateId: string;
  stateKind: string;                // "send" | "receive" | "action" | "guard" | "timer" | "fork" | "terminal" | ...
  ctx: Record<string, unknown>;     // current $ctx (read-only snapshot)
  self: Record<string, unknown>;    // current $self (read-only snapshot)
}
```

The hook is inserted at the top of the `advance()` while loop:

```typescript
private async advance(): Promise<void> {
  while (this.status === "running") {
    const state = this.stateMap.get(this.currentStateId);
    if (!state) throw new Error(`State ${this.currentStateId} not found`);

    // >>> AdvanceHook fires here — can await indefinitely (pause) <<<
    if (this.advanceHook) {
      await this.advanceHook({
        instanceId: this.instanceId,
        agentName: this.agentName,
        stateId: state.id,
        stateKind: state.data.kind,
        ctx: { ...this.ctx },
        self: { ...this.selfRef },
      });
    }

    // ... existing switch (state.data.kind) ...
  }
}
```

The hook is `async` — it returns a `Promise`. When the debugger wants to pause, the hook returns a promise that resolves only when the client sends `continue` or `step`. This blocks `advance()` without busy-waiting or polling.

**DebugAdvanceHook** wraps this into a debugger-aware implementation:

```typescript
class DebugAdvanceHook {
  private stateBreakpoints: Set<string>;     // IR state IDs
  private stepMode: "off" | "stepOver" | "stepInto";
  private gate: PromiseGate | null;          // resolves when client says go

  hook: AdvanceHook;

  setStateBreakpoints(stateIds: string[]): void;
  continue(): void;                           // resolve gate, stepMode = off
  stepState(): void;                          // resolve gate, stepMode = stepInto (pause at next state)
  stepOver(): void;                           // resolve gate, skip actions, pause at next message send/receive
}
```

When the hook fires:
1. Check if `stateId` is in `stateBreakpoints`, or `stepMode !== "off"`.
2. If pausing: create a `PromiseGate`, emit `Stopped` event with `{ stateId, stateKind, reason }`, await the gate.
3. The hook promise resolves when the client calls `continue()` / `stepState()` / `stepOver()` on the controller.

**Step modes**:

| Mode | Behavior | Use case |
|---|---|---|
| `stepState` | Pause before every IR state | Fine-grained: see each zone, guard, send, receive |
| `stepOver` | Pause only before `send`, `receive`, `terminal` states | Skip zone internals, step message-by-message within one agent |
| `stepMessage` (DebugInterceptor) | Hold next message in RC pipeline | Step at agent boundaries — pause before delivery |
| `continue` | Run until next breakpoint or completion | Normal run |

#### 2.4.3 Interaction between the two levels

The two levels complement each other:

- **DebugInterceptor** pauses message delivery *between* agents at the RC level. The receiving agent hasn't executed any code yet.
- **AdvanceHook** pauses *within* an agent's state machine. Once a message is delivered and the agent starts processing it, the AdvanceHook governs stepping through the agent's internal states.

A typical debug flow:
1. DebugInterceptor holds a `Greeting` message at the RC level → client sees "Greeting about to be delivered to AgentB".
2. Client calls `stepMessage` → message is released to AgentB.
3. AgentB's `ProtocolInstance` receives the message, enters `receive` state, then tries to advance to the next state (`action` = zone).
4. AdvanceHook fires before the `action` state → client sees "AgentB about to execute zone at act_8" with current `$ctx` (including `$ctx.msg` from the received message).
5. Client inspects `$ctx.msg`, calls `stepState` → zone executes → AdvanceHook fires at the next state.

For Python agents, the AdvanceHook is not directly available (the state machine runs in a child process). Instead, the `PythonAgentNode` IPC bridge exposes equivalent functionality:
- A `pauseBeforeState` IPC command configures the Python `ProtocolInstance` to emit `{"type": "paused", "stateId": "...", ...}` and await a `{"type": "resume"}` command before continuing.
- The `DebugController` translates between the unified debug API and the per-language mechanism.

### 2.5 DebugController — coordinates debug operations

```typescript
class DebugController {
  private interceptors: Map<string, DebugInterceptor>;     // per session
  private advanceHooks: Map<string, DebugAdvanceHook[]>;   // per session, one per agent

  setBreakpoints(sessionId: string, locations: BreakpointLocation[]): ResolvedBreakpoint[];
  continue(sessionId: string): void;
  stepMessage(sessionId: string): void;           // message-level step (DebugInterceptor)
  stepState(sessionId: string, agentName?: string): void;  // state-level step (AdvanceHook)
  stepOver(sessionId: string, agentName?: string): void;   // skip zones, step to next message op
  inspectState(sessionId: string, agentName: string): StateSnapshot;
}
```

Breakpoints can be set on:

- **Message names**: pause when a message with that name is about to be delivered (DebugInterceptor).
- **Source locations**: `.rg` file + line → resolved to IR state ID via source map (AdvanceHook).
- **IR state IDs**: direct low-level breakpoint (AdvanceHook).
- **State kinds**: e.g. "all action states" — pause before every zone executes (AdvanceHook).

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

**Goal**: two-level breakpoints (message + state), stepping, zone-aware pausing, and state inspection.

**New files**:
- `runtime/ts/src/debug-interceptor.ts` — `DebugInterceptor` with held-message queue (message-level)
- `runtime/ts/src/debug-advance-hook.ts` — `DebugAdvanceHook` with promise-gate pausing (state-level)
- `runtime/ts/src/debug-controller.ts` — `DebugController` coordinating both levels
- Compiler enhancement: source map emission

**ProtocolInstance change**: add optional `advanceHook: AdvanceHook` to config. Single `await this.advanceHook(...)` at top of `advance()` while loop. No other changes to state machine logic.

**Python IPC extension**: add `pauseBeforeState` / `resume` commands to the IPC protocol. Python `ProtocolInstance` gains the same hook point.

**What works after Phase 2**:
1. Client sends `SetBreakpointsRequest` with `.rg` source locations or message names → ROS resolves locations to IR state IDs via source map, classifies as message-level or state-level breakpoints.
2. Client sends `RunStart` with `mode: "debug"` → protocol runs until breakpoint hit.
3. **Message breakpoint**: RC holds the message → `Stopped` event with `reason: "message-breakpoint"`.
4. **State breakpoint**: AdvanceHook pauses before the IR state → `Stopped` event with `reason: "state-breakpoint"`, includes `stateKind` (e.g. `"action"` for zones).
5. Client sends `DebugCommand`:
   - `stepMessage` → release one held message, pause at next message delivery.
   - `stepState` → advance one IR state, pause before next state (catches every zone).
   - `stepOver` → advance until next `send`/`receive`/`terminal` state (skips zone internals).
   - `continue` → run until next breakpoint or completion.
6. Client sends `GetState` → ROS returns `StateSnapshot` with `$ctx`, `$self`, `currentStateId`, `stateKind`, pending messages, recent traces.

**E2E tests**:
- T22: Set breakpoint on message name, run, verify pause at correct point (message-level).
- T23: Inspect `$ctx` and `$self` at pause point, verify values match expected.
- T24: Step through 3 message-level transitions, verify state after each.
- T25: Set breakpoint on `action` state (zone), run, verify pause *before zone executes* with pre-zone `$ctx` (state-level).
- T26: `stepState` through receive → action → send, verify `$ctx` changes at each step.

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

### 5.2 Debug session — message-level (Phase 2)

```
Client                          ROS
  │                              │
  │─── Compile ─────────────────▶│
  │◀── CompileSuccess ───────────│
  │                              │
  │─── SetBreakpoints ──────────▶│  message breakpoint: "Greeting"
  │◀── BreakpointsResolved ──────│  [{type: "message", messageName: "Greeting"}]
  │                              │
  │─── RunStart (mode: debug) ──▶│  deploy + trigger
  │◀── TraceEvent ───────────────│  ProtocolStarted
  │◀── TraceEvent ───────────────│  MessageSent (Greeting)
  │◀── Stopped ──────────────────│  {reason: "message-breakpoint", messageName: "Greeting",
  │                              │   from: "AgentA", to: "AgentB"}
  │─── GetState (AgentB) ───────▶│
  │◀── StateSnapshot ────────────│  {ctx: {}, self: {...}}  ← message not yet delivered
  │                              │
  │─── DebugCommand (stepMsg) ──▶│  release Greeting to AgentB
  │◀── TraceEvent ───────────────│  MessageReceived
  │◀── TraceEvent ───────────────│  ActionStarted → ActionFinished
  │◀── TraceEvent ───────────────│  MessageSent (Reply)
  │◀── Stopped ──────────────────│  {reason: "message-breakpoint", messageName: "Reply"}
  │                              │
  │─── DebugCommand (continue) ─▶│  run to completion
  │◀── TraceEvent (stream) ──────│  ...
  │◀── RunCompleted ─────────────│
```

### 5.3 Debug session — state-level with zone stepping (Phase 2)

```
Client                          ROS                          AgentB's ProtocolInstance
  │                              │                              │
  │─── SetBreakpoints ──────────▶│  state breakpoint on line 18 │
  │◀── BreakpointsResolved ──────│  [{stateId: "act_8"}]        │
  │                              │                              │
  │─── RunStart (mode: debug) ──▶│  deploy + trigger            │
  │◀── TraceEvent ───────────────│  ProtocolStarted             │
  │◀── TraceEvent ───────────────│  MessageSent (Greeting)      │
  │◀── TraceEvent ───────────────│  MessageReceived             │
  │                              │                 advance() ──▶│ recv_7 processed ✓
  │                              │                              │ advance hook fires at act_8
  │◀── Stopped ──────────────────│  {stateId: "act_8",          │ ← promise gate blocks advance()
  │                              │   stateKind: "action",       │
  │                              │   reason: "state-breakpoint"}│
  │                              │                              │
  │─── GetState (AgentB) ───────▶│                              │
  │◀── StateSnapshot ────────────│  {ctx: {msg: {text: "hi"}},  │ ← $ctx.msg set, zone NOT yet run
  │                              │   self: {counter: 0},        │
  │                              │   stateId: "act_8",          │
  │                              │   stateKind: "action"}       │
  │                              │                              │
  │─── DebugCommand (stepState) ▶│                              │
  │                              │              gate resolves ──▶│ act_8 zone executes
  │◀── TraceEvent ───────────────│  ActionStarted               │
  │◀── TraceEvent ───────────────│  ActionFinished              │
  │                              │                              │ advance hook fires at send_9
  │◀── Stopped ──────────────────│  {stateId: "send_9",         │ ← zone done, about to send Reply
  │                              │   stateKind: "send",         │
  │                              │   reason: "step"}            │
  │                              │                              │
  │─── GetState (AgentB) ───────▶│                              │
  │◀── StateSnapshot ────────────│  {ctx: {reply: "processed"}, │ ← $ctx updated by zone
  │                              │   self: {counter: 1}}        │ ← $self updated by zone
  │                              │                              │
  │─── DebugCommand (continue) ─▶│              gate resolves ──▶│ runs to terminal
  │◀── TraceEvent (stream) ──────│  ...                         │
  │◀── RunCompleted ─────────────│                              │
```

---

## 6. Key design decisions

### 6.1 ROS as a Reagent node

The ROS runs its own `ReagentController`. In the future, infrastructure operations (trace collection, debug control, deployment management) can be modeled as Reagent protocols with dedicated infrastructure agents. This is the "self-describing infrastructure" endgame, but for Phase 1 the ROS uses direct API calls to the RC.

### 6.2 Two-level debugging (DebugInterceptor + AdvanceHook)

Two approaches were considered and both adopted — they operate at different granularities:

**Level A: Message-level (DebugInterceptor)**
- Intercept messages in the RC's pipeline.
- Hold messages to pause execution *between* agents.
- Coarse-grained: pauses at message delivery boundaries.

**Level B: State-level (AdvanceHook)**
- Hook into `ProtocolInstance.advance()` loop.
- Pause before each state transition *within* an agent.
- Fine-grained: pauses at every IR state including agent zones (`action`), guards, timers.

**Decision**: both levels are implemented in Phase 2. Message-level covers "stop before this message reaches the agent" scenarios. State-level covers "step through the zone code that processes this message" scenarios. Without state-level, zones are black boxes — the debugger can't pause before/after zone execution, which is critical for debugging agent logic.

The AdvanceHook is a minimal change to `ProtocolInstance`: a single `await` at the top of the `advance()` while loop. The hook's async nature means pause/resume is just promise resolution — no polling, no busy-waiting, no changes to the state machine logic itself.

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
| `runtime/ts/src/debug-interceptor.ts` | DebugInterceptor with held-message queue (message-level) | 2 |
| `runtime/ts/src/debug-advance-hook.ts` | DebugAdvanceHook with promise-gate pausing (state-level) | 2 |
| `runtime/ts/src/debug-controller.ts` | DebugController coordinating both debug levels | 2 |
| `lang/src/source-map.ts` | Source map emission from compiler | 2 |
| `runtime/tests/m6-ros.test.ts` | ROS E2E tests (T21–T26) | 1-2 |

---

## 8. DoD

- ROS boots, accepts WS connections, compiles `.rg`, deploys agents in-process, runs protocols, streams traces.
- `WsNodeLink` works for remote node connectivity.
- **Message-level debug**: `DebugInterceptor` pauses on message breakpoints, supports `stepMessage`/`continue`.
- **State-level debug**: `AdvanceHook` in `ProtocolInstance` pauses before any IR state (including zones). `DebugAdvanceHook` supports `stepState`/`stepOver`/`continue`.
- `DebugController` resolves source-level breakpoints via source map, coordinates both debug levels.
- `InspectState` returns `$ctx`, `$self`, `currentStateId`, `stateKind`, pending messages for paused agents.
- T21 (compile + run via WS), T22 (message breakpoint), T23 (state inspection), T24 (message step-through), T25 (zone breakpoint), T26 (state-level stepping) pass.
