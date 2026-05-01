# copilot-ralph-extension

> Ralph Wiggum-style autonomous iterative loop for **GitHub Copilot CLI**, implemented as an in-session extension.

[![Inspired by](https://img.shields.io/badge/inspired_by-Anthropic_Ralph_Wiggum-blue)](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)

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

```
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
```

`install.sh` syntax-checks each source file with `node --check` and writes via temp-file + atomic `mv`, so a concurrent Copilot CLI reload can never see a half-written `handler.mjs`.

## Usage

In a Copilot CLI session, ask the agent to invoke `ralph_loop`:

> *"Use ralph_loop to: create a REST API for todos with CRUD operations and tests. Run tests after each change. Output COMPLETE when all tests pass. max_iterations 20."*

The tool **arms** the loop and returns immediately. Iterations then play out as normal assistant turns, each kicked off by a `session.idle` event re-injecting the prompt via `session.send`.

### Tool parameters

| Param | Default | Purpose |
|---|---|---|
| `prompt` | _(required)_ | The task prompt re-fed each iteration |
| `max_iterations` | `20` | Hard iteration cap (integer, 1–1000) |
| `min_iterations` | `1` | Minimum iterations before `completion_promise` / `abort_promise` are honored. Use this to force verification passes even if the agent declares completion early. |
| `completion_promise` | `"COMPLETE"` | Substring in assistant response → stop. Trimmed; max 200 chars. |
| `abort_promise` | _(none)_ | Substring → early abort. Trimmed; max 200 chars. Must differ from `completion_promise` and not overlap as a substring (e.g. `"DONE"` / `"DONE_FAIL"` is rejected) |
| `stagnation_limit` | `3` | Abort after N consecutive byte-identical responses (0 disables, must be ≥ 2 if set) |

### Companion tool

`ralph_stop` cancels an active loop and returns the iteration count. No-op (failure) if nothing is running. Optionally takes a `reason` string (≤500 chars) which is recorded on the result as `note` and surfaced in the log line and `additionalContext` injection — handy when the agent (or user) wants to record *why* the loop was stopped manually.

```js
ralph_stop({ reason: "user changed plan" })
```

`ralph_stop` returns:

```js
{
  textResultForLlm: "ralph_loop stopped after 4/20 iterations (user changed plan).",
  resultType: "success",
  iterations: 4,
  note: "user changed plan"   // omitted when no reason was supplied
}
```

If no loop is active it returns `resultType: "failure"` with the message `ralph_stop: no ralph_loop is currently running.` and does nothing else — there's no new outcome to surface. (When `ralph_stop` *does* succeed, the resulting `user_stopped` outcome flows through the `additionalContext` injection on the next `onUserPromptSubmitted` hook, exactly as for any other finish reason.)

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
- `session.log` markers visible in the timeline (`🔁 ralph_loop iter 4/20`, `✅ completed ralph_loop after 4 iterations (reason: completion_promise, 12345ms)`).
- An `additionalContext` injection on the *next* `onUserPromptSubmitted` hook so the agent silently learns the loop finished and why (`[ralph_loop just finished — iterations=4, reason=completion_promise, durationMs=12345]`).

The full structured result (available via `controller.state.lastResult` for embedders):

```js
{
  reason: "completion_promise",
  iterations: 4,
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
- `stagnation_limit` (default 3) catches stuck agents that keep returning identical responses; set to `0` to disable. Stagnation always overrides `min_iterations` (safety).
- `min_iterations` is useful when you want the agent to run additional verification or double-check passes even if the completion phrase appears early.
- Only one loop runs per session at a time. A second `ralph_loop` while one is active returns a failure.
- Each iteration is a **paid turn**. Budget accordingly.

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
    tools: controller.tools,   // ralph_loop + ralph_stop
    hooks: controller.hooks,   // onUserPromptSubmitted carries the result forward
});
controller.attach(session);    // wires session.idle / assistant.message / abort listeners
```

### Arming

`ralph_loop(...)` returns immediately with `{ armed: true }`. It does **not** loop synchronously. The validated arguments (`prompt`, `max`, `min`, `completion_promise`, `abort_promise`, `stagnation_limit`) are stored on `controller.state.active`; the loop is now driven entirely by SDK events.

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

```
[ralph_loop just finished — iterations=4, reason=completion_promise, durationMs=12345]
```

This mirrors how Anthropic's Claude Code `ralph-wiggum` plugin uses the `Stop` hook to re-prompt — same architectural shape, just expressed via the Copilot CLI extension SDK.

If you arm a new `ralph_loop` *before* the next user prompt fires, the prior run's result is wiped during arming — the post-loop context from the previous run will **not** leak into the new loop's first prompt.

## Limitations

- **Substring-match completion can self-trigger.** Both `completion_promise` and `abort_promise` use plain substring matching against the assistant's accumulated turn output. If the agent quotes the trigger phrase mid-thought (e.g. *"I'll mark this COMPLETE when done"*), the loop will finish on that turn. Pick a phrase the agent is unlikely to mention casually; emoji or unusual tokens (e.g. `RALPH_DONE_42`) work well.
- **Multi-message turns join with newlines.** When the SDK emits multiple `assistant.message` events within a single turn, Ralph concatenates them with `\n`. A trigger phrase that lands *split* exactly across the boundary (e.g. one message ends with `"DO"` and the next starts with `"NE"` while looking for `"DONE"`) becomes `"DO\nNE"` and won't match. In practice the SDK emits whole responses or large multi-paragraph chunks, so this rarely bites — but choose phrases that won't realistically straddle a chunk boundary.
- **Prompt is re-injected verbatim every iteration.** The loop has no concept of progress — the agent must derive what's already done from its own conversation history. This is intentional (it matches the Anthropic plugin) but means a vague prompt yields vague iteration.
- **Stagnation always overrides `min_iterations`.** Identical responses fire stagnation regardless of `min_iterations` — this is a safety floor, not a configurable behavior.
- **Iteration timing is loop-arm-relative.** The `(elapsed Xms)` value in iter logs and the final `durationMs` measure time from arming, not per-turn latency. Per-turn timing isn't tracked.
- **One loop per session.** Arming a second `ralph_loop` while one is active fails fast — you must `ralph_stop` the active loop first.

## Requirements

- GitHub Copilot CLI (tested on `1.0.40-0`)
- Copilot CLI Extension SDK (`@github/copilot-sdk/extension`) — bundled with Copilot CLI
- No runtime npm dependencies. Tests use `node:test` (built-in); run them with `npm test`.

## License

MIT
