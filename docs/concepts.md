# Concepts

!!! note "Stub page (issue #2)"
    Scaffold only — to be expanded in follow-ups. See the [README](https://github.com/kloba/autopilot#readme) until this page is filled in.

Topics planned:

- The arming → subprocess-per-iter model used by `ralph-tui run`
- Completion / abort / stagnation finish reasons
- Pause / resume semantics
- Adaptive iteration budget

## Pause / resume semantics

`ralph-tui run --pause <runId>` and `ralph-tui run --resume <runId>` let you stop the next iteration from firing without losing the iteration counter or the captured Copilot session id (in `--continue` mode). The currently-running `copilot -p` subprocess is **never killed mid-iter** — the driver waits for it to finish naturally before honoring the pause flag at the next iter boundary.

State writes are CAS-protected via a per-run lockfile so a concurrent `--pause` + `--stop` from two terminals do not lose updates.

`--resume` flips `pauseRequested` back to `false`. `--stop` sets `stopRequested` and the driver emits a terminal `abort` event with `reason: "user_stopped"` after the in-flight iter exits.

## Completion / abort triggers

The driver scans each iter's response (root `assistant.message.data.content` — sub-agent content is filtered out) for two configurable substrings:

- **`--completion-promise`** (default `COMPLETE`) — terminates with `reason: "completion_promise"`.
- **`--abort-promise`** — terminates with `reason: "abort_promise"`. Defaults to the baked prompt's abort token in `--self-improve` mode (`ABORT_NO_IMPROVEMENTS`) and `--grow-project` mode (`ABORT_NO_BACKLOG`); no default in `--prompt` mode.

Both triggers are **only honored after `min_iterations`** to avoid premature termination from the agent merely describing the protocol on iter 1.

## Stagnation detection

The driver tracks the last few iter responses and aborts with `reason: "stagnation"` when N consecutive responses are byte-identical (default N=3; `--stagnation-limit 0` disables). Stagnation overrides `min_iterations` as a safety floor — a genuinely stuck loop should not run to `max_iterations` just because `min` hadn't been reached.

## Adaptive iteration budget

When `--self-improve` reaches `--max` and progress signals are positive (the working tree shows uncommitted changes, or the last few iters are not byte-identical), the runner grants `adaptive_extension` more iterations up to `adaptive_max_total` rather than aborting useful work. See [`packages/tui/src/runner.mjs`](../packages/tui/src/runner.mjs) for the signal evaluation and ceiling rules.
