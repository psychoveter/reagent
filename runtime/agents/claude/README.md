# Claude Live Agent

Headless Claude live-agent for Reagent protocols, using `@anthropic-ai/claude-agent-sdk`.

## How it works

`live-agent.ts` uses the SDK's `query()` function to handle one Reagent protocol event at a time.
The `mcp-gate` process is launched as a subprocess MCP server, giving Claude access to
Reagent tools (`register`, `wait_for_events`, `respond`, `invoke`).

```
live-agent.ts ──SDK──> Claude API
       │
       └──stdio──> mcp-gate.js ──> RC ──> NATS/etcd/control-endpoint
```

## Setup

1. Create `.env` with `ANTHROPIC_API_KEY=sk-ant-...`
2. Run `./run-worker.sh` (builds Docker image, starts container)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `CLAUDE_NODE_CONFIG` | `/opt/task-delegation-config/worker.claude-node.docker.json` | Wrapper config containing embedded Reagent runtime config plus Claude settings |
| `MCP_GATE_PATH` | `/opt/reagent/dist/mcp-gate.js` | Path to the `mcp-gate` entrypoint |
| `MCP_RUNTIME_CONFIG` | unset | Legacy fallback: direct runtime config path for `mcp-gate` |
| `AGENT_NAME` / `AGENT_ROLES` | unset | Legacy fallback: direct agent identity overrides |
| `MAX_TURNS` | `4` | Legacy fallback max SDK turns when wrapper config is not used |

## Development

```bash
npm install          # install SDK
npm run build        # compile live-agent.ts and legacy worker-agent.ts
npm start            # run the config-driven live-agent locally
```

## Files

- `live-agent.ts` — canonical config-driven Claude live-agent entrypoint
- `worker-agent.ts` — legacy autonomous variant kept for compatibility
- `Dockerfile` — container image (node:20-slim + reagent runtime + live-agent)
- `run-worker.sh` — build & run Docker container
- `.env` — API key (not committed)
