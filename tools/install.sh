#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/reagent-vscode"
CURSOR="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"

VERSION=$(node -p "require('$PLUGIN_DIR/package.json').version")
VSIX="$PLUGIN_DIR/reagent-vscode-${VERSION}.vsix"

echo "==> Building reagent-vscode v${VERSION} ..."
(cd "$PLUGIN_DIR" && npm run package)

echo "==> Installing ${VSIX} ..."
"$CURSOR" --install-extension "$VSIX" --force

echo "==> Done. Restart Cursor window to pick up changes."
