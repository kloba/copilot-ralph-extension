# Quickstart

A 5-minute on-ramp to your first autopilot loop. By the end you will have the
`autopilot` binary on your `$PATH`, a self-improve run executing in your repo,
and a second terminal tailing it live.

## Prerequisites

- **Node.js >= 20.** Check with `node --version`.
- **GitHub Copilot CLI** on your `$PATH`. Check with `copilot --version`. If
  the binary is missing, follow the upstream
  [Copilot CLI install guide](https://github.com/github/gh-copilot) first —
  autopilot drives `copilot -p ...` once per iteration and cannot start
  without it.
- **`git`** (any modern version) — autopilot inspects your working tree to
  signal progress between iterations.

## Install

```bash
git clone https://github.com/kloba/autopilot.git
cd autopilot
cd packages/tui && npm install && npm link
autopilot --help    # confirm install
```

`npm link` symlinks the `autopilot` bin into your global npm prefix so you can
invoke it from any directory. If you would rather not pollute the global
prefix, swap `npm link` for `npm install -g .` or skip the linking step and
call the binary by path: `node packages/tui/bin/tui.mjs ...`.

!!! tip "Plain mode is zero-dep"
    The `list`, `replay`, `watch --plain`, `doctor`, `prune`, `stats`, and
    `where` subcommands all run straight from a fresh checkout with no
    `npm install` — `node packages/tui/bin/tui.mjs <subcommand>` is enough.
    The `npm install` step is only required for the interactive Ink-rendered
    TUI used by `autopilot run` (without `--headless` / `--plain`) and
    `autopilot watch` (without `--plain`).

## Run your first loop

```bash
autopilot          # bare invocation: starts run --self-improve --fresh
```

Bare `autopilot` is the canonical drive-the-backlog incantation. It expands
internally to `autopilot run --self-improve --fresh` and kicks off a
self-improving iteration loop in the **current working directory** — autopilot
does not change directories or clone anything; the loop operates on whatever
repository you cd-ed into. The Ink-rendered TUI mounts as soon as the run is
armed and shows iter / stage / substage progress, the live event timeline, and
a backlog-pressure summary.

Press **`q`** to stop gracefully. The currently-running `copilot -p`
subprocess is never killed mid-turn — the driver waits for it to finish, then
honors the stop request at the next iter boundary. Hit Ctrl-C twice if you
need a hard abort.

!!! warning "`--fresh` discards in-flight session context"
    `--fresh` starts a brand-new Copilot session every iteration, so the agent
    has no memory of the previous turn beyond what landed on disk (commits,
    notes, issue updates). Use `--continue` instead if you want the Copilot
    session id to thread through every iter — but be aware the context window
    grows monotonically and will eventually cost you a premium request per
    turn.

## Watch from another terminal

`autopilot run` already shows live progress, but if you want a second view
(e.g. the run is detached under `nohup`, or you closed the original terminal),
open a new shell and tail it:

```bash
autopilot watch              # tails the latest run
autopilot watch <runId>      # tails a specific run by id
autopilot watch --plain      # non-TTY-friendly stream (no Ink, no ANSI)
```

`--plain` is auto-enabled when stdout is not a TTY (CI logs, asciinema
recordings, piping to `grep` / `tee`), so you rarely need to pass it
explicitly.

## Where the run lives

Every armed run gets its own directory under the runs root:

```
~/.copilot/autopilot/runs/<runId>/
  events.jsonl    # append-only event stream (one JSON object per line)
  state.json      # per-run pause / stop / status flags + iter counter
```

A sibling `~/.copilot/autopilot/runs/index.jsonl` carries one row per `armed`
event so `autopilot list` / `stats` / `prune` can enumerate runs without
walking every directory.

If you started using autopilot under its previous name (`ralph-tui`), the
legacy `~/.copilot/ralph-tui/runs` root is still read on first start when it
exists, with a one-line stderr migration notice. Override either root with
`AUTOPILOT_RUNS_DIR=/abs/path` (canonical) — the legacy `RALPH_TUI_RUNS_DIR`
still works as a fallback. Run `autopilot where` to print the resolved root.

## Try the other modes

```bash
autopilot run --grow-project --focus "TUI replay UX" --fresh --max 10
autopilot run --prompt "Refactor packages/tui/src/runner.mjs and emit COMPLETE when tests pass." --fresh --max 5
```

- **`--self-improve`** (the default) drains the existing backlog: failing CI
  runs, stale PRs, open issues, latent improvements. The loop is
  scope-driven, not iter-driven, so the default `--max` is the runaway-guard
  ceiling (1000) and the agent self-aborts via `ABORT_NO_IMPROVEMENTS` when
  the backlog is empty.
- **`--grow-project`** plans new work and adds backlog items in the focus area
  given via `--focus TEXT`. Default `--max 100`; aborts via
  `ABORT_NO_BACKLOG` once the planned items are filed.
- **`--prompt TEXT`** is the classic Ralph mode: your literal prompt is
  re-fed verbatim every iteration until the agent emits `COMPLETE` (or your
  custom `--completion-promise TOKEN`). Default `--max 100`.

`--continue` vs `--fresh` is mandatory — there is no default because the
context behaviour is too consequential to guess. Pick `--fresh` for cheap,
deterministic iters; pick `--continue` when the agent genuinely needs a
multi-turn conversation.

## Stopping a long run

`q` and Ctrl-C only work in the terminal that owns the run. To stop a run
out-of-band — from any other terminal, a cron job, or a CI cancellation hook
— use the sibling commands:

```bash
autopilot run --status <runId>   # peek at iter, paused, stopRequested
autopilot run --pause <runId>    # gate the next iter without killing the loop
autopilot run --resume <runId>   # flip pause back off
autopilot run --stop <runId>     # graceful stop at the next iter boundary
```

All four operate on the run's `state.json` via a CAS-protected lockfile, so
concurrent calls from two terminals never lose updates. As with `q`, the
in-flight `copilot -p` subprocess is allowed to finish its turn before the
flag is honored.

## Read next

- [Concepts](concepts.md) — the arming model, completion / abort triggers,
  pause/resume semantics, adaptive iteration budget.
- [Recipes](recipes.md) — copy-pasteable scenarios (focused refactors, CI
  triage, scheduled grow-project sweeps).
- [FAQ](faq.md) — premium-request budgeting, Copilot rate limits, debugging
  a stuck loop.
- [ARCHITECTURE](ARCHITECTURE.md) — full event-stream / runs-directory /
  TUI-mount contract reference.
