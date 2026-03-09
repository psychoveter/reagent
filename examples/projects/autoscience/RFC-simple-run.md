# RFC: Running simple.rg via MCP Gate (Cursor + Claude Code)

**Date:** 2026-03-09
**Status:** RFC draft
**Area:** examples/autoscience, runtime integration
**Depends on:** MCP Gate RFC (`docs/future/mcp-gate-rfc.md`), simple.rg protocol,
  ROS (`runtime/ts/src/ros.ts`), RemoteNode (`runtime/ts/src/remote-node.ts`)

---

## Goal

Run `simple.rg` end-to-end with three agents, all connected through MCP Gate:

| Role | Agent | MCP client | Where it runs |
|---|---|---|---|
| `human` | `oleg` | Cursor (you) | local RemoteNode |
| `consultant` | `consultant-1` | Claude Code | Docker RemoteNode |
| `researcher` | `researcher-1` | Claude Code | Docker RemoteNode |

All three agents use the same MCP mechanism: `reagent/register`,
`reagent/wait_for_events`, `reagent/respond`. The protocol does not know or
care whether the agent on the other end is a human or an LLM.

---

## Architecture: ROS + RemoteNodes + MCP Gate

The system uses the existing Reagent multi-node architecture:

- **ROS** (ReagentOrchestratorServer) — central coordinator. Compiles `.rg`,
  deploys agent IR to RemoteNodes, triggers protocols, routes
  `MessageEnvelope`s between nodes. Runs on your local machine.
- **RemoteNode** — lightweight RC process that connects to ROS via WebSocket.
  Receives `Deploy` and `TriggerProtocol` commands. Runs the agent's
  `ProtocolEngine` locally. One per agent (or per machine).
- **MCP Gate** — each RemoteNode exposes an MCP server that the actual agent
  (Cursor or Claude Code) connects to. The MCP Gate bridges between the
  `ProtocolEvent`/`AgentResponse` wire protocol and MCP tools.

```
                         ┌──────────────────────────┐
                         │         ROS              │
                         │   Compile simple.rg      │
                         │   Deploy IR to nodes     │
                         │   Trigger protocols      │
                         │   Route MessageEnvelopes │
                         │   WS server :7400        │
                         └───┬──────┬──────┬────────┘
                             │      │      │
              RAP/WS         │      │      │         RAP/WS
           ┌─────────────────┘      │      └─────────────────┐
           │                        │                        │
           ▼                        ▼                        ▼
  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐
  │ RemoteNode 1    │    │ RemoteNode 2     │    │ RemoteNode 3     │
  │ (local)         │    │ (Docker)         │    │ (Docker)         │
  │                 │    │                  │    │                  │
  │ RC              │    │ RC               │    │ RC               │
  │ agent: oleg     │    │ agent: consult-1 │    │ agent: research-1│
  │                 │    │                  │    │                  │
  │ McpGateTransport│    │ McpGateTransport │    │ McpGateTransport │
  │ MCP server :9201│    │ MCP server :9202 │    │ MCP server :9203 │
  └───────┬─────────┘    └───────┬──────────┘    └───────┬──────────┘
          │                      │                       │
          ▼                      ▼                       ▼
  ┌───────────────┐    ┌──────────────────┐    ┌──────────────────┐
  │ Cursor (you)  │    │ Claude Code      │    │ Claude Code      │
  │ MCP client    │    │ MCP client       │    │ MCP client       │
  │ human-in-loop │    │ auto event loop  │    │ auto event loop  │
  └───────────────┘    └──────────────────┘    └──────────────────┘
```

### Why RemoteNode per agent?

Each Claude Code instance needs its **own RC** to run its role's
`ProtocolEngine`. `RemoteNode` is exactly this — a standalone RC process
that connects to ROS. ROS handles deployment (pushing IR graphs) and
inter-node message routing. The RemoteNode handles local engine execution.

This is the existing architecture. We add MCP Gate to each RemoteNode so
the actual LLM/human agent connects via MCP instead of being in-process.

### Message routing

1. ROS compiles `simple.rg`, produces IR graphs for all three roles
2. ROS sends `Deploy` command to each RemoteNode with the appropriate
   role's IR graph and `roleToAgent` mapping
3. When a protocol triggers, ROS sends `TriggerProtocol` to the initiator
   node (oleg's RemoteNode)
4. When oleg sends a message to consultant, the `MessageEnvelope` flows:
   `RemoteNode 1 → ROS → RemoteNode 2`
   (ROS acts as the envelope router between nodes)
5. RemoteNode 2's local RC dispatches the envelope to the consultant agent

### Why not one big RC with all agents?

- Claude Code instances run on different machines (Docker containers)
- Each needs its own process
- `RemoteNode` already provides this pattern
- ROS already provides compilation, deployment, and routing

### MCP Gate on each RemoteNode

Each RemoteNode extends its RC with `McpGateTransport`. When ROS deploys
an agent to the node, instead of running the agent in-process (NativeAgentNode),
the node registers it with MCP Gate. The MCP client (Cursor or Claude Code)
connects, registers via `reagent/register`, and participates via the
`wait_for_events` / `respond` loop.

This means `RemoteNode` needs a new mode: **MCP Gate mode**, where deployed
agents are bridged to external MCP clients instead of running zone code
locally. This is the main implementation work.

---

## Human-in-the-loop via MCP Gate: the hybrid model

The key design: **Cursor is an MCP client that bridges you (the human) with
the Reagent protocol**. But unlike an LLM agent that auto-loops, Cursor
operates in a **human-driven hybrid mode**:

### The loop, from your perspective

```
You:     "Register me as oleg, role human in SimpleResearch. Wait for events."
Cursor:  → reagent/register("oleg", ["SimpleResearch.human"])
         → reagent/wait_for_events(timeout: 30000)
         ← (blocks until event arrives)
         ← [{instanceId: "sr-1", event: {type: "action", body: "...", ctx: {...}}}]
Cursor:  "You have an action event. The protocol wants you to provide an intuition.
          Current context: [shows ctx]. What would you like to do?"

You:     "Read the file docs/topology.md first, then I'll decide."
Cursor:  → Read("docs/topology.md")
         (shows you the contents)

You:     "Ok, respond with intuition about topological defects in crystal growth."
Cursor:  → reagent/respond("sr-1",
            {ctx: {userInput: "Topological defects in crystal growth correlate with..."}})
         → reagent/wait_for_events(timeout: 30000)
         ← (blocks, waiting for next event)
         ...
         ← [{instanceId: "sr-1", event: {type: "post_receive_action",
             ctx: {msg: {statement: "...", predictions: [...]}}}}]
Cursor:  "Consultant sent a FormalClaim. Here's what they formalized: [shows].
          The protocol now wants you to review it. What do you think?"

You:     "Search for papers on this topic first."
Cursor:  → WebSearch("topological defects crystal growth")
         (shows results)

You:     "Now respond — I approve the formalization."
Cursor:  → reagent/respond("sr-1", {ctx: {userInput: "approved", ...}})
         → reagent/wait_for_events(...)
```

### Key properties

1. **Cursor drives the event loop** — it calls `wait_for_events` and
   `respond` as MCP tool calls. You don't manually invoke tools.

2. **You control the pace** — Cursor doesn't auto-respond. After receiving
   an event, it shows you the context and asks what to do. You can:
   - Ask Cursor to do other work first (read files, search, analyze)
   - Think as long as you need
   - Dictate the response when ready

3. **After each respond, Cursor goes back to waiting** — it calls
   `wait_for_events` again automatically. This keeps the event loop alive
   without you having to say "now wait again."

4. **You can intervene** — at any point you can:
   - Ask Cursor to call `reagent/get_state(instanceId)` to inspect protocol state
   - Ask Cursor to call `reagent/list_instances()` to see all active protocols
   - Stop the loop by not asking Cursor to call `wait_for_events`
   - Call `reagent/unregister()` to leave the protocol

### System prompt for Cursor

To make this work reliably, Cursor needs context about its role. This can be
set via a `.cursorrules` file or initial prompt:

```
You are connected to a Reagent protocol network via MCP.
Your MCP server "reagent" provides tools for protocol participation.

Your workflow:
1. When the user asks to join a protocol, call reagent/register with the
   given agent name and roles.
2. After registration, call reagent/wait_for_events to start receiving events.
3. When an event arrives, present it to the user in a clear format:
   - Show the event type and relevant fields
   - Explain what the protocol expects (based on the event type)
   - Ask the user what they want to do
4. The user may ask you to perform other tasks before responding (read files,
   search, analyze code, etc.). Do those tasks first.
5. When the user is ready, call reagent/respond with their input.
6. After responding, immediately call reagent/wait_for_events again to
   continue the loop. Do NOT wait for the user to tell you to wait again.
7. On protocol_completed or protocol_failed events, notify the user and
   stop the loop.

Important:
- Never auto-respond to protocol events. Always show the user and wait for
  their decision.
- Format protocol contexts and messages as readable markdown.
- If wait_for_events returns empty (timeout), call it again silently.
```

---

## LLM agents (consultant, researcher): auto event loop

Claude Code agents run in Docker containers with Reagent as an MCP server.
They operate fully autonomously — no human in the loop.

### System prompt (consultant)

```
You are a research consultant agent connected to a Reagent protocol network.

MCP tools available from the "reagent" server:
- reagent/register, reagent/wait_for_events, reagent/respond,
  reagent/list_instances, reagent/get_state

Your workflow:
1. Register as "consultant-1" with roles ["SimpleResearch.consultant"]
2. Call reagent/wait_for_events in a loop
3. For each event, process it according to your role:

   action events — these contain zone code hints in the "body" field.
   Read the body to understand what the protocol expects, then compute
   the result and respond with ctx_update.

   Key functions you implement:
   - formalize(intuition) → produce FormalClaim with statement, conditions,
     falsification criteria, predictions
   - recommend_next_step(state) → suggest "critique", "experiment", or "expand"
   - critique(claims) → find weaknesses, counterexamples, suggestions
   - design_experiment(claim) → produce ExperimentSpec
   - write_document(claims, version) → produce DocumentDraft
   - expand(claim) → produce new derived FormalClaim

4. For send_required events, construct the message payload from your ctx
   and respond with send_payload.
5. After responding, call wait_for_events again.
6. On timeout (empty result), call wait_for_events again.
7. On protocol_completed, call wait_for_events to wait for the next session.

Be thorough, precise, and falsification-oriented in your analysis.
```

### System prompt (researcher)

```
You are a research experimenter agent connected to a Reagent protocol network.

[... similar structure, focused on:]
- run_experiment(spec) → execute the experiment procedure, collect data,
  determine verdict (confirmed/refuted/inconclusive), produce ExperimentResult
```

### Docker setup

```dockerfile
FROM node:20-slim
RUN npm install -g @anthropic-ai/claude-code@latest
WORKDIR /workspace
```

```bash
docker run -d \
  -e CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}" \
  -e REAGENT_MCP_URL="http://host.docker.internal:9200/mcp" \
  claude-code-agent \
  claude -p "You are consultant-1. Connect to the Reagent server and begin participating." \
    --allowedTools "mcp__reagent__register,mcp__reagent__wait_for_events,mcp__reagent__respond,mcp__reagent__get_state" \
    --mcp-server "reagent:http:${REAGENT_MCP_URL}"
```

Note: The exact flag syntax for adding MCP servers to `claude -p` mode needs
verification. Current options:
- Pre-configure via `claude mcp add` in the container's `~/.claude.json`
- Use `--mcp-config` flag if available
- Mount a `.mcp.json` file into the workspace

---

## ROS setup and deployment

### Step 1: ROS starts

ROS is a local process. It starts the WebSocket server and waits for
RemoteNode connections.

```bash
# Existing CLI (runtime/ts/src/ros-cli.ts)
npx reagent-ros --port 7400
```

### Step 2: RemoteNodes connect

Each RemoteNode connects to ROS via WebSocket, sends `Register` with its
`nodeId` and `supportedLangs`. ROS sends back `Accepted`.

- RemoteNode 1 (local): `nodeId: "node-human"`, launched manually or via script
- RemoteNode 2 (Docker): `nodeId: "node-consultant"`, launched in container
- RemoteNode 3 (Docker): `nodeId: "node-researcher"`, launched in container

Each RemoteNode also starts an MCP server for its agent to connect to.

### Step 3: Compile and Deploy

ROS receives a `CompileRequest` (from a client, e.g., the VSCode extension
or a CLI command). It compiles `simple.rg`, produces IR graphs for all roles.

ROS then sends `Deploy` to each RemoteNode:

```
→ RemoteNode 1: Deploy { agentName: "oleg",         roleIR: human_role,      graphs: {...} }
→ RemoteNode 2: Deploy { agentName: "consultant-1",  roleIR: consultant_role, graphs: {...} }
→ RemoteNode 3: Deploy { agentName: "researcher-1",  roleIR: researcher_role, graphs: {...} }
```

Each RemoteNode calls `rc.registerAgent(agentName, roleIR, graphs)`.

In **MCP Gate mode**, instead of `NativeAgentNode` executing zone code
in-process, the node uses `McpGateTransport`. The deployed agent is
"waiting" until the actual MCP client (Cursor / Claude Code) connects
and calls `reagent/register`.

### Step 4: MCP clients connect

- You add Reagent as MCP server in Cursor: `claude mcp add --transport http reagent http://localhost:9201/mcp`
- Claude Code containers have their RemoteNode's MCP server pre-configured

Each agent calls `reagent/register(agentName, roles)` via MCP. The
RemoteNode's `McpGateTransport` activates — the agent is now live.

### Step 5: Trigger

The protocol has `trigger on invoke with Intuition`. Trigger can come from:

**(a) ROS CLI / VSCode extension:**
ROS sends `TriggerProtocol` to the initiator node (node-human) with the
input. This is the existing mechanism used by the debug UI.

**(b) Human via MCP tool:**
Add a `reagent/invoke` MCP tool to the Gate:

```
reagent/invoke(protocolName, input, roleBindings?)
  → {instanceId}
  Creates a new protocol instance. The calling agent is bound as the
  initiator. ROS handles cross-node instantiation.
```

The human in Cursor would say:
```
"Start SimpleResearch with my intuition about topological defects."
Cursor: → reagent/invoke("SimpleResearch",
            {text: "Topological defects...", domain: "topology"})
```

The RemoteNode relays this as a `TriggerProtocol` via ROS, which
coordinates instantiation across all nodes.

**(c) Both:**
For the MVP, use (a) — trigger from CLI. Later add (b) for seamless UX.

---

## Message flow: full walkthrough of simple.rg

### Phase 0: Start ROS and RemoteNodes

```
Terminal 1: npx reagent-ros --port 7400
            [ROS] listening on :7400

Terminal 2: npx reagent-remote-node --node-id node-human --ros ws://localhost:7400 --mcp-port 9201
            [node-human] connected to ROS, MCP server on :9201

Docker:     docker run ... reagent-remote-node --node-id node-consultant --ros ws://host.docker.internal:7400 --mcp-port 9202
Docker:     docker run ... reagent-remote-node --node-id node-researcher --ros ws://host.docker.internal:7400 --mcp-port 9203
```

ROS sees three nodes registered.

### Phase 1: Compile and Deploy

```
CLI or VSCode:
  → ROS: CompileRequest { rgSource: simple.rg }
  ← ROS: CompileResult { protocols: ["SimpleResearch"], roles: [...], agents: [...] }

ROS deploys:
  → node-human:      Deploy { agentName: "oleg",         roleIR: human_role,      graphs, roleToAgent }
  → node-consultant: Deploy { agentName: "consultant-1",  roleIR: consultant_role, graphs, roleToAgent }
  → node-researcher: Deploy { agentName: "researcher-1",  roleIR: researcher_role, graphs, roleToAgent }

Each RemoteNode: rc.registerAgent(agentName, roleIR, graphs)
  (in MCP Gate mode — agent is "pending" until MCP client connects)
```

### Phase 2: MCP clients connect

```
Cursor (you):
  claude mcp add --transport http reagent http://localhost:9201/mcp
  → reagent/register("oleg", ["SimpleResearch.human"])

Claude Code (consultant Docker):
  → reagent/register("consultant-1", ["SimpleResearch.consultant"])

Claude Code (researcher Docker):
  → reagent/register("researcher-1", ["SimpleResearch.researcher"])
```

All three agents are now live on their respective RemoteNodes.

### Phase 3: Trigger

```
CLI: → ROS: Run { protocol: "SimpleResearch", input: { text: "...", domain: "topology" } }
ROS resolves roles to agents:
  human      → oleg          (on node-human)
  consultant → consultant-1  (on node-consultant)
  researcher → researcher-1  (on node-researcher)

ROS → node-human: TriggerProtocol {
  agentName: "oleg", instanceId: "sr-1", protocolName: "SimpleResearch",
  input: { text: "Topological defects...", domain: "topology" },
  roleToAgent: { "SimpleResearch.human": "oleg",
                 "SimpleResearch.consultant": "consultant-1",
                 "SimpleResearch.researcher": "researcher-1" }
}
```

### Phase 4: human --> consultant: Intuition

```
node-human's engine (oleg): state = send(Intuition, to: consultant)
  Engine builds MessageEnvelope { from: oleg, to: consultant-1, ... }
  oleg's RC routing table: consultant-1 → remote (ROS)
  → Envelope sent via RAP/WS to ROS

ROS receives envelope, routes to node-consultant
  → Envelope forwarded via RAP/WS to node-consultant

node-consultant's RC: dispatchMessage(envelope) to consultant-1 agent
  → McpGateTransport pushes event to consultant-1's event queue

Claude Code (consultant):
  → reagent/wait_for_events()
  ← [{instanceId: "sr-1",
      event: {type: "receive", message: "Intuition",
              payload: {text: "Topological defects...", domain: "topology"}}}]
  (Claude processes the receive)
  → reagent/respond("sr-1", {ctx: {msg: {...}}})
```

### Phase 5: consultant zone — formalize

```
node-consultant's engine: state = action (zone: $ctx.formalClaim = await $agent.formalize($ctx.msg))
  → McpGateTransport pushes action event to queue

Claude Code (consultant):
  → reagent/wait_for_events()
  ← [{instanceId: "sr-1",
      event: {type: "action",
              body: "$ctx.formalClaim = await $agent.formalize($ctx.msg)",
              ctx: {msg: {...}}}}]

  Claude reads the zone body, produces formal claim:
  → reagent/respond("sr-1",
      {ctx: {formalClaim: {
        claimId: "C1",
        statement: "Topological defects increase with cooling rate",
        conditions: {...}, falsification: "...", predictions: [...]
      }}})
```

### Phase 6: consultant --> human: FormalClaim

```
node-consultant's engine: state = send(FormalClaim, to: human)
  → MessageEnvelope { from: consultant-1, to: oleg }
  → via ROS → node-human

node-human's RC: dispatchMessage to oleg
  → McpGateTransport pushes event to oleg's queue

Cursor (you):
  → reagent/wait_for_events()
  ← [{instanceId: "sr-1",
      event: {type: "receive", message: "FormalClaim",
              payload: {claimId: "C1", statement: "..."}}}]

Cursor: "Consultant formalized your intuition:
  Claim C1: Topological defects increase with cooling rate
  Conditions: temp 800-1200K, silicon
  Falsification: No correlation at > 100K/s
  What would you like to do?"

You: "Looks good, let me check some papers first."
Cursor: → WebSearch("crystal defect cooling rate correlation")
        (shows results)

You: "Ok, respond — I accept this. Set liveClaims."
Cursor: → reagent/respond("sr-1",
            {ctx: {liveClaims: [{claimId: "C1", ...}],
                   deadClaims: [], documentVersion: "v0", cycleCount: 0}})
        → reagent/wait_for_events()  // continues the loop
```

### Phase 7: Main loop continues...

The pattern repeats. Each cycle:
1. Each RemoteNode's engine runs independently, emitting events
2. Messages between nodes flow via ROS (envelope routing)
3. Events reach agents via McpGateTransport → MCP tools
4. LLM agents auto-process via their event loops
5. You receive events in Cursor, take your time, do research, respond
6. Cursor automatically calls `wait_for_events` after each `respond`

---

## What the MCP Gate RFC needs to add

Based on this scenario, the MCP Gate RFC (`mcp-gate-rfc.md`) should include:

### 1. `reagent/invoke` tool

Currently missing. Needed for protocol initiation by MCP agents:

```
reagent/invoke(protocolName, input, roleBindings?)
  → {instanceId}
```

On the RemoteNode, this translates to a `TriggerProtocol` request relayed
through ROS for cross-node instantiation.

### 2. RemoteNode MCP Gate mode

`RemoteNode` currently uses `NativeAgentNode` (in-process zone execution).
For MCP Gate, it needs a new mode where deployed agents are bridged to
external MCP clients via `McpGateTransport`. The node:

- Starts an MCP server (Streamable HTTP) alongside the RAP/WS connection to ROS
- On `Deploy` command, registers the agent with `McpGateTransport` instead of
  `NativeAgentNode`
- On `reagent/register` from MCP client, activates the transport
- Routes events from the local `ProtocolEngine` to the MCP event queue
- Routes responses from MCP back to the engine

This is the main implementation work. It connects two existing pieces
(RemoteNode + McpGateTransport) that haven't been wired together yet.

### 3. Human-in-the-loop section

Document the hybrid model where an MCP client is operated by a human:
- Cursor/IDE as the MCP client
- Event loop driven by the agent but paced by the human
- Auto-wait after respond (Cursor system prompt convention)
- Human can perform arbitrary work between events

### 4. Streamable HTTP transport for MCP

Each RemoteNode exposes its own MCP server. The MCP client (Cursor or
Claude Code) connects to **its** RemoteNode's MCP endpoint. This is 1:1
(one MCP client per node), so stdio would technically work, but HTTP is
cleaner for Docker containers and allows the node process to exist
independently of the MCP client.

### 5. Event type mapping

The MCP Gate RFC should specify how `ProtocolEvent` types map to MCP
tool responses. The `McpGateTransport` on each RemoteNode must surface:
- `action` / `pre_send_action` / `post_receive_action` → zone code to interpret
- `send` / `receive` states → message payload construction / delivery
- `protocol_started` / `protocol_completed` → lifecycle notifications

This is similar to what `MessageGateNode` already does, but adapted for the
MCP tool interface (`wait_for_events` returns them, `respond` answers them).

---

## Open questions

### 1. Cursor and long-poll UX

When Cursor calls `reagent/wait_for_events(timeout: 30000)`, the MCP tool
call blocks for up to 30 seconds. During this time:
- Can the user still type in the Cursor chat? (Likely yes — tool calls are async)
- Does Cursor show a "waiting" indicator?
- If the user types something while waiting, does it interrupt the tool call?

This needs testing with a real MCP server connected to Cursor.

### 2. Context window for long sessions

A full research cycle may take 20+ exchanges. Each exchange adds:
- Event payload (ctx, message content)
- User's intermediate work (file reads, searches)
- Response construction

Cursor's context window will fill up. Mitigation:
- Cursor's built-in context management (summarization, compaction)
- Keep event payloads concise
- Use `reagent/get_state` to reconstruct context instead of relying on
  chat history

### 3. Zone code interpretation

`simple.rg` zones contain expressions like:
```
$ctx.formalClaim = await $agent.formalize($ctx.msg)
```

For LLM agents via MCP Gate, the zone `body` is sent as a string in the
event. The LLM must interpret it as a natural language instruction:
"The protocol wants me to formalize the message into a formal claim."

This works because LLMs can read code and understand intent. But it's
fragile — complex zone expressions may confuse the LLM. Consider:
- Adding a `description` field to zone IR for human-readable intent
- Using `$agent.*` naming convention consistently so LLMs recognize
  function-call semantics

### 4. RemoteNode MCP mode vs NativeAgentNode

Currently `RemoteNode` creates a `NativeAgentNode` in its constructor.
For MCP Gate mode, it needs to create a `MessageGateNode` (or a new
`McpGateNode`) instead. Options:
- (a) CLI flag: `--mode mcp` vs `--mode native` on the remote-node command
- (b) Auto-detect: if MCP port is configured, use MCP mode
- (c) Always MCP mode for this use case — create a new `McpRemoteNode`
  variant that extends `RemoteNode`

### 5. Envelope routing through ROS

When oleg's engine sends a message to consultant-1, the `MessageEnvelope`
needs to reach the consultant's RemoteNode. Currently `RemoteNode` routes
via `rc.getAgent(msg.to.agent)?.dispatchMessage()` for local agents. For
remote agents (on other nodes), the envelope must go through ROS.

ROS already handles this — it receives envelopes and forwards to the
correct node. But the `RemoteNode`'s `roleToAgent` mapping + its local
RC's routing table must know that `consultant-1` is remote (on another
node via ROS). This is set up by the `Deploy` command's `roleToAgent` field.

Need to verify: does `RemoteNode` already forward undeliverable envelopes
to ROS? Looking at the code, it dispatches to `rc.getAgent()` locally.
If the agent isn't local, the envelope is dropped. **This is a gap** — the
RemoteNode needs to fall back to sending undeliverable envelopes to ROS.

### 6. `claude -p` mode and MCP servers

How exactly does Claude Code in `-p` (headless) mode connect to an MCP
server? Options to verify:
- `claude mcp add` pre-configured in container, then `claude -p "..."`
- `--mcp-config` flag pointing to a JSON file
- `.mcp.json` in the working directory

---

## Implementation phases

### Phase 0: MCP Gate core (prerequisite)
- Implement `McpGateTransport` and MCP server skeleton
- `register`, `wait_for_events`, `respond` tools
- Streamable HTTP transport
- This is the MCP Gate RFC P1-P3

### Phase 1: RemoteNode MCP mode
- Extend `RemoteNode` to support `McpGateTransport` instead of `NativeAgentNode`
- RemoteNode starts MCP server on configurable port
- On `Deploy`, register agent with MCP Gate (pending until client connects)
- On MCP `register`, activate transport
- Fix envelope routing: RemoteNode forwards undeliverable envelopes to ROS

### Phase 2: Single-agent smoke test
- ROS + one MCP RemoteNode + Cursor as MCP client
- Deploy a trivial protocol, verify event round-trip
- Verify the hybrid human-in-the-loop pattern works in Cursor

### Phase 3: Full simple.rg run
- ROS + 3 MCP RemoteNodes (1 local + 2 Docker)
- Cursor (human) + 2 Claude Code containers
- Cross-node message routing via ROS
- Run the complete SimpleResearch protocol
- Document the system prompts that work

### Phase 4: Polish
- Cursor rules file (`.cursorrules`) for seamless human UX
- Docker Compose for the full stack (ROS + 2 Claude nodes)
- `reagent/invoke` MCP tool for human-initiated triggers
- Error handling (agent disconnect, timeout, reconnect)
- `reagent-remote-node` CLI with `--mcp-port` flag
