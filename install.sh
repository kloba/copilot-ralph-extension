#!/usr/bin/env bash
# Install copilot-ralph-extension to user-scoped Copilot CLI extensions dir.
# Usage: ./install.sh [--project]
#   default: ~/.copilot/extensions/ralph
#   --project: .github/extensions/ralph in current git repo

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/extension/extension.mjs"

if [[ ! -f "$SOURCE" ]]; then
  echo "Error: $SOURCE not found." >&2
  exit 1
fi

if [[ "${1:-}" == "--project" ]]; then
  GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$GIT_ROOT" ]]; then
    echo "Error: --project requires being inside a git repo." >&2
    exit 1
  fi
  TARGET_DIR="$GIT_ROOT/.github/extensions/ralph"
else
  TARGET_DIR="$HOME/.copilot/extensions/ralph"
fi

mkdir -p "$TARGET_DIR"
cp "$SOURCE" "$TARGET_DIR/extension.mjs"
echo "✅ Installed ralph extension to $TARGET_DIR/extension.mjs"
echo ""
echo "Restart Copilot CLI (or run /extensions reload) to activate."
