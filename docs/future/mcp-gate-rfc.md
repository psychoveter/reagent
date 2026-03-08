# RFC: Reagent as MCP Server (MCP Gate)

**Date:** 2026-03-08
**Status:** RFC draft
**Area:** runtime/ts, integration
**Depends on:** Message Gate (done), R1 (Py Gate — for Py RC parity)

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

### Primary model: persistent agent session

The central design is a **long-lived MCP session** where a Claude Code (or any
MCP client) connects to Reagent RC as a persistent agent. The session is
associated with an **agent identity** — it registers in discovery, can
participate in multiple protocol instances simultaneously, and receives
incoming events via a **long-poll tool call**.

```
Claude Code session lifecycle:

  1. Connect to Reagent MCP server (stdio or Streamable HTTP)
  2. reagent/register(agentName, roles[])     → agent appears in discovery
  3. reagent/wait_for_events(timeout?)        → BLOCKS until event arrives
  4.   ← returns [{instanceId, event}]
  5. reagent/respond(instanceId, response)    → RC advances FSM
  6. goto 3 (loop)
  ...
  N. reagent/unregister()                     → agent leaves discovery
```

The key insight: **`reagent/wait_for_events` is a blocking MCP tool call**.
The MCP server holds the JSON-RPC response until an event is available (or
timeout expires). From Claude Code's perspective, it calls a tool and waits —
the same way it would call any slow tool (e.g. a build or test runner).
When the tool returns, Claude Code sees the event, reasons about it, responds
via `reagent/respond`, then calls `wait_for_events` again.

This creates a **cooperative event loop** driven by the agent:

```
Claude Code                          Reagent RC (MCP server)
    │                                        │
    │  tool: reagent/register("claude-1",    │
    │         roles: ["reviewer"])            │
    │ ──────────────────────────────────────► │  → agent registered
    │                                        │  → appears in discovery
    │  ◄──────────────────────────────────── │  {ok, agentId}
    │                                        │
    │  tool: reagent/wait_for_events()       │
    │ ──────────────────────────────────────► │
    │                    ...                  │  (holding response)
    │                    ...                  │
    │              (protocol starts,          │
    │               event for this agent)     │
    │                                        │
    │  ◄──────────────────────────────────── │  [{instanceId: "rev-42",
    │                                        │    event: {type: "receive",
    │                                        │     message: "PullRequest",
    │                                        │     payload: {diff: "..."}}}]
    │                                        │
    │  (Claude reasons about the PR)         │
    │                                        │
    │  tool: reagent/respond("rev-42",       │
    │    {ctx: {verdict: "approve"}})         │
    │ ──────────────────────────────────────► │  → FSM advances
    │  ◄──────────────────────────────────── │  {ok, nextState}
    │                                        │
    │  tool: reagent/wait_for_events()       │
    │ ──────────────────────────────────────► │  (blocks again, waiting
    │                    ...                  │   for next event across
    │                    ...                  │   any protocol instance)
```

### Properties of the persistent session model

**Agent identity.** The MCP session is bound to a named agent (`agentName`).
This agent registers its roles with RC, appears in the agent registry and
discovery (gossip/etcd), and is addressable by name — exactly like an
in-process or subprocess agent. Other agents can send messages to it.
Trigger resolve policies can match it.

**Multi-instance participation.** One agent session handles events from
multiple protocol instances. `wait_for_events` returns events from any
instance where this agent participates. The agent multiplexes by `instanceId`.

**Multi-protocol participation.** The agent declares which roles it can play
at registration time. RC can assign it to any matching protocol via triggers
or explicit instantiation.

**Natural backpressure.** The agent processes events at its own pace. It calls
`wait_for_events`, gets an event, processes it, responds, then asks for more.
RC queues events for this agent until it's ready. No event is lost.

**Graceful disconnect.** If the MCP connection drops (agent crashes, user
closes Claude Code), RC detects the transport close and either:
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
  or timeout expires (returns [] on timeout). Events span all protocol
  instances where this agent participates.

── Protocol interaction ──

reagent/respond(instanceId, response: AgentResponse)
  → {ok, nextState?}
  Submit response for a specific protocol instance event.

reagent/send_message(instanceId, messageName, payload)
  → {ok}
  Shorthand for responding with a send payload.

── Introspection ──

reagent/list_protocols()
  → [{name, version, roles, description}]

reagent/list_instances()
  → [{instanceId, protocolName, status, myRole, pendingEvents}]

reagent/get_state(instanceId)
  → {expecting, awaiting, protocolStatus, ctx}

reagent/get_pending_events(instanceId?)
  → [ProtocolEvent, ...]
  Non-blocking variant of wait_for_events. Returns immediately.
```

### `wait_for_events` semantics

This is the core mechanism that makes pull-model MCP work for push-style
protocol events.

**Long-poll behavior:**
- RC holds the JSON-RPC response open until an event arrives or timeout
- Default timeout: 30s (configurable). On timeout, returns `[]`
- Agent calls again immediately after processing — creating a continuous loop
- `max_events` limits batch size (default: 1 for LLM agents that want to
  process one thing at a time; higher for programmatic agents)

**Event ordering:**
- Events are delivered in protocol-causal order per instance
- Across instances, events are ordered by arrival time at RC
- Each event has a monotonic sequence number for dedup on reconnect

**At-least-once delivery:**
- Events are not acked until `reagent/respond` is called
- If agent disconnects before responding, events are re-delivered on reconnect
- `respond` with a stale/duplicate sequence number is a no-op (idempotent)

**Timeout tuning for LLM agents:**
- Claude Code has tool-call timeouts (typically 60–120s)
- `wait_for_events(timeout_ms: 25000)` stays well under the limit
- Agent calls in a loop: `while(active) { events = wait(25s); process(events); }`

---

## Architecture

### Transport layer: `McpGateTransport`

```
GateTransport
  ├── WsGateTransport
  ├── StdioGateTransport
  ├── HttpGateTransport
  └── McpGateTransport        ← NEW
```

`McpGateTransport` differs from other transports: it is **not per-session**
but **per-agent**. One MCP connection serves all protocol instances for that
agent. Internally, `McpGateTransport` manages a map of `instanceId → GateSession`
and routes events/responses accordingly.

```typescript
class McpGateTransport implements GateTransport {
  private sessions: Map<string, GateSession> = new Map();
  private eventQueue: AsyncQueue<QueuedEvent> = new AsyncQueue();
  private agentName: string;

  // Called by GateSession when RC has an event for this agent
  send(event: ProtocolEvent): void {
    this.eventQueue.push({ instanceId, event });
    // Unblocks any pending wait_for_events call
  }

  // Called by MCP tool handler for wait_for_events
  async waitForEvents(timeout: number, max: number): Promise<QueuedEvent[]> {
    return this.eventQueue.drain(timeout, max);
  }

  // Called by MCP tool handler for respond
  deliverResponse(instanceId: string, response: AgentResponse): void {
    this.sessions.get(instanceId)?.deliverResponse(response);
  }
}
```

### System diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Reagent RC                                  │
│                                                                     │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │  Agent Registry │  │ Protocol       │  │  Discovery           │  │
│  │  & Discovery    │  │ Instances      │  │  (gossip/etcd)       │  │
│  └───────┬────────┘  └───────┬────────┘  └──────────┬───────────┘  │
│          │                   │                      │              │
│  ┌───────▼───────────────────▼──────────────────────▼───────────┐  │
│  │                    MessageGateNode                            │  │
│  │                                                               │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐  │  │
│  │  │ GateSession │  │ GateSession  │  │  GateSession        │  │  │
│  │  │ (instance A)│  │ (instance B) │  │  (instance C)       │  │  │
│  │  └──────┬──────┘  └──────┬───────┘  └───────┬─────────────┘  │  │
│  │         └────────────────┼──────────────────┘                │  │
│  │                          │ all sessions for one agent        │  │
│  │                   ┌──────▼──────────┐                        │  │
│  │                   │ McpGateTransport│                        │  │
│  │                   │                 │                        │  │
│  │                   │  event queue    │                        │  │
│  │                   │  ┌───────────┐  │                        │  │
│  │                   │  │ evt evt.. │  │                        │  │
│  │                   │  └───────────┘  │                        │  │
│  │                   └──────┬──────────┘                        │  │
│  └──────────────────────────┼───────────────────────────────────┘  │
│                             │ MCP server (stdio / Streamable HTTP) │
└─────────────────────────────┼─────────────────────────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │   Claude Code      │
                    │   (MCP client)     │
                    │                    │
                    │   register()       │
                    │   wait_for_events()│  ← blocks
                    │   respond()        │
                    │   wait_for_events()│  ← blocks again
                    │   ...              │
                    └────────────────────┘
```

### Agent lifecycle and discovery integration

```
register("claude-reviewer", roles: ["CodeReview.reviewer", "DesignReview.reviewer"])
  │
  ▼
RC AgentRegistry
  ├─ Creates agent entry: {name: "claude-reviewer", roles: [...], transport: "mcp"}
  ├─ Publishes to discovery (gossip/etcd): other RC nodes learn about this agent
  └─ Agent is now eligible for:
       • Explicit assignment: rc.instantiate({..., roleToAgent: {reviewer: "claude-reviewer"}})
       • Trigger resolve: resolve policy matches by role → selects this agent
       • Spawn: dynamically bound at runtime

unregister() or disconnect
  │
  ▼
RC AgentRegistry
  ├─ Marks agent unavailable
  ├─ Publishes removal to discovery
  └─ Running instances receive agent-disconnected event
       (supervision policy decides: wait, reassign, abort)
```

### Event loop detail

```
┌────────────────────────────────────────────────────────────────────┐
│  Claude Code                                                       │
│                                                                    │
│  System prompt:                                                    │
│    "You are claude-reviewer. You participate in Reagent protocols.  │
│     Your workflow:                                                  │
│     1. Call reagent/register to join the network                    │
│     2. Call reagent/wait_for_events in a loop                      │
│     3. For each event, reason and call reagent/respond              │
│     4. Repeat until done"                                          │
│                                                                    │
│  Agent behavior:                                                   │
│                                                                    │
│    reagent/register("claude-reviewer", ["CodeReview.reviewer"])     │
│    │                                                               │
│    loop {                                                          │
│      events = reagent/wait_for_events(timeout: 25000)              │
│      │                                                             │
│      if events is empty:                                           │
│        continue  // timeout, try again                             │
│      │                                                             │
│      for event in events:                                          │
│        match event.type:                                           │
│          "receive" + "PullRequest":                                │
│            review the diff, form opinion                           │
│            reagent/respond(event.instanceId,                       │
│              {ctx: {verdict: "approve", comments: [...]}})         │
│          "send_required" + "ReviewFeedback":                       │
│            reagent/respond(event.instanceId,                       │
│              {payload: {comments: ..., verdict: ...}})             │
│          "protocol_completed":                                     │
│            note completion                                         │
│    }                                                               │
│    reagent/unregister()                                            │
└────────────────────────────────────────────────────────────────────┘
```

---

## Alternative push strategies (supplementary)

The persistent session with long-poll is the primary model. These alternatives
exist for specific scenarios:

### AgentLauncher (stateless, per-event)

For cases where a persistent session is impractical (serverless, one-shot tasks),
RC can spawn a fresh agent session per event. The launcher builds a prompt with
the event context and Reagent MCP tools, spawns a Claude Code CLI or API call,
waits for the `reagent/respond` tool call, and returns.

```typescript
interface AgentLauncher {
  launch(event: ProtocolEvent, context: LaunchContext): Promise<AgentResponse>;
}
```

Built-in launchers:
- `ClaudeCodeLauncher` — spawns `claude` CLI with `--mcp-server`
- `AnthropicApiLauncher` — calls Messages API with tools
- `GenericCliLauncher` — spawns any MCP-aware CLI agent

This is a **fallback** for environments that can't hold a persistent MCP session.
It does not register in discovery — RC manages the launcher directly.

### MCP Notifications + SSE (future)

When MCP clients support reactive notification handling (server notification →
triggers new reasoning chain), RC can push events via SSE instead of long-poll.
The agent would not need to call `wait_for_events` — events arrive as
notifications. This is the most elegant model but depends on client support.

---

## Interaction with existing architecture

### Fits into Gate cleanly

`McpGateTransport` implements `GateTransport`. `GateSession` handles FSM
validation identically — invalid tool calls (sending a message out of turn)
are rejected with a structured error.

The key difference from other transports: `McpGateTransport` is per-agent
(one transport → many sessions), while WS/stdio/HTTP transports are
per-session. This is because an MCP connection is bound to the agent process,
not to a protocol instance.

### No language changes

Purely a runtime/transport feature. No changes to `.rg` syntax, IR, or
compiler. A protocol doesn't know whether its participants are in-process,
subprocess, WebSocket, or MCP.

### Agent configuration

Agents connecting via MCP are self-describing — they register their roles
at connect time. No static configuration needed in `deployment.json`.

For pre-configured agents (RC knows to expect an MCP agent):

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

For launcher-mode (RC spawns the agent):

```json
{
  "agents": {
    "claude-reviewer": {
      "role": "CodeReview.reviewer",
      "transport": "mcp",
      "mcp": {
        "mode": "launcher",
        "launcher": "claude-code",
        "model": "claude-sonnet-4-20250514",
        "systemPrompt": "You are a code reviewer..."
      }
    }
  }
}
```

### Relationship to A2A

MCP Gate: Reagent RC is the authority; agent participates via tools.
A2A: Reagent RC peers with another agent system; mutual protocol.

Complementary. A future `A2aGateTransport` would bridge A2A-capable agents
similarly to how `McpGateTransport` bridges MCP clients.

---

## Example: Code review protocol with persistent Claude Code agent

### Protocol

```
protocol CodeReview {
  participants: author [py], reviewer [*], ci [ts]
  initiator: author
  input: ReviewRequest

  author --> reviewer: PullRequest = {
    onSend { $ctx.msg = { diff: $ctx.input.diff, description: $ctx.input.description } }
  }

  reviewer {
    $ctx.feedback = await $agent.review($ctx.msg)
  }

  reviewer --> author: ReviewFeedback = {
    onSend { $ctx.msg = { comments: $ctx.feedback.comments, verdict: $ctx.feedback.verdict } }
  }

  alt ($ctx.msg.verdict == "approve") {
    author --> ci: MergeTrigger = {
      onSend { $ctx.msg = { branch: $ctx.input.branch } }
    }
    ci --> author: MergeResult = {
      onReceive { $ctx.result = $ctx.msg }
    }
  } else {
    author {
      $ctx.result = { status: "changes_requested", feedback: $ctx.feedback }
    }
  }
}
```

### Claude Code session (reviewer role)

Claude Code is started with Reagent as an MCP server. Its system prompt
instructs it to register and participate:

```
You are a persistent code review agent connected to a Reagent protocol network.

Available MCP tools (from reagent server):
  reagent/register, reagent/wait_for_events, reagent/respond, etc.

Your workflow:
1. Register as "claude-reviewer" with role "CodeReview.reviewer"
2. Wait for events in a loop
3. When you receive a PullRequest, review the code and respond with your verdict
4. Continue waiting for more events
```

Claude Code execution:

```
→ reagent/register("claude-reviewer", ["CodeReview.reviewer"])
  ← {agentId: "cr-1", registeredRoles: ["CodeReview.reviewer"]}

→ reagent/wait_for_events(timeout: 25000)
  ... (waits) ...
  ← [{instanceId: "rev-42", protocolName: "CodeReview", role: "reviewer",
      event: {type: "receive", message: "PullRequest",
              payload: {diff: "...", description: "Add caching layer"}}}]

  (Claude reviews the diff, analyzes the changes)

→ reagent/respond("rev-42",
    {ctx: {feedback: {comments: ["Good approach, consider TTL config"],
                      verdict: "approve"}}})
  ← {ok: true}

→ reagent/wait_for_events(timeout: 25000)
  ← [{instanceId: "rev-42", event: {type: "send_required",
      message: "ReviewFeedback"}}]

→ reagent/respond("rev-42",
    {payload: {comments: ["Good approach, consider TTL config"],
               verdict: "approve"}})
  ← {ok: true}

→ reagent/wait_for_events(timeout: 25000)
  ← [{instanceId: "rev-42", event: {type: "protocol_completed"}}]

→ reagent/wait_for_events(timeout: 25000)
  ... (waits for next review) ...
```

---

## Phasing

| Phase | What | Notes |
|-------|------|-------|
| P1 | MCP server skeleton + `register` / `unregister` / `wait_for_events` / `respond` | Core event loop. Stdio transport. |
| P2 | Discovery integration (agent registry, resolve policy matching) | MCP agents appear alongside local/subprocess agents. |
| P3 | Streamable HTTP transport (remote MCP connections) | Enables remote agents, not just local stdio. |
| P4 | `AgentLauncher` (stateless fallback) | For serverless / one-shot scenarios. |
| P5 | Reconnection, session resumption, pending event replay | Production resilience. |
| P6 | Multi-node: MCP agent on node A, protocol on node B | Requires cross-node routing (existing NodeLink). |

---

## Open questions

1. **Claude Code tool-call timeout.** If `wait_for_events` blocks for 25s
   and no event arrives, it returns `[]`. Claude Code must call again. Will
   Claude Code reliably loop on empty results, or will it decide "nothing to
   do" and stop? May need explicit prompt engineering: "always call
   wait_for_events again even if the result is empty."

2. **Context window growth.** In a long-lived session, repeated
   `wait_for_events` → `respond` cycles accumulate in Claude Code's context.
   Eventually the context window fills. Mitigation options:
   - Claude Code's built-in context management (summarization)
   - Explicit `reagent/get_context_summary(instanceId)` tool that returns
     a compressed protocol state instead of raw event history

3. **Concurrent events.** If multiple events arrive while the agent is
   processing one, they queue. `max_events` parameter on `wait_for_events`
   controls batch size. LLM agents should use `max_events: 1` to avoid
   overwhelming the reasoning. Programmatic MCP clients can use higher values.

4. **Authentication.** Stdio transport is inherently local (same machine).
   Streamable HTTP (P3) needs token-based auth. RC could issue a registration
   token that the MCP client presents at connect time.

5. **Multiple Claude Code sessions.** Can two Claude Code sessions register
   as the same agent? Options:
   - Reject (one session per agentName)
   - Load-balance (round-robin event delivery)
   - Failover (second session is standby)

6. **Cost control.** A persistent Claude Code session holding a long-poll
   costs API tokens per interaction (not per wait). But if the LLM "thinks"
   about whether to continue waiting, that's wasted tokens. The prompt should
   make the loop mechanical: "call wait_for_events, process result, repeat."

---

## References

- Message Gate architecture: `docs/current/connectivity.md` Appendix C
- Gate transport implementations: `runtime/ts/src/gate-transport.ts`
- GateSession: `runtime/ts/src/gate-session.ts`
- MCP specification: https://modelcontextprotocol.io/specification
- Backlog-far idea "AKG → Reagent: акторная сеть с LLM-агентами": `backlog-far.md`
