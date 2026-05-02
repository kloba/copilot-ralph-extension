# Configuration

Reference for every flag, env var, and runtime knob `autopilot` exposes. Use this page as a lookup; for end-to-end walkthroughs see [`recipes.md`](recipes.md), and for the runtime model see [`concepts.md`](concepts.md).

## Subcommands

```text
autopilot                             Bare — defaults to
                                      `run --self-improve` with reset-on=workitem.
autopilot copilot [run flags]         Drive each iter with the GitHub Copilot CLI;
                                      bare = self-improve / fresh / yolo.
autopilot claude  [run flags]         Drive each iter with Claude Code; bare =
                                      self-improve / fresh / yolo.
autopilot list [--json] [--limit N]   Show recorded runs (newest first).
autopilot replay <runId>              Print every event in a past run.
autopilot watch [runId] [--plain]     Tail the given run (or the most recent one)
                                      in real time.
autopilot doctor                      Diagnose the runs directory.
autopilot prune [--older-than 30d]    Remove runs older than DURATION.
        [--dry-run]
autopilot stats                       Aggregate stats across runs.
autopilot where                       Print the resolved runs root.
autopilot run …                       Drive an autonomous loop.
autopilot --help     | -h
autopilot --version  | -V
```

`--plain` is auto-enabled when stdout is not a TTY so CI logs and `asciinema rec` outputs stay grep-friendly and ANSI-free.

## Run flags

Every `autopilot run` invocation picks exactly one prompt mode:

- `--self-improve` — baked SDLC prompt that drives a project-agnostic improvement loop. Walks the agent through nine stages: **ORIENT** → **IDEATE** → **CRITIQUE** → **BASELINE** → **IMPLEMENT** → **TEST** → **COMMIT** → **PUSH** → **END**.
- `--grow-project` — baked prompt that grows a backlog as GitHub issues. Thirteen stages: **ORIENT** → **IDEATE** (iter 1 only) → **SELECT** → **CRITIQUE** → **BASELINE** → **IMPLEMENT** → **TEST** → **ACCEPTANCE** → **DEMO** → **COMMIT** → **PUSH** → **CLOSE** → **END**. Add `--focus "<area>"` to narrow IDEATE.
- `--prompt "..."` — a literal prompt re-fed verbatim every iter until the agent emits the completion-promise token.

Context-reset boundary (default `workitem`):

- `--reset-on=workitem` — fresh Copilot session at every `[WORKITEM_END]` marker. Stages within a work item share a reasoning chain.
- `--reset-on=iter` — every iter starts a brand-new session (clean context per iter).
- `--reset-on=never` — capture iter 1's `result.sessionId` and resume on iter 2+ so context grows monotonically.

Legacy `--continue` and `--fresh` still work as aliases for `--reset-on=never` / `--reset-on=iter` with a one-shot stderr deprecation notice.

Iteration budget:

- `--max N` — hard cap on iterations (default 1000 for `--self-improve`; loop is scope-driven via the abort token rather than iter-driven).
- `--min-iterations N` — floor below which the agent is not allowed to short-circuit on `ABORT_NO_IMPROVEMENTS`.
- `--adaptive-extension N` — extra iterations granted in a single bump when progress signals are positive.
- `--adaptive-max-total N` — hard ceiling across all extensions.
- `--stagnation-limit N` — abort after N byte-identical responses (default 3; `0` disables).

See [`concepts.md` → Adaptive iteration budget](concepts.md#adaptive-iteration-budget) for the signal heuristics.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `AUTOPILOT_RUNS_DIR` | Override the runs root (default: `~/.copilot/autopilot/runs`). |
| `AUTOPILOT_COPILOT_BIN` | Override the Copilot CLI binary (default: `copilot` from `$PATH`). |
| `AUTOPILOT_CLAUDE_BIN` | Override the Claude Code CLI binary (default: `claude` from `$PATH`). |
| `AUTOPILOT_NO_ATTRIBUTION` | Set to `1` to suppress the second `Co-authored-by` trailer (see [Commit attribution](#commit-attribution)). |
| `AUTOPILOT_CAFFEINATE` | Set to `1` to keep macOS awake during a run (see [Keep system awake](#keep-system-awake-caffeinate-macos)). |
| `AUTOPILOT_CAFFEINATE_SCOPE` | `idle` (default) or `idle+display` to also block display sleep. |

Legacy `RALPH_TUI_*` / `RALPH_NO_ATTRIBUTION` / `RALPH_CAFFEINATE` env vars are still recognized as a fallback for one release; reading one prints a one-line stderr deprecation notice. The default runs root also falls back to `~/.copilot/ralph-tui/runs` if the new path does not yet exist.

## Pause / resume / stop / status

Long autonomous runs sometimes need a manual checkpoint. Out-of-band flags against the run's state file:

```bash
autopilot run --pause   <runId>     # pause at next iter boundary
autopilot run --resume  <runId>     # resume a paused run
autopilot run --stop    <runId>     # request graceful stop
autopilot run --status  <runId>     # snapshot of run state
```

The currently-running iteration always finishes normally; subsequent iters are short-circuited until `--resume`. State writes are CAS-protected via a per-state-file lockfile so concurrent `--pause` + `--stop` do not lose updates. `SIGINT` / `SIGTERM` at the driver process maps onto `--stop` via the same lock-protected CAS path.

See [`concepts.md` → Pause / resume semantics](concepts.md#pause--resume-semantics) for the state-machine writeup.

## Commit attribution

The baked SDLC prompts instruct the agent to add `Co-authored-by:` trailers to every commit so loop-driven changes are attributable. By default every commit ships **two** trailers:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
```

The first identifies the agent. The second attributes the commit to a dedicated bot account so commits made by this driver are passively searchable across public GitHub. The trailers are preserved verbatim — do not localize, abbreviate, or reorder them.

### Opt-out

Set `AUTOPILOT_NO_ATTRIBUTION=1` to suppress the second trailer. The first `Copilot` trailer still ships, since it identifies the agent that made the change. The opt-out is **honored by the prompt** — the agent reads the env var during the COMMIT stage and omits the trailer accordingly.

```bash
AUTOPILOT_NO_ATTRIBUTION=1 autopilot run --self-improve
```

### Caveats

- Only public-repo commits are searchable. GitHub's commit search API does not index private repositories.
- The bot account must exist before commits are made. Unregistered noreply emails do not link retroactively to a GitHub account once the account is created.
- The opt-out is honored by the prompt, not enforced by the runtime. If a sub-agent ignores `process.env`, the trailer can still appear. Audit with `git log -1 --pretty=%B`.

## Keep system awake (`caffeinate`, macOS)

Long `autopilot run` loops can outlast macOS's idle-sleep timeout. Set `AUTOPILOT_CAFFEINATE=1` and the runner spawns `caffeinate -i` for the duration of the run:

```bash
AUTOPILOT_CAFFEINATE=1 autopilot run --self-improve
```

To also keep the display awake:

```bash
AUTOPILOT_CAFFEINATE=1 AUTOPILOT_CAFFEINATE_SCOPE=idle+display autopilot run --self-improve
```

The wrapper script [`scripts/autopilot-fresh.sh`](https://github.com/kloba/autopilot/blob/main/scripts/autopilot-fresh.sh) auto-upgrades the checkout and invokes `autopilot` with `caffeinate` already wrapped.

## Requirements

- **Node.js ≥ 20.**
- One of:
    - **GitHub Copilot CLI** on `$PATH` (override via `AUTOPILOT_COPILOT_BIN`). Required for `autopilot copilot` and the bare `autopilot` invocation.
    - **Claude Code CLI** on `$PATH` (override via `AUTOPILOT_CLAUDE_BIN`). Required for `autopilot claude`.
- **git ≥ 2.30**, with a configured author identity (`git config user.name` / `user.email`).
- No required runtime dependencies for plain mode. The interactive Ink renderer pulls Ink + React + Yoga + Commander via `cd packages/tui && npm install`.
- **`gh` CLI** (≥ 2.0) authenticated via `gh auth login` — only required when running `--grow-project`. `--self-improve` and `--prompt` do not invoke `gh`.

## Limitations

- **Substring-match completion can self-trigger.** Both `--completion-promise` and `--abort-promise` use plain substring matching against the assistant's accumulated turn output. If the agent quotes the trigger phrase mid-thought (e.g. *"I'll mark this COMPLETE when done"*), the loop will finish on that turn. Pick a phrase the agent is unlikely to mention casually.
- **Prompt is re-injected verbatim every iteration.** The loop has no concept of progress — the agent must derive what's already done from its own conversation history (in `--reset-on=never`) or from the working tree (in `--reset-on=workitem` / `--reset-on=iter`).
- **One loop per `runId`.** The driver coordinates pause / resume / stop via the per-run state file; concurrently driving the same `runId` from two processes is unsupported.
- **`--reset-on=never` requires a clean session-resume contract from the backend.** If `copilot -p ... --output-format json` ever stops emitting a terminal `result.sessionId`, the resume becomes a fresh session for the next iter and the regression is logged.
- **Attribution opt-out is honored by the prompt, not enforced by the runtime.** See [Commit attribution → Caveats](#caveats).
- **No automatic rollback.** Loop-driven commits are not auto-reverted if a later iteration regresses. Treat the working branch as expendable, push to a feature branch, and review the diff before merging.
- **An idle Copilot subscription still costs.** The loop keeps the Copilot CLI busy for the full run; budget accordingly.
