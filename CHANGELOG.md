# Changelog

## Unreleased

### Features
- Runner now executes each iter in a per-iter git worktree under `$RALPH_TUI_RUNS_DIR/<runId>/worktrees/iter-<N>/` for `--self-improve` and `--grow-project` (`--worktree` opts in for `--prompt`); merged iters tear down on END, unmerged ones are preserved on disk and emit a `worktree_kept` event with the absolute path. (#66)

### Internal
- Startup sweep removes orphan worktrees from prior `terminated` runs (~200 ms budget). (#66)

### Breaking
- Binary renamed `ralph-tui` → `autopilot`. Bare invocation now starts `run --self-improve --fresh` (was: print help). Use `autopilot --help` for the previous help output. (#65)
- Issue #50 — Removed the in-session Copilot CLI extension.
  The project now ships only as the `ralph-tui` standalone TUI
  app. The `ralph_loop`, `ralph_status`, `ralph_pause`,
  `ralph_resume`, `ralph_stop`, `self_improve`, and
  `grow_project` in-session tools are gone — use
  `ralph-tui run [--prompt … | --self-improve | --grow-project]`
  and the sibling `--pause` / `--resume` / `--stop` /
  `--status <runId>` flags instead. The `extension/` directory,
  `extension/handler.mjs`, and the `joinSession`-coupled SDK
  contract are removed; existing `~/.copilot/extensions/ralph`
  installs become inert (`/extensions reload` will no longer
  see a `ralph` extension). Clean up with
  `rm -rf ~/.copilot/extensions/ralph`.
- Issue #50 — Removed `install.sh`. The TUI driver does not
  install into `~/.copilot/extensions/` — `git clone` the repo
  and run `node packages/tui/bin/tui.mjs --help` (or
  `cd packages/tui && npm install` for the Ink-rendered UI).
- Issue #50 — Removed the `RALPH_EVENTS_DIR` environment
  variable. The runs root for events.jsonl + index.jsonl +
  state.json now resolves via `RALPH_TUI_RUNS_DIR` (default
  `~/.copilot/ralph-tui/runs`), unifying the previously-split
  events root (`~/.copilot/ralph/runs`) and run-state root
  into a single per-run directory.

### Features
- Issue #57 — `ralph-tui watch` Live panel streams the agent's
  output (assistant text, tool calls, tool results) for the
  currently active L3 task, sourced directly from the Copilot
  CLI per-session JSONL log. Replaces the old DetailPane
  (which duplicated counters already rendered in Header and
  showed only a single static "last excerpt" line) with a
  fixed-height 10-row buffer that resets on each `task_start`
  and shows up to 200 lines of scroll-back. Dim prose for
  assistant text, cyan arrows for tool starts, green / red
  for tool successes / failures. Three honest empty states:
  `(waiting for session)` (live, no sessionId yet),
  `(no output yet)` (live, sessionId, no events), and
  `(session log unavailable for replay)` (static replay
  mode — the Copilot CLI rotates these logs and we can't
  reconstruct them from `events.jsonl`). The runner emits
  a new `session_attached` event so the TUI knows which
  session log to follow; the event dedups against a
  `lastEmittedSessionId` cursor so continue-mode runs fire
  once and fresh-context runs fire per sessionId rotation.
  As a regression-mitigation for losing DetailPane, the
  Header now renders the terminal `reason` inline as a dim
  parenthetical next to the status badge (`DONE (promise)`,
  `ABORTED (stagnation)`).

- Issue #59 — TUI Header gains a dim `v<X.Y.Z>` version pip
  pinned to the right edge of the heading row so an
  at-a-glance read of the run pane shows which build is
  active. Reads `packages/tui/package.json` via a new shared
  helper `readTuiVersion()` extracted to
  `packages/tui/src/version.mjs` (also re-exported from
  `bin/tui.mjs` so the existing `--version` flag and `doctor`
  output keep their previous behaviour). Visible from launch,
  including pre-iter-1 / idle status. `<Header>` accepts an
  optional `appVersion` string prop; when absent or empty,
  the pip is hidden and the heading row collapses to the
  pre-issue-59 single-text layout, so snapshot tests and
  pre-existing callers stay deterministic. `<App>` forwards
  the prop through; `run-ui.mjs` and `watch.mjs` pass
  `readTuiVersion()` at mount time. `readTuiVersion()`
  returns the literal `"unknown"` on read/parse failure
  rather than throwing, and `<Header>` will render
  `vunknown` over a blank pip when that fallback fires —
  more informative than silence when something went wrong.

- TUI Header gains an `elapsed HH:MM:SS` wallclock counter on
  the right row (after `tokens` / `premium`) so an at-a-glance
  read of the run pane shows how long the loop has been
  active. Live in non-terminal status (running / paused) — the
  `<App>` component drives a 1 Hz tick that re-renders the
  Header so seconds advance without depending on event
  arrivals (long stages without events no longer freeze the
  display). Frozen at the run's actual end ts in terminal
  status (complete / aborted) so the final value is the real
  duration of the run. `foldEvents` gains a `terminalAt:
  number|null` field on the snapshot, set strictly from the
  `complete` / `abort` event's own `ts`, so a late or replayed
  event arriving after termination cannot shift the frozen
  elapsed counter (mirrors the `ts`-pinned-not-`updatedAt`
  pattern used by `iteration_end`). Hidden when the loop has
  not yet armed (`startedAt` is null) and in static-mode
  renders without an injected `now` for non-terminal status,
  so snapshot tests and pre-iter-1 frames stay deterministic
  rather than rendering a wallclock-derived value that drifts
  per CI machine. The 1 Hz `setInterval` only fires in live
  mode (when `<App>` receives an `eventStream`), `unref()`s
  itself so it can't keep the process alive past TUI
  unmount, and clears immediately on terminal-status
  transition or unmount. The new `formatElapsed(ms)` helper
  is exported from `<Header>` and computes `HH:MM:SS`
  manually so a 30-hour self-improve run reads `30:00:00`
  rather than wrapping at 24 hours like a `Date`-based
  formatter would.

- Issue #54 — `ralph-tui run` UX hardening across the
  three-level layout. The four top panes
  (`<Header>` / `<StagesRow>` / `<TasksPane>` /
  `<SubstagesPane>`) now render a bold-underline heading
  (`Run` / `Stages` / `Tasks` / `Activity`) inside their
  bordered Box matching the existing inside-border heading
  convention used by `<Timeline>` / `<DetailPane>` /
  `<LastCommit>`, so each pane is identifiable without
  hovering for context. `<SubstagesPane>` decouples the
  pane heading from the active-stage marker — `Activity` is
  the heading and the `▸ STAGE_NAME` body row remains in the
  first content position so the substage stream still scopes
  visually to its parent stage. The `<Timeline>` pane now
  shows `(working…)` (dim) for in-flight iters that haven't
  yet streamed an excerpt, instead of the misleading
  `(no excerpt)` which made finished and in-flight iters
  indistinguishable; finished iters with no captured
  excerpt still get the historical `(no excerpt)` placeholder
  so replay fidelity for old runs is intact. `<Timeline>`
  also picks up live excerpt streaming: the runner streams
  root-agent `assistant.message.data.content` into existing
  `usage_update` events whenever 80+ new chars accumulate,
  capped at 500 chars surrogate-safely. `foldEvents` extends
  the `usage_update` case to update `iterations[last].excerpt`
  when the live event matches the in-flight iter (guarded by
  `endedAt == null` so a late event can't clobber a closed
  iter's excerpt) and `snap.lastExcerpt` for run-scope
  display, so the user sees mid-iter narration update within
  seconds of the agent emitting it rather than waiting for
  `iteration_end` at iter close. The `<LastCommit>` pane is
  no longer empty on mount when the run hasn't yet made a
  commit: the runner shells `git rev-parse --short HEAD` +
  `git log -1 --pretty=format:%s%(trailers:only)` once at
  arm time (right after the canonical `armed` event,
  carrying `iteration: 0`) so HEAD surfaces immediately;
  `defaultGitExec` gained a 200 ms `spawnSync` timeout to
  protect the start path against a wedged repo (lock file,
  hung credential helper). When `gitExec` is null (test
  injection without a stub) or the cwd isn't a git repo,
  arm-time replay is silently skipped — no crash, no spurious
  event, the pane just stays empty exactly like before the
  fix when there's nothing to surface.

- TUI 3-level renderer (issue #48 slice 9): the `<App>` layout
  now composes the new `<TasksPane>` + `<LastCommit>` panes
  alongside the existing `<Header>` / `<StagesRow>` /
  `<SubstagesPane>` / `<Timeline>` / `<DetailPane>` /
  `<Controls>` so a `ralph-tui run --self-improve` session
  surfaces the L1 work item / L2 flex stage plan / L3 per-
  stage task list / footer last-commit hierarchy specced by
  the issue's mockup. `<Header>` gained an active work-item
  row above the backlog row (kind glyph + `#ref` + clipped
  title, magenta accent so it pops) that collapses to nothing
  when no work item is in flight, and the backlog row picks
  up a green `(N done)` pip showing how many work items the
  loop has closed so far via `closedByLoop`. `<StagesRow>`
  picks the stages list from `snapshot.currentPlan.stages`
  when the agent has emitted a `[STAGE_PLAN: …]`, falling
  back to the canonical list otherwise; pinned-tail stages
  (`COMMIT` / `PUSH` / `END` for self-improve, `CLOSE` too
  for grow-project) display a 📌 glyph so the user sees
  they're loop-mandated, and stages added by an agent
  amendment (any reason other than the runner's
  `pinned-tail-enforcement`) get a `+` glyph so amend churn
  is visible. New `<TasksPane>` renders the current task
  list with `▶ N.M` for the in-flight task (with `← this
  iter` marker), `✓ N.M` for done, `✗ N.M` for failed, `↷
  N.M` for skipped, and `· N.M` for not-yet-started — where
  N is the parent stage's 1-based ordinal in the active plan
  and M is the task's `sub` number. New `<LastCommit>`
  footer renders the latest `commit_observed` event as
  `<sha7>  <subject>   <N> trailers (M co-authors)` with the
  SHA in yellow + the co-author badge in magenta; falls back
  to `last commit: (none yet)` when no commit has been
  observed. Pure components — fed entirely from the
  `foldEvents` snapshot, no extra wiring needed in the
  driver. 21 new tests in `packages/tui/test/components.test.mjs`
  cover the new helpers (`selectStages`, `computeAmendmentAdds`,
  `stageOrdinal`, `computeTaskRows`, `countCoAuthors`),
  empty/placeholder states, and a full 3-level
  end-to-end render.

- `ralph-tui run` (`packages/tui/src/runner.mjs`) now turns the
  agent's `[STAGE_PLAN: …]` / `[STAGE_PLAN_AMEND: …]` /
  `[TASK_LIST: …]` / `[TASK_START: …]` / `[TASK_END: …]` /
  `[WORKITEM_START: …]` / `[WORKITEM_END: …]` markers from
  `assistant.message` content into the matching events.jsonl
  events (slice 9 of issue #48), so the TUI's flex stage plan
  + per-stage task list + work-item header all populate live
  during an iter. `extractStructuredMarkers` (line-by-line
  whole-line parser, exported for tests) accepts only markers
  that occupy a line by themselves — inline mentions in prose
  (e.g. `"I will emit [STAGE_PLAN: …] later"`) do NOT fire;
  malformed JSON, non-object payloads, and unknown keys are
  silently skipped so a typo in the agent's narration never
  breaks the run. The seven supported keys are pinned by a
  single exported `STRUCTURED_MARKER_KEYS` array. The runner-
  side pinned-tail repair surfaces as a sequence of
  `stage_plan_amend` events with `reason:
  "pinned-tail-enforcement"` (computed by the new exported
  `computePinnedTailAmendments` diff helper) — the agent's
  RAW stages list is emitted first as `stage_plan` so the
  timeline preserves the agent's intent before the runner
  normalizes COMMIT/PUSH/END to the canonical tail.
  Sub-agent (`explore` etc.) `assistant.message` content is
  ignored for marker extraction the same way it's ignored
  for `[STAGE: NAME]` markers — the root-agent gate is the
  single source of truth.

- `ralph-tui run` now emits a `commit_observed` event after
  every successful `bash` `git commit` invocation by the
  agent, so the TUI's LastCommit footer picks up the SHA +
  subject + co-author trailer count without the agent having
  to self-report. Detection is heuristic-based on the raw
  `arguments.command` (the truncated `argsSummary` is too
  lossy — a multi-line bash script with the commit on a
  non-first line still fires) via the new exported
  `looksLikeGitCommit` helper, which accepts the common
  shapes (`git commit -m`, `git commit -F`,
  `git -c user.name=… commit`, `cd subdir && git commit`,
  multi-line bash scripts) and rejects look-alikes
  (`git --help commit`, `git commit-tree`,
  `echo 'git commit'`). Idempotent per `toolCallId` so the
  post-iter suffix-replay safety net cannot double-emit.
  Failed commits (non-zero exit) and non-bash tools whose
  args happen to contain "git commit" do not fire. The
  shell-out itself goes through a new injectable
  `gitExec({args, cwd, env})` opt arg on `runRalphTui`
  (default: `child_process.spawnSync`) so tests stub repo
  state without touching disk. The new exported
  `readHeadCommit` helper composes `git rev-parse --short
  HEAD` + `git log -1 --pretty=format:%s\\0%(trailers:…)`
  into a `{sha, subject, trailers[]}` triple, capping
  trailers at 8 to match the events.mjs serializer.

- `ralph-tui run` now surfaces output-token totals and
  Copilot premium-request counts live in the Header (right
  row picks up ` · premium <N>`) and DetailPane (a new
  `premium req <N>` row below the existing tokens row). The
  out-of-session driver in `packages/tui/src/runner.mjs` now
  extracts `assistant.message.data.outputTokens` (per-message
  delta, summed; sub-agent events skipped via the `agentId`
  presence check) and `result.usage.premiumRequests` from
  the JSONL stream `copilot -p --output-format json` writes,
  emits a new `usage_update` event mid-iter so the snapshot
  reflects in-progress totals (no more `tokens 0` for the
  duration of an iteration), and backfills cumulative
  `tokens` + `premiumRequests` on `iteration_end` for replay
  resilience. Plain-mode (`ralph-tui plain`) renders a
  matching 5-char `usage` verb and appends `premium=<N>`
  alongside `tokens=I/O` so `awk` / `grep` consumers see the
  same field. The `premiumRequests` counter is null until
  the first `result` event lands, and the TUI hides both
  surfaces while null so users don't see a confident
  "premium 0" pre-iter-1.

### Fixes
- `self_improve` loop no longer terminates one stage short of
  done on tier (b) STALE OPEN PR work items, no longer aborts
  while real backlog work is sitting unpicked, and no longer
  emits COMPLETE on no-op iters that walked
  ORIENT/IDEATE/CRITIQUE/BASELINE without producing a commit.
  The baked `PROMPT_SELF_IMPROVE` body in
  `extension/prompts.mjs` now pins three contracts the agent
  had been silently violating:
  (1) **tier (b) terminal state is MERGED** (or auto-merge
  armed via `gh pr merge --auto`), not "mergeable with green
  CI" — step 2.b, step 8 PUSH (with explicit `gh pr merge`
  invocation + the squash/merge/rebase style detection
  hint), step 9 END (per-tier terminal-state enumeration),
  and HARD RULES all reinforce it; the misleading "driving
  that PR to a mergeable state IS the iteration" wording is
  gone, and the fallback for "merge can't complete this iter"
  now correctly tells the agent to **end the iter without
  emitting COMPLETE** (so the loop iterates) rather than the
  previous self-defeating "emit COMPLETE and the next iter
  will re-pick" (COMPLETE terminates the whole loop, so there
  is no next iter).
  (2) **`ABORT_NO_IMPROVEMENTS` is the literal backlog-empty
  signal**, only valid when tiers (a)/(b)/(c) are objectively
  empty AND no genuine (d) is identifiable — concurrent-agent
  activity, contested file scope, "this work feels too large
  for one iter", and "I'm uncertain how to fix this" are
  explicitly disclaimed as abort grounds. The corrected
  response when work exists but is blocked from THIS iter is
  either picking a different non-blocked work item from the
  same tier or ending the iter without a terminal token (no
  COMPLETE, no ABORT) so the loop iterates and re-orients on
  the next premium request.
  (3) **COMPLETE requires shipped work THIS iter** — at
  minimum a COMMIT with the IMPLEMENT/TEST stages preceding
  it. An iter that walked only ORIENT/IDEATE/CRITIQUE/BASELINE
  and went straight to END without producing a commit MUST
  NOT emit COMPLETE; the correct response is either picking a
  different work item and walking IMPLEMENT/TEST/COMMIT/PUSH,
  or ending the iter without any terminal token. Step 2.b
  now also explicitly disclaims intentionally-draft /
  mergeable-and-green PRs as tier (b) candidates so the agent
  doesn't pick them just to discover "no work needed" and
  emit COMPLETE on a no-op iter — those PRs are skipped and
  tier (c) is consulted instead.
  Three new regression-pin tests in `test/extension.test.mjs`
  cover all three contracts (`PROMPT_SELF_IMPROVE tier (b)
  terminal state is MERGED, not just mergeable`,
  `PROMPT_SELF_IMPROVE ABORT_NO_IMPROVEMENTS contract`, and
  `PROMPT_SELF_IMPROVE COMPLETE requires shipped work this
  iter`) and pin the specific anti-pattern wording the agent
  rationalised against, so a future edit cannot silently
  re-create any of the three failure modes.

- `ralph-tui run` no longer prints a spurious
  `ExperimentalWarning: Detected unsettled top-level await at
  …/packages/tui/bin/tui.mjs:<EOF>` line on exit. Root cause:
  the symlink-aware direct-run check pulled `realpathSync` and
  `pathToFileURL` in via two `await import(...)` statements at
  module top level (added by the `npm link` symlink fix in
  `8b2a98e`). On Node 22+, when `main()`'s
  `.then(process.exit)` fires the implicit module-evaluation
  TLA hadn't been observed as settled yet, so Node attached
  the warning to the file's last line. Fix: promote both
  imports to the existing static `import fs from "node:fs"` /
  `import { fileURLToPath, pathToFileURL } from "node:url"`
  lines and drop the dynamic `await import(...)`. New
  regression test `tui.mjs has no top-level await (Node 22+
  unsettled-TLA warning regression guard)` in
  `packages/tui/test/bin.test.mjs` walks the file at brace-
  and string-aware depth 0 to fail any future re-introduction
  of a top-level `await`.

- `ralph-tui run` no longer renders `tokens 0` for the
  duration of a `--self-improve` / `--continue` / `--fresh`
  run. Root cause: `reduceCopilotEvents` in
  `packages/tui/src/runner.mjs` was not extracting
  `assistant.message.data.outputTokens` from the
  `copilot -p --output-format json` JSONL stream, so the
  `iteration_end` event the runner emitted never carried a
  `tokens` field — `foldEvents` therefore kept the snapshot
  at `{input:0, output:0}` and Header rendered 0 even after
  multiple iters had run. Fix is two-pronged: a new
  `usage_update` event streams cumulative usage out of the
  per-line callback so the snapshot updates while an iter
  is still in-flight, and `iteration_end` now backfills the
  same totals as a defensive line in case a tail loses some
  live events.

### Features
- `events.mjs` gains the `stage_plan` / `stage_plan_amend` /
  `task_list` / `task_start` / `task_end` / `commit_observed`
  event vocabulary so the agent-emitted flex stage plan +
  per-stage task list + LastCommit footer specced by issue
  #48 slice 9 can be carried in `events.jsonl` (and replayed
  losslessly by the TUI). `serializeEvent` rejects malformed
  payloads up-front: empty `stage_plan.stages[]` (after the
  non-string filter), `stage_plan_amend` with neither `add`
  nor `remove` or with an empty `reason`, `task_list` with
  no stage, `task_start` with `sub<1`, `task_end` with an
  outcome outside `["ok","fail","skip"]`, and
  `commit_observed` with a SHA that doesn't match
  `/^[0-9a-f]{7,40}$/i` (SHA stored lowercase so dedupe and
  equality work). The new `enforcePinnedTail` pure utility
  takes any agent-supplied stages array, strips entries
  matching the canonical tail (`COMMIT`, `PUSH`, `END`) from
  any position, re-appends them in canonical order at the
  tail, and returns `{stages, repaired}` so the runner can
  emit a visible `stage_plan_amend` with `reason:
  "pinned-tail-enforcement"` whenever it had to repair the
  plan (silent normalization is forbidden — every
  correction must surface in `events.jsonl` so the timeline
  stays a faithful narrative). `foldEvents` extends its
  snapshot with `currentPlan`, `planAmendments[]`,
  `currentTaskList`, `taskInFlight`, `recentTasks[]`, and
  `lastCommit`; `armed` resets all of them, `workitem_start`
  resets the plan / task list / in-flight task (each work
  item gets a fresh plan), `stage_start` resets the task
  list and in-flight task (each stage gets a fresh task
  list), and a `task_end` computes its own `durationMs` from
  the matching `task_start` so plain mode and the renderer
  see a consistent value. Plain mode adds `plan `, `pamen`,
  `tlist`, `tsk+ `, `tsk- `, and `commt` verbs plus the new
  `stages=[…]`, `add=`, `remove=`, `after=`, `items=[…]`,
  `desc="…"`, `sha=` (12-char prefix; full SHA stays in
  JSONL), `subject="…"`, and `trailers=N` (count only — full
  trailer payload stays in JSONL) field renderers. Strictly
  additive: `EVENT_TYPES` keeps the original 14 entries in
  the original order, the six new ones append below them,
  and a historic `events.jsonl` produced before this change
  replays identically.

- `events.mjs` gains the `workitem_start` / `workitem_end`
  event vocabulary plus the `WORKITEM_KINDS` enum
  (`["issue","pr","red_ci"]`) so the L1 work-item — the single
  unit the loop is currently fixing — can be named in
  `events.jsonl` and surfaced by the TUI header (slice 3 of
  issue #48). `serializeEvent` validates the `kind` field on
  workitem events (rejects an unknown kind), clips `title` at
  200 chars surrogate-safely, and accepts an optional numeric
  `ref` (issue / PR number, or run id for `red_ci`) plus an
  optional `closesN` on `workitem_end` for the
  `Closes #N`-footer case. `foldEvents` tracks
  `activeWorkItem` (cleared on `workitem_end` and reset on
  `armed`), appends to `completedWorkItems[]`, and increments
  a run-local `closedByLoop` counter once per `workitem_end`
  that carries a `closesN` — kept strictly separate from
  `backlog.closedByLoop` (the runner's snapshot value) so
  the two cannot drift. A mid-run replay (a `workitem_end`
  with no preceding `workitem_start`) appends with
  `startedAt: null` rather than re-using a stale value, and a
  mismatched `(kind, ref)` end-event no longer blanks out the
  active item. Plain mode renders `wkit+` / `wkit-` verbs and
  the new `kind=`, `ref=`, `title="…"`, `closesN=` columns
  (whitespace in the title collapses to a single space and
  the value is JSON-stringified so awk consumers see one
  token). Strictly additive; existing event types and the
  `events.jsonl` schema stay backwards-compatible — historic
  replays without workitem events render identically.

- `ralph-tui run` now mounts the Ink TUI by default on a TTY,
  giving daemon / live-loop users the iter -> stage -> substage
  hierarchy + backlog pressure header that issue #48 specced
  (slice 8). Headless mode kicks in automatically when stdout
  isn't a TTY (CI / pipe / asciinema), or explicitly via the
  new `--headless` flag (alias for `--plain`) for `nohup`-style
  daemons. Falls back to plain text when the `ink` dependency
  isn't installed (ERR_MODULE_NOT_FOUND on a fresh checkout).
  Fixes three runtime concerns in the same slice:
  * Runner `# iter N/M` writes are routed to a no-op stdout
    sink while the TUI is mounted so they no longer interleave
    with Ink frames; stderr stays attached so unrecoverable
    errors still surface above the TUI.
  * Ctrl-C in Ink raw mode (which does NOT produce SIGINT,
    only the `\x03` byte) is caught by a new useInput handler
    that calls `runner.stopRun(runId, { reason: "signal_SIGINT" })`
    via a new `onUserAbort` callback prop on `<App>`. The same
    callback fires on `q` with reason `user_quit`, so pressing
    `q` to "quit the TUI" while a self-improve loop is burning
    tokens now also stops the run instead of orphaning it.
  * The TUI's tail starts from offset 0 of `events.jsonl`; we
    seed `<App>` with an empty initial array (instead of
    pre-reading the file) so events written before mount don't
    appear twice and inflate the foldEvents snapshot.
  New module `packages/tui/src/run-ui.mjs` (lazy-loaded by
  `bin/tui.mjs`) holds the mount logic; the `<App>` keybinding
  hook is back-compat — `ralph-tui watch` callers that omit
  `onUserAbort` just get exit-only behaviour as before.

- `scripts/ralph-tui-fresh.sh` — new Bash wrapper that runs
  `git pull --quiet --ff-only` from the repo root before
  `exec node packages/tui/bin/tui.mjs` *only* when the first arg
  is `run`, so each long-haul out-of-session loop (e.g.
  `ralph-tui run --self-improve` draining a backlog over hours)
  starts on the freshest source. Quick read-only subcommands
  (`list`, `replay`, `watch`, `doctor`, `prune`, `stats`,
  `where`) skip the upgrade — they're millisecond-fast read ops
  on local files and adding a `git pull` would just make `list`
  feel laggy. Self-overwrite races are impossible by
  construction: the TUI binary is loaded into memory once at
  Node startup and the wrapper's `git pull` lands the new source
  *before* `exec node` imports the module graph. Mid-loop
  version skew is impossible for the same reason — iter 1 and
  iter 100 of a single run always execute identical code. All
  failure modes are silent (`|| true`): no network, dirty
  working tree, non-fast-forward, detached HEAD all fall through
  to the existing checkout. `--ff-only` deliberately refuses to
  clobber local work-in-progress. Documented under a new
  `Auto-upgrade for each run` subsection of
  `packages/tui/README.md`. Pinned by drift-guard tests in
  `test/extension.test.mjs` covering shebang, executable bit,
  `set -euo pipefail`, the only-when-`run` gate, the silent
  `|| true`, and the canonical
  `exec node "$ROOT/packages/tui/bin/tui.mjs" "$@"` line.

- `ralph-tui watch` Ink components now render the 3-level hierarchy
  the runner has been emitting since slices 4–6 (issue #48 slice 7).
  `<Header>` gained a backlog row showing
  `open issues · open PRs · red CI runs` (with `?` for fields the
  agent didn't probe in this iter), and renders `iter X/∞` instead
  of a literal `1000` when the iteration cap matches the
  runaway-guard ceiling — the new self-improve default. New
  `<StagesRow>` component renders the canonical SDLC stage list as
  a horizontal pill row (`[✓ ORIENT] [● IDEATE] [ CRITIQUE]`)
  with three states (completed / active / pending), driven by
  `snapshot.recentStages` and `snapshot.activeStage`. New
  `<SubstagesPane>` renders the per-stage substage activity log
  (`verb argsSummary  outcome  durationMs`) with a tail-cap so
  long stages don't push the rest of the UI off-screen, and a
  placeholder for stages with no activity yet. All three are
  pure presentational components — `computeStageStates` and
  `formatDurationMs` are exported for unit testing without
  rendering. Custom `--prompt` runs (no canonical stage list)
  collapse `<StagesRow>` to nothing so the header stays compact.

- `ralph-tui run` now emits a `backlog_snapshot` event after each
  iteration when the agent's ORIENT-stage `gh` probes ran (issue
  #48 slice 6). The runner walks the iter's `tool.execution_*`
  events for the three baked probes
  (`gh run list --status failure`, `gh pr list --state open`,
  `gh issue list --state open`), parses each `gh list` output's
  tab-delimited row count, and emits one snapshot per iter
  carrying `redCi` / `openPrs` / `openIssues`. Fields the agent
  did not probe stay `null` — the renderer (slice 7) shows `?`
  for those. No extra `gh` calls from the runner: the snapshot
  is free when the agent ran the probes (per the baked SDLC
  prompt) and silently absent otherwise. Failed bash tool
  results (e.g. unauthenticated `gh`) are ignored so a partial
  stdout never poisons the snapshot. New exported helpers in
  `packages/tui/src/runner.mjs`: `parseGhListCount(stdout)` and
  `extractBacklogFromEvents(events)`, both pure / no I/O.

- `ralph-tui run` now emits `substage` events from each
  `tool.execution_complete` JSONL frame in the agent's response
  stream (issue #48 slice 5). Each substage carries the verb
  (`bash` / `view` / `edit` / `grep` / …), a one-line arguments
  summary (≤80 chars; per-tool shaping pulls the most useful
  field), an outcome (`ok` or the error code), a computed
  `durationMs` (or null when timestamps are missing), and a
  `sub` counter that resets to 1 on each new stage. Substage
  events sit between consecutive `stage_start` events so
  `foldEvents` attributes each substage to its containing
  stage. New exported helpers in `packages/tui/src/runner.mjs`:
  `extractAgentTimeline(events, allowedStages)` (pure walker
  that interleaves stage markers and tool completions in event
  order) and `summarizeToolArgs(verb, args)` (one-line arg
  distillation).

- `ralph-tui run` now parses `[STAGE: NAME]` markers from the
  agent's response stream and emits `stage_start` / `stage_end`
  events for the renderer's per-iter stage row (issue #48 slice
  4). Markers are validated against the canonical per-mode stage
  list (`SDLC_STAGES_SELF_IMPROVE` / `SDLC_STAGES_GROW_PROJECT`):
  a hallucinated marker like `[STAGE: REVIEW]` is silently
  dropped at parse time so a typo can never poison the event
  stream. Markers must appear on a line by themselves (anchored
  match) so an inline mention in narrative prose doesn't fire.
  `--prompt` mode emits no stage events (no canonical list).
  New exported helpers: `extractStageMarkers(text, allowedStages)`
  (pure) and `stagesForMode(mode)`.

- `ralph-tui run --self-improve` no longer caps at 100 iterations
  by default. The default `--max` for `--self-improve` mode is now
  the runaway-guard ceiling (`MAX_ALLOWED_ITERATIONS = 1000`),
  matching the loop's job: drain the entire backlog and assert
  `ABORT_NO_IMPROVEMENTS`. The 100-iter cap was stopping the loop
  while real backlog items were still actionable — exactly the
  failure mode issue #48 is fixing. Explicit `--max N` still
  wins; `--grow-project` and `--prompt` keep the conservative
  100-iter default since their scope is finite and user-supplied.
  New exported helper `defaultMaxIterationsFor(mode, runner)` in
  `packages/tui/bin/tui.mjs` resolves the per-mode default and is
  pinned by tests in `packages/tui/test/bin.test.mjs`.

- `PROMPT_SELF_IMPROVE` and `PROMPT_GROW_PROJECT` now instruct the
  agent to emit `[STAGE: NAME]` markers on a line by themselves as
  it enters each numbered SDLC stage (`[STAGE: ORIENT]`,
  `[STAGE: IDEATE]`, … `[STAGE: END]`). The runner-side parser
  (issue #48 slice 4) reads these markers from the agent's
  response stream to drive the 3-level hierarchical TUI's stage
  row. Missing markers don't break the loop, but they hide
  progress from the user. `events.mjs` now exports
  `SDLC_STAGES_SELF_IMPROVE`, `SDLC_STAGES_GROW_PROJECT`, and a
  `stagesForLabel(label)` lookup helper, all kept in lockstep
  with the prompt bodies by parity-guard tests
  (`packages/tui/test/events.test.mjs` —
  *every stage name appears in PROMPT_*) so a future edit cannot
  silently strip a marker without the test catching it.

- `events.jsonl` event vocabulary gains four strictly-additive
  types (`stage_start`, `stage_end`, `substage`,
  `backlog_snapshot`) so the TUI can surface a 3-level
  hierarchy (iteration → SDLC stage → sub-stage) plus a
  backlog-pressure header. `EVENT_TYPES` retains the eight
  pre-existing types in their original order — historical
  `events.jsonl` files replay through the new reader unchanged.
  `foldEvents` now tracks `activeStage`, `recentStages`
  (per-iter), `currentStageSubstages` (per-stage), and
  `backlog` (`{redCi, openPrs, openIssues, closedByLoop}`),
  with reset-on-`armed` / reset-on-`iteration_start` /
  reset-on-`stage_start` semantics so a long-running loop's
  snapshot stays bounded. `serializeEvent` allow-lists the
  new fields with conservative caps (`stageName` ≤ 64 chars,
  `verb` ≤ 32, `argsSummary` / `outcome` capped via
  `safeSliceChars` so the 16 KB per-line ceiling holds).
  `formatEventLine` renders the new types with stable
  one-line shapes (`stge+` / `stge-` / `sub` / `back`
  verbs; `stage=K name=… durationMs=… outcome=…`,
  `sub=L verb=… args="…"`, and
  `redCi=… openPrs=… openIssues=… closedByLoop=…`) so
  CI / `tail -f` / `awk` consumers see new columns alongside
  the existing iteration-level columns. The `excerpt+note`
  lockstep guard in `test/events-emit.test.mjs` is scoped to
  the user-supplied prose fields it actually pins; new
  machine-generated identifier fields keep their own caps.
  Pinned by 19 new tests across
  `packages/tui/test/events.test.mjs` and
  `packages/tui/test/plain.test.mjs`. Foundation for the
  3-level hierarchical TUI tracked in issue #48.

- `ralph-tui run` — new subcommand that drives a
  `ralph_loop` / `self_improve` / `grow_project` loop
  OUT-OF-SESSION by spawning each iteration as a fresh
  `copilot -p "<prompt>" --allow-all-tools --output-format
  json` subprocess. The user MUST pick exactly one prompt
  mode (`--self-improve` / `--grow-project` / `--prompt
  "..."`) AND exactly one context mode (`--continue` /
  `--fresh`). `--continue` names the session on iter 1
  (`-n ralph-tui-<runId>`), captures the terminal
  `result.sessionId` from the JSONL stream, and resumes via
  `--resume=<sessionId>` on iter 2+ so the conversation
  history grows across iterations. `--fresh` re-spawns
  without `-n` or `--resume` each iter so every iteration
  starts from a clean context — the mode the in-session
  `ralph_loop` tool cannot offer because the Copilot SDK
  exposes no session-history reset to extension code.
  `--max N` caps total iterations (default 100). `--focus
  "..."` is supported for `--self-improve` /
  `--grow-project` and is appended verbatim as
  `Focus this run on: <focus>` (≤2000 chars; rejected at
  parse time otherwise). Sibling `--pause <runId>` /
  `--resume <runId>` / `--stop <runId>` / `--status
  <runId>` operate on the run's state file
  (`~/.copilot/ralph-tui/runs/<runId>/state.json`) via a
  versioned read-modify-write under a lockfile so a `pause`
  racing the driver's iter-end write cannot lose updates.
  SIGINT/SIGTERM at the driver process sets
  `stopRequested=true` in the state file and lets the
  current child exit naturally before emitting the terminal
  `abort` event with `reason: "user_stopped"`. Events are
  emitted to the same JSONL stream
  (`~/.copilot/ralph-tui/runs/<runId>/events.jsonl`) the
  in-session runner uses, so `ralph-tui watch / replay /
  list / stats` work unchanged for both
  in-session and out-of-session runs. Reuses
  `extension/prompts.mjs` and
  `extension/events-emit.mjs` rather than duplicating the
  baked SDLC prompts or the writer wiring. Pinned by 36 new
  tests in `packages/tui/test/runner.test.mjs` plus drift
  guards covering the USAGE block, `VALUE_FLAGS` set, and
  the header `// Subcommands` comment.

- `self_improve` and `grow_project` baked SDLC prompts
  reframed around the per-iteration cost model and a clean
  division of labor. **`self_improve`** is now a backlog-DRAIN
  runner: each ORIENT stage best-effort enumerates red CI
  runs, open pull requests, and open human-filed issues
  via `gh run list --status failure`, `gh pr list --state
  open`, and `gh issue list --state open`. IDEATE runs a
  four-tier priority list — RED CI → STALE OPEN PR → OPEN
  HUMAN-FILED ISSUE (any open issue WITHOUT the
  `grow-project` / `proposed` label) → ROTATING SDLC
  HARDENING (last-resort fallback). When the first three
  tiers are empty AND no genuine user-visible improvement
  is identifiable, the agent is instructed to emit
  `ABORT_NO_IMPROVEMENTS` rather than mine the codebase
  for defensive guards, drift-pins, or comment-alignment
  churn. **`grow_project`** is now scoped explicitly to NEW
  FEATURES only — bug fixes, hardening, CI healing,
  refactors, and human-filed asks belong to the
  backlog-drain runner. If a `grow-project`-labelled issue
  turns out to describe a bug, the agent is instructed to
  strip its `grow-project` / `proposed` labels and skip it
  so the backlog-drain runner picks it up. Both prompts
  drop the prior "smallest correct step is the right step"
  mantra, which was anti-aligned with Copilot's premium-
  request pricing model: each iteration is a paid request
  whether it produces one tiny commit or several
  substantive ones, so the corrected contract is "pack the
  turn — multiple atomic commits per iter are encouraged
  when the work permits, with the tree green between
  commits" (`grow_project` keeps the per-feature gate
  intact: tests + acceptance + demo + close cannot be
  shortcut to fit more features in). Together these
  changes address the failure mode where a long
  `self_improve` run produced ~100 commits of micro-polish
  while four open human-filed issues sat untouched. Pinned
  by four new drift-guard tests in `test/extension.test.mjs`.

- `install.sh --dry-run` now derives an at-a-glance
  `Direction:` label between the `Version:` and `Source:`
  lines, naming the relationship between the installed
  and source versions in five distinct shapes: `fresh
  install` (no prior install), `no-op reinstall (same
  version)`, `upgrade (vA.B.C → vX.Y.Z)`, `downgrade
  (vA.B.C → vX.Y.Z)`, or `indeterminate (installed
  VERSION unparseable)` for the iter 133 corrupt-prior-
  install case. The direction is computed by parsing
  both versions as strict `MAJOR.MINOR.PATCH` integers
  and comparing lexicographically — this project has
  never shipped a pre-release suffix, so a future tag
  like `0.7.0-rc.1` lands in the indeterminate branch
  rather than emit a misleading ordering. Pinned by a
  drift-guard test in `test/extension.test.mjs` that
  exercises all five branches through a sandbox `HOME`.

- `install.sh --dry-run` now prints an `Installed:`
  line above the existing `Version:` line, sourced
  from the target dir's `handler.mjs` (if any). Reads
  top-to-bottom as upgrade direction (`Installed:
  v0.5.0` → `Version: v0.6.0`) so a contributor or CI
  script staging an upgrade no longer has to cd into
  the target dir and grep handler.mjs themselves.
  Renders as `Installed: (none)` when the extension was
  never installed before. Two new tests pin both
  branches AND the line ordering (Installed above
  Version, never the reverse).
- `install.sh` now accepts `--version` (long form) and `-V`
  (short form) flags that print
  `copilot-ralph-extension vX.Y.Z` and exit 0. Sourced from
  the same `export const VERSION` declaration in
  `extension/handler.mjs` that the dry-run header and the
  post-install success line use, so a CI script asking "which
  version would `./install.sh` install?" gets the canonical
  answer in a single line without having to parse `--dry-run`
  output (which is multi-line) or grep handler.mjs themselves.
  The `--help` output now advertises both flags. Pinned by
  three new tests (long flag, short flag, `--help` drift
  guard) that cross-check the printed version against
  `handler.mjs`'s declaration.
- `install.sh` now prints the extension version on the
  dry-run header (`Version:   vX.Y.Z`) and the post-install
  success line (`✅ Installed ralph extension vX.Y.Z to …`).
  Sourced via `awk` from `extension/handler.mjs`'s
  `export const VERSION` constant (a single source of truth
  shared with `ralph_status`), so the install confirmation
  cannot drift away from what the running extension reports.
  An empty-version guard fails the install loudly if a
  future refactor changes the declaration shape rather than
  silently printing `v ` to the user. Drift-guarded with
  three tests pinning the header line, the success line,
  and the failure mode.
- `install.sh --dry-run` now annotates each file in the
  listing with `[new]` / `[overwrite]` / `[unchanged]` and
  emits a closing `Changes: A new, B existing` summary so a
  contributor can tell at a glance whether the run would be
  a fresh install, an in-place upgrade, or a no-op. Combined
  with the iter 93 `Total:` footprint line, the dry-run
  output now answers three different "what would happen?"
  questions without writing a byte. Drift-guarded so the
  annotation cannot silently regress.
- `install.sh --dry-run` now closes the file listing with a
  one-line install-footprint summary
  (`Total:   <N> bytes (<K> files)`) so a contributor reviewing
  the dry-run output no longer has to mentally sum the per-file
  byte counts. Useful when verifying an install fits inside a
  quota'd filesystem (CI sandboxes, container layers). Drift-
  guard test pins both halves of the line — the byte total
  matches the sum of `extension/*.mjs` sizes and the file count
  matches `extension/*.mjs.length` — so a future hardcode of
  either value is caught at test time.

### Fixes
- `ralph-tui run`: pressing `q` now prints an immediate
  user-visible message to stderr (`ralph-tui run: q received —
  finishing current iteration, then stopping. Hit Ctrl-C to
  abort hard.`) so the user sees that the keystroke was
  captured. Field bug from issue #48 dogfooding: pressing q
  during iter 1 of a self-improve run left the static last
  Ink frame on screen with no further output, since the
  runner only checks `stopRequested` between iters and won't
  kill the in-flight copilot subprocess. Users perceived
  this as "q is broken" and fell back to Ctrl-C (which DID
  print a `SIGINT received…` banner via the signal handler).
  The fix routes both Ink's `useInput` path AND the keypress
  fallback through a single `printAbortMessage` closure
  that's idempotent across double-fires (Ink + fallback both
  fire for the same byte) and dedups against the SIGINT
  banner so a Ctrl-C in the TUI doesn't print two
  near-identical lines. Extracted `formatAbortMessage(reason)`
  as a pure helper (returns `string|null`, exported from
  `bin/tui.mjs`) so the formatting contract is
  unit-testable without exercising the full TTY + Ink +
  runner pipeline.

- `ralph-tui run`: stage / substage / activity panes no longer
  show "(no active stage)" / "(no activity yet)" for the entire
  duration of an iter — the UI now updates LIVE as the agent
  works. Previously the runner buffered every child JSONL event
  in memory and emitted the synthetic `stage_start` /
  `stage_end` / `substage` events to `events.jsonl` in a single
  batch AFTER the child exited, which meant the TUI (which
  tails events.jsonl) saw nothing land between
  `iteration_start` and `iteration_end` for an iter that took
  many minutes — every pane rendered empty for the whole iter
  and the user had no signal that the agent was making
  progress (field report on `--self-improve --fresh`). The
  multi-iter loop now wires `runOneIteration`'s `onLine` hook
  and re-runs `extractAgentTimeline` incrementally on each new
  child event, emitting only the new tail items. The extractor
  is monotonic w.r.t. its input — adding more events never
  reorders earlier output — so the streaming path lands the
  same final event sequence as the previous post-close batch
  (existing tests covering ordering / sub-counter / attribution
  / mode-aware filtering all still pass byte-equivalent). A
  suffix-replay safety net runs after the await against
  `result.events` so any drift between the live feed and the
  post-close events array (e.g. a swallowed throw inside the
  live emitter) is silently filled in. The companion fix to
  `runOneIteration`'s close-handler trailing-buffer drain now
  ALSO calls `onLine` on the recovered final un-newline-
  terminated row, so a child that exits mid-line still streams
  its last event live instead of waiting for the suffix replay.
  Two new regression tests pin the contract: (a) `stage_start`
  must appear in the events sink BEFORE the spawn close
  callback fires, and (b) a final un-newline-terminated JSONL
  row's stage events must still surface in the final ordering.
- `ralph-tui run`: pressing `q` (or Ctrl-C) inside the Ink TUI
  reliably stops the loop again — field reports surfaced an
  environment where Ink's `useInput` silently failed to enter
  raw mode, leaving `q` echoing to the terminal as cooked-mode
  input while the loop kept running and the user had to
  double-Ctrl-C to escape. `bin/tui.mjs` now installs a stdlib
  `readline.emitKeypressEvents` keystroke listener on
  `process.stdin` BEFORE mounting Ink and explicitly calls
  `setRawMode(true)` itself, so the keystroke path is live
  regardless of whether Ink's hook ever fires. Both listeners
  share the same `onAbort` (which routes to `runner.stopRun`,
  idempotent), so a double-fire from Ink + readline is
  harmless. The fallback only attaches when stdin is a TTY —
  CI / piped runs short-circuit to a no-op cleanup. For Ctrl-C
  in raw mode (where the kernel does NOT generate SIGINT),
  the handler synthesises `process.kill(process.pid, "SIGINT")`
  to the parent so the existing `installSignal` graceful-stop
  message still prints and the second-Ctrl-C hard-abort gate
  still works.

### Fixes
- `runGitCommand` (`extension/handler.mjs:645`) now explicitly
  guards `if (!res)` between the `res?.error` branch and the
  final happy-path return. The helper's docstring promises
  every error path collapses to `{ ok: false, stdout: "",
  stderr, code }` and "never throw out of the wrapper" — but
  if `spawnSync` ever returned undefined/null (a theoretical
  contract violation by a future Node release or an exotic
  embedder), the wrapper would TypeError on `res.status` at
  the final return, silently breaking the contract every
  gitExec consumer (ralph_status diagnostics, armLoop's
  pre-arm git snapshot, the adaptive-budget evaluator)
  depends on. Surfaces the documented stderr sentinel
  (`spawnSync returned no result`) instead. Pinned by a new
  drift-guard test in `test/extension.test.mjs` that
  verifies the guard is present AND that the three branches
  appear in the documented order (`res?.error` → `!res` →
  happy path).
- `ralph-tui replay` and `ralph-tui watch` now catch the
  `TypeError` thrown by `resolveRunEventsPath` on path-traversal
  runIds (e.g. `../etc/passwd`, runIds containing `\0`, `\\`, or
  `..` segments) and route through the bin's `fail()` helper. Pre-
  iter-167 a user supplying such a runId saw a raw stack trace
  instead of the clean one-line `ralph-tui: replay: <reason>`
  message + exit code 2 that every other input-validation path
  emits. Production behaviour for legitimate runIds (those produced
  by `makeRunId`) is unchanged. Two tests in
  `packages/tui/test/bin.test.mjs` pin both the no-throw contract
  and the user-visible message — mutation-verified by removing the
  catch (2 failures).
- `pruneRuns` (the engine behind `ralph-tui prune`) now also
  guards the `obj.ts < cutoff` deletion gate with
  `Number.isFinite(obj.ts)`. Pre-iter-163 the gate was
  `typeof obj.ts === "number" && obj.ts < cutoff`. Because
  `typeof -Infinity === "number"` is true and `-Infinity < N`
  is true for every finite cutoff, a hand-edited or corrupted
  index.jsonl row carrying `ts: -1e500` (which `JSON.parse`
  promotes to `-Infinity`) would have silently swept the
  matching legitimate per-run directory into `removed` and
  `rmSync`'d it from disk. Mirrors the iter-158 hardening of
  `aggregateRuns` on events.jsonl rows; defence in depth on the
  same class of bug for the index.jsonl side. The writer never
  emits `-Infinity` (`JSON.stringify(-Infinity) === "null"`),
  so this only ever bites a hand-edited or partially-corrupted
  index file — but a stuck-in-prune-loop user reporting "my
  legitimate runs keep disappearing" would have had no clue
  the corrupted-ts row was the cause. Pinned with a
  drift-guard test in `packages/tui/test/writer.test.mjs` that
  forges the `-1e500` literal in the JSONL line, asserts
  `JSON.parse` indeed yields `-Infinity`, runs `pruneRuns`,
  and verifies the legitimate run dir survives.
- `pruneRuns` (the engine behind `ralph-tui prune`) no longer
  treats an empty-string `runId` as a valid armed-row to delete.
  Pre-iter-159 the row filter at the top of the loop checked
  only `typeof obj.runId === "string"`, which an empty string
  passes; `isPathTraversalRunId("")` ALSO returns false (no `/`,
  no `\`, not `"."`, not `".."`). With both gates green, an
  index.jsonl row of the form `{"type":"armed","runId":"",
  "ts":1}` reached `path.join(root, "")` — which Node resolves
  to `root` itself — and `fs.rmSync(root, {recursive: true,
  force: true})` would have silently wiped the entire runs
  directory along with every legitimately-recorded run's
  events.jsonl. The writer never emits an empty runId
  (`makeRunId` requires a non-empty `label`), but a hand-edited
  or corrupted index.jsonl CAN — and `ralph-tui prune
  --older-than 0d` would have triggered the wipe immediately.
  Fix: extracted a centralised `isValidArmedIndexRow` helper
  used by BOTH `readRunIndex` and `pruneRuns`, with an explicit
  `obj.runId.length > 0` clause so an empty-string row is
  treated like the other malformed rows (skipped). The shared
  helper also closes the iter-154/155-style drift vector where
  a future hardening pass (e.g. an `obj.ts` finiteness guard)
  could land on one site and silently miss the other. Pinned
  by an end-to-end test in `packages/tui/test/writer.test.mjs`
  that writes a canary file at the runs root, prunes against a
  corrupted index containing an empty-runId row, and asserts
  both the root and the canary survive untouched.
  Mutation-verified: removing the `length > 0` clause fires
  the test red with the canary deleted.
- `aggregateRuns` (the engine behind `ralph-tui stats`) now
  guards `obj.iteration` with `Number.isFinite` before letting
  it advance the per-run `lastIter`. Pre-iter-158 the loop only
  checked `typeof obj.iteration === "number"`, which `Infinity`
  passes — and `JSON.parse('{"iteration": 1e500}')` yields
  `{iteration: Infinity}` because the literal overflows IEEE-754
  double precision. A hand-edited or corrupted events.jsonl row
  with such a literal would propagate into `iters.max =
  Infinity` and `iters.mean = NaN`/Infinity, silently breaking
  the stats output for the entire index. The writer never emits
  Infinity (`JSON.stringify(Infinity)` → `"null"`), so this only
  bites for hand-edits, but `aggregateRuns` is best-effort by
  contract: the surrounding `try/catch` already silently skips
  malformed JSON rows, so skipping a non-finite iteration value
  is the consistent behaviour. Pinned by a regression test in
  `packages/tui/test/writer.test.mjs` that hand-writes a
  `1e500` row alongside finite rows and asserts both `iters.max`
  and `iters.mean` stay finite (and reflect the surviving
  finite values). Mutation-verified: dropping the
  `Number.isFinite` guard fires the test red.
- `ralph_resume` now clamps `pausedFor` to `>= 0` symmetric
  with the `Math.max(0, …)` guard `finish()` already uses on
  the same window. Pre-iter-154 a system-clock rewind during
  a pause (NTP correction, manual clock change, daylight
  savings on a host without monotonic-time backing) would
  compute `Date.now() - pausedAt` as negative, credit a
  negative duration to `totalPausedMs`, and — because
  `totalPausedMs` is subtracted from `durationMs` in
  `finish()` — make the run's reported wall-clock LONGER
  than the true elapsed time. The caller also saw a
  nonsensical negative `pausedForMs` on the resume return
  value. The fix mirrors the existing finish-path clamp;
  happy-path behaviour is unchanged because `Math.max(0, X)`
  for non-negative `X` returns `X`. A regression test in
  `test/extension.test.mjs` shoves `pausedAt` into the
  future to simulate the skew and pins `pausedForMs >= 0`
  plus `totalPausedMs >= 0` post-resume.
- Removed three install artifacts that were accidentally
  swept into the repo via `git add -A` in iter 149's first
  commit (1f4f509): `.github/extensions/ralph/events-emit.mjs`,
  `.github/extensions/ralph/extension.mjs`,
  `.github/extensions/ralph/handler.mjs`. These are produced
  when `install.sh --project` runs from inside this repo (the
  script writes a working copy under `.github/extensions/ralph/`
  so tools that auto-load extensions from that path see the
  repo's own extension while a contributor dogfoods).
  Committing the working copy creates a SECOND source of
  truth that would drift from `extension/` on every iter.
  Added `.github/extensions/ralph/` to `.gitignore` so the
  next contributor running `./install.sh --project` from
  inside this repo cannot trip the same wire.
- `packages/tui/src/writer.mjs`'s `createEventWriter` now
  rejects path-traversal runIds (`"../escape"`, `"a/b"`,
  `"a\\b"`, `"."`, `".."`, `"with\0null"`) with the same
  TypeError contract its sibling readers and deleters have
  shipped since slice 5: `resolveRunEventsPath` (read path,
  line 47) and `pruneRuns` (delete path, line 361) both
  routed runIds through `isPathTraversalRunId`, but the
  primary write surface did not. Production runIds come
  from `makeRunId` and only contain `[A-Za-z0-9_-]`, so this
  is defensive — but it brings the read / write / delete
  paths into one lockstep contract: a hostile or corrupted
  runId can no longer escape the runs sandbox via
  `path.join(root, runId, "events.jsonl")` regardless of
  which surface the caller hits first. Pinned by a new test
  in `packages/tui/test/writer.test.mjs` covering seven
  documented traversal payloads plus a symmetry assertion
  that the canonical `makeRunId`-shape (e.g.
  `"ralph_loop-deadbeef"`) still constructs successfully so
  the guard rejects ONLY traversal payloads, never
  legitimate runIds. Regression catch verified by deleting
  the new `isPathTraversalRunId(runId)` block — only the
  targeted test fires.
- `packages/tui/bin/tui.mjs`'s `cmdReplay` and `cmdWatch`
  now follow each `fail(...)` call with an explicit
  `return 2`, matching the symmetry contract every other
  call site in the file already obeyed (`cmdList`, `cmdPrune`).
  Pre-iter-142 the empty-input branches did `if (!runId)
  fail(...)` without a trailing return; in production this
  was harmless because `fail` calls `process.exit(2)` which
  ends the process, but under a stubbed `process.exit`
  (test harness, future programmatic caller, REPL) control
  fell through into `resolveRunEventsPath(undefined)` which
  throws TypeError, so the caller saw a confusing stack
  trace instead of the clean "<runId> is required"
  diagnostic. `cmdReplay` is now exported from the bin so
  the symmetry contract can be pinned via a direct unit
  test that stubs `process.exit` + `process.stderr.write`
  and asserts a 2 return value with no TypeError
  fallthrough. Regression catch verified by reverting the
  fix — only the targeted test fires.
- `packages/tui/src/plain.mjs`'s `formatEventLine` now
  JSON-stringifies the `reason=` field iff the reason
  contains whitespace, so a user-supplied multi-word
  reason from `ralph_pause` / `ralph_stop` (e.g. "lunch
  break", "context window pressure", a flattened
  multi-line paste) renders as a single
  awk-/grep-parseable token. Pre-iter-137 these reasons
  emitted unquoted, so a `pause` event with
  `reason: "going to lunch"` rendered as
  `pause <runId> iter=N/M reason=going to lunch`,
  collapsing four extra tokens after `reason=` and
  silently mis-aligning every column to its right for
  scrapers that splat on whitespace. Mirrors the
  long-standing JSON.stringify treatment of the `note`
  field. Baked single-token reasons (
  `completion_promise`, `abort_promise`, `stagnation`,
  `max_iterations`, `send_error`, …) keep their
  historical UNquoted form so existing log scrapers don't
  suddenly see a quoted form on new runs. Pinned by a
  drift-guard test that exercises both branches plus the
  cross-property "exactly one whitespace-separated token
  starts with `reason=`" invariant on multi-word reasons,
  and also pins tab-bearing reasons (the `\s` regex
  catches `\t`, not just literal space).

- `install.sh --dry-run`'s "Installed:" line now distinguishes
  `(none)` (target `handler.mjs` is missing — legitimate fresh
  install) from `(unknown)` (target `handler.mjs` exists but
  `extract_handler_version` returns no parseable
  `export const VERSION = "X.Y.Z";` line — corrupt or
  partially-installed). Pre-iter-133 both states collapsed to
  `(none)`, which silently misled a user whose previous
  install was interrupted by ^C between the per-file `cp`
  calls (leaving a half-written `handler.mjs`) into thinking
  the dry-run reported "fresh install" when in fact the
  existing copy was corrupt. Distinct labels surface the
  recovery path (`(unknown)` → investigate before reinstall;
  `(none)` → just run `install.sh`). Pinned by a sandbox
  test that seeds a malformed handler.mjs with no VERSION
  declaration and asserts the new label renders verbatim
  while the regression to `(none)` is explicitly forbidden.
- `install.sh --project` now surfaces a distinct error when
  the `git` binary is missing from `PATH`, instead of
  conflating that case with "not inside a git repo". A
  pre-flight `command -v git` check fires before
  `git rev-parse --show-toplevel`, prints
  `Error: --project requires the 'git' binary in PATH, but
  it was not found.` + a Hint pointing at the user-scoped
  install path as a one-line recovery. Previously the
  `git rev-parse 2>/dev/null || true` swallowed the
  binary-missing exit code along with every other failure
  mode and surfaced the misleading "not inside a git repo"
  message — sending the user looking for a phantom repo
  rather than installing git. Pinned by a sandbox test that
  builds a minimal `PATH` containing only the coreutils
  install.sh exercises before the `--project` branch
  (`dirname`, `awk`) and asserts both the new error AND
  that the misleading wording is NOT what surfaces.
- `install.sh` now prints a friendly "Error: …/handler.mjs
  not found" + recovery hint when the source tree is missing
  `extension/handler.mjs` (e.g. a user copied only the script
  out of the repo without bringing the `extension/` subdir
  along). Previously the awk that extracts `VERSION` at the
  top of the script crashed with the cryptic `awk: can't open
  file …` and exit code 2 — the user had no clue which piece
  was missing or how to recover. The new guard mirrors the
  per-file friendly diagnostic that the later `FILES`
  existence loop already produces for every other file in
  the install set, so the error message is symmetric across
  all four sources. Pinned by a new test that runs `install.sh`
  in a sandbox dir without the `extension/` subdir and asserts
  the friendly stderr message + exit 1 (not awk's exit 2)
  + empty stdout.
- README's three manual-install `curl` loops (Option A
  user-scoped, Option B project-scoped, Option D pinned
  release) now download `events-emit.mjs` and `handler.mjs`
  BEFORE the `extension.mjs` entry point, matching the same
  leaf-first order `install.sh`'s `FILES` array maintains
  for atomic per-file installs (iter 113). Previously the
  README listed `extension.mjs handler.mjs events-emit.mjs`
  — entry point FIRST — so a slow link or a `/extensions
  reload` firing mid-curl could leave the SDK loading the
  new entry point against missing/old siblings (the exact
  torn-import scenario `install.sh` painstakingly avoids).
  A drift-guard test now reads `install.sh`'s `FILES=` line
  as the source of truth and asserts every README `for f in
  …; do` loop covering the runtime modules uses the same
  order verbatim, so the two install paths can never silently
  diverge again.
- `events-emit.mjs` `clipExcerpt` no longer splits a UTF-16
  surrogate pair when truncating a long excerpt at the
  `MAX_EXCERPT_CHARS` (500) boundary. Previously, an emoji
  or astral-plane char landing exactly at index 498/499
  produced a lone high surrogate in the JSONL line —
  technically valid UTF-16 but renders as a replacement
  glyph in most terminals AND breaks any consumer doing
  strict UTF-8 validation downstream (e.g. a Python tail
  of `events.jsonl` with `errors='strict'`). The fix
  mirrors `handler.mjs`'s `safeSliceEnd`: when the last
  kept code unit is a high surrogate, back off by one so
  the pair stays intact (we drop a single astral char
  rather than emit a lone half). Pinned by a regression
  test that constructs an excerpt with `💀` (U+1F480)
  straddling the boundary and asserts every high surrogate
  in the clipped output is followed by a low surrogate.
- `install.sh` now surfaces a friendly diagnostic when
  `mkdir -p "$TARGET_DIR"` fails (parent is a regular file,
  parent is read-only, ENOSPC, etc) — the previous bare
  `mkdir -p "$TARGET_DIR"` let `set -e` bail with mkdir's
  raw OS error alone, which tells a contributor WHAT failed
  but not how to recover. The new guard captures stderr,
  surfaces the underlying error, and prints a recovery hint
  pointing at `--project` as the alternate path. Two tests
  pin the behaviour end-to-end (sandbox $HOME=regular-file
  → exit non-zero with the three-part diagnostic) and the
  source-level guard wrapper (so a future "shorten
  install.sh" PR can't quietly drop the recovery hint).
- `install.sh` now exits 0 on a successful install. Every
  install.sh test before this fix used `--dry-run` (which
  exits before the EXIT trap is armed), so a latent bug in
  the `cleanup()` trap was invisible: when every temp file
  had been consumed by its `mv`, the trap's per-file
  `[[ -e $tmp ]] && rm -f $tmp` returned false, and bash
  propagated that as the script's exit code — meaning a
  clean install ALWAYS reported failure to the caller even
  though every byte landed correctly. Added a trailing
  `return 0` to `cleanup()` plus two tests: an end-to-end
  install in a sandbox HOME asserting exit 0, and a
  source-level drift guard pinning the explicit `return 0`
  so a future refactor can't silently re-introduce the bug.
- `resolveRunsRoot` now `.trim()`s the `RALPH_EVENTS_DIR`
  override before returning it. Shells routinely leak stray
  leading/trailing whitespace into env vars (heredoc
  redirects, copy-paste, Makefile interpolation), and the
  unfiltered value silently created runs roots whose name
  contained literal whitespace — breaking the matching
  `ralph-tui list` glob. Internal whitespace (e.g. macOS
  volume paths like `/Volumes/My Drive/runs`) is preserved.
- `extension/events-emit.mjs` `createEventEmitter.write()`
  now rejects arrays up front. Previously `typeof [] ===
  "object"` and `!ev` was `false`, so an array would fall
  through to `serialize()` where `{ ...ev }` turned
  `[1,2,3]` into `{"0":1,"1":2,"2":3}` — a malformed event
  with no `type` field that polluted `events.jsonl` and
  tripped the TUI's "skipped: missing type" path per line.
  Now arrays (including `[]` and arrays-of-objects) are
  silently dropped on entry, matching the existing
  null/non-object behaviour. Drift-guarded.
- `ralph_loop` now reports an actionable "Shorten the prompt by
  at least N character(s)" hint when a user prompt + the
  commit-attribution rider would exceed `MAX_PROMPT_CHARS`
  (65 536). The previous wording stopped at "Shorten the
  prompt." — leaving the user to subtract `MAX_PROMPT_CHARS`
  from `got` themselves. Also drops the misleading `~` prefix
  on the reserved-bytes count: that value is computed at
  runtime from the actual rider length, so it is exact, never
  approximate. Pluralisation flips correctly between
  `1 character.` and `N characters.`.

### Refactor
- Extracted `safeResolveEventsPath(label, runId)` helper
  in `packages/tui/bin/tui.mjs` and routed both
  `cmdReplay` and `cmdWatch` through it. Both commands
  previously open-coded the same try/catch wrapper (added
  in iters 167 and 168) that caught the `TypeError`
  thrown by `resolveRunEventsPath` for path-traversal
  runIds, emitted a one-line error via `fail()`, and
  returned exit code 2. Centralising the wrapper keeps
  the two call sites a single line apiece and means a
  future tweak — a new traversal clause raising a
  different error type, or a third command needing the
  same guard — lands in one place rather than drifting
  between two. The helper returns the resolved events
  path on success or `null` on the bail path (the
  caller still emits the correct exit code). Existing
  iter-167 (`cmdReplay`) and iter-168 (`cmdWatch via
  main()`) traversal-runId tests cover both routes
  unchanged.

- Extracted `iterJsonlRows(raw)` generator in
  `packages/tui/src/writer.mjs` and routed the three
  formerly-duplicated JSONL line-iteration sites through it:
  `readRunIndex` (index.jsonl), `aggregateRuns`'s events.jsonl
  inner loop, and `pruneRuns` (index.jsonl). Each site
  previously open-coded the same five-step pattern (split
  on `\n`, trim, skip-empty, JSON.parse with try/catch skip,
  yield row), and a future hardening pass — e.g. handling
  `\r\n` on Windows-edited files, or rejecting a specific
  `obj` shape early — would have to land in three places.
  Centralising the iterator means a single edit propagates
  to every reader. The helper yields `{ obj, trimmed }` so
  `pruneRuns` can rewrite surviving entries verbatim without
  re-stringifying. Tolerant of non-string input (returns
  nothing) so a future caller passing `undefined` from a
  missing-file path doesn't crash, mirroring the file-level
  best-effort policy. Exposed via the `__test__` bag and
  pinned with three direct unit tests
  (`packages/tui/test/writer.test.mjs`) covering empty/
  non-string input, mixed valid/empty/malformed rows with
  trim semantics, and all-whitespace-or-broken input.
  Behaviour preserved — all 674 pre-existing tests stayed
  green through the refactor; mutation-verified that
  removing the parse-error try/catch fires 4 failures.
- Extract `pauseElapsedFromAt(pausedAt, now)` helper in
  `extension/handler.mjs` and route the three formerly-
  duplicated pause-elapsed call sites — `finish()`,
  `ralph_status`, and `ralph_resume` — through it. Each
  site previously open-coded `pausedAt > 0 ? Math.max(0,
  now - pausedAt) : 0` (the never-paused sentinel + clock-
  skew clamp), and pre-iter-154 the `ralph_resume` site
  had drifted off the clamp entirely (fixed iter 154).
  Centralising the expression makes that drift mechanically
  impossible to reintroduce. The helper is exported via the
  `__test__` bag and pinned with a direct unit test in
  `test/extension.test.mjs` covering the never-paused
  sentinel, the happy-path subtraction, and the backward-
  skew clamp. Behaviour preserved (verified by the existing
  664 tests staying green pre- and post-extract).
- `packages/tui/src/writer.mjs`'s two throw-on-traversal call
  sites (`resolveRunEventsPath` and `createEventWriter`) now
  route through a shared `assertSafeRunId(fnName, runId)`
  helper instead of each open-coding the same `if
  (isPathTraversalRunId(runId)) throw new TypeError(...)` two
  lines. Behaviour preserved (same `TypeError`, same
  `<fnName>: runId "<runId>" contains path separators or
  traversal segments` message format, same fail-before-fs
  guarantee), but the consolidation removes the drift hazard
  that would let one site update its message wording while the
  other quietly keeps the old form. `pruneRuns` continues to
  call `isPathTraversalRunId` directly because its policy is
  "silently skip the row, keep the survivor in the index"
  rather than "throw". A new test in
  `packages/tui/test/writer.test.mjs` pins the contract that
  every caller prefixes its own function name in the
  `TypeError` message so a stack-truncated error log still
  identifies which surface rejected the runId.
- `packages/tui/src/components/Timeline.mjs`'s private
  `truncate` helper is now wired through the shared
  `safeSliceChars` utility (already used by `plain.mjs` and
  `serializeEvent`) so a 4-byte emoji landing on the
  truncation boundary backs off cleanly instead of emitting a
  lone high-surrogate code unit + "…" to the terminal frame.
  Pre-iter-140 the helper called `flat.slice(0, n - 1)`
  directly; the same data shown via `ralph-tui watch --plain`
  was already surrogate-safe (plain.mjs has used
  `safeSliceChars` since iter 110), so the asymmetry between
  the two render paths was a real hazard nobody surfaced.
  `truncate` is now exported as a named member of
  `Timeline.mjs` so the surrogate-safety contract can be
  pinned with a direct unit test instead of squinting at
  Ink-rendered frames. Pinned by four tests in
  `packages/tui/test/components.test.mjs`: short-string
  pass-through, whitespace flatten, overflow → ellipsis, and
  the surrogate-safe back-off path including a "no lone
  surrogate code units appear in the rendered output"
  invariant scan.

### Internal
- `extension/prompts.mjs` — both baked SDLC prompts
  (`PROMPT_SELF_IMPROVE` and `PROMPT_GROW_PROJECT`) gain a
  `STRUCTURED MARKERS` preamble after the existing `STAGE
  MARKERS` preamble, instructing the agent to additionally
  emit the 7 structured markers
  (`[WORKITEM_START|WORKITEM_END|STAGE_PLAN|STAGE_PLAN_AMEND|TASK_LIST|TASK_START|TASK_END: {…}]`)
  one-per-line as it walks the work item → flex stage plan →
  per-stage task list hierarchy specced by issue #48 slice 9.
  Strictly additive over the existing SDLC body — the agent
  still walks the full STAGE-marker workflow, the new markers
  decorate the workflow with structured progress narration.
  Explicitly states that `STAGE_PLAN.stages` must NOT include
  `COMMIT` / `PUSH` / `END` (the runner appends those as the
  canonical pinned tail), that JSON bodies must be on a single
  line, that markers must not appear inside fenced code blocks
  / quoted text, and that missing or malformed markers are
  silently dropped (so the loop's termination logic is
  unaffected). The load-time parity guards
  (`PROMPT_*` must contain `COMPLETION_PROMISE` and the matching
  abort token) and the leak guards (no internal extension tool
  names in either prompt) continue to pass.

- Extracted the baked SDLC prompts (`PROMPT_SELF_IMPROVE`,
  `PROMPT_GROW_PROJECT`) and their abort tokens
  (`BAKED_ABORT_TOKEN`, `BAKED_BACKLOG_ABORT_TOKEN`) plus the
  `COMPLETION_PROMISE` token into a new pure-stdlib production
  module `extension/prompts.mjs`. Both `extension/handler.mjs`
  (the in-session loop runner) and the upcoming `ralph-tui run`
  driver (which spawns each iter as a fresh `copilot -p ...`
  subprocess and therefore lives in `packages/tui/`) now import
  the same prompt source — the in-session and out-of-session
  loops cannot drift in prompt body. `install.sh` ships
  `prompts.mjs` alongside the existing extension files in
  leaf-first order (`events-emit.mjs prompts.mjs handler.mjs
  extension.mjs` — entry point last so a concurrent
  `/extensions reload` mid-install can never see a new entry
  against old siblings). Pure refactor; load-time parity
  guards for completion/abort tokens moved with the prompts.
  No behaviour change; all 688 existing tests pass unchanged.
- Extended the syntax-check coverage roots in
  `.github/workflows/ci.yml` and `scripts/check.mjs`
  (`npm run check`) to include `scripts/`. Pre-iter-170 a
  syntax error in any `scripts/*.mjs` helper (including
  `scripts/check.mjs` itself) would silently sail through both
  the bash "Syntax check" CI step and the portable mirror —
  the former scoped its `find` to `extension packages/tui/src
  packages/tui/bin`; the latter pinned the same three roots in
  its `ROOTS` array. Local file count moves from 14 → 15. The
  existing iter-62 drift-guard at
  `test/extension.test.mjs:7066` already pins both surfaces in
  lockstep, so the iter-170 update touched both together; the
  matching iter-67 hard-coded `find` regex at
  `test/extension.test.mjs:5225` was updated to expect the new
  fourth root. Mutation-verified by reverting either surface
  individually (1 failure for `scripts/check.mjs`, 2 failures
  when the CI step also drops `scripts`).
- Aligned `packages/tui/package.json` metadata with the root
  package: added the missing `repository` (with
  `directory: "packages/tui"` so npm's monorepo subdir hint
  points at the right path), `bugs`, `homepage`, `author`, and
  `keywords` fields. The TUI is shipped via the dogfood install
  path and documented as `npx ralph-tui` in `docs/faq.md`; if
  the `private: true` flag is ever flipped on a release branch,
  registry/source links would have silently degraded without
  these fields. A drift-guard test in
  `packages/tui/test/bin.test.mjs` pins the TUI's
  `repository.url`, `bugs.url`, and `author` to match the root
  `package.json` — a future edit to either side forces a
  matching edit to the other.
- Added the missing `"author": "Taras Kloba"` field to
  `package.json`, matching the canonical copyright holder
  declared in `LICENSE` since the repo was created. Tooling
  that scrapes the npm manifest (GitHub project surfacing,
  third-party SBOM extractors, the npm registry's
  private-package metadata view) was previously seeing a
  package with no author. Pinned both files in lockstep with
  a drift-guard test in `test/extension.test.mjs` so a future
  edit to either side forces a matching edit to the other —
  one of the two metadata sources moving without the other
  would silently attribute the package to a stale name.
- `packages/tui/src/plain.mjs`'s `formatTimestamp` now also
  collapses out-of-range finite inputs to the
  `"??:??:??.???"` sentinel. Pre-iter-144 the only guard was
  `!Number.isFinite(ts)`, which is necessary but not
  sufficient: JS Date tops out at ±8.64e15 ms (100M days
  from epoch), so a finite-but-unrepresentable value
  (`Number.MAX_SAFE_INTEGER`, or a corrupted events.jsonl
  row that lost a digit) constructed an Invalid Date whose
  `getUTC*` accessors all returned NaN — rendering the
  16-char string `"NaN:NaN:NaN.NaN"` instead of the 12-char
  sentinel and silently knocking every column to its right
  out of awk/grep alignment. The new
  `Number.isNaN(d.getTime())` guard backs straight off to
  the same sentinel, keeping the single-line column
  contract awk-stable regardless of how the upstream `ts`
  got mangled. Pinned by a 4-assertion test in
  `packages/tui/test/plain.test.mjs` covering both
  out-of-range bounds, `MAX_SAFE_INTEGER`, and a symmetry
  check that the JS Date upper bound itself
  (`8.64e15`) still renders normally so the guard stays
  exact rather than an over-broad sledgehammer that would
  clip plausible far-future timestamps.
- `packages/tui/src/events.mjs`'s `serializeEvent` now caps the
  `reason` field at 500 chars (surrogate-safely via
  `safeSliceChars`) for symmetry with the long-standing caps on
  `note` and `excerpt`. Caller hygiene already enforced this
  upstream — `parseUserReason` in `extension/handler.mjs`
  routes user-supplied `ralph_pause` / `ralph_stop` reasons
  through `boundedNoteForLog` which caps at PREVIEW_CHARS=500,
  and the baked-token reasons (`completion_promise`,
  `abort_promise`, `stagnation`, `max_iterations`,
  `send_error`, …) are all under 30 chars — so no current
  callsite trips the cap. The cap is defensive: a future code
  path that emits a `reason` directly without going through
  `parseUserReason` cannot bloat events.jsonl past the 16 KB
  per-line ceiling on a single pathological input. Pinned by
  a four-branch test exercising overflow-truncation,
  under-cap pass-through, surrogate-pair-safe back-off (a 501
  UTF-16-unit reason ending in 💀 must truncate to 499, not
  emit a lone high surrogate at index 499), and the
  combined-line-stays-under MAX_EVENT_LINE_BYTES invariant.

- `install.sh` now extracts `export const VERSION = "X.Y.Z";`
  from `handler.mjs` via a single shared
  `extract_handler_version()` shell helper, replacing the two
  duplicated `awk -F'"'` invocations (one for the source-tree
  VERSION at script start, one for the target-tree
  "Installed:" line landed in iter 127). The duplication had
  drift potential: a future refactor tightening the regex on
  one site (e.g. allowing `let` declarations, or migrating to
  a different shape) would silently misreport one of the two
  versions on otherwise-valid input, making the dry-run
  "Installed: vA.B.C" / "Version: vX.Y.Z" pair disagree on
  identical input. Pinned by a new test asserting the awk
  pattern appears in install.sh exactly once (inside the
  helper) and that ≥2 callers route through it.
- Extract `safeSliceChars(s, max)` as a shared exported helper
  in `packages/tui/src/events.mjs`, generalising the iter 117
  `safeSlice500` (now removed). `serializeEvent`'s 500-char
  excerpt/note cap and `plain.mjs`'s 80-char excerpt cap now
  share the same surrogate-safe boundary check rather than
  open-coding the off-by-one guard at every call site. As a
  follow-on bug fix, `plain.mjs`'s `formatEventLine` excerpt
  cap is now surrogate-safe — pre-iter-119 the cap used a
  naive `.slice(0, 80)` which would keep a lone high surrogate
  when an emoji landed at the boundary; `JSON.stringify` then
  rendered the lone half as a verbose `\uD83D` escape in the
  `tail -f`'d line, surprising the user. Pinned by a
  regression test in `packages/tui/test/plain.test.mjs`.
- `packages/tui/src/events.mjs`'s `serializeEvent` now uses
  a surrogate-safe truncation helper (`safeSlice500`) for
  the `excerpt` and `note` fields rather than a naïve
  `s.slice(0, 500)`. Mirrors iter 115's
  `extension/events-emit.mjs` `clipExcerpt` fix so every
  disk writer in the workspace is surrogate-safe — defence
  in depth: the production writer pre-truncates already,
  but a future TUI-emitted event or a third-party consumer
  of `serializeEvent` reaching this boundary cannot produce
  a lone high surrogate. Pinned by two regression tests
  (one for `excerpt`, one for `note`) in
  `packages/tui/test/events.test.mjs` that walk every code
  unit of the truncated output asserting every high
  surrogate is paired with a low surrogate.
- `install.sh` reorders the `FILES=(…)` array so the entry
  point `extension.mjs` is moved LAST (was first). The
  Copilot CLI loads `extension.mjs` and that file imports
  `handler.mjs` + `events-emit.mjs`; replacing the entry
  last means a concurrent `/extensions reload` mid-install
  either sees the old fully-coherent set (entry not yet
  replaced → still imports the intact original siblings) or
  the new fully-coherent set (entry replaced → imports the
  already-replaced new siblings). It can never see an old
  entry against new siblings whose API may have shifted.
  Surgical reorder + drift-guard test pinning extension.mjs
  as the trailing element.
- Untrack the `package-lock.json` exclusion in
  `packages/tui/.gitignore` and commit the existing 631-line
  lockfile. Iter 103 wired up Dependabot for the
  `/packages/tui` npm ecosystem, but Dependabot's npm
  scheduler REQUIRES a committed lockfile to compute
  deterministic CVE-patch PRs — without it the entry was
  effectively a no-op. The original "the lock would balloon
  the diff" rationale (commit `8b1c202`) no longer holds
  now that lockfile-driven Dependabot updates ship as
  Conventional-Commit `chore(deps)` PRs. Drift-guarded so
  a future re-introduction of the gitignore exclusion (or a
  `git rm` of the lockfile) surfaces as a test failure.
- Replace the stub `.github/dependabot.yml` (`package-ecosystem:
  ""` — an invalid ecosystem string Dependabot silently ignored)
  with two real update streams: `github-actions` at repo root so
  the SHA-pinned workflow `uses:` references in `ci.yml`,
  `release.yml`, and `docs.yml` get weekly bump PRs; and `npm` at
  `packages/tui` so the TUI's ink / react / commander deps
  receive CVE patches. Both streams use `chore(deps)` as the
  Conventional-Commit prefix per AGENTS.md §2 and Monday-weekly
  scheduling. Drift-guard pins absence of the stub plus presence
  of both ecosystems and the correct `directory` for npm
  (root has zero deps + no lockfile — pointing npm at `/` would
  always error out with "no lockfile found").
- Added `.editorconfig` capturing the project's existing
  whitespace conventions (LF EOL mirroring `.gitattributes`,
  4-space `*.mjs`, 2-space `install.sh` + `*.yml`,
  trim-trailing-whitespace except in `*.md` to preserve
  CommonMark hard breaks). EditorConfig-aware editors (VS
  Code, JetBrains, Vim, Emacs, Sublime, …) now land on the
  right indent / EOL automatically — without each contributor
  re-configuring per-project. Drift-guarded so the five facts
  that matter (EOL, charset, final-newline, plus per-language
  indent sizes) cannot silently rot.

### Tests
- Issue #48 slice 9 commit 4 — end-to-end smoke test that drives
  `runRalphTui` with the full marker stream (`workitem_start →
  stage_plan → task_list → task_start → tool_complete (git
  commit) → task_end → workitem_end → COMPLETE`) and asserts
  every slice 9 event type fires exactly once, the marker
  payloads round-trip intact, the runner-side `commit_observed`
  detector fired (including idempotent per-toolCallId behaviour)
  with both `git rev-parse` + `git log` shell-outs invoked
  exactly once each, and the `foldEvents` snapshot stitches
  everything into a renderer-ready shape (`completedWorkItems`
  has the closed item, `currentPlan.stages` matches the agent's
  STAGE_PLAN, `currentTaskList.stage` = "FIX",
  `lastCommit.{sha,subject}` = the stubbed HEAD). End-to-end
  proof that the L1/L2/L3/footer hierarchy works through the
  whole pipeline (markers → runner emit → JSONL events →
  foldEvents snapshot → renderer-consumable shape) without
  needing a real `copilot` binary or a real git repo. Pins the
  contract so a future runner refactor that drops one of the
  marker passes, the substage fan-out, or the `commit_observed`
  trigger fails this test loudly.

- Pinned that `ralph_pause`'s idempotent branch returns the
  FIRST (committed) `reason` to the caller, not the second
  caller's `reason`. The pre-existing iter-116 test pinned
  that `state.active.pauseReason` stays "first" after a
  redundant pause, but the no-op success ALSO returns
  `reason` to the caller. Without this guard, a refactor
  that swapped the idempotent-branch return to
  `args?.reason ?? null` (or, worse, dropped the `?? null`
  and let `undefined` ride out) would silently leak the
  second caller's reason into the success payload — an
  automation polling `ralph_pause({reason})` to confirm
  pause state would see its own input echoed back rather
  than the original reason that the user typed in the
  first (effective) pause. Pin both the returned `reason`
  field AND the single-line `textResultForLlm` rendering
  (`already paused at i/max (first)`) so a regression in
  either surface fires this test. Mutation-verified by
  flipping `a.pauseReason` to `args?.reason ?? null` in
  the idempotent return — the new test fails, existing
  tests stay green (the gap was real).

- Pinned the cmdWatch half of the iter-167 traversal-runId
  catch via the supported `main(["watch", "../etc/passwd",
  "--plain"])` entry point. Pre-iter-168 only `cmdReplay`'s
  catch was directly exercised; without this companion test a
  future "simplify" refactor could quietly drop the catch on
  one entry point while leaving the other intact, and CI
  would not notice. The new test stubs `process.exit` and
  `process.stderr.write`, asserts a clean `watch:` prefix on
  the stderr line, and asserts no raw stack frames leak —
  mutation-verified by reverting cmdWatch to the bare
  `resolveRunEventsPath(target)` call (1 failure).
- Pinned the second-pass salvage branch in
  `extension/events-emit.mjs`'s `serialize()` — the path that
  strips `excerpt` + `note` and re-serializes when the first
  JSON pass exceeds the 16KB hard line cap. Pre-iter-164 the
  salvage was tested only in the unsalvageable direction
  (32KB junk in a non-clip field — drops); the salvageable
  direction was unguarded, so a future "simplify" refactor
  collapsing the two passes into a single drop-on-overflow
  would silently start losing every legitimate event whose
  excerpt + payload combined to exceed 16KB. New test in
  `test/events-emit.test.mjs` synthesises an event whose
  first-pass byte length is over cap but second-pass (after
  stripping the two clip-eligible fields) fits, asserts
  exactly one line is appended, that the line stays under the
  16KB cap, and that `type` / `runId` / `iteration` / `payload`
  survive while `excerpt` / `note` are gone.
  Mutation-verified: collapsing the salvage to an immediate
  drop fires the test red (actual=0, expected=1 captured).
- Behavioural coverage for `readRunIndex`'s rejection of
  empty-runId / missing-runId / non-string-runId rows in
  `packages/tui/test/writer.test.mjs`. The iter-159 fix
  centralised the row-validation predicate into
  `isValidArmedIndexRow` (used by BOTH `readRunIndex` and
  `pruneRuns`), but iter 159 only pinned the new
  `obj.runId.length > 0` clause end-to-end via the pruneRuns
  data-loss canary test. Without a matching read-path pin, a
  future maintainer who re-inlines the helper "because it
  looks redundant" — or who refactors it into per-clause
  checks — could silently drop the empty-runId rejection on
  the read side; the TUI's `list` / `watch` / `replay`
  commands would then start trying to render `{runId: ""}`
  entries and fail in increasingly opaque ways. New test
  writes index.jsonl with four invalid shapes (empty string,
  missing field, number, null) plus one legitimate row and
  asserts only the legitimate row survives. Mutation-
  verified: dropping the `length > 0` clause fires both this
  test AND the iter-159 pruneRuns canary red.
- Pin `formatEventLine`'s `min=N` segment as type-gated to
  `armed` events in `packages/tui/test/plain.test.mjs`. The
  defensive `&& ev.type === "armed"` clause in plain.mjs
  ensures a corrupted events.jsonl row replayed by the TUI
  tail mode that smuggles in a stray `minIterations` on a
  non-armed event (e.g. iteration_end / pause / resume /
  abort) cannot render an extra `min=N` segment and break
  awk/grep column alignment downstream. Pre-iter-156 only
  the positive case (armed-with-min) was pinned, so a
  refactor that dropped the type-gate would have slipped
  through. New test loops over the seven most-trafficked
  non-armed event types and asserts `min=` does NOT appear.
- Pin `describeArgType` and `displayValue` validation helpers
  with direct unit tests in `test/extension.test.mjs`. Both
  helpers feed every "(got X)" tail in the extension's
  user-facing error messages (validateArgShape,
  validateOptionalReasonField, parseFocus, validatePromise-
  Field, the listener-returned-non-function warning) but
  pre-iter-152 had zero direct coverage — a regression that
  dropped `describeArgType`'s null special case (so a caller
  passing `null` would be told "got object") or that swapped
  `displayValue`'s `JSON.stringify` for plain `String()` (so
  empty / whitespace-only strings rendered as invisible
  blanks) would have slipped past every existing test. The
  new tests pin both special cases (null, array) plus the
  typeof passthrough for describeArgType, and pin string-
  quoting + the NaN/Infinity-via-String contract for
  displayValue. Both helpers are now exported from the
  `__test__` bag for direct exercise.
- Pin `install.sh`'s `reject_duplicate --project` arm with a
  sibling assertion to the existing `--dry-run --dry-run`
  test in `test/extension.test.mjs`. The reject_duplicate
  helper takes the sentinel name as a runtime parameter and
  is invoked from BOTH the `--dry-run` and `--project` arms,
  but pre-iter-149 only the `--dry-run` half had a regression
  test. A future "simplify" pass that accidentally inlined
  the guard for one flag and dropped it for the other would
  have shipped a silently asymmetric duplicate-flag
  rejection. The new assertion exercises `--project --project`
  end-to-end and pins the stderr wording (`--project
  specified more than once`) so the offending flag is named
  in the error — without that, a copy-paste typo turns into
  a confusing "more than once" with no hint which flag
  doubled up.
- Pin the three caffeinate env-parser helpers
  (`isCaffeinateEnabled`, `resolveCaffeinateScope`,
  `caffeinateFlagsForScope` in `extension/handler.mjs`) with
  direct unit tests in `test/extension.test.mjs`. Pre-iter-145
  the helpers were exercised only end-to-end through the
  `armWithCaffeinate` integration suite, which covers `"1"` /
  `"idle+display"` / `"bogus"` but never the case + whitespace
  tolerance every other env knob in the project ships
  (`RALPH_CAFFEINATE=TRUE`, `=" yes "`, `=ON` all enable;
  `RALPH_CAFFEINATE_SCOPE=IDLE+DISPLAY` resolves to
  `idle+display`). The three new tests pin the truthy set
  including capitalisation + whitespace, the falsy default
  including non-string `env` arguments and non-string values
  (boolean / number / object / array) so a future refactor
  swapping in a shared env-truthy helper can't silently
  tighten the truthy contract, and the
  `caffeinateFlagsForScope` fall-through ensuring any value
  other than `"idle+display"` defaults to `-i` (idle-only)
  rather than the more invasive `-id` (idle + display) — a
  defensive contract that protects callers who bypass the
  normaliser. Regression catch verified by mutating each
  helper independently — the targeted helper-direct test
  fires alongside the existing integration test, confirming
  the new tests add genuine coverage rather than overlapping
  the integration ladder. Helpers added to the `__test__`
  export bag at `extension/handler.mjs:2570`.
- Pin `packages/tui/src/tail.mjs`'s under-covered
  input-validation contracts so a future "simplify the tail
  surface" PR can't silently drop the typeof guards. Added
  five tests covering: `readEventsFile` rejects non-string
  `filePath` with `TypeError`; rejects empty-string
  explicitly (the regression case where dropping the
  `|| !filePath` clause would let `""` fall through to
  `fs.readFileSync("", …)` and surface a confusing platform-
  dependent error); ENOENT is the ONE error code that
  collapses to `[]` (everything else propagates unchanged so
  operators see real failures); EACCES propagation is
  pinned via injected fake fs; `splitAndParse` returns `[]`
  for non-string input (defensive contract used by the
  plain-mode renderer + tests). Regression catch verified by
  removing the empty-string guard — only the targeted test
  fires.
- Pin `ralph_resume`'s `totalPausedMs` accumulator across
  multiple pause/resume cycles. The handler does
  `a.totalPausedMs += pausedFor` — the `+=` is load-bearing.
  A future "simplify" that wrote `= pausedFor` would silently
  lose every prior pause window: a user who paused twice
  would see `total_paused_ms` reflect only the most recent
  pause, and `finish()`'s `durationMs = wallClock −
  totalPausedMs` calculation would over-bill the earlier
  pause's wall-clock time as "running" when it wasn't. The
  new test injects deterministic 1500ms + 800ms pause windows
  via direct `pausedAt` backdating, then asserts the
  accumulator sums to ~2300ms (not ~800ms). A belt-and-braces
  assertion explicitly forbids the regression shape (post-
  second-resume value at-or-below the first cycle's
  contribution) with a hint pointing at `+=` vs `=`.
- Pin `plain.mjs`'s `formatEventLine` rendering for
  `iteration_start` (verb `iter+`) and `abort` (verb
  `abort`) events. Until iter 132 these two verbs only
  had indirect coverage through the `armed` and
  `iteration_end` tests; a refactor that renamed
  `iteration_start` → `iter_start` in the VERB map (or
  dropped the `abort` mapping entirely) would have
  silently regressed `tail -f`'d log column alignment to
  printing the raw event-type string. New tests assert
  the verb literal AND the surrounding render contract:
  `iter+` carries `runId` + `iter=N/M` but no
  `tokens=`/`excerpt=`; `abort` carries `runId` +
  `reason=` and optionally `note=` but never the per-iter
  `iter=` segment (since the event uses `iterations`
  plural rather than `iteration` singular).
- Pin `install.sh -h` short flag as a byte-identical
  alias of `--help`. The case arm (`--help|-h)`) covers
  both forms, but only the long form was directly
  exercised — a future split that accidentally
  short-circuits `-h` (e.g. moving it to a handler that
  forgets to call `print_help`) would have shipped
  silently. The new test asserts exit 0 + byte-equal
  stdout + presence of the canonical `Usage:` line +
  empty stderr, mirroring the `-V` alias coverage from
  iter 123.
- Pin that `ralph_pause` is idempotent on the JSONL emit
  side too — exactly ONE `pause` event written to the
  durable event stream per logical pause, regardless of
  how many times `ralph_pause` is called. The handler's
  in-memory state is already pinned idempotent (the
  second call returns success without mutating state),
  but the emitter side had no test guarding against a
  refactor that accidentally moved `safeEmit({ type:
  "pause", ... })` above the early-return short-circuit
  — such a regression would emit duplicate JSONL entries
  and corrupt the pause-state fold any TUI consumer or
  downstream tool computes over the event stream.
- Direct unit-test coverage for `safeSliceChars`'s
  defensive guards (extracted in iter 119): non-string
  input → returned unchanged (null, undefined, number,
  boolean, object identity preserved); non-finite or
  invalid max → returned unchanged (NaN, Infinity,
  -Infinity, 0, -1); short input (length ≤ max) →
  fast-path returns identity; ASCII at the boundary →
  sliced to exactly `max`; high surrogate at index
  `max-1` → backed off by one (length = max-1); low
  surrogate at `max-1` (pair fully captured) → no
  back-off (length = max). The two existing call sites
  (serializeEvent + formatEventLine) only exercise the
  string + finite-max happy path, so the helper's
  defensive branches were untested — pin them so a
  future "simplify" PR can't silently drop the guards.
- Pin the emitted `pause` JSONL event's `reason` field to
  `null` when the user supplies no reason (`{}`) OR a
  whitespace-only reason. The existing test only pinned the
  explicit-string form; the no-reason / whitespace branches
  were drift-prone — `parseUserReason` collapses them to null
  at the boundary, but nothing was asserting that null
  actually rides the field downstream TUI consumers parse.
  Two new tests in `test/handler-events.test.mjs` exercise
  the recording-factory path and additionally assert the
  `reason` key is present (not missing) so downstream
  consumers using `"reason" in ev` cannot regress on shape.
- Pin the documented `ralph_status` one-line summary format
  for the paused-without-reason branch:
  ` (PAUSED, for {ms}ms)` (no em-dash). The em-dash-with-
  reason path was already pinned, but the no-reason path —
  the format `docs/concepts.md` explicitly documents — was
  never asserted, so a future ternary refactor could have
  silently rendered ` (PAUSED — , for {ms}ms)` (stray
  em-dash with empty reason slot). Two new tests pin the
  bare form for both an absent `reason` argument and a
  whitespace-only reason that `parseUserReason` collapses to
  null end-to-end.
- Pin install.sh's `--dry-run` `[overwrite]` annotation
  branch (target file exists but differs from source). Iter
  101 shipped per-file new/overwrite/unchanged tags but the
  test coverage only exercised the `[new]` and `[unchanged]`
  cases — a regression that collapsed unchanged + overwrite
  into one bucket would have shipped silently. The new test
  pre-populates the sandbox HOME with a stub payload
  (guaranteed to differ from the real source) and asserts
  every file annotates as `[overwrite]` with `0 new, N
  existing` in the Changes summary.
- Drift guard: `release.yml`'s `setup-node` pin (currently
  `node-version: "20"`) must equal `package.json#engines.node`'s
  floor major. Mirrors iter 94's guard for `ci.yml`'s matrix
  lowest entry — if a future engines bump forgets to update
  the release runner, tagged releases would silently ship from
  a runtime the project no longer claims to support. Test scans
  every `node-version: "..."` declaration so a future second
  job (notify, post-publish smoke) is automatically covered.
- Behavioural coverage for `extension/events-emit.mjs`'s
  `createEventEmitter.write()` and its 3-tier `serialize()`
  fallback (issue #22's "swallow every error" contract): tier-1
  happy path, tier-1 excerpt-clip to MAX_EXCERPT_CHARS, tier-2
  drop excerpt+note when the full JSON exceeds 16 KB, tier-3
  silent-drop when even tier-2 still trips the byte cap, plus
  the `armed` event's index-file side-effect that the TUI's
  `readRunIndex` filters on. Previously the only coverage was
  via integration tests that emit events as a side-effect — a
  regression in the byte-cap fallback could have silently
  corrupted JSONL output without surfacing in any test.
- Drift guard: `ci.yml`'s `matrix.node` lowest entry must equal
  `package.json#engines.node`'s floor major. Mirrors the
  existing `.nvmrc` ↔ `engines.node` pin so a future engines
  bump that forgets to prune the lower CI version (silently
  running CI against an unsupported runtime) is caught at test
  time instead of as a misleading green check on `main`.

### CI
- Added a `Tests must leave the working tree clean` step to
  `.github/workflows/ci.yml` immediately after `npm test`.
  Defence in depth against the iter 149 regression where
  install-dogfood artifacts under `.github/extensions/ralph/`
  slipped into a commit via `git add -A`, inflating the diff
  from ~50 lines to 2804 insertions. The new step runs both
  `git diff --exit-code` (catches tracked-file modifications)
  AND `git status --porcelain` (catches untracked files —
  exactly the failure mode iter 149 hit; `git diff` alone
  misses these). A PR whose tests dirty the working tree now
  fails CI before it can land on `main`. Pinned with a
  drift-guard test in `test/extension.test.mjs` that asserts
  both checks remain wired up — a regression that drops the
  `--porcelain` half (the half that catches untracked files)
  fails loudly.

### Documentation
- Both `README.md`'s "Pause and resume" section and
  `docs/concepts.md`'s "Pause / resume semantics" section now
  document the **first reason wins** contract for
  `ralph_pause`'s idempotent path. Iter 172 pinned via test
  that a redundant `ralph_pause({reason: "newer"})` against
  an already-paused loop returns the FIRST committed reason
  in both the success payload's `reason` field and the
  rendered `textResultForLlm` (`<label> already paused at
  i/max (firstReason).`). Automation polling pause state
  depends on this contract: callers expect the original
  committed reason, not their own input echoed back. Pinned
  with a new drift-guard test that scans both surfaces for
  the "first reason wins" phrase plus the rendered message
  shape, so a future docs trim that drops the clarification
  fires the test instead of silently leaking a contract gap
  to automation authors.
- The JSDoc block above `VALUE_FLAGS` in `packages/tui/bin/tui.mjs`
  said `(currently: --older-than)` even though the set has held
  `["older-than", "limit"]` since iter 152 (when issue #32 added
  `--limit N` to `ralph-tui list`). Drift-only fix — the parser
  always knew about `--limit`, but the comment misled future
  contributors reading the file. Pinned with a new test
  (`packages/tui/test/bin.test.mjs`) that reads `bin/tui.mjs` as
  text, extracts every flag from the `VALUE_FLAGS` Set literal,
  and asserts each appears in the JSDoc block — so the next
  value-flag addition (e.g. `--since`, `--tool` from issues
  #37/#40) cannot regress the comment without breaking CI.
- `docs/ARCHITECTURE.md`'s "Token tracking" section listed
  only **one** of the four clauses that
  `isCreditableTokenPair` actually enforces: the negative-peer
  case. The helper at `extension/handler.mjs:1488-1490`
  rejects (1) any non-finite peer (NaN / Infinity / coerced
  `undefined → NaN` from a missing field), (2) any negative
  peer, AND (3) the all-zero `{input: 0, output: 0}` shape.
  Concepts.md already documented the full contract; the
  ARCHITECTURE drift meant a contributor reading only the
  contributor-facing doc would believe NaN / Infinity / 0/0
  events were credited. Renamed the bullet to "Creditable-
  pair rejection" and enumerated all four clauses inline,
  noting the shared gate covers both the nested-`usage` and
  flat-`usage_*` extractor branches. Pinned with assertions
  in `test/extension.test.mjs`'s ARCHITECTURE drift guard
  (`isCreditableTokenPair`, `Number.isFinite`, `NaN`,
  `Infinity`, `zero/zero` literals) so a future trim cannot
  silently degrade the contract back to a partial description.
- `packages/tui/README.md`'s `## Subcommands` block drifted
  significantly from the actual CLI surface in
  `packages/tui/bin/tui.mjs`. Pre-iter-161 it listed only
  `list` / `replay` / `watch` / `--help`, but the bin ships
  `doctor`, `prune` (with `--older-than` / `--dry-run`),
  `stats`, `where`, the `--version` / `-V` flag, plus the
  `--json` and `--limit N` flags on `list`. A contributor
  reading the TUI README without cross-referencing
  bin/tui.mjs's USAGE constant would not know these
  subcommands existed; CI scripts probing the canonical CLI
  surface would silently miss them. Updated the block to
  list every shipped subcommand + key flag, and pinned the
  contract with a drift-guard test in
  `packages/tui/test/bin.test.mjs` that re-reads the README,
  slices the Subcommands section, and asserts every required
  keyword (`ralph-tui doctor`, `ralph-tui prune`,
  `ralph-tui stats`, `ralph-tui where`, `--version`,
  `--json`, `--limit`, `--older-than`, `--dry-run`,
  `--plain`) is present. Bin/tui.mjs's own USAGE constant is
  already pinned by the `tui.mjs header comment lists every
  USAGE subcommand` test, so the source-of-truth side is
  covered — this test pins the README mirror so adding a new
  subcommand to bin/tui.mjs forces the corresponding README
  update or CI fails.
- `docs/faq.md`'s "Why is `pausedForMs` zero on a `resume`
  event?" section drifted from the post-iter-154 / iter-155
  runtime contract: it described the formula as
  `pausedForMs = now - pausedAt` — the unclamped pre-fix
  expression. The runtime now computes
  `pausedAt > 0 ? Math.max(0, now - pausedAt) : 0` (via the
  shared `pauseElapsedFromAt` helper that backs `finish()`,
  `ralph_status`, and `ralph_resume`), so a backward clock
  skew during a pause window — NTP correction, manual clock
  change, daylight-savings on a host without monotonic-time
  backing — yields `pausedForMs == 0` rather than crediting a
  negative duration to `total_paused_ms` and inflating the
  reported `durationMs`. The FAQ now lists both same-
  millisecond rounding AND backward-clock-skew clamping as
  causes of a zero, and explicitly notes the three call
  sites share a single helper so the contract cannot drift.
  Pinned by a drift-guard test in `test/extension.test.mjs`
  that re-reads the section and asserts the backward-skew
  case + the `Math.max(0, …)` / "clamp" wording + the
  original same-millisecond case all remain.
- `docs/concepts.md`'s "Two safety contracts" bullet on
  token-credit rejection drifted from the actual
  `isCreditableTokenPair` contract in `extension/handler.mjs`.
  Pre-iter-153 the doc listed only "negative / NaN / Infinity"
  rejection, missing the `(input > 0 || output > 0)` clause:
  `{input: 0, output: 0}` events ARE silently dropped. A
  maintainer reading concepts.md alone could implement an
  event-source shim that emitted `{0, 0}` after a no-op turn
  and be confused when those events never landed in the per-
  iteration breakdown. ARCHITECTURE.md's section already had
  the correct "at least one positive" wording — concepts.md
  is now consistent. A drift-guard test in
  `test/extension.test.mjs` re-reads the bullet and pins both
  the zero/zero phrase AND the at-least-one-positive clause
  so the wording cannot regress without flipping the test.
- `.github/copilot-instructions.md`'s CHANGELOG section-order
  summary drifted away from `AGENTS.md`'s canonical chain on
  TWO points: it placed `Documentation` BEFORE `Internal`
  (AGENTS.md is the other way), and it omitted `Tests` and
  `CI` entirely. AI assistants that load
  `copilot-instructions.md` automatically would have filed
  test-related entries under `Internal` (or invented a new
  section), and inverted the Internal/Documentation ordering
  used by every release section in `CHANGELOG.md`. Synced the
  bullet to AGENTS.md's canonical chain
  (`Breaking → Features → Fixes → Performance → Refactor →
  Internal → Tests → CI → Documentation`) and pinned both
  files in lockstep with a drift-guard test in
  `test/extension.test.mjs`: every section
  `copilot-instructions.md` cites must exist in AGENTS.md's
  chain in the same relative order, with explicit pins that
  `Internal` precedes `Documentation` and `Tests` is
  mentioned.
- `extension/handler.mjs`'s `VERB_BY_REASON` header comment
  drifted away from the table: pre-iter-143 it claimed
  `max_tokens` "falls through to ⏹ stopped" alongside
  `max_iterations`, `user_stopped`, and `detached`, but the
  table actually has an explicit
  `max_tokens: "⏹ stopped"` entry. Behaviour was correct
  (the explicit entry returns the same string the fallback
  would have produced), but the comment misled anyone
  auditing the verb ladder. Updated the comment to
  acknowledge `max_tokens` has an explicit entry for
  defensive double-coverage and pin the contract with a
  drift-guard test in `test/extension.test.mjs`:
  `max_tokens` MUST stay in `VERB_BY_REASON`,
  `max_iterations` / `user_stopped` / `detached` MUST stay
  out (the comment's "fall through" claim depends on it).
  Regression catch verified by adding a redundant
  `max_iterations: "⏹ stopped"` entry — the targeted test
  fires.
- `packages/tui/bin/tui.mjs`'s top-of-file `// Subcommands:`
  comment block now lists all 7 currently-shipped subcommands
  (`list`, `replay`, `watch`, `doctor`, `prune`, `stats`,
  `where`) instead of just the original 3 (`list`, `replay`,
  `watch`). A contributor reading the header to gauge tool
  scope previously saw a stale snapshot from before
  `doctor` / `prune` / `stats` / `where` landed and would
  silently miss four user-visible commands. Each header entry
  now documents key flags inline (e.g. `--json` and
  `--limit N` for `list`, `--older-than D` for `prune`).
  Pinned by a drift-guard test in `packages/tui/test/bin.test.mjs`
  that extracts both the header subcommand list and the
  USAGE subcommand list from the source and asserts every
  USAGE subcommand also appears in the header — so the next
  subcommand drop must update both surfaces in lockstep.

- AGENTS.md's "Section names (in order)" chain now matches the
  actual order observed in `CHANGELOG.md`'s `## Unreleased`
  block, and now documents the `### Tests` and `### CI`
  sections that were previously omitted from the chain. Adds a
  drift-guard test that pins both files in lockstep — every
  section heading the current top sub-batch of `## Unreleased`
  uses must (a) be documented in AGENTS.md and (b) appear in
  the relative order AGENTS.md declares. Older sub-batches and
  legacy section names (`Changes`, `Hardening (post-0.6.0)`,
  `Tests / docs`) are silently skipped so the guard catches new
  drift at the top without forcing a retroactive rewrite of
  already-accumulated entries. Also replaces a stale README
  example referencing a hypothetical `RALPH_NO_UPDATE_CHECK`
  with the real opt-out `RALPH_NO_ATTRIBUTION` env var.

- `docs/RELEASING.md`'s end-user pinning curl loop now uses
  the leaf-first order (`events-emit.mjs handler.mjs
  extension.mjs`) — entry point LAST — that `install.sh`'s
  FILES array, README Options A/B/D, and the iter 121 README
  fix all already pin. Previously the loop listed
  `extension.mjs` FIRST: a download interrupted (or merely
  slow) mid-loop with a concurrent `/extensions reload` would
  briefly leave the SDK importing a new `extension.mjs`
  against missing/old siblings — exactly the crash mode the
  rest of the project was hardened against. The README-only
  drift guard from iter 121 has been broadened to scan every
  `.md` under repo root + `docs/` for `for f in …; do` curl
  loops covering `handler.mjs`, so future docs additions
  (quickstart.md, recipes.md, …) inherit the lockstep
  enforcement automatically. Total install loops scanned in
  the new assertion: ≥ 3 (Option A + B + D in README, plus
  the new RELEASING.md entry).
- README's install instructions now list `./install.sh
  --version` alongside the existing `--project`, `--dry-run`,
  and `--help` flags. The `--version` / `-V` flag landed in
  iter 123 but the README never advertised it, so a user
  skimming the install section would never learn the flag
  exists. New drift-guard test extracts every long-form
  `--flag` from `./install.sh --help`'s output and asserts
  each one appears at least once in `README.md` — the next
  time a flag is added or renamed in install.sh the test
  fails until the README is updated to match.
- `extension/events-emit.mjs`'s `MAX_EXCERPT_CHARS`
  comment no longer references a non-existent
  `MAX_EXCERPT_CHARS` constant in the TUI side. The
  TUI inlines the cap as the literal `500` argument to
  two `safeSliceChars(..., 500)` call sites in
  `packages/tui/src/events.mjs`'s `serializeEvent`
  (one for `excerpt`, one for `note`). The updated
  comment names those exact call sites and explains
  the failure mode if the two sides drift (reader
  re-clips data the emitter believed was final, or
  oversize-line guards fire asymmetrically). A new
  drift-guard test in `test/events-emit.test.mjs`
  reads both files and asserts every TUI
  `safeSliceChars()` call uses the same cap as the
  emitter's named constant — so a future refactor
  that bumps either side without bumping the other
  will fail loudly with a message naming the exact
  mismatch.
- `docs/ARCHITECTURE.md`'s "Test architecture" section now
  lists every DI option `createRalphController({...})`
  supports — previously the comma-list enumerated only
  `{ caffeinate, git, adaptive }` and silently omitted the
  `events` slot wired by issue #22 (JSONL emitter override
  used by `test/handler-events.test.mjs`). A contributor
  reading ARCHITECTURE.md to learn how to stub a writer in
  a test would have had to grep handler.mjs to find the
  slot. The fix adds `events` to the list with a brief
  description (true / { env, fs } / { factory } shapes).
  Drift-guard test pins both the comma-list and a brief
  events-slot description so the doc cannot silently
  regress when a future opts.* slot is added.
- README's "Pause visibility" bullet now documents BOTH
  `ralph_status` `textResultForLlm` summary forms — the
  with-reason em-dash variant `(PAUSED — <reason>, for
  <ms>ms)` AND the bare no-reason variant `(PAUSED, for
  <ms>ms)` (no em-dash, no reason slot). Iter 111 pinned
  the no-reason format as the implementation contract via
  test, but the README still claimed the em-dash form was
  unconditional. A contributor consuming only the README to
  build a regex against `ralph_status` output would have
  written `/PAUSED — /` and missed every reasonless pause.
  Drift-guard test pins both forms in the README so a
  future "shorten" PR can't silently regress.
- AGENTS.md and docs/RELEASING.md now describe the same
  canonical `## X.Y.Z` CHANGELOG release-heading shape that
  the existing CHANGELOG actually uses. Previously AGENTS.md
  said `## X.Y.Z — YYYY-MM-DD` (with a date suffix that has
  never appeared in any release section) and RELEASING.md
  said `## [vX.Y.Z] - YYYY-MM-DD` (a bracket-and-date form
  that the manual `awk` extraction snippet on the same page
  would have failed to match). Both files now reflect the
  bare `## X.Y.Z` form, the manual `awk` extraction is fixed
  to actually work against the existing CHANGELOG, and a
  drift-guard test pins both the canonical shape across all
  existing release headings and the doc-file references so a
  future hand-edited drift (typo, accidental `v` prefix,
  reintroduced date suffix) surfaces at test time rather
  than after a failed release.
- `docs/CONTRIBUTING.md` previously cited `extension/handler.mjs`
  as `~1.3kLOC`; the file has since grown to ~2.5kLOC (more
  than 2× the documented figure), giving new contributors a
  misleading expectation of how much state-machine glue lives
  there. Refresh the figure to `~2.5kLOC` and pin it with a
  drift-guard test that allows the documented value to drift
  by up to ±30% before failing — wide enough to absorb normal
  iteration but tight enough that the figure cannot silently
  double again.
- AGENTS.md §5 "Quick checklist before pushing" now includes
  `npm run check` alongside `npm test`. The two scripts cover
  different surfaces (functional tests vs. per-file
  `node --check` syntax sweep across `extension/` +
  `packages/tui/{src,bin}`); CI runs both, so a contributor
  who only ran `npm test` locally could push a syntax error
  that broke every matrix runner. Drift-guarded so a future
  edit cannot drop either entry.
- README parameter tables for `self_improve` and `grow_project`
  now spell out the iter 90 default-clamp contract on
  `min_iterations`: the tool-specific default (5 / 10) is
  silently clamped down to `max_iterations` when `max` is
  smaller (so a small `max_iterations` Just Works), but an
  explicitly-supplied `min_iterations > max_iterations` is
  still rejected. Drift-guarded — the README rows must mention
  both halves of the contract so a future doc edit can't
  partially erase it.

### Internal
- `.github/workflows/ci.yml` now declares a `concurrency` block
  so a fast-typing contributor pushing several commits to the
  same PR cancels old in-progress CI runs (saving the Node 20 +
  Node 22 runner pair per push). Grouping is per-workflow
  per-ref so distinct PRs / branches still run independently;
  cancel-in-progress is gated on `github.event_name ==
  'pull_request'` so main-branch pushes are never cancelled —
  preserving the per-merged-commit green/red CI signal that
  the Conventional Commits + Keep-a-Changelog release flow
  depends on. Drift-guard test pins both halves (group key
  shape AND the pull_request cancel gate).

### Documentation
- The `self_improve` and `grow_project` tool descriptions now
  document the `min_iterations` default-clamp behaviour
  introduced in the previous fix: the tool-specific defaults
  (5 / 10) are silently clamped down to `max_iterations` when
  the user passes a smaller `max` and no explicit `min`.
  Explicitly-supplied `min_iterations` values are still
  required to be ≤ `max_iterations`, so a real config mistake
  (typing `min=5, max=3`) still surfaces loudly. A new
  drift-guard test pins both halves of the contract — the
  clamp note AND the user-explicit strictness call-out — in
  both tools' schema descriptions so a future revert (or a
  description rewrite that drops one half) is caught at test
  time.

### Fixes
- `self_improve` and `grow_project` no longer surface a confusing
  validation error when the caller picks a small `max_iterations`
  without an explicit `min_iterations`. Previously, the
  tool-specific defaults (`self_improve.min_iterations = 5`,
  `grow_project.min_iterations = 10`) were applied verbatim, so
  e.g. `self_improve({max_iterations: 3})` rejected with
  `min_iterations must be in [1, max=3] (got 5)` — blaming a
  value the user never typed. Both handlers now clamp the
  unsupplied default to `max_iterations` (the floor still
  applies whenever there's room for it). An *explicit*
  user-supplied `min` larger than `max` still surfaces the
  strict error, so a real configuration mistake stays loud.

### Tests
- New behavioural drift guard for `ralph_pause` re-pause
  idempotency. The existing test only pinned "first reason wins";
  the new test extends coverage to the two adjacent invariants
  that make idempotency actually safe in practice:
  (1) `pausedAt` is NOT reset on a re-pause (otherwise the
  `totalPausedMs += Date.now() - pausedAt` math on resume would
  silently undercount the paused window, distorting
  `ralph_status` durations); and (2) `textResultForLlm` echoes
  the FIRST reason, never the discarded second — so an agent
  that "updates" the reason via re-pause sees the silent
  rejection clearly instead of being misled into thinking its
  new reason landed.

### Refactor
- `ralph_status` now uses a module-level `RALPH_STATUS_KEYS` Set
  for argument-shape validation, matching every other loop-control
  tool (`RALPH_STOP_KEYS`, `RALPH_PAUSE_KEYS`, `RALPH_RESUME_KEYS`).
  The previous form allocated a fresh `new Set()` inline at the
  `validateOptionalArgShape("ralph_status", args, new Set())` call
  site — cheap but drift-prone (a future change that adds an
  optional argument to ralph_status would have to update the call
  site instead of a single module constant). A new drift-guard
  test pins the new constant's existence and forbids any future
  reintroduction of the inline `new Set()` anti-pattern.

### Documentation
- `SECURITY.md`'s in-scope file list now covers every runtime
  module shipped under `extension/` (currently `extension.mjs`,
  `handler.mjs`, `events-emit.mjs`). The previous wording listed
  only `extension.mjs` and `handler.mjs` explicitly — a security
  reporter checking whether a vulnerability in `events-emit.mjs`
  was in scope would have been told it isn't, even though it's
  shipped to every install. The new wording delegates the
  authoritative list to `install.sh`'s `FILES` array (pinned to
  `extension/*.mjs` by an existing drift-guard test) so a future
  module addition lands in scope automatically without another
  `SECURITY.md` edit. A new drift-guard test asserts each shipped
  `extension/*.mjs` basename is mentioned in `SECURITY.md` AND
  that the install.sh-FILES delegation pointer is preserved.

### Internal
- `.github/workflows/release.yml` now uploads release assets via a
  `shopt -s nullglob; ASSETS=(extension/*.mjs)` bash glob instead
  of a hardcoded three-filename list. The hardcoded form silently
  dropped any newly-added module from published GitHub Releases —
  even after iter 84's drift guard pinned `install.sh`'s `FILES`
  array against `extension/*.mjs`, the workflow still required a
  separate manual update. The glob makes the workflow track the
  directory automatically, and `nullglob` ensures an empty
  `extension/` errors out loudly rather than passing the literal
  `extension/*.mjs` string to `gh release create` as a non-existent
  asset name. The pre-existing release.yml drift guard test
  (`test/extension.test.mjs`) was rewritten in place to pin the
  glob form, the `nullglob` opt-in, and the absence of any
  hardcoded `extension/<name>.mjs` filename in the
  `gh release create` block — so a future "helpful" refactor that
  re-hardcodes the list trips before merge.
- `.gitignore` now excludes `site/`, the default mkdocs build
  output directory. A contributor running `mkdocs build` to
  preview the docs site locally would previously have swept
  hundreds of generated HTML/CSS/JS files into the next
  `git add -A`. A drift-guard test parses `mkdocs.yml` for an
  explicit `site_dir:` override (or falls back to the mkdocs
  default `site/`) and asserts the matching directory is listed
  in `.gitignore` as a whole line; if a future refactor moves
  the build output without updating the ignore list, the
  assertion fires before merge and tells the contributor
  exactly which directory to add.

### Tests
- New drift guard asserts `install.sh`'s `FILES=(...)` array
  matches `extension/*.mjs` as a set. The script's existing
  guards (Node `--check` parse, missing-file refusal, post-copy
  `cmp -s` verification) only run *after* the list has been
  chosen, so a developer adding `extension/newmodule.mjs`
  without updating `FILES` silently shipped to nowhere — the
  omitted module never reached the install target and the
  extension crashed at user-side load time. The new test reads
  both lists at runtime and trips CI before merge if they
  diverge.

### Fixes
- `compareSemver` (introduced iter 80) now parses but ignores
  build metadata per SemVer 2.0.0 §10. Previously the regex
  rejected the `+meta` suffix outright, so a tag like
  `0.6.1+sha.abcdef0` fell through to the malformed→0
  silent-degrade path and compared equal to ALL other versions,
  including `0.7.0`. Real-world impact: a release pipeline that
  stamps a build tag (or any consumer pulling tags from
  `gh release list` where third-party fork releases sometimes
  include build metadata) would silently miss every upgrade
  recommendation under the planned issue #25 version-check
  feature. Widened the regex to accept `+[0-9A-Za-z.-]+` and
  discard the captured segment before comparison; precedence
  for `MAJOR.MINOR.PATCH` and prerelease segments is unchanged.
  9 new tests pin the §10 contract end-to-end. Refs #25.

### Documentation
- README's `ralph_status` behaviour-notes block now spells out
  that `elapsed_ms` is wall-clock — counted from arm-time to
  "now" and including pause time. A loop paused for 60s reports
  `elapsed_ms` 60_000 higher than its active-time peer would.
  The note points readers at `total_paused_ms` (and
  `paused_for_ms` when currently paused) for computing
  active-only time, and links to the matching contract in
  `docs/concepts.md` (iter 77). A drift-guard test reads
  README at runtime and asserts the bullet is still present —
  without this guard a refactor that quietly switched
  `elapsed_ms` to active-only time would let the README lie.

### Refactor
- `validateArgs` adaptive-budget block now uses a single closure
  helper `validateAdaptiveIntField(fieldName, raw, lo, loLabel)`
  for both `adaptive_extension` and `adaptive_max_total`. Before
  this change, each field repeated the same five-line dance —
  `coerceNumberField` → finite-number gate → bounds gated on
  `adaptiveBudget` — with hand-spelled error templates. The
  duplication meant the iter 76 accept-and-ignore contract had
  to be re-asserted in two places, and any future tweak (relax
  the upper bound, change the finite-number message wording)
  would have to land identically in two spots. Extract the
  shape once: the closure captures `adaptiveBudget` from the
  enclosing scope and the only field-specific knobs are the
  lower bound + its display label (since `adaptive_max_total`'s
  lower bound is the dynamic `max_iterations`, not `1`).
  Behaviour and error templates are byte-identical to the
  pre-refactor branches; the existing 558 tests still pass.

### Features
- New `compareSemver(a, b)` pure helper (extension/handler.mjs)
  returning `-1 | 0 | 1`. Handles `MAJOR.MINOR.PATCH` plus an
  optional `-prerelease` suffix per SemVer 2.0.0 §11 (release >
  prerelease, dot-segment compare with numeric < alphanumeric,
  longer set wins). Malformed input deliberately resolves to 0
  so the future "version check on extension load" feature
  (issue [#25](https://github.com/kloba/copilot-ralph-extension/issues/25))
  cannot falsely recommend an upgrade on a parse failure. Build
  metadata (`+...`) is intentionally ignored per §10. Six unit
  tests pin the contract: equality, major/minor/patch ordering,
  release-vs-prerelease, prerelease §11.4 ordering, malformed
  inputs (non-string, leading-v, extra segments), and the full
  SemVer §11 example chain (alpha < alpha.1 < … < rc.1 < 1.0.0)
  verified end-to-end with strict monotonicity.

### Internal
- Bake an exported `VERSION` constant in `extension/handler.mjs`
  matching `package.json#version`. This is the precursor to
  issue [#25](https://github.com/kloba/copilot-ralph-extension/issues/25)
  (version check on extension load): the future check needs a
  baked-in "this is the version installed at
  `~/.copilot/extensions/ralph/`" anchor, and `install.sh` does
  not ship `package.json` to the install target so a runtime
  `require("../package.json")` would crash on installed copies.
  A new `VERSION matches package.json` test reads the source
  `package.json` and asserts the constant matches, so a release
  PR that bumps one without the other fails CI before merge.
  `AGENTS.md`'s release flow is updated to call out the dual
  bump.

### Tests
- `coerceNumberField` (extension/handler.mjs:945) gains direct
  unit-test coverage. Pins the helper's input contract: rejects
  non-{number,string} types (boolean / object / array / null /
  undefined / function / symbol) with a type-aware error,
  accepts numeric strings via `Number()` coercion, passes
  numbers (including 0, negatives, MAX_SAFE_INTEGER, NaN,
  Infinity) through unchanged, lets bogus strings like `"ten"`
  coerce to NaN so the call-site `Number.isFinite` /
  `Number.isInteger` checks remain the gate, and interpolates
  the requested `fieldName` into every error so a typoed
  `stagnation_limit` cannot surface as a `max_iterations`
  rejection. The helper is now exported via `__test__` so
  these contracts pin directly instead of through validateArgs
  integration tests.

### Documentation
- `docs/concepts.md` now pins the exact slot layout of the
  `ralph_status` `textResultForLlm` one-line summary (added in
  iter 71). Documents both active-loop and inactive-loop
  variants, calls out that `, tokens X/Y` only appears when
  `max_tokens` was armed, and clarifies that `elapsed Nms` is
  wall-clock (pause time included). A drift-guard test reads
  `docs/concepts.md` at runtime and asserts the documented
  template strings still match the handler's emit format, so a
  refactor that renames a slot is forced to update the doc.

### Fixes
- `validateArgs` now honours the documented "accept-and-ignore"
  contract for `adaptive_extension` and `adaptive_max_total` when
  `adaptive_budget` is false (the default). The comment above the
  validator promised that a user with adaptive presets baked into
  their tooling could toggle `adaptive_budget=false` without first
  clearing the presets — but the validator strictly bounds-checked
  both fields regardless of `adaptive_budget`, so a preset like
  `adaptive_extension: 0` paired with `adaptive_budget: false` was
  rejected even though the runtime never reads the value. Loosen
  the integer-and-range bounds check so it only runs when
  `adaptive_budget` is true. Type checks (must-be-a-finite-number)
  still run unconditionally so a typo (`"ten"`, `Infinity`, `NaN`)
  surfaces loudly. Round-tripped unchanged on the arm result so
  consumers see exactly what they configured. Four new tests pin
  the loosened path (out-of-range, negative, below-`max`, type-
  error) and one regression test re-affirms the strict path when
  `adaptive_budget` is true.

### Refactor
- Extract `isCreditableTokenPair(input, output)` helper inside the
  ralph controller closure to dedupe the four-clause validation
  contract (`isFinite × 2`, `>= 0 × 2`, `(input > 0 || output > 0)`)
  that previously lived inline in both branches of `extractUsage`.
  A future SDK shape variant (e.g. flat `data.tokens_in` /
  `data.tokens_out`) can now reuse the helper instead of
  reimplementing three of the four clauses and silently weakening
  the contract. Behaviour is unchanged — all 31 existing
  extractUsage / token-credit tests remain green.

### Tests
- Add direct unit tests for `parseUserReason` — the shared
  normaliser for the optional `reason` argument on `ralph_pause`
  and `ralph_stop`. Previously only covered indirectly via
  integration tests on the two tools; a refactor that swapped
  `boundedNoteForLog` for a stricter trim could have silently
  changed behaviour for both surfaces. Five new tests pin: (1)
  non-string inputs (number / boolean / object / array / function)
  → `null`; (2) empty / whitespace-only strings → `null` so the
  success message can't render a stray ` ()` suffix; (3) normal
  strings pass through bounded + whitespace-flattened (newlines
  and tabs collapse to single spaces); (4) strings longer than
  `PREVIEW_CHARS` truncate to the cap; (5) idempotency — feeding
  the output back through the helper is a no-op, so re-normalising
  on resume / re-render can't double-truncate or lose data.
  Exports `parseUserReason` from the handler's `__test__` block.

### Documentation
- README "session.log markers" bullet now matches the iter 72
  `VERB_BY_REASON` runtime contract: `abort_promise` and
  `stagnation` are listed under `⚠️ *ended*` (the four reasons
  that also map to `type=abort` in the terminal event), and the
  `⏹ *stopped*` parenthetical now lists only the genuinely neutral
  exits — `max_iterations`, `max_tokens`, `user_stopped`,
  `detached`. A new drift-guard test reads `README.md` at runtime
  and pins the membership of both sentences so a future code-only
  fix can't silently desync the docs again.

### Fixes
- Align `VERB_BY_REASON` log marker with `ABORT_REASONS` terminal-
  event mapping. `abort_promise` and `stagnation` are listed in
  `ABORT_REASONS` (so the terminal event maps them to `type=abort`
  and the TUI shows them red) but the finish-log line was rendering
  them with `⏹ stopped` — the neutral verb used for "the loop ran
  to a configured boundary, no failure". A user reading the log
  came away thinking the run terminated cleanly while the event
  stream was simultaneously reporting it as a failure. Add both
  reasons to `VERB_BY_REASON` with `⚠️ ended` so log marker and
  terminal event semantics agree. The four genuinely-neutral exits
  (`max_iterations`, `user_stopped`, `detached`, `max_tokens`) keep
  `⏹ stopped`. Two new tests pin the `⚠️ ended` mapping for
  `abort_promise` and `stagnation`; one regression test pins that
  the neutral exits do NOT regress to `⚠️`. The grow_project verb-
  ladder test from iter 22 is updated to assert the new
  `⚠️ ended grow_project … abort_promise` contract.

### Features
- `ralph_status.textResultForLlm` (the one-line summary string an
  LLM consumer reads when it doesn't introspect the JSON snapshot)
  now appends `, tokens X/Y` when `max_tokens` is armed — e.g.
  `self_improve: iteration 12/100, elapsed 142318ms, tokens
  1801/100000`. Loops with no cap keep their summary unchanged so
  the line stays uncluttered for runs that don't care about token
  budgeting. Order: tokens segment precedes the optional `(PAUSED
  …)` suffix so a paused, capped loop still surfaces both pieces.
  Three tests pin the new format: capped + token-credited, no-cap
  omission, and paused-while-capped ordering.

### Tests
- Pin the lenient-input contracts of `extension/events-emit.mjs`'s
  `makeRunId` and `resolveRunsRoot` helpers. The module's stated
  discipline (issue #22) is "swallow every error so the loop keeps
  running" — `makeRunId` substitutes `Date.now()` for non-finite
  `startedAt` and replaces filesystem-unsafe label characters with
  `_`, while `resolveRunsRoot` falls back to
  `~/.copilot/ralph/runs` when `RALPH_EVENTS_DIR` is empty,
  whitespace, the wrong type, or unset. Integration tests already
  cover the holistic emit path; the new tests pin the helpers
  themselves so a future "tighten the input contract" PR cannot
  silently regress the loop's resilience or — worse — let a hostile
  / typo'd label escape the runs root via path traversal. Six tests
  added covering: env override pass-through, four flavours of
  empty/wrong-type fallback, well-formed run ids, eight degraded
  `startedAt` values, and five unsafe label character classes
  (path traversal, spaces, shell metacharacters, empty, null).

### Documentation
- Add `## Token tracking and context-window warnings` section to
  `docs/concepts.md`. The user-facing concepts page listed token
  tracking under "Topics planned" but the section itself was missing
  even though iters 67/68 had just shipped `ralph_status.tokens`
  (live + `last`). The new section covers the live + post-finish
  shapes, the two safety contracts (negative/NaN rejection + pause-
  time isolation), and the two-threshold context-window warning
  model — all from the user's perspective. Cross-links to the
  engineering-level walkthrough already present in
  `docs/ARCHITECTURE.md`. The "Topics planned" stub list no longer
  pretends the section is missing. Drift-guard test pins the
  heading, the four live-snapshot field names, the post-finish
  mirror, the rejection contract, the pause-time-isolation cross
  reference, the 80%/95% thresholds, and the ARCHITECTURE link — and
  asserts the "Topics planned" block above the first section no
  longer mentions Token tracking.

### Fixes
- `ralph_status`'s `last` summary (returned when no loop is active)
  now surfaces a `tokens: { input, output, total }` block when the
  prior run actually credited tokens, mirroring the live `tokens`
  block added to the active snapshot in iter 67. Previously the data
  was reachable only by parsing the terminal `result.tokens` from the
  loop's return value — a post-mortem `ralph_status` call could see
  iteration count / reason / duration but had no view of how many
  tokens the run consumed. Skips `byIteration` / `byModel` for
  snapshot-size parity with the live block (those stay on
  `state.lastResult.tokens` for callers that want per-iter or per-
  model detail). Omitted entirely when the run consumed zero tokens
  so the snapshot doesn't pretend to know what it doesn't. Two tests
  pin the new shape — one with credited tokens, one with the zero-
  usage omission contract.

### Features
- `ralph_status` now surfaces a `tokens` block on the live snapshot
  (`{ input, output, total, max_tokens }`) so the user can monitor
  token-budget consumption against `max_tokens` mid-run without waiting
  for the terminal result. The block is always present on the active
  snapshot for predictable consumer parsing — counts start at 0 and
  accumulate from every `assistant.message` event credited during the
  loop; `max_tokens` echoes the configured cap or `null` when no cap
  was armed. Pause/resume isolation still applies: tokens are not
  credited while the loop is paused. Per-iteration and per-model
  detail remain on the terminal `result.tokens` (and the
  `iteration_end` events stream) — surfacing them on every status
  call would bloat the snapshot. README sample payload and tool
  description updated; two tests pin the new field shape including
  the `max_tokens: null` (not `undefined`) contract when no cap was
  configured.

### CI
- `.github/workflows/release.yml` now runs `npm run check` after
  `npm test` so a release tag cannot ship a syntactically broken
  shipped `.mjs`. The release runner does not `cd packages/tui &&
  npm install`, so any syntax error under `packages/tui/src` (where
  ink/react are absent at release time) would not fail the test
  step on its own — `npm run check` is the dependency-free parse-
  walker that covers every root. Drift-guard test pins the step so
  a future "trim the workflow" PR cannot silently strip it.

### Tests
- Pin `extractUsage`'s edge-case rejection contract: NaN-from-string
  (`input_tokens: "abc"`), Infinity, double-NaN, all-zero usage,
  missing `usage` object, and non-object (`usage: "wat"`) usage
  payloads must all be rejected silently — none of them may credit
  tokens or push entries into `byIteration`. The negative-rejection
  tests added in iter 63 covered the most likely upstream bug; these
  tests pin the broader robustness of the helper so a future
  "simplify extractUsage" PR (e.g. swapping `Number.isFinite` for a
  loose truthiness check) trips immediately. Each test ends with a
  positive sanity event to confirm the helper still credits real
  usage after the malformed events were rejected.

### Documentation
- Add `## Token tracking (issue #7)` section to
  `docs/ARCHITECTURE.md`. Token bookkeeping has been a significant
  reliability surface for many iterations (43, 48, 52, 59, 63 all
  touched it) but ARCHITECTURE.md never described the model — leaving
  contributors to reverse-engineer `extractUsage` / `creditUsage`,
  the `byIteration` / `byModel` rollups, the dual-threshold warning
  model (`warn_at_pct` plus the hard-coded 95% critical), the
  unknown-model handling (`unknownModelLogged`), and the two safety
  contracts (negative-rejection from iter 63; pause-time isolation
  from iter 59) before changing anything. The new section captures
  all of the above in the existing concise architecture-doc style,
  links to `concepts.md` for the pause/resume contract, and is
  pinned by a drift-guard test that asserts every key term remains
  present.

### Fixes
- `extractUsage` now rejects negative usage values from
  `assistant.message` events. The previous filter
  (`input > 0 || output > 0`) would happily admit
  `{ input_tokens: -500, output_tokens: 50 }` because the OR was
  satisfied by the positive peer; `creditUsage` would then apply
  `a.tokens.input += -500`, *decreasing* the loop's cumulative
  budget. That silently masks a configured `max_tokens` cap (the
  loop never trips it because the running total deflates) and
  drives the context-window pct calculation negative. Both
  the nested `data.usage` and flat `data.usage_input_tokens`
  paths now require both peers to be `>= 0` AND at least one
  positive — events with any negative peer are treated as "no
  usage" so the upstream bug surfaces (no credit, no
  byIteration entry) instead of being absorbed into
  bookkeeping. Two tests pin both forms.

### CI
- `.github/workflows/ci.yml` now runs `npm run check` (the portable
  `scripts/check.mjs` syntax checker added in iter 58) alongside the
  existing bash `Syntax check` step. Two independent code paths
  exercise the same property; if the bash form drifts from the Node
  script (e.g. roots updated in one but not the other), CI fails on
  the first push instead of letting a contributor discover it
  locally weeks later. A drift-guard test extracts the find-roots
  from `ci.yml` and the `ROOTS` array from `scripts/check.mjs`,
  sorts both, and asserts deep-equal — so the parity is also pinned
  pre-push.

### Tests
- Pin the ordering of the two early-exit guards in
  `onAssistantMessage` (`isSubAgentEvent` first, then the paused
  short-circuit). A sub-agent `assistant.message` arriving while the
  loop is paused AND `fireInFlight=true` must NOT set
  `observedMessageThisFire` — otherwise the post-resume idle would
  skip the next real fire because queue-bloat protection thinks the
  in-flight response was already observed (by a sub-agent that
  wasn't even the root agent). The test arms a loop, pauses, sets
  `fireInFlight=true` + `observedMessageThisFire=false`, emits a
  sub-agent `assistant.message` carrying heavy usage (50000 input,
  9999 output) and a stray "COMPLETE" string, then asserts tokens
  unchanged AND `observedMessageThisFire=false`. Regressions that
  swap the two guards trip the test immediately.

### Documentation
- Document the iter-57 + iter-59 pause/resume isolation contract in
  `docs/concepts.md` and the README. Pause-time chat is now isolated
  from the loop's token budget AND from completion/abort evaluation,
  and `ralph_resume` resets `lastAssistantContent` in addition to the
  stagnation streak — but the previous docs only mentioned the
  streak reset, leaving the new contract undocumented. The expanded
  "Pause / resume semantics" section now covers both isolation
  layers, the trade-off (an in-flight iter completion signal that
  landed right before pause is forfeited), and the resume-time
  resets table now lists all three reset fields. Two drift-guard
  tests pin the new wording in both files.

### Fixes
- `onAssistantMessage` now short-circuits when the
  loop is paused, preventing pause-time chat from
  polluting the loop's token budget. Iter 57 fixed
  the completion/abort contamination via a resume-
  time `lastAssistantContent` reset; iter 59
  addresses the symmetric token pollution at the
  root: while paused the user chats freely with
  the agent, and each chat turn's usage data was
  being credited via `creditUsage` to
  `a.tokens.input` / `a.tokens.output` /
  `byIteration` / `byModel` — inflating the loop's
  cumulative budget and (for loops armed with a
  `max_tokens` cap) potentially terminating the
  loop on the first post-resume idle. The new
  guard skips both token credit AND content
  accumulation while paused; `observedMessageThis-
  Fire` is still set so the post-resume idle isn't
  stuck on queue-bloat protection when pause
  happened between fire and first agent response.
  Three tests pin: (1) token budget unchanged
  across pause-time chat, (2) `max_tokens` cap
  doesn't trip on pause-time usage, (3) pause-
  time content doesn't reach `lastAssistantCont-
  ent` (root-cause defense in addition to the
  iter-57 resume-time reset).

### Internal
- Add `npm run check` — a portable, zero-dep
  Node script (`scripts/check.mjs`) that walks
  `extension/`, `packages/tui/src`, and
  `packages/tui/bin` and runs `node --check` on
  every shipped `.mjs`. Mirrors the CI
  "Syntax check" job behavior identically (same
  roots, same per-file invocation, same
  ≥10-files guard, same `Syntax-checked N .mjs
  files.` success line) so contributors can
  validate locally before pushing without
  waiting for the CI feedback loop. A test
  pins the script's existence + the
  `package.json#scripts.check` wiring + the
  exit-0-on-clean-tree contract.

### Fixes
- `ralph_resume` now clears `state.lastAssistantContent`
  before re-arming the idle handler. Previously,
  every assistant.message that fired during the
  paused conversation accumulated into the same
  buffer that `onIdle` reads to evaluate
  `completion_promise` / `abort_promise`. A casual
  mention of the configured trigger phrase in the
  user's pause-time chat (e.g. "I'll mark this
  COMPLETE when the refactor lands") would
  therefore spuriously terminate the loop on the
  first post-resume idle. Now the buffer resets
  at resume so the next iteration is evaluated
  against a clean slate. Trade-off documented in
  the inline comment: a genuine completion signal
  that landed in the in-flight iter response right
  before the pause is forfeited, but
  `ralph_status.last_response_excerpt` exposes
  that text for the user to inspect, and
  `ralph_stop` is available to honor it
  explicitly. Two tests pin the contract for both
  completion and abort tokens.

### Documentation
- Fix README drift introduced by the iter-52
  `durationMs` change. The "Limitations" bullet
  used to claim `durationMs` measures "time
  from arming, not per-turn latency" — true
  before the paused-time-deduction fix, wrong
  after. Now: "active time — wall-clock from
  arming minus `total_paused_ms`", with a
  concrete example (paused 60 min + ran 5 min →
  `durationMs ≈ 5 min`, not `≈ 65 min`). The
  result-shape example also gains an inline
  `// active runtime — wall-clock from arming
  MINUS total paused time (issue #3)` comment
  on the `durationMs` line so a reader scanning
  the JSON shape doesn't misread it as raw
  elapsed. A drift-guard test pins both the new
  wording and the absence of the old wording so
  a future "simplify the bullets" PR can't
  regress the page silently.

### Tests
- Direct unit tests for `classifyPorcelainLine`
  pin every branch of the git-status porcelain
  v1 classifier (untracked / staged-add /
  worktree-add / delete / modify / typechange /
  rename-with-arrow / rename-without-arrow /
  unknown-falls-through). Previously the
  classifier was only exercised indirectly via
  `buildFilesChangedSinceArm` inside
  `ralph_status`, where mocking the gitExec
  shape obscured which branch ran. Direct tests
  document the contract so a future port to
  porcelain=v2 (or a refactor that narrows a
  predicate) surfaces a focused failure
  instead of a far-removed status snapshot
  drift. `classifyPorcelainLine` is now exposed
  on the `__test__` export alongside the other
  internals already pinned by tests
  (`gitAheadBehind`, `gitUncommittedLines`,
  `evaluateAdaptiveSignals`, …).

### Refactor
- Extract `validateOptionalReasonField(toolName,
  args)` shared between `ralph_stop` and
  `ralph_pause`. The two handlers had byte-
  identical type-guards inlined after the
  iter-53 fix; centralising the check prevents
  drift if a third loop-mutating tool ever
  takes a `reason` field, and shrinks each
  handler back to a one-line guard call. Pure
  refactor — all 492 existing tests cover the
  shared helper from both call sites.

### Fixes
- `ralph_stop` and `ralph_pause` now reject a
  non-string `reason` with a clear typed error
  (`ralph_stop: reason must be a string (got
  number).`) instead of silently dropping it.
  Previously a caller passing `reason: 42` (or
  a templating-bug `reason: false`, `reason:
  ["x"]`) saw `success` with the note vanished
  — the buggy input was invisible and could
  silently corrupt log markers, the
  `ralph_status.last.note` field, and the
  emitted pause/terminal events. The new guard
  triggers BEFORE `parseUserReason`'s string
  coercion so the error is loud, mirrors how
  `ralph_loop` validates every other typed
  field, and leaves `state.active` unchanged so
  the caller can retry with a fixed call. `null`
  is still treated as "not supplied" (SDK
  sentinel), so existing callers passing `null`
  see no behaviour change.
- `result.durationMs` now actually subtracts
  paused time from wall-clock elapsed, matching
  the long-standing typedef contract
  (`totalPausedMs ... deducted from durationMs
  so wall-clock reflects active time`). Prior to
  this commit the field reported raw wall-clock
  elapsed and ignored `totalPausedMs` entirely
  — a loop paused for an hour and then run for
  five minutes would report `durationMs:
  3900000` (65 min) instead of the true active
  runtime (5 min). The fix subtracts BOTH banked
  `totalPausedMs` AND the not-yet-banked current
  pause window (when `ralph_stop` fires while
  the loop is still paused), and clamps at 0 so
  a clock-skew defect can't surface a negative
  duration. Three new tests pin: the
  totalPausedMs subtraction, the live-pause
  subtraction at stop-while-paused, and the
  zero-clamp guard.

### Documentation
- Replace the `docs/faq.md` stub (a 4-line
  pointer to the README) with a real Q&A page
  distilled from the README's Troubleshooting +
  Limitations sections plus
  [`docs/concepts.md`](docs/concepts.md). Covers
  setup ("why doesn't /extensions list ralph"),
  running a loop ("why did my loop stop after
  one iteration", "why does my loop never
  finish", how to stop / pause / resume), output
  & observability (where `events.jsonl` lives,
  the `RALPH_EVENTS_DIR` override, why
  `pausedForMs` can round to 0), and commit
  attribution (the dual `Co-authored-by:`
  trailers + the `RALPH_NO_ATTRIBUTION=1`
  opt-out and its prompt-honored caveat). A
  drift-guard test pins the headings + a few
  load-bearing claims so a future "simplify" PR
  can't silently regress the page.

### Refactor
- `activeLoopGuard` now reports a paused active
  loop as `paused (iteration N/M)` instead of
  the previous `running (iteration N/M)`. The
  guard fires when ralph_loop / self_improve /
  grow_project is invoked while another loop is
  already active; if that other loop has been
  paused with ralph_pause, the legacy "running"
  wording was misleading — the right remedy is
  often `ralph_resume` rather than `ralph_stop`.
  Rendering priority is now:
  paused > pendingFire > running.
  Tools using the guard (every loop-arming tool)
  inherit the corrected wording for free.

### Fixes
- Replace the awkward `Valid keys: .` error
  rendering for tools that accept no arguments
  (only `ralph_resume` today) with the clearer
  `This tool takes no arguments.` guidance. The
  legacy wording produced output like
  `ralph_resume: unknown argument: "foo". Valid
  keys: .` — the dangling period after `Valid
  keys:` read like a copy-paste typo and
  obscured the real signal (the tool simply
  takes no arguments). Tools with at least one
  known key (every other tool) keep the
  `Valid keys: ...` listing unchanged.

### Documentation
- Fill in the "Pause / resume semantics" section
  of docs/concepts.md (was a stub). Documents the
  iteration-counter contract (pause does not
  interrupt the in-flight iteration; takes effect
  on the next session.idle), the pause idempotency
  rule (ralph_pause is idempotent; ralph_resume is
  NOT), the stagnation-streak reset on resume
  (`streak = 0`, `prev = null` — manual
  intervention changes context), and the
  `paused_for_ms` / `total_paused_ms` accounting
  exposed by ralph_status. Companion drift-guard
  test pins the section header and its load-bearing
  factual claims so a future code change cannot
  silently invalidate the prose.

### Tests
- Pin install.sh `--project` flag handling. The
  --project arm computes the install target as
  `$(git rev-parse --show-toplevel)/.github/extensions/ralph`;
  if no git repo is in scope, the script must
  refuse with a clear error instead of silently
  writing somewhere unexpected. Two new tests
  cover (a) the error path — running with cwd in
  a fresh `mkdtempSync` dir (no git repo) exits
  non-zero with `--project requires being inside
  a git repo` on stderr and emits no DRY RUN
  banner on stdout; (b) the happy path — running
  with cwd at the repo root reports
  `Target:    $GIT_ROOT/.github/extensions/ralph/`
  and explicitly NOT the user-scoped
  `~/.copilot/extensions/ralph` path. Locks down
  the install entry point that production users
  actually invoke from contributor checkouts.
- Pin gitAheadBehind / gitUncommittedLines edge
  cases — the two helpers that feed ralph_status's
  "git" snapshot block. Cover: non-zero exit (no
  upstream tracked) → null; happy path parses
  `behind\\tahead`; wrong-field-count stdout →
  null; non-numeric fields → null; empty stdout →
  null; clean working tree → 0; insertions-only,
  deletions-only, and combined shortstat output.
  Both helpers must degrade to null on parse
  failure rather than emit a NaN-laced snapshot,
  so each failure mode is now a behaviour test.

### Internal
- Add `.gitattributes` pinning every shipped text
  file to LF line endings (`* text=auto eol=lf`,
  with explicit pins for `.sh` / `.mjs` / `.md` /
  `.json` / `.yml`). Without this, a Windows
  contributor's editor can save a `.mjs` or
  `install.sh` with CRLF, which breaks bash
  shebangs ("bad interpreter") AND surfaces as
  byte-mismatch failures in install.sh's post-copy
  `cmp -s` verification step. The lockfile gets
  `merge=ours` so a regen-only conflict resolution
  is the default. Companion test scans every
  shipped source file for any `\r` byte and
  reports the offending file + offset so a
  contributor can re-save with LF before pushing.

### Refactor
- Consolidate self_improve / grow_project's
  validation-error re-prefix logic into a shared
  `reprefixRalphLoopError(error, tool)` helper. Both
  tools delegated validation to `validateArgs()`
  (which prefixes errors with `"ralph_loop:"`) and
  then rewrote the prefix in-place — two near-
  identical 6-line blocks of regex-replace + string-
  fallback. Now one helper handles both branches
  (rewrite + defensive forced-prefix) and any future
  wrapper tool inherits the same behaviour for free.
  Helper is exported via `__test__` and pinned by
  two new tests covering rewrite and fallback.

### Fixes
- TUI plain-mode renderer now surfaces `pausedForMs`
  on resume events. Previously the field was silently
  dropped from the log line, forcing users (and any
  `awk`/`grep` consumer) to compute pause duration
  from the pause→resume timestamp diff — fragile
  across log rotation or clock skew. The new segment
  is `pausedForMs=<n>` and uses `Number.isFinite`
  rather than a truthy check, so a same-millisecond
  resume (`pausedForMs=0`) still renders. New tests
  pin the rendering, the zero boundary, and the
  segment's absence on non-resume events.

### Tests
- Pin TUI plain-mode rendering of `pause` and
  `resume` events. The plain renderer's VERB map
  already mapped both, but no test exercised the
  full event shape (verb / runId / iteration /
  reason). Adds three tests covering: pause with a
  reason, pause with `reason: null` (must omit the
  segment, not render `reason=null`), and resume
  with `pausedForMs`. The pausedForMs assertion is
  intentionally pinned to current behaviour (field
  not rendered today) so any future renderer change
  surfaces loudly in this test.

### Documentation
- README's Installation section had two `### Option C`
  H3 headings (Option C — From source AND Option C —
  Pin a specific tagged release). GitHub renders each
  heading into an anchor and silently appends `-1` to
  the second on collision, so cross-doc deep links
  landed on the wrong content. Renamed the second to
  `### Option D — Pin a specific tagged release` and
  added a drift-guard test that asserts every
  `### Option X` heading uses a unique letter AND
  the run is contiguous A→B→C→D — a future Option
  removal that turns D back into C must update both
  the heading and the test in lockstep.

### Refactor
- Consolidate the "no active loop" failure wording for
  ralph_stop / ralph_pause / ralph_resume into a single
  `noActiveLoopFailure(tool)` helper. Behaviour is
  byte-identical to before — `<tool>: no ralph_loop,
  self_improve, or grow_project is currently running.`
  — but now any future loop-mutating tool that needs
  the same failure (or any reword) updates one site
  instead of three. Added a drift-guard test that
  pins the wording across all three tools and fails
  loudly if any handler diverges.

### Fixes
- Token-tracking warning loop no longer emits a
  redundant ⚠ approaching warning when `warn_at_pct`
  is set to ≥ 95. Previously the dedupe guard keyed
  on the CONSTANT threshold value (80 / 95) rather
  than the effective percent, so a user dialing
  `warn_at_pct: 95` (or higher) saw BOTH log lines
  fire for the same usage spike — one approaching,
  one critical, at the same percentage. Now the
  user-tunable branch is suppressed when its
  effective value ≥ 95 so the strictly-more-
  actionable 95% critical message stands alone.
  Behaviour for the default `warn_at_pct: 80` and
  every value 1..94 is unchanged. Two new tests pin
  the new contract at `warn_at_pct: 95` and the
  schema upper bound `warn_at_pct: 99`.

### Documentation
- Fix stale `tools: controller.tools` comment in
  README's "How it works" code block. Previously
  listed only `ralph_loop + ralph_stop + self_improve
  + grow_project`; now lists all seven tools the
  controller exposes (adds `ralph_status`,
  `ralph_pause`, `ralph_resume` in their declaration
  order). A new drift-guard test parses the comment
  on every test run and fails loudly when a future
  tool addition is forgotten in the snippet — same
  pattern as the existing install.sh / release.yml /
  README install-loop drift guards.

### Tests
- Pin pause-during-pendingFire contract: an early
  `ralph_pause` (before iter 1 has fired) must NOT
  consume the `pendingFire` flag nor advance the
  iteration counter, and `ralph_resume` followed by
  the next `session.idle` must fire iter 1 cleanly.
  Closes a coverage gap on the transient pre-iter-1
  window — paired with the existing tests that pin
  pause-during-running (post iter 1) and pause-while-
  detached.

### Refactor
- Extract `parseUserReason(raw)` helper for the
  optional `reason` argument shared by `ralph_pause`
  and `ralph_stop`. Both tools now route raw input
  through one place: type-guard ⇒ `boundedNoteForLog`
  (collapse whitespace + PREVIEW_CHARS truncate) ⇒
  coerce empty-after-flatten to `null`. Side effect:
  `ralph_stop`'s `result.note` is now the canonical
  single-line form (was raw-truncated), aligning
  with `additionalContext` / terminal-event consumers
  that already flattened on read. Whitespace-only
  reasons now resolve to `undefined` on the result so
  the success message no longer renders a stray
  ` ()` suffix. Two new behaviour tests pin the
  multi-line and whitespace-only paths.

### Fixes
- `ralph_pause` now flattens user-supplied `reason`
  values at the entry point via `boundedNoteForLog`
  (collapse all whitespace runs to single spaces +
  PREVIEW_CHARS surrogate-safe truncate). Previously
  a multi-line paste — an Error stack, a blockquote,
  a CRLF input — would land verbatim in
  `state.active.pauseReason`, which then bled into:
  the `pause_reason` field of the ralph_status JSON
  snapshot (breaking JSON visual layout), the
  `⏸ <label> paused at i/max (reason)` timeline log
  marker (splitting it across multiple lines), and
  the `reason` payload on the emitted `pause` event.
  All three downstream sinks now stay single-line
  regardless of input. An all-whitespace reason
  (e.g. `"   \n\t  "`) now resolves to `null` rather
  than an empty string, so the user-facing pause
  message no longer renders a stray ` ()` suffix.

### CI
- The `Syntax check` job in `.github/workflows/ci.yml`
  now recursively walks the shipped `.mjs` roots
  (`extension`, `packages/tui/src`, `packages/tui/bin`)
  via `find … -type f -name '*.mjs' -print0` instead of
  listing `packages/tui/src/*.mjs` and the components
  subdir explicitly. The previous form silently skipped
  any new subdirectory under `packages/tui/src/` (e.g.
  `src/util/`), so a syntax error in such a file would
  reach `main` undetected. Added a guard that aborts the
  step with a loud error if fewer than 10 files are
  scanned, so emptying the search roots can't pass green.
  The local mirror test (`every shipped .mjs parses
  cleanly with node --check`) was updated in lockstep
  with a recursive walker, and a new
  `ci.yml: syntax-check step recursively walks shipped
  .mjs roots` drift-guard pins the find-based form so a
  future "tidy" pass cannot quietly revert to the
  explicit-subdir loop.

### Tests
- Added direct branch-coverage unit tests for
  `evaluateAdaptiveSignals` (the
  adaptive-iteration-budget signal evaluator at
  `extension/handler.mjs:686`). The function is
  now exported via `__test__` so each branch can
  be exercised in isolation: shortstat-detected
  changes, porcelain fallback (with singular vs
  plural phrasing), distinct-hash novelty,
  combined git+hash reason, identical-hash
  no-op, gitExec throw swallowed, gitExec ok=false
  treated as no signal, and the documented
  `ADAPTIVE_WINDOW = 3` constant. Previously
  these branches were only reached transitively
  through the loop-driven adaptive_budget tests,
  which made it expensive to pin individual
  reason strings and tolerated phrasing drift.

### Documentation
- README.md and the `ralph_status` tool
  description in `extension/handler.mjs` now
  document the five pause-state fields the
  snapshot has been returning since the iter-30
  fix (`paused`, `pause_reason`, `paused_at`,
  `paused_for_ms`, `total_paused_ms`) plus the
  `(PAUSED — …)` substring appended to the
  one-line LLM summary. The README's example
  JSON payload was extended to include them, the
  prose overview now mentions "pause state", and
  a new behaviour-notes bullet explains the
  semantics (current vs cumulative pause windows,
  ISO timestamp only when paused, etc.).
  Hardened the existing
  `ralph_status: README documents the tool` test
  into a docs-drift guard: it asserts every
  pause field name appears verbatim in the
  example payload, that the prose mentions pause
  state, and that the handler's tool description
  agrees — so a future README "tidy" pass can't
  silently drop the documentation again.

### Refactor
- `extension/handler.mjs` — consolidated
  `defaultGitExec` and `defaultAdaptiveGitExec`
  (the two production gitExec entry points) into
  a single `runGitCommand(args, cwd, timeoutMs)`
  helper. The two functions were near-byte-
  identical clones differing only in their
  timeout constant (`GIT_TIMEOUT_MS` vs
  `ADAPTIVE_GIT_TIMEOUT_MS`) and a missing `code`
  field on the adaptive variant. Future env-
  hardening or timeout-policy tweaks now live in
  one place. Behaviour-preserving (the adaptive
  result shape gained the `code` field — its only
  caller, `evaluateAdaptiveSignals`, reads `.ok`
  and `.stdout` only). Drift guard in
  `test/extension.test.mjs` asserts exactly one
  `spawnSync("git", …)` call site remains in
  `extension/handler.mjs` so the duplication
  can't ossify back.

### Fixes
- `extension/handler.mjs` — `ralph_status` now
  surfaces pause state. The snapshot's active
  branch gained five fields: `paused` (bool),
  `pause_reason` (string|null), `paused_at`
  (ISO timestamp|null), `paused_for_ms` (current
  pause duration, 0 when not paused), and
  `total_paused_ms` (cumulative across prior
  pause/resume cycles). The one-line LLM summary
  appended `(PAUSED — <reason>, for <ms>ms)`
  whenever the loop is parked. Before this, an
  operator who called `ralph_pause` and then
  `ralph_status` saw the iteration counter and
  elapsed clock advancing as usual — there was
  no observable difference between a paused loop
  and a slow / blocked one. Reliability gap; pure
  additive change to the JSON payload (no removed
  or renamed keys). New behaviour test in
  `test/extension.test.mjs` exercises pause →
  status → resume → status to pin every field.

### CI
- `.github/workflows/ci.yml` — replaced
  `npm ci --no-audit --no-fund || npm install
  --no-audit --no-fund` with a conditional
  `npm ci` gated on `hashFiles('package-lock.json')
  != ''`. The previous form silently fell through
  to `npm install` whenever `npm ci` failed,
  which is exactly the manifest/lockfile drift
  scenario `npm ci` is supposed to *catch* — a
  missing or out-of-date lockfile would have been
  papered over by `npm install` resolving fresh
  versions at CI time. Today the root has zero
  dependencies and no lockfile, so the gated
  step skips entirely; the moment a contributor
  commits a lockfile alongside new deps, CI
  enforces it deterministically. Added a
  drift-guard test in `test/extension.test.mjs`
  that pins the `run:` line: it must invoke
  `npm ci --no-audit --no-fund`, must not contain
  `||` or `npm install`, and the step must be
  gated on the lockfile.

### Fixes
- `extension/events-emit.mjs` — index.jsonl entries
  now include `type: "armed"`. Previously the
  emitter wrote `{runId, label, startedAt,
  maxIterations, minIterations}` without a `type`
  field, but the TUI's `readRunIndex`
  (`packages/tui/src/writer.mjs:227`) filters for
  `obj.type === "armed"`, so `ralph-tui list` and
  `ralph-tui stats` silently dropped every run the
  extension's lighter sibling emitter recorded.
  `packages/tui/src/writer.mjs`'s `recordIndex`
  already emits the field — only the
  install.sh-shipped sibling had drifted from the
  contract. Added a cross-component round-trip
  test: write via `extension/events-emit.mjs`,
  read via `packages/tui/src/writer.mjs`'s
  `readRunIndex`, assert the run surfaces.

### Documentation
- Added `.github/copilot-instructions.md` — the
  canonical filename GitHub Copilot loads on
  session start. Until now `AGENTS.md` referenced
  it as the dual-trailer source-of-truth, but the
  file was missing, so AI tooling that followed
  the link fell through silently. The new file is
  a thin redirect to `AGENTS.md` (the single
  source of truth for commit / changelog /
  versioning conventions) plus a quick summary so
  agents that don't follow the link still see the
  rules. New `test/extension.test.mjs` drift
  guards: (1) every in-repo path AGENTS.md
  references must exist, (2) the
  copilot-instructions.md must point at AGENTS.md
  and mention Conventional Commits + Keep a
  Changelog by name.

### Tests
- `test/extension.test.mjs` — three new tests pin
  the `warnPromiseDrift` runtime warning for both
  `self_improve` and `grow_project`. Until now the
  helper's log line ("self_improve: warning —
  completion_promise=… differs from the baked SDLC
  prompt's "COMPLETE" emit instruction; loop may
  run to max_iterations") had zero direct
  coverage — only schema-description tests hinted
  at it. A future tweak to the message format
  (which is what users / log-grep tooling read)
  could regress silently. Now pinned: structured
  form (tool prefix + field name + JSON-stringified
  override + baked-token quote + consequence), the
  no-warning path when promises match, and the
  grow_project variant (ABORT_NO_BACKLOG vs
  ABORT_NO_IMPROVEMENTS).

### Refactor
- `extension/handler.mjs` — extracted the
  `warnPromiseDrift` helper to closure scope so
  `self_improve` and `grow_project` share a single
  implementation. Previously the function was
  defined byte-identically inside each handler
  (modulo the tool-name prefix in the log
  message), so a future tweak to the warning text
  could drift between the two tools. Pure refactor
  — behaviour and log messages unchanged; the 431
  existing tests continue to pin the
  prompt/runtime drift warnings.

### Internal
- Added `.nvmrc` pinning Node major **20** so
  contributors who run `nvm use` / `fnm use` /
  `asdf install` land on the same Node major CI's
  primary matrix runs against (and `engines.node`
  declares as the floor). New
  `test/extension.test.mjs` drift guard parses
  `.nvmrc` plus `package.json#engines.node` and
  asserts the majors agree — bumping the engines
  floor without bumping `.nvmrc` (or vice versa)
  now fails CI loudly instead of silently
  diverging.

### Documentation
- README + `docs/RELEASING.md` — install / pin
  snippets now include `events-emit.mjs` in their
  curl loops. The previous snippets fetched only
  `extension.mjs` and `handler.mjs`, so anyone
  following Option A (user-scoped), Option B
  (project-scoped), Option C (pinned release), or
  the manual release checklist's `gh release create`
  invocation ended up with a partially copied
  extension that crashes at module-load with
  `Cannot find module './events-emit.mjs'`. The
  Windows note and the Troubleshooting "/extensions
  doesn't list ralph" entry have been refreshed to
  match. `docs/RELEASING.md` no longer describes
  the tag-driven workflow as "tracked in #10 until
  that ships" — it ships at
  `.github/workflows/release.yml`. Added a
  `test/extension.test.mjs` drift guard that scans
  every `for f in <list>; do` loop in README.md and
  RELEASING.md and asserts the file list matches
  `extension/*.mjs` — mirrors the existing
  install.sh + release.yml drift guards.

### Fixes
- `.github/workflows/release.yml` — release tarball
  now also includes `extension/events-emit.mjs`. The
  workflow previously attached only `extension.mjs`
  and `handler.mjs` as release assets, but
  `handler.mjs` imports `./events-emit.mjs` (added in
  the events-emit feature). Anyone who downloaded a
  release tarball got a broken three-quarters
  extension that crashed at module-load time. Added
  a `test/extension.test.mjs` drift guard that
  parses `release.yml` for `extension/*.mjs` lines
  under `gh release create` and asserts the set
  matches the actual `.mjs` files on disk — so a new
  module can never silently land without a release
  asset entry again.

### Tests
- `test/extension.test.mjs` — three new behavioural
  tests for `install.sh` that actually spawn `bash`
  against the script (under a sandboxed `$HOME` so
  the dev's real `~/.copilot/extensions/ralph` is
  never touched). Cover: `--help` prints the
  Usage/flag block; `--dry-run` reports the right
  target dir + every FILES entry with a byte size
  AND does not create the target directory; and
  `--dry-run --dry-run` plus `--<unknown-flag>` both
  exit non-zero with the expected stderr. Until now
  the only `install.sh` coverage was a static FILES
  drift guard — the script's actual execution path
  had zero coverage.

### Performance
- `packages/tui/src/writer.mjs` — `aggregateRuns`
  no longer computes `iters.max` via
  `Math.max(...iterCounts)`. The spread form throws
  "Maximum call stack size exceeded" once the iter
  counts array crosses Node's argument-count limit
  (~150k entries on V8). A long-lived user with
  daily `self_improve` runs would eventually
  accumulate enough recorded runs that `ralph-tui
  stats` would silently crash. Switched to a
  `reduce` pass that handles arbitrary array sizes
  in O(n). Regression test pumps 200_001 synthetic
  runs through `aggregateRuns` via an in-memory fs
  stub and asserts no throw plus correct totals.

### Documentation
- README — `ralph_loop` "Tool parameters" table now
  lists `adaptive_budget`, `adaptive_extension`, and
  `adaptive_max_total` with their canonical defaults
  (`false`, `10`, `min(max_iterations*5, 1000)`).
  These three were missing from the canonical
  defaults table even though the JSON schema has
  advertised them since the adaptive-budget feature
  landed (issue #4); users had to dig into the
  prose section further down to find them. Adds a
  `test/extension.test.mjs` drift guard that
  enumerates every `ralph_loop` schema property and
  asserts a backtick-wrapped row exists in the
  README — so a new param can never silently land
  without a README entry again.

### Fixes
- `extension/events-emit.mjs` — `makeRunId` now
  substitutes `Date.now()` when `startedAt` is
  non-finite (undefined / NaN / Infinity / string /
  object). Without this, two callers that both
  forgot to pass `startedAt` would generate the same
  literal id (`"ralph_loop-undefined"`), collide on
  the same per-run directory, and silently overwrite
  each other's events. The lenient fallback matches
  the file's documented contract ("swallow every
  error so the loop keeps running") while preserving
  the unique-per-call-id property the writer / TUI
  depend on. Adds a regression test that pumps seven
  bad-input shapes through `makeRunId` and asserts
  each fallback yields a finite timestamp ≥ now().

### CI
- `.github/workflows/ci.yml` — extend the syntax
  check loop to cover `packages/tui/src/*.mjs`,
  `packages/tui/src/components/*.mjs`, and
  `packages/tui/bin/*.mjs` in addition to
  `extension/*.mjs`. The TUI's component tests
  dynamically skip in CI when `ink` / `react` aren't
  installed (the workflow does not run `cd
  packages/tui && npm install`), so a syntax error in
  any component file would otherwise slip through
  CI undetected. Parse-checking is dependency-free
  and ~10 ms per file, closing the gap cheaply.

### Tests
- `test/extension.test.mjs` — add a local mirror of
  the CI parse-check (`every shipped .mjs parses
  cleanly with \`node --check\``) so `npm test` fails
  immediately on a syntax regression in any shipped
  `.mjs`, regardless of whether any test imports it.

### Fixes
- `extension/events-emit.mjs` — `serialize()` now
  catches `JSON.stringify` throws (e.g. circular
  refs, `BigInt` payloads) and drops the bad event
  instead of crashing the loop. The file's contract
  is "swallow every error so the loop keeps running"
  (lines 6-8); the two un-guarded `JSON.stringify`
  calls were the last paths through which a single
  malformed internal event could take the entire
  ralph_loop / self_improve / grow_project process
  down. Adds a regression test that pumps a `BigInt`
  field and a self-referential cycle through
  `e.write()` and asserts no throw + no partial line
  on disk + a subsequent good event still writes.

### Internal
- `.gitignore` — add `.env`, `.env.*`, `coverage/`,
  and `*.tgz` to the repo's ignore list. The `.env*`
  patterns are the de-facto-standard preventive
  entries against accidentally committing local
  dotenv files (which routinely contain credentials)
  via `git add -A`. The extension itself doesn't use
  dotenv, but contributor tooling — asciinema
  recipes, ad-hoc scripts, IDE launchers — often
  does. `coverage/` and `*.tgz` are defensive entries
  for future `c8`/`nyc` and `npm pack` output. Add a
  regression test that asserts `.env` and `.env.*`
  remain present so a future "simplify" PR cannot
  silently regress the security-critical lines.

### Refactor
- `extension/handler.mjs` — wrap `gitExec` and
  `adaptiveGitExec` at the controller boundary so a
  throwing injection (test stub or a future
  production exec that forgets the `{ ok, stdout,
  stderr, code }` convention) is normalized to
  `{ ok: false, stdout: "", stderr: <message>, code:
  null }` instead of propagating up the stack. Before
  this change, a throwing test-injected gitExec would
  crash `captureGitArmSnapshot` mid-`armLoop`,
  leaving caffeinate running and the loop never
  armed. After the change, every gitExec call site
  (arm-time snapshot, `ralph_status`'s
  buildStatusSnapshot, the files-changed block, the
  adaptive-budget signal evaluator) can treat the
  function as total — no per-call try/catch needed.
  Production behaviour is unchanged because
  `defaultGitExec` already returns `{ok:false}` on
  every internal failure path; this only tightens
  the contract for callers.

### Documentation
- `packages/tui/README.md` — fix two drift points
  about how `src/tail.mjs` detects file replacement.
  The README claimed only "inode changes" trigger
  the reader's offset reset, but the implementation
  has tracked **both** `ino` and `birthtimeMs` since
  the early TUI hardening pass — that's what defeats
  the Linux-ext4 blind spot where a freed inode is
  immediately reallocated to the next file in the
  same directory (so naïve `ino`-only detection
  silently misses the replacement when the new file
  happens to start with bytes that match the old
  file's tail). Both the Architecture notes bullet
  and the Tests coverage bullet now describe the
  ino+birthtime pair the code actually maintains and
  that `tail.test.mjs` already exercises.

### Tests
- Add a drift-guard test that asserts `install.sh`'s
  hardcoded `FILES=(extension.mjs handler.mjs
  events-emit.mjs)` array matches the actual set of
  `*.mjs` files under `extension/` on disk. Closes
  the install-time half of the same drift class CI's
  `node --check` got fixed for in b4c0ff1: today, if
  a contributor adds `extension/foo.mjs` without also
  updating `install.sh`, the new module silently
  fails to install — the user-scoped Copilot CLI
  extension dir would be missing it and Copilot would
  crash on import. The test parses the literal
  `FILES=(...)` declaration out of `install.sh` and
  compares to `readdirSync('extension')` filtered to
  `.mjs`. Surgical: the install script keeps its
  explicit list (so post-copy verification stays
  targeted) but is now mechanically guarded against
  going stale.

### Fixes
- `packages/tui/src/writer.mjs` — harden `pruneRuns`
  against the same path-traversal class
  `resolveRunEventsPath` already rejects (issue
  follow-up to fb2d2f8). Today a hand-edited or
  corrupted `index.jsonl` row whose `runId` contained
  `..`, `/`, `\`, or `\0` would let `path.join(root,
  runId)` resolve outside the runs root, after which
  `rmSync(..., { recursive: true, force: true })`
  would happily delete the sibling directory. The
  writer never produces such ids — `makeRunId` only
  emits `[A-Za-z0-9_-]+` — so this is purely a
  defence-in-depth guard for caller-supplied input.
  Hostile rows are now treated as survivors: they
  stay in the index (so an operator can audit them)
  but never reach `rmSync`. Extracted the runId
  predicate into a shared `isPathTraversalRunId`
  helper so the read path (`resolveRunEventsPath`)
  and the delete path (`pruneRuns`) cannot drift.

### Tests
- Add 5 direct unit tests for `pruneRuns` in
  `packages/tui/test/writer.test.mjs` (until now this
  helper was uncovered): the new path-traversal
  guard via a sentinel sibling directory, the happy
  path that deletes only the matching per-run dir,
  `dryRun: true` byte-for-byte fidelity of the
  index, input-validation of `olderThanMs`, and the
  empty-state path when `index.jsonl` is absent.

### CI
- `.github/workflows/ci.yml` — the **Syntax check** step
  was hard-coded to `node --check extension/extension.mjs
  && node --check extension/handler.mjs`, which silently
  excluded `extension/events-emit.mjs` from CI's parse
  guard once that file shipped. Worse, attempting the
  fix as `node --check extension/*.mjs` would only have
  validated the first glob match (Node's `--check` flag
  ignores positional arguments past the first), giving
  the appearance of coverage while still skipping the
  rest. Replace with an explicit shell loop that runs
  `node --check` against every `.mjs` under `extension/`,
  so new sibling files are automatically covered. Drives
  parity with `install.sh`'s post-copy verification,
  which already iterates the same FILES list.

### Documentation
- `docs/ARCHITECTURE.md` — fix three drift points so the
  contributor-facing architecture doc matches reality:
  (1) the **Source layout** tree was missing
  `extension/events-emit.mjs`, `test/events-emit.test.mjs`,
  `test/handler-events.test.mjs`, and the entire
  `packages/tui/` directory; (2) the **Tool surface**
  table was missing the `ralph_pause` and `ralph_resume`
  rows even though both tools have shipped (issue #3);
  (3) the **Notable fields** list omitted the pause-state
  fields (`paused` / `pauseReason` / `pausedAt` /
  `totalPausedMs`) and how `ralph_resume` zeroes the
  streak detector and folds `pausedFor` into
  `totalPausedMs`. Add a load-time test
  (`ARCHITECTURE.md tool surface table lists every
  registered tool`) that walks `controller.tools` and
  asserts every registered tool name appears in the
  table — preventing this kind of drift on future tool
  additions.

### Tests
- Add 7 direct unit tests for `aggregateRuns` in
  `packages/tui/test/writer.test.mjs`. Until now this
  helper was only exercised end-to-end via the
  `bin stats` CLI test. The new tests pin its contract on
  edge cases the bin test never touched: empty index, run
  with no terminal event, multiple terminal events (last
  wins), missing events.jsonl on disk (skipped), malformed
  JSONL lines (skipped silently), terminal event with no
  `reason` (buckets under bare type), and arithmetic mean
  across multiple runs.

### Fixes
- `packages/tui/bin/tui.mjs` — render `TypeError` validation
  failures (e.g. `resolveRunEventsPath` rejecting a
  path-traversal runId) as a clean one-line stderr message
  with exit code 2 instead of dumping a Node stack trace.
  Genuinely unexpected errors keep their full stack so they
  remain debuggable. Together with the previous commit, a
  stray `ralph-tui replay ../etc/passwd` now produces
  `ralph-tui: resolveRunEventsPath: runId "../etc/passwd"
  contains path separators or traversal segments` and
  exits 2 — instead of a confusing multi-line trace.
- `packages/tui/src/writer.mjs` — `resolveRunEventsPath` now
  rejects runIds containing path separators (`/`, `\`),
  null bytes, or `..` traversal segments with a clear
  `TypeError`. Emitter-produced runIds (`[A-Za-z0-9_-]+`)
  are unaffected; the guard is a safety net for the
  user-supplied `runId` argument on `ralph-tui replay`,
  `ralph-tui watch`, and any future subcommand that takes a
  runId from the command line. Without it, a stray
  `replay ../../etc/passwd` would happily build a path
  outside the runs root and surface a confusing
  "ENOENT" instead of an actionable validation error.

### Refactor
- `packages/tui/bin/tui.mjs` — `cmdDoctor` now calls the
  existing `readTuiVersion()` helper instead of re-implementing
  the same package.json read inline. Pure deduplication: the
  doctor output is byte-identical (existing
  `bin doctor: healthy case` test continues to pass) but the
  package.json resolution logic (path computation,
  `JSON.parse`, "unknown" fallback) now lives in exactly one
  place. Future work that needs to surface the TUI version
  has a single helper to reach for.

### Documentation
- `README.md` — replace the duplicated `**Contents:**` line
  pair with a single, accurate ToC. The two lines had drifted:
  the first was missing `Pause/resume`, the second was
  missing `Documentation`, `Inspecting a running loop`,
  `Adaptive budget`, `Development`, and `License`. Readers
  saw two near-identical bullet lines and either followed a
  broken link or didn't know the section existed at all. The
  merged line now includes every top-level (H2) section in
  document order: What is Ralph? · What's different · Install
  · Usage · Development · Documentation · Self-improve ·
  Grow-project · Inspecting a running loop · Adaptive budget
  · Pause/resume · How it works · Commit attribution · Keep
  system awake · Troubleshooting · Limitations · Requirements
  · Changelog · License. Anchors verified against the actual
  H2 / H3 headings.

### Tests
- Add 16 unit tests for `extension/events-emit.mjs`
  (`test/events-emit.test.mjs`). Until now the zero-dep
  JSONL emitter shipped next to `handler.mjs` was only
  exercised indirectly via `handler-events.test.mjs`. The
  new file pins the exported contract directly:
  `resolveRunsRoot` (default, env override, blank/whitespace
  fallback, missing env arg), `makeRunId` (composition,
  sanitisation of non-`[A-Za-z0-9_-]` chars, empty/null/
  undefined label fallback), and `createEventEmitter`
  (single-line append, armed-also-writes-index, non-armed
  does-not-touch-index, falsy-event drop, excerpt clipping
  to 500 chars + ellipsis, swallowed mkdir/append errors,
  memoised mkdir, idempotent close, oversize-event drop).
  Total suite count is now 399 (was 383).

### Fixes
- `docs.yml` workflow: replace the inline single-line `run:`
  scalar with a block scalar (`|`) so the embedded `docs:`
  colon in the gh-deploy commit message no longer trips the
  YAML parser. Symptom: every push since the workflow landed
  produced a phantom "Deploy docs site" run with conclusion
  `failure`, no jobs, and the GitHub UI message "This run
  likely failed because of a workflow file issue" — because
  GitHub parses workflow files *before* applying `paths:`
  filters, so a YAML syntax error fails the run even on
  pushes that don't touch `docs/**`. Replacing the inline
  `--message "docs: deploy ${{ github.sha }}"` with a block
  scalar containing `--message "docs deploy ${{ github.sha
  }}"` (no colon) makes every workflow file parse cleanly
  (`python3 -c "import yaml; yaml.safe_load(...)"` confirmed
  for all three of `ci.yml`, `docs.yml`, `release.yml`).
- `tailEventsFile` (packages/tui) now detects file replacement
  even when the freed inode is reused by the next file in the
  directory — common on Linux ext4 — by tracking
  `stat.birthtimeMs` alongside `stat.ino`. Previously, an
  `unlink + writeFileSync` rotation whose new first line had
  the same byte length as the old single line (e.g. two
  minimal `armed` events sharing ~38 bytes) would skip the
  entire first event of the rotated file because `offset` was
  not reset. The fix treats *either* a new inode *or* a new
  birthtime as the replacement signal and resets `offset`,
  `pending`, and `lastSize` accordingly. Pinned by a new
  fakeFs-driven regression test that simulates same-ino /
  fresh-btime rotation deterministically across platforms.
  This unblocks CI, which had been red on every push since
  e65de63 because the existing rotation test relied on Linux
  kernel inode-reuse behavior that only triggered on the
  runner.

### Features
- `self_improve` now treats red GitHub Actions runs as the
  highest-priority signal. ORIENT best-effort lists failing
  workflow runs via `gh run list --status failure --limit 10
  2>/dev/null || true` and captures the failed log with
  `gh run view <id> --log-failed 2>/dev/null || true`. IDEATE
  declares a three-tier priority order — RED CI first, then
  open-issue match, then the rotating SDLC categories — so an
  iteration heals a broken pipeline before polishing anything
  else. The prompt explicitly guards against the easy-way-out
  anti-pattern of silencing the failure with
  `continue-on-error` or deleting the failing job; the agent
  must fix the root cause (flaky → harden, drift → pin/update,
  regression → revert or fix forward) and verify the rerun is
  green via `gh run rerun` or a fresh push. Pinned by a new
  prompt assert covering the `gh run list --status failure`
  literal, the `|| true` best-effort fallback, the
  `--log-failed` drill-down, the RED-CI-before-rotating-SDLC
  ordering, and the `continue-on-error` anti-pattern callout.
- `self_improve` ORIENT stage now best-effort lists open GitHub
  issues via `gh issue list --state open --limit 30 2>/dev/null
  || true` so an iteration doesn't duplicate, contradict, or
  pre-empt work a human (or a prior `grow_project` run) has
  already filed. The IDEATE stage is updated in lockstep:
  candidate improvements that match an open issue are addressed
  end-to-end with `Closes #N` (or `Refs #N` for partial fixes),
  and issues carrying the `grow-project` or `proposed` label are
  deferred so `self_improve` doesn't race the backlog runner.
  The query is best-effort — a missing or unauthenticated `gh`
  silently no-ops via `|| true` rather than aborting the
  iteration. Pinned by a new prompt assert covering the literal
  command, the `|| true` fallback, the `--state open` scope, and
  the IDEATE label-defer semantics.
- `ralph_loop` now appends a small commit-attribution rider to the
  user-supplied prompt at arm time, reaching parity with
  `self_improve` and `grow_project` (issue #1). Any git commit
  produced during a `ralph_loop` iteration carries the same dual
  `Co-authored-by:` trailer (Copilot + copilot-ralph) and honors
  the same `RALPH_NO_ATTRIBUTION=1` env-var opt-out. The rider is
  inert when an iteration produces no commit, so generic
  `ralph_loop` tasks (log analysis, exploration) are unaffected.
  The new `BAKED_RALPH_LOOP_RIDER` literal participates in the
  module-load attribution invariant (both trailers in canonical
  order + opt-out env var documented) so a future edit can't
  silently break the parity. README "Commit attribution" and
  "Limitations" sections updated; tool description discloses the
  augmentation; the new helper `composeRalphLoopPrompt` rejects
  user prompts that would push the composed length past
  `MAX_PROMPT_CHARS` with a clear error.
- Tag-driven release workflow at `.github/workflows/release.yml`
  (issue #10). Pushing a `v*.*.*` tag verifies that
  `package.json#version` matches the tag, that `CHANGELOG.md` has a
  section for the version, runs `npm test`, and creates a GitHub
  Release with `extension/extension.mjs` and `extension/handler.mjs`
  attached as standalone downloadable assets so users can pin a
  specific revision instead of curling from rolling `main`. Pre-flight
  checks fail fast so a malformed tag never produces a half-baked
  release. README adds an "Option C — Pin a specific tagged release"
  install snippet.
- `grow_project` IDEATE stage now bootstraps the three labels it
  uses (`grow-project`, `proposed`, `in-progress`) with idempotent
  `gh label create … 2>/dev/null || true` calls before issuing
  `gh issue create --label X` for the first time. Previously the
  baked prompt instructed the agent to create issues with labels
  that may not exist yet, so a brand-new repo's iter 1 would fail
  with `gh: could not add label …` and burn the iteration trying
  to recover. The README already promised this behaviour but the
  prompt body never delivered. Pinned by four new prompt asserts
  (`gh label create grow-project`, `gh label create proposed`,
  `gh label create in-progress`, and `|| true` for idempotency).
- `self_improve` and `grow_project` baked SDLC prompts now ship a
  second `Co-authored-by: copilot-ralph
  <copilot-ralph@users.noreply.github.com>` trailer on every
  loop-driven commit, alongside the existing `Copilot` trailer
  (issue #1). The new trailer attributes loop output to a
  dedicated `copilot-ralph` GitHub account so usage is passively
  searchable across public GitHub via `gh search commits
  "copilot-ralph@users.noreply.github.com"` (raw-text search;
  GitHub's commit-search API has no `co-authored-by:` qualifier) —
  zero-infrastructure analytics. Setting
  `RALPH_NO_ATTRIBUTION=1` in the environment instructs the agent
  to omit ONLY the `copilot-ralph` trailer; the `Copilot` trailer
  (and `Closes #N` for `grow_project`) always ships. README adds a
  new "Commit attribution" section disclosing the dual trailer,
  the opt-out env var, and the caveats (public-repo-only
  searchability via the GitHub commit-search API; opt-in-telemetry
  framing; account-must-exist-first ordering). Two new prompt
  pin-tests anchor the canonical noreply email and the opt-out
  polarity ("omit" within 200 chars of `RALPH_NO_ATTRIBUTION=1`)
  so a future edit can't silently drop the bot-account trailer or
  invert the opt-out polarity. A subsequent commit added a
  load-time parity guard that fails module import if either
  prompt drops the canonical Copilot or copilot-ralph trailer
  literal, regresses on trailer order (Copilot must precede
  copilot-ralph — GitHub's commit UI surfaces the first
  co-author more prominently), or stops documenting the
  `RALPH_NO_ATTRIBUTION=1` env var. The new
  `BAKED_COPILOT_TRAILER`, `BAKED_RALPH_TRAILER`, and
  `BAKED_ATTRIBUTION_OPT_OUT` literals are exported through
  `__test__` for symmetric pinning with the existing
  `BAKED_*_ABORT_TOKEN` constants. Follow-up commits widened the
  invariant outward to two more surfaces: a README pin test reads
  `README.md` from disk and asserts both canonical trailer
  literals, the opt-out env var, and the public-repo-only
  searchability caveat are present (and that Copilot precedes
  copilot-ralph in the example block); and an armLoop runtime
  pin asserts the prompt the executing agent actually receives
  via `session.send` contains all three baked literals — closing
  the loophole where a "minimize tokens" / "strip example block"
  pass between `PROMPT_*` and `session.send` could silently
  break attribution while leaving body-level pins intact. Two
  narrow regex pins on the canonical-literals test (noreply
  domain ends with `@users.noreply.github.com>`, header starts
  with the exact `Co-authored-by: ` prefix) defend against the
  silent-typo failure mode where a misspelled domain or
  miscased header ships valid commits whose trailers do not
  link to any GitHub user.

### Fixes
- README user-facing sections now name `grow_project` as the third
  loop tool throughout. Three stale spots still hardcoded the
  pre-`grow_project` two-tool wording: the "How it works" code-
  example inline comment listed only `ralph_loop + ralph_stop +
  self_improve` (one tool short of the four `controller.tools`
  actually exposes); the Troubleshooting "`<owner>` is already
  armed/running" entry said the leading word reflects "ralph_loop
  or self_improve" and the guard "fires on either tool"
  (undersold the third); and the Limitations "One loop per
  session" callout said "arming a second `ralph_loop` (or a
  `self_improve`)" fails — missing `grow_project` and only
  describing two of the six pairwise directions of the symmetric
  conflict. All three updated; no remaining
  `ralph_loop or self_improve` enumeration survives in user-facing
  README copy.
- `self_improve` `focus` schema description now discloses the
  steering semantics ("Steers ideation and improvement selection
  without altering the SDLC stages") matching the parallel callout
  on `grow_project.focus`. Previously the `self_improve.focus`
  description was bare ("Optional focus area appended to the SDLC
  prompt …"), letting callers reasonably assume `focus` was a
  free-form addendum that might skip stages — when in fact it only
  narrows what the agent picks at IDEATE/SELECT time.
- `ralph_loop` and `ralph_stop` schema descriptions now name all
  three loop tools (`ralph_loop`, `self_improve`, `grow_project`)
  symmetric with the runtime `activeLoopGuard`. Previously
  `ralph_loop`'s description had no active-loop conflict callout
  at all (so an LLM dispatcher had to learn the conflict from a
  runtime failure), and `ralph_stop`'s description hardcoded
  "Cancel a currently-running ralph_loop or self_improve",
  missing `grow_project` — leaving a dispatcher with a
  `grow_project` loop active no signal that `ralph_stop` was the
  cancel endpoint.
- `self_improve` `completion_promise` and `abort_promise` schema
  descriptions now disclose the baked-SDLC-prompt drift footgun.
  Previously the descriptions were generic copies of `ralph_loop`'s
  ("Substring that, when present in an assistant turn's response,
  signals completion"), with no mention of the SDLC prompt body.
  An LLM dispatcher reading the schema before calling had no
  warning that overriding either field without also editing the
  prompt body silently runs the loop to `max_iterations`. The
  runtime `warnPromiseDrift` log line still fires, but only AT
  arm-time — by which point the wrong promise was already chosen.
  The `abort_promise` description also now references the literal
  baked token (`ABORT_NO_IMPROVEMENTS`) and notes the field has no
  default, so callers know to supply the token explicitly to honor
  the abort signal. (`grow_project` already had the parallel
  callout.)
- `grow_project` `focus` validation errors now carry the
  `grow_project:` prefix instead of `self_improve:`. The shared
  `parseFocus` helper hardcoded the latter, so a too-big or
  wrong-typed `focus` passed to `grow_project` would surface
  `"self_improve: focus exceeds 2000 characters …"` — the
  wrong tool name in the error stream. `parseFocus` now takes a
  `toolName` parameter (default preserves backwards compatibility
  for the existing `self_improve` call site).
- `ralph_stop` "no active loop" error message now reads
  `"no ralph_loop, self_improve, or grow_project is currently
  running."` Previously it only mentioned `ralph_loop` and
  `self_improve` — a user trying to cancel a non-existent
  `grow_project` loop saw a misleading message.
- `self_improve` schema description now discloses that a
  `grow_project` loop also blocks it (matching the symmetric
  `activeLoopGuard`). Previously the description hardcoded
  `"ralph_loop or self_improve"` and never mentioned the third
  peer; the model reading the schema had no warning before
  hitting the runtime guard.
- `self_improve` argument-validation errors are now guaranteed to
  carry the `self_improve:` prefix even if a future `validateArgs`
  path forgets the delegated `ralph_loop:` prefix. The previous
  bare regex rewrite (`replace(/^ralph_loop:/, "self_improve:")`)
  would silently no-op on a missing prefix and leak a tool-less
  error message to callers; the rewrite now falls back to an
  explicit `self_improve: <msg>` prepend so the tool name is
  always present in the error stream.
- `self_improve` now emits a one-shot arm-time warning when the
  caller overrides `completion_promise` / `abort_promise` with a
  value that differs from the baked SDLC prompt's literal emit
  tokens (`COMPLETE` and `ABORT_NO_IMPROVEMENTS`). Previously the
  prompt would instruct the agent to emit one token while the
  runtime watched for another, silently running the loop to
  `max_iterations` on an otherwise-successful turn. The warning
  names the offending field, the supplied value, the expected
  baked token, and the consequence so operators can spot the
  mismatch in the timeline instead of diagnosing a stuck loop
  after the fact.

### Changes
- `self_improve` `focus` length cap raised from 500 → 2000 characters.
  The previous 500-char cap was tight enough that real-world focus
  strings (a sentence on the goal + a sentence each on test command,
  commit conventions, allowed file paths) routinely tripped the limit
  and forced callers to abbreviate. 2000 chars still fits comfortably
  in `MAX_PROMPT_CHARS` (65536) alongside the baked SDLC prompt.
  `MAX_FOCUS_CHARS` is now exported via `__test__` so tests pin the
  bound symbolically and stay drift-proof through future bumps.

### Features
- **New `grow_project` tool.** Third long-running loop tool,
  parallel to `self_improve`. Where `self_improve` polishes an
  existing codebase, `grow_project` *grows* one: on the first
  iteration it ideates a backlog of small, well-scoped features
  and persists them as **GitHub issues** (`gh issue create
  --label grow-project --label proposed`); subsequent iterations
  each pick one proposed issue, implement it, and close it. The
  per-feature completion gate is **three-part**: tests stay
  green, every checkbox in the issue's `acceptance_criteria`
  block passes, and the issue's `demo_command` is executed and
  its output pasted back as a comment. Reuses all existing
  `armLoop` / `createRalphController` plumbing — only new
  surface is `PROMPT_GROW_PROJECT`, `GROW_PROJECT_DEFAULTS`
  (`max_iterations: 200`, `min_iterations: 10`),
  `GROW_PROJECT_KEYS`, the handler block, and the schema
  registration. Inherits `warnPromiseDrift`, `parseFocus`,
  `requireAttachedSession`, `activeLoopGuard`,
  `validateOptionalArgShape`, and the error-prefix rewrite from
  the same pattern as `self_improve`. The agent emits
  `ABORT_NO_BACKLOG` (a new token, distinct from
  `self_improve`'s `ABORT_NO_IMPROVEMENTS`) when the backlog is
  exhausted; `abort_promise` defaults to that token so the
  signal is wired by default. Active-loop guard is symmetric
  across all three tools — only one loop runs per session at a
  time.

- **New `self_improve` tool.** Thin wrapper that arms `ralph_loop`
  with a baked-in, project-agnostic SDLC self-improvement prompt
  walking the agent through nine stages — ORIENT (read recent
  commits + project docs, detect the test command), IDEATE (rotate
  across SDLC categories: bug fix, hardening, validation, tests,
  refactor, dependency hygiene, docs, release engineering),
  CRITIQUE (rubber-duck pass), BASELINE, IMPLEMENT, TEST, COMMIT
  (conventional-commit prefix + Co-authored-by trailer), PUSH, END
  (emit `COMPLETE` or `ABORT_NO_IMPROVEMENTS`). Use it on any repo
  to drive autonomous improvement without authoring the prompt.
- Schema mirrors `ralph_loop` but with self-improve-flavored
  defaults: `max_iterations` 100 (cap 1000), `min_iterations` 5,
  `completion_promise` `"COMPLETE"`, optional `abort_promise`,
  `stagnation_limit` 3 (≥ 2 or 0), plus a new optional `focus`
  string (≤2000 chars; see the Changes section above for the cap
  bump rationale) appended verbatim as `Focus this run on: <focus>`
  after the SDLC scaffolding.
- `self_improve` reuses the same `state.active` / `finish()` /
  post-loop `additionalContext` pipeline as `ralph_loop` via a
  shared private `armLoop(parsedValue, label)` helper — only the
  log line and success-result text differ in the leading label.
- Every observable log line now carries the calling tool's label.
  `state.active.label` and `state.lastResult.label` ("ralph_loop"
  or "self_improve") flow into the **arm-time log line**
  (`🔁 self_improve armed — max=…`), the per-iteration log line
  (`🔁 self_improve iter N/M`), the send-error log, the idle-skip
  log, the finish log, the **session-abort log**
  (`⏹ self_improve interrupted by session abort …`), and the
  post-loop `additionalContext` bracket (`[self_improve just
  finished — …]`). The `ralph_stop` success text
  (`textResultForLlm`) now also carries the calling tool's label
  — a self_improve-armed loop reports "self_improve stopped
  after N/M iterations …" instead of the previous hardcoded
  "ralph_loop stopped …". New `label` property is documented on
  the `RalphResult` typedef.
- Only one loop runs per session at a time, so calling
  `self_improve` while a `ralph_loop` is active fails fast with
  the existing `is already running` guard (and vice versa). Cancel
  with `ralph_stop`.

### Hardening (post-0.6.0)
- The "already armed/running" guard message now names the **owning**
  loop, not the calling tool. When `self_improve` armed the active
  loop and the agent then calls `ralph_loop`, the failure now reads
  `self_improve is already armed (iteration 1/N pending) — call
  ralph_stop first.` Previously this hardcoded `ralph_loop is already
  …` regardless of which tool actually armed the loop, lying about
  ownership and confusing the calling agent. Mirror behaviour on the
  other side: a `self_improve` invoked while `ralph_loop` armed the
  loop reads `ralph_loop is already …`.
- The `ralph_loop is already armed/running` failure string had
  unbalanced parentheses: the produced sentence ended with
  `…pending — call ralph_stop first).` (stray close paren after the
  period; opening paren around the iteration counter never closed
  cleanly). The string now reads `…(iteration 1/7 pending) — call
  ralph_stop first.` Both `ralph_loop` and `self_improve` emit the
  same string and both are fixed.
- `attach()` is now transactional: if `session.on()` throws partway
  through subscribing the three required events (assistant.message,
  session.idle, abort), any listeners attached before the throw are
  rolled back via their unsubscribe handles before re-throwing. The
  previous code lost those handles to the array literal it was
  building when the throw fired, leaking listeners forever.
- `durationMs` and the iter-log `elapsed` marker are clamped to ≥ 0 so
  a backward `Date.now()` step (NTP correction, RTC skew on resume,
  manual clock change) mid-loop can no longer surface negative time
  in result objects or the timeline.
- `ralph_stop` rejects array / primitive arg shapes loudly (mirrors
  `ralph_loop`'s shape guard) instead of silently falling through to
  "no note".
- `stagnation_limit=1` is now declared invalid in the JSON schema
  via `not: { const: 1 }` (runtime already rejected it; LLM clients
  that honor `not` now see the constraint up front).
- Shape + unknown-keys validation deduplicated into a shared
  `validateArgShape` helper used by both tools.
- Surrogate-safe head-trim of the 1 MiB rolling assistant-content
  buffer: when overflow slicing lands inside a UTF-16 surrogate pair,
  bump the start forward by 1 so the kept buffer never begins with a
  lone low surrogate (would otherwise print as a replacement char).

### Tests / docs
- Regression test pinning the `prompt: null/undefined` → "prompt is
  required" path (some JSON layers normalize undefined → null).
- Regression test pinning that arming a fresh `ralph_loop` clears
  any stale `lastResult` so the post-loop hook doesn't leak the
  previous run's preview into the next prompt.
- README parameter table now surfaces the 200-char cap on
  `completion_promise` / `abort_promise`, the 65536-char cap on
  `prompt`, and a rationale for why `stagnation_limit=1` is rejected.
- `install.sh --help` extracts the comment block dynamically
  (no hard-coded line range), and Option C now documents the
  `--help` flag alongside `--project` and `--dry-run`.
- README polish pass: inline table of contents under the badge;
  Troubleshooting section (5 entries covering missing-extensions,
  already-armed, abort/completion overlap, send_error, runaway);
  Windows install note (WSL / Git Bash / MSYS2 fallback for the
  Bash-only `install.sh`); Node 20+ requirement called out in
  Requirements; Changelog link section; timeline verb legend
  (✅ / ⚠️ / ⏹ → finish reasons); `(elapsed Xms)` in the sample
  iter log line; explicit `attach()` detach return shown in the
  embedder snippet; bare ` ``` ` code fences tagged `text`;
  redundant Tips bullets trimmed (one-loop-per-session,
  stagnation-overrides-min) since the same facts live in
  Limitations / Troubleshooting; abort/completion overlap example
  spelled out with explicit assignment.

## 0.6.0

### Bug fixes (root agentic loop boundary)
- **Refire trigger switched from `assistant.turn_end` to `session.idle`.**
  The SDK emits one `assistant.turn_end` per *agentic-loop sub-turn*
  (each tool-call roundtrip carries its own `turnId`), so a single root
  response with N tool calls produced N+ events. Earlier per-turnId
  dedupe + `fireInFlight` gates didn't cover the case where the root
  agent emitted an `assistant.message` early in the response and then
  ran tool calls — each subsequent sub-turn `turn_end` passed all
  gates and queued another copy of the prompt, reproducing the
  `Queued (N)` UI marker. `session.idle` fires exactly once per
  root-level agentic-loop completion, which is the correct iteration
  boundary. The `fireInFlight` / `observedMessageThisFire` gate is
  retained as belt-and-suspenders.

### Hardening
- `completion_promise` / `abort_promise` are trimmed before being stored
  so copy-paste padding (e.g. `"  COMPLETE\n"`) doesn't silently fail
  to ever match.
- `ralph_stop` rejects unknown argument keys (typo guard mirroring
  `ralph_loop`).
- `install.sh` writes via temp file + atomic `mv`, with cleanup safe
  under macOS bash 3.2 + `set -u` (empty array expansion).

## 0.5.0

### Bug fixes (queue stacking & sub-agent leakage)
- **Queue stacking eliminated** — the SDK can emit multiple
  `assistant.turn_end` events around a single agent reply (sub-turn /
  tool-call boundaries). Each one used to refire the prompt, producing
  the dreaded `Queued (3)` of identical messages in the CLI UI. A
  `fireInFlight` / `observedMessageThisFire` gate now ensures we only
  refire after the *root* agent has actually responded with an
  `assistant.message`. Verified end-to-end with file-based event
  tracing.
- **Sub-agent events (`task` / `explore` / `code-review` /
  `rubber-duck` …) no longer trigger a refire**. Per the SDK schema,
  sub-agent events carry an `agentId` field that is absent on root-
  agent events; both `onTurnEnd` and `onAssistantMessage` now ignore
  any event with `agentId !== undefined`. Without this, every
  sub-agent invocation queued another copy of the prompt.
- **`turn_end` with `turnId=null`** no longer self-deduplicates against
  the initial `NO_TURN_ID` sentinel; a real `null` turnId is now treated
  as "no dedup info" instead of being silently dropped.
- **Stale `session.send` rejection** from a previous (cancelled) arming
  can no longer poison a freshly-armed loop. `tryFire` now snapshots the
  active loop identity at fire-time and ignores late rejections from
  superseded armings.
- **Boolean/array values for numeric args** (`max_iterations`,
  `min_iterations`, `stagnation_limit`) are rejected with a typed error
  instead of being silently coerced via `Number()` (which would yield
  e.g. `Number(true) === 1`).
- **`npm test` works on Node 20.0–20.5** — switched from a quoted
  `'test/**/*.test.mjs'` glob (which relies on Node ≥20.6's built-in
  matcher) to a shell-expanded `test/*.test.mjs` pattern.

### New / hardened behavior
- **JSON schema bounds** declared for every parameter:
  `max_iterations`/`min_iterations` carry `minimum`/`maximum`,
  `completion_promise`/`abort_promise` carry `minLength: 1`,
  `prompt` carries `minLength: 1` and `maxLength: 65536`,
  `ralph_stop.reason` carries `maxLength: 500`. Clients learn the
  bounds up-front instead of via a runtime validation error.
- **`additionalProperties: false`** on both tool schemas — combined with
  runtime unknown-key rejection (see below), typos like `max_iter`
  fail loudly instead of silently using the default.
- **Unknown argument keys** in `ralph_loop` are now rejected at
  validation time with the list of valid keys; the runtime mirrors what
  the JSON schema already enforces.
- **`ralph_stop(reason)`** truncates an oversized user-supplied reason
  in both the response message and `result.note` (≤500 chars,
  surrogate-safe).
- **Tool descriptors are deep-frozen** — consumers can no longer mutate
  nested JSON-schema fields (e.g. `tools[0].parameters.properties.prompt.maxLength`)
  and silently desync the declared schema from the runtime validator.
- **`extension.mjs` wraps `joinSession` and `controller.attach`** in
  try/catch and writes a clear identifying line to stderr on failure
  (instead of a silent unhandled promise rejection at module-load).

### Polish
- **Finish log marker differentiates by reason category** —
  `✅ completed` for `completion_promise`, `⚠️ ended` for
  `send_error` / `aborted`, `⏹ stopped` for everything else. An error
  finish no longer visually reads like a clean cancellation.
- **Multi-line notes are collapsed to one line** in the finish log
  marker and `additionalContext` injection (an `Error` stack would
  otherwise break alignment in the timeline).
- **`already armed` vs `already running`** is reported separately when
  a second `ralph_loop` is invoked, so the caller can tell whether the
  prior loop has fired its first iteration yet.

### CI / docs / refactor
- **`session.on()` returning a non-function** now produces a per-event
  warning (listener-leak risk) instead of being silently filtered out.
- **`ralph_stop` return shape** is now documented in the README,
  including the `iterations` / `note` fields and the `no loop running`
  failure path.
- **GitHub Actions** workflow runs `npm test` on push/PR across Node
  20.x and 22.x. Includes a `node --check` syntax pass on the source
  files.
- **README "How it works"** rewritten to distinguish event-driven
  iteration (`assistant.message`/`turn_end`/`abort`) from the single
  post-loop hook (`onUserPromptSubmitted`), document the per-turn
  decision ladder, and explain why each iteration appears as a queued
  user-turn in the timeline (`session.send`).
- **README test-count drift removed** — replaced "29 tests" with a
  description that doesn't churn on every test addition.
- **Helpers extracted** (`logIterStart`, `collapseNote`) to remove
  duplication.
- **Test suite grew from 56 → 78** covering all of the above plus
  regressions for: surrogate-safe truncation, boundary at exactly
  `MAX_PROMPT_CHARS`, deep-freeze of nested schema, unknown-key
  rejection, stale-detach-during-pendingFire, late-rejection from
  cancelled arming, multiple turn_ends without intervening message,
  sub-agent event filtering, and `session.on()` non-function warnings.

## 0.4.0

### Bug fixes
- **Stale `detach()`** returned by a superseded `attach()` no longer kills
  the controller's currently-active loop. Stale detaches skip the
  `finish('detached')` step and only attempt to remove their own listeners.
- **Double `attach()`** no longer registers duplicate event listeners
  (which caused every turn to be processed twice). The second attach
  tears down the prior wiring first.
- **Pre-attach `ralph_loop` invocation** fails fast with a clear error
  ("session not attached") instead of arming a loop that can never fire.
- **`ralph_stop(null)`** no longer throws — null/non-object args are
  tolerated and treated as "no reason".
- **`previewOf` surrogate-pair safety** — the 500-char preview no longer
  truncates in the middle of a UTF-16 surrogate pair, which previously
  left a lone high surrogate that broke JSON round-tripping.
- **Whitespace-only `completion_promise` / `abort_promise`** are now
  rejected at validation time (previously they silently disabled the
  matcher).
- **`stagnation_limit: 1`** is now rejected — comparison is impossible
  after a single response, so it would always fire on iter 1. Valid
  values are 0 (disabled) or any integer ≥ 2.
- **Substring overlap** between `completion_promise` and `abort_promise`
  (e.g. `"DONE"` / `"DONE_FAIL"`) is rejected — `.includes()` would
  always fire the first matcher, opposite of caller intent.

### New features
- **`success`/`failure` helpers protect message and resultType** —
  `extra` metadata cannot accidentally clobber them.
- **`note` on `send_error`** — the underlying error message is now
  surfaced on `result.note` (sync throw or async rejection) instead
  of only being logged.
- **`note` on aborted reason** — when the SDK abort event carries a
  reason payload (`ev.data.reason` / `ev.reason`), it's surfaced on
  `result.note` and logged.
- **Iteration log lines include elapsed-since-arm** — every
  `🔁 ralph_loop iter X/Y` log now reports `(elapsed Xms)`.
- **Non-string `prompt`** is rejected with a typed error
  (`"prompt must be a string (got array)"`) instead of silently
  coerced via `String()`.
- **`MAX_CONTENT_CHARS = 1 MiB` cap** on the per-iteration accumulated
  assistant content, preserving the tail (where completion phrases
  typically live).

### Defensive
- **`Object.freeze(state.lastResult)`**, controller `tools` array, each
  tool descriptor, and `hooks` object — consumers cannot mutate the
  public surface or rewrite history.
- **`attach(session)` validates session shape** (must have `.send` and
  `.on`) and throws `TypeError` immediately instead of silently
  no-op'ing or failing later at fire-time.
- **`validateArgs`** rejects array/string/null arguments with a typed
  error message indicating what was received.

### Tooling
- **install.sh** iterates files instead of hardcoding, adds `cmp -s`
  byte-equality verification post-copy.
- **package.json** repository.url normalized to npm-canonical
  `git+https://...git`.

### Tests
- Suite grew from 42 → 56 covering all of the above plus regressions
  for: stale-detach, double-attach, surrogate-pair preview, freeze
  invariants, send_error note surfacing, content cap.

### Docs
- README **Limitations** section documenting substring-match self-trigger,
  verbatim re-injection, stagnation override, arm-relative timing, and
  the single-loop-per-session constraint.
- README result-shape comment updated: `note` is set by `ralph_stop`,
  `send_error`, and aborted-with-reason — no longer "ralph_stop only".

## 0.3.0

### Bug fixes
- **Detach during active loop** no longer leaves orphaned `state.active`
  pointing at a torn-down session. Detach now finalizes the loop with
  `reason="detached"` and clears state cleanly so re-attach starts fresh.
- **Silent iterations** (a turn that ends without an `assistant.message`)
  no longer reuse the previous iteration's content for completion / abort /
  stagnation evaluation. The accumulator is reset on each iteration fire-out.
- **Multiple `assistant.message` events per turn** are now accumulated into
  a single content blob instead of overwriting each other, so a completion
  phrase in an earlier message of the turn is no longer lost.
- **Async `session.send` rejections** are caught alongside synchronous
  throws and finish the loop with `reason="send_error"` instead of surfacing
  as an unhandled promise rejection.
- **A throwing `session.log`** can no longer crash event listeners.
- **Duplicate `assistant.turn_end` events** with the same `turnId` are
  ignored to prevent double-counting iterations.

### New features
- **`min_iterations` parameter** — forces the loop to run at least N
  iterations before `completion_promise` / `abort_promise` are honored.
  Useful for verification passes. Stagnation still triggers regardless
  (safety override).
- **`ralph_stop` accepts an optional `reason`** string, recorded as
  `note` on the structured result, in the log line, and in the
  `additionalContext` hook injection.
- **Result includes timing** — `startedAt`, `finishedAt`, and `durationMs`
  are now part of the result and the `additionalContext` injection.
- **Prompt length cap** of 64 KiB with a clear error message.

### Tooling
- **install.sh** gained `--help`, `--dry-run`, order-independent argument
  parsing, `node --check` syntax validation of source files before copy,
  and post-copy file existence verification.
- **package.json** enriched with `engines.node`, `keywords`, `bugs`, and
  `homepage` metadata.

### Tests
- Test suite grew from 19 → 42 cases covering the new behaviors and
  regressions for the bugs above.
- Test runner updated to `node --test 'test/**/*.test.mjs'` (no new deps).

## 0.2.0

- Switch ralph_loop to hook/event-driven architecture; tool returns
  immediately and iterations are driven by `assistant.turn_end` plus
  fire-and-forget `session.send`. Eliminates the `sendAndWait` deadlock.

## 0.1.0

- Initial release.
