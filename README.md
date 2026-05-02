# copilot-ralph-extension

> Ralph Wiggum-style autonomous iterative loop for **GitHub Copilot CLI**, packaged as the `ralph-tui` standalone TUI app.

[![CI](https://github.com/kloba/autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/kloba/autopilot/actions/workflows/ci.yml)
[![Inspired by](https://img.shields.io/badge/inspired_by-Anthropic_Ralph_Wiggum-blue)](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)

**Contents:** [What is Ralph?](#what-is-ralph-wiggum) · [Install](#install) · [Usage](#usage) · [Subcommands](#subcommands) · [Self-improve](#self-improve) · [Grow-project](#grow-project) · [Pause / resume / stop / status](#pause--resume--stop--status) · [Adaptive budget](#adaptive-iteration-budget) · [Commit attribution](#commit-attribution) · [Keep system awake](#keep-system-awake-caffeinate-macos) · [Limitations](#limitations) · [Requirements](#requirements) · [Development](#development) · [Documentation](#documentation) · [Changelog](#changelog) · [License](#license)

## What is Ralph Wiggum?

Ralph Wiggum is an iterative-agent technique: re-feed the same prompt to a coding agent in a loop until it emits a "completion promise" (e.g. `COMPLETE`) or hits an iteration cap. Originally a Claude Code plugin by Anthropic.

This project ships **`ralph-tui`** — a terminal app that drives the Copilot CLI in a Ralph loop by spawning each iteration as a fresh `copilot -p ...` subprocess and tailing the JSONL event stream live. Three baked SDLC prompts (`--prompt` / `--self-improve` / `--grow-project`) cover the common shapes; pause / resume / stop / status are out-of-band against a per-run state file so a long run can be checkpointed without losing context.

> **Migrating from an older install?** The previous in-session Copilot CLI extension (`ralph_loop` / `self_improve` / `grow_project` / `ralph_status` / `ralph_pause` / `ralph_resume` / `ralph_stop` tools, installed at `~/.copilot/extensions/ralph`) was retired. If you still have `~/.copilot/extensions/ralph` from an older install, `rm -rf ~/.copilot/extensions/ralph` and switch to the TUI driver below. See [`CHANGELOG.md`](CHANGELOG.md) for the full migration note.

## Install

```bash
git clone https://github.com/kloba/autopilot
cd copilot-ralph-extension

# Plain mode works straight from a fresh checkout — no install needed.
node packages/tui/bin/tui.mjs --help

# For the interactive Ink-rendered watch UI (one-time):
cd packages/tui && npm install
```

A future release will publish `ralph-tui` to npm so `npm i -g ralph-tui` works; until then the source checkout above is the supported install path.

## Usage

```bash
# Drive a backlog-drain loop, fresh context every iter (50-iter cap).
node packages/tui/bin/tui.mjs run --self-improve --fresh --max 50

# Same, but resume the same Copilot session every iter (context grows).
node packages/tui/bin/tui.mjs run --self-improve --continue --max 50

# Grow the project backlog with a focus area, fresh context per iter.
node packages/tui/bin/tui.mjs run --grow-project --fresh \
  --focus "ralph-tui replay UX" --max 30

# Custom prompt mode — re-fed verbatim every iter until COMPLETE.
node packages/tui/bin/tui.mjs run \
  --prompt "Refactor packages/tui/src/runner.mjs and add tests. Emit COMPLETE when green." \
  --fresh --max 20
```

Pick exactly one prompt mode (`--self-improve` / `--grow-project` / `--prompt "..."`) AND exactly one context mode (`--continue` / `--fresh`).

* `--continue` captures the terminal `result.sessionId` from the JSONL stream on iter 1 and resumes via `--resume=<sessionId>` on iter 2+ so the agent's context grows monotonically.
* `--fresh` re-spawns with no session reuse — every iteration starts from a clean slate.

Events flow into `~/.copilot/ralph-tui/runs/<runId>/events.jsonl`. Use `ralph-tui list / replay / watch / stats / doctor / prune` to inspect them.

`SIGINT` / `SIGTERM` at the driver process flips `stopRequested=true` via the run's lock-protected state file; the in-flight Copilot child is allowed to exit naturally before the driver emits the terminal `abort` event with `reason: "user_stopped"`.

## Subcommands

```text
ralph-tui list [--json] [--limit N]   Show recorded runs (newest first).
ralph-tui replay <runId>              Print every event in a past run.
ralph-tui watch [runId] [--plain]     Tail the given run (or the most
                                      recent one) in real time.
ralph-tui doctor                      Diagnose the runs directory.
ralph-tui prune [--older-than 30d]    Remove runs older than DURATION.
        [--dry-run]
ralph-tui stats                       Aggregate stats across runs.
ralph-tui where                       Print the resolved runs root.
ralph-tui run …                       Drive an autonomous Copilot loop
                                      (see Usage above).
ralph-tui --help     | -h
ralph-tui --version  | -V
```

`--plain` is **auto-enabled when stdout is not a TTY** so CI logs and `asciinema rec` outputs stay grep-friendly and ANSI-free.

## Self-improve

`ralph-tui run --self-improve` drives a baked, **project-agnostic SDLC** prompt (`PROMPT_SELF_IMPROVE` in [`packages/tui/src/prompts.mjs`](packages/tui/src/prompts.mjs)). Each iteration walks the agent through nine stages: **ORIENT** (read recent commits + project docs, detect the test command) → **IDEATE** (pick ONE concrete change, prioritising red CI → stale open PR → open human-filed issue → rotating SDLC hardening) → **CRITIQUE** → **BASELINE** → **IMPLEMENT** → **TEST** → **COMMIT** (conventional-commit prefix + dual `Co-authored-by` trailers) → **PUSH** → **END** (emit `COMPLETE` or `ABORT_NO_IMPROVEMENTS`).

Use it on **any repo** to drive an autonomous improvement loop without writing the prompt yourself. Default `--max` is 1000 (effectively unbounded — the loop is scope-driven via the `ABORT_NO_IMPROVEMENTS` token rather than iter-driven).

## Grow-project

`ralph-tui run --grow-project` drives a parallel SDLC prompt that *grows* a codebase. On the first iteration it ideates a backlog of small, well-scoped features and persists them as **GitHub issues** (`gh issue create --label grow-project --label proposed`); subsequent iterations each pick one proposed issue, implement it, and close it. The per-feature completion gate is **three-part**: (a) tests stay green, (b) every checkbox in the issue's `acceptance_criteria` block passes, (c) the issue's `demo_command` is executed and its output is pasted back as a comment.

Each iteration walks through thirteen stages: **ORIENT** → **IDEATE** (only on iter 1 with empty backlog) → **SELECT** → **CRITIQUE** → **BASELINE** → **IMPLEMENT** → **TEST** → **ACCEPTANCE** → **DEMO** → **COMMIT** (with `Closes #N`) → **PUSH** → **CLOSE** → **END** (`COMPLETE`, or `ABORT_NO_BACKLOG` when no ready issues remain).

> ⚠️ **The baked prompt drives `gh` CLI calls.** Make sure `gh auth status` succeeds before arming `--grow-project` — without auth, the very first `gh issue list` call fails and the agent will burn iterations trying to recover.

## Pause / resume / stop / status

Long autonomous runs sometimes need a manual checkpoint — to read a diff, run tests by hand, fix something, then continue. The TUI driver exposes pause / resume / stop / status as out-of-band flags against the run's state file:

```bash
ralph-tui run --pause   <runId>     # pause at next iter boundary
ralph-tui run --resume  <runId>     # resume a paused run
ralph-tui run --stop    <runId>     # request graceful stop
ralph-tui run --status  <runId>     # snapshot of run state
```

The currently-running iteration finishes normally; subsequent iters are short-circuited until `--resume`. State writes are CAS-protected via a per-state-file lockfile so concurrent `--pause` + `--stop` do not lose updates.

## Adaptive iteration budget

When `--self-improve` reaches `--max` and progress signals are positive (the working tree shows uncommitted changes, or the last few iters are not byte-identical), the runner can grant more iterations up to a hard ceiling rather than aborting useful work. See `packages/tui/src/runner.mjs` for the signals and the ceiling rules.

## Commit attribution

The baked `--self-improve` and `--grow-project` SDLC prompts instruct the agent to add `Co-authored-by:` trailers to every commit so loop-driven changes are attributable. By default every loop-driven commit ships **two** trailers (per [issue #1](https://github.com/kloba/autopilot/issues/1)):

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
```

The first identifies the agent. The second attributes the commit to a dedicated `copilot-ralph` GitHub account so commits made by this driver are passively searchable across public GitHub.

### Opt-out

Set `RALPH_NO_ATTRIBUTION=1` in the environment before running the loop to suppress the second `copilot-ralph` trailer. The first `Copilot` trailer still ships, since it identifies the agent that made the change. The opt-out is **honored by the prompt** — the agent reads the env var during the COMMIT stage and omits the trailer accordingly.

```bash
RALPH_NO_ATTRIBUTION=1 ralph-tui run --self-improve --fresh
```

### Caveats

- **Only public-repo commits are searchable.** GitHub's commit search API does not index private repositories.
- **The bot account must exist before commits are made.** Unregistered noreply emails do not link retroactively to a GitHub account once the account is created.

## Keep system awake (`caffeinate`, macOS)

Long `ralph-tui run` loops can outlast macOS's idle-sleep timeout. The runner does not spawn `caffeinate` itself; the simplest workaround is to wrap the call:

```bash
caffeinate -i node packages/tui/bin/tui.mjs run --self-improve --fresh
```

Add `-d` if you also want to keep the display awake.

## Limitations

- **Substring-match completion can self-trigger.** Both `--completion-promise` and `--abort-promise` use plain substring matching against the assistant's accumulated turn output. If the agent quotes the trigger phrase mid-thought (e.g. *"I'll mark this COMPLETE when done"*), the loop will finish on that turn. Pick a phrase the agent is unlikely to mention casually.
- **Prompt is re-injected verbatim every iteration.** The loop has no concept of progress — the agent must derive what's already done from its own conversation history (in `--continue` mode) or from the working tree (in `--fresh` mode).
- **One loop per `runId`.** The driver coordinates pause / resume / stop via the per-run state file; concurrently driving the same `runId` from two processes is unsupported.
- **`--continue` mode requires a clean session-resume contract from the Copilot CLI.** If `copilot -p ... --output-format json` ever stops emitting a terminal `result.sessionId`, `--continue` falls back to `--fresh` and logs the regression.
- **Attribution opt-out is honored by the prompt, not enforced by the runtime.** `RALPH_NO_ATTRIBUTION=1` suppresses the second `copilot-ralph` `Co-authored-by:` trailer only because the prompt instructs the agent to read the env var during COMMIT and omit the trailer. The driver does not rewrite commits — if a sub-agent ignores the env var, the trailer can still ship.

## Requirements

- GitHub Copilot CLI on `$PATH` (override via `RALPH_TUI_COPILOT_BIN`).
- Node.js ≥ 20.
- No required runtime dependencies for plain mode. The interactive Ink renderer pulls Ink + React + Yoga + Commander via `cd packages/tui && npm install`.
- **`gh` CLI** (≥ 2.0) authenticated via `gh auth login` — *only* required when running `--grow-project`. `--self-improve` and `--prompt` do not invoke `gh`.

## Development

```bash
npm test     # runs the node:test suite under packages/*/test (no deps, no install needed)
npm run check  # syntax-checks every shipped .mjs (mirrors the CI "Syntax check" job)
```

The driver lives in [`packages/tui/src/runner.mjs`](packages/tui/src/runner.mjs); the baked SDLC prompts are in [`packages/tui/src/prompts.mjs`](packages/tui/src/prompts.mjs); the JSONL event contract is split between [`packages/tui/src/events.mjs`](packages/tui/src/events.mjs) (read side) and [`packages/tui/src/events-emit.mjs`](packages/tui/src/events-emit.mjs) (write side).

## Documentation

Contributor and design docs live under [`docs/`](docs/) so this README can stay focused on end-users:

- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — local dev setup, style conventions, commit-trailer rules, PR expectations.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design notes on the out-of-session driver, the baked-prompt pattern, and the JSONL event contract.
- [`docs/RELEASING.md`](docs/RELEASING.md) — manual release checklist for tagged GitHub Releases.
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability and the supported-versions policy.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a per-release record of behavior changes, hardening notes, and bug fixes.

## License

MIT
