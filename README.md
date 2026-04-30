# copilot-ralph-extension

> Ralph Wiggum-style autonomous iterative loop for **GitHub Copilot CLI**, implemented as an in-session extension.

[![Inspired by](https://img.shields.io/badge/inspired_by-Anthropic_Ralph_Wiggum-blue)](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)
[![Also see](https://img.shields.io/badge/see_also-open--ralph--wiggum-green)](https://github.com/Th0rgal/open-ralph-wiggum)

## What is Ralph Wiggum?

Ralph Wiggum is an iterative-agent technique: re-feed the same prompt to a coding agent in a loop until it emits a "completion promise" (e.g. `COMPLETE`) or hits an iteration cap. Originally a Claude Code plugin by Anthropic, popularized by [Th0rgal/open-ralph-wiggum](https://github.com/Th0rgal/open-ralph-wiggum) for multiple agents.

## What's different here?

Existing Ralph implementations for Copilot CLI (open-ralph-wiggum, copilot-ralph-mode, etc.) are **shell wrappers** — they spawn `copilot -p "..."` as a subprocess for each iteration. Each iteration starts with a **fresh session**.

This extension instead runs **in-session**, driven by the Copilot CLI extension SDK's `assistant.turn_end` event — the same architectural pattern as Anthropic's Claude Code [`ralph-wiggum`](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum) plugin (their `Stop` hook). Conversation context is **retained** across iterations and every iteration is a normal assistant turn the user sees.

| | This extension | Shell wrappers | Claude Code plugin |
|---|---|---|---|
| Agent | Copilot CLI | Copilot/Claude/Codex/etc. | Claude Code |
| Context across iterations | Retained | Fresh each iter | Retained |
| Where it runs | Inside your active session | External subprocess | Inside your active session |
| Mechanism | `assistant.turn_end` event + `session.send` | Subprocess fork per iter | `Stop` hook + re-prompt |

If you want fresh-context iterations, use [open-ralph-wiggum](https://github.com/Th0rgal/open-ralph-wiggum). If you want the agent to keep its working memory inside Copilot CLI, use this.

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
cp -r copilot-ralph-extension/extension ~/.copilot/extensions/ralph
```

## Usage

In a Copilot CLI session, ask the agent to invoke `ralph_loop`:

> *"Use ralph_loop to: create a REST API for todos with CRUD operations and tests. Run tests after each change. Output COMPLETE when all tests pass. max_iterations 20."*

The tool **arms** the loop and returns immediately. Iterations then play out as normal assistant turns, each kicked off by an `assistant.turn_end` event re-injecting the prompt via `session.send`.

### Tool parameters

| Param | Default | Purpose |
|---|---|---|
| `prompt` | _(required)_ | The task prompt re-fed each iteration |
| `max_iterations` | `20` | Hard iteration cap (integer, 1–1000) |
| `min_iterations` | `1` | Minimum iterations before `completion_promise` / `abort_promise` are honored. Use this to force verification passes even if the agent declares completion early. |
| `completion_promise` | `"COMPLETE"` | Substring in assistant response → stop |
| `abort_promise` | _(none)_ | Substring → early abort. Must differ from `completion_promise` and not overlap as a substring (e.g. `"DONE"` / `"DONE_FAIL"` is rejected) |
| `stagnation_limit` | `3` | Abort after N consecutive byte-identical responses (0 disables, must be ≥ 2 if set) |

### Companion tool

`ralph_stop` cancels an active loop and returns the iteration count. No-op (failure) if nothing is running. Optionally takes a `reason` string (≤500 chars) which is recorded on the result as `note` and surfaced in the log line and `additionalContext` injection — handy when the agent (or user) wants to record *why* the loop was stopped manually.

```js
ralph_stop({ reason: "user changed plan" })
```

### Result shape

`ralph_loop` (the arming call) returns:

```js
{
  textResultForLlm: "ralph_loop armed (max=20). Iterations will run as conversation turns.",
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
npm test    # runs the node:test suite under test/ (29 tests, no deps)
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
controller.attach(session);    // wires assistant.turn_end / assistant.message / abort listeners
```

The first `assistant.turn_end` after arming fires iteration 1's prompt; subsequent turn_ends evaluate the assistant's response against `completion_promise` / `abort_promise` / stagnation / `max_iterations`, and either re-fire the prompt or finish the loop. This is the same architectural pattern as Anthropic's Claude Code `ralph-wiggum` plugin (which uses a `Stop` hook for the same purpose).

## Limitations

- **Substring-match completion can self-trigger.** Both `completion_promise` and `abort_promise` use plain substring matching against the assistant's accumulated turn output. If the agent quotes the trigger phrase mid-thought (e.g. *"I'll mark this COMPLETE when done"*), the loop will finish on that turn. Pick a phrase the agent is unlikely to mention casually; emoji or unusual tokens (e.g. `RALPH_DONE_42`) work well.
- **Prompt is re-injected verbatim every iteration.** The loop has no concept of progress — the agent must derive what's already done from its own conversation history. This is intentional (it matches the Anthropic plugin) but means a vague prompt yields vague iteration.
- **Stagnation always overrides `min_iterations`.** Identical responses fire stagnation regardless of `min_iterations` — this is a safety floor, not a configurable behavior.
- **Iteration timing is loop-arm-relative.** The `(elapsed Xms)` value in iter logs and the final `durationMs` measure time from arming, not per-turn latency. Per-turn timing isn't tracked.
- **One loop per session.** Arming a second `ralph_loop` while one is active fails fast — you must `ralph_stop` the active loop first.

## Requirements

- GitHub Copilot CLI (tested on `1.0.40-0`)
- Copilot CLI Extension SDK (`@github/copilot-sdk/extension`) — bundled with Copilot CLI
- No runtime npm dependencies. Tests use `node:test` (built-in); run them with `npm test`.

## Related

- **[anthropics/claude-code/plugins/ralph-wiggum](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)** — original plugin for Claude Code
- **[Th0rgal/open-ralph-wiggum](https://github.com/Th0rgal/open-ralph-wiggum)** — multi-agent shell wrapper (Claude Code, Codex, Copilot CLI, Cursor, OpenCode)
- **[sepehrbayat/copilot-ralph-mode](https://github.com/sepehrbayat/copilot-ralph-mode)** — Python wrapper for Copilot CLI
- **[mihaiLucian/copilot-ralph](https://github.com/mihaiLucian/copilot-ralph)** — PowerShell wrapper for Copilot CLI
- **[michaelstonis/ImInDanger](https://github.com/michaelstonis/ImInDanger)** — C# CLI using GitHub.Copilot.SDK (.NET)

## License

MIT
