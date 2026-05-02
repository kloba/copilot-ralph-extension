# Architecture

This document is for contributors and future-self maintenance. End-user docs live in the [README](../README.md). For local-dev setup see [CONTRIBUTING.md](CONTRIBUTING.md).

## What ships

The project ships a single artifact: the `autopilot` CLI. It drives autonomous Copilot CLI loops by spawning each iteration as a fresh `copilot -p ...` subprocess, parses the JSONL stdout for terminal markers, and tails a per-run `events.jsonl` event stream so a separate terminal can `autopilot watch` the live timeline.

The previous in-session Copilot CLI extension (`ralph_loop` / `self_improve` / `grow_project` / `ralph_status` / `ralph_pause` / `ralph_resume` / `ralph_stop` tools) was retired — see [`CHANGELOG.md`](../CHANGELOG.md). All forward work lives in `packages/tui/`.

## Source layout

```
packages/tui/
├── bin/tui.mjs        # CLI entry — argv parser + dispatcher
├── src/
│   ├── prompts.mjs    # Baked SDLC prompts (PROMPT_SELF_IMPROVE, PROMPT_GROW_PROJECT)
│   ├── runner.mjs     # `autopilot run` driver — spawns each iter, tracks state.json
│   ├── events.mjs     # Pure event contract (read side)
│   ├── events-emit.mjs # Zero-dep JSONL emitter (write side)
│   ├── writer.mjs     # JSONL reader + index aggregator (`list`/`stats`/`prune`)
│   ├── tail.mjs       # Live tail iterator for `watch`
│   ├── plain.mjs      # Plain-mode log line formatter
│   ├── watch.mjs      # Watch dispatcher (TTY → Ink, non-TTY → plain)
│   ├── run-ui.mjs     # Ink renderer for `run`'s live UI
│   └── components/    # Ink layout components (Header, Timeline, DetailPane, …)
├── test/              # node:test suite
└── package.json       # Ink/React/Yoga deps for the renderer
scripts/
├── check.mjs          # Portable equivalent of CI's syntax-check job
└── ralph-tui-fresh.sh # Optional `git pull --ff-only` wrapper for long runs
```

## `autopilot run` — the driver

[`runner.mjs`](../packages/tui/src/runner.mjs) is the heart of the project. Each iteration is a fresh subprocess:

```
copilot -p "<baked or user prompt>" --allow-all-tools --output-format json [--resume <sessionId>]
```

The driver parses JSONL stdout for two markers:

- Root `assistant.message.data.content` (no `agentId`) — the iter's user-visible response. Scanned for the configured `completion_promise` / `abort_promise` substring.
- Terminal `result` event with `result.sessionId` — captured at iter 1 and reused via `--resume=<sessionId>` on iter 2+ when the driver is in `--continue` mode.

### Context modes

- **`--continue`** — resume the same Copilot session every iter. The Copilot CLI itself manages the conversation history; the driver only forwards `--resume=<sessionId>`. Closer to the in-session shape that the retired extension provided.
- **`--fresh`** — brand-new Copilot session every iter. Each iteration sees only the prompt + tool results, with no history from prior iters. Better for long backlog-drain loops where context rot would otherwise dominate late iterations.

### State machine — `state.json`

Each run owns a directory at `<runs-root>/<runId>/` containing `events.jsonl`, optional `index.jsonl` (for the runs-root index), and `state.json`. The state file holds:

- `runId`, `label`, `mode`, `contextMode`, `startedAt`.
- `iter` — current iteration number.
- `pauseRequested`, `stopRequested` — out-of-band flags flipped by sibling `--pause` / `--stop` invocations.
- `sessionId` — captured on iter 1 in `--continue` mode.

State writes are CAS-protected via a per-state-file lockfile (`acquireLock` / `releaseLock` in `runner.mjs`) so concurrent `--pause` + `--stop` from two terminals do not lose updates.

## JSONL event contract

The runner emits one JSON object per line via [`events-emit.mjs`](../packages/tui/src/events-emit.mjs):

| Type | Emitted when |
| ---- | ------------ |
| `armed` | Once per run, on driver start. Also written to `<runs-root>/index.jsonl` so `autopilot list` / `stats` can enumerate without scanning every per-run dir. |
| `iteration_start` | Before spawning the next `copilot -p` subprocess. |
| `iteration_end` | After the subprocess exits; carries the iter's response excerpt and tokens (when usage events were observed). |
| `pause` / `resume` | Honored at the next iter boundary after the corresponding flag flip. |
| `stagnation` | Emitted when the byte-identical-response detector fires. |
| `complete` | Terminal — completion-promise observed. |
| `abort` | Terminal — abort-promise / max iterations / stagnation / send error / user stop. |

Reader-side helpers live in [`events.mjs`](../packages/tui/src/events.mjs) (`parseEventLine`, `serializeEvent`, `safeSliceChars`, `foldEvents`) and [`writer.mjs`](../packages/tui/src/writer.mjs) (`readRunIndex`, `aggregateRuns`, `pruneRuns`, the `resolveRunsRoot` helper).

The emitter swallows every error so a disk hiccup never crashes the loop. The reader is tolerant of malformed lines for the same reason — a torn write must not break `replay`.

## The "baked prompt" pattern

`--self-improve` and `--grow-project` are convenience wrappers that drive `runner.mjs`'s loop with a prompt baked in: the user only supplies optional `--focus` / `--max`, and the runner builds a multi-paragraph SDLC or backlog-grooming prompt from a template constant (`PROMPT_SELF_IMPROVE`, `PROMPT_GROW_PROJECT` in [`prompts.mjs`](../packages/tui/src/prompts.mjs)).

The baked prompts include hard-coded `COMPLETE` / `ABORT_…` tokens. A load-time parity guard at the bottom of `prompts.mjs` throws if the prompt body stops emitting either token; the runner refuses to start rather than silently ship a broken prompt.

## Completion-promise & abort-promise contracts

- **`--completion-promise`** (default `"COMPLETE"`) — substring match against the iter's response. Triggers a terminal `complete` event with `reason: "completion_promise"`.
- **`--abort-promise`** (optional; defaults to the baked prompt's abort token in `--self-improve` / `--grow-project` modes; no default in `--prompt` mode) — same mechanism, but emits an `abort` event with `reason: "abort_promise"`.
- Both are **only honored after `min_iterations`** (currently a per-mode default; `--prompt` mode honors immediately) to avoid premature termination from the agent merely describing the protocol on iter 1.

## Pause / resume / stop / status

Out-of-band flags written to the run's `state.json`:

```bash
autopilot run --pause   <runId>     # set pauseRequested=true
autopilot run --resume  <runId>     # clear pauseRequested
autopilot run --stop    <runId>     # set stopRequested=true
autopilot run --status  <runId>     # read state.json + render
```

The driver re-reads `state.json` at every iter boundary; the in-flight Copilot child is **never killed mid-iter** — the driver waits for natural exit before honoring pause/stop. `SIGINT` / `SIGTERM` at the driver process maps onto `--stop` via the same lock-protected CAS path.

## Test architecture

- `node:test` runner; no third-party test deps.
- The runner suite in `packages/tui/test/runner.test.mjs` drives end-to-end loops through a Node-script "fake copilot" shim that emits scripted JSONL on stdout. The shim is parameterised by a `SCRIPT` env var (path to a JSON file describing the iter's output) so a single binary covers every test scenario.
- Pure helpers (`validateFocus`, `composePrompt`, `reduceCopilotEvents`, `resolveStateRoot`, `readState`, …) get straightforward unit tests.
- The reader-side tests (`writer.test.mjs`, `events.test.mjs`, `tail.test.mjs`) sandbox into `mkdtempSync`-allocated dirs and pin the JSONL contract.

## Why we removed the in-session extension

The original project began as an in-session Copilot CLI extension that exposed `ralph_loop` / `self_improve` / `grow_project` tools to the active Copilot session via the `@github/copilot-sdk/extension` SDK's `joinSession` + `session.idle` event contract. The TUI driver (`autopilot run`) eventually grew to cover every feature of the in-session tools — same baked prompts, same pause/resume/stop/status, same adaptive budget — without imposing the SDK contract on every cross-cutting change.

Maintaining both engines required keeping every prompt change, every event-vocabulary entry, and every adaptive-budget tweak in lockstep across two implementations. Deleting the in-session engine retired that whole drift surface. See issue #50 for the full rationale.
