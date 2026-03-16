# Claude Node — Docker Wrapper

Docker packaging for the Reagent Claude node. The actual entrypoint
(`claude-node.ts`), behavior factory (`claude-behavior-factory.ts`), and
config types (`claude-config.ts`) live in `@reagent/agent-runtime`
(`runtime/ts/src/`).

## Architecture

```
runtime/ts/src/
  ├── claude-node.ts            — entrypoint (bin: reagent-claude-node)
  └── nodes/
        ├── claude-behavior-factory.ts — ClaudeBehaviorFactory (AgentBehavior → Claude SDK)
        └── claude-config.ts           — config types and loaders

runtime/agents/claude/          ← this directory
  ├── Dockerfile                — container image (node:20-slim + runtime dist)
  ├── run-worker.sh             — build & run Docker container
  ├── worker-agent.ts           — legacy autonomous variant (uses MCP child process)
  └── .env                      — API key (not committed)
```

## Setup

1. Create `.env` with `ANTHROPIC_API_KEY=sk-ant-...`
2. Run `./run-worker.sh` (builds Docker image, starts container)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `CLAUDE_NODE_CONFIG` | (required unless MCP_RUNTIME_CONFIG set) | Wrapper config with embedded Reagent runtime config + Claude settings |
| `MCP_RUNTIME_CONFIG` | unset | Legacy fallback: direct runtime config path |
| `AGENT_NAME` / `AGENT_ROLES` | unset | Legacy fallback: direct agent identity overrides |
| `MAX_TURNS` | `4` | Legacy fallback max SDK turns when wrapper config is not used |

## Running locally (without Docker)

```bash
# From the runtime root
cd runtime/ts
npm run build
node dist/nodes/claude/claude-node.js
```
