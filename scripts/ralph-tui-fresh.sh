#!/usr/bin/env bash
# scripts/ralph-tui-fresh.sh — deprecating wrapper for scripts/autopilot-fresh.sh.
# Will be removed in a future release. See issue #49.
echo "ralph-tui-fresh.sh is deprecated; use scripts/autopilot-fresh.sh instead." >&2
exec "$(dirname "$0")/autopilot-fresh.sh" "$@"
