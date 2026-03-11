#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
"$SCRIPT_DIR/../../../runtime/ts/node_modules/.bin/tsx" ./run_node.ts --runtime-config ./node.runtime.json --auto-deploy