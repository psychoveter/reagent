#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_NODE_CONFIG="$SCRIPT_DIR/../../examples/projects/task-delegation/config/worker.claude-node.docker.json"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Set ANTHROPIC_API_KEY in .env" >&2
  exit 1
fi

REAGENT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNTIME_TS="$REAGENT_ROOT/runtime/ts"

echo "==> Compiling reagent runtime (includes claude-node)..."
(cd "$RUNTIME_TS" && npx tsc --skipLibCheck || true)

echo "==> Building Docker image..."
docker build -t reagent-worker-agent \
  --build-arg "CACHE_BUST=$(date +%s)" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$REAGENT_ROOT" 2>&1

echo "==> Starting worker agent..."
docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -p "${WORKER_CONTROL_PORT:-19092}:19092" \
    -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
    -e "CLAUDE_NODE_CONFIG=${CLAUDE_NODE_CONFIG:-/opt/task-delegation-config/worker.claude-node.docker.json}" \
    -v "${CLAUDE_NODE_CONFIG_PATH:-$DEFAULT_NODE_CONFIG}:/opt/task-delegation-config/worker.claude-node.docker.json:ro" \
    reagent-worker-agent
