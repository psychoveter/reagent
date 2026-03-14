# Task Delegation (MCP Gate E2E)

Minimal two-party task delegation: **human** (Cursor IDE) sends a task to **worker** (Claude Agent SDK), worker processes and returns a result.

## Architecture

```
Cursor ──stdio──> mcp-gate (human-gate)  ──NATS──>  mcp-gate (worker-gate) <──stdio── Claude Agent SDK
                        │                                  │
                        └──────── etcd (discovery) ────────┘
                        │                                  │
                        └──────── ROS (deploy/trigger) ────┘
```

Each `mcp-gate` runs its own `ReagentController`. Agent discovery is automatic via etcd watches. Message envelopes flow directly between gates via `NatsNodeLink`.

This example now keeps node wiring in declarative config files:

- `config/human.runtime.json` — plain Reagent runtime config for the human-side `mcp-gate` used by Cursor
- `config/human.claude-node.json` — Claude-backed node wrapper config used by the live e2e path
- `config/worker.claude-node.docker.json` — Claude-backed node wrapper config for the Dockerized worker

Runtime lifecycle in this example:

- deploy installs `ProtocolArtifacts` plus `AgentTemplate`
- the gate can hold an `AgentRecord` before the external client is actually attached
- `reagent_register` from Cursor/Claude attaches `AgentRuntime`, after which the agent becomes addressable

## Quick start

### Option A: VSCode command (recommended)

Open this directory in Cursor, then run **`Reagent: MCP Dev Cycle`** from the command palette. This:

1. Starts NATS + etcd via `docker compose`
2. Starts ROS
3. Compiles the protocol
4. Deploys to the cluster

The human-gate MCP server starts automatically via `.cursor/mcp.json`. That file points `mcp-gate` at `config/human.runtime.json`, so Cursor still talks directly to the gate using the plain Reagent runtime config. Claude-backed nodes use the wrapper config path instead.

To recompile after editing `.rg` files: **`Reagent: Recompile & Redeploy (MCP)`**.

### Option B: Manual shell script

```bash
./run.sh
```

This starts NATS + etcd (docker compose), compiles the protocol, and starts ROS.

### Worker agent (Claude via Agent SDK)

The worker runs as a headless Claude live-agent using `@anthropic-ai/claude-agent-sdk` in a Docker container.

```bash
cd ../../../runtime/agents/claude
# Set ANTHROPIC_API_KEY in .env
./run-worker.sh
```

This builds and starts a Docker container that:
1. Mounts `config/worker.claude-node.docker.json` into the container
2. Launches `claude-node.ts` with that one node config file
3. `claude-node.ts` materializes the embedded Reagent runtime config and bootstraps an in-process RC
4. Claude processes protocol events one-by-one and registers as `WorkerAgent`

### Deploy and trigger

With the MCP Dev Cycle, deploy happens automatically. For manual operation, use the transitional admin tooling layer (`reagent-rgctl`) or send RAP messages to the current legacy ROS admin endpoint (`ws://localhost:18789`):

```json
{
  "rap": "TriggerOnCluster",
  "id": "trigger-1",
  "payload": {
    "agentName": "HumanAgent",
    "protocolName": "TaskDelegation",
    "input": { "description": "Summarize the project README" }
  }
}
```

## Protocol

```
human --> worker: TaskRequest { description, context }
worker --> human: TaskResult  { result, summary }
```

Single round-trip. Both agents execute zone code (pre_send / post_receive) via MCP tools.

## Files

- `protocols/task.rg` — protocol definition
- `reagent.json` — project manifest
- `docker-compose.yml` — NATS + etcd infrastructure (with health checks)
- `config/human.runtime.json` — plain Reagent runtime config for Cursor's human gate
- `config/*.claude-node*.json` — one-config-per-node wrapper files for Claude-backed live-agent nodes
- `.cursor/mcp.json` — Cursor MCP server config (human-gate)
- `.cursorrules` — instructions for Cursor agent on how to use Reagent MCP tools
- `run.sh` — infrastructure launcher (manual alternative)
