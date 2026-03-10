#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Set ANTHROPIC_API_KEY in .env" >&2
  exit 1
fi

REAGENT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNTIME_TS="$REAGENT_ROOT/runtime/ts"

echo "==> Compiling reagent runtime..."
(cd "$RUNTIME_TS" && npx tsc --skipLibCheck || true)

echo "==> Compiling worker-agent..."
(cd "$SCRIPT_DIR" && npx tsc)

echo "==> Building Docker image..."
docker build -t reagent-worker-agent \
  --build-arg "CACHE_BUST=$(date +%s)" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$REAGENT_ROOT" 2>&1

echo "==> Starting worker agent..."
docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
    -e "ROS_URL=${ROS_URL:-ws://host.docker.internal:18789}" \
    -e "NATS_URL=${NATS_URL:-nats://host.docker.internal:4222}" \
    -e "ETCD_HOSTS=${ETCD_HOSTS:-http://host.docker.internal:2379}" \
    -e "NODE_ID=${NODE_ID:-worker-gate}" \
    -e "WORKER_AGENT=${WORKER_AGENT:-WorkerAgent}" \
    -e "WORKER_ROLES=${WORKER_ROLES:-WorkerRole}" \
    -e "MAX_TURNS=${MAX_TURNS:-200}" \
    reagent-worker-agent
