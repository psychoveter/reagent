# RFC: Reagent Telegram Bot Agent

**Date:** 2026-03-09
**Status:** RFC draft
**Area:** runtime/agents, integration
**Depends on:** CustomAgentNode (done), WsNodeLink (done), ProtocolEngine (done)

---

## Motivation

Reagent protocols orchestrate multi-agent workflows, but human participation
currently has no turnkey interface. A Telegram bot that embeds RC as a library
turns any Telegram user into a first-class Reagent agent — able to receive
protocol events, make decisions, and send responses — without custom UI or
dedicated infrastructure.

The bot is **protocol-agnostic**: it does not know about autoscience, code
review, or any specific domain. All protocol logic stays in `.rg` files.
The bot is a universal human adapter that translates between the
`ProtocolEvent`/`AgentResponse` wire protocol and Telegram's chat UI.

### Why not a separate process with Gate transport?

A standalone bot connecting via `WsGateTransport` would work, but adds
unnecessary complexity for the human agent:

- Extra network hop (bot → WS → RC) with reconnect/timeout logic
- The bot must reimplement Gate wire protocol parsing on the client side
- Two processes to manage instead of one

Embedding RC as a library and using `CustomAgentNode` eliminates all of this.
The bot calls `AgentInterface.handle()` as a direct async function — no
serialization, no network, no reconnect. Other agents (LLMs on remote
machines) still connect over the network via inter-node `WsNodeLink`.

---

## Architecture

### Multi-node Reagent network

The telebot app is one **node** in a distributed Reagent network:

```
┌─────────────────────────────────────────────────────────┐
│              TeleBot Node (this app)                    │
│                                                         │
│  ┌───────────┐    ┌──────────────────────────────────┐  │
│  │ grammY    │◄──►│ TelebotAgentInterface             │  │
│  │ (TG API)  │    │ implements AgentInterface.handle() │  │
│  └───────────┘    └──────────┬───────────────────────┘  │
│       ▲                      │                          │
│       │                      ▼                          │
│       │           ┌──────────────────────┐              │
│  Telegram         │ ReagentController    │              │
│  User             │  CustomAgentNode     │              │
│                   │  AgentRegistry       │              │
│                   │  Routing Table       │              │
│                   │  WsNodeLinkServer    │              │
│                   │    :9100             │              │
│                   └─────────┬────────────┘              │
│                             │                           │
└─────────────────────────────┼───────────────────────────┘
                              │ WsNodeLink (MessageEnvelope)
                ┌─────────────┼─────────────┐
                │             │             │
                ▼             ▼             ▼
  ┌──────────────────┐ ┌──────────────────┐ ...
  │ Claude Node 1    │ │ Claude Node 2    │
  │  RC              │ │  RC              │
  │  MessageGateNode │ │  MessageGateNode │
  │  agent:consultan │ │  agent:researcher│
  │  Claude Code ◄──►│ │  Claude Code ◄──►│
  └──────────────────┘ └──────────────────┘
  (separate machine)    (separate machine)
```

- **TeleBot node**: Embeds RC as a library. Runs one local agent (the human)
  via `CustomAgentNode`. Exposes `WsNodeLinkServer` for other nodes.
- **Claude Code node(s)**: Separate RC processes on other machines. Each runs
  LLM agents via `MessageGateNode` (or `CustomAgentNode`). Connect to the
  TeleBot node via `WsNodeLink` in client mode.
- **Inter-node transport**: Nodes exchange `MessageEnvelope` objects over
  `WsNodeLink` (WebSocket). Each node has its own `AgentRegistry` and routing
  table. Remote agents are registered via `rc.registerRemoteAgent()` or
  discovered via `DiscoveryAgent` (SWIM gossip).

### Why CustomAgentNode, not MessageGateNode?

`MessageGateNode` wraps a `GateTransport` and speaks the `ProtocolEvent`/
`AgentResponse` wire protocol over a network transport (WS, stdio, HTTP).
It's designed for **external** agents that live in separate processes.

The telebot agent lives **inside** the RC process. Using `CustomAgentNode`
means:

- `AgentInterface.handle(event)` is called as a direct async function
- No serialization/deserialization overhead
- No network transport to manage
- The `CustomAgentHandle` drives the `ProtocolEngine` event loop directly,
  including send/receive/timer/guard/invoke state handling
- The `TelebotAgentInterface` only needs to handle the events it cares about
  (`action`, `protocol_started`, etc.) and return `{ type: "noop" }` for the
  rest — the `CustomAgentHandle.runEngine()` handles send/receive routing
  automatically

Key insight: looking at `CustomAgentHandle.runEngine()` (in
`custom-agent-node.ts`), the engine loop **already handles** `send` and
`receive` states internally — it calls `transport.ref(toAgent).sendEnvelope()`
for sends and `waitForMessage()` for receives. The `AgentInterface.handle()`
is only called for `action`, `pre_send_action`, and `post_receive_action`
events (zone code execution). This means the telebot agent only needs to
handle zone code events where the protocol expects human input.

---

## Agent identity

Each telebot instance represents one named agent in the Reagent network.
The name is configured via `AGENT_NAME` env var (e.g., `"oleg"`).

At startup:

1. App compiles the `.rg` protocol file
2. Creates `ReagentController` with a `CustomAgentNode` backend
3. Calls `rc.registerAgent("oleg", roleIR, graphs)`
4. Agent `"oleg"` appears in local `AgentRegistry` and routing table
5. `WsNodeLinkServer` starts, accepting connections from remote RC nodes
6. When a remote node connects, `rc.addNodeLink(link)` adds it; the remote
   node's agents become routable via `rc.registerRemoteAgent()` or discovery

The agent name flows through the entire system:

- `AgentRegistration.name` in `StateStoreAgentRegistry` → queryable by role
- `routingTable.get("oleg")` → `loopbackRef` (local delivery)
- `MessageEnvelope.from.agent` / `to.agent` → message addressing
- `DiscoveryAgent` membership → visible to all nodes in the cluster

---

## TelebotAgentInterface

Implements `AgentInterface` from `@reagent/agent-runtime`:

```typescript
import type { AgentInterface } from "@reagent/agent-runtime";
import type { ProtocolEvent, AgentResponse } from "@reagent/agent-runtime";
import type { Bot } from "grammy";

export class TelebotAgentInterface implements AgentInterface {
  private bot: Bot;
  private chatId: number | null = null;
  private pendingResolve: ((input: string) => void) | null = null;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  setChatId(chatId: number): void {
    this.chatId = chatId;
  }

  resolveInput(text: string): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(text);
    }
  }

  async handle(event: ProtocolEvent): Promise<AgentResponse> {
    switch (event.type) {
      case "protocol_started":
        // CustomAgentHandle doesn't actually call handle() for this;
        // it's listed here for completeness if used with other node types.
        await this.notify(`Protocol started`);
        return { type: "noop" };

      case "action": {
        // Zone code execution — the protocol expects human input.
        // Show the zone body and context to the user, wait for response.
        const text = formatActionEvent(event);
        await this.sendToChat(text);
        const input = await this.waitForUserInput();
        return { type: "ctx_update", ctx: { ...event.ctx, userInput: input } };
      }

      case "pre_send_action": {
        // onSend hook — protocol is preparing a message payload.
        // Show what's being prepared, let user modify if needed.
        const text = formatPreSendEvent(event);
        await this.sendToChat(text);
        const input = await this.waitForUserInput();
        return { type: "ctx_update", ctx: { ...event.ctx, userInput: input } };
      }

      case "post_receive_action": {
        // onReceive hook — message just arrived, protocol wants user to process it.
        const text = formatPostReceiveEvent(event);
        await this.sendToChat(text);
        const input = await this.waitForUserInput();
        return { type: "ctx_update", ctx: { ...event.ctx, userInput: input } };
      }

      default:
        return { type: "noop" };
    }
  }

  private waitForUserInput(): Promise<string> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  private async sendToChat(text: string): Promise<void> {
    if (!this.chatId) return;
    await this.bot.api.sendMessage(this.chatId, text, { parse_mode: "Markdown" });
  }

  private async notify(text: string): Promise<void> {
    await this.sendToChat(text);
  }
}
```

### Async bridging: handle() ↔ Telegram

The critical mechanism: when `CustomAgentHandle.runEngine()` hits a zone state
(`action`, `pre_send_action`, `post_receive_action`), it calls
`this.agent.handle(event)` and **awaits** the returned Promise. Inside
`TelebotAgentInterface.handle()`, the method sends a message to Telegram and
returns `waitForUserInput()` — a Promise that hangs until `resolveInput()` is
called.

On the Telegram side, the grammY `on("message:text")` handler calls
`resolveInput(msg.text)`, which resolves the pending Promise. The engine loop
then continues with the user's response.

```
Engine loop                     TelebotAgentInterface           Telegram
    │                                    │                         │
    │  handle({ type: "action", ... })   │                         │
    │ ──────────────────────────────────► │                         │
    │                                    │  bot.api.sendMessage()  │
    │                                    │ ──────────────────────► │
    │                                    │                         │  "What domain?"
    │              (awaiting...)          │   waitForUserInput()    │
    │                                    │  ◄── Promise ────────   │
    │                                    │                         │
    │                                    │                         │  User types:
    │                                    │                         │  "topology"
    │                                    │  resolveInput("topology")│
    │                                    │ ◄──────────────────────│
    │  ◄── { type: "ctx_update",         │                         │
    │       ctx: { userInput: "topology"}}│                         │
    │                                    │                         │
    │  (engine continues)                │                         │
```

### What handle() does NOT need to handle

Looking at `CustomAgentHandle.runEngine()` in `custom-agent-node.ts`,
the engine loop handles these states **internally** without calling
`agent.handle()`:

- `send` — The engine calls `transport.ref(toAgent).sendEnvelope(env)`
  directly. It only calls `agent.handle()` for `pre_send_action` if
  there's an `onSend` hook.
- `receive` — The engine calls `waitForMessage(messageName)` which resolves
  from the message inbox. It only calls `agent.handle()` for
  `post_receive_action` if there's an `onReceive` hook.
- `timer` — `setTimeout()` internally.
- `guard` / `join` — `followDefault()` internally.
- `initial` / `terminal` — State machine transitions.
- `async_invoke` / `spawn` — Delegated to callbacks.

This means the telebot `handle()` only fires for **zone code** — the blocks
where the protocol expects the agent to do something. For a human agent,
"doing something" means showing information and collecting input.

---

## Protocol design for human agents

Protocols intended for human participation via telebot should follow these
conventions:

### Use `$agent.*` calls in zones

```
human {
  $ctx.nextAction = await $agent.decide($ctx.recommendation, $ctx.liveClaims)
}
```

For a `ManagedAgentAdapter` (native TS execution), `$agent.decide()` would be
a real function. For `TelebotAgentInterface`, the zone body is opaque — the
bot shows the user the context and collects free-text input. The zone code
**cannot execute** inside the telebot; instead, the user's text response
is placed in `$ctx.userInput`.

This is a known limitation: **the telebot agent cannot execute arbitrary JS
zone code**. The protocol author must design zones for human roles such that
the user's free-text response (or structured choice) is sufficient.

### Structured choices via ctx hints

For decisions like "critique / experiment / expand / stop", the protocol can
set a `$ctx._choices` field before the zone block:

```
lead --> human: HumanDecision = {
  onSend {
    $ctx.msg._choices = ["critique", "experiment", "expand", "stop"]
  }
}
```

The telebot formatter can detect `_choices` in the message payload or ctx
and render inline keyboard buttons. If no `_choices` are present, the bot
falls back to free-text input.

---

## Message flow: cross-node example

Using `simple.rg` with three agents across three nodes:

```
Node: telebot        Node: claude-1         Node: claude-2
Agent: oleg          Agent: consultant      Agent: researcher
Role: human          Role: consultant       Role: researcher
```

### Step: `human --> consultant: Intuition`

1. `ProtocolEngine` on telebot node reaches `send` state
2. `CustomAgentHandle.runEngine()` executes the send:
   - If there's an `onSend` hook, calls `handle({ type: "pre_send_action" })`
     → telebot shows prompt, user types intuition text
   - Creates `MessageEnvelope { from: {agent:"oleg", role:"human"},
     to: {agent:"consultant", role:"consultant"}, messageName: "Intuition",
     payload: { text: "...", domain: "..." } }`
3. `transport.ref("consultant")` → looks up routing table
4. `routingTable.get("consultant")` → `NodeRef` wrapping `WsNodeLink` to
   claude-1 node
5. `NodeRef.send(envelope)` → serialized JSON over WebSocket
6. claude-1 RC receives envelope via `WsNodeLink.onEnvelope()`
7. RC runs interceptors, then `dispatchLocal(envelope)`
8. `consultant` agent's handle receives the message

### Step: `consultant --> human: FormalClaim`

1. claude-1's `consultant` agent sends a message back
2. claude-1 RC routes to `routingTable.get("oleg")` → `NodeRef` to telebot
3. Envelope arrives at telebot RC via `WsNodeLink.onEnvelope()`
4. `dispatchLocal(envelope)` → `CustomAgentHandle.dispatchMessage(env)`
5. Message lands in the engine's `_messageInbox`
6. Engine's `waitForMessage("FormalClaim")` resolves
7. If there's an `onReceive` hook, `handle({ type: "post_receive_action" })`
   fires → telebot shows the formal claim to the user in Telegram

---

## Telegram UX

### Commands

- `/status` — Show connected nodes, registered agents (local + remote),
  active protocol instances
- `/stop` — Send `break_requested` to the active protocol instance

### Input modes

- **Free text** — Default. Any text message resolves the pending
  `waitForUserInput()` promise. The text goes into `$ctx.userInput`.
- **Inline keyboards** — When the formatter detects `_choices` in the
  event context or message payload, it renders buttons. A button press
  resolves the pending promise with the button's callback data.
- **JSON input** — If the user's message is valid JSON, the bot parses it
  and merges it into `$ctx` instead of setting `userInput`.

### Notifications (non-interactive)

The bot sends informational messages for protocol lifecycle events
that don't require user input:

- Protocol started/completed/failed
- Message sent to remote agent
- Message received from remote agent

These are sent via `bot.api.sendMessage()` but don't create a pending
`waitForUserInput()`.

---

## File structure

```
runtime/agents/telebot/
├── package.json          # grammy, dotenv; workspace link to @reagent/agent-runtime
├── tsconfig.json
├── .env.example          # BOT_TOKEN, AGENT_NAME, PROTOCOL_PATH, NODE_PORT
├── src/
│   ├── index.ts          # Entry: create RC + WsNodeLinkServer, compile .rg,
│   │                     # register agent, start bot
│   ├── telebot-agent.ts  # TelebotAgentInterface (AgentInterface impl)
│   ├── bot.ts            # grammY setup, commands, callback handlers, input queue
│   ├── formatter.ts      # ProtocolEvent → Telegram markdown (protocol-agnostic)
│   └── types.ts          # ChatSession, config types
└── RFC.md                # This document
```

---

## Configuration

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_TOKEN` | yes | — | Telegram bot token from @BotFather |
| `AGENT_NAME` | no | `"human"` | Agent identity in Reagent network |
| `PROTOCOL_PATH` | yes | — | Path to `.rg` file to compile and load |
| `NODE_PORT` | no | `9100` | Port for `WsNodeLinkServer` |

### Dependencies

| Package | Purpose |
|---|---|
| `grammy` | Telegram Bot API framework (TypeScript-native) |
| `dotenv` | Environment variable loading |
| `@reagent/agent-runtime` | Workspace link — provides RC, CustomAgentNode, WsNodeLinkServer, compiler, all wire protocol types |

Note: `ws` is a transitive dependency via `@reagent/agent-runtime`.

---

## Startup sequence

```
1. Load .env (BOT_TOKEN, AGENT_NAME, PROTOCOL_PATH, NODE_PORT)

2. Create grammY Bot(BOT_TOKEN)

3. Create TelebotAgentInterface(bot)

4. Create CustomAgentNode({
     roleToAgent: { ... },  // from compiled protocol
     agentFactory: () => telebotAgentInterface,
   })

5. Create ReagentController({
     nodeId: "telebot-node",
     agentNodes: { ts: customAgentNode },
   })

6. Start WsNodeLinkServer({ port: NODE_PORT })
   - onLink(link): rc.addNodeLink(link)
   - Remote nodes send handshake { nodeId: "claude-1" }
   - After handshake: rc.registerRemoteAgent("consultant", "claude-1")

7. Compile .rg protocol from PROTOCOL_PATH
   - Parse → IR → extract roleIR, graphs

8. rc.registerAgent(AGENT_NAME, roleIR, graphs)
   - Agent appears in AgentRegistry and routing table

9. rc.start()
   - Connects all NodeLinks, starts all agent handles

10. Start grammY long polling
    - First /start or message → capture chatId for TelebotAgentInterface
    - Subsequent messages → resolveInput(text) on the agent interface

11. Protocol triggered by:
    - Telegram command (user initiates)
    - Remote node sending a trigger
    - Cron trigger defined in .rg
```

---

## Interaction with existing runtime components

| Component | Role in telebot app |
|---|---|
| `ReagentController` | Created as library instance. Manages routing, interceptors, registry |
| `CustomAgentNode` | Backend for the human agent. Creates `CustomAgentHandle` |
| `CustomAgentHandle` | Drives `ProtocolEngine` loop, calls `TelebotAgentInterface.handle()` for zones |
| `ProtocolEngine` | FSM walker. Owns `$ctx`, state machine, transitions |
| `WsNodeLinkServer` | Accepts incoming connections from remote RC nodes |
| `WsNodeLink` | Bidirectional envelope pipe to each remote node |
| `AgentRegistry` | Stores local agent registration (queryable by role) |
| `ProtocolRegistry` | Stores compiled protocol IR, trigger definitions |
| `ResolvePolicyEvaluator` | Evaluates `resolve` clauses to pick agents for roles |

No new runtime abstractions are needed. The telebot is a **composition** of
existing components.

---

## Open questions

### 1. Zone code execution for human agents

The current `CustomAgentHandle.runEngine()` calls `handle()` with `action`
events that contain zone `body` (JavaScript source). `ManagedAgentAdapter`
executes this code. `TelebotAgentInterface` cannot — it shows the user a
prompt instead.

Should we:
- (a) Accept this asymmetry and document that human-facing zones must be
  designed for text-in/text-out (current plan)
- (b) Add a `lang: "human"` tag that changes code generation to produce
  structured prompts instead of JS code
- (c) Have the telebot use `ManagedAgentAdapter` for zones that don't need
  user input and `TelebotAgentInterface` only for zones with `$agent.*` calls

### 2. Multiple Telegram users

Currently, one bot instance = one agent identity = one chatId. Multiple
Telegram users would require either:
- Multiple bot instances (different BOT_TOKEN / AGENT_NAME per user)
- Session-per-user mapping within one bot (one `TelebotAgentInterface` per
  user, multiple agents registered in RC)

### 3. Protocol loading

The current plan loads one protocol at startup. Dynamic protocol loading
(via Telegram command or API) would require:
- Recompiling and registering new agents at runtime
- Managing multiple active protocol instances
- Potential role conflicts if multiple protocols define the same roles

### 4. ChatId capture timing

The bot needs a `chatId` before it can send messages. But the protocol might
be triggered before the user has sent any Telegram message. Options:
- Require `CHAT_ID` as env var (static, simple)
- Wait for first `/start` message to capture chatId (dynamic, but protocol
  can't start until user initiates)
- Use Telegram Bot API `getUpdates` at startup to find the most recent chat

---

## Phasing

### Phase 1: Minimal viable telebot
- Single protocol, single user, single chatId (env var)
- `TelebotAgentInterface.handle()` for action events
- Free-text input only (no inline keyboards)
- Manual `registerRemoteAgent()` (no discovery)
- Local testing with `InMemoryNodeLink` (two RC instances in one process)

### Phase 2: Telegram UX
- Inline keyboards for structured choices (`_choices` convention)
- JSON input parsing
- `/status` and `/stop` commands
- Protocol lifecycle notifications

### Phase 3: Multi-node deployment
- `WsNodeLinkServer` for remote Claude Code nodes
- Docker Compose for full autoscience setup (telebot + N Claude nodes)
- Health checks, reconnect handling

### Phase 4: Multi-user and dynamic protocols
- Session-per-user with multiple agent identities
- Dynamic protocol loading via Telegram commands
- `DiscoveryAgent` integration for automatic remote agent registration
