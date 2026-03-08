#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/reagent-vscode"
CURSOR="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
EXT_ID="psychoveter.reagent-vscode"

VERSION=$(node -p "require('$PLUGIN_DIR/package.json').version")
VSIX="$PLUGIN_DIR/reagent-vscode-${VERSION}.vsix"

# Uninstall ALL previously installed versions of the plugin (any version tag)
INSTALLED=$("$CURSOR" --list-extensions --show-versions 2>/dev/null | grep -i "^psychoveter\.reagent" || true)
if [ -n "$INSTALLED" ]; then
  while IFS= read -r ext; do
    EXT_NAME="${ext%%@*}"
    echo "==> Uninstalling ${ext} ..."
    "$CURSOR" --uninstall-extension "$EXT_NAME" 2>/dev/null || true
  done <<< "$INSTALLED"
fi

echo "==> Building reagent-vscode v${VERSION} ..."
(cd "$PLUGIN_DIR" && npm run package)

echo "==> Installing ${VSIX} ..."
"$CURSOR" --install-extension "$VSIX" --force

echo "==> Done. Restart Cursor window to pick up changes."
