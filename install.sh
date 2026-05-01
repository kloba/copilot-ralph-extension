#!/usr/bin/env bash
# Install copilot-ralph-extension to user-scoped Copilot CLI extensions dir.
# Usage: ./install.sh [--project] [--dry-run] [--help]
#   default:    ~/.copilot/extensions/ralph
#   --project:  .github/extensions/ralph in current git repo
#   --dry-run:  show what would be installed without writing anything
#   --help:     show this message

set -euo pipefail

DRY_RUN=0
# These sentinels are set in the --dry-run / --project arms below and
# read indirectly via reject_duplicate's `${!sentinel}` lookup. Keep
# them declared up front so `set -u` doesn't trip on first read.
SEEN_DRY_RUN=0
SEEN_PROJECT=0
# Reject duplicates so a copy-paste typo (`./install.sh --dry-run --dry-run`)
# surfaces loudly instead of being silently accepted — the user almost
# certainly meant a different second flag. Bash indirect ref `${!var}`
# lets one helper handle every flag's sentinel without per-flag boilerplate.
reject_duplicate() {
  local flag="$1" sentinel="$2"
  if [[ "${!sentinel}" == "1" ]]; then
    echo "Error: $flag specified more than once." >&2
    exit 1
  fi
}
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      # Print the leading comment block (lines 2..first non-comment),
      # decoupling --help from a hard-coded line range so refactors of
      # the header (adding/removing a flag description) don't desync.
      awk '/^[^#]/{exit} NR>1{print}' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --dry-run)
      reject_duplicate --dry-run SEEN_DRY_RUN
      # shellcheck disable=SC2034
      SEEN_DRY_RUN=1
      DRY_RUN=1
      ;;
    --project)
      reject_duplicate --project SEEN_PROJECT
      SEEN_PROJECT=1
      ;;
    *)
      echo "Error: unknown argument '$arg' (try --help)." >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/extension"
FILES=(extension.mjs handler.mjs events-emit.mjs)

for f in "${FILES[@]}"; do
  if [[ ! -f "$SOURCE_DIR/$f" ]]; then
    echo "Error: $SOURCE_DIR/$f not found." >&2
    exit 1
  fi
done

# Sanity: source files must parse as valid ES modules before we copy them.
# Capture node's stderr so we can surface the actual SyntaxError + line
# number — the previous `2>/dev/null` swallowed the most useful piece of
# debugging info and left the user with only a generic "failed" message.
if command -v node >/dev/null 2>&1; then
  for f in "${FILES[@]}"; do
    if ! err=$(node --check "$SOURCE_DIR/$f" 2>&1); then
      printf 'Error: %s failed Node.js syntax check; refusing to install.\n%s\n' "$SOURCE_DIR/$f" "$err" >&2
      exit 1
    fi
  done
else
  echo "Warning: node not found; skipping syntax check." >&2
fi

if [[ "$SEEN_PROJECT" == "1" ]]; then
  GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$GIT_ROOT" ]]; then
    echo "Error: --project requires being inside a git repo." >&2
    exit 1
  fi
  TARGET_DIR="$GIT_ROOT/.github/extensions/ralph"
else
  # User-scoped install needs $HOME. Surface a friendly error if it's
  # unset (cron / minimal docker / weird CI) instead of letting `set -u`
  # bail out with a cryptic "HOME: unbound variable" diagnostic.
  if [[ -z "${HOME:-}" ]]; then
    echo "Error: \$HOME is not set; cannot determine user-scoped install path. Pass --project to install into the current git repo instead." >&2
    exit 1
  fi
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
# Atomic per-file install: write to a sibling temp file in the target dir
# (so it's on the same filesystem as the destination — required for
# rename(2) atomicity), then mv. A naive `cp src dst` does open+write,
# which can momentarily leave a half-written handler.mjs that a concurrent
# Copilot CLI reload might import and crash on. The temp+mv pattern
# guarantees readers always see either the old file or the fully-written
# new file, never a torn copy.
TMP_FILES=()
cleanup() {
  # Safely expand a potentially-empty array under `set -u` (macOS bash 3.2
  # treats `"${TMP_FILES[@]}"` as an unbound variable when the array is
  # empty). The `${arr[@]+"${arr[@]}"}` idiom only expands if at least one
  # element is set, so the trap is robust if it fires before the first
  # temp file is pushed (e.g. SIGINT between trap install and the loop).
  for tmp in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do
    [[ -e "$tmp" ]] && rm -f "$tmp"
  done
}
trap cleanup EXIT
for f in "${FILES[@]}"; do
  TMP="$TARGET_DIR/.$f.tmp.$$"
  TMP_FILES+=("$TMP")
  cp "$SOURCE_DIR/$f" "$TMP"
  mv "$TMP" "$TARGET_DIR/$f"
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
