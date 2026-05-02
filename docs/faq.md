# FAQ

Short answers to the questions that come up most often when running
Ralph in anger. Most of these point at a deeper section in the
[README](https://github.com/kloba/copilot-ralph-extension#readme) or
at [`docs/concepts.md`](concepts.md) — keep this page narrow and
link out rather than duplicating prose.

## Setup

### Why doesn't `/extensions` list `ralph` after install?

The Copilot CLI loads extensions at startup (and on `/extensions
reload`). Confirm every shipped `.mjs` is present in the install
target:

- User-scoped: `~/.copilot/extensions/ralph/` — visible from any cwd.
- Project-scoped: `<git-root>/.github/extensions/ralph/` — only
  visible when you launch Copilot CLI from inside that repo.

Currently shipped files are `extension.mjs`, `handler.mjs`, and
`events-emit.mjs`. A partial install crashes at module-load with
`Cannot find module './events-emit.mjs'`. Re-run `./install.sh`
from a fresh source checkout — it `node --check`s every file
before writing and verifies each post-copy file is byte-identical
to the source via `cmp -s`.

### How do I install a specific tagged release?

See README → [Option D — Pin a specific tagged
release](https://github.com/kloba/copilot-ralph-extension#option-d--pin-a-specific-tagged-release).
Tags are immutable; release tarballs are SHA-pinned by GitHub,
so a pinned install never silently shifts under you.

### Do I need any npm dependencies?

No. The extension is zero-dep at runtime — only the Copilot CLI's
bundled Node runtime is required. The test suite uses `node:test`
(built-in) and runs with `npm test`. Node ≥ 20 is required for the
test suite; the installed extension itself runs on whichever Node
version Copilot CLI ships with.

## Running a loop

### Why does arming fail with `<owner> is already armed/running/paused`?

Only one loop runs per session at a time. The leading word of the
refusal — `ralph_loop`, `self_improve`, or `grow_project` — names
whichever tool armed the *currently active* loop. Call `ralph_stop`
first, then arm the new one.

If the active loop is paused you'll see `is already paused
(iteration N/M) — call ralph_stop first.` Despite the wording,
`ralph_resume` is also valid if you wanted the original loop to
continue rather than be cleared.

### Why did my loop stop after exactly one iteration?

The most common cause is an early `completion_promise` match. Both
`completion_promise` and `abort_promise` use plain substring matching
against the assistant's accumulated turn output — if the agent quotes
the trigger phrase mid-thought (e.g. *"I'll mark this COMPLETE when
done"*), the loop finishes. Pick a phrase the agent is unlikely to
mention casually; `RALPH_DONE_42` and similar unusual tokens work
well. See README → [Limitations](https://github.com/kloba/copilot-ralph-extension#limitations).

### Why does my loop never finish?

Three frequent causes:

1. The prompt doesn't actually instruct the agent to emit the
   `completion_promise` literally. With a quoted/paraphrased
   completion phrase, only `max_iterations` (or `max_tokens`,
   `stagnation_limit`, `ralph_stop`) ends the loop.
2. Stagnation guard is disabled (`stagnation_limit: 0`) and the
   agent oscillates indefinitely. Re-enable with the default
   `stagnation_limit: 3` or higher.
3. `min_iterations` is high and the agent emits the completion
   promise too early — the runtime ignores the promise until
   `min_iterations` is reached. This is by design.

### How do I stop a loop that's running away?

Call `ralph_stop` — it returns immediately with the iteration count
at the moment of the call. The currently-running iteration finishes
normally; the loop simply doesn't fire on the next `session.idle`.
You can pass an optional `reason` string that gets recorded on the
result for later forensics.

### Pause and resume — what's the difference vs stop?

- `ralph_stop` clears the active loop. The iteration counter is
  gone afterwards.
- `ralph_pause` keeps the loop alive but skips subsequent
  `session.idle` triggers. You can chat freely with the agent
  without consuming iterations.
- `ralph_resume` un-pauses. The iteration counter resumes where
  it left off; the stagnation streak is reset (manual chat
  almost always changes context).

`ralph_pause` is idempotent (pausing an already-paused loop is a
no-op). `ralph_resume` is **not** idempotent — calling it without
a paused loop returns a failure. See [`docs/concepts.md` → Pause /
resume semantics](concepts.md#pause--resume-semantics) for the full
state-machine writeup.

## Output and observability

### Where does a running loop's event log live?

By default: `~/.copilot/ralph/runs/<runId>/events.jsonl`. Override
the runs root with the `RALPH_EVENTS_DIR` environment variable. The
`<runId>` shape is `${label}-${startedAt}` — sortable,
filesystem-safe, and surfaced in the `armed` event so the TUI can
locate it.

### How do I tail a running loop's events?

Use the bundled TUI: `npx ralph-tui watch <runId>` to follow events
live, or `ralph-tui list` to see runs the index knows about. See
README → [Inspecting a running loop](https://github.com/kloba/copilot-ralph-extension#inspecting-a-running-loop-ralph_status-tool)
for the snapshot tool that returns a structured live snapshot
without leaving the chat.

### Why is `pausedForMs` zero on a `resume` event?

A resume reports `pausedForMs = max(0, now - pausedAt)`, where
`pausedAt` is the wall-clock millisecond timestamp captured by the
last `ralph_pause`. Two cases produce a zero:

- **Same-millisecond resume.** If you fire `ralph_resume` in the
  same millisecond as the pause (vanishingly rare in practice, but
  easy to hit in fast tests), `now - pausedAt` rounds to `0`.
- **Backward clock skew.** If the system clock moves backward
  during the pause window (NTP correction, manual clock change,
  daylight savings on a host without monotonic-time backing),
  `now - pausedAt` would compute negative — the runtime clamps it
  to `0` rather than crediting a negative duration to
  `total_paused_ms`. Without the clamp, the run's reported
  `durationMs` would be inflated past the true wall-clock elapsed
  time. The same `Math.max(0, …)` guard runs in `finish()` and
  `ralph_status.paused_for_ms` for symmetry; all three call sites
  share a single helper so the contract cannot drift.

The `total_paused_ms` accumulated across multiple pause/resume
cycles is what gets deducted from the final `durationMs`.

## Commit attribution

### How are loop-driven commits attributed?

Every commit produced inside a loop carries two `Co-authored-by:`
trailers — one for the `Copilot` GitHub identity, one for the
dedicated `copilot-ralph` bot account. The dual-trailer convention
is baked into the SDLC prompts (`self_improve`, `grow_project`)
and appended as a rider to the user-supplied prompt for
`ralph_loop`. See README → [Commit attribution](https://github.com/kloba/copilot-ralph-extension#commit-attribution).

### How do I opt out of the second `copilot-ralph` trailer?

Set `RALPH_NO_ATTRIBUTION=1` in the environment before arming the
loop. The opt-out suppresses **only** the second
`copilot-ralph` trailer; the first `Copilot` trailer always ships.
Note that the opt-out is honored by the prompt, not enforced by
the runtime — if a sub-agent ignores `process.env` (or can't read
it), the trailer can still appear. Audit afterwards with
`git log -1 --pretty=%B` to confirm.

## Anything else?

If your question isn't answered here, open an issue or skim the
[README](https://github.com/kloba/copilot-ralph-extension#readme)
Troubleshooting and Limitations sections — they cover the
long-tail edge cases this page intentionally elides.
