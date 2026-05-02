# Changelog

## Unreleased

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
