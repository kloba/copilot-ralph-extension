# Concepts

!!! note "Stub page (issue #2)"
    Scaffold only — to be expanded in follow-ups. See the [README](https://github.com/kloba/copilot-ralph-extension#readme) until this page is filled in.

Topics planned:

- The arming → idle-driven iteration model
- Completion / abort / stagnation finish reasons
- Sub-agent isolation
- Token tracking and context-window warnings
- Pause / resume semantics
- Adaptive iteration budget

## Pause / resume semantics

`ralph_pause` and `ralph_resume` let you stop the next iteration from
firing without losing the iteration counter, the conversation context,
or the arm-time git snapshot. The iteration in flight at the moment
you call `ralph_pause` is not interrupted — it runs to completion and
emits its `iteration_end` event. Pause only takes effect on the
**next** `session.idle`: the on-idle handler short-circuits when
`active.paused` is `true`, and the iteration counter stays at the
value it reached.

While paused, you may chat freely with the agent. Those turns are
real conversation turns, but they do **not** consume iterations and
they do **not** count toward the stagnation streak (see below).

`ralph_pause` is idempotent: calling it on an already-paused loop is
a no-op and returns success. The two failure modes are:

1. No loop is currently active (`{ active: false }`).
2. The `reason` argument exceeds 500 chars (validation rejection).

`ralph_resume` flips `paused` back to `false` and **resets the
stagnation streak** (`streak = 0`, `prev = null`). The comment in the
code spells out why: *"manual intervention almost always changes
context"*. Without this reset, a paused → user-tweaks-source →
resumed loop would carry a stale `prev` response and a non-zero
`streak`, so the very next iteration could trip the stagnation guard
even though the conversation context has changed substantially.

`ralph_resume` returns failure if the loop is **not** currently
paused — the error message is
`ralph_resume: <label> is not paused. Use ralph_pause first, or
ralph_stop to cancel.` So unlike `ralph_pause`, `ralph_resume` is
**not** idempotent.

Pause time is tracked in two places visible via `ralph_status`:

- `paused_for_ms` — the duration of the **current** pause (zero when
  the loop is not paused).
- `total_paused_ms` — cumulative pause time across **all** prior
  pause/resume cycles in this run.

`total_paused_ms` is deducted from `durationMs` so the wall-clock
elapsed time reported by the loop reflects active execution time
only, not any time the user spent inspecting state with the loop
paused.

In summary, the contract is:

| Operation         | When it succeeds                       | What it does                                                                |
| ----------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `ralph_pause`     | Loop active (paused or unpaused)       | Sets `paused = true`. Currently-running iteration finishes normally.        |
| `ralph_resume`    | Loop active **and** paused             | Clears `paused`, resets `streak`/`prev`, adds elapsed pause to `total_paused_ms`. |
| `ralph_stop`      | Loop active (paused or unpaused)       | Cancels the loop entirely. Pausing first is not required.                   |

