FROM node:20-slim

# Reagent runtime (mcp-gate + its dependencies)
WORKDIR /opt/reagent
ARG CACHE_BUST=1
COPY runtime/ts/dist/ ./dist/
COPY runtime/ts/node_modules/ ./node_modules/
COPY runtime/ts/package.json ./

# Worker agent as a standalone project
WORKDIR /opt/worker
COPY runtime/agents/claude/dist/live-agent.js ./live-agent.js
COPY runtime/agents/claude/package.json ./
COPY runtime/agents/claude/node_modules/ ./node_modules/

RUN useradd -m -s /bin/sh worker && mkdir -p /workspace && chown worker:worker /workspace

ENV MCP_GATE_PATH=/opt/reagent/dist/mcp-gate.js

USER worker
WORKDIR /workspace

CMD ["node", "/opt/worker/live-agent.js"]
