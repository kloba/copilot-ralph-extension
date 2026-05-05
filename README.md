# copilot-ralph-extension

> Autonomous iterative loop for **GitHub Copilot CLI**, implemented as an in-session extension.

[![CI](https://github.com/kloba/copilot-ralph-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/kloba/copilot-ralph-extension/actions/workflows/ci.yml)
[![Inspired by](https://img.shields.io/badge/inspired_by-Anthropic_Ralph_Wiggum-blue)](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)

**Contents:** [What is Ralph?](#what-is-ralph-wiggum) · [What's different](#whats-different-here) · [Install](#install) · [Usage](#usage) · [Development](#development) · [Documentation](#documentation) · [Self-improve](#self-improve-self_improve-tool) · [Grow-project](#grow-project-grow_project-tool) · [Inspecting a running loop](#inspecting-a-running-loop-ap_status-tool) · [Adaptive budget](#adaptive-iteration-budget) · [Pause/resume](#pause-and-resume) · [How it works](#how-it-works) · [Commit attribution](#commit-attribution) · [Keep system awake](#keep-system-awake-caffeinate-macos) · [Troubleshooting](#troubleshooting) · [Limitations](#limitations) · [Requirements](#requirements) · [Changelog](#changelog) · [License](#license)

## What is Ralph Wiggum?

Ralph Wiggum is an iterative-agent technique: re-feed the same prompt to a coding agent in a loop until it emits a "completion promise" (e.g. `COMPLETE`) or hits an iteration cap. Originally a Claude Code plugin by Anthropic.

## What's different here?

Existing Ralph implementations for Copilot CLI (e.g. copilot-ralph-mode) are **shell wrappers** — they spawn `copilot -p "..."` as a subprocess for each iteration. Each iteration starts with a **fresh session**.

This extension instead runs **in-session**, driven by the Copilot CLI extension SDK's `session.idle` event — the same architectural pattern as Anthropic's Claude Code [`ralph-wiggum`](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum) plugin (their `Stop` hook). Conversation context is **retained** across iterations and every iteration is a normal assistant turn the user sees.

| | This extension | Shell wrappers |
|---|---|---|
| Context across iterations | Retained | Fresh each iter |
| Where it runs | Inside your active Copilot CLI session | External subprocess |
| Mechanism | `session.idle` event + `session.send` | Subprocess fork per iter |

The Ralph technique itself is agent-agnostic — for Claude Code, see [Anthropic's `ralph-wiggum` plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum). This repo specifically targets Copilot CLI's extension SDK and its native subagent (`/fleet`) infrastructure.

If you want fresh-context iterations, use a shell-wrapper implementation. If you want the agent to keep its working memory inside Copilot CLI, use this.

## Install

### Option A — User-scoped (persists across all repos)

```bash
mkdir -p ~/.copilot/extensions/ralph
# Order matters: leaf modules first, entry point (extension.mjs) LAST.
# If `/extensions reload` fires mid-download, this guarantees the SDK
# never sees a new entry point importing missing/old siblings.
for f in scout-tool.mjs shipper-agent.mjs handler.mjs extension.mjs; do
  curl -fsSL "https://raw.githubusercontent.com/kloba/copilot-ralph-extension/main/extension/$f" \
    -o ~/.copilot/extensions/ralph/$f
done
```

Then in any Copilot CLI session, run:

```text
/extensions
```

…and confirm `ralph` is loaded. Or simply restart Copilot CLI.

### Option B — Project-scoped (only in one repo)

```bash
mkdir -p .github/extensions/ralph
# Same leaf-first ordering as Option A — see comment there.
for f in scout-tool.mjs shipper-agent.mjs handler.mjs extension.mjs; do
  curl -fsSL "https://raw.githubusercontent.com/kloba/copilot-ralph-extension/main/extension/$f" \
    -o .github/extensions/ralph/$f
done
```

### Option C — From source

```bash
git clone https://github.com/kloba/copilot-ralph-extension
cd copilot-ralph-extension
./install.sh                # user-scoped → ~/.copilot/extensions/ralph
./install.sh --project      # project-scoped → .github/extensions/ralph (cwd must be inside a git repo)
./install.sh --dry-run      # show what would be installed without writing anything
./install.sh --version      # print the extension version (e.g. "copilot-ralph-extension v0.6.0") and exit
./install.sh --help         # print usage and exit
```

`install.sh` syntax-checks each source file with `node --check` and writes via temp-file + atomic `mv`, so a concurrent Copilot CLI reload can never see a half-written `handler.mjs`.

> **Windows note:** the runtime extension (`extension.mjs`, `handler.mjs`, `scout-tool.mjs`, `shipper-agent.mjs`) is plain ESM and works wherever Copilot CLI runs. The `install.sh` script requires a Bash shell — on Windows use **WSL**, **Git Bash**, or **MSYS2**. As a fallback, follow Option A or B above (the `mkdir -p` + `curl` snippets) inside any POSIX-ish shell, or copy every `.mjs` file from `extension/` manually into `%USERPROFILE%\.copilot\extensions\ralph\`.

### Option D — Pin a specific tagged release

The default install snippets curl from `main`, which is rolling-latest. To pin a specific revision (recommended for shared/CI environments), download the assets attached to a [GitHub Release](https://github.com/kloba/copilot-ralph-extension/releases):

```bash
VERSION=v0.7.0
mkdir -p ~/.copilot/extensions/ralph
# Same leaf-first ordering as Option A — see comment there.
for f in scout-tool.mjs shipper-agent.mjs handler.mjs extension.mjs; do
  curl -fsSL "https://github.com/kloba/copilot-ralph-extension/releases/download/$VERSION/$f" \
    -o ~/.copilot/extensions/ralph/$f
done
```

For a project-scoped pin, swap `~/.copilot/extensions/ralph` for `.github/extensions/ralph` inside your repo. See [`docs/RELEASING.md`](docs/RELEASING.md) for the release workflow that produces these assets.

## Usage

In a Copilot CLI session, ask the agent to invoke `ap_loop`:

> *"Use ap_loop to: create a REST API for todos with CRUD operations and tests. Run tests after each change. Output COMPLETE when all tests pass. max_iterations 20."*

The tool **arms** the loop and returns immediately. Iterations then play out as normal assistant turns, each kicked off by a `session.idle` event re-injecting the prompt via `session.send`.

### Tool parameters

| Param | Default | Purpose |
|---|---|---|
| `prompt` | _(required)_ | The task prompt re-fed each iteration. Max 65536 chars. |
| `max_iterations` | `20` | Hard iteration cap (integer, 1–1000) |
| `min_iterations` | `1` | Minimum iterations before `completion_promise` / `abort_promise` are honored. Use this to force verification passes even if the agent declares completion early. |
| `completion_promise` | `"COMPLETE"` | Substring in assistant response → stop. Trimmed; max 200 chars. |
| `abort_promise` | _(none)_ | Substring → early abort. Trimmed; max 200 chars. Must differ from `completion_promise` and not overlap as a substring (e.g. `completion_promise: "DONE"` together with `abort_promise: "DONE_FAIL"` is rejected because `"DONE_FAIL"` contains `"DONE"`) |
| `stagnation_limit` | `3` | Abort after N consecutive byte-identical responses (0 disables, must be ≥ 2 if set — `1` is rejected since no comparison is possible after a single response) |
| `max_tokens` | _(none)_ | Optional cumulative token cap (input + output combined). Loop stops with reason `max_tokens` when crossed at end of an iteration. Useful to bound spend on long-running self-improve / grow-project runs. |
| `warn_at_pct` | `80` | First context-window warning threshold (percent of model's total window). A second hard-coded warning fires at 95%. Each fires at most once per loop run. |
| `adaptive_budget` | `false` | Opt-in adaptive iteration budget (issue [#4](https://github.com/kloba/copilot-ralph-extension/issues/4)). When the loop reaches `max_iterations` and progress signals are positive (see [Adaptive iteration budget](#adaptive-iteration-budget) below), grants `adaptive_extension` more iterations, capped at `adaptive_max_total`. |
| `adaptive_extension` | `10` | Iterations granted per adaptive extension. Ignored when `adaptive_budget` is `false`. Integer, 1–1000. |
| `adaptive_max_total` | `min(max_iterations*5, 1000)` | Hard ceiling for the effective max even after adaptive extensions. Must be ≥ `max_iterations` and ≤ 1000. |

### Companion tool

`ap_stop` cancels an active loop and returns the iteration count. Optionally takes a `reason` string (≤500 chars) which is recorded on the result as `note` and surfaced in the log line and `additionalContext` injection — handy when the agent (or user) wants to record *why* the loop was stopped manually.

```js
ap_stop({ reason: "user changed plan" })
```

`ap_stop` returns:

```js
{
  textResultForLlm: "ap_loop stopped after 4/20 iterations (user changed plan).",   // leading "ap_loop" reflects the calling tool's label — a self_improve-armed loop reads "self_improve stopped after …", and a grow_project-armed loop reads "grow_project stopped after …"
  resultType: "success",
  iterations: 4,
  note: "user changed plan"   // omitted when no reason was supplied
}
```

If no loop is active it returns `resultType: "failure"` with the message `ap_stop: no ap_loop, self_improve, or grow_project is currently running.` and does nothing else — there's no new outcome to surface. (When `ap_stop` *does* succeed, the resulting `user_stopped` outcome flows through the `additionalContext` injection on the next `onUserPromptSubmitted` hook, exactly as for any other finish reason.)

### Result shape

`ap_loop` (the arming call) returns:

```js
{
  textResultForLlm: "ap_loop armed (max=20). Iterations will run as conversation turns. Use ap_stop to cancel.",
  resultType: "success",
  armed: true,
  max: 20,
  min: 1
}
```

The actual loop **outcome** (iteration count, reason, timing) is surfaced in two ways:
- `session.log` markers visible in the timeline (`🔁 ap_loop iter 4/20 (elapsed 12345ms)`, `✅ completed ap_loop after 4 iterations (reason: completion_promise, 12345ms)`). The leading label (`ap_loop`, `self_improve`, or `grow_project`) reflects which tool armed the loop, so a `self_improve`-armed run shows `🔁 self_improve iter 4/20` and a `grow_project`-armed run shows `🔁 grow_project iter 4/200`. The closing-line verb depends on the finish reason: ✅ *completed* (`completion_promise`), ⚠️ *ended* (`send_error`, `aborted`, `abort_promise`, `stagnation` — the four reasons that map to `type=abort` in the terminal event, so the marker matches the red badge in the TUI), and ⏹ *stopped* for the neutral exits (`max_iterations`, `max_tokens`, `user_stopped`, `detached`).
- An `additionalContext` injection on the *next* `onUserPromptSubmitted` hook so the agent silently learns the loop finished and why (`[ap_loop just finished — iterations=4, reason=completion_promise, durationMs=12345]`, or `[self_improve just finished — …]` / `[grow_project just finished — …]` when armed via the corresponding tool).

The full structured result (available via `controller.state.lastResult` for embedders):

```js
{
  reason: "completion_promise",
  iterations: 4,
  label: "ap_loop",                 // "ap_loop", "self_improve", or "grow_project" — which tool armed the loop
  preview: "first 500 chars of last assistant content…",
  startedAt: 1719000000000,
  finishedAt: 1719000012345,
  durationMs: 12345,                  // active runtime — wall-clock from arming MINUS total paused time (issue #3)
  note: "user changed plan",          // present when set via ap_stop or on send_error / abort with reason
  tokens: {                            // present only when usage events were observed (issue #7)
    input: 12500,
    output: 1800,
    total: 14300,
    byIteration: [{ iter: 1, input: 8000, output: 900, model: "claude-opus-4.7" }, /* ... */],
    byModel: { "claude-opus-4.7": { input: 12500, output: 1800 } }
  }
}
```

`reason` ∈ `completion_promise` · `abort_promise` · `stagnation` · `max_iterations` · `max_tokens` · `send_error` · `aborted` · `user_stopped` · `detached`.

### Token usage

The loop tracks per-iteration token usage from the SDK's `assistant.message` events (when present) and surfaces it on the result as `tokens`. It also:

- Warns once when cumulative input tokens cross `warn_at_pct` (default 80%) of the model's known context window, and again at 95%.
- Stops the loop with reason `max_tokens` when the cumulative total (input + output) crosses the optional `max_tokens` cap. The cap is checked at the end of each iteration (after `min_iterations` have completed), never mid-iteration.
- Skips warnings (with a one-time log line) for models not in the static context-window table.

### Tips

- **Always set `max_iterations`** — runaway loops burn premium requests fast.
- The prompt **must instruct the agent to emit the completion promise** when done, otherwise the loop only stops at `max_iterations`.
- Use `abort_promise` for "stop early if the precondition fails" — e.g. `"PRECONDITION_FAILED"`.
- `stagnation_limit` (default 3) catches stuck agents that keep returning identical responses; set to `0` to disable.
- `min_iterations` is useful when you want the agent to run additional verification or double-check passes even if the completion phrase appears early.
- Each iteration is a **paid turn**. Budget accordingly.

### Self-improve (`self_improve` tool)

`self_improve` is a thin wrapper that arms `ap_loop` with a baked-in, **project-agnostic SDLC** prompt. Use it on **any repo** to drive an autonomous improvement loop without writing the prompt yourself:

> *"Use self_improve to keep improving this project for 100 iterations."*

Each iteration walks the agent through nine stages: **ORIENT** (read recent commits + project docs, detect the test command) → **IDEATE** (pick ONE concrete change, rotating across SDLC categories: bug fix, hardening, validation, tests, refactor, dependency hygiene, docs, release engineering) → **CRITIQUE** (rubber-duck pass) → **BASELINE** (run the existing test command) → **IMPLEMENT** (surgical edits only) → **TEST** (must stay green at same-or-higher count) → **COMMIT** (conventional-commit prefix + dual `Co-authored-by` trailers; see [Commit attribution](#commit-attribution)) → **PUSH** (non-fatal) → **END** (emit `COMPLETE` or `ABORT_NO_IMPROVEMENTS`).

| Param | Default | Purpose |
|---|---|---|
| `max_iterations` | `100` | Hard iteration cap (1–1000) |
| `min_iterations` | `5` | Honors completion / abort phrases only after N iterations. The default is automatically clamped down to `max_iterations` when `max_iterations < 5` (so `self_improve({max_iterations: 3})` runs 3 iters, not a confusing rejection); an explicitly-supplied `min_iterations > max_iterations` is still rejected loudly. |
| `focus` | _(none)_ | Optional ≤2000-char string. Appended verbatim as `Focus this run on: <focus>` after the SDLC scaffolding — narrows the run to one area without altering the SDLC stages. |
| `completion_promise` | `"COMPLETE"` | Substring → stop. Trimmed; max 200 chars. |
| `abort_promise` | _(none)_ | Substring → early abort. Same disjoint-substring rule as `ap_loop`. |
| `stagnation_limit` | `3` | Same rules as `ap_loop` (≥ 2 or `0` to disable; `1` is rejected). |

`self_improve` reuses the same internal state machine as `ap_loop` — the same `controller.state.active` shape, the same `finish()` pipeline, the same timeline log line (just with `self_improve` as the label), and the same `additionalContext` post-loop hook. Only one loop runs per session at a time, so a `self_improve` while a `ap_loop` (or `grow_project`) is active fails fast (and vice versa). Cancel with `ap_stop` exactly as you would for any `ap_loop`.

> ⚠️ **The baked SDLC prompt instructs the agent to emit `COMPLETE` at the end of every iteration.** That means `completion_promise` would fire on iter 1 if `min_iterations` allowed it. The default `min_iterations: 5` defers honoring `COMPLETE` until iter 5 (so a 100-iter call usually stops there). To run the full budget, set `min_iterations` equal to `max_iterations` — e.g. `self_improve({ max_iterations: 100, min_iterations: 100 })`. Use `ap_stop` to tear down a long-running session early.

### Grow-project (`grow_project` tool)

`grow_project` is a third long-running loop tool, parallel to `self_improve`. Where `self_improve` polishes an existing codebase, `grow_project` *grows* one: on the first iteration it ideates a backlog of small, well-scoped features and persists them as **GitHub issues** (`gh issue create --label grow-project --label proposed`); subsequent iterations each pick one proposed issue, implement it, and close it. The per-feature completion gate is **three-part**: (a) tests stay green, (b) every checkbox in the issue's `acceptance_criteria` block passes, (c) the issue's `demo_command` is executed and its output is pasted back as a comment.

> *"Use grow_project to bootstrap and ship features for this project."*

Each iteration walks the agent through thirteen stages: **ORIENT** (`gh issue list --label grow-project --state open` + recent commits + docs) → **IDEATE** (only on iter 1 with empty backlog: 5–10 well-scoped issues with spec, acceptance_criteria checkbox list, and demo_command) → **SELECT** (pick oldest `proposed` issue whose `Depends-on:` lines are all closed; re-label `in-progress`) → **CRITIQUE** (rubber-duck the spec) → **BASELINE** (run tests; bail if red) → **IMPLEMENT** (surgical edits in the file allowlist) → **TEST** (stay green at same-or-higher count) → **ACCEPTANCE** (execute every checkbox check) → **DEMO** (run the issue's `demo_command`, paste output as a comment) → **COMMIT** (conventional commit `feat(#N): <title>` with `Closes #N` + dual `Co-authored-by` trailers; see [Commit attribution](#commit-attribution)) → **PUSH** → **CLOSE** (`gh issue close N --reason completed`) → **END** (`COMPLETE`, or `ABORT_NO_BACKLOG` when no ready issues remain).

| Param | Default | Purpose |
|---|---|---|
| `max_iterations` | `200` | Hard iteration cap (1–1000). Larger than `self_improve` because feature work takes more turns than polish. |
| `min_iterations` | `10` | Honors completion / abort phrases only after N iterations. Drains a baseline portion of the backlog before honoring early `ABORT_NO_BACKLOG`. The default is automatically clamped down to `max_iterations` when `max_iterations < 10`; an explicitly-supplied `min_iterations > max_iterations` is still rejected loudly. |
| `focus` | _(none)_ | Optional ≤2000-char string. Appended verbatim as `Focus this run on: <focus>` after the SDLC scaffolding — narrows the backlog ideation/selection to one area without altering the SDLC stages. |
| `completion_promise` | `"COMPLETE"` | Substring → stop. Trimmed; max 200 chars. |
| `abort_promise` | `"ABORT_NO_BACKLOG"` | Substring → early abort (signaled by the agent when no proposed issue is ready). Same disjoint-substring rule as `ap_loop`. |
| `stagnation_limit` | `3` | Same rules as `ap_loop` (≥ 2 or `0` to disable; `1` is rejected). |

`grow_project` reuses the same internal state machine as `ap_loop` and `self_improve` — the same `controller.state.active` shape, the same `finish()` pipeline, the same timeline log line (just with `grow_project` as the label), and the same `additionalContext` post-loop hook. **Only one loop runs per session at a time**, so calling `grow_project` while a `ap_loop` or `self_improve` is active fails fast (and vice versa). Cancel with `ap_stop` exactly as you would for any `ap_loop`.

> ⚠️ **The baked prompt drives `gh` CLI calls.** Make sure the agent has a working `gh auth status` before arming `grow_project` — without auth, the very first `gh issue list` call fails and the agent will burn iterations trying to recover. Run `gh auth login` once per repo / once per machine. The `grow-project` and `proposed` labels do not need to exist beforehand; `gh issue create --label X` will refuse on first use, but the agent is instructed to create them with `gh label create grow-project` / `gh label create proposed` on the first iter.

> ⚠️ **The baked prompt instructs the agent to emit `COMPLETE` at the end of every iteration and `ABORT_NO_BACKLOG` when the backlog is exhausted.** As with `self_improve`, `completion_promise` would fire on iter 1 if `min_iterations` allowed it; the default `min_iterations: 10` defers honoring `COMPLETE` until iter 10. Set `min_iterations` equal to `max_iterations` to drain the full budget. Use `ap_stop` to tear down a long-running session early.

### Read-only watcher TUI (`autopilot-tui`)

The optional `@autopilot/tui` package ships a thin **read-only**
dashboard that polls the loop's persisted state file
(`~/.copilot/autopilot/state.json`, written atomically by the
in-extension driver) and renders Header / Timeline / Footer panes.
It does NOT spawn anything, does NOT feed prompts, does NOT drive a
loop — start the loop with `/autopilot run` from a regular Copilot
CLI session and run the watcher in a side terminal:

```bash
# Print the current state once.
node packages/tui/bin/tui.mjs show

# Live dashboard (Ink-rendered if ink/react are installed,
# plain-text fallback otherwise; auto-plain when stdout is not a TTY).
node packages/tui/bin/tui.mjs watch
```

Pressing `q` or Ctrl-C quits the TUI; the loop keeps running. The
watcher has no reverse channel to the loop — to stop the loop, run
`/autopilot stop` from the originating Copilot CLI session.

> The legacy out-of-session SDLC driver (`ralph-tui run …`) was
> removed in 0.7.0 alongside the broader autopilot rewrite. The new
> watcher is the entire TUI surface — see
> [`packages/tui/README.md`](packages/tui/README.md) for the
> trimmed CLI.

## Development

```bash
npm test     # runs the node:test suite under test/ (no deps, no install needed)
npm run check  # syntax-checks every shipped .mjs (mirrors the CI "Syntax check" job)
```

The handler logic lives in [`extension/handler.mjs`](extension/handler.mjs) and is decoupled from the SDK so it can be unit-tested with a fake session that drives events deterministically.

## Documentation

Contributor and design docs live under [`docs/`](docs/) so this README can stay focused on end-users:

- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — local dev setup, style conventions, commit-trailer rules, PR expectations.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design notes on the `session.idle` event-driven loop, the `extension.mjs`/`handler.mjs` split, the baked-prompt pattern, and the tool surface.
- [`docs/RELEASING.md`](docs/RELEASING.md) — manual release checklist for tagged GitHub Releases.
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability and the supported-versions policy.
## Inspecting a running loop (`ap_status` tool)

`ap_status` returns a structured live snapshot of the active loop — iteration count, elapsed time, configured promises, pause state, live token usage, last response excerpt, and (when running inside a git repo) the files touched since the loop was armed. It's read-only and cheap (typically <10ms), so call it as often as you like.

```bash
> ap_status
```

Sample structured payload (`status` key on the tool result):

```jsonc
{
  "active": true,
  "label": "self_improve",
  "iteration": 7,
  "max_iterations": 20,
  "min_iterations": 1,
  "elapsed_ms": 142318,
  "elapsed_seconds": 142,
  "started_at": "2025-05-01T18:30:00.000Z",
  "last_iteration_at": "2025-05-01T18:32:22.000Z",
  "now": "2025-05-01T18:32:22.318Z",
  "completion_promise": "COMPLETE",
  "abort_promise": null,
  "stagnation_limit": 3,
  "stagnation_streak": 0,
  "pending_first_iteration": false,
  "paused": false,
  "pause_reason": null,
  "paused_at": null,
  "paused_for_ms": 0,
  "total_paused_ms": 0,
  "tokens": {
    "input": 145300,
    "output": 28412,
    "total": 173712,
    "max_tokens": null
  },
  "last_response_excerpt": "Implemented the GET /todos endpoint and added 3 tests…",
  "git": {
    "branch": "main",
    "armed_head": "abc1234…",
    "head": "def5678…",
    "ahead": 0,
    "behind": 0,
    "uncommitted_lines": 142
  },
  "files_changed": {
    "added": ["src/routes/todos.ts"],
    "modified": ["src/app.ts", "test/todos.test.ts"],
    "deleted": [],
    "renamed": []
  }
}
```

When no loop is active, `ap_status` returns `{ active: false }` plus a `last` summary of the most recent run in this session (label, reason, iteration count, duration, and preview), or just `{ active: false }` if no loop has run yet.

Behaviour notes:

- **Read-only.** Never mutates loop state — calling it during a loop never advances iterations, resets stagnation, or moves any timer.
- **`elapsed_ms` is wall-clock.** Counted from arm-time to "now" and includes pause time — so a loop paused for 60 seconds reports `elapsed_ms` 60_000 ms higher than its active-time peer would. Subtract `total_paused_ms` (and `paused_for_ms` if currently paused) from the structured snapshot if you need active-only time. The one-line `textResultForLlm` summary uses the same wall-clock value, mirroring the [`ap_status` summary contract documented in concepts.md](./docs/concepts.md#ap_status-one-line-summary).
- **Pause visibility.** When `ap_pause` has parked the loop, `paused` is `true`, `pause_reason` echoes whatever was passed (truncated to a preview length), `paused_at` is the ISO timestamp the pause took effect, `paused_for_ms` is the *current* pause duration (always 0 when not paused), and `total_paused_ms` is the cumulative time spent paused across prior pause/resume cycles in this run. The one-line `textResultForLlm` summary appends `(PAUSED — <reason>, for <ms>ms)` when a reason was supplied, or the bare `(PAUSED, for <ms>ms)` (no em-dash, no reason slot) when `ap_pause` was called without one — see the [summary contract in concepts.md](./docs/concepts.md#ap_status-one-line-summary) for the canonical grammar — so a model reading the result without introspecting the JSON still sees the pause.
- **Live token usage.** The `tokens` block surfaces cumulative `input`, `output`, and `total` token counts credited so far, plus the configured `max_tokens` cap (or `null` when no cap was armed). Counts start at 0 and accumulate from every `assistant.message` event observed during the loop; while the loop is paused, no tokens are credited (matching the pause/resume isolation contract). Use this to monitor budget consumption mid-run without waiting for the terminal result. The one-line `textResultForLlm` summary appends `, tokens X/Y` when `max_tokens` is armed (omitted otherwise) so a model reading the result without introspecting the JSON still sees budget pressure.
- **Files-changed window.** Computed by diffing the current working tree (`git status --porcelain`) plus `git diff --name-status` against the HEAD captured at arm-time. Untracked files surface in `added`. Outside a git repo the entire `git` block is `null` and `files_changed` is omitted.
- **No external API calls.** Only synchronous local `git` invocations with a 2-second timeout each; if any individual call fails, the corresponding field is `null` and the rest of the snapshot still returns.

## Adaptive iteration budget

By default, `ap_loop` (and `self_improve`, `grow_project`) hard-stops at `max_iterations`. Sometimes the loop is genuinely making progress at the terminator and a flat cap aborts useful work. Issue [#4](https://github.com/kloba/copilot-ralph-extension/issues/4) adds an opt-in **adaptive budget**: when the loop hits `max_iterations`, the controller checks two cheap signals — and if either is positive, grants `adaptive_extension` more iterations (capped by `adaptive_max_total`).

Signals (positive ⇒ extend):

1. **File-change signal** — `git diff --shortstat HEAD` reports any uncommitted changes, OR `git status --porcelain` is non-empty. Best-effort: if `git` isn't available or cwd isn't a repo, this signal stays unset.
2. **Response novelty** — ≥ 2 distinct response hashes among the last 3 iterations. Stagnation already covers hard-identical streaks, so novelty is genuinely additive.

Stagnation, `completion_promise`, and `abort_promise` always win over the adaptive extension. The hard ceiling `adaptive_max_total` is never crossed.

```js
ap_loop({
  prompt: "Fix the failing build, run tests, commit. Emit COMPLETE when green.",
  max_iterations: 20,
  adaptive_budget: true,
  adaptive_extension: 10,
  adaptive_max_total: 80,
});
```

Each granted extension is logged (`adaptive budget extended N → M (reason: …)`) and surfaced on the loop's final `RalphResult` as `result.adaptive = { enabled, originalMax, effectiveMax, extensions, history }`.
## Pause and resume

Long autonomous runs sometimes need a manual checkpoint — to read a diff, run tests by hand, fix something, then continue. `ap_pause` and `ap_resume` (issue [#3](https://github.com/kloba/copilot-ralph-extension/issues/3)) let you do that without losing iteration count or conversation context:

```js
ap_pause({ reason: "manual review of the refactor" });
// …chat freely with the agent. Those turns do NOT count toward max_iterations.
ap_resume();
```

- The currently-running iteration finishes normally; subsequent `session.idle` events are short-circuited until `ap_resume`.
- Iteration counter, prompt, and full conversation context are preserved across the pause.
- **Pause-time chat is isolated from loop bookkeeping.** Tokens consumed during your pause-time conversation are not credited to the loop's budget (so a long chat cannot spuriously trip a configured `max_tokens` cap on resume), and your pause-time messages are not inspected for the configured `completion_promise` / `abort_promise` triggers (so a casual mention of the phrase will not terminate the loop). See [Concepts → Pause / resume semantics](./docs/concepts.md#pause--resume-semantics) for the full contract and the trade-off (an in-flight iter completion signal that landed right before pause is forfeited; you can still inspect it via `ap_status.last_response_excerpt`).
- `ap_resume` resets the stagnation streak (manual intervention almost always changes context, so a post-resume identical-to-pre-pause turn must NOT be misclassified as stuck).
- `ap_pause` is idempotent: pausing an already-paused loop is a no-op success. **First reason wins** — a second `ap_pause({reason: "newer"})` against an already-paused loop returns the FIRST reason in both the success payload (`reason` field) and the rendered `textResultForLlm` (`<label> already paused at i/max (firstReason).`). Automation polling pause state will not see its own input echoed back.
- `ap_stop` works while paused and terminates the loop.
- `ap_resume` on a non-paused loop is a failure (use `ap_pause` first).

## How it works

```js
import { joinSession } from "@github/copilot-sdk/extension";
import { createRalphController } from "./handler.mjs";

const controller = createRalphController();
const session = await joinSession({
    tools: controller.tools,   // ap_loop + ap_stop + ap_status + ap_pause + ap_resume + self_improve + grow_project
    hooks: controller.hooks,   // onUserPromptSubmitted carries the result forward
});
const detach = controller.attach(session);    // wires session.idle / assistant.message / abort listeners
// detach() unsubscribes all listeners; if a loop is still active, it finishes with reason: "detached".
```

### Arming

`ap_loop(...)` returns immediately with `{ armed: true }`. It does **not** loop synchronously. The validated arguments (`prompt`, `max`, `min`, `completionPromise`, `abortPromise`, `stagnationLimit`) are stored on `controller.state.active`; the loop is now driven entirely by SDK events.

### Iterations are driven by events, not by a hook

`controller.attach(session)` subscribes to three SDK events:

| Event | Role |
|---|---|
| `assistant.message` | Accumulates the current turn's content into `state.lastAssistantContent` (capped at 1 MiB; tail preserved so completion phrases near the end aren't lost). |
| `session.idle` | The heartbeat. The first idle after arming is the turn that *called* `ap_loop` — that fires iteration 1's prompt. Each subsequent idle runs the decision ladder: completion → abort → stagnation → max → otherwise re-fire. |
| `abort` | Finalizes the loop with `reason: "aborted"` (and `note` if the SDK supplies a reason). |

Re-firing means calling `session.send({ prompt })` and not awaiting the response synchronously — the next iteration is driven by the next `session.idle`. The returned promise *is* still observed for rejection: an async send-failure finishes the loop with `reason: "send_error"` rather than silently dropping the iteration. Each call **enqueues a new user-turn** in the live conversation, which is why every iteration shows up in the timeline as a real user prompt followed by a real assistant turn (not some hidden background invocation).

Decision ladder per `session.idle` (in order, first match wins):

1. `i >= min` and `text.includes(completion_promise)` → finish `completion_promise`.
2. `i >= min` and `abort_promise` set and `text.includes(abort_promise)` → finish `abort_promise`.
3. Stagnation: N consecutive byte-identical responses → finish `stagnation` (overrides `min_iterations` as a safety floor).
4. `i >= max` → finish `max_iterations`.
5. Otherwise: increment `i`, clear the content accumulator, re-fire the prompt.

A failed `session.send` (sync throw or async rejection) finishes with `reason: "send_error"` and the underlying message on `result.note`.

### Root agent only — sub-agents are filtered

The SDK fans every event out to a single bus: a sub-agent (e.g. invoking `task` / `explore` / `code-review` / `rubber-duck`) emits its own `assistant.message`, `session.idle`, and `abort` events alongside the root agent's. Every event carries an optional `agentId` field that is **absent on root-agent events** and a string on sub-agent events.

Ralph filters on this field before reacting:

- **`assistant.message`** — sub-agent content is ignored, so quoting `COMPLETE` inside an `explore` summary doesn't terminate the loop.
- **`session.idle`** — sub-agent idle transitions are ignored, so an `explore` invocation that takes 12 turns doesn't queue 12 copies of the prompt.
- **`abort`** — sub-agent aborts are ignored, so a failed `task` / `explore` / `rubber-duck` doesn't kill the root ralph loop.

### Queue-bloat protection

The SDK emits one `session.idle` per *root-level* agentic loop completion — not per agentic-loop sub-turn. (An earlier design listened to `assistant.turn_end`, which fires once per tool-call boundary, so a single root response with N tool calls produced N+ events and queued duplicates — visible as the **`Queued (N)`** marker in the CLI UI.) As an additional belt-and-suspenders gate, a `fireInFlight` / `observedMessageThisFire` flag pair ensures Ralph only refires after it's actually seen an `assistant.message` from the root agent since the previous fire.

### The one hook (post-loop, not iteration driver)

`onUserPromptSubmitted` is the only hook the extension registers. It does **not** drive iterations. It runs on the *next* user prompt after the loop has finished and injects a single `additionalContext` line so the agent silently learns the outcome:

```text
[ap_loop just finished — iterations=4, reason=completion_promise, durationMs=12345]
```

This mirrors how Anthropic's Claude Code `ralph-wiggum` plugin uses the `Stop` hook to re-prompt — same architectural shape, just expressed via the Copilot CLI extension SDK.

If you arm a new `ap_loop` *before* the next user prompt fires, the prior run's result is wiped during arming — the post-loop context from the previous run will **not** leak into the new loop's first prompt.

## Commit attribution

The baked `self_improve` and `grow_project` SDLC prompts instruct the agent to add `Co-authored-by:` trailers to every commit so loop-driven changes are attributable. `ap_loop` reaches parity by appending a small commit-attribution rider to the user-supplied prompt at arm time — so any commit produced during a `ap_loop` iteration carries the same dual trailer. By default, every loop-driven commit ships **two** trailers (per [issue #1](https://github.com/kloba/copilot-ralph-extension/issues/1)):

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
```

The first identifies the agent. The second attributes the commit to a dedicated `copilot-ralph` GitHub account so commits made via this extension are passively searchable across public GitHub. Once the bot account is registered, `gh search commits "copilot-ralph@users.noreply.github.com"` (raw-text search across commit messages — GitHub's commit-search API has no `co-authored-by:` qualifier, so the trailer is matched as plain text) surfaces every public-repo commit produced by a `self_improve` / `grow_project` run — a zero-infrastructure usage signal.

### Opt-out

Set `RALPH_NO_ATTRIBUTION=1` in the environment before arming the loop to suppress the second `copilot-ralph` trailer. The first `Copilot` trailer still ships, since it identifies the agent that made the change. The opt-out is **honored by the prompt** (baked SDLC prompt for `self_improve` / `grow_project`; appended rider for `ap_loop`), not by the extension code path — the agent reads the env var during the COMMIT stage and omits the trailer accordingly.

```bash
RALPH_NO_ATTRIBUTION=1 copilot   # subsequent ap_loop / self_improve / grow_project loops omit the copilot-ralph trailer
```

### Caveats

- **Only public-repo commits are searchable.** GitHub's commit search API does not index private repositories, so private-repo loops are invisible to `gh search commits` regardless of the trailer. The bot-account profile likewise only shows public contributions.
- **This is effectively opt-in telemetry via git metadata.** No data leaves your machine — the trailer is just text in the commit object — but anyone reading the public commit log can correlate it with extension usage. The opt-out exists so you can disable that correlation per session without forking the extension.
- **The bot account must exist before commits are made.** Unregistered noreply emails do not link retroactively to a GitHub account once the account is created — the `copilot-ralph@users.noreply.github.com` mailbox (matching the trailer format used in the example block above) has to be claimed first, then the trailers will associate going forward.

## Keep system awake (`caffeinate`, macOS)

Long `ap_loop` / `self_improve` / `grow_project` runs can outlast macOS's idle-sleep timeout, which interrupts in-flight tool calls and timers. Opt in to a `caffeinate`-backed sleep block for the duration of the loop:

```bash
RALPH_CAFFEINATE=1 copilot                                # block idle sleep only (default)
RALPH_CAFFEINATE=1 RALPH_CAFFEINATE_SCOPE=idle+display copilot   # also keep the display awake
```

| Variable | Values | Default | Effect |
|---|---|---|---|
| `RALPH_CAFFEINATE` | `1` / `true` / `yes` / `on` (case-insensitive) — anything else disables | unset (disabled) | Master switch. When unset, the extension **never** spawns `caffeinate`. |
| `RALPH_CAFFEINATE_SCOPE` | `idle` or `idle+display` | `idle` | `idle` blocks idle/system sleep but lets the display lock for security. `idle+display` also prevents display sleep. |

Behaviour:

- Spawns `caffeinate -i [-d] -w <pid>` on arm, where `<pid>` is the host CLI process. Logs a single line: `keeping system awake via caffeinate (pid=…, scope=…)`.
- Killed automatically on loop completion, `ap_stop`, abort, or detach. The `-w` flag is a belt-and-braces fallback so a hard crash of the CLI still releases the wake-lock.
- **macOS only.** On Linux/Windows the helper is a silent no-op (a single log line records the skip). Future PRs may add `systemd-inhibit` / `SetThreadExecutionState` equivalents.
- **Graceful when the binary is missing.** If `caffeinate` isn't on `PATH` or `spawn` fails, the loop runs without sleep prevention and logs the failure — it never aborts the loop over a power-management nicety.
- **Disabled by default.** The extension does not modify system power state unless you set `RALPH_CAFFEINATE`.

## Troubleshooting

- **`/extensions` doesn't list `ralph`.** Confirm every `.mjs` from `extension/` (currently `extension.mjs`, `handler.mjs`, `scout-tool.mjs`, `shipper-agent.mjs`) is present in `~/.copilot/extensions/ralph/` (user-scoped) or `.github/extensions/ralph/` (project-scoped, only visible from inside that repo) and restart Copilot CLI. `./install.sh` from source double-checks every file with `node --check` before writing, and a partial copy (e.g. only the first two modules) crashes at module-load with `Cannot find module './handler.mjs'`.
- **`<owner> is already armed/running` failure.** Only one loop runs per session at a time — call `ap_stop` before re-arming. The leading word (`ap_loop`, `self_improve`, or `grow_project`) reflects whichever tool armed the active loop, so the guard fires on any of the three when one of the others is active.
- **`abort_promise … overlap as substrings`.** `completion_promise` and `abort_promise` must be disjoint phrases (e.g. `"DONE"` and `"DONE_FAIL"` is rejected because one contains the other). Pick non-overlapping tokens.
- **Loop ends immediately with `reason: send_error`.** The first `session.send` call rejected — usually because `controller.attach(session)` was not called or the session is no longer live. Check `result.note` for the underlying error.
- **Loop runs N+ times instead of stopping.** Check that the prompt actually instructs the agent to emit the `completion_promise` literally; with a quoted/paraphrased completion phrase the loop only stops at `max_iterations`.
- **Commit is missing the `copilot-ralph` `Co-authored-by:` trailer (or shipping it despite `RALPH_NO_ATTRIBUTION=1`).** The dual-trailer + opt-out behaviour lives in the [baked SDLC prompt](#commit-attribution), not in the extension code path — the agent reads the env var during COMMIT and decides accordingly. If the second trailer is missing on a commit you expected to attribute, re-run the iteration with the var unset (or audit `git log -1 --pretty=%B` to confirm); if it's still present despite the opt-out, the sub-agent likely couldn't see `process.env` (Limitations).

## Limitations

- **Substring-match completion can self-trigger.** Both `completion_promise` and `abort_promise` use plain substring matching against the assistant's accumulated turn output. If the agent quotes the trigger phrase mid-thought (e.g. *"I'll mark this COMPLETE when done"*), the loop will finish on that turn. Pick a phrase the agent is unlikely to mention casually; emoji or unusual tokens (e.g. `RALPH_DONE_42`) work well.
- **Multi-message turns join with newlines.** When the SDK emits multiple `assistant.message` events within a single turn, Ralph concatenates them with `\n`. A trigger phrase that lands *split* exactly across the boundary (e.g. one message ends with `"DO"` and the next starts with `"NE"` while looking for `"DONE"`) becomes `"DO\nNE"` and won't match. In practice the SDK emits whole responses or large multi-paragraph chunks, so this rarely bites — but choose phrases that won't realistically straddle a chunk boundary.
- **Prompt is re-injected verbatim every iteration.** The loop has no concept of progress — the agent must derive what's already done from its own conversation history. This is intentional (it matches the Anthropic plugin) but means a vague prompt yields vague iteration. Note: `ap_loop` augments the user-supplied prompt once at arm time with a small commit-attribution rider (see [Commit attribution](#commit-attribution)); after that augmentation, the same composed prompt is what gets re-injected verbatim each iteration.
- **Stagnation always overrides `min_iterations`.** Identical responses fire stagnation regardless of `min_iterations` — this is a safety floor, not a configurable behavior.
- **Iteration timing is loop-arm-relative and pause-deducted.** The `(elapsed Xms)` value in iter logs is wall-clock from arming. The final `durationMs` on the result is **active time** — wall-clock from arming minus `total_paused_ms` (cumulative time the loop spent paused via `ap_pause`), so a loop paused for an hour and then run for five minutes reports `durationMs ≈ 5 min`, not `≈ 65 min`. Per-turn timing isn't tracked. See [Pause and resume](#pause-and-resume) for the pause semantics.
- **One loop per session.** Arming a second `ap_loop` (or a `self_improve`, or a `grow_project`) while one is active fails fast — you must `ap_stop` the active loop first. The guard applies symmetrically across all three tools: a `ap_loop` while `self_improve` or `grow_project` is active is also rejected, and vice versa.
- **`self_improve` keeps re-iterating with no commits.** The baked SDLC prompt instructs the agent to emit `COMPLETE` when the staircase is done. Until that token appears in an iteration, the loop runs to `max_iterations`. To stop early, either `ap_stop` it manually or prepend a tighter `focus` so each iteration converges faster.
- **Attribution opt-out is honored by the prompt, not enforced by the runtime.** [`RALPH_NO_ATTRIBUTION=1`](#opt-out) suppresses the second `copilot-ralph` `Co-authored-by:` trailer only because the prompt instructs the agent to read the env var during the COMMIT stage and omit the trailer (baked into `self_improve` / `grow_project` SDLC prompts; appended as a rider to user prompts on `ap_loop`). The extension does not rewrite commits — if a sub-agent ignores the env var (or runs in a context where `process.env` isn't visible), the trailer can still ship. Audit a commit afterwards with `git log -1 --pretty=%B` if attribution must be guaranteed off.

## Requirements

- GitHub Copilot CLI (tested on `1.0.40-0`)
- Copilot CLI Extension SDK (`@github/copilot-sdk/extension`) — bundled with Copilot CLI
- Node.js ≥ 20 (only required for running the test suite; the installed extension uses the Node runtime bundled with Copilot CLI)
- No runtime npm dependencies. Tests use `node:test` (built-in); run them with `npm test`.
- **`gh` CLI** (≥ 2.0) authenticated via `gh auth login` — *only* required when arming `grow_project`. The baked SDLC prompt drives `gh issue list/create/edit/close` calls every iteration; without auth, the very first call fails and the agent burns iterations trying to recover. `ap_loop` and `self_improve` do not invoke `gh` and have no such requirement.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a per-release record of behavior changes, hardening notes, and bug fixes.

## License

MIT
