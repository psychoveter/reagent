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

## Quick start

### Option A: VSCode command (recommended)

Open this directory in Cursor, then run **`Reagent: MCP Dev Cycle`** from the command palette. This:

1. Starts NATS + etcd via `docker compose`
2. Starts ROS
3. Compiles the protocol
4. Deploys to the cluster

The human-gate MCP server starts automatically via `.cursor/mcp.json`. The Cluster Panel shows infrastructure health (NATS / etcd / ROS).

To recompile after editing `.rg` files: **`Reagent: Recompile & Redeploy (MCP)`**.

### Option B: Manual shell script

```bash
./run.sh
```

This starts NATS + etcd (docker compose), compiles the protocol, and starts ROS.

### Worker agent (Claude via Agent SDK)

The worker runs as a headless Claude agent using `@anthropic-ai/claude-agent-sdk` in a Docker container.

```bash
cd ../../../runtime/agents/claude
# Set ANTHROPIC_API_KEY in .env
./run-worker.sh
```

This builds and starts a Docker container that:
1. Launches `mcp-gate` as a subprocess (connects to ROS, NATS, etcd)
2. Runs Claude via the Agent SDK with `reagent` as its MCP server
3. Autonomously registers as `WorkerAgent` and enters the event loop

### Deploy and trigger

With the MCP Dev Cycle, deploy happens automatically. For manual operation, send RAP messages to ROS (`ws://localhost:18789`):

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
- `.cursor/mcp.json` — Cursor MCP server config (human-gate)
- `.cursorrules` — instructions for Cursor agent on how to use Reagent MCP tools
- `run.sh` — infrastructure launcher (manual alternative)
