#!/usr/bin/env bash
# Install copilot-ralph-extension to user-scoped Copilot CLI extensions dir.
# Usage: ./install.sh [--project] [--dry-run] [--version|-V] [--help|-h]
#   default:        ~/.copilot/extensions/ralph
#   --project:      .github/extensions/ralph in current git repo
#   --dry-run:      show what would be installed without writing anything
#   --version, -V:  print the extension version and exit
#   --help, -h:     show this message

set -euo pipefail

# Resolve script paths and extract the canonical version FIRST so the
# --version flag (and the --help arm via the awk header extractor) can
# use them without spawning a second awk invocation. The empty-version
# guard catches a future refactor that breaks the `export const VERSION`
# declaration shape — fail loudly rather than print "v" and continue.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/extension"
# Friendly diagnostic when the source tree is missing handler.mjs (e.g. a
# user copied install.sh out of the repo without the extension/ subdir).
# Without this guard, awk below fails with the cryptic "awk: can't open
# file ..." message and an exit code of 2 — the user has no clue they
# need to bring the extension/ subdir along. Surfacing the friendly error
# up front mirrors the per-file check that runs later for the rest of
# FILES; doing it here too keeps the error message symmetric across all
# four files in the install set.
if [[ ! -f "$SOURCE_DIR/handler.mjs" ]]; then
  echo "Error: $SOURCE_DIR/handler.mjs not found." >&2
  echo "  Hint: install.sh must live next to the extension/ subdir from this repo. Re-clone or re-download the full source tree." >&2
  exit 1
fi
# Extract `export const VERSION = "X.Y.Z";` from a handler.mjs file.
# Single source of truth for the awk pattern: used (a) at script start
# to read the source-tree VERSION (the "what would be installed"
# answer for --version, --dry-run, and the success line), and (b) by
# --dry-run to read the already-installed VERSION at TARGET_DIR for
# the "Installed:" header line. A drift between the two awks (e.g. a
# future refactor that tightens one regex but forgets the other)
# would silently misreport one of the two versions on otherwise-valid
# input, so a single helper guarantees lockstep evolution. Caller
# must redirect stderr if a missing file is expected (the b-call
# does); the a-call expects the file to exist (already guarded by
# the [[ -f ]] check above).
extract_handler_version() {
  awk -F'"' '/^export const VERSION = "/{print $2; exit}' "$1"
}
VERSION="$(extract_handler_version "$SOURCE_DIR/handler.mjs")"
if [[ -z "$VERSION" ]]; then
  echo "Error: could not extract VERSION from $SOURCE_DIR/handler.mjs (expected an 'export const VERSION = \"X.Y.Z\";' line)." >&2
  exit 1
fi

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
    --version|-V)
      # Source-of-truth-shared with the dry-run header + post-install
      # success line: every place that prints a version reads the same
      # `export const VERSION` declaration in handler.mjs (extracted
      # above). A user/CI script that wants to know "which version
      # would this script install?" can now do so without parsing
      # `--dry-run` output or reading handler.mjs themselves.
      echo "copilot-ralph-extension v$VERSION"
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

# Order matters: leaf modules first, entry point LAST. The Copilot CLI
# loads `extension.mjs` and that file imports handler.mjs + events-emit.mjs.
# If a concurrent `/extensions reload` fires mid-install, replacing the
# entry point last means the SDK either sees the old fully-coherent set
# (entry not yet replaced → still imports old siblings, which the trap-
# preserving atomic per-file mv has already left intact at that instant)
# OR the new fully-coherent set (entry replaced → imports the already-
# replaced new siblings). It can never see an old entry against new
# siblings whose API contract may have shifted under it.
FILES=(events-emit.mjs handler.mjs extension.mjs)

# VERSION is extracted from `extension/handler.mjs`'s `export const
# VERSION = "X.Y.Z";` declaration above the arg-parse loop so the
# --version flag can use it. Sourcing from handler.mjs (rather than
# package.json) avoids a dependency on `node` / a JSON parser at
# install time and keeps the version surface a single source of
# truth — handler.mjs's constant is what the running extension
# reports via `ralph_status`. The empty-version guard up there
# fails the install loudly if a future refactor breaks the
# declaration shape rather than printing "v" to the user.

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
  # Surface a clear error when `git` itself is missing from PATH instead
  # of relying on `git rev-parse` failing through the empty-string
  # fallthrough below — that path mis-attributes a missing binary as
  # "not inside a git repo", sending the user looking for a phantom repo
  # rather than installing git. `command -v` is a bash builtin so this
  # check works even on minimal containers where coreutils may be
  # trimmed (the user can't have hit --project without `bash` running
  # this script anyway, so the builtin is always available).
  if ! command -v git >/dev/null 2>&1; then
    echo "Error: --project requires the 'git' binary in PATH, but it was not found." >&2
    echo "  Hint: install git, or omit --project to install into the user-scoped path (~/.copilot/extensions/ralph)." >&2
    exit 1
  fi
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
  # Show the currently-installed version (if any) so a contributor
  # running `--dry-run` knows whether they're staging a fresh install,
  # an upgrade, a downgrade, or a no-op reinstall — without having to
  # cd into TARGET_DIR and grep handler.mjs themselves. The same awk
  # extractor used at the top of this script is run against the target
  # dir's handler.mjs; missing target / unparseable VERSION renders as
  # "(none)" so the dry-run output stays informative even when the
  # extension was never installed before. Emitted before the "Version:"
  # line so the upgrade direction (old → new) reads top-to-bottom.
  installed_version="(none)"
  if [[ -f "$TARGET_DIR/handler.mjs" ]]; then
    installed_extracted="$(extract_handler_version "$TARGET_DIR/handler.mjs" 2>/dev/null || true)"
    if [[ -n "$installed_extracted" ]]; then
      installed_version="v$installed_extracted"
    fi
  fi
  echo "Installed: $installed_version"
  echo "Version:   v$VERSION"
  echo "Source:    $SOURCE_DIR/"
  echo "Target:    $TARGET_DIR/"
  echo "Files:"
  total=0
  new_count=0
  overwrite_count=0
  for f in "${FILES[@]}"; do
    size=$(wc -c < "$SOURCE_DIR/$f" | tr -d ' ')
    # Surface whether each file would be a fresh write or an overwrite
    # of an existing target — useful for a contributor verifying that
    # `./install.sh --dry-run` is a first-time install vs an upgrade.
    # `cmp -s` compares bytes; identical content earns the explicit
    # "unchanged" label so a no-op upgrade is obvious from the dry run
    # alone.
    if [[ -f "$TARGET_DIR/$f" ]]; then
      if cmp -s "$SOURCE_DIR/$f" "$TARGET_DIR/$f"; then
        status="unchanged"
      else
        status="overwrite"
      fi
      overwrite_count=$((overwrite_count + 1))
    else
      status="new"
      new_count=$((new_count + 1))
    fi
    echo "  $f ($size bytes) [$status]"
    total=$((total + size))
  done
  # Surface the total install footprint so a contributor reviewing
  # the dry-run output doesn't have to mentally sum the per-file
  # bytes — useful when verifying that an install fits inside a
  # quota'd filesystem (e.g. CI sandboxes, container layers).
  echo "Total:     $total bytes (${#FILES[@]} files)"
  # Per-file change summary: how many slots are first-time installs
  # vs upgrades. Helps a contributor distinguish a fresh install from
  # an in-place upgrade in CI logs without scrolling through the
  # per-file `[new]` / `[overwrite]` / `[unchanged]` markers above.
  echo "Changes:   $new_count new, $overwrite_count existing"
  exit 0
fi

# Surface a friendly diagnostic when `mkdir -p` cannot create the target
# directory (read-only parent, parent is a regular file, ENOSPC, etc).
# Without this guard, `set -e` bails with the raw OS error from mkdir
# alone — which tells a contributor WHAT failed but not how to recover.
# Capturing stderr lets us preserve the underlying error AND surface the
# fix hint (`set COPILOT_HOME` / `--project`) on the same exit code.
if ! mkdir_err="$(mkdir -p "$TARGET_DIR" 2>&1)"; then
  echo "Error: failed to create target directory: $TARGET_DIR" >&2
  if [[ -n "$mkdir_err" ]]; then
    echo "  underlying error: $mkdir_err" >&2
  fi
  echo "  Hint: ensure the parent directory exists and is writable, or pass --project to install into the current git repo instead." >&2
  exit 1
fi
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
  # The `[[ -e "$tmp" ]] && rm -f` short-circuit returns the exit code
  # of whichever side evaluated last, so when no temp file remains
  # after a clean install (every `mv` succeeded) the trap returns 1
  # — and bash then propagates that as the SCRIPT's exit code on
  # EXIT, even though every install step succeeded. Force a 0 return
  # so a successful install ALWAYS reports success to the caller; an
  # explicit early exit before the trap fires preserves error codes
  # from real failures.
  return 0
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

echo "✅ Installed ralph extension v$VERSION to $TARGET_DIR/"
echo ""
echo "Restart Copilot CLI (or run /extensions reload) to activate."
