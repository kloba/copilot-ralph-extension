# autopilot

> Autonomous iterative loop for **GitHub Copilot CLI**, packaged as the `autopilot` standalone TUI app.

[![CI](https://github.com/kloba/autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/kloba/autopilot/actions/workflows/ci.yml)
[![Inspired by](https://img.shields.io/badge/inspired_by-Anthropic_Ralph_Wiggum-blue)](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)

**Contents:** [What is Ralph?](#what-is-ralph-wiggum) · [Install](#install) · [Usage](#usage) · [Subcommands](#subcommands) · [Self-improve](#self-improve) · [Grow-project](#grow-project) · [Pause / resume / stop / status](#pause--resume--stop--status) · [Adaptive budget](#adaptive-iteration-budget) · [Commit attribution](#commit-attribution) · [Keep system awake](#keep-system-awake-caffeinate-macos) · [Limitations](#limitations) · [Requirements](#requirements) · [Development](#development) · [Documentation](#documentation) · [Changelog](#changelog) · [License](#license)

## What is Ralph Wiggum?

Ralph Wiggum is an iterative-agent technique: re-feed the same prompt to a coding agent in a loop until it emits a "completion promise" (e.g. `COMPLETE`) or hits an iteration cap. Originally a Claude Code plugin by Anthropic — see the [upstream `ralph-wiggum` plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum) for the canonical write-up.

This project ships **`autopilot`** — a terminal app that drives the Copilot CLI in a Ralph loop by spawning each iteration as a fresh `copilot -p ...` subprocess and tailing the JSONL event stream live. Three baked SDLC prompts (`--prompt` / `--self-improve` / `--grow-project`) cover the common shapes; pause / resume / stop / status are out-of-band against a per-run state file so a long run can be checkpointed without losing context.

## Install

```bash
git clone https://github.com/kloba/autopilot
cd autopilot
cd packages/tui && npm install && npm link
```

After `npm link`, the bare `autopilot` binary is on your `$PATH`:

```bash
autopilot --help
autopilot --version
```

Bare `autopilot` (no subcommand) starts a self-improve loop with `--fresh` context, equivalent to `autopilot run --self-improve --fresh`.

### Plain mode (no install)

If you want to skip `npm install` entirely, the plain renderer works straight from a fresh checkout:

```bash
node packages/tui/bin/tui.mjs --help
```

The interactive Ink-rendered watch UI requires the one-time `cd packages/tui && npm install`; the plain mode does not.

A future release will publish `autopilot` to npm so `npm i -g autopilot` works; until then the source checkout above is the supported install path.

## Usage

```bash
# Default — bare invocation runs --self-improve --fresh.
autopilot

# Drive a backlog-drain loop, fresh context every iter (50-iter cap).
autopilot run --self-improve --fresh --max 50

# Same, but resume the same Copilot session every iter (context grows).
autopilot run --self-improve --continue --max 50

# Grow the project backlog with a focus area, fresh context per iter.
autopilot run --grow-project --fresh \
  --focus "autopilot replay UX" --max 30

# Custom prompt mode — re-fed verbatim every iter until COMPLETE.
autopilot run \
  --prompt "Refactor packages/tui/src/runner.mjs and add tests. Emit COMPLETE when green." \
  --fresh --max 20
```

Pick exactly one prompt mode (`--self-improve` / `--grow-project` / `--prompt "..."`) AND exactly one context mode (`--continue` / `--fresh`).

* `--continue` captures the terminal `result.sessionId` from the JSONL stream on iter 1 and resumes via `--resume=<sessionId>` on iter 2+ so the agent's context grows monotonically.
* `--fresh` re-spawns with no session reuse — every iteration starts from a clean slate.

Events flow into `~/.copilot/autopilot/runs/<runId>/events.jsonl`. Use `autopilot list / replay / watch / stats / doctor / prune` to inspect them.

`SIGINT` / `SIGTERM` at the driver process flips `stopRequested=true` via the run's lock-protected state file; the in-flight Copilot child is allowed to exit naturally before the driver emits the terminal `abort` event with `reason: "user_stopped"`.

### Environment variables

The runner honors a small set of canonical `AUTOPILOT_*` env vars:

| Variable | Purpose |
| --- | --- |
| `AUTOPILOT_RUNS_DIR` | Override the runs root (default: `~/.copilot/autopilot/runs`). |
| `AUTOPILOT_COPILOT_BIN` | Override the Copilot CLI binary (default: `copilot` from `$PATH`). |
| `AUTOPILOT_NO_ATTRIBUTION` | Set to `1` to suppress the second `Co-authored-by` trailer (see [Commit attribution](#commit-attribution)). |
| `AUTOPILOT_CAFFEINATE` | Set to `1` to keep macOS awake during a run (see [Keep system awake](#keep-system-awake-caffeinate-macos)). |
| `AUTOPILOT_CAFFEINATE_SCOPE` | `idle` (default) or `idle+display` to also block display sleep. |

> Legacy `RALPH_TUI_*` / `RALPH_NO_ATTRIBUTION` / `RALPH_CAFFEINATE` env vars are still recognized as a fallback for one release; reading one prints a one-line stderr deprecation notice. The default runs root also falls back to `~/.copilot/ralph-tui/runs` if the new path does not yet exist (with a one-line stderr migration notice on first read).

## Subcommands

```text
autopilot list [--json] [--limit N]   Show recorded runs (newest first).
autopilot replay <runId>              Print every event in a past run.
autopilot watch [runId] [--plain]     Tail the given run (or the most
                                      recent one) in real time.
autopilot doctor                      Diagnose the runs directory.
autopilot prune [--older-than 30d]    Remove runs older than DURATION.
        [--dry-run]
autopilot stats                       Aggregate stats across runs.
autopilot where                       Print the resolved runs root.
autopilot run …                       Drive an autonomous Copilot loop
                                      (see Usage above).
autopilot --help     | -h
autopilot --version  | -V
```

`--plain` is **auto-enabled when stdout is not a TTY** so CI logs and `asciinema rec` outputs stay grep-friendly and ANSI-free.

## Self-improve

`autopilot run --self-improve` drives a baked, **project-agnostic SDLC** prompt (`PROMPT_SELF_IMPROVE` in [`packages/tui/src/prompts.mjs`](packages/tui/src/prompts.mjs)). Each iteration walks the agent through nine stages: **ORIENT** (read recent commits + project docs, detect the test command) → **IDEATE** (pick ONE concrete change, prioritising red CI → stale open PR → open human-filed issue → rotating SDLC hardening) → **CRITIQUE** → **BASELINE** → **IMPLEMENT** → **TEST** → **COMMIT** (conventional-commit prefix + dual `Co-authored-by` trailers) → **PUSH** → **END** (emit `COMPLETE` or `ABORT_NO_IMPROVEMENTS`).

Use it on **any repo** to drive an autonomous improvement loop without writing the prompt yourself. Default `--max` is 1000 (effectively unbounded — the loop is scope-driven via the `ABORT_NO_IMPROVEMENTS` token rather than iter-driven). `--min-iterations` raises the floor below which the agent is not allowed to short-circuit on `ABORT_NO_IMPROVEMENTS`, so a flaky early "nothing to do" verdict cannot end the run before any real work has happened.

## Grow-project

`autopilot run --grow-project` drives a parallel SDLC prompt that *grows* a codebase. On the first iteration it ideates a backlog of small, well-scoped features and persists them as **GitHub issues** (`gh issue create --label grow-project --label proposed`); subsequent iterations each pick one proposed issue, implement it, and close it. The per-feature completion gate is **three-part**: (a) tests stay green, (b) every checkbox in the issue's `acceptance_criteria` block passes, (c) the issue's `demo_command` is executed and its output is pasted back as a comment.

Each iteration walks through thirteen stages: **ORIENT** → **IDEATE** (only on iter 1 with empty backlog) → **SELECT** → **CRITIQUE** → **BASELINE** → **IMPLEMENT** → **TEST** → **ACCEPTANCE** → **DEMO** → **COMMIT** (with `Closes #N`) → **PUSH** → **CLOSE** → **END** (`COMPLETE`, or `ABORT_NO_BACKLOG` when no ready issues remain).

`--focus "<area>"` narrows the IDEATE stage to a particular surface (e.g. `--focus "autopilot replay UX"`).

> ⚠️ **The baked prompt drives `gh` CLI calls.** Make sure `gh auth status` succeeds before arming `--grow-project` — without auth, the very first `gh issue list` call fails and the agent will burn iterations trying to recover.

## Pause / resume / stop / status

Long autonomous runs sometimes need a manual checkpoint — to read a diff, run tests by hand, fix something, then continue. The TUI driver exposes pause / resume / stop / status as out-of-band flags against the run's state file:

```bash
autopilot run --pause   <runId>     # pause at next iter boundary
autopilot run --resume  <runId>     # resume a paused run
autopilot run --stop    <runId>     # request graceful stop
autopilot run --status  <runId>     # snapshot of run state
```

The currently-running iteration finishes normally; subsequent iters are short-circuited until `--resume`. State writes are CAS-protected via a per-state-file lockfile so concurrent `--pause` + `--stop` do not lose updates.

## Adaptive iteration budget

When `--self-improve` reaches `--max` and progress signals are positive (the working tree shows uncommitted changes, or the last few iters are not byte-identical), the runner can grant more iterations up to a hard ceiling rather than aborting useful work.

Two flags shape the policy:

* `--adaptive-extension N` — how many extra iterations to grant in a single bump when progress signals are positive (default: small bump).
* `--adaptive-max-total N` — hard ceiling on total iterations across all extensions, so the loop can never run forever.

See `packages/tui/src/runner.mjs` for the exact signal heuristics and the ceiling rules.

## Commit attribution

The baked `--self-improve` and `--grow-project` SDLC prompts instruct the agent to add `Co-authored-by:` trailers to every commit so loop-driven changes are attributable. By default every loop-driven commit ships **two** trailers (per [issue #1](https://github.com/kloba/autopilot/issues/1)):

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
```

The first identifies the agent. The second attributes the commit to a dedicated `copilot-ralph` GitHub account so commits made by this driver are passively searchable across public GitHub. The trailers are preserved **verbatim** — do not localize, abbreviate, or reorder them.

### Opt-out

Set `AUTOPILOT_NO_ATTRIBUTION=1` in the environment before running the loop to suppress the second `copilot-ralph` trailer. The first `Copilot` trailer still ships, since it identifies the agent that made the change. The opt-out is **honored by the prompt** — the agent reads the env var during the COMMIT stage and omits the trailer accordingly.

```bash
AUTOPILOT_NO_ATTRIBUTION=1 autopilot run --self-improve --fresh
```

> Legacy `RALPH_NO_ATTRIBUTION=1` is still recognized as a fallback for one release.

### Caveats

- **Only public-repo commits are searchable.** GitHub's commit search API does not index private repositories.
- **The bot account must exist before commits are made.** Unregistered noreply emails do not link retroactively to a GitHub account once the account is created.

## Keep system awake (`caffeinate`, macOS)

Long `autopilot run` loops can outlast macOS's idle-sleep timeout. Set `AUTOPILOT_CAFFEINATE=1` and the runner will spawn `caffeinate -i` for the duration of the run:

```bash
AUTOPILOT_CAFFEINATE=1 autopilot run --self-improve --fresh
```

To also keep the display awake, opt into `idle+display` scope:

```bash
AUTOPILOT_CAFFEINATE=1 AUTOPILOT_CAFFEINATE_SCOPE=idle+display autopilot run --self-improve --fresh
```

The wrapper script [`scripts/autopilot-fresh.sh`](scripts/autopilot-fresh.sh) is the canonical helper that auto-upgrades the checkout and invokes `autopilot` with `caffeinate` already wrapped (the old `scripts/ralph-tui-fresh.sh` path stays as a deprecating wrapper).

## Limitations

- **Substring-match completion can self-trigger.** Both `--completion-promise` and `--abort-promise` use plain substring matching against the assistant's accumulated turn output. If the agent quotes the trigger phrase mid-thought (e.g. *"I'll mark this COMPLETE when done"*), the loop will finish on that turn. Pick a phrase the agent is unlikely to mention casually.
- **Prompt is re-injected verbatim every iteration.** The loop has no concept of progress — the agent must derive what's already done from its own conversation history (in `--continue` mode) or from the working tree (in `--fresh` mode).
- **One loop per `runId`.** The driver coordinates pause / resume / stop via the per-run state file; concurrently driving the same `runId` from two processes is unsupported.
- **`--continue` mode requires a clean session-resume contract from the Copilot CLI.** If `copilot -p ... --output-format json` ever stops emitting a terminal `result.sessionId`, `--continue` falls back to `--fresh` and logs the regression.
- **Attribution opt-out is honored by the prompt, not enforced by the runtime.** `AUTOPILOT_NO_ATTRIBUTION=1` suppresses the second `copilot-ralph` `Co-authored-by:` trailer only because the prompt instructs the agent to read the env var during COMMIT and omit the trailer. The driver does not rewrite commits — if a sub-agent ignores the env var, the trailer can still ship.
- **No automatic rollback.** Loop-driven commits are not auto-reverted if a later iteration regresses. Treat the working branch as expendable, push to a feature branch, and review the diff before merging.
- **An idle Copilot subscription still costs.** The loop keeps the Copilot CLI busy for the full run; budget accordingly.

## Requirements

- **Node.js ≥ 20.**
- **GitHub Copilot CLI** on `$PATH` (override via `AUTOPILOT_COPILOT_BIN`).
- **git ≥ 2.30**, with a configured author identity (`git config user.name` / `user.email`).
- No required runtime dependencies for plain mode. The interactive Ink renderer pulls Ink + React + Yoga + Commander via `cd packages/tui && npm install`.
- **`gh` CLI** (≥ 2.0) authenticated via `gh auth login` — *only* required when running `--grow-project`. `--self-improve` and `--prompt` do not invoke `gh`.

## Development

```bash
npm test       # runs the node:test suite under packages/*/test (no deps, no install needed)
npm run check  # syntax-checks every shipped .mjs (mirrors the CI "Syntax check" job)
```

The driver lives in [`packages/tui/src/runner.mjs`](packages/tui/src/runner.mjs); the baked SDLC prompts are in [`packages/tui/src/prompts.mjs`](packages/tui/src/prompts.mjs); the JSONL event contract is split between [`packages/tui/src/events.mjs`](packages/tui/src/events.mjs) (read side) and [`packages/tui/src/events-emit.mjs`](packages/tui/src/events-emit.mjs) (write side). For the full design walk-through, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Documentation

The live MkDocs site is published at **<https://kloba.github.io/autopilot/>** and built from [`docs/`](docs/). The handful of pages there:

- [`docs/quickstart.md`](docs/quickstart.md) — get a first run going in under a minute.
- [`docs/concepts.md`](docs/concepts.md) — the Ralph technique, run lifecycle, JSONL event model.
- [`docs/recipes.md`](docs/recipes.md) — task-shaped how-tos for the common loops.
- [`docs/faq.md`](docs/faq.md) — answers to the recurring questions.
- [`docs/cli-stack.md`](docs/cli-stack.md) — how `autopilot` sits on top of the Copilot CLI.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — out-of-session driver, baked-prompt pattern, JSONL contract.
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — local dev setup, style conventions, commit-trailer rules, PR expectations.
- [`docs/RELEASING.md`](docs/RELEASING.md) — manual release checklist for tagged GitHub Releases.

[`SECURITY.md`](SECURITY.md) covers vulnerability reporting and the supported-versions policy.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a per-release record of behavior changes, hardening notes, and bug fixes.

## License

MIT
