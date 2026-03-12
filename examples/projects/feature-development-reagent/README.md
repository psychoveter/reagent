# Feature Development Reagent

Use case: structured feature delivery with a human in Cursor and three collaborating roles:

- `human` — product owner / approver via Cursor MCP
- `analyst` — formalizes the task, updates user-facing and product/spec docs
- `developer` — produces architecture/design, implementation, and tests
- `reviewer` — reviews analyst and developer outputs and sends feedback

The workflow is staged:

1. `DesignStage`
2. `ImplementationStage`
3. `FinalizationStage`

Each stage has its own analyst/developer/reviewer iteration loop. When the trio converges,
the stage is sent to the human for approval. The top-level protocol invokes the three stages
in order and returns the final package.

## Suggested runtime shape

Recommended reference deployment:

- `human` — Cursor via MCP Gate
- `analyst` — MCP-backed or Claude/live MCP agent
- `developer` — MCP-backed or Claude/live MCP agent
- `reviewer` — MCP-backed or Claude/live MCP agent

Single-node prototype:

- one TypeScript `ReagentController`
- four MCP-backed agents
- `trigger on invoke` from the human role

Clustered variant:

- one RC per remote role host
- etcd for discovery/presence
- message plane for inter-node routing

## Build

From `projects/reagent/`:

```bash
node lang/dist/cli.js build examples/projects/feature-development-reagent
```
