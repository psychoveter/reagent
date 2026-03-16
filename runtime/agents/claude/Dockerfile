FROM node:20-slim

# Reagent runtime (contains claude-node entrypoint + all behavior factories)
WORKDIR /opt/reagent
ARG CACHE_BUST=1
COPY runtime/ts/dist/ ./dist/
COPY runtime/ts/node_modules/ ./node_modules/
COPY runtime/ts/package.json ./

RUN useradd -m -s /bin/sh worker && mkdir -p /workspace && chown worker:worker /workspace

USER worker
WORKDIR /workspace

CMD ["node", "/opt/reagent/dist/nodes/claude/claude-node.js"]
