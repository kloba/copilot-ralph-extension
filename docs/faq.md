# FAQ

Short answers to the questions that come up most often when running Ralph in anger. Most of these point at a deeper section in the [README](https://github.com/kloba/copilot-ralph-extension#readme) or at [`docs/concepts.md`](concepts.md) — keep this page narrow and link out rather than duplicating prose.

## Setup

### Do I need any npm dependencies?

Not for plain mode. The non-render layer (`prompts.mjs`, `runner.mjs`, `events*.mjs`, `writer.mjs`, `tail.mjs`, `plain.mjs`, `bin/tui.mjs`) is zero-dep — only Node ≥ 20 is required. The interactive Ink-rendered `watch` / `run` UI pulls Ink + React + Yoga + Commander via `cd packages/tui && npm install`.

### How do I install a specific tagged release?

Check out the matching tag in your clone:

```bash
git checkout vX.Y.Z
node packages/tui/bin/tui.mjs --help
```

Tags are immutable, so a pinned checkout never silently shifts. A future release will publish `ralph-tui` to npm so `npm i -g ralph-tui@X.Y.Z` works.

### What happened to the `~/.copilot/extensions/ralph` install?

The previous in-session Copilot CLI extension was retired — see [`CHANGELOG.md`](../CHANGELOG.md). If you still have `~/.copilot/extensions/ralph` from an older install, `rm -rf ~/.copilot/extensions/ralph` and switch to `ralph-tui run` as documented in the [README](../README.md#usage).

## Running a loop

### Why did my loop stop after exactly one iteration?

The most common cause is an early `--completion-promise` match. Both `--completion-promise` and `--abort-promise` use plain substring matching against the assistant's response — if the agent quotes the trigger phrase mid-thought (e.g. *"I'll mark this COMPLETE when done"*), the loop finishes. Pick a phrase the agent is unlikely to mention casually; `RALPH_DONE_42` and similar unusual tokens work well. See README → [Limitations](https://github.com/kloba/copilot-ralph-extension#limitations).

### Why does my loop never finish?

Three frequent causes:

1. The prompt doesn't actually instruct the agent to emit the `--completion-promise` literally. With a quoted/paraphrased completion phrase, only `--max` (or `--stagnation-limit`, `--stop`) ends the loop.
2. Stagnation guard is disabled (`--stagnation-limit 0`) and the agent oscillates indefinitely. Re-enable with the default `--stagnation-limit 3` or higher.
3. `min_iterations` is high and the agent emits the completion promise too early — the runtime ignores the promise until `min_iterations` is reached. This is by design.

### How do I stop a loop that's running away?

Run `ralph-tui run --stop <runId>` from another terminal — it sets `stopRequested` in `state.json`. The currently-running iteration finishes normally; the driver emits a terminal `abort` event with `reason: "user_stopped"` afterwards. `SIGINT` / `SIGTERM` at the driver process flips the same flag.

### Pause / resume — what's the difference vs stop?

- `--stop` clears the active loop after the in-flight iter finishes.
- `--pause` keeps the loop alive but skips subsequent iter triggers. The driver re-reads `state.json` at every iter boundary.
- `--resume` un-pauses. The iteration counter resumes where it left off; the stagnation streak is reset.

See [`docs/concepts.md` → Pause / resume semantics](concepts.md#pause--resume-semantics) for the state-machine writeup.

## Output and observability

### Where does a running loop's event log live?

By default: `~/.copilot/ralph-tui/runs/<runId>/events.jsonl`. Override the runs root with `RALPH_TUI_RUNS_DIR`. The `<runId>` shape is `${label}-${startedAt}` — sortable, filesystem-safe, and surfaced in the `armed` event.

### How do I tail a running loop's events?

```bash
ralph-tui watch              # tail the most recent run
ralph-tui watch <runId>      # tail a specific run
ralph-tui list               # enumerate recorded runs newest-first
ralph-tui replay <runId>     # print every event in a past run
```

### How do I get a structured snapshot of a live run?

```bash
ralph-tui run --status <runId>
```

Reads the run's `state.json` and renders iter counter, pause/stop flags, and (in `--continue` mode) the captured Copilot session id.

## Commit attribution

### How are loop-driven commits attributed?

Every commit produced inside a loop carries two `Co-authored-by:` trailers — one for the `Copilot` GitHub identity, one for the dedicated `copilot-ralph` bot account. The dual-trailer convention is baked into the SDLC prompts (`--self-improve`, `--grow-project`). See README → [Commit attribution](https://github.com/kloba/copilot-ralph-extension#commit-attribution).

### How do I opt out of the second `copilot-ralph` trailer?

Set `RALPH_NO_ATTRIBUTION=1` in the environment before running the loop. The opt-out suppresses **only** the second `copilot-ralph` trailer; the first `Copilot` trailer always ships. Note that the opt-out is honored by the prompt, not enforced by the runtime — if a sub-agent ignores `process.env`, the trailer can still appear. Audit afterwards with `git log -1 --pretty=%B` to confirm.

## Anything else?

If your question isn't answered here, open an issue or skim the [README](https://github.com/kloba/copilot-ralph-extension#readme) Limitations section — it covers the long-tail edge cases this page intentionally elides.
