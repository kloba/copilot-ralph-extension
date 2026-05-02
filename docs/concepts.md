# Concepts

This page covers the runtime model `autopilot` uses to drive a loop, the JSONL event vocabulary it emits, and the per-run state file. The later sections (pause / resume, completion / abort triggers, stagnation, adaptive iteration budget) document the protocol contracts the agent and the driver share.

## How autopilot models a loop

`autopilot run` is an **arming → subprocess-per-iter** driver. The driver process itself is small and largely stateless: every meaningful piece of run state lives on disk, in two files per run (`state.json` and `events.jsonl`).

The full lifecycle of a single run is:

1. **Arm.** Resolve flags, compute the runId, write the seed `state.json`, emit `armed`, mount the TUI.
2. **Spawn iter N.** Read `state.json`, honor pause/stop, emit `iteration_start`, fork `copilot -p`.
3. **Stream the iter.** Reduce stdout JSONL into the in-process iter reducer; re-emit structured agent markers as typed events.
4. **Close iter N.** Subprocess exits; the driver folds the reducer's output into an `iteration_end` event, evaluates completion / abort / stagnation triggers, and either continues to iter N+1 or terminates.
5. **Terminate.** Emit either `complete` or `abort` with a structured `reason`, set `terminated = true` on `state.json`, return.

### Arming

When you invoke `autopilot run` (e.g. `autopilot run --self-improve --fresh` or just bare `autopilot`, which expands to `--self-improve --fresh`), the driver:

1. Computes a stable `runId` (`<label>-<startedAtEpochMs>`) and creates the per-run directory at `<runs-root>/<runId>/`.
2. Writes the initial `state.json` (iter counter at 0, `paused` and `stopRequested` both false, no captured `sessionId` yet).
3. Emits the `armed` event to `events.jsonl` and appends a row to `<runs-root>/index.jsonl` so `autopilot list` / `autopilot stats` can enumerate the run without scanning every per-run dir.
4. Mounts the TUI (or skips it under `--plain`).

The runs root resolves from `$AUTOPILOT_RUNS_DIR`, falling back to the legacy `$RALPH_TUI_RUNS_DIR`, falling back to `~/.copilot/autopilot/runs`. The Copilot CLI binary resolves from `$AUTOPILOT_COPILOT_BIN`, falling back to legacy `$RALPH_TUI_COPILOT_BIN`, falling back to `copilot` on `$PATH`.

### Subprocess-per-iter

Once armed, the driver enters a `for iter in 1..max` loop. **Each iteration spawns a fresh `copilot -p "..." --allow-all-tools ...` subprocess** and pipes its stdout JSONL into the driver. The driver:

- Re-reads `state.json` at every iter boundary to honor `paused` / `stopRequested` flips.
- Streams the iter's stdout JSONL into a small reducer that captures the root assistant's content, the terminal `result.sessionId`, and per-message token / premium-request deltas.
- Re-emits structured agent markers (stage starts, task starts/ends, commit observations) as events on `events.jsonl` so the TUI and any replay tool can reconstruct the run end-to-end without re-running anything.
- Waits for the subprocess to exit naturally — the in-flight Copilot child is **never killed mid-iter**.

Whatever the iter's response was, it is stored verbatim in the iter's `iteration_end` event excerpt (truncated to 500 surrogate-safe characters). The full session JSONL stays in Copilot CLI's own log at `~/.copilot/session-state/<sessionId>.jsonl`; once the driver captures the sessionId it emits a `session_attached` event so the TUI can mount a tail against that file for the live-output panel.

### Why subprocess-per-iter

This shape buys two properties the driver depends on:

- **Hermeticity per iteration.** Context modes are simple flags fed to the next subprocess: `--continue` reuses the captured `result.sessionId` from iter 1 (passed to Copilot as `--resume <sessionId>`), and `--fresh` starts a brand-new session every iter. A crash, hang, or OOM in one iter doesn't poison subsequent iters — the driver just spawns a new subprocess for iter N+1.
- **Statelessness in the driver.** The driver itself holds nothing across iters except `state.json` and the `events.jsonl` log. Restarting or re-attaching from another terminal is trivial: read `state.json`, replay `events.jsonl`, render.

### Markers the driver scans for

In each iter's stdout JSONL the driver looks for two things:

- The **root assistant's `assistant.message.data.content`** — sub-agent content (Copilot CLI subagents) is filtered out — for the configured completion / abort substrings, and for the byte-identical-response stagnation detector. Subagent filtering matters: an SDLC-style baked prompt can spawn a critique subagent that legitimately quotes the literal completion token while reasoning about it, and the driver must not terminate on that quote.
- The **terminal `result` event with `result.sessionId`** — captured at iter 1 in `--continue` mode and reused as `--resume <sessionId>` for iter 2+. In `--fresh` mode the sessionId is captured but discarded (each iter starts a new session).

Beyond those two, the parser also surfaces structured `[STAGE: …]` / `[STAGE_PLAN: …]` / `[TASK_START: …]` / `[TASK_END: …]` markers the agent emits inline in its response, plus `git commit` substages observed via tool-call results. Each of those is re-emitted as a typed event on `events.jsonl` so a replayer never has to re-parse the agent's prose.

## Event vocabulary

The driver writes one JSON object per line to `<runs-root>/<runId>/events.jsonl`. The schema, the serializer, and the read-side `parseEventLine` / `foldEvents` helpers all live in [`packages/tui/src/events.mjs`](https://github.com/kloba/autopilot/blob/main/packages/tui/src/events.mjs). Every event has at minimum a `type`, a `ts` (epoch milliseconds), and the run's stable `runId`.

### `armed`

Emitted once, before iter 1, when the driver has finished arming the run. Also written to `<runs-root>/index.jsonl` so list / stats commands can enumerate runs cheaply. The `label` (`self_improve` / `grow_project` / `ralph_loop`) determines which baked prompt and SDLC stage list applies.

```json
{"type":"armed","ts":1714600000000,"runId":"self_improve-1714600000000","label":"self_improve","maxIterations":50,"minIterations":1}
```

### `iteration_start`

Emitted just before the driver spawns the iter's `copilot -p` subprocess. Carries the 1-indexed iter counter. The matching `iteration_end` is what closes the iter; an `iteration_start` without a paired `iteration_end` indicates an interrupted run (driver crashed mid-iter or external SIGKILL).

```json
{"type":"iteration_start","ts":1714600005000,"runId":"self_improve-1714600000000","iteration":1}
```

### `task` / `stage_plan` / `commit_observed`

Mid-iter progress markers. The agent emits structured `[STAGE: …]` / `[TASK_START: …]` / `[STAGE_PLAN: …]` markers in its assistant content; the driver's parser re-emits each as a typed event so the TUI can render the live three-level hierarchy (work item → stage → task) and the LastCommit footer without re-deriving anything. `commit_observed` events are sourced from the runner's `git commit` substage detector rather than from agent prose, so a run that `git reset`s after the fact still has accurate commit history in `events.jsonl`.

```json
{"type":"stage_plan","ts":1714600006500,"runId":"self_improve-1714600000000","iteration":1,"stages":["ORIENT","IDEATE","CRITIQUE","BASELINE","IMPLEMENT","TEST","COMMIT","PUSH","END"]}
```

```json
{"type":"task_start","ts":1714600007200,"runId":"self_improve-1714600000000","iteration":1,"stage":"IMPLEMENT","sub":3,"desc":"add safeSliceChars unit test"}
```

```json
{"type":"commit_observed","ts":1714600009000,"runId":"self_improve-1714600000000","iteration":1,"sha":"a1b2c3d","subject":"test: surrogate-safe truncation","trailers":["Co-authored-by: Copilot <noreply@github.com>"]}
```

### `result` / `iteration_end`

Terminal event from the in-flight `copilot -p` subprocess; the driver folds it into `iteration_end`, which carries the iter's response excerpt, cumulative tokens, and (when present) the Copilot premium-request count. The subprocess's terminal `result.sessionId` lives only in the in-process reducer's local state — it is surfaced to consumers via `session_attached` and stored on `state.json`, never on the iter's `iteration_end` event payload itself.

```json
{"type":"iteration_end","ts":1714600060000,"runId":"self_improve-1714600000000","iteration":1,"excerpt":"Implemented safeSliceChars test; commit pushed.","tokens":{"input":12000,"output":850},"premiumRequests":1}
```

### `finalize`

Iter N concluded. In the canonical schema the iter close is the `iteration_end` event above; downstream tooling that prefers a separate "finalize" name reads the same `iteration_end` line.

### `abort`

Emitted exactly once when the loop ends via `--stop`, completion-promise, abort-promise, stagnation, send error, or hitting `--max`. Carries a structured `reason` so downstream tooling can branch on the cause without parsing a free-form `note`. Reason vocabulary includes `user_stopped`, `abort_promise`, `stagnation`, `max_iterations`, and `send_error`.

```json
{"type":"abort","ts":1714600300000,"runId":"self_improve-1714600000000","reason":"abort_promise"}
```

### `complete` / `done`

Terminal event when the completion-promise (default `COMPLETE`) was observed. Drivers fire either `complete` or `abort` — never both — at the end of every run, so a consumer can rely on a single closing event per `runId`.

```json
{"type":"complete","ts":1714600200000,"runId":"self_improve-1714600000000","reason":"completion_promise"}
```

The `terminalAt` timestamp on either `complete` or `abort` is what `autopilot stats` and the TUI's elapsed-clock display freeze on, so a late event landing on the file after termination cannot push the elapsed counter forward.

### Other events

`pause` / `resume`, `stagnation`, `stage_start` / `stage_end`, `substage`, `task_list` / `task_end`, `stage_plan_amend`, `workitem_start` / `workitem_end`, `backlog_snapshot`, `usage_update`, and `session_attached` round out the schema. See [`events.mjs`](https://github.com/kloba/autopilot/blob/main/packages/tui/src/events.mjs) for the complete contract.

The schema is **strictly additive**: new event types append to the `EVENT_TYPES` list and never reorder or remove existing entries, so a months-old `events.jsonl` written by an older driver still folds cleanly through the latest reader. Lines longer than 16 KiB are rejected at serialize time and excerpts / notes are surrogate-safely truncated at 500 characters, so a runaway prompt cannot bloat the file.

The reader-side `foldEvents(events)` helper reduces the linear stream into a structured snapshot (`status`, `iteration`, `tokens`, `activeStage`, `currentPlan`, `lastCommit`, …) used by the TUI render path and by every replay tool — so any consumer can re-derive the run's state without re-implementing the protocol.

## Per-run state file

`~/.copilot/autopilot/runs/<runId>/state.json` is the run's only mutable on-disk state. It holds:

- `runId`, `mode`, `contextMode`, `startedAt`, `max` — run identity.
- `iter` — the 1-indexed iteration counter, advanced at every iter boundary.
- `paused` / `pausedAt` / `totalPausedMs` — pause flags + clock so `--resume` can compute how long a pause lasted.
- `stopRequested` / `stopReason` — flipped by sibling `autopilot run --stop <runId>` invocations.
- `sessionId` — captured Copilot CLI session id (in `--continue` mode); null otherwise.
- `terminated` / `terminationReason` / `terminationNote` — set on the run's final exit.
- `version` — monotonic counter incremented on every CAS write.

The resolved completion / abort tokens themselves are baked at arm-time and held on the driver's runtime closure rather than on `state.json`, so a config change between the arm and the next iter cannot retroactively change the run's termination criteria.

State writes are CAS-protected via a per-run lockfile (`<statePath>.lock`, a directory created via `mkdirSync` for atomicity) so a concurrent `--pause` + `--stop` from two separate terminals do not lose updates. Each writer reads the current state under the lock, mutates, bumps `version`, and renames a temp file into place.

`autopilot run --status <runId>` is a thin reader over the same file: it parses `state.json`, optionally tails the run's recent `events.jsonl` lines, and prints a one-screen summary. Because `state.json` is the single source of truth, `--status` works whether the driver is currently mid-iter, paused, or already terminated — the lock is held only during writes, so reads never block.

The companion `<runs-root>/index.jsonl` aggregates one row per run (the `armed` event re-emitted to a global file) so `autopilot list` and `autopilot stats` enumerate runs in a single sequential read instead of globbing every per-run directory. Runs that no longer have a per-run dir on disk (pruned, manually deleted) still surface in the index until a sweep removes them.

## Pause / resume semantics

`autopilot run --pause <runId>` and `autopilot run --resume <runId>` let you stop the next iteration from firing without losing the iteration counter or the captured Copilot session id (in `--continue` mode). The currently-running `copilot -p` subprocess is **never killed mid-iter** — the driver waits for it to finish naturally before honoring the pause flag at the next iter boundary.

State writes are CAS-protected via a per-run lockfile so a concurrent `--pause` + `--stop` from two terminals do not lose updates.

`--resume` flips `paused` back to `false` and rolls forward `totalPausedMs`. `--stop` sets `stopRequested` and the driver emits a terminal `abort` event with `reason: "user_stopped"` after the in-flight iter exits.

`SIGINT` / `SIGTERM` at the driver process maps onto `--stop` via the same lock-protected CAS path: the signal handler flips `stopRequested = true` on `state.json` and lets the in-flight iter exit before the driver returns. That keeps Ctrl-C in the foreground terminal and a sibling `autopilot run --stop <runId>` from another terminal indistinguishable from each other to a downstream consumer of `events.jsonl`.

## Completion / abort triggers

The driver scans each iter's response (root `assistant.message.data.content` — sub-agent content is filtered out) for two configurable substrings:

- **`--completion-promise`** (default `COMPLETE`) — terminates with `reason: "completion_promise"`.
- **`--abort-promise`** — terminates with `reason: "abort_promise"`. Defaults to the baked prompt's abort token in `--self-improve` mode (`ABORT_NO_IMPROVEMENTS`) and `--grow-project` mode (`ABORT_NO_BACKLOG`); no default in `--prompt` mode.

Both triggers are **only honored after `min_iterations`** to avoid premature termination from the agent merely describing the protocol on iter 1. The substring match is naive `.includes()` against the filtered root content — that's deliberate, since baked prompts pin both the exact spelling of the token and the surrounding markdown context, so false positives in normal agent prose are vanishingly rare.

## Stagnation detection

The driver tracks the last few iter responses and aborts with `reason: "stagnation"` when N consecutive responses are byte-identical (default N=3; `--stagnation-limit 0` disables). Stagnation overrides `min_iterations` as a safety floor — a genuinely stuck loop should not run to `max_iterations` just because `min` hadn't been reached.

The comparison is on the filtered root-assistant content — the same string used for completion / abort substring scans — so subagent chatter that happens to vary across iters (different tool-call IDs, different timestamps in tool output) does not mask a stuck root agent. A `stagnation` event with a non-zero `streak` is also emitted at the boundary that crosses the threshold, so the TUI can surface "2 of 3 identical" warnings before the run actually aborts.

## Adaptive iteration budget

When `--self-improve` reaches `--max` and progress signals are positive (the working tree shows uncommitted changes, or the last few iters are not byte-identical), the runner grants `adaptive_extension` more iterations up to `adaptive_max_total` rather than aborting useful work. The reverse is also true: if every progress signal is negative (no commits, byte-identical tail), the runner respects the user-supplied ceiling and does not extend.

The extension applies only to the `--self-improve` mode where "useful work in flight" is well-defined; `--grow-project` and `--prompt` runs honor `--max` exactly as configured. See [`packages/tui/src/runner.mjs`](https://github.com/kloba/autopilot/blob/main/packages/tui/src/runner.mjs) for the signal evaluation and ceiling rules.

The signals are deliberately conservative — uncommitted changes count, but a noisy file-watcher artifact does not — so the extension never fires speculatively. If the run does extend, the TUI shows the new ceiling and the reason in the header; the matching `iteration_start` events keep the same `runId` so a replay still folds into one timeline.
