# Claude Worker Agent

Headless Claude worker agent for Reagent protocols, using `@anthropic-ai/claude-agent-sdk`.

## How it works

`worker-agent.ts` uses the SDK's `query()` function to run Claude as an autonomous agent.
The `mcp-gate` process is launched as a subprocess MCP server, giving Claude access to
Reagent tools (`register`, `wait_for_events`, `respond`, `invoke`).

```
worker-agent.ts ──SDK──> Claude API
       │
       └──stdio──> mcp-gate.js ──> RC ──> NATS/etcd/ROS
```

## Setup

1. Create `.env` with `ANTHROPIC_API_KEY=sk-ant-...`
2. Run `./run-worker.sh` (builds Docker image, starts container)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `ROS_URL` | `ws://host.docker.internal:18789` | ROS WebSocket URL |
| `NATS_URL` | `nats://host.docker.internal:4222` | NATS server URL |
| `ETCD_HOSTS` | `http://host.docker.internal:2379` | etcd endpoints |
| `NODE_ID` | `worker-gate` | Cluster node ID |
| `WORKER_AGENT` | `WorkerAgent` | Agent name to register |
| `WORKER_ROLES` | `WorkerRole` | Comma-separated roles |
| `MAX_TURNS` | `200` | Max SDK turns before stopping |

## Development

```bash
npm install          # install SDK
npm run build        # compile worker-agent.ts
npm start            # run locally (needs ANTHROPIC_API_KEY + infra running)
```

## Files

- `worker-agent.ts` — source (system prompt + SDK query loop)
- `Dockerfile` — container image (node:20-slim + reagent runtime + worker)
- `run-worker.sh` — build & run Docker container
- `.env` — API key (not committed)
