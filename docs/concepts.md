# Concepts

!!! note "Stub page (issue #2)"
    Scaffold only — to be expanded in follow-ups. See the [README](https://github.com/kloba/copilot-ralph-extension#readme) until this page is filled in.

Topics planned:

- The arming → idle-driven iteration model
- Completion / abort / stagnation finish reasons
- Sub-agent isolation
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
they do **not** count toward the stagnation streak (see below). The
loop also **isolates** its bookkeeping from the pause-time chat:

- **Token budget isolation.** `assistant.message` events that arrive
  while paused are not credited to `tokens.input` / `tokens.output` /
  `byIteration` / `byModel`. A long pause-time conversation cannot
  push the loop's cumulative usage past a configured `max_tokens`
  cap (so the loop will not finish with `reason="max_tokens"` on the
  first post-resume idle as a side-effect of you reading a diff with
  the agent), and it cannot trip the `warn_at_pct` context-window
  threshold either.
- **Completion / abort isolation.** Pause-time chat content does not
  accumulate into the rolling buffer that `onIdle` inspects for the
  configured `completion_promise` / `abort_promise` substrings. A
  casual mention of the trigger phrase in your pause-time chat — e.g.
  *"I'll mark this COMPLETE when the refactor lands"* — will **not**
  terminate the loop. Trade-off: a genuine completion / abort signal
  that landed in the in-flight iteration's response right before you
  paused is forfeited; you can still read it via
  `ralph_status.last_response_excerpt` and `ralph_stop` the loop
  explicitly if you want to honor it.

`ralph_pause` is idempotent: calling it on an already-paused loop is
a no-op and returns success. The two failure modes are:

1. No loop is currently active (`{ active: false }`).
2. The `reason` argument exceeds 500 chars (validation rejection).

`ralph_resume` flips `paused` back to `false` and resets three
pieces of state that would otherwise leak pause-time context into
the next iteration's evaluation:

- The **stagnation streak** (`streak = 0`, `prev = null`). The
  comment in the code spells out why: *"manual intervention almost
  always changes context"*. Without this reset, a paused →
  user-tweaks-source → resumed loop would carry a stale `prev`
  response and a non-zero `streak`, so the very next iteration
  could trip the stagnation guard even though the conversation
  context has changed substantially.
- The **last-assistant-content buffer** (`state.lastAssistantContent
  = ""`). Even though `ralph_pause` itself stops new pause-time
  content from being appended (see "Completion / abort isolation"
  above), the in-flight iteration's response that arrived **before**
  the pause is still sitting in that buffer at resume time. Clearing
  it on resume guarantees the post-resume idle evaluates an empty
  string for completion / abort triggers — same defense-in-depth
  reasoning as the streak reset.

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
| `ralph_pause`     | Loop active (paused or unpaused)       | Sets `paused = true`. Currently-running iteration finishes normally. Pause-time `assistant.message` events are not credited to the loop's token budget and do not accumulate into the completion/abort buffer. |
| `ralph_resume`    | Loop active **and** paused             | Clears `paused`, resets `streak` / `prev` / `lastAssistantContent`, adds elapsed pause to `total_paused_ms`. |
| `ralph_stop`      | Loop active (paused or unpaused)       | Cancels the loop entirely. Pausing first is not required.                   |


## Token tracking and context-window warnings

The loop credits cumulative input and output tokens from every
`assistant.message` event observed during an iteration, so you can
both cap a long-running run with `max_tokens` and watch the context
window pressure climb in real time.

### What you observe

- **Live cumulative totals** — `ralph_status.tokens` (added in
  issue [#7](https://github.com/kloba/copilot-ralph-extension/issues/7))
  exposes `{ input, output, total, max_tokens }` on the active
  snapshot. Counts start at zero and grow with every credited
  iteration. `max_tokens` echoes the configured cap, or is `null`
  when no cap was armed.
- **Post-finish summary** — `ralph_status.last.tokens` mirrors the
  same `{ input, output, total }` shape on the prior-run summary so
  a post-mortem `ralph_status` call after the loop exits still sees
  how many tokens the run consumed. Omitted entirely when the run
  credited zero tokens.
- **Per-iteration breakdown** — the deep-frozen
  `result.tokens.byIteration` and `result.tokens.byModel` (returned
  on the loop's terminal value, not on the live snapshot) carry
  per-iter and per-model rollups for callers that want detail. They
  are intentionally **not** mirrored on `ralph_status` to keep that
  payload cheap to serialise.

### Two safety contracts

The loop makes two promises about what it credits:

1. **Negative / NaN / Infinity / zero-zero rejection.**
   `extractUsage` discards any `assistant.message` whose
   `usage.input_tokens` or `usage.output_tokens` is negative, NaN,
   Infinity, or non-numeric. It also discards a `{input: 0,
   output: 0}` pair — a zero/zero event carries no information and
   would pollute the per-iteration breakdown with empty rows. The
   contract is therefore: both peers finite and `>= 0`, and at
   least one of them strictly positive. A flaky upstream usage
   payload cannot push `tokens.input` below zero (which would
   silently mask a `max_tokens` cap by inflating remaining budget)
   or generate an `Infinity` total that breaks the context-window
   threshold maths.
2. **Pause-time isolation.** While the loop is paused, no
   `assistant.message` is credited to the running totals, no
   per-iteration entry is appended, and no context-window warning
   threshold is evaluated. See the [Pause / resume semantics
   section](#pause--resume-semantics) above for the full isolation
   contract.

### Context-window warnings

When the cumulative input pressure for the **current model** crosses
`warn_at_pct` (default 80%) of that model's known total context
window, the loop logs a one-time WARN. A second hard-coded warning
fires at 95%. Each threshold fires at most once per loop run so a
loop sitting at 81% does not spam the log on every iteration.
Unknown models log a one-time INFO so the maintainer notices the
gap without losing iteration progress.

For the engineering-level walkthrough — how `extractUsage` and
`creditUsage` thread together, where the rollups live, and which
exact lines enforce the two contracts — see the
[Token tracking section in `docs/ARCHITECTURE.md`](ARCHITECTURE.md).


## `ralph_status` one-line summary

Every `ralph_status` invocation returns a structured snapshot **plus**
a single-line `textResultForLlm` summary so a model that reads only
the prose result still sees the loop's pulse. The shape is fixed and
intended to be parsed (or grepped) by tooling.

### Active loop

```
{label}: iteration {N}/{M}, elapsed {ms}ms[, tokens {X}/{Y}][ (PAUSED — {reason}, for {ms}ms)]
```

Slot-by-slot:

- `{label}` — the loop's display name (`ralph_loop`,
  `self_improve`, or `grow_project`).
- `iteration {N}/{M}` — current iteration count vs. the configured
  `max_iterations`. `N` is the number of completed iterations, so
  `0/{M}` means the loop is armed but no iteration has fired yet.
- `elapsed {ms}ms` — milliseconds since arm-time, rounded down.
  Pause time is **included** here (wall-clock); subtract
  `paused_for_ms` from the structured snapshot if you need
  active-only time.
- `, tokens {X}/{Y}` — appears **only when** `max_tokens` was armed
  (issue [#7](https://github.com/kloba/copilot-ralph-extension/issues/7)).
  `X` is the cumulative input+output total credited so far; `Y` is
  the configured cap. Loops without a cap omit this segment so
  consumers do not see a misleading `tokens X/null`.
- ` (PAUSED — {reason}, for {ms}ms)` — appears only when the loop
  is currently paused. The em-dash + reason are omitted when no
  reason was provided, leaving ` (PAUSED, for {ms}ms)`.

### Inactive — prior run summary

```
no active loop; last {label} {reason} after {N} iterations
```

`{reason}` is one of the canonical finish reasons (`completion_promise`,
`max_iterations`, `abort_promise`, `aborted`, `stagnation`,
`max_tokens`, `send_error`, `user_stopped`, `detached`).

### Inactive — first call in a fresh session

```
no active loop and no prior run in this session
```

This is the only case where `ralph_status` returns neither an
active snapshot nor a `last` block. It is safe to call from any
session, including before any loop has been armed.
