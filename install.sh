#!/usr/bin/env bash
# Install copilot-ralph-extension to user-scoped Copilot CLI extensions dir.
# Usage: ./install.sh [--project] [--help]
#   default: ~/.copilot/extensions/ralph
#   --project: .github/extensions/ralph in current git repo
#   --help:    show this message

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/extension"
FILES=(extension.mjs handler.mjs)

for f in "${FILES[@]}"; do
  if [[ ! -f "$SOURCE_DIR/$f" ]]; then
    echo "Error: $SOURCE_DIR/$f not found." >&2
    exit 1
  fi
done

# Sanity: source files must parse as valid ES modules before we copy them.
if command -v node >/dev/null 2>&1; then
  for f in "${FILES[@]}"; do
    if ! node --check "$SOURCE_DIR/$f" 2>/dev/null; then
      echo "Error: $SOURCE_DIR/$f failed Node.js syntax check; refusing to install." >&2
      exit 1
    fi
  done
else
  echo "Warning: node not found; skipping syntax check." >&2
fi

if [[ "${1:-}" == "--project" ]]; then
  GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$GIT_ROOT" ]]; then
    echo "Error: --project requires being inside a git repo." >&2
    exit 1
  fi
  TARGET_DIR="$GIT_ROOT/.github/extensions/ralph"
elif [[ -n "${1:-}" ]]; then
  echo "Error: unknown argument '$1' (try --help)." >&2
  exit 1
else
  TARGET_DIR="$HOME/.copilot/extensions/ralph"
fi

mkdir -p "$TARGET_DIR"
cp "$SOURCE_DIR/extension.mjs" "$SOURCE_DIR/handler.mjs" "$TARGET_DIR/"

# Post-copy verification: every file must exist at the destination.
for f in "${FILES[@]}"; do
  if [[ ! -f "$TARGET_DIR/$f" ]]; then
    echo "Error: post-install verification failed; $TARGET_DIR/$f missing." >&2
    exit 1
  fi
done

echo "✅ Installed ralph extension to $TARGET_DIR/"
echo ""
echo "Restart Copilot CLI (or run /extensions reload) to activate."
