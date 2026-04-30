# copilot-ralph-extension

> Ralph Wiggum-style autonomous iterative loop for **GitHub Copilot CLI**, implemented as an in-session extension.

[![Inspired by](https://img.shields.io/badge/inspired_by-Anthropic_Ralph_Wiggum-blue)](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)
[![Also see](https://img.shields.io/badge/see_also-open--ralph--wiggum-green)](https://github.com/Th0rgal/open-ralph-wiggum)

## What is Ralph Wiggum?

Ralph Wiggum is an iterative-agent technique: re-feed the same prompt to a coding agent in a loop until it emits a "completion promise" (e.g. `COMPLETE`) or hits an iteration cap. Originally a Claude Code plugin by Anthropic, popularized by [Th0rgal/open-ralph-wiggum](https://github.com/Th0rgal/open-ralph-wiggum) for multiple agents.

## What's different here?

Existing Ralph implementations for Copilot CLI (open-ralph-wiggum, copilot-ralph-mode, etc.) are **shell wrappers** — they spawn `copilot -p "..."` as a subprocess for each iteration. Each iteration starts with a **fresh session**.

This extension instead runs **in-session** using the Copilot CLI extension SDK (`joinSession()` + `session.sendAndWait()`). Conversation context is **retained** across iterations.

| | This extension | Shell wrappers |
|---|---|---|
| Context | Retained across iterations | Fresh each iteration |
| Overhead | One in-session call | Full `copilot` CLI boot per iter |
| Where it runs | Inside your active session | External process |
| Use case | Refining within a coherent thread | Independent fresh attempts |

Both have legitimate use cases. If you want fresh-context iterations, use [open-ralph-wiggum](https://github.com/Th0rgal/open-ralph-wiggum). If you want the agent to keep its working memory, use this.

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

### Tool parameters

| Param | Default | Purpose |
|---|---|---|
| `prompt` | _(required)_ | The task prompt re-fed each iteration |
| `max_iterations` | `20` | Hard iteration cap (1–1000) |
| `completion_promise` | `"COMPLETE"` | Substring in assistant response → stop |
| `abort_promise` | _(none)_ | Substring → early abort (precondition fail) |
| `timeout_ms` | `600000` | Per-iteration timeout (10 min, min 1000) |
| `stagnation_limit` | `3` | Abort after N consecutive byte-identical responses (0 disables) |

### Result shape

`ralph_loop` returns a structured object:

```js
{
  textResultForLlm: "ralph_loop completed successfully after 4 iterations …",
  resultType: "success" | "failure",
  iterations: 4,
  reason: "completion_promise" | "abort_promise" | "stagnation" | "max_iterations" | "send_error",
  last_content_preview: "…last 500 chars of the final assistant response…"
}
```

### Tips

- **Always set `max_iterations`** — runaway loops burn premium requests fast.
- The prompt **must instruct the agent to emit the completion promise** when done, otherwise the loop only stops at `max_iterations`.
- Use `abort_promise` for "stop early if the precondition fails" — e.g. `"PRECONDITION_FAILED"`.
- `stagnation_limit` (default 3) catches stuck agents that keep returning identical responses; set to `0` to disable.
- Each iteration is a **paid turn**. Budget accordingly.

## Development

```bash
npm test    # runs the node:test suite under test/
```

The handler logic lives in [`extension/handler.mjs`](extension/handler.mjs) and is decoupled from the SDK so it can be unit-tested with a mocked session.

## How it works

```js
import { joinSession } from "@github/copilot-sdk/extension";

const session = await joinSession({
    tools: [{
        name: "ralph_loop",
        handler: async (args) => {
            for (let i = 1; i <= args.max_iterations; i++) {
                const event = await session.sendAndWait({ prompt: args.prompt });
                if (event?.data?.content?.includes(args.completion_promise)) {
                    return `Done after ${i} iterations.`;
                }
            }
            return `Stopped after ${args.max_iterations} iterations.`;
        },
    }],
});
```

The full implementation lives in [`extension/handler.mjs`](extension/handler.mjs) (pure, testable) and [`extension/extension.mjs`](extension/extension.mjs) (thin SDK boot). It adds error handling, abort-promise support, configurable timeout, stagnation detection, and `session.log()` progress reporting.

## Requirements

- GitHub Copilot CLI (tested on `1.0.40-0`)
- Copilot CLI Extension SDK (`@github/copilot-sdk/extension`) — bundled with Copilot CLI

## Related

- **[anthropics/claude-code/plugins/ralph-wiggum](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)** — original plugin for Claude Code
- **[Th0rgal/open-ralph-wiggum](https://github.com/Th0rgal/open-ralph-wiggum)** — multi-agent shell wrapper (Claude Code, Codex, Copilot CLI, Cursor, OpenCode)
- **[sepehrbayat/copilot-ralph-mode](https://github.com/sepehrbayat/copilot-ralph-mode)** — Python wrapper for Copilot CLI
- **[mihaiLucian/copilot-ralph](https://github.com/mihaiLucian/copilot-ralph)** — PowerShell wrapper for Copilot CLI
- **[michaelstonis/ImInDanger](https://github.com/michaelstonis/ImInDanger)** — C# CLI using GitHub.Copilot.SDK (.NET)

## License

MIT
