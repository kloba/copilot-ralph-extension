# Changelog

## Unreleased

### Fixes
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
