# copilot-ralph-extension

> Ralph Wiggum-style autonomous iterative loop for **GitHub Copilot CLI**, implemented as an in-session extension.

[![Inspired by](https://img.shields.io/badge/inspired_by-Anthropic_Ralph_Wiggum-blue)](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)

**Contents:** [What is Ralph?](#what-is-ralph-wiggum) · [What's different](#whats-different-here) · [Install](#install) · [Usage](#usage) · [Self-improve](#self-improve-self_improve-tool) · [Grow-project](#grow-project-grow_project-tool) · [How it works](#how-it-works) · [Commit attribution](#commit-attribution) · [Troubleshooting](#troubleshooting) · [Limitations](#limitations) · [Requirements](#requirements) · [Changelog](#changelog)

## What is Ralph Wiggum?

Ralph Wiggum is an iterative-agent technique: re-feed the same prompt to a coding agent in a loop until it emits a "completion promise" (e.g. `COMPLETE`) or hits an iteration cap. Originally a Claude Code plugin by Anthropic.

## What's different here?

Existing Ralph implementations for Copilot CLI (e.g. copilot-ralph-mode) are **shell wrappers** — they spawn `copilot -p "..."` as a subprocess for each iteration. Each iteration starts with a **fresh session**.

This extension instead runs **in-session**, driven by the Copilot CLI extension SDK's `session.idle` event — the same architectural pattern as Anthropic's Claude Code [`ralph-wiggum`](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum) plugin (their `Stop` hook). Conversation context is **retained** across iterations and every iteration is a normal assistant turn the user sees.

| | This extension | Shell wrappers | Claude Code plugin |
|---|---|---|---|
| Agent | Copilot CLI | Copilot/Claude/Codex/etc. | Claude Code |
| Context across iterations | Retained | Fresh each iter | Retained |
| Where it runs | Inside your active session | External subprocess | Inside your active session |
| Mechanism | `session.idle` event + `session.send` | Subprocess fork per iter | `Stop` hook + re-prompt |

If you want fresh-context iterations, use a shell-wrapper implementation. If you want the agent to keep its working memory inside Copilot CLI, use this.

## Install

### Option A — User-scoped (persists across all repos)

```bash
mkdir -p ~/.copilot/extensions/ralph
for f in extension.mjs handler.mjs; do
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
for f in extension.mjs handler.mjs; do
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
./install.sh --help         # print usage and exit
```

`install.sh` syntax-checks each source file with `node --check` and writes via temp-file + atomic `mv`, so a concurrent Copilot CLI reload can never see a half-written `handler.mjs`.

> **Windows note:** the runtime extension (`extension.mjs` + `handler.mjs`) is plain ESM and works wherever Copilot CLI runs. The `install.sh` script requires a Bash shell — on Windows use **WSL**, **Git Bash**, or **MSYS2**. As a fallback, follow Option A or B above (the `mkdir -p` + `curl` snippets) inside any POSIX-ish shell, or copy `extension/extension.mjs` and `extension/handler.mjs` manually into `%USERPROFILE%\.copilot\extensions\ralph\`.

## Usage

In a Copilot CLI session, ask the agent to invoke `ralph_loop`:

> *"Use ralph_loop to: create a REST API for todos with CRUD operations and tests. Run tests after each change. Output COMPLETE when all tests pass. max_iterations 20."*

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

### Companion tool

`ralph_stop` cancels an active loop and returns the iteration count. Optionally takes a `reason` string (≤500 chars) which is recorded on the result as `note` and surfaced in the log line and `additionalContext` injection — handy when the agent (or user) wants to record *why* the loop was stopped manually.

```js
ralph_stop({ reason: "user changed plan" })
```

`ralph_stop` returns:

```js
{
  textResultForLlm: "ralph_loop stopped after 4/20 iterations (user changed plan).",   // leading "ralph_loop" reflects the calling tool's label — a self_improve-armed loop reads "self_improve stopped after …", and a grow_project-armed loop reads "grow_project stopped after …"
  resultType: "success",
  iterations: 4,
  note: "user changed plan"   // omitted when no reason was supplied
}
```

If no loop is active it returns `resultType: "failure"` with the message `ralph_stop: no ralph_loop, self_improve, or grow_project is currently running.` and does nothing else — there's no new outcome to surface. (When `ralph_stop` *does* succeed, the resulting `user_stopped` outcome flows through the `additionalContext` injection on the next `onUserPromptSubmitted` hook, exactly as for any other finish reason.)

### Result shape

`ralph_loop` (the arming call) returns:

```js
{
  textResultForLlm: "ralph_loop armed (max=20). Iterations will run as conversation turns. Use ralph_stop to cancel.",
  resultType: "success",
  armed: true,
  max: 20,
  min: 1
}
```

The actual loop **outcome** (iteration count, reason, timing) is surfaced in two ways:
- `session.log` markers visible in the timeline (`🔁 ralph_loop iter 4/20 (elapsed 12345ms)`, `✅ completed ralph_loop after 4 iterations (reason: completion_promise, 12345ms)`). The leading label (`ralph_loop`, `self_improve`, or `grow_project`) reflects which tool armed the loop, so a `self_improve`-armed run shows `🔁 self_improve iter 4/20` and a `grow_project`-armed run shows `🔁 grow_project iter 4/200`. The closing-line verb depends on the finish reason: ✅ *completed* (`completion_promise`), ⚠️ *ended* (`send_error`, `aborted`), and ⏹ *stopped* for everything else (`max_iterations`, `abort_promise`, `stagnation`, `user_stopped`, `detached`).
- An `additionalContext` injection on the *next* `onUserPromptSubmitted` hook so the agent silently learns the loop finished and why (`[ralph_loop just finished — iterations=4, reason=completion_promise, durationMs=12345]`, or `[self_improve just finished — …]` / `[grow_project just finished — …]` when armed via the corresponding tool).

The full structured result (available via `controller.state.lastResult` for embedders):

```js
{
  reason: "completion_promise",
  iterations: 4,
  label: "ralph_loop",                 // "ralph_loop", "self_improve", or "grow_project" — which tool armed the loop
  preview: "first 500 chars of last assistant content…",
  startedAt: 1719000000000,
  finishedAt: 1719000012345,
  durationMs: 12345,
  note: "user changed plan"          // present when set via ralph_stop or on send_error / abort with reason
}
```

`reason` ∈ `completion_promise` · `abort_promise` · `stagnation` · `max_iterations` · `send_error` · `aborted` · `user_stopped` · `detached`.

### Tips

- **Always set `max_iterations`** — runaway loops burn premium requests fast.
- The prompt **must instruct the agent to emit the completion promise** when done, otherwise the loop only stops at `max_iterations`.
- Use `abort_promise` for "stop early if the precondition fails" — e.g. `"PRECONDITION_FAILED"`.
- `stagnation_limit` (default 3) catches stuck agents that keep returning identical responses; set to `0` to disable.
- `min_iterations` is useful when you want the agent to run additional verification or double-check passes even if the completion phrase appears early.
- Each iteration is a **paid turn**. Budget accordingly.

### Self-improve (`self_improve` tool)

`self_improve` is a thin wrapper that arms `ralph_loop` with a baked-in, **project-agnostic SDLC** prompt. Use it on **any repo** to drive an autonomous improvement loop without writing the prompt yourself:

> *"Use self_improve to keep improving this project for 100 iterations."*

Each iteration walks the agent through nine stages: **ORIENT** (read recent commits + project docs, detect the test command) → **IDEATE** (pick ONE concrete change, rotating across SDLC categories: bug fix, hardening, validation, tests, refactor, dependency hygiene, docs, release engineering) → **CRITIQUE** (rubber-duck pass) → **BASELINE** (run the existing test command) → **IMPLEMENT** (surgical edits only) → **TEST** (must stay green at same-or-higher count) → **COMMIT** (conventional-commit prefix + dual `Co-authored-by` trailers; see [Commit attribution](#commit-attribution)) → **PUSH** (non-fatal) → **END** (emit `COMPLETE` or `ABORT_NO_IMPROVEMENTS`).

| Param | Default | Purpose |
|---|---|---|
| `max_iterations` | `100` | Hard iteration cap (1–1000) |
| `min_iterations` | `5` | Honors completion / abort phrases only after N iterations |
| `focus` | _(none)_ | Optional ≤2000-char string. Appended verbatim as `Focus this run on: <focus>` after the SDLC scaffolding — narrows the run to one area without altering the SDLC stages. |
| `completion_promise` | `"COMPLETE"` | Substring → stop. Trimmed; max 200 chars. |
| `abort_promise` | _(none)_ | Substring → early abort. Same disjoint-substring rule as `ralph_loop`. |
| `stagnation_limit` | `3` | Same rules as `ralph_loop` (≥ 2 or `0` to disable; `1` is rejected). |

`self_improve` reuses the same internal state machine as `ralph_loop` — the same `controller.state.active` shape, the same `finish()` pipeline, the same timeline log line (just with `self_improve` as the label), and the same `additionalContext` post-loop hook. Only one loop runs per session at a time, so a `self_improve` while a `ralph_loop` (or `grow_project`) is active fails fast (and vice versa). Cancel with `ralph_stop` exactly as you would for any `ralph_loop`.

> ⚠️ **The baked SDLC prompt instructs the agent to emit `COMPLETE` at the end of every iteration.** That means `completion_promise` would fire on iter 1 if `min_iterations` allowed it. The default `min_iterations: 5` defers honoring `COMPLETE` until iter 5 (so a 100-iter call usually stops there). To run the full budget, set `min_iterations` equal to `max_iterations` — e.g. `self_improve({ max_iterations: 100, min_iterations: 100 })`. Use `ralph_stop` to tear down a long-running session early.

### Grow-project (`grow_project` tool)

`grow_project` is a third long-running loop tool, parallel to `self_improve`. Where `self_improve` polishes an existing codebase, `grow_project` *grows* one: on the first iteration it ideates a backlog of small, well-scoped features and persists them as **GitHub issues** (`gh issue create --label grow-project --label proposed`); subsequent iterations each pick one proposed issue, implement it, and close it. The per-feature completion gate is **three-part**: (a) tests stay green, (b) every checkbox in the issue's `acceptance_criteria` block passes, (c) the issue's `demo_command` is executed and its output is pasted back as a comment.

> *"Use grow_project to bootstrap and ship features for this project."*

Each iteration walks the agent through thirteen stages: **ORIENT** (`gh issue list --label grow-project --state open` + recent commits + docs) → **IDEATE** (only on iter 1 with empty backlog: 5–10 well-scoped issues with spec, acceptance_criteria checkbox list, and demo_command) → **SELECT** (pick oldest `proposed` issue whose `Depends-on:` lines are all closed; re-label `in-progress`) → **CRITIQUE** (rubber-duck the spec) → **BASELINE** (run tests; bail if red) → **IMPLEMENT** (surgical edits in the file allowlist) → **TEST** (stay green at same-or-higher count) → **ACCEPTANCE** (execute every checkbox check) → **DEMO** (run the issue's `demo_command`, paste output as a comment) → **COMMIT** (conventional commit `feat(#N): <title>` with `Closes #N` + dual `Co-authored-by` trailers; see [Commit attribution](#commit-attribution)) → **PUSH** → **CLOSE** (`gh issue close N --reason completed`) → **END** (`COMPLETE`, or `ABORT_NO_BACKLOG` when no ready issues remain).

| Param | Default | Purpose |
|---|---|---|
| `max_iterations` | `200` | Hard iteration cap (1–1000). Larger than `self_improve` because feature work takes more turns than polish. |
| `min_iterations` | `10` | Honors completion / abort phrases only after N iterations. Drains a baseline portion of the backlog before honoring early `ABORT_NO_BACKLOG`. |
| `focus` | _(none)_ | Optional ≤2000-char string. Appended verbatim as `Focus this run on: <focus>` after the SDLC scaffolding — narrows the backlog ideation/selection to one area without altering the SDLC stages. |
| `completion_promise` | `"COMPLETE"` | Substring → stop. Trimmed; max 200 chars. |
| `abort_promise` | `"ABORT_NO_BACKLOG"` | Substring → early abort (signaled by the agent when no proposed issue is ready). Same disjoint-substring rule as `ralph_loop`. |
| `stagnation_limit` | `3` | Same rules as `ralph_loop` (≥ 2 or `0` to disable; `1` is rejected). |

`grow_project` reuses the same internal state machine as `ralph_loop` and `self_improve` — the same `controller.state.active` shape, the same `finish()` pipeline, the same timeline log line (just with `grow_project` as the label), and the same `additionalContext` post-loop hook. **Only one loop runs per session at a time**, so calling `grow_project` while a `ralph_loop` or `self_improve` is active fails fast (and vice versa). Cancel with `ralph_stop` exactly as you would for any `ralph_loop`.

> ⚠️ **The baked prompt drives `gh` CLI calls.** Make sure the agent has a working `gh auth status` before arming `grow_project` — without auth, the very first `gh issue list` call fails and the agent will burn iterations trying to recover. Run `gh auth login` once per repo / once per machine. The `grow-project` and `proposed` labels do not need to exist beforehand; `gh issue create --label X` will refuse on first use, but the agent is instructed to create them with `gh label create grow-project` / `gh label create proposed` on the first iter.

> ⚠️ **The baked prompt instructs the agent to emit `COMPLETE` at the end of every iteration and `ABORT_NO_BACKLOG` when the backlog is exhausted.** As with `self_improve`, `completion_promise` would fire on iter 1 if `min_iterations` allowed it; the default `min_iterations: 10` defers honoring `COMPLETE` until iter 10. Set `min_iterations` equal to `max_iterations` to drain the full budget. Use `ralph_stop` to tear down a long-running session early.

## Development

```bash
npm test    # runs the node:test suite under test/ (no deps, no install needed)
```

The handler logic lives in [`extension/handler.mjs`](extension/handler.mjs) and is decoupled from the SDK so it can be unit-tested with a fake session that drives events deterministically.

## How it works

```js
import { joinSession } from "@github/copilot-sdk/extension";
import { createRalphController } from "./handler.mjs";

const controller = createRalphController();
const session = await joinSession({
    tools: controller.tools,   // ralph_loop + ralph_stop + self_improve + grow_project
    hooks: controller.hooks,   // onUserPromptSubmitted carries the result forward
});
const detach = controller.attach(session);    // wires session.idle / assistant.message / abort listeners
// detach() unsubscribes all listeners; if a loop is still active, it finishes with reason: "detached".
```

### Arming

`ralph_loop(...)` returns immediately with `{ armed: true }`. It does **not** loop synchronously. The validated arguments (`prompt`, `max`, `min`, `completionPromise`, `abortPromise`, `stagnationLimit`) are stored on `controller.state.active`; the loop is now driven entirely by SDK events.

### Iterations are driven by events, not by a hook

`controller.attach(session)` subscribes to three SDK events:

| Event | Role |
|---|---|
| `assistant.message` | Accumulates the current turn's content into `state.lastAssistantContent` (capped at 1 MiB; tail preserved so completion phrases near the end aren't lost). |
| `session.idle` | The heartbeat. The first idle after arming is the turn that *called* `ralph_loop` — that fires iteration 1's prompt. Each subsequent idle runs the decision ladder: completion → abort → stagnation → max → otherwise re-fire. |
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
[ralph_loop just finished — iterations=4, reason=completion_promise, durationMs=12345]
```

This mirrors how Anthropic's Claude Code `ralph-wiggum` plugin uses the `Stop` hook to re-prompt — same architectural shape, just expressed via the Copilot CLI extension SDK.

If you arm a new `ralph_loop` *before* the next user prompt fires, the prior run's result is wiped during arming — the post-loop context from the previous run will **not** leak into the new loop's first prompt.

## Commit attribution

The baked `self_improve` and `grow_project` SDLC prompts instruct the agent to add `Co-authored-by:` trailers to every commit so loop-driven changes are attributable. By default, every loop-driven commit ships **two** trailers (per [issue #1](https://github.com/kloba/copilot-ralph-extension/issues/1)):

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
```

The first identifies the agent. The second attributes the commit to a dedicated `copilot-ralph` GitHub account so commits made via this extension are passively searchable across public GitHub. Once the bot account is registered, `gh search commits "co-authored-by:copilot-ralph@users.noreply.github.com"` surfaces every public-repo commit produced by a `self_improve` / `grow_project` run — a zero-infrastructure usage signal.

### Opt-out

Set `RALPH_NO_ATTRIBUTION=1` in the environment before arming the loop to suppress the second `copilot-ralph` trailer. The first `Copilot` trailer still ships, since it identifies the agent that made the change. The opt-out is **honored by the baked prompt**, not by the extension code path — the agent reads the env var during the COMMIT stage and omits the trailer accordingly.

```bash
RALPH_NO_ATTRIBUTION=1 copilot   # subsequent self_improve/grow_project loops omit the copilot-ralph trailer
```

### Caveats

- **Only public-repo commits are searchable.** GitHub's commit search API does not index private repositories, so private-repo loops are invisible to `gh search commits` regardless of the trailer. The bot-account profile likewise only shows public contributions.
- **This is effectively opt-in telemetry via git metadata.** No data leaves your machine — the trailer is just text in the commit object — but anyone reading the public commit log can correlate it with extension usage. The opt-out exists so you can disable that correlation per session without forking the extension.
- **The bot account must exist before commits are made.** Unregistered noreply emails do not link retroactively to a GitHub account once the account is created — the `+copilot-ralph@users.noreply.github.com` mailbox has to be claimed first, then the trailers will associate going forward.

## Troubleshooting

- **`/extensions` doesn't list `ralph`.** Confirm `extension.mjs` and `handler.mjs` are present in `~/.copilot/extensions/ralph/` (user-scoped) or `.github/extensions/ralph/` (project-scoped, only visible from inside that repo) and restart Copilot CLI. `./install.sh` from source double-checks both files with `node --check` before writing.
- **`<owner> is already armed/running` failure.** Only one loop runs per session at a time — call `ralph_stop` before re-arming. The leading word (`ralph_loop`, `self_improve`, or `grow_project`) reflects whichever tool armed the active loop, so the guard fires on any of the three when one of the others is active.
- **`abort_promise … overlap as substrings`.** `completion_promise` and `abort_promise` must be disjoint phrases (e.g. `"DONE"` and `"DONE_FAIL"` is rejected because one contains the other). Pick non-overlapping tokens.
- **Loop ends immediately with `reason: send_error`.** The first `session.send` call rejected — usually because `controller.attach(session)` was not called or the session is no longer live. Check `result.note` for the underlying error.
- **Loop runs N+ times instead of stopping.** Check that the prompt actually instructs the agent to emit the `completion_promise` literally; with a quoted/paraphrased completion phrase the loop only stops at `max_iterations`.
- **Commit is missing the `copilot-ralph` `Co-authored-by:` trailer (or shipping it despite `RALPH_NO_ATTRIBUTION=1`).** The dual-trailer + opt-out behaviour lives in the [baked SDLC prompt](#commit-attribution), not in the extension code path — the agent reads the env var during COMMIT and decides accordingly. If the second trailer is missing on a commit you expected to attribute, re-run the iteration with the var unset (or audit `git log -1 --pretty=%B` to confirm); if it's still present despite the opt-out, the sub-agent likely couldn't see `process.env` (Limitations).

## Limitations

- **Substring-match completion can self-trigger.** Both `completion_promise` and `abort_promise` use plain substring matching against the assistant's accumulated turn output. If the agent quotes the trigger phrase mid-thought (e.g. *"I'll mark this COMPLETE when done"*), the loop will finish on that turn. Pick a phrase the agent is unlikely to mention casually; emoji or unusual tokens (e.g. `RALPH_DONE_42`) work well.
- **Multi-message turns join with newlines.** When the SDK emits multiple `assistant.message` events within a single turn, Ralph concatenates them with `\n`. A trigger phrase that lands *split* exactly across the boundary (e.g. one message ends with `"DO"` and the next starts with `"NE"` while looking for `"DONE"`) becomes `"DO\nNE"` and won't match. In practice the SDK emits whole responses or large multi-paragraph chunks, so this rarely bites — but choose phrases that won't realistically straddle a chunk boundary.
- **Prompt is re-injected verbatim every iteration.** The loop has no concept of progress — the agent must derive what's already done from its own conversation history. This is intentional (it matches the Anthropic plugin) but means a vague prompt yields vague iteration.
- **Stagnation always overrides `min_iterations`.** Identical responses fire stagnation regardless of `min_iterations` — this is a safety floor, not a configurable behavior.
- **Iteration timing is loop-arm-relative.** The `(elapsed Xms)` value in iter logs and the final `durationMs` measure time from arming, not per-turn latency. Per-turn timing isn't tracked.
- **One loop per session.** Arming a second `ralph_loop` (or a `self_improve`, or a `grow_project`) while one is active fails fast — you must `ralph_stop` the active loop first. The guard applies symmetrically across all three tools: a `ralph_loop` while `self_improve` or `grow_project` is active is also rejected, and vice versa.
- **`self_improve` keeps re-iterating with no commits.** The baked SDLC prompt instructs the agent to emit `COMPLETE` when the staircase is done. Until that token appears in an iteration, the loop runs to `max_iterations`. To stop early, either `ralph_stop` it manually or prepend a tighter `focus` so each iteration converges faster.
- **Attribution opt-out is honored by the prompt, not enforced by the runtime.** [`RALPH_NO_ATTRIBUTION=1`](#opt-out) suppresses the second `copilot-ralph` `Co-authored-by:` trailer only because the baked SDLC prompt instructs the agent to read the env var during the COMMIT stage and omit the trailer. The extension does not rewrite commits — if a sub-agent ignores the env var (or runs in a context where `process.env` isn't visible), the trailer can still ship. Audit a commit afterwards with `git log -1 --pretty=%B` if attribution must be guaranteed off.

## Requirements

- GitHub Copilot CLI (tested on `1.0.40-0`)
- Copilot CLI Extension SDK (`@github/copilot-sdk/extension`) — bundled with Copilot CLI
- Node.js ≥ 20 (only required for running the test suite; the installed extension uses the Node runtime bundled with Copilot CLI)
- No runtime npm dependencies. Tests use `node:test` (built-in); run them with `npm test`.
- **`gh` CLI** (≥ 2.0) authenticated via `gh auth login` — *only* required when arming `grow_project`. The baked SDLC prompt drives `gh issue list/create/edit/close` calls every iteration; without auth, the very first call fails and the agent burns iterations trying to recover. `ralph_loop` and `self_improve` do not invoke `gh` and have no such requirement.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a per-release record of behavior changes, hardening notes, and bug fixes.

## License

MIT
