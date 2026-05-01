# Architecture

This document is for contributors and future-self maintenance. End-user docs live in the [README](../README.md). For local-dev setup see [CONTRIBUTING.md](CONTRIBUTING.md).

## Why `session.idle` instead of a subprocess wrapper?

Existing Ralph implementations for Copilot CLI (e.g. `copilot-ralph-mode`) are **shell wrappers**: they `spawn copilot -p "<prompt>"` once per iteration. Each iteration starts with a fresh session and loses the conversation context built up by previous iterations.

This extension instead runs **inside the active session**, driven by the Copilot CLI extension SDK's `session.idle` event — the same architectural pattern as Anthropic's Claude Code [`ralph-wiggum`](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum) plugin (their `Stop` hook). When the root agent finishes its turn:

1. The SDK emits `session.idle` to all attached extensions.
2. The Ralph controller's `onIdle` handler runs the completion / abort / stagnation / max-iterations checks.
3. If the loop should continue, the controller calls `session.send({ prompt })` to inject the prompt as a new user turn.
4. Copilot CLI processes that turn exactly as if the human had typed it — including all UI rendering, model calls, tool execution, and ancillary handlers.

The trade-off is documented in the README's comparison table; see [What's different here?](../README.md#whats-different-here).

## Source layout

```
extension/
├── extension.mjs   # SDK glue — joinSession + createRalphController() + register tools/hooks
├── handler.mjs     # The entire controller: state machine, validation, tool defs, baked prompts
└── events-emit.mjs # Zero-dep JSONL event emitter (writes ~/.copilot/ralph/runs/<runId>/events.jsonl)
test/
├── extension.test.mjs       # node:test suite — controller against a fake session
├── events-emit.test.mjs     # Unit tests for the JSONL emitter helpers
└── handler-events.test.mjs  # Integration tests covering controller↔emitter wiring
packages/tui/       # Stand-alone TUI consumer (`ralph-tui`) — see packages/tui/README.md
install.sh          # User- or project-scoped install into ~/.copilot/extensions or .github/extensions
```

### `extension.mjs` vs `handler.mjs` split

- **`extension.mjs`** is the only file that talks to the SDK. It's intentionally tiny (~30 LOC). Anything beyond `joinSession`, `controller.attach(session)`, and `for (const t of controller.tools) session.registerTool(t)` does not belong here.
- **`handler.mjs`** is everything else: state machine, prompt validation, tool definitions, completion / abort / stagnation logic, baked-prompt templates, adaptive-budget signal evaluation, caffeinate spawning, etc. Because it's pure JS over a tiny event-bus interface (`on`/`emit`/`send`/`log`), it can be unit-tested with `makeFakeSession()` from `test/extension.test.mjs` — no SDK mock required.

The `createRalphController(opts?)` factory returns `{ tools, hooks, attach, state }`. Each call returns an **independent** controller with closure-private state — important because tests routinely create two controllers and assert non-leakage.

## State machine: `state.active` (the `ActiveLoopState`)

While a loop is running, `state.active` holds the canonical loop state. Field-by-field documentation lives in the JSDoc above `createRalphController` in `handler.mjs`. Notable fields:

- `i` / `max` / `min` — current iteration index, effective max, lower bound for honoring the completion / abort promises.
- `prompt` / `completionPromise` / `abortPromise` — the strings re-fed each iter and the substrings that terminate the loop.
- `prev` / `streak` / `stagnationLimit` — byte-identical-response detector that aborts a stuck loop.
- `pendingFire` / `fireInFlight` / `observedMessageThisFire` — per-iteration dispatch guards. The first idle (the one that *armed* the loop) consumes `pendingFire` to fire iter 1; the in-flight markers prevent stale-idle bloat from cancelled tool calls or sub-agents.
- `paused` / `pauseReason` / `pausedAt` / `totalPausedMs` — pause-state fields (issue [#3](https://github.com/kloba/copilot-ralph-extension/issues/3)). When `paused === true`, `onIdle` short-circuits before firing the next iteration so the user can chat freely without consuming iterations. `ralph_resume` re-arms by zeroing the streak detector (manual intervention almost always changes context) and folding `pausedFor` into `totalPausedMs` for accurate elapsed-time reporting in `ralph_status`.
- Adaptive-budget fields (issue [#4](https://github.com/kloba/copilot-ralph-extension/issues/4)): `adaptiveBudget`, `adaptiveExtension`, `adaptiveMaxTotal`, `originalMax`, `adaptiveContentHashes`, `adaptiveExtensionHistory`.

When the loop finishes, `state.active` becomes `null` and the immutable `state.lastResult` (a deep-frozen `RalphResult`) holds the post-mortem.

## Sub-agent event filtering

Copilot CLI's `task` / `explore` / `code-review` / `rubber-duck` agents share the same event bus as the root agent. Without filtering, a sub-agent's `session.idle` would queue an extra prompt fire, and a sub-agent's abort would tear down the root loop. `isSubAgentEvent(ev)` (in `handler.mjs`) returns `true` whenever `ev.agentId` is a non-empty string — root events have no `agentId`. **All loop-driving handlers must early-return on `isSubAgentEvent(ev)`.**

## The "baked prompt" pattern

`self_improve` and `grow_project` are convenience tools that wrap `armLoop()` with a **prompt baked in**: the user only supplies optional `focus` / `max_iterations` / `min_iterations`, and the tool builds a multi-paragraph SDLC or backlog-grooming prompt from a template constant (`PROMPT_SELF_IMPROVE`, `PROMPT_GROW_PROJECT`). The bake is opaque to `validateArgs` — we validate only what the user supplied, then construct the prompt and call `armLoop({ prompt: baked, ... })`.

The baked prompts include hard-coded `COMPLETE` / `ABORT_…` tokens and `min_iterations` defaults that defer honoring those tokens (otherwise the agent would emit `COMPLETE` on iter 1 by virtue of merely *describing* the protocol). When changing a baked prompt, run the existing prompt-shape tests (`PROMPT_SELF_IMPROVE: contains the protocol literal`, etc.) — they pin the user-visible contract.

## Tool surface

| Tool | Purpose | Key contract |
|---|---|---|
| `ralph_loop` | Generic re-fed-prompt loop | One loop at a time. Returns immediately after arming. Driven by `session.idle`. |
| `ralph_stop` | Cancel the active loop | Returns failure if no loop is active. Optional `reason` string is recorded as `note` on the result. |
| `ralph_status` | Live structured snapshot of the active loop | Issue [#5](https://github.com/kloba/copilot-ralph-extension/issues/5) — read-only; safe to call mid-loop. |
| `ralph_pause` | Pause the active loop without losing state | Issue [#3](https://github.com/kloba/copilot-ralph-extension/issues/3). Idempotent; `onIdle` short-circuits while `paused === true`. Returns failure if no loop is active. |
| `ralph_resume` | Resume a paused loop | Returns failure if no loop is active or the loop is not paused. Stagnation streak is reset on resume. |
| `self_improve` | Baked SDLC self-improvement prompt | Wraps `armLoop` with `PROMPT_SELF_IMPROVE`. Honors `focus` for narrowing scope. |
| `grow_project` | Baked backlog-grooming + execution loop | Wraps `armLoop` with `PROMPT_GROW_PROJECT`. Drives `gh` CLI calls. |

All tools share the `success(message, extra)` / `failure(message, extra)` envelope: `{ ...extra, textResultForLlm, resultType }` (extras cannot override `textResultForLlm` or `resultType`). The shape is pinned by tests so refactors can't accidentally leak internal scratch into the LLM-facing return.

## Completion-promise & abort-promise contracts

- **`completion_promise`** (default `"COMPLETE"`) — substring match against the latest assistant content. When seen on iter ≥ `min_iterations`, finishes the loop with `reason: "completion_promise"`.
- **`abort_promise`** (optional, no default) — same mechanism, but finishes with `reason: "abort_promise"`. Used by `grow_project` (`ABORT_NO_BACKLOG`) to bail when there's nothing to do.
- Both promises are **only honored once `i >= min_iterations`** to avoid premature termination from the agent merely describing the protocol on iter 1. Stagnation, max-iterations, and adaptive-budget terminators have their own thresholds and do not respect `min_iterations`.

## Adaptive iteration budget (issue [#4](https://github.com/kloba/copilot-ralph-extension/issues/4))

Opt-in. When the loop reaches `max_iterations`, `evaluateAdaptiveSignals(a, gitExec)` returns a non-null reason iff *either* `git diff --shortstat HEAD` or `git status --porcelain` reports working-tree changes, *or* the rolling 3-iteration content-hash window contains ≥ 2 distinct hashes. A positive signal grants `adaptive_extension` more iterations, capped at `adaptive_max_total`. Stagnation / completion / abort still win unconditionally because they're checked earlier in `onIdle`.

## Caffeinate integration (issue [#8](https://github.com/kloba/copilot-ralph-extension/issues/8))

Opt-in via `RALPH_CAFFEINATE=1`. On macOS, `armLoop` spawns `caffeinate -i [-d] -w <pid>` to inhibit display/system sleep for the duration of the loop. `finish()` (and every error path) kills the caffeinate process. Tests inject a `spawnFn` stub via `createRalphController({ caffeinate: { spawnFn } })`.

## Test architecture

- `node:test` runner; no third-party test deps.
- `makeFakeSession()` returns a `{ on, emit, send, log }` object that mimics the SDK's event bus.
- `runTurn(session, content)` drives one iteration: emits `assistant.message` then `session.idle`.
- DI on the controller (`createRalphController({ caffeinate, git, adaptive })`) lets tests stub external effects (process spawn, git exec) without monkey-patching.
- Several **shape-pin tests** lock down field counts and key sets on `state.active`, the success-envelope, the parsed-args object, and the tool-array order. These exist specifically to catch refactors that silently leak internal scratch into the LLM-facing surface.
