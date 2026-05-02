#!/usr/bin/env bash
# scripts/autopilot-fresh.sh — wrapper for `node packages/tui/bin/tui.mjs`
# that runs `git pull --quiet --ff-only` from the repo root immediately
# before an `autopilot run` invocation, so each long-haul out-of-session
# loop starts on the latest source.
#
# Why this is safe:
#   * `autopilot run` runs OUT-OF-SESSION — each iter is a fresh
#     `copilot -p ...` subprocess. The TUI binary itself is loaded
#     into memory once at Node startup, so a `git pull` immediately
#     before `exec node …/tui.mjs` lands the new source on disk
#     before Node imports the module graph. No self-overwrite race.
#   * Mid-loop version skew is impossible: Node imports the module
#     graph at process start, so a `git pull` running concurrently
#     with the loop CANNOT change the running iter's behaviour.
#
# Why only `run` upgrades:
#   The other subcommands (`list`, `replay`, `watch`, `doctor`,
#   `prune`, `stats`, `where`) are millisecond-fast read ops on
#   local files. Adding a `git pull` to those would make `list`
#   feel laggy for no behavioural benefit.
#
# Why failures are silent:
#   No network, dirty working tree, non-fast-forward, or detached
#   HEAD all silently fall through to the existing checked-out
#   code (`|| true`). The wrapper never blocks a run on git issues.
#   `--ff-only` deliberately refuses to clobber local work-in-progress.
#
# Usage:
#   alias autopilot="$PWD/scripts/autopilot-fresh.sh"   # in ~/.zshrc
#   autopilot run --self-improve --continue
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Subshell isolates `cd`: the parent shell stays in the user's cwd so
# `exec node` below preserves it (the TUI's `run` subcommand spawns
# `copilot -p` subprocesses that inherit cwd from the user, NOT this
# wrapper's repo root).
if [[ "${1:-}" == "run" ]]; then
    ( cd "$ROOT" && git pull --quiet --ff-only ) 2>/dev/null || true
fi

exec node "$ROOT/packages/tui/bin/tui.mjs" "$@"
