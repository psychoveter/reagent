# RFC: Reagent as MCP Server (MCP Gate)

**Date:** 2026-03-08 (updated 2026-03-09)
**Status:** Implementation started (P1 done)
**Area:** runtime/ts, integration
**Depends on:** Message Gate (done), CustomAgentNode (done), ROS (done),
  RemoteNode (done)

---

## Motivation

LLM-powered coding agents (Claude Code, Cursor, OpenClaw) already speak MCP.
If Reagent RC exposes an MCP server, any MCP client can become a first-class
protocol participant: send messages, receive events, join sessions — without
custom SDKs or transport adapters.

This turns Reagent into a **coordination backbone for agentic ecosystems**:
a Claude Code session can participate in a review protocol with a human,
another LLM, and a CI bot — all orchestrated by a single `.rg` file.

### Why not just use existing Gate transports?

Existing `WsGateTransport` / `StdioGateTransport` / `HttpGateTransport` work
for purpose-built agents. But MCP clients (Claude Code, Cursor, etc.) don't
speak the Gate wire format — they speak MCP (JSON-RPC + tools). An MCP Gate
bridges the two worlds without requiring changes on the client side.

---

## Design

### Execution model: CustomAgentNode-style

**Decision: the ProtocolEngine runs on the RC side (inside RemoteNode), not
on the MCP client.** The engine handles send/receive routing, timers, guards,
invokes, and all FSM transitions automatically. The MCP agent only sees
**zone events** — the points where the protocol needs the agent to make a
decision or produce data.

This is the same model as `CustomAgentNode`: the engine calls
`AgentInterface.handle(event)` only for `action`, `pre_send_action`, and
`post_receive_action` events. The MCP Gate translates these into MCP tool
interactions.

```
What the agent sees via wait_for_events:
  ✓ action                — zone code, agent must compute and respond
  ✓ pre_send_action       — onSend hook, agent prepares message payload
  ✓ post_receive_action   — onReceive hook, agent processes received message
  ✓ protocol_started      — informational notification
  ✓ protocol_completed    — informational notification
  ✓ protocol_failed       — informational notification

What the engine handles automatically (invisible to agent):
  ✗ send                  — engine builds envelope, routes via transport
  ✗ receive               — engine waits for message, delivers to ctx
  ✗ timer                 — engine handles timeout
  ✗ guard / join          — engine evaluates, follows transition
  ✗ invoke / spawn        — engine delegates to RC
```

**Why this model?**
- Simpler agent: doesn't need to understand routing, addressing, FSM
- Correct by construction: engine enforces protocol choreography
- Same contract as in-process agents: protocol behavior is identical
  regardless of transport
- Smaller tool surface: agent only needs `respond` with `ctx_update`
- Human-friendly: zone code describes what to do, agent (or human) provides
  the answer

### Primary model: persistent agent session

The central design is a **long-lived MCP session** where a Claude Code (or any
MCP client) connects to Reagent RC as a persistent agent. The session is
associated with an **agent identity** — it registers in discovery, can
participate in multiple protocol instances simultaneously, and receives
incoming events via a **long-poll tool call**.

```
Agent session lifecycle:

  1. Agent starts mcp-gate as subprocess (stdio MCP server)
  2. reagent/register(agentName, roles[])     → agent appears in discovery
  3. reagent/wait_for_events(timeout?)        → BLOCKS until event arrives
  4.   ← returns [{instanceId, event}]        (only zone/lifecycle events)
  5. reagent/respond(instanceId, response)    → engine processes, advances FSM
  6. goto 3 (loop)
  ...
  N. reagent/unregister()                     → agent leaves discovery
```

The key insight: **`reagent/wait_for_events` is a blocking MCP tool call**.
The MCP server holds the JSON-RPC response until an event is available (or
timeout expires). From the agent's perspective, it calls a tool and waits —
the same way it would call any slow tool (e.g. a build or test runner).
When the tool returns, the agent sees the event, reasons about it, responds
via `reagent/respond`, then calls `wait_for_events` again.

```
MCP Client (agent)                   mcp-gate subprocess (MCP server, stdio)
    │                                        │
    │  tool: reagent/register("claude-1",    │
    │         roles: ["reviewer"])            │
    │ ──── stdin JSON-RPC ─────────────────► │  → agent registered
    │  ◄── stdout JSON-RPC ──────────────── │  {ok, agentId}
    │                                        │
    │  tool: reagent/wait_for_events()       │
    │ ──── stdin ──────────────────────────► │
    │                    ...                  │  (engine runs, reaches zone)
    │                                        │
    │  ◄── stdout ─────────────────────────  │  [{instanceId: "rev-42",
    │                                        │    event: {type: "action",
    │                                        │     body: "$ctx.feedback = ...",
    │                                        │     ctx: {msg: {diff: "..."}}}}]
    │                                        │
    │  (agent reasons about the event)       │
    │                                        │
    │  tool: reagent/respond("rev-42",       │
    │    {ctx: {feedback: {verdict: "ok"}}}) │
    │ ──── stdin ──────────────────────────► │  → engine continues
    │  ◄── stdout ─────────────────────────  │  {ok}
    │                                        │
    │  tool: reagent/wait_for_events()       │
    │ ──── stdin ──────────────────────────► │  (blocks again)
```

### Properties of the persistent session model

**Agent identity.** The MCP session is bound to a named agent (`agentName`).
This agent registers its roles with RC, appears in the agent registry and
discovery, and is addressable by name — exactly like an in-process agent.

**Multi-instance participation.** One agent session handles events from
multiple protocol instances. `wait_for_events` returns events from any
instance where this agent participates. The agent multiplexes by `instanceId`.

**Multi-protocol participation.** The agent declares which roles it can play
at registration time. RC can assign it to any matching protocol via triggers
or explicit instantiation.

**Natural backpressure.** The agent processes events at its own pace.
RC queues events for this agent until it's ready. No event is lost.

**Graceful disconnect.** If the MCP connection drops, RC detects the
transport close and either:
- Marks the agent as unavailable in discovery (protocol instances wait/timeout)
- Fires a `system.agent.disconnected` event for supervision protocols

Reconnection: a new session calling `reagent/register` with the same
`agentName` can resume (RC re-delivers pending events).

### MCP tools exposed by RC

```
── Agent lifecycle ──

reagent/register(agentName, roles, capabilities?)
  → {agentId, registeredRoles}
  Registers this MCP session as a named agent. Agent appears in
  discovery and can be assigned to protocol instances.

reagent/unregister()
  → {ok}
  Removes agent from discovery. Pending protocol instances receive
  an agent-disconnected event.

── Event loop ──

reagent/wait_for_events(timeout_ms?, max_events?)
  → [{instanceId, protocolName, role, event: ProtocolEvent}]
  Long-poll: blocks until at least one event is available for this agent,
  or timeout expires (returns [] on timeout). Only returns zone events
  (action, pre_send_action, post_receive_action) and lifecycle events
  (protocol_started, protocol_completed, protocol_failed).

── Protocol interaction ──

reagent/respond(instanceId, response: AgentResponse)
  → {ok, nextState?}
  Submit response for a specific protocol instance event. Typically
  {type: "ctx_update", ctx: {...}} for zone events.

── Protocol initiation ──

reagent/invoke(protocolName, input, roleBindings?)
  → {instanceId}
  Creates a new protocol instance. The calling agent is bound as the
  initiator. Other roles are resolved via the standard resolve pipeline.
  On a RemoteNode, relayed through ROS for cross-node instantiation.

── Introspection ──

reagent/list_protocols()
  → [{name, version, roles, description}]

reagent/list_instances()
  → [{instanceId, protocolName, status, myRole, pendingEvents}]

reagent/get_state(instanceId)
  → {currentState, protocolStatus, ctx}

reagent/get_pending_events(instanceId?)
  → [ProtocolEvent, ...]
  Non-blocking variant of wait_for_events. Returns immediately.
```

### `wait_for_events` semantics

**Long-poll behavior:**
- RC holds the JSON-RPC response open until an event arrives or timeout
- Default timeout: 30s (configurable). On timeout, returns `[]`
- Agent calls again immediately after processing — creating a continuous loop
- `max_events` limits batch size (default: 1 for LLM agents)

**Event filtering:**
- Only zone events and lifecycle events are surfaced
- Send/receive/timer/guard transitions happen inside the engine silently
- The agent never sees routing details or FSM internals

**Event ordering:**
- Events are delivered in protocol-causal order per instance
- Across instances, events are ordered by arrival time
- Each event has a monotonic sequence number for dedup on reconnect

**At-least-once delivery:**
- Events are not acked until `reagent/respond` is called
- If agent disconnects before responding, events are re-delivered on reconnect
- `respond` with a stale/duplicate sequence number is a no-op (idempotent)

**Timeout tuning for LLM agents:**
- Claude Code has tool-call timeouts (typically 60–120s)
- `wait_for_events(timeout_ms: 25000)` stays well under the limit

---

## Architecture

### Transport: stdio subprocess

MCP Gate uses **stdio transport** (stdin/stdout JSON-RPC). The agent
(Claude Code, Cursor) starts `mcp-gate` as a subprocess. This is the
standard MCP pattern — no HTTP ports, no network configuration.

Agent configuration (e.g. Claude Code `.mcp.json` or Cursor `.cursorrules`):
```json
{
  "reagent": {
    "command": "node",
    "args": ["path/to/mcp-gate.js", "--admin-url", "ws://localhost:7400", "--node-id", "claude-1"]
  }
}
```

### Inter-RC communication

Message routing between RCs uses **NATS** or **NodeLink** (peer-to-peer
or via NAT). The **admin host is not a message router** — it only handles compile,
deploy, debug, and monitoring. Envelopes travel directly between RC
instances through the configured transport layer.

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                           NATS / NodeLink                        │
  │              (inter-RC envelope transport, peer-to-peer)         │
  └──────┬──────────────────────┬──────────────────────┬─────────────┘
         │                      │                      │
         ▼                      ▼                      ▼
  ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
  │ mcp-gate       │   │ mcp-gate       │   │ mcp-gate       │
  │ (node-human)   │   │ (node-consult) │   │ (node-research)│
  │                │   │                │   │                │
  │ RC             │   │ RC             │   │ RC             │
  │ ProtocolEngine │   │ ProtocolEngine │   │ ProtocolEngine │
  │ McpAgentAdapter│   │ McpAgentAdapter│   │ McpAgentAdapter│
  │ MCP stdio ↕    │   │ MCP stdio ↕    │   │ MCP stdio ↕    │
  └───────┬────────┘   └───────┬────────┘   └───────┬────────┘
          │ stdin/stdout        │ stdin/stdout        │ stdin/stdout
          ▼                     ▼                     ▼
  ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
  │ Cursor (human) │   │ Claude Code    │   │ Claude Code    │
  │ MCP client     │   │ MCP client     │   │ MCP client     │
  └────────────────┘   └────────────────┘   └────────────────┘

  ┌──────────────────────────────────────────────────────────────────┐
  │  ROS (compile, deploy, debug, monitor)  — NOT a message router   │
  └──────────────────────────────────────────────────────────────────┘
```

### McpAgentAdapter (replaces McpGateTransport)

Since MCP Gate follows the CustomAgentNode model (engine runs on RC side),
the adapter is **not a `GateTransport` implementation**. It is an
`AgentInterface` adapter that bridges `handle()` calls to MCP tool
interactions via an event queue.

```typescript
class McpAgentAdapter implements AgentInterface {
  private eventQueue: AsyncQueue<QueuedEvent> = new AsyncQueue();
  private pendingResolve: ((response: AgentResponse) => void) | null = null;

  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    // Push event to queue (unblocks wait_for_events)
    this.eventQueue.push({ instanceId: this.currentInstanceId, event });

    // Wait for agent to call reagent/respond
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  // Called by MCP tool handler for wait_for_events
  async waitForEvents(timeout: number, max: number): Promise<QueuedEvent[]> {
    return this.eventQueue.drain(timeout, max);
  }

  // Called by MCP tool handler for respond
  deliverResponse(instanceId: string, response: AgentResponse): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(response);
    }
  }
}
```

Key difference from the v1 RFC: **no `GateTransport`, no `GateSession`, no
`MessageGateNode`**. The MCP adapter sits at the `AgentInterface` level,
same as `ManagedAgentAdapter` (which executes zone code in-process). The
engine loop in `CustomAgentHandle.runEngine()` calls `handle()` for zones
and handles everything else internally.

### mcp-gate: standalone subprocess

Instead of modifying RemoteNode, MCP Gate is a **separate entry-point**
(`mcp-gate.ts`) that creates its own RC + CustomAgentNode + McpAgentAdapter.
It connects to ROS for deploy/trigger commands, and uses NATS/NodeLink
for inter-RC message routing — same as any other RC node.

```typescript
// mcp-gate.ts creates:
const adapter = new McpAgentAdapter(nodeId);
const mcpNode = new CustomAgentNode({
  roleToAgent,
  agentFactory: () => adapter,
});
const rc = new ReagentController({ nodeId, agentNodes: { ts: mcpNode } });

// Connects to ROS for deploy/trigger, starts MCP stdio server
const mcpServer = new ReagentMcpServer({ adapter });
await mcpServer.startStdio();
```

When ROS sends `Deploy`, the mcp-gate process registers the agent with
its local RC using `CustomAgentNode` backed by `McpAgentAdapter`. The
engine loop starts but blocks on the first zone event until the MCP
client calls `reagent/register` and `reagent/wait_for_events`.

### Envelope routing

Inter-RC message routing uses NATS or NodeLink — the standard Reagent
transport layer. **ROS is not involved in message routing.** Each mcp-gate
process configures its RC with the same transport as any other node.

---

## Human-in-the-loop via Cursor

The MCP Gate is not only for LLM agents. A human using Cursor can
participate in protocols through the same mechanism.

### Hybrid model

Cursor is an MCP client that bridges you (the human) with the Reagent
protocol. Unlike an LLM agent that auto-loops, Cursor operates in a
**human-driven hybrid mode**:

1. **Cursor calls `wait_for_events`** — blocks until the protocol has
   something for you
2. **Event arrives** — Cursor shows you the zone code context:
   "The protocol wants you to formalize this intuition. Here's the current
   context: [shows ctx fields]"
3. **You do work** — read files, search the web, analyze code, think.
   Cursor executes your requests using its other tools.
4. **You dictate the response** — "respond with this formalization..."
5. **Cursor calls `reagent/respond`** with your input
6. **Cursor automatically calls `wait_for_events` again** — the loop
   continues without you having to say "wait for next event"

### System prompt for Cursor (`.cursorrules`)

```
You are connected to a Reagent protocol network via the "reagent" MCP server.

Workflow:
1. On user request, call reagent/register with the given agent name and roles.
2. Call reagent/wait_for_events to start receiving events.
3. When an event arrives, show the user:
   - Event type (action / pre_send / post_receive / lifecycle)
   - Zone body (what the protocol expects)
   - Relevant ctx fields
   - Ask what they want to do
4. User may ask you to perform tasks before responding (read files, search,
   analyze). Do those first.
5. When ready, call reagent/respond with their input as ctx_update.
6. After responding, immediately call reagent/wait_for_events again.
7. On protocol_completed/failed, notify and stop the loop.
8. On empty wait (timeout), call wait_for_events again silently.

Never auto-respond to events. Always show the user and wait for their input.
```

---

## Alternative push strategies (supplementary)

### AgentLauncher (stateless, per-event)

For cases where a persistent session is impractical (serverless, one-shot
tasks), RC can spawn a fresh agent session per event.

```typescript
interface AgentLauncher {
  launch(event: ProtocolEvent, context: LaunchContext): Promise<AgentResponse>;
}
```

Built-in launchers:
- `ClaudeCodeLauncher` — spawns `claude` CLI with MCP server configured
- `AnthropicApiLauncher` — calls Messages API with tools
- `GenericCliLauncher` — spawns any MCP-aware CLI agent

This is a **fallback**. It does not register in discovery.

### MCP Notifications + SSE (future)

When MCP clients support reactive notifications (server notification →
triggers new reasoning chain), RC can push events instead of long-poll.
This is the most elegant model but depends on client support.

---

## Interaction with existing architecture

### Fits alongside CustomAgentNode

`McpAgentAdapter` implements `AgentInterface`, same as `ManagedAgentAdapter`.
It plugs into `CustomAgentNode` which wraps it with `CustomAgentHandle` +
`ProtocolEngine`. No changes to the engine or the agent node abstractions.

### No language changes

Purely a runtime/transport feature. No changes to `.rg` syntax, IR, or
compiler. A protocol doesn't know whether its participants are in-process
or MCP-connected.

### Agent configuration

Agents connecting via MCP are self-describing — they register their roles
at connect time. For pre-configured agents (RC knows to expect an MCP agent):

```json
{
  "agents": {
    "claude-reviewer": {
      "role": "CodeReview.reviewer",
      "transport": "mcp",
      "mcp": {
        "mode": "persistent",
        "systemPrompt": "You are a code reviewer...",
        "reconnectPolicy": "wait-30s"
      }
    }
  }
}
```

### Relationship to A2A

MCP Gate: Reagent RC is the authority; agent participates via tools.
A2A: Reagent RC peers with another agent system; mutual protocol.
Complementary.

---

## Example: simple.rg with Cursor + two Claude Code agents

See: `examples/projects/autoscience/RFC-simple-run.md` for full walkthrough.

Summary:
- ROS compiles `simple.rg`, deploys to 3 RemoteNodes
- Each RemoteNode runs in MCP mode with `McpAgentAdapter`
- Human (Cursor) connects to node-human's MCP server
- Claude Code agents (Docker) connect to their respective nodes
- Messages between agents route: RemoteNode → ROS → RemoteNode
- All agents see only zone events via `wait_for_events`

---

## Phasing

| Phase | What | Status | Notes |
|-------|------|--------|-------|
| P1 | `AsyncQueue` + `McpAgentAdapter` implementing `AgentInterface` | **DONE** | `async-queue.ts`, `mcp-agent-adapter.ts` |
| P1 | `ReagentMcpServer` with stdio transport + all MCP tools | **DONE** | `mcp-server.ts` — register/wait/respond/invoke/list/state |
| P2 | `mcp-gate.ts` entry-point: RC + CustomAgentNode + McpAgentAdapter + MCP stdio | **DONE** | Standalone subprocess, connects to ROS for deploy/trigger |
| P3 | E2E test: mcp-gate + ROS + Claude Code (Docker) | TODO | First real agent integration |
| P4 | `reagent/invoke` tool + trigger relay through ROS | TODO | Agents can initiate protocols from MCP |
| P5 | Streamable HTTP transport option for MCP server | TODO | For Docker/remote agents (supplement stdio) |
| P6 | Reconnection, session resumption, pending event replay | TODO | Production resilience |
| P7 | `AgentLauncher` (stateless fallback) | TODO | For serverless / one-shot scenarios |

---

## Open questions

1. **Claude Code tool-call timeout.** If `wait_for_events` blocks for 25s
   and no event arrives, it returns `[]`. Claude Code must call again. Will
   Claude Code reliably loop on empty results, or will it decide "nothing to
   do" and stop? May need explicit prompt engineering.

2. **Context window growth.** Repeated `wait_for_events` → `respond` cycles
   accumulate in Claude Code's context. Mitigation:
   - Claude Code's built-in context management (summarization)
   - `reagent/get_state(instanceId)` for compressed state reconstruction

3. **Concurrent events.** Multiple events queue; `max_events` controls batch
   size. LLM agents should use `max_events: 1`.

4. **Authentication.** Streamable HTTP needs token-based auth. RC could issue
   a registration token.

5. **Multiple sessions per agent.** Can two MCP clients register as the same
   agent? Options: reject, load-balance, failover.

6. **Cost control.** Prompt should make the loop mechanical to avoid wasted
   tokens on "should I keep waiting?" reasoning.

7. **Zone code interpretation.** LLM agents receive zone `body` as a string
   (e.g., `$ctx.formalClaim = await $agent.formalize($ctx.msg)`). They must
   interpret it as a task description. Consider adding a `description` field
   to zone IR for human-readable intent.

8. **Cursor long-poll UX.** When Cursor calls `wait_for_events`, can the user
   still type in the chat? Does Cursor show a waiting indicator? Needs testing.

---

## References

- **MCP Gate implementation:**
  - `runtime/ts/src/gate/async-queue.ts` — AsyncQueue with timeout drain
  - `runtime/ts/src/mcp/mcp-agent-adapter.ts` — McpAgentAdapter (AgentInterface → MCP)
  - `runtime/ts/src/mcp/mcp-server.ts` — ReagentMcpServer (MCP tools, stdio transport)
  - `runtime/ts/src/mcp-gate.ts` — Entry-point subprocess (RC + MCP stdio)
  - `runtime/ts/test/mcp-adapter.test.ts` — Smoke tests
- **Core abstractions:**
  - CustomAgentNode: `runtime/ts/src/nodes/custom-agent-node.ts`
  - AgentInterface: `runtime/ts/src/core/agent-interface.ts`
  - ProtocolEngine: `runtime/ts/src/core/protocol-engine.ts`
  - Transport: `runtime/ts/src/contracts/transport.ts`
- **Infrastructure:**
  - RemoteNode: `runtime/ts/src/admin/remote-node.ts`
  - legacy admin transport host: removed in final cluster-first cutover
  - WsNodeLink: `runtime/ts/src/network/ws-node-link.ts`
  - Gate transports: `runtime/ts/src/gate/gate-transport.ts`
- **Specs and plans:**
  - MCP specification: https://modelcontextprotocol.io/specification
  - Autoscience simple.rg run plan: `examples/projects/autoscience/RFC-simple-run.md`
  - Telebot agent RFC: `runtime/agents/telebot/RFC.md`
