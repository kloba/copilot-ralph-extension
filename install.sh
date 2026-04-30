#!/usr/bin/env bash
# Install copilot-ralph-extension to user-scoped Copilot CLI extensions dir.
# Usage: ./install.sh [--project] [--dry-run] [--help]
#   default:    ~/.copilot/extensions/ralph
#   --project:  .github/extensions/ralph in current git repo
#   --dry-run:  show what would be installed without writing anything
#   --help:     show this message

set -euo pipefail

DRY_RUN=0
TARGET_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --project)
      TARGET_FLAG="--project"
      ;;
    *)
      echo "Error: unknown argument '$arg' (try --help)." >&2
      exit 1
      ;;
  esac
done

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

if [[ "$TARGET_FLAG" == "--project" ]]; then
  GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$GIT_ROOT" ]]; then
    echo "Error: --project requires being inside a git repo." >&2
    exit 1
  fi
  TARGET_DIR="$GIT_ROOT/.github/extensions/ralph"
else
  TARGET_DIR="$HOME/.copilot/extensions/ralph"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY RUN — no files will be written."
  echo "Source:    $SOURCE_DIR/"
  echo "Target:    $TARGET_DIR/"
  echo "Files:"
  for f in "${FILES[@]}"; do
    size=$(wc -c < "$SOURCE_DIR/$f" | tr -d ' ')
    echo "  $f ($size bytes)"
  done
  exit 0
fi

mkdir -p "$TARGET_DIR"
for f in "${FILES[@]}"; do
  cp "$SOURCE_DIR/$f" "$TARGET_DIR/$f"
done

# Post-copy verification: every file must exist AND be byte-identical to source.
for f in "${FILES[@]}"; do
  if [[ ! -f "$TARGET_DIR/$f" ]]; then
    echo "Error: post-install verification failed; $TARGET_DIR/$f missing." >&2
    exit 1
  fi
  if ! cmp -s "$SOURCE_DIR/$f" "$TARGET_DIR/$f"; then
    echo "Error: post-install verification failed; $TARGET_DIR/$f differs from source (partial copy?)." >&2
    exit 1
  fi
done

echo "✅ Installed ralph extension to $TARGET_DIR/"
echo ""
echo "Restart Copilot CLI (or run /extensions reload) to activate."
