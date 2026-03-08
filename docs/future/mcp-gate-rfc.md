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

### Core idea

A new `McpGateTransport` that implements `GateTransport` by exposing an MCP
server. Protocol events become MCP tool calls (agent → RC) and MCP notifications
or SSE pushes (RC → agent).

```
GateTransport
  ├── WsGateTransport
  ├── StdioGateTransport
  ├── HttpGateTransport
  └── McpGateTransport        ← NEW
        ├── MCP server (stdio or Streamable HTTP)
        ├── Tools: respond, get_state, send_message, list_protocols, join
        ├── Push: MCP notifications / SSE / AgentLauncher callback
        └── Maps ProtocolEvent ↔ MCP tool calls
```

### MCP tools exposed by RC

```
reagent/list_protocols()
  → [{name, version, roles, description}]

reagent/list_instances()
  → [{instanceId, protocolName, status, myRole, pendingEvents}]

reagent/join(protocol, role, instanceId?)
  → {instanceId, initialState}

reagent/get_state(instanceId)
  → {expecting, awaiting, protocolStatus, ctx}

reagent/get_pending_events(instanceId?)
  → [ProtocolEvent, ...]

reagent/respond(instanceId, response)
  → {ok, nextState}

reagent/send_message(instanceId, messageName, payload)
  → {ok, nextState}
```

The tool set maps 1:1 onto the existing `ProtocolEvent` / `AgentResponse`
wire protocol — it's a different framing of the same data.

### Inbound direction (agent → RC): straightforward

MCP client calls `reagent/respond(...)` or `reagent/send_message(...)`.
The `McpGateTransport` translates to an `AgentResponse` and delivers to
`GateSession` → `MessageGateHandle` → RC dispatch. No new concepts needed.

### Outbound direction (RC → agent): the push problem

MCP is client-initiated (pull). When RC needs to deliver a `ProtocolEvent`
to the agent, three strategies apply:

#### Strategy 1: AgentLauncher (works today)

RC spawns a new agent session (CLI process or API call) per incoming event.
The spawned session has Reagent MCP tools in its context.

```
Incoming ProtocolEvent for Claude role
  │
  ▼
AgentLauncher.launch(event)
  │
  ├─ Build system prompt with protocol context + event
  ├─ Spawn `claude` CLI with --mcp-server reagent
  │   OR call Anthropic Messages API with tools
  │
  ├─ Claude sees event in system prompt
  ├─ Claude calls reagent/respond(...) via MCP tool
  │
  └─ Return AgentResponse to RC
```

This is the **most pragmatic** option. It works with any LLM that supports
tool use, regardless of whether the client supports push notifications.
Each event = one agent session. Stateless from the agent's perspective.

```typescript
interface AgentLauncher {
  launch(event: ProtocolEvent, context: LaunchContext): Promise<AgentResponse>;
}

interface LaunchContext {
  instanceId: string;
  protocolName: string;
  role: string;
  mcpServerUrl?: string;     // for Streamable HTTP
  mcpServerCommand?: string; // for stdio
  systemPrompt?: string;     // protocol-specific instructions
}
```

Built-in launchers:
- `ClaudeCodeLauncher` — spawns `claude` CLI with `--mcp-server`
- `AnthropicApiLauncher` — calls Messages API with tools
- `GenericCliLauncher` — spawns any MCP-aware CLI agent
- `CursorLauncher` — triggers Cursor agent session (if API available)

#### Strategy 2: MCP Notifications + SSE (elegant, future)

MCP Streamable HTTP transport supports server-sent events. RC pushes
`reagent/protocol_event` notifications through the SSE channel.
Client subscribes and reacts.

```
RC ──[SSE push]──► {"method": "notifications/reagent/protocol_event",
                    "params": {"instanceId": "...", "event": {...}}}
                   │
                   ▼
Claude Code receives notification
  → triggers internal reasoning
  → tool call: reagent/respond(...)
```

This requires the MCP client to support **reactive notification handling**
(treating server notifications as action triggers). As of 2026-03, this is
not standard behavior for Claude Code or Cursor — notifications go to logs
but don't trigger new reasoning chains.

**When to adopt:** when major MCP clients add "notification → action" support.

#### Strategy 3: Polling (simple fallback)

Agent periodically calls `reagent/get_pending_events()`. Coarse but
universally compatible.

```
loop {
  events = reagent/get_pending_events()
  for each event:
    response = reason(event)
    reagent/respond(instanceId, response)
  sleep(interval)
}
```

Useful for batch/cron-style agents or environments without push support.

### Recommended phasing

| Phase | What | Push strategy | Depends on |
|-------|------|---------------|------------|
| P1 | `McpGateTransport` (stdio) + MCP tool definitions | Polling / AgentLauncher | Message Gate (done) |
| P2 | `ClaudeCodeLauncher` + `AnthropicApiLauncher` | AgentLauncher | P1 |
| P3 | Streamable HTTP MCP transport + SSE push | MCP Notifications | P1 |
| P4 | Cursor / OpenClaw integration | Platform-specific | P1–P3 |

---

## Architecture

### System diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       Reagent RC                                │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   MessageGateNode                         │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │  │
│  │  │ GateSession │  │ GateSession  │  │  GateSession    │  │  │
│  │  │ (WS agent)  │  │ (stdio agent)│  │  (MCP agent)    │  │  │
│  │  └──────┬──────┘  └──────┬───────┘  └───────┬─────────┘  │  │
│  │         │                │                   │            │  │
│  │  ┌──────▼──────┐  ┌─────▼────────┐  ┌──────▼──────────┐  │  │
│  │  │ WsGate      │  │ StdioGate    │  │ McpGate         │  │  │
│  │  │ Transport   │  │ Transport    │  │ Transport       │  │  │
│  │  └──────┬──────┘  └──────┬───────┘  └──────┬──────────┘  │  │
│  └─────────┼────────────────┼──────────────────┼─────────────┘  │
│            │                │                  │                │
└────────────┼────────────────┼──────────────────┼────────────────┘
             │                │                  │
             ▼                ▼                  ▼
     Browser agent    Python subprocess   ┌──────────────────┐
     (WebSocket)      (JSON lines)        │  MCP Client      │
                                          │  ┌────────────┐  │
                                          │  │ Claude Code │  │
                                          │  │ Cursor      │  │
                                          │  │ OpenClaw    │  │
                                          │  │ Any LLM     │  │
                                          │  └────────────┘  │
                                          └──────────────────┘
```

### AgentLauncher flow (per-event session spawning)

```
┌──────────────┐     ProtocolEvent      ┌──────────────────────┐
│  Reagent RC  │ ──────────────────────►│   AgentLauncher      │
│              │                        │                      │
│              │                        │  1. Build prompt     │
│              │                        │     (protocol ctx +  │
│              │                        │      event payload)  │
│              │                        │                      │
│              │                        │  2. Spawn agent      │
│              │                        │     session with     │
│              │                        │     Reagent MCP tools│
│              │                        │         │            │
│              │     MCP tool call      │         ▼            │
│  MCP Server  │◄───────────────────────│  3. Agent reasons    │
│  (in RC)     │  reagent/respond(...)  │     and calls tool   │
│              │                        │                      │
│              │     AgentResponse      │  4. Return response  │
│              │◄───────────────────────│                      │
└──────────────┘                        └──────────────────────┘
```

### Long-lived MCP session flow (SSE push, future)

```
┌──────────────┐                        ┌──────────────────────┐
│  Reagent RC  │  SSE: protocol_event   │   MCP Client         │
│              │ ──────────────────────►│   (Claude Code)      │
│              │                        │                      │
│              │                        │   Receives event     │
│              │                        │   Reasons about it   │
│              │                        │         │            │
│              │  tool: reagent/respond  │         │            │
│  MCP Server  │◄───────────────────────│─────────┘            │
│              │                        │                      │
│              │  SSE: next event...    │                      │
│              │ ──────────────────────►│                      │
└──────────────┘                        └──────────────────────┘
```

---

## Interaction with existing architecture

### Fits into Gate cleanly

`McpGateTransport` implements the same `GateTransport` interface as WS/stdio/HTTP.
`GateSession` handles FSM validation identically — the external agent must still
follow the protocol FSM, regardless of transport. Invalid tool calls (e.g. sending
a message out of turn) are rejected by `GateSession` with a structured error.

### No language changes

This is purely a runtime/transport feature. No changes to `.rg` syntax, IR,
or compiler. A protocol doesn't know or care whether its participants are
in-process, subprocess, WebSocket, or MCP.

### Agent configuration

In `deployment.json` or `reagent.json`, an agent's transport is configured:

```json
{
  "agents": {
    "claude-reviewer": {
      "role": "ReviewProtocol.reviewer",
      "transport": "mcp",
      "mcp": {
        "push": "launcher",
        "launcher": "claude-code",
        "systemPrompt": "You are a code reviewer participating in a review protocol.",
        "model": "claude-sonnet-4-20250514"
      }
    }
  }
}
```

### Relationship to A2A

MCP Gate is for **tool-using agents** (the agent calls tools to participate).
A2A is for **agent-to-agent** communication (peer-level, bidirectional).
They're complementary:

- MCP Gate: Reagent RC is the authority; agent participates via tools
- A2A: Reagent RC peers with another agent system; mutual protocol

Both can coexist. A future `A2aGateTransport` would bridge A2A-capable agents
similarly to how `McpGateTransport` bridges MCP clients.

---

## Example: Code review protocol with Claude Code

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

The `reviewer` role is played by Claude Code via MCP Gate. When `PullRequest`
arrives, the `AgentLauncher` spawns a Claude Code session:

```
System prompt:
  You are a code reviewer. You received a pull request for review.
  Use the reagent/respond tool to submit your review.

  PR diff: {diff}
  PR description: {description}

  Respond with: { "ctx": { "feedback": { "comments": [...], "verdict": "approve"|"request_changes" } } }
```

Claude Code reviews the diff, calls `reagent/respond(...)`, and the protocol
continues.

---

## Open questions

1. **Session lifetime vs. per-event spawning.** AgentLauncher spawns a fresh
   session per event. For multi-step protocols, should we keep the session alive
   across events? This would require a persistent MCP connection (Strategy 2) or
   a session-resumption mechanism.

2. **Cost control.** Each AgentLauncher invocation is an LLM API call. For
   high-frequency protocols (e.g. tick loops), this could be expensive. Should
   RC support batching multiple events into one launcher call?

3. **Context window management.** Long protocols accumulate context. Should the
   launcher include full protocol history or only the current event + summary?

4. **Authentication.** MCP server exposed by RC needs auth for remote access.
   Stdio transport is inherently local. Streamable HTTP needs token-based auth.

5. **Multi-agent MCP session.** Can one MCP client participate as multiple
   roles simultaneously? Probably yes — each `join()` creates a separate
   GateSession. The client manages multiple instanceIds.

---

## References

- Message Gate architecture: `docs/current/connectivity.md` Appendix C
- Gate transport implementations: `runtime/ts/src/gate-transport.ts`
- GateSession: `runtime/ts/src/gate-session.ts`
- MCP specification: https://modelcontextprotocol.io/specification
- Backlog-far idea "AKG → Reagent: акторная сеть с LLM-агентами": `backlog-far.md`
