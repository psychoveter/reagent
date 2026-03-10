#!/usr/bin/env bash
# Task Delegation E2E launcher
#
# Prerequisites:
#   - Docker installed and running
#   - Node.js 20+ with npm
#   - Reagent runtime built (cd runtime/ts && npm run build)
#
# This script starts the shared infrastructure (NATS, etcd),
# compiles the protocol, starts ROS, and deploys.
# The two MCP gates (human-gate, worker-gate) are started separately
# by Cursor and Claude Code respectively.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNTIME_TS="$PROJECT_ROOT/runtime/ts"

cleanup() {
  echo "Shutting down..."
  [ -n "${ROS_PID:-}" ] && kill "$ROS_PID" 2>/dev/null || true
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" down 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT

# ── 1. Start NATS + etcd via docker compose ───────────────────────

echo "Starting NATS + etcd..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d --wait
echo "NATS running on :4222 (monitoring :8222)"
echo "etcd running on :2379"

# ── 3. Build runtime (if needed) ──────────────────────────────────

if [ ! -f "$RUNTIME_TS/dist/ros.js" ]; then
  echo "Building runtime..."
  (cd "$RUNTIME_TS" && npm run build)
fi

# ── 4. Compile protocol ───────────────────────────────────────────

echo "Compiling protocol..."
node "$PROJECT_ROOT/lang/dist/cli.js" build "$SCRIPT_DIR"

# ── 5. Start ROS ──────────────────────────────────────────────────

echo "Starting ROS on :18789..."
node "$RUNTIME_TS/dist/ros-cli.js" --port 18789 &
ROS_PID=$!
sleep 1

echo ""
echo "============================================"
echo "  Infrastructure ready!"
echo ""
echo "  NATS:  nats://localhost:4222"
echo "  etcd:  http://127.0.0.1:2379"
echo "  ROS:   ws://localhost:18789"
echo ""
echo "  Next steps:"
echo "  1. Open this folder in Cursor (human-gate MCP starts automatically)"
echo "  2. Start Claude Code worker: cd runtime/agents/claude && ./run.sh"
echo "  3. Deploy via ROS: send DeployProject RAP message"
echo "  4. Trigger: send TriggerOnCluster RAP message"
echo "============================================"
echo ""

wait "$ROS_PID"
