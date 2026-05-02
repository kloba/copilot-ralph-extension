// Hook/event-driven Ralph Wiggum controller for Copilot CLI.
//
// Architecture: the ralph_loop tool returns immediately after arming the loop.
// Iterations are driven by listening to `session.idle` events (the root
// agent's "agentic loop fully done" signal) and re-injecting the prompt via
// `session.send` (fire-and-forget). Using `session.idle` rather than
// `assistant.turn_end` is critical: the SDK emits a turn_end per agentic-loop
// sub-turn (one per tool-call boundary), so a single root response with N
// tool calls produces N+ turn_ends. Only `session.idle` fires exactly once
// per root response. Every iteration is a real assistant turn the user sees,
// keeping full conversation context across the loop.
//
// Inspired by the Stop-hook re-injection pattern.

import { createRequire } from "node:module";

import { createEventEmitter as defaultEventEmitter } from "./events-emit.mjs";

// Lazy-resolved sync `require` so we can pull child_process only when needed
// (caffeinate when enabled, git for ralph_status / adaptive-budget, etc.)
// without paying the import cost up front.
const moduleRequire = createRequire(import.meta.url);

const DEFAULTS = Object.freeze({
    max_iterations: 20,
    min_iterations: 1,
    completion_promise: "COMPLETE",
    stagnation_limit: 3,
    warn_at_pct: 80,
    adaptive_budget: false,
    adaptive_extension: 10,
    // adaptive_max_total has no flat default — when omitted, it's resolved
    // to min(max_iterations * 5, MAX_ALLOWED_ITERATIONS) at validation time
    // so the ceiling scales with the user's chosen base budget.
});
// self_improve has different max/min defaults than ralph_loop because the
// SDLC loop is meant to run long-haul (whole-repo polish across many
// categories), while ralph_loop is a generic primitive that often arms
// short, targeted runs. Extract them here so the schema's `default:` hints
// and the handler's `?? <fallback>` use the SAME source of truth.
const SELF_IMPROVE_DEFAULTS = Object.freeze({
    max_iterations: 100,
    min_iterations: 5,
});
// grow_project budgets are wider: features take longer to ship than
// polish iters, so allow more iterations by default; min stays low so
// the loop can naturally drain a small backlog without forced extra
// passes.
const GROW_PROJECT_DEFAULTS = Object.freeze({
    max_iterations: 200,
    min_iterations: 10,
});
const MAX_ALLOWED_ITERATIONS = 1000;
const PREVIEW_CHARS = 500;
const MAX_PROMPT_CHARS = 65536;
// Cap completion_promise / abort_promise — short substring signals; megabyte-
// long signals would waste memory and slow `.includes()` matching.
const MAX_PROMISE_CHARS = 200;
// Cap the per-iteration accumulated assistant content. Only used for
// substring matching (completion/abort/stagnation) and the preview.
const MAX_CONTENT_CHARS = 1_048_576; // 1 MiB

// Issue #7: static map of model → context-window size. Conservative
// values from the public docs — when SDK reports a model not listed
// here we skip the warning rather than guess. Numbers are TOTAL window
// (input + output combined), since usage events report cumulative
// input tokens for the conversation.
const MODEL_CONTEXT_WINDOWS = Object.freeze({
    "claude-opus-4.7": 200000,
    "claude-opus-4.7-1m-internal": 1000000,
    "claude-opus-4.7-high": 200000,
    "claude-opus-4.7-xhigh": 200000,
    "claude-opus-4.6": 200000,
    "claude-opus-4.6-1m": 1000000,
    "claude-opus-4.5": 200000,
    "claude-sonnet-4.6": 200000,
    "claude-sonnet-4.5": 200000,
    "claude-sonnet-4": 200000,
    "claude-haiku-4.5": 200000,
    "gpt-5.5": 256000,
    "gpt-5.4": 256000,
    "gpt-5.3-codex": 256000,
    "gpt-5.2-codex": 256000,
    "gpt-5.2": 256000,
    "gpt-5.4-mini": 256000,
    "gpt-5-mini": 128000,
    "gpt-4.1": 128000,
});

// Issue #7: warning thresholds (percent of context window). Pre-baked
// so we can iterate a small array instead of computing both edges
// inline. 95% is the "stronger" warning that suggests ralph_stop.
const TOKEN_WARNING_THRESHOLDS = Object.freeze([80, 95]);


// Map finish reason → log-line verb. Reasons not listed fall through
// to "⏹ stopped" (max_iterations, abort_promise, stagnation,
// user_stopped, detached).
//   ✅ completed — completion_promise
//   ⚠️  ended   — send_error, aborted (something went wrong)
const VERB_BY_REASON = Object.freeze({
    completion_promise: "✅ completed",
    send_error: "⚠️ ended",
    aborted: "⚠️ ended",
    max_tokens: "⏹ stopped",
});

// Project-agnostic SDLC self-improvement prompt baked into the
// `self_improve` tool. Each iteration walks the agent through:
//   ORIENT  — read recent commits + project docs
//   IDEATE  — pick ONE concrete change, rotating across SDLC categories
//             (bug fix, hardening, validation, tests, refactor,
//             dependency hygiene, docs, release engineering)
//   CRITIQUE — rubber-duck pass: state the change, the risk, and one
//              alternative considered and rejected
//   BASELINE — detect & run the project's existing test command
//   IMPLEMENT — surgical edits only; no invented features
//   TEST     — re-run; must stay green at same-or-higher count
//   COMMIT   — conventional-commit prefix + dual Co-authored-by trailers
//              (Copilot + copilot-ralph bot account; the second trailer
//              is suppressed when RALPH_NO_ATTRIBUTION=1 is set in env)
//   PUSH     — git push (non-fatal on push failure)
//   END      — emit COMPLETE on its own line, or ABORT_NO_IMPROVEMENTS
const PROMPT_SELF_IMPROVE = `You are running an autonomous self-improvement iteration on the project in cwd. Each iteration must produce ONE concrete improvement and a real commit; if no worthwhile improvement exists after honest investigation, emit ABORT_NO_IMPROVEMENTS instead.

PER-ITERATION SDLC WORKFLOW (the smallest correct step is the right step):

1. ORIENT.
   - Run \`git log --oneline -20\` and read the most recent commits so you do not redo or undo prior iterations.
   - If the \`gh\` CLI is available and authenticated, run \`gh issue list --state open --limit 30 2>/dev/null || true\` to see open issues a human or a prior backlog-driven run may have already filed. Skim the titles + labels so you don't duplicate, contradict, or pre-empt work that's already tracked.
   - Also best-effort check CI health: \`gh run list --status failure --limit 10 2>/dev/null || true\`. If any recent runs on the default branch (or your current branch's HEAD) are failing, treat that as the highest-priority signal — a red CI blocks releases and silently breaks downstream consumers. Drill into the most recent failure with \`gh run view <run-id> --log-failed 2>/dev/null || true\` to capture the actual error before IDEATE.
   - Skim the project's primary docs: README, AGENTS.md, package.json / pyproject.toml / Cargo.toml / go.mod (whichever exist), CHANGELOG.
   - Detect the project's existing test command (npm test, pytest, cargo test, go test ./..., etc).

2. IDEATE.
   PRIORITY ORDER (do not skip a higher tier when a candidate exists in it):
     a. RED CI — if ORIENT surfaced any failing GitHub Actions run on the default branch / current branch HEAD, healing that failure IS the iteration. Reproduce the failure locally if possible, fix the root cause (not the symptom — do not add \`continue-on-error\` or delete the failing job to silence it), and verify the fix re-runs green via \`gh run rerun <run-id>\` or by pushing the fix and watching the new run. If the failure is a flaky test, harden it; if it's an env/dependency drift, pin or update; if it's a legitimate regression, revert or fix forward.
     b. OPEN ISSUE MATCH — if your candidate improvement matches an open issue you saw in ORIENT, prefer addressing that issue end-to-end and reference it with \`Closes #N\` (or \`Refs #N\` if the fix is partial); if the matching issue carries the \`grow-project\` or \`proposed\` label, defer to the backlog tooling and pick a different improvement instead — this loop should not race the backlog runner for issues already queued for feature work.
     c. ROTATING SDLC IMPROVEMENT — pick ONE concrete improvement, rotating across the categories below so the loop covers the whole lifecycle over time:
        - bug fix or edge-case hardening
        - input validation / error message clarity
        - tests for under-covered behaviour
        - refactor for readability / dead-code removal
        - dependency / config hygiene
        - docs (README, CHANGELOG, comments) accuracy
        - release engineering (version bump rules, CI hints, .gitignore, lockfile)
   Avoid repeating the SDLC category used in the previous 2-3 commits.

3. CRITIQUE (rubber-duck pass).
   Before editing, briefly state: the change, the risk it introduces, and one alternative you considered and rejected. Reject your own idea and pick a different one if the risk outweighs the value.

4. BASELINE.
   Run the project's existing test command and record pass/fail count. If the baseline is broken on entry and you cannot fix it in this single iteration, emit ABORT_NO_IMPROVEMENTS.

5. IMPLEMENT.
   Surgical edits only. No invented features. Do not change public API surface unless that change IS the improvement.

6. TEST.
   Re-run the same test command. It MUST pass at the same or higher count than baseline. If it fails, fix forward or revert, then re-run.

7. COMMIT.
   Short imperative subject prefixed with the SDLC category (\`fix:\`, \`feat:\`, \`test:\`, \`refactor:\`, \`docs:\`, \`chore:\`, \`ci:\`, \`perf:\`). Always include both trailers:
     Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
     Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
   The second trailer attributes the commit to the dedicated \`copilot-ralph\` bot account so loop-driven commits are passively searchable across public GitHub. If the environment variable \`RALPH_NO_ATTRIBUTION=1\` is set, omit ONLY the second \`copilot-ralph\` trailer; the first \`Copilot\` trailer always ships.
   Write the commit message to a temp file in a SEPARATE shell call before running \`git commit -F\`; combining heredoc + commit in one call has historically failed silently. Prefer "cancel", "tear down", or "stop" in commit messages over forceful-action synonyms that some agent runtimes treat as trigger phrases.

8. PUSH.
   \`git push\` to origin. If push fails (no remote, auth, conflict), log it and continue; do not abort the loop on push failure.

9. END THE TURN.
   Emit the literal token COMPLETE on its own line so the loop advances. If no worthwhile improvement exists, emit ABORT_NO_IMPROVEMENTS instead.

HARD RULES:
- Stay in cwd; do not edit unrelated repos.
- Do not introduce new top-level dependencies, frameworks, or build systems unless that introduction IS the improvement and the rubber-duck critique justified it.
- Do not delete or rewrite the project's existing license, README, or CHANGELOG wholesale; surgical edits only.
- Each iteration is a paid turn — the smallest correct step is the right step.`;

// Literal abort token baked into PROMPT_SELF_IMPROVE. The completion
// counterpart is DEFAULTS.completion_promise ("COMPLETE") and is reused
// directly. Centralising the abort token here keeps the warnPromiseDrift
// call site (in the self_improve handler) and the prompt body in lockstep
// — if either drifts, the load-time parity guard below throws.
const BAKED_ABORT_TOKEN = "ABORT_NO_IMPROVEMENTS";
if (!PROMPT_SELF_IMPROVE.includes(DEFAULTS.completion_promise) ||
    !PROMPT_SELF_IMPROVE.includes(BAKED_ABORT_TOKEN)) {
    throw new Error(
        `handler.mjs: PROMPT_SELF_IMPROVE must contain both "${DEFAULTS.completion_promise}" and "${BAKED_ABORT_TOKEN}" — the self_improve drift warning depends on this invariant.`,
    );
}

// PROMPT_GROW_PROJECT is the baked SDLC prompt for the grow_project tool.
// Unlike self_improve (which polishes one tiny improvement per iter), this
// loop grows a project by ideating a backlog of features as GitHub issues
// (via the `gh` CLI) on the first iter, then executing one feature per
// subsequent iter against a three-part completion gate: tests green +
// executable acceptance check + demo invocation. The literal abort token
// is BAKED_BACKLOG_ABORT_TOKEN ("ABORT_NO_BACKLOG"), distinct from
// self_improve's "ABORT_NO_IMPROVEMENTS" because the agent emits it for a
// different reason: the backlog has been drained, not that no worthwhile
// improvement exists.
const PROMPT_GROW_PROJECT = `You are running an autonomous project-growth iteration on the project in cwd. Each iteration ships ONE feature end-to-end from a GitHub-issue backlog; if the backlog is drained or no proposed issue is ready, emit ABORT_NO_BACKLOG instead.

PER-ITERATION SDLC WORKFLOW (the smallest correct step is the right step):

1. ORIENT.
   - \`gh issue list --label grow-project --state open\` to see the backlog.
   - \`git log --oneline -20\` so you do not redo or undo prior iterations.
   - Skim README, AGENTS.md, package.json / pyproject.toml / Cargo.toml / go.mod (whichever exist), CHANGELOG.
   - Detect the project's existing test command (npm test, pytest, cargo test, go test ./..., etc).

2. IDEATE (only if the backlog is empty AND this is the first iter).
   Before creating issues, run \`gh label create grow-project --color 0e8a16 --description "feature backlog" 2>/dev/null || true\` and \`gh label create proposed --color fbca04 --description "ready to pick up" 2>/dev/null || true\` and \`gh label create in-progress --color d93f0b --description "actively being shipped" 2>/dev/null || true\` so the very first \`gh issue create --label X\` call doesn't fail on a missing label. The \`|| true\` swallows the "label already exists" error on subsequent runs.
   Generate 5-10 small, well-scoped features. For each, run \`gh issue create --label grow-project --label proposed\` with a body that includes:
     - Spec — one paragraph describing the feature.
     - Acceptance criteria — a checkbox list of machine-checkable assertions (test name, CLI invocation + expected output, file existence + content match, etc).
     - Demo command — a single CLI invocation that exercises the feature end-to-end and prints recognisable output.
     - Optional \`Depends-on: #N\` line per dependency.
   If the backlog is non-empty, skip this stage.

3. SELECT.
   Pick ONE issue with the \`proposed\` label, oldest first. Respect any \`Depends-on: #N\` lines: block if any dependency issue is still open. Re-label the chosen issue with \`gh issue edit N --add-label in-progress --remove-label proposed\`. If no proposed issue is ready, emit ABORT_NO_BACKLOG.

4. CRITIQUE (rubber-duck pass).
   Briefly state the change, the risk, and one alternative you considered+rejected. If the spec is unclear, post a refining comment on the issue before proceeding.

5. BASELINE.
   Run the project's existing test command and record pass/fail count. If the baseline is broken on entry and you cannot fix it in this single iteration, emit ABORT_NO_BACKLOG.

6. IMPLEMENT.
   Surgical edits only. No invented features beyond the issue's spec.

7. TEST.
   Re-run the same test command. It MUST pass at the same or higher count than baseline. If it fails, fix forward or revert, then re-run.

8. ACCEPTANCE.
   Execute every acceptance-criteria check from the issue body. Each one must pass. Tick the checkbox in the issue body via \`gh issue edit\` as you go.

9. DEMO.
   Execute the demo command. Capture its output and post it as a comment on the issue with \`gh issue comment N --body ...\` so the demo trace is durable.

10. COMMIT.
    Conventional-commit prefix (\`feat:\` is typical). Subject must reference the issue, e.g. \`feat(#42): add CSV export\`. Trailers MUST include all three:
      Closes #N
      Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
      Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
    The second \`Co-authored-by\` trailer attributes the commit to the dedicated \`copilot-ralph\` bot account so loop-driven commits are passively searchable across public GitHub. If the environment variable \`RALPH_NO_ATTRIBUTION=1\` is set, omit ONLY the \`copilot-ralph\` trailer; the \`Closes #N\` and \`Copilot\` trailers always ship.
    Write the commit message to a temp file in a SEPARATE shell call before running \`git commit -F\`; combining heredoc + commit in one call has historically failed silently. Prefer "cancel", "tear down", or "stop" in commit messages over forceful-action synonyms that some agent runtimes treat as trigger phrases.

11. PUSH.
    \`git push\` to origin. If push fails (no remote, auth, conflict), log it and continue; do not abort the loop on push failure.

12. CLOSE.
    \`gh issue close N --reason completed\`. The commit trailer auto-closes too, but be explicit so the close is recorded even if the push failed.

13. END THE TURN.
    Emit the literal token COMPLETE on its own line so the loop advances. If the backlog is drained, emit ABORT_NO_BACKLOG instead.

HARD RULES:
- Stay in cwd; do not edit unrelated repos.
- Do not introduce new top-level dependencies, frameworks, or build systems unless that introduction IS the feature and the rubber-duck critique justified it.
- Do not delete or rewrite the project's existing license, README, or CHANGELOG wholesale; surgical edits only.
- Each iteration is a paid turn — the smallest correct step is the right step.`;

// Literal abort token baked into PROMPT_GROW_PROJECT. Centralised here so
// the warnPromiseDrift call site (in the grow_project handler) and the
// prompt body stay in lockstep — if either drifts, the load-time parity
// guard below throws.
const BAKED_BACKLOG_ABORT_TOKEN = "ABORT_NO_BACKLOG";
if (!PROMPT_GROW_PROJECT.includes(DEFAULTS.completion_promise) ||
    !PROMPT_GROW_PROJECT.includes(BAKED_BACKLOG_ABORT_TOKEN)) {
    throw new Error(
        `handler.mjs: PROMPT_GROW_PROJECT must contain both "${DEFAULTS.completion_promise}" and "${BAKED_BACKLOG_ABORT_TOKEN}" — the grow_project drift warning depends on this invariant.`,
    );
}

// Issue #1: every loop-driven commit ships TWO Co-authored-by trailers
// (Copilot agent + copilot-ralph bot account, with RALPH_NO_ATTRIBUTION=1
// suppressing the second). Bake the canonical trailer literals here so a
// future edit to either prompt that drops the bot-account trailer or
// inverts the order fails at module-load time, not at the next CI run.
// The order-pin (Copilot first, copilot-ralph second) matters because
// GitHub's commit UI surfaces the first co-author more prominently.
//
// Companion surfaces that must stay in lockstep with these literals:
//   - README.md "Commit attribution" section (canonical user-facing
//     disclosure, including the public-repo-only searchability caveat,
//     the RALPH_NO_ATTRIBUTION=1 opt-out, and the order-of-trailers
//     example block — pinned by the README test in
//     test/extension.test.mjs).
//   - Both PROMPT_SELF_IMPROVE and PROMPT_GROW_PROJECT bodies (the
//     load-time loop below validates both contain the literals in the
//     correct order and document the opt-out env var).
//   - The __test__ exports (BAKED_COPILOT_TRAILER, BAKED_RALPH_TRAILER,
//     BAKED_ATTRIBUTION_OPT_OUT) used by the canonical-source pin test.
// Renaming any of these literals (e.g. registering the bot under a
// different login, swapping the noreply domain) requires updating
// every surface above.
const BAKED_COPILOT_TRAILER = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";
const BAKED_RALPH_TRAILER = "Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>";
const BAKED_ATTRIBUTION_OPT_OUT = "RALPH_NO_ATTRIBUTION=1";

// Issue #1 (ralph_loop parity): unlike self_improve / grow_project which
// embed the COMMIT stage in their full baked SDLC prompt, ralph_loop takes
// a user-supplied `prompt` and re-injects it verbatim every iteration. To
// keep the dual-trailer attribution contract symmetric across all three
// loop tools, the ralph_loop handler appends this rider to the user's
// prompt at arm time. The rider is short on purpose — it ships once per
// re-injected message and adds to context on every iteration. Worded as
// a "Controller requirement" so a user prompt that omits commit
// instructions does not appear to override it; explicitly inert when no
// commit is created so generic ralph_loop tasks (e.g. log analysis) are
// unaffected.
const BAKED_RALPH_LOOP_RIDER = `---
CONTROLLER REQUIREMENT — commit attribution: if this iteration produces any git commit, append BOTH Co-authored-by trailers in this exact order at the end of the commit message (separated from the body by a blank line):
  ${BAKED_COPILOT_TRAILER}
  ${BAKED_RALPH_TRAILER}
The second trailer attributes loop-driven commits to the dedicated copilot-ralph bot account so they are passively searchable across public GitHub. If the environment variable ${BAKED_ATTRIBUTION_OPT_OUT} is set, omit ONLY the second copilot-ralph trailer; the first Copilot trailer always ships. If this iteration creates no commit, ignore this requirement.`;

for (const [label, prompt] of [
    ["PROMPT_SELF_IMPROVE", PROMPT_SELF_IMPROVE],
    ["PROMPT_GROW_PROJECT", PROMPT_GROW_PROJECT],
    ["BAKED_RALPH_LOOP_RIDER", BAKED_RALPH_LOOP_RIDER],
]) {
    const copilotIdx = prompt.indexOf(BAKED_COPILOT_TRAILER);
    const ralphIdx = prompt.indexOf(BAKED_RALPH_TRAILER);
    if (copilotIdx === -1 || ralphIdx === -1 || copilotIdx >= ralphIdx) {
        throw new Error(
            `handler.mjs: ${label} must contain both Co-authored-by trailers in canonical order (Copilot first, copilot-ralph second). Got Copilot@${copilotIdx}, copilot-ralph@${ralphIdx}. Issue #1 attribution invariant.`,
        );
    }
    if (!prompt.includes(BAKED_ATTRIBUTION_OPT_OUT)) {
        throw new Error(
            `handler.mjs: ${label} must document the "${BAKED_ATTRIBUTION_OPT_OUT}" opt-out env var alongside the dual Co-authored-by trailers. Issue #1 attribution invariant.`,
        );
    }
}

// Append the dual-trailer commit-attribution rider to a user-supplied
// ralph_loop prompt. Returns `{value}` on success or `{error}` when the
// composed prompt would exceed MAX_PROMPT_CHARS — the rider eats roughly
// 600 of the 65 536-char budget, so callers near the cap need a clear
// signal instead of a silent overshoot. The separator is part of the
// rider so a future tweak to spacing only edits one place.
function composeRalphLoopPrompt(userPrompt) {
    const separator = "\n\n";
    const composed = `${userPrompt}${separator}${BAKED_RALPH_LOOP_RIDER}`;
    if (composed.length > MAX_PROMPT_CHARS) {
        const reserved = separator.length + BAKED_RALPH_LOOP_RIDER.length;
        return {
            error: `ralph_loop: prompt + commit-attribution rider exceeds ${MAX_PROMPT_CHARS} characters (got ${composed.length}; ~${reserved} chars reserved for the rider). Shorten the prompt.`,
        };
    }
    return { value: composed };
}

// Find a slice length ≤ `cut` that doesn't split a UTF-16 surrogate pair
// (4-byte chars like emoji), so we never produce a lone-surrogate tail.
function safeSliceEnd(s, cut) {
    const code = s.charCodeAt(cut - 1);
    return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
}

// Mirror of safeSliceEnd for the START side: if the kept slice would begin
// on a lone low surrogate (high surrogate dropped by the head trim), advance
// start by 1 to avoid producing an invalid UTF-16 string.
function safeSliceStart(s, start) {
    const code = s.charCodeAt(start);
    return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
}

function previewOf(text) {
    if (!text) return "";
    if (text.length <= PREVIEW_CHARS) return text;
    return text.slice(0, safeSliceEnd(text, PREVIEW_CHARS)) + "…";
}

// English pluralization for log lines: "" when n===1, "s" otherwise.
function pluralS(n) {
    return n === 1 ? "" : "s";
}

// Truncate `note` to PREVIEW_CHARS without splitting a surrogate pair (notes
// can carry user-supplied or error strings containing 4-byte chars like emoji).
function truncateNote(text) {
    const s = String(text);
    if (s.length <= PREVIEW_CHARS) return s;
    return s.slice(0, safeSliceEnd(s, PREVIEW_CHARS));
}

// Collapse whitespace (newlines, tabs, runs of spaces) into single spaces and
// trim — flattens multi-line notes (e.g. Error stacks) to single-line markers.
function collapseNote(text) {
    return text ? String(text).replace(/\s+/g, " ").trim() : "";
}

// Cap length at PREVIEW_CHARS (surrogate-safely) and flatten whitespace
// for log sites embedding external strings (abort reason, send-error
// message), so the timeline can't be flooded by a pathological payload.
function boundedNoteForLog(text) {
    return collapseNote(truncateNote(text));
}

// Shared normalizer for the optional `reason` argument of ralph_pause +
// ralph_stop. Returns the canonical single-line, length-capped form, or
// `null` when the caller supplied nothing / a non-string / a value that
// is empty after whitespace flattening. Centralising the logic prevents
// drift between the two tools — both store `reason` on long-lived state
// (active.pauseReason / result.note) and both render it back into single
// -line surfaces (timeline log markers, JSON snapshot fields, terminal /
// pause events). A multi-line paste would otherwise corrupt those
// surfaces; coercing empty-after-flatten to `null` prevents the
// user-facing success message from rendering a stray ` ()` suffix.
function parseUserReason(raw) {
    if (typeof raw !== "string") return null;
    return boundedNoteForLog(raw) || null;
}

// Recursively freeze obj + nested values; skips already-frozen entries so
// cycles terminate. Returns the input (for fluent `return deepFreeze(...)`).
function deepFreeze(obj) {
    if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) return obj;
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
    return obj;
}

// ---------------------------------------------------------------------------
// caffeinate integration (issue #8)
//
// Optional, opt-in macOS-only system-sleep prevention while a ralph loop is
// active. Spawns `caffeinate -i [-d] -w <pid>` as a child process at arm-time
// and kills it at finish-time. The `-w <pid>` flag ties caffeinate's lifetime
// to the host process, so even if the loop crashes hard caffeinate exits with
// the CLI — no orphaned wake-locks.
//
// Disabled by default. Enable via env var:
//     RALPH_CAFFEINATE=1                 → enable, scope = idle (default)
//     RALPH_CAFFEINATE_SCOPE=idle+display → also block display sleep
//
// On non-darwin platforms or when the binary is missing, the helper degrades
// to a silent no-op — never fail the loop over a power-management nicety.
// ---------------------------------------------------------------------------
const CAFFEINATE_TRUTHY = new Set(["1", "true", "yes", "on"]);
const CAFFEINATE_SCOPES = new Set(["idle", "idle+display"]);

function isCaffeinateEnabled(env) {
    const raw = env?.RALPH_CAFFEINATE;
    if (typeof raw !== "string") return false;
    return CAFFEINATE_TRUTHY.has(raw.trim().toLowerCase());
}

function resolveCaffeinateScope(env) {
    const raw = env?.RALPH_CAFFEINATE_SCOPE;
    if (typeof raw !== "string") return "idle";
    const v = raw.trim().toLowerCase();
    return CAFFEINATE_SCOPES.has(v) ? v : "idle";
}

function caffeinateFlagsForScope(scope) {
    // -i: prevent idle sleep, -d: prevent display sleep.
    return scope === "idle+display" ? "-id" : "-i";
}

/**
 * Start a caffeinate child if enabled + supported. Returns a `stop()` function
 * (idempotent) or null when no process was spawned. Never throws.
 *
 * @param {object} deps
 * @param {NodeJS.ProcessEnv} deps.env
 * @param {string} deps.platform - process.platform value
 * @param {number} deps.pid - host process pid (for `-w`)
 * @param {Function} deps.spawnFn - child_process.spawn-compatible
 * @param {(msg: string) => void} deps.log
 * @param {string} deps.label - "ralph_loop" | "self_improve" | "grow_project"
 * @returns {(() => void) | null}
 */
function startCaffeinate({ env, platform, pid, spawnFn, log, label }) {
    if (!isCaffeinateEnabled(env)) return null;
    if (platform !== "darwin") {
        log(`${label}: caffeinate skipped — platform ${platform} not supported (darwin only)`);
        return null;
    }
    if (typeof spawnFn !== "function") return null;
    const scope = resolveCaffeinateScope(env);
    const flags = caffeinateFlagsForScope(scope);
    const args = [flags, "-w", String(pid)];
    let child;
    try {
        child = spawnFn("caffeinate", args, { stdio: "ignore", detached: false });
    } catch (err) {
        log(`${label}: caffeinate spawn failed (${err?.message ?? err}); continuing without sleep prevention`);
        return null;
    }
    if (!child || typeof child.kill !== "function") {
        log(`${label}: caffeinate spawn returned no child handle; continuing without sleep prevention`);
        return null;
    }
    if (typeof child.on === "function") {
        child.on("error", (err) => {
            log(`${label}: caffeinate error (${err?.message ?? err}); sleep prevention inactive`);
        });
    }
    log(`${label}: keeping system awake via caffeinate (pid=${child.pid ?? "?"}, scope=${scope})`);
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        try { child.kill("SIGTERM"); } catch { /* swallow */ }
    };
}

// git snapshot / status helpers (issue #5)
//
// `ralph_status` needs to report files changed since the loop was armed.
// We capture HEAD at arm-time and diff against it on demand. All git calls
// are best-effort: if the repo isn't a git repo, the binary is missing, or
// any individual call fails, the corresponding status field is omitted with
// an explanatory note rather than the whole tool aborting.
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 2000;

/**
 * Default git executor — runs `git <args>` synchronously with a tight timeout
 * and never throws. Returns { ok, stdout, stderr, code }.
 *
 * @returns {{ ok: boolean, stdout: string, stderr: string, code: number|null }}
 */
// Shared spawnSync wrapper for the two production gitExec entry points
// (defaultGitExec for ralph_status / armLoop diagnostics, and
// defaultAdaptiveGitExec for the end-of-iteration adaptive-budget
// signal evaluation). Both call sites need the same total-function
// guarantees:
//   - never throw out of the wrapper (every error path collapses to
//     `{ ok: false, stdout: "", stderr, code }`);
//   - `child_process` import failure (e.g. exotic embedders) is also
//     normalized rather than throwing;
//   - process env is filtered through GIT_TERMINAL_PROMPT=0 + GIT_PAGER=cat
//     so a misconfigured git on the host can't deadlock spawnSync.
// The only difference between the two callers is the timeout budget,
// which is the helper's only required parameter.
function runGitCommand(args, cwd, timeoutMs) {
    let spawnSync;
    try {
        ({ spawnSync } = moduleRequire("node:child_process"));
    } catch {
        return { ok: false, stdout: "", stderr: "child_process unavailable", code: null };
    }
    let res;
    try {
        res = spawnSync("git", args, {
            cwd,
            timeout: timeoutMs,
            encoding: "utf8",
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
        });
    } catch (err) {
        return { ok: false, stdout: "", stderr: err?.message ?? String(err), code: null };
    }
    if (res?.error) {
        return { ok: false, stdout: "", stderr: res.error.message ?? String(res.error), code: res.status ?? null };
    }
    return {
        ok: res.status === 0,
        stdout: typeof res.stdout === "string" ? res.stdout : "",
        stderr: typeof res.stderr === "string" ? res.stderr : "",
        code: res.status ?? null,
    };
}

function defaultGitExec(args, cwd) {
    return runGitCommand(args, cwd, GIT_TIMEOUT_MS);
}

function captureGitArmSnapshot(gitExec, cwd) {
    const head = gitExec(["rev-parse", "HEAD"], cwd);
    if (!head.ok) return { isRepo: false };
    const branch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    return {
        isRepo: true,
        head: head.stdout.trim(),
        branch: branch.ok ? branch.stdout.trim() : null,
    };
}

/**
 * Categorize a porcelain v1 status line into added/modified/deleted/renamed.
 * Untracked files surface as "added" so the user sees new files they may have
 * forgotten to `git add`.
 */
function classifyPorcelainLine(line) {
    if (line.length < 4) return null;
    const x = line[0];
    const y = line[1];
    const rest = line.slice(3);
    let path = rest;
    if (x === "R" || y === "R") {
        const arrow = rest.indexOf(" -> ");
        if (arrow >= 0) path = rest.slice(arrow + 4);
        return { kind: "renamed", path };
    }
    if (x === "?" && y === "?") return { kind: "added", path };
    if (x === "A" || y === "A") return { kind: "added", path };
    if (x === "D" || y === "D") return { kind: "deleted", path };
    if (x === "M" || y === "M" || x === "T" || y === "T") return { kind: "modified", path };
    return { kind: "modified", path };
}

function buildFilesChangedSinceArm(gitExec, cwd, armedHead) {
    const out = { added: new Set(), modified: new Set(), deleted: new Set(), renamed: new Set() };
    if (armedHead) {
        const diff = gitExec(["diff", "--name-status", "-z", `${armedHead}..HEAD`], cwd);
        if (diff.ok && diff.stdout) {
            const tokens = diff.stdout.split("\0").filter(Boolean);
            for (let i = 0; i < tokens.length; i++) {
                const status = tokens[i];
                if (!status) continue;
                if (status.startsWith("R") || status.startsWith("C")) {
                    const _old = tokens[++i];
                    const newp = tokens[++i];
                    if (newp) out.renamed.add(newp);
                    void _old;
                } else if (status.startsWith("A")) {
                    const p = tokens[++i]; if (p) out.added.add(p);
                } else if (status.startsWith("D")) {
                    const p = tokens[++i]; if (p) out.deleted.add(p);
                } else {
                    const p = tokens[++i]; if (p) out.modified.add(p);
                }
            }
        }
    }
    const status = gitExec(["status", "--porcelain"], cwd);
    if (status.ok) {
        for (const line of status.stdout.split("\n")) {
            if (!line) continue;
            const c = classifyPorcelainLine(line);
            if (!c) continue;
            if (out.added.has(c.path) || out.modified.has(c.path) || out.deleted.has(c.path) || out.renamed.has(c.path)) continue;
            out[c.kind].add(c.path);
        }
    }
    return {
        added: [...out.added].sort(),
        modified: [...out.modified].sort(),
        deleted: [...out.deleted].sort(),
        renamed: [...out.renamed].sort(),
    };
}

function gitAheadBehind(gitExec, cwd) {
    const r = gitExec(["rev-list", "--left-right", "--count", "@{u}...HEAD"], cwd);
    if (!r.ok) return null;
    const m = r.stdout.trim().split(/\s+/);
    if (m.length !== 2) return null;
    const behind = Number.parseInt(m[0], 10);
    const ahead = Number.parseInt(m[1], 10);
    if (Number.isNaN(ahead) || Number.isNaN(behind)) return null;
    return { ahead, behind };
}

function gitUncommittedLines(gitExec, cwd) {
    const r = gitExec(["diff", "--shortstat", "HEAD"], cwd);
    if (!r.ok) return null;
    const txt = r.stdout;
    let total = 0;
    const ins = /(\d+) insertion/.exec(txt);
    const del = /(\d+) deletion/.exec(txt);
    if (ins) total += Number.parseInt(ins[1], 10) || 0;
    if (del) total += Number.parseInt(del[1], 10) || 0;
    return total;
}

// ---------------------------------------------------------------------------
// Adaptive iteration budget (issue #4)
// ---------------------------------------------------------------------------
const ADAPTIVE_WINDOW = 3;
const ADAPTIVE_GIT_TIMEOUT_MS = 2000;

function djb2Hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    }
    return h.toString(16);
}

function defaultAdaptiveGitExec(args, cwd) {
    // Adaptive-budget evaluation runs synchronously inside onIdle and
    // is best-effort; a stuck git invocation must not stall the loop.
    // Hence the tighter ADAPTIVE_GIT_TIMEOUT_MS budget vs the
    // ralph_status default. Shape is identical to defaultGitExec
    // (including the `code` field — `evaluateAdaptiveSignals` only
    // reads `.ok` / `.stdout`, so the extra field is harmless and
    // keeps both entry points to a single helper).
    return runGitCommand(args, cwd, ADAPTIVE_GIT_TIMEOUT_MS);
}

function evaluateAdaptiveSignals(a, gitExec) {
    const reasons = [];
    try {
        const stat = gitExec(["diff", "--shortstat", "HEAD"]);
        if (stat?.ok && /\d+\s+(insertion|deletion|file)/.test(stat.stdout)) {
            reasons.push(`uncommitted changes (${stat.stdout.trim()})`);
        } else {
            const porcelain = gitExec(["status", "--porcelain"]);
            if (porcelain?.ok && porcelain.stdout.trim().length > 0) {
                const lines = porcelain.stdout.split("\n").filter(Boolean).length;
                reasons.push(`${lines} working-tree change${lines === 1 ? "" : "s"}`);
            }
        }
    } catch { /* swallow — signal stays unset */ }
    const hashes = a.adaptiveContentHashes;
    if (hashes && hashes.length >= 2) {
        const distinct = new Set(hashes).size;
        if (distinct >= 2) {
            reasons.push(`${distinct} distinct responses in last ${hashes.length} iterations`);
        }
    }
    if (reasons.length === 0) return null;
    return reasons.join(", ");
}

function failure(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "failure" };
}

function success(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "success" };
}

// Every session event carries an optional `agentId` — string on sub-agent
// events (task / explore / code-review / rubber-duck …), absent on root.
// Sub-agent events bubble on the same bus, so root-only handlers must
// filter — else sub-agents trigger spurious refires or interrupt the loop.
function isSubAgentEvent(ev) {
    return ev != null && ev.agentId !== undefined && ev.agentId !== null;
}

/**
 * @typedef {Object} RalphArgs
 * @property {string} prompt - Required. The prompt re-injected each iteration. ≤ MAX_PROMPT_CHARS (65 536) UTF-16 code units. Note: emoji and other 4-byte chars consume two code units each, so worst-case byte length can be larger than 64 KiB.
 * @property {number} [max_iterations=20] - Hard cap on iterations (1..1000).
 * @property {number} [min_iterations=1] - Floor before completion/abort phrases honored (1..max_iterations).
 * @property {string} [completion_promise="COMPLETE"] - Substring → finish with reason "completion_promise".
 * @property {string} [abort_promise] - Optional substring → finish with reason "abort_promise". Must differ from completion_promise.
 * @property {number} [stagnation_limit=3] - Abort after N consecutive byte-identical responses (0 disables).
 */

/**
 * @typedef {Object} RalphResult
 * @property {string} reason - One of: completion_promise, abort_promise, stagnation, max_iterations, send_error, aborted, user_stopped, detached.
 * @property {number} iterations - Number of iterations completed (post-fire count).
 * @property {string} label - Tool that armed the loop ("ralph_loop", "self_improve", or "grow_project"). Used for the post-loop additionalContext bracket and the "<verb> <label> after N iterations" finish log line.
 * @property {string} preview - Up to PREVIEW_CHARS (500) chars of the LAST iteration's accumulated assistant content. If the content was longer, an ellipsis ("…") is appended (so the truncated form is 501 chars). If finish runs before any iteration produced output (e.g. send_error before iter 1, or ralph_stop right after arm), this is the empty string. Surrogate-safe — never ends on a lone high surrogate.
 * @property {number} startedAt - Epoch ms when the loop was armed.
 * @property {number} finishedAt - Epoch ms when the loop finished.
 * @property {number} durationMs - Elapsed wall-clock ms from arming to finish, clamped to ≥ 0 (a backward clock jump mid-loop reports 0 instead of a negative).
 * @property {string} [note] - Optional human-readable context: caller-supplied via ralph_stop({reason}), or the underlying error message on send_error, or the SDK abort reason on aborted. Truncated silently to PREVIEW_CHARS (500) (surrogate-safe) — no "…" indicator is appended (unlike `preview`). Notes are flowed inline into single-line log markers and the post-loop additionalContext bracket, where a trailing "…" would be misread as part of the message.
 */

// Type name for error messages: distinguishes null/array from generic
// "object" (so `[]` shows as "array" instead of the misleading "object").
function describeArgType(args) {
    if (args === null) return "null";
    if (Array.isArray(args)) return "array";
    return typeof args;
}

// Render a raw arg value for human-readable error messages. Quotes string
// inputs so an empty/whitespace-only value displays as `""` instead of an
// invisible blank, and stringifies NaN/Infinity as themselves rather than
// JSON.stringify's "null".
function displayValue(v) {
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
}

// Reject malformed shapes (null/array/primitive) and unknown keys (so a
// typo like `resaon` or `max_iter` surfaces loudly instead of being
// silently dropped). Returns null on valid shape, else { error }.
function validateArgShape(toolName, args, knownKeys) {
    // typeof null === "object" so null needs an explicit check.
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return { error: `${toolName}: arguments must be an object (got ${describeArgType(args)}).` };
    }
    const unknown = Object.keys(args).filter((k) => !knownKeys.has(k));
    if (unknown.length) {
        return {
            error: `${toolName}: unknown argument${pluralS(unknown.length)}: ${unknown.map((k) => JSON.stringify(k)).join(", ")}. Valid keys: ${[...knownKeys].join(", ")}.`,
        };
    }
    return null;
}

// Variant of validateArgShape used by tools where "no args" is a valid
// call (ralph_stop, self_improve, grow_project — all three have only
// optional fields). Treats null/undefined as "use defaults" and returns
// a ready-to-return `failure(...)` result on bad shape, so the caller's
// call site is just
// `const bad = validateOptionalArgShape(...); if (bad) return bad;` —
// keeping the "null/undefined = not supplied" decision in one place.
function validateOptionalArgShape(label, args, knownKeys) {
    if (args === null || args === undefined) return null;
    const shape = validateArgShape(label, args, knownKeys);
    return shape ? failure(shape.error) : null;
}

const RALPH_LOOP_KEYS = new Set([
    "prompt",
    "max_iterations",
    "min_iterations",
    "completion_promise",
    "abort_promise",
    "stagnation_limit",
    "max_tokens",
    "warn_at_pct",
    "adaptive_budget",
    "adaptive_extension",
    "adaptive_max_total",
]);
const RALPH_STOP_KEYS = new Set(["reason"]);
const RALPH_PAUSE_KEYS = new Set(["reason"]);
const RALPH_RESUME_KEYS = new Set([]);
const SELF_IMPROVE_KEYS = new Set([
    "max_iterations",
    "min_iterations",
    "focus",
    "completion_promise",
    "abort_promise",
    "stagnation_limit",
]);
const GROW_PROJECT_KEYS = new Set([
    "max_iterations",
    "min_iterations",
    "focus",
    "completion_promise",
    "abort_promise",
    "stagnation_limit",
]);
const MAX_FOCUS_CHARS = 2000;

// Validate the optional `focus` argument shared by self_improve and
// grow_project. Treats null/undefined as "not supplied" (returns
// {value: undefined}); for strings, requires non-whitespace content
// and ≤ MAX_FOCUS_CHARS after trim. Centralizes the three error
// messages so the handler call site stays one line. The toolName
// parameter scopes error prefixes correctly per call site (default
// preserves backwards-compat for the original self_improve caller).
function parseFocus(raw, toolName = "self_improve") {
    if (raw === undefined || raw === null) return { value: undefined };
    if (typeof raw !== "string") {
        return { error: `${toolName}: focus must be a string (got ${describeArgType(raw)}).` };
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return { error: `${toolName}: focus must contain at least one non-whitespace character.` };
    }
    if (trimmed.length > MAX_FOCUS_CHARS) {
        return { error: `${toolName}: focus exceeds ${MAX_FOCUS_CHARS} characters (got ${trimmed.length}).` };
    }
    return { value: trimmed };
}

// Validate completion_promise / abort_promise: string, non-whitespace,
// ≤ MAX_PROMISE_CHARS, trimmed before matching. `whenProvided` injects
// ", when provided," into abort_promise's empty error (it has no default).
function validatePromiseField(fieldName, raw, { whenProvided = false } = {}) {
    if (typeof raw !== "string") {
        return { error: `ralph_loop: ${fieldName} must be a string (got ${describeArgType(raw)}).` };
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        const interjection = whenProvided ? ", when provided," : "";
        return { error: `ralph_loop: ${fieldName}${interjection} must contain at least one non-whitespace character.` };
    }
    if (raw.length > MAX_PROMISE_CHARS) {
        return { error: `ralph_loop: ${fieldName} exceeds ${MAX_PROMISE_CHARS} characters (got ${raw.length}). Use a short signal phrase.` };
    }
    return { value: trimmed };
}

// Like validatePromiseField but treats undefined/null as "not supplied"
// (so `{ abort_promise: null }` means "no abort signal", not a type error).
function resolveOptionalPromise(fieldName, raw, fallback, opts) {
    if (raw === undefined || raw === null) return { value: fallback };
    return validatePromiseField(fieldName, raw, opts);
}

// Type-check + Number() coerce for max/min_iterations and stagnation_limit.
// Range validation stays at the call site since each field's bounds differ.
function coerceNumberField(fieldName, raw) {
    if (typeof raw !== "number" && typeof raw !== "string") {
        return { error: `ralph_loop: ${fieldName} must be a number (got ${describeArgType(raw)}).` };
    }
    return { value: Number(raw) };
}

/**
 * Validate ralph_loop arguments.
 *
 * @param {RalphArgs} args
 * @returns {{value: object} | {error: string}} Validated values or a single human-readable error.
 */
export function validateArgs(args) {
    const shape = validateArgShape("ralph_loop", args, RALPH_LOOP_KEYS);
    if (shape) return shape;
    if (args.prompt !== undefined && args.prompt !== null && typeof args.prompt !== "string") {
        return { error: `ralph_loop: prompt must be a string (got ${describeArgType(args.prompt)}).` };
    }
    const prompt = (args.prompt ?? "").trim();
    if (!prompt) {
        // Distinguish "missing" from "whitespace-only" — the latter
        // usually signals a templating bug (variable interpolated to "").
        if (!args.prompt) {
            return { error: "ralph_loop: prompt is required and must be non-empty." };
        }
        return { error: "ralph_loop: prompt must contain at least one non-whitespace character (got a whitespace-only string)." };
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
        return {
            error: `ralph_loop: prompt exceeds ${MAX_PROMPT_CHARS} characters (got ${prompt.length}). Shorten the prompt or split the work.`,
        };
    }

    const rawMax = args.max_iterations ?? DEFAULTS.max_iterations;
    const maxC = coerceNumberField("max_iterations", rawMax);
    if (maxC.error) return maxC;
    const max = maxC.value;
    if (!Number.isInteger(max) || max < 1 || max > MAX_ALLOWED_ITERATIONS) {
        return {
            error: `ralph_loop: max_iterations must be an integer in [1, ${MAX_ALLOWED_ITERATIONS}] (got ${displayValue(rawMax)}).`,
        };
    }

    const rawMin = args.min_iterations ?? DEFAULTS.min_iterations;
    const minC = coerceNumberField("min_iterations", rawMin);
    if (minC.error) return minC;
    const min = minC.value;
    if (!Number.isInteger(min) || min < 1 || min > max) {
        return {
            error: `ralph_loop: min_iterations must be an integer in [1, max_iterations=${max}] (got ${displayValue(rawMin)}).`,
        };
    }

    const cp = resolveOptionalPromise("completion_promise", args.completion_promise, DEFAULTS.completion_promise);
    if (cp.error) return cp;
    const completionPromise = cp.value;

    const ap = resolveOptionalPromise("abort_promise", args.abort_promise, null, { whenProvided: true });
    if (ap.error) return ap;
    const abortPromise = ap.value;

    if (abortPromise !== null) {
        if (abortPromise === completionPromise) {
            return {
                error: `ralph_loop: abort_promise must differ from completion_promise (both are ${JSON.stringify(completionPromise)} — the signal would be ambiguous).`,
            };
        }
        if (abortPromise.includes(completionPromise) || completionPromise.includes(abortPromise)) {
            return {
                error: `ralph_loop: completion_promise (${JSON.stringify(completionPromise)}) and abort_promise (${JSON.stringify(abortPromise)}) overlap as substrings — whichever check runs first will always fire. Pick disjoint phrases.`,
            };
        }
    }

    const rawStagnation = args.stagnation_limit ?? DEFAULTS.stagnation_limit;
    const stagC = coerceNumberField("stagnation_limit", rawStagnation);
    if (stagC.error) return stagC;
    const stagnationLimit = stagC.value;
    if (!Number.isInteger(stagnationLimit) || stagnationLimit < 0 || stagnationLimit === 1) {
        return {
            error: `ralph_loop: stagnation_limit must be 0 (disabled) or an integer ≥ 2 (got ${displayValue(rawStagnation)}). 1 is meaningless because no comparison is possible after a single response.`,
        };
    }

    // Issue #7: optional max_tokens cap. Null when not supplied (cap
    // disabled). Accepted shapes: positive integer ≤ 1e9 (sanity bound
    // — anything larger is almost certainly a bug, since current
    // context windows top out at 1M).
    let maxTokens = null;
    if (args.max_tokens !== undefined && args.max_tokens !== null) {
        const mtC = coerceNumberField("max_tokens", args.max_tokens);
        if (mtC.error) return mtC;
        if (!Number.isInteger(mtC.value) || mtC.value < 1 || mtC.value > 1_000_000_000) {
            return {
                error: `ralph_loop: max_tokens must be a positive integer ≤ 1e9 (got ${displayValue(args.max_tokens)}).`,
            };
        }
        maxTokens = mtC.value;
    }

    // Issue #7: warn_at_pct controls the first context-window warning
    // threshold. The 95% second threshold is hard-coded since it's
    // meant as the "danger zone" and is independent of user preference.
    const rawWarnPct = args.warn_at_pct ?? DEFAULTS.warn_at_pct;
    const wpC = coerceNumberField("warn_at_pct", rawWarnPct);
    if (wpC.error) return wpC;
    const warnAtPct = wpC.value;
    if (!Number.isInteger(warnAtPct) || warnAtPct < 1 || warnAtPct > 99) {
        return {
            error: `ralph_loop: warn_at_pct must be an integer in [1, 99] (got ${displayValue(rawWarnPct)}).`,
        };
    }

    // Adaptive iteration budget (issue #4). Opt-in. When disabled, the other
    // adaptive fields are accepted-and-ignored so a user can keep
    // adaptive_extension / adaptive_max_total presets in their tooling without
    // having to remember to flip them off when adaptive_budget is false.
    const rawAdaptive = args.adaptive_budget;
    let adaptiveBudget = DEFAULTS.adaptive_budget;
    if (rawAdaptive !== undefined && rawAdaptive !== null) {
        if (typeof rawAdaptive !== "boolean") {
            return { error: `ralph_loop: adaptive_budget must be a boolean (got ${describeArgType(rawAdaptive)}).` };
        }
        adaptiveBudget = rawAdaptive;
    }
    const rawExt = args.adaptive_extension ?? DEFAULTS.adaptive_extension;
    const extC = coerceNumberField("adaptive_extension", rawExt);
    if (extC.error) return extC;
    const adaptiveExtension = extC.value;
    if (!Number.isInteger(adaptiveExtension) || adaptiveExtension < 1 || adaptiveExtension > MAX_ALLOWED_ITERATIONS) {
        return { error: `ralph_loop: adaptive_extension must be an integer in [1, ${MAX_ALLOWED_ITERATIONS}] (got ${displayValue(rawExt)}).` };
    }
    const rawTotal = args.adaptive_max_total ?? Math.min(max * 5, MAX_ALLOWED_ITERATIONS);
    const totalC = coerceNumberField("adaptive_max_total", rawTotal);
    if (totalC.error) return totalC;
    const adaptiveMaxTotal = totalC.value;
    if (!Number.isInteger(adaptiveMaxTotal) || adaptiveMaxTotal < max || adaptiveMaxTotal > MAX_ALLOWED_ITERATIONS) {
        return { error: `ralph_loop: adaptive_max_total must be an integer in [max_iterations=${max}, ${MAX_ALLOWED_ITERATIONS}] (got ${displayValue(rawTotal)}).` };
    }

    return { value: { prompt, max, min, completionPromise, abortPromise, stagnationLimit, maxTokens, warnAtPct, adaptiveBudget, adaptiveExtension, adaptiveMaxTotal } };
}

/**
 * @typedef {Object} ActiveLoopState
 * @property {string} prompt - Validated, trimmed prompt re-fired each iteration.
 * @property {string} label - Tool that armed the loop ("ralph_loop", "self_improve", or "grow_project"). Stamps every per-iteration log line and the finish() log line with the calling tool's name.
 * @property {number} max - Hard iteration cap (1..MAX_ALLOWED_ITERATIONS).
 * @property {number} min - Iterations that must complete before completion/abort phrases are honored (1..max).
 * @property {string} completionPromise - Trimmed substring whose presence finishes with reason "completion_promise".
 * @property {string|null} abortPromise - Trimmed substring whose presence finishes with reason "abort_promise"; null when not configured.
 * @property {number} stagnationLimit - 0 disables; otherwise N≥2 consecutive byte-identical responses fire reason "stagnation".
 * @property {number} i - Current iteration counter (0 between arm and first idle, 1..max thereafter).
 * @property {string|null} prev - Last iteration's accumulated text, captured for stagnation comparison; null until the first iteration evaluation.
 * @property {number} streak - Count of consecutive byte-identical responses (resets to 1 on any change).
 * @property {boolean} pendingFire - True from arm-time until the first session.idle fires iteration 1.
 * @property {boolean} fireInFlight - True between a successful tryFire and the next assistant.message that "consumes" it.
 * @property {boolean} observedMessageThisFire - True once the in-flight fire has produced at least one root assistant.message.
 * @property {number} startedAt - Epoch ms captured at arm-time, used for durationMs.
 * @property {number|null} maxTokens - Issue #7: opt-in token cap; null = disabled.
 * @property {number} warnAtPct - Issue #7: first context-window warning threshold (default 80, range 1..99). 95% second-threshold is hard-coded.
 * @property {{ input: number, output: number, byIteration: Array<object>, byModel: Object<string, {input:number, output:number}>, currentModel: string|null, warnedThresholds: number[], unknownModelLogged: boolean }} tokens - Issue #7: cumulative token bookkeeping. Initialized empty at arm-time; mutated in onAssistantMessage as usage events arrive.
 * @property {(() => void) | null} stopCaffeinate - Idempotent killer for the optional caffeinate child (issue #8); null when sleep prevention is disabled or unsupported.
 * @property {number|null} lastIterationAt - Epoch ms of the most recent iteration fire (issue #5); null until the first iteration starts.
 * @property {{isRepo: boolean, head?: string, branch?: string|null}} armedGit - Snapshot of git HEAD/branch at arm-time (issue #5); `isRepo: false` when the cwd isn't a git repo.
 * @property {boolean} adaptiveBudget - Issue #4: when true, max may be extended at the terminator if progress signals are positive.
 * @property {number} adaptiveExtension - Issue #4: iterations granted per extension (≥ 1).
 * @property {number} adaptiveMaxTotal - Issue #4: hard ceiling regardless of extensions (≥ originalMax, ≤ MAX_ALLOWED_ITERATIONS).
 * @property {number} originalMax - Issue #4: snapshot of `max` at arm-time so logs/results can report the user-supplied vs effective budget.
 * @property {string[]} adaptiveContentHashes - Issue #4: rolling djb2 hashes of the last ADAPTIVE_WINDOW iterations' assistant content; powers the response-novelty signal.
 * @property {Array<{atIter: number, from: number, to: number, reason: string}>} adaptiveExtensionHistory - Issue #4: append-only log of every extension granted; surfaced in ralph_status and the finish result.
 * @property {boolean} paused - Issue #3: when true, onIdle short-circuits before firing the next iteration. Toggled by ralph_pause / ralph_resume.
 * @property {string|null} pauseReason - Issue #3: optional human-readable reason supplied to ralph_pause; surfaced in logs.
 * @property {number} pausedAt - Issue #3: epoch ms of the most recent pause; 0 when never paused.
 * @property {number} totalPausedMs - Issue #3: cumulative paused time across all pause/resume cycles, deducted from durationMs so wall-clock reflects active time.
 */

/**
 * Build a Ralph controller.
 *
 * Use `tools` and `hooks` directly in `joinSession({ tools, hooks })`.
 * Then call `attach(session)` once with the resolved session to wire up
 * event listeners and bind the session reference used by tool handlers.
 *
 * @returns {{
 *   tools: Array<object>,
 *   hooks: { onUserPromptSubmitted: Function },
 *   attach: (session: object) => () => void,
 *   state: { active: ActiveLoopState|null, lastAssistantContent: string, lastResult: RalphResult|null },
 *   _internal: { onAssistantMessage: Function, onIdle: Function, onAbort: Function, finish: Function, success: Function, failure: Function }
 * }} Controller. See `attach()` for the detach contract.
 */
export function createRalphController(opts = {}) {
    // Caffeinate dependency injection (issue #8). Tests pass stubs; production
    // resolves child_process.spawn lazily so the import cost is paid only when
    // RALPH_CAFFEINATE is actually enabled.
    const caffeinateDeps = {
        env: opts.caffeinate?.env ?? process.env,
        platform: opts.caffeinate?.platform ?? process.platform,
        pid: opts.caffeinate?.pid ?? process.pid,
        spawnFn: opts.caffeinate?.spawnFn ?? null,
    };
    // Git dependency injection (issue #5). `ralph_status` calls gitExec(args)
    // synchronously; tests replace it with a stub that returns canned results.
    // `cwd` is captured at controller-build time so tests can pin a fake root.
    const gitCwd = opts.git?.cwd ?? process.cwd();
    const gitExecRaw = opts.git?.exec ?? ((args) => defaultGitExec(args, gitCwd));
    // Normalize a throwing gitExec into the same `{ ok: false, ... }` shape
    // that `defaultGitExec` produces on internal failure. This guarantees
    // every call site (captureGitArmSnapshot, ralph_status's
    // buildStatusSnapshot, computeFilesChangedBlock, etc.) can treat
    // gitExec as total — no need to wrap each call in try/catch and no
    // way for a misbehaving test injection (or a future production gitExec
    // that forgets the convention) to crash arm-time and leak caffeinate.
    const gitExec = (args) => {
        try { return gitExecRaw(args); }
        catch (err) {
            return { ok: false, stdout: "", stderr: err?.message ?? String(err), code: null };
        }
    };
    // Adaptive-budget DI (issue #4). Tests inject a stub gitExec to drive
    // signals deterministically; production resolves spawnSync lazily so the
    // import cost is paid only when adaptive_budget is actually enabled.
    const adaptiveCwd = opts.adaptive?.cwd ?? process.cwd();
    const adaptiveGitExecRaw = opts.adaptive?.gitExec ?? ((args) => defaultAdaptiveGitExec(args, adaptiveCwd));
    // Same total-function normalization as gitExec above: a throwing
    // adaptive injection must not crash the end-of-iteration adaptive
    // signal evaluation (which runs synchronously inside onIdle).
    const adaptiveGitExec = (args) => {
        try { return adaptiveGitExecRaw(args); }
        catch (err) {
            return { ok: false, stdout: "", stderr: err?.message ?? String(err), code: null };
        }
    };
    // JSONL event emit DI (issue #22). When `opts.events` is undefined or
    // false, no events.jsonl is produced — the loop runs exactly as before.
    // When `opts.events` is `true` or an object, an emitter is built per
    // armLoop call and attached to state.active.events. `factory` is the
    // injection seam tests use to record without touching disk.
    //   opts.events = false | undefined         → off
    //   opts.events = true                      → on, default emitter (writes ~/.copilot/ralph/runs)
    //   opts.events = { factory }               → on, custom factory({label, startedAt}) → writer
    //   opts.events = { env, fs }               → on, default emitter w/ overrides
    const eventsConfig = (() => {
        const e = opts.events;
        if (!e) return null;
        if (e === true) return { factory: defaultEventEmitter };
        if (typeof e.factory === "function") return { factory: e.factory };
        return { factory: (args) => defaultEventEmitter({ ...args, env: e.env, fs: e.fs }) };
    })();
    const buildEventWriter = (label, startedAt) => {
        if (!eventsConfig) return null;
        try { return eventsConfig.factory({ label, startedAt }) ?? null; }
        catch { return null; }
    };
    const safeEmit = (a, ev) => {
        const w = a?.events;
        if (!w?.write) return;
        try { w.write(ev); } catch { /* swallow */ }
    };
    const safeCloseEvents = (a) => {
        const w = a?.events;
        if (!w?.close) return;
        try { w.close(); } catch { /* swallow */ }
    };
    const state = {
        active: null,           // ActiveLoopState; null when no loop is armed.
        lastAssistantContent: "",
        // Shape: see the RalphResult typedef. Frozen on assignment.
        lastResult: null,
    };
    let sessionRef = null;

    // Clamp elapsed to ≥ 0 so a backward clock jump (NTP correction mid-loop)
    // never surfaces a negative duration in logs or result.durationMs.
    const clampedElapsed = (start) => Math.max(0, Date.now() - start);

    const log = (msg) => {
        try { sessionRef?.log?.(msg); } catch { /* swallow */ }
    };

    // Shared helper for self_improve / grow_project handlers (refactor): emit
    // a single arm-time log line if the caller's completion_promise /
    // abort_promise differs from the baked SDLC prompt's literal emit
    // instruction. A mismatch means the prompt instructs the agent to emit
    // one token while the runtime watches for another — the loop silently
    // runs to max_iterations on an otherwise-successful run. Was previously
    // duplicated byte-for-byte (modulo tool name) in both handlers; pulling
    // it up keeps a single source of truth so a future message tweak can't
    // drift between the two tools.
    const warnPromiseDrift = (toolName, fieldName, raw, expected, consequence) => {
        if (typeof raw !== "string") return;
        const trimmed = raw.trim();
        if (!trimmed || trimmed === expected) return;
        log(`${toolName}: warning — ${fieldName}=${JSON.stringify(trimmed)} differs from the baked SDLC prompt's "${expected}" emit instruction; ${consequence}.`);
    };

    // Fire iteration prompt; handle both sync throws and async rejections.
    // Captures the active-loop identity at fire-time so a late rejection from a
    // previous arming can't poison a freshly-armed loop. Queue-bloat protection:
    // back-to-back signals would otherwise queue duplicate prompts — visible as
    // `Queued (3)` of identical messages.
    const tryFire = (prompt) => {
        const armedFor = state.active;
        if (!armedFor) return;
        if (armedFor.fireInFlight) {
            log(`${armedFor.label}: skipping refire — previous prompt still queued (no assistant.message observed yet)`);
            return;
        }
        armedFor.fireInFlight = true;
        armedFor.observedMessageThisFire = false;
        // kind: "rejected" (async rejection) or "failed" (sync throw) — both prefixes
        // are part of the public log/note contract. boundedNoteForLog caps the log
        // line; finish() does its own truncate on result.note.
        const handleSendFailure = (err, kind) => {
            if (state.active !== armedFor) return;
            armedFor.fireInFlight = false;
            const raw = err?.message ?? String(err);
            const prefix = `send ${kind}`;
            log(`${armedFor.label}: ${prefix}: ${boundedNoteForLog(raw)}`);
            finish("send_error", `${prefix}: ${raw}`);
        };
        try {
            if (!sessionRef?.send) throw new Error("session not attached");
            const r = sessionRef.send({ prompt });
            if (typeof r?.then === "function") {
                r.catch((err) => handleSendFailure(err, "rejected"));
            }
        } catch (err) {
            handleSendFailure(err, "failed");
        }
    };

    const finish = (reason, note) => {
        if (!state.active) return;
        const { startedAt, i: iterations, label, tokens, stopCaffeinate, originalMax, max, adaptiveBudget, adaptiveExtensionHistory } = state.active;
        const finishedAt = Date.now();
        const durationMs = clampedElapsed(startedAt);
        const result = {
            reason,
            iterations,
            label,
            preview: previewOf(state.lastAssistantContent),
            startedAt,
            finishedAt,
            durationMs,
        };
        if (note) result.note = truncateNote(note);
        // Issue #7: surface tokens block whenever any tokens were
        // counted. Empty (no usage events seen) ⇒ omit so the result
        // shape doesn't pretend to know what it doesn't.
        if (tokens && (tokens.input > 0 || tokens.output > 0)) {
            result.tokens = {
                input: tokens.input,
                output: tokens.output,
                total: tokens.input + tokens.output,
                byIteration: [...tokens.byIteration],
                byModel: { ...tokens.byModel },
            };
        }
        // Surface adaptive-budget info on the frozen result whenever the
        // feature was enabled — even if no extension fired — so callers can
        // tell "feature was on but never triggered" from "feature was off".
        if (adaptiveBudget) {
            result.adaptive = {
                enabled: true,
                originalMax,
                effectiveMax: max,
                extensions: adaptiveExtensionHistory.length,
                history: [...adaptiveExtensionHistory],
            };
        }
        const verb = VERB_BY_REASON[reason] ?? "⏹ stopped";
        const noteForLog = collapseNote(result.note);
        log(`${verb} ${label} after ${iterations} iteration${pluralS(iterations)} (reason: ${reason}${noteForLog ? `, note: ${noteForLog}` : ""}, ${durationMs}ms)`);
        // Issue #22: emit terminal event before we drop state.active so
        // the writer is still reachable. Failure-flavored reasons map
        // to `abort` (UI shows red); success-flavored reasons map to
        // `complete` (UI shows green).
        const ABORT_REASONS = new Set(["aborted", "abort_promise", "send_error", "stagnation"]);
        const terminalType = ABORT_REASONS.has(reason) ? "abort" : "complete";
        safeEmit(state.active, {
            type: terminalType,
            runId: state.active.runId,
            iterations,
            reason,
            note: result.note,
            durationMs,
            tokens: result.tokens ? { input: result.tokens.input, output: result.tokens.output } : undefined,
            ts: finishedAt,
        });
        safeCloseEvents(state.active);
        state.active = null;
        state.lastResult = deepFreeze(result);
        // Tear down caffeinate AFTER state.active is cleared and lastResult is
        // frozen so a kill-time crash can't leave the loop in a half-finished
        // state.
        if (typeof stopCaffeinate === "function") {
            try { stopCaffeinate(); } catch { /* swallow */ }
        }
    };

    // Issue #7: extract usage from an event payload. Defensive against
    // multiple possible shapes — different SDK versions may expose
    // usage as data.usage = {input_tokens, output_tokens, model} OR
    // as flat data.usage_input_tokens / data.usage_output_tokens /
    // data.usage_model. Returns null when no usage data found.
    const extractUsage = (ev) => {
        const d = ev?.data;
        if (!d) return null;
        const u = d.usage;
        if (u && typeof u === "object") {
            const input = Number(u.input_tokens ?? u.inputTokens ?? 0);
            const output = Number(u.output_tokens ?? u.outputTokens ?? 0);
            const model = typeof u.model === "string" ? u.model : (typeof d.model === "string" ? d.model : null);
            if (Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0)) {
                return { input, output, model };
            }
        }
        const flatIn = Number(d.usage_input_tokens ?? d.usageInputTokens ?? 0);
        const flatOut = Number(d.usage_output_tokens ?? d.usageOutputTokens ?? 0);
        if (Number.isFinite(flatIn) && Number.isFinite(flatOut) && (flatIn > 0 || flatOut > 0)) {
            const model = typeof d.usage_model === "string" ? d.usage_model
                : typeof d.usageModel === "string" ? d.usageModel
                : typeof d.model === "string" ? d.model : null;
            return { input: flatIn, output: flatOut, model };
        }
        return null;
    };

    // Issue #7: credit usage to the active loop. Updates per-iteration
    // and per-model rollups, then checks context-window warning
    // thresholds. Each threshold fires at most once per loop run.
    const creditUsage = (a, usage) => {
        a.tokens.input += usage.input;
        a.tokens.output += usage.output;
        a.tokens.byIteration.push({
            iter: a.i,
            input: usage.input,
            output: usage.output,
            model: usage.model ?? null,
        });
        if (usage.model) {
            a.tokens.currentModel = usage.model;
            const m = a.tokens.byModel[usage.model] ?? { input: 0, output: 0 };
            m.input += usage.input;
            m.output += usage.output;
            a.tokens.byModel[usage.model] = m;
        }
        // Context-window warnings — only for known models. Unknown models
        // get one log line so the user knows the warning is skipped.
        const window = usage.model ? MODEL_CONTEXT_WINDOWS[usage.model] : null;
        if (!window) {
            if (usage.model && !a.tokens.unknownModelLogged) {
                log(`${a.label}: token tracking — model ${JSON.stringify(usage.model)} has no known context-window size; skipping window warnings.`);
                a.tokens.unknownModelLogged = true;
            }
            return;
        }
        // Use input tokens for the warning since that's what determines
        // when the next request will overflow. Output tokens shrink
        // available space too but only for the *current* turn.
        const used = a.tokens.input;
        const pct = (used / window) * 100;
        for (const threshold of TOKEN_WARNING_THRESHOLDS) {
            const effective = threshold === 80 ? a.warnAtPct : threshold;
            if (pct >= effective && !a.tokens.warnedThresholds.includes(threshold)) {
                a.tokens.warnedThresholds.push(threshold);
                const usedK = Math.round(used / 1000);
                const winK = Math.round(window / 1000);
                if (threshold === 95) {
                    log(`${a.label}: ⚠ context window critical: ${usedK}k / ${winK}k tokens used (${pct.toFixed(1)}%, model ${usage.model}). Consider ralph_stop to avoid mid-iteration truncation.`);
                } else {
                    log(`${a.label}: ⚠ approaching context window: ${usedK}k / ${winK}k tokens used (${pct.toFixed(1)}%, model ${usage.model}). Consider stopping and restarting with a fresh session.`);
                }
            }
        }
    };


    const onAssistantMessage = (ev) => {
        const text = ev?.data?.content;
        if (typeof text !== "string") return;
        // Ignore sub-agent messages — see isSubAgentEvent() rationale.
        // Otherwise their content would be checked for completion/abort tokens.
        if (isSubAgentEvent(ev)) return;
        // Issue #7: credit token usage on this event (if any) before we
        // touch the rest of the state. Sub-agent events are excluded by
        // the guard above.
        if (state.active) {
            const usage = extractUsage(ev);
            if (usage) creditUsage(state.active, usage);
        }
        // Mark this fire "consumed" so the next idle is treated as a real
        // response cycle, not a spurious signal that would queue another copy.
        if (state.active?.fireInFlight) {
            state.active.observedMessageThisFire = true;
        }
        // Accumulate across multiple assistant.message events in the same turn
        // (the SDK can emit several per turn); reset on each iteration fire-out.
        const prev = state.lastAssistantContent;
        const next = prev ? `${prev}\n${text}` : text;
        // Bound memory: keep a tail ≤ MAX_CONTENT_CHARS — completion/abort/
        // stagnation only inspect this string. safeSliceStart guards against
        // the head-trim leaving a lone low surrogate at position 0.
        state.lastAssistantContent = next.length > MAX_CONTENT_CHARS
            ? next.slice(safeSliceStart(next, next.length - MAX_CONTENT_CHARS))
            : next;
    };

    // Run an iteration: log start, clear the accumulator (so a silent
    // iteration is evaluated as empty rather than the prior turn), and
    // fire the prompt. Caller is responsible for incrementing `a.i`.
    const fireIteration = (a) => {
        log(`🔁 ${a.label} iter ${a.i}/${a.max} (elapsed ${clampedElapsed(a.startedAt)}ms)`);
        state.lastAssistantContent = "";
        safeEmit(a, { type: "iteration_start", runId: a.runId, iteration: a.i, ts: Date.now() });
        tryFire(a.prompt);
    };

    const onIdle = (ev) => {
        const a = state.active;
        if (!a) return;

        // Only react to root-agent idles — see isSubAgentEvent() rationale.
        // A sub-agent finishing its own loop (task / explore / …) must NOT
        // queue an extra copy of our prompt.
        if (isSubAgentEvent(ev)) return;

        // Issue #3: if paused, stop here. The user may still chat freely
        // with the agent in this session — those turns reach the real
        // session.idle but we deliberately do nothing, leaving the loop
        // counter untouched until ralph_resume re-arms.
        if (a.paused) return;

        // The turn that *called* ralph_loop goes idle before any iteration runs.
        // Use that idle to fire iteration 1; evaluate completion/abort on later ones.
        if (a.pendingFire) {
            a.pendingFire = false;
            a.i = 1;
            a.lastIterationAt = Date.now();
            fireIteration(a);
            return;
        }

        // Queue-bloat protection: if the prompt we previously fired hasn't
        // produced any assistant.message yet, this idle is a stale signal.
        if (a.fireInFlight && !a.observedMessageThisFire) {
            log(`${a.label}: skipping idle — previous prompt not yet picked up by agent`);
            return;
        }
        // Consume the in-flight marker now that the agent has fully
        // responded to our last fire (assistant.message + session.idle).
        a.fireInFlight = false;
        a.observedMessageThisFire = false;

        const text = state.lastAssistantContent;

        // Issue #22: emit iteration_end as soon as the iteration is
        // observable on disk — before any terminator runs so the TUI
        // sees the completed iter even when the loop ends right after.
        safeEmit(a, {
            type: "iteration_end",
            runId: a.runId,
            iteration: a.i,
            excerpt: text,
            tokens: { input: a.tokens.input, output: a.tokens.output },
            ts: Date.now(),
        });

        // completion/abort only honored once min_iterations have completed
        if (a.i >= a.min) {
            if (text.includes(a.completionPromise)) return finish("completion_promise");
            if (a.abortPromise && text.includes(a.abortPromise)) return finish("abort_promise");
        }

        if (a.stagnationLimit > 0) {
            // First iteration: a.prev is null, text is a string — `text ===
            // a.prev` is false so we take the reset branch and set streak=1.
            a.streak = text === a.prev ? a.streak + 1 : 1;
            a.prev = text;
            if (a.streak >= a.stagnationLimit) {
                safeEmit(a, { type: "stagnation", runId: a.runId, iteration: a.i, streak: a.streak, ts: Date.now() });
                return finish("stagnation");
            }
        }

        // Track per-iteration response signature for the adaptive-budget
        // novelty signal (issue #4). Cheap djb2 hash — we only need
        // distinct/identical, not collision resistance. Window is the last
        // ADAPTIVE_WINDOW iterations; stagnation already covers the
        // hard-identical case so this is purely additive.
        if (a.adaptiveBudget) {
            a.adaptiveContentHashes.push(djb2Hash(text));
            if (a.adaptiveContentHashes.length > ADAPTIVE_WINDOW) {
                a.adaptiveContentHashes.shift();
            }
        }

        // Adaptive-budget extension check (issue #4). Run BEFORE the
        // max-iterations terminator so a positive progress signal can
        // grant more iterations for this loop. Stagnation/completion/
        // abort already had their chance above and win unconditionally.
        if (a.i >= a.max && a.adaptiveBudget && a.max < a.adaptiveMaxTotal) {
            const reason = evaluateAdaptiveSignals(a, adaptiveGitExec);
            if (reason) {
                const newMax = Math.min(a.max + a.adaptiveExtension, a.adaptiveMaxTotal);
                if (newMax > a.max) {
                    log(`${a.label}: adaptive budget extended ${a.max} → ${newMax} (reason: ${reason})`);
                    a.adaptiveExtensionHistory.push({ atIter: a.i, from: a.max, to: newMax, reason });
                    a.max = newMax;
                }
            }
        }

        if (a.i >= a.max) return finish("max_iterations");

        // Issue #7: check max_tokens cap *after* min_iterations have
        // completed (don't bypass the user's minimum) and after
        // completion/abort/stagnation have had their chance. Use total
        // (input+output) for the cap since that's the user-facing
        // budget concept ("don't spend more than N tokens on this loop").
        if (a.maxTokens && a.i >= a.min) {
            const total = a.tokens.input + a.tokens.output;
            if (total >= a.maxTokens) {
                return finish("max_tokens", `${total} tokens used (cap: ${a.maxTokens})`);
            }
        }

        a.i += 1;
        a.lastIterationAt = Date.now();
        fireIteration(a);
    };

    const onAbort = (ev) => {
        // Only react to root-agent aborts — see isSubAgentEvent() rationale.
        // A sub-agent that gets aborted (task / explore / rubber-duck
        // failure) must NOT tear down the root ralph_loop along with it.
        if (isSubAgentEvent(ev)) return;
        if (!state.active) return;
        // If the SDK supplies an abort reason in the event payload,
        // capture it so it shows up in the log line and additionalContext.
        const reasonRaw = ev?.data?.reason ?? ev?.reason;
        const note = (typeof reasonRaw === "string" ? reasonRaw.trim() : "") || undefined;
        // Log line capped via boundedNoteForLog; result.note is capped
        // independently by finish() → truncateNote.
        log(`⏹ ${state.active.label} interrupted by session abort${note ? ` (${boundedNoteForLog(note)})` : ""}.`);
        finish("aborted", note);
    };

    // Single source of truth for the "session not attached" refusal —
    // used by both arming tools so the wording stays in lockstep and the
    // label matches the calling tool.
    function requireAttachedSession(label) {
        if (sessionRef?.send) return null;
        return failure(
            `${label}: session not attached — controller.attach(session) must be called before invoking ${label}.`,
        );
    }

    // Single source of truth for the "another loop is already active"
    // refusal — used by ralph_loop, self_improve, and grow_project so
    // the message and iteration-counter logic can never drift.
    function activeLoopGuard() {
        if (!state.active) return null;
        const { pendingFire, i, max } = state.active;
        const status = pendingFire
            ? `armed (iteration 1/${max} pending)`
            : `running (iteration ${i}/${max})`;
        return failure(`${state.active.label} is already ${status} — call ralph_stop first.`);
    }

    // Shared arming body for ralph_loop, self_improve, and grow_project.
    // Caller is responsible for the session-attached and already-active
    // guards plus arg validation; this helper mutates state.active and
    // emits the arm log + success result. The `label` is woven through
    // state.active.label, the arm log line, and the success text so
    // every observable artifact reflects which tool armed the loop.
    function armLoop(parsedValue, label = "ralph_loop") {
        // Resolve spawnFn lazily so child_process is only required when
        // caffeinate is actually enabled (avoids paying the require cost
        // for every loop arm). Tests inject spawnFn directly via opts.
        let spawnFn = caffeinateDeps.spawnFn;
        if (!spawnFn && isCaffeinateEnabled(caffeinateDeps.env) && caffeinateDeps.platform === "darwin") {
            try {
                ({ spawn: spawnFn } = moduleRequire("node:child_process"));
            } catch { /* swallow — startCaffeinate handles null spawnFn */ }
        }
        const stopCaffeinate = startCaffeinate({
            env: caffeinateDeps.env,
            platform: caffeinateDeps.platform,
            pid: caffeinateDeps.pid,
            spawnFn,
            log,
            label,
        });
        // Snapshot git HEAD/branch at arm-time for ralph_status's
        // "files changed since loop started" diff. Best-effort — a non-git
        // cwd just means status reports null for the git block.
        const armedGit = captureGitArmSnapshot(gitExec, gitCwd);
        const startedAt = Date.now();
        const eventsWriter = buildEventWriter(label, startedAt);
        state.active = {
            ...parsedValue,
            label,
            i: 0,
            prev: null,
            streak: 0,
            pendingFire: true,
            fireInFlight: false,
            observedMessageThisFire: false,
            startedAt,
            tokens: {
                input: 0,
                output: 0,
                byIteration: [],
                byModel: {},
                currentModel: null,
                warnedThresholds: [],
                unknownModelLogged: false,
            },
            stopCaffeinate,
            lastIterationAt: null,
            armedGit,
            originalMax: parsedValue.max,
            adaptiveContentHashes: [],
            adaptiveExtensionHistory: [],
            paused: false,
            pauseReason: null,
            pausedAt: 0,
            totalPausedMs: 0,
            // Issue #22: per-loop event writer (null when events are off).
            events: eventsWriter,
            runId: eventsWriter?.runId ?? null,
        };
        state.lastAssistantContent = "";
        state.lastResult = null;

        // Build the arm log line as an array of "key=value" parts
        // so optional fields drop out cleanly without nested ternaries.
        const { max, min, completionPromise, abortPromise, stagnationLimit, adaptiveBudget, adaptiveExtension, adaptiveMaxTotal } = parsedValue;
        const armParts = [`max=${max}`];
        if (min > 1) armParts.push(`min=${min}`);
        armParts.push(`completion=${JSON.stringify(completionPromise)}`);
        if (abortPromise) armParts.push(`abort=${JSON.stringify(abortPromise)}`);
        if (stagnationLimit > 0) armParts.push(`stagnation_limit=${stagnationLimit}`);
        if (adaptiveBudget) armParts.push(`adaptive=${adaptiveExtension}/${adaptiveMaxTotal}`);
        log(`🔁 ${label} armed — ${armParts.join(", ")}`);
        // Issue #22: emit the armed event AFTER state.active is wired so
        // safeEmit can find the writer; an `armed` event also bumps the
        // run index so `ralph-tui list` discovers this run immediately.
        safeEmit(state.active, {
            type: "armed",
            runId: state.active.runId,
            label,
            maxIterations: max,
            minIterations: min,
            startedAt,
            ts: startedAt,
        });
        return success(
            `${label} armed (max=${max}${min > 1 ? `, min=${min}` : ""}${adaptiveBudget ? `, adaptive_max_total=${adaptiveMaxTotal}` : ""}). Iterations will run as conversation turns. Use ralph_stop to cancel.`,
            { armed: true, max, min, adaptive_budget: adaptiveBudget, adaptive_extension: adaptiveExtension, adaptive_max_total: adaptiveMaxTotal },
        );
    }

    function buildStatusSnapshot() {
        const now = Date.now();
        if (!state.active) {
            const out = { active: false };
            if (state.lastResult) {
                const r = state.lastResult;
                out.last = {
                    label: r.label,
                    reason: r.reason,
                    iterations: r.iterations,
                    started_at: new Date(r.startedAt).toISOString(),
                    finished_at: new Date(r.finishedAt).toISOString(),
                    duration_ms: r.durationMs,
                    preview: r.preview,
                };
                if (r.note) out.last.note = r.note;
            }
            return out;
        }
        const a = state.active;
        const elapsed = clampedElapsed(a.startedAt);
        const status = {
            active: true,
            label: a.label,
            iteration: a.i,
            max_iterations: a.max,
            min_iterations: a.min,
            elapsed_ms: elapsed,
            elapsed_seconds: Math.floor(elapsed / 1000),
            started_at: new Date(a.startedAt).toISOString(),
            last_iteration_at: a.lastIterationAt ? new Date(a.lastIterationAt).toISOString() : null,
            now: new Date(now).toISOString(),
            completion_promise: a.completionPromise,
            abort_promise: a.abortPromise,
            stagnation_limit: a.stagnationLimit,
            stagnation_streak: a.streak,
            pending_first_iteration: a.pendingFire,
            // Pause visibility — without these fields, a paused loop is
            // indistinguishable from a slow / blocked one in ralph_status,
            // because `iteration` and `elapsed_ms` keep advancing while
            // the loop is silent. `paused_for_ms` is the *current* pause
            // duration (0 when not paused); `total_paused_ms` is the
            // cumulative time spent paused across all prior pause/resume
            // cycles in this run (matches what's added back at resume).
            paused: a.paused === true,
            pause_reason: a.pauseReason ?? null,
            paused_at: a.paused && a.pausedAt > 0 ? new Date(a.pausedAt).toISOString() : null,
            paused_for_ms: a.paused && a.pausedAt > 0 ? Math.max(0, now - a.pausedAt) : 0,
            total_paused_ms: a.totalPausedMs ?? 0,
            last_response_excerpt: previewOf(state.lastAssistantContent),
        };
        // Git block — best effort. Whole block is omitted when not in a repo.
        if (a.armedGit?.isRepo) {
            const head = gitExec(["rev-parse", "HEAD"]);
            const branchRes = gitExec(["rev-parse", "--abbrev-ref", "HEAD"]);
            const ab = gitAheadBehind(gitExec);
            const uncommitted = gitUncommittedLines(gitExec);
            const files = buildFilesChangedSinceArm(gitExec, gitCwd, a.armedGit.head);
            status.git = {
                branch: branchRes.ok ? branchRes.stdout.trim() : a.armedGit.branch,
                armed_head: a.armedGit.head,
                head: head.ok ? head.stdout.trim() : null,
                ahead: ab?.ahead ?? null,
                behind: ab?.behind ?? null,
                uncommitted_lines: uncommitted,
            };
            status.files_changed = files;
        } else {
            status.git = null;
        }
        return status;
    }

    const tools = [
        {
            name: "ralph_loop",
            description:
                `Run a Ralph Wiggum-style autonomous iterative loop. The tool returns immediately after arming the loop; iterations are driven by reacting to each session.idle (root-agent agentic-loop completion) and re-injecting the prompt as a new user message. Each iteration is a real conversation turn — context is retained, and progress is visible inline. Use ralph_stop to cancel an active loop. Tip: instruct the agent in the prompt to emit the completion_promise (default '${DEFAULTS.completion_promise}') when finished, otherwise the loop only stops at max_iterations. Only one loop runs per session; returns failure if a ralph_loop, self_improve, or grow_project loop is already active. Note: the user-supplied prompt is augmented at arm time with a small commit-attribution rider that adds dual Co-authored-by trailers (Copilot + copilot-ralph) to any git commit produced during the loop; set RALPH_NO_ATTRIBUTION=1 in the environment to suppress the second trailer.`,
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description:
                            `The task prompt that gets re-fed each iteration. Should instruct the agent to emit the completion_promise when done. Max ${MAX_PROMPT_CHARS} chars.`,
                        minLength: 1,
                        maxLength: MAX_PROMPT_CHARS,
                    },
                    max_iterations: {
                        type: "integer",
                        description: `Maximum iterations before stopping (default ${DEFAULTS.max_iterations}, max ${MAX_ALLOWED_ITERATIONS}).`,
                        default: DEFAULTS.max_iterations,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                    min_iterations: {
                        type: "integer",
                        description: `Minimum iterations before completion_promise / abort_promise are honored (default ${DEFAULTS.min_iterations}; must not exceed max_iterations). Use this to force the agent to run additional verification passes even if it declares completion early.`,
                        default: DEFAULTS.min_iterations,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                    completion_promise: {
                        type: "string",
                        description:
                            `Substring that, when present in an assistant turn's response, signals completion (default '${DEFAULTS.completion_promise}'). Max ${MAX_PROMISE_CHARS} chars.`,
                        default: DEFAULTS.completion_promise,
                        minLength: 1,
                        maxLength: MAX_PROMISE_CHARS,
                    },
                    abort_promise: {
                        type: "string",
                        description:
                            `Optional substring that, when present in an assistant turn's response, aborts the loop early (e.g. when the agent signals a precondition failure). Max ${MAX_PROMISE_CHARS} chars.`,
                        minLength: 1,
                        maxLength: MAX_PROMISE_CHARS,
                    },
                    stagnation_limit: {
                        type: "integer",
                        description: `Abort if the assistant returns N consecutive byte-identical responses (default ${DEFAULTS.stagnation_limit}, 0 to disable). Must be 0 or ≥ 2 — the value 1 is rejected at runtime since no comparison is possible after a single response.`,
                        default: DEFAULTS.stagnation_limit,
                        minimum: 0,
                        // Schema-level guard mirroring validateArgs's rejection of 1,
                        // so LLM clients honoring `not` see it up front instead of
                        // via a tool-call failure.
                        not: { const: 1 },
                    },
                    max_tokens: {
                        type: "integer",
                        description: "Optional cumulative token cap for the loop (input + output combined). When the loop crosses this value at the end of an iteration, it stops with reason \"max_tokens\". Omit for no cap. Useful to bound spend on long-running self-improve / grow_project runs.",
                        minimum: 1,
                        maximum: 1_000_000_000,
                    },
                    warn_at_pct: {
                        type: "integer",
                        description: `First context-window warning threshold as a percent of the model's total window (default ${DEFAULTS.warn_at_pct}). A second hard-coded warning fires at 95%. Each warning fires at most once per loop run.`,
                        default: DEFAULTS.warn_at_pct,
                        minimum: 1,
                        maximum: 99,
                    },
                    adaptive_budget: {
                        type: "boolean",
                        description: `Opt-in adaptive iteration budget (issue #4). When the loop reaches \`max_iterations\` and progress signals are positive (uncommitted changes OR ≥ 2 distinct responses in the last ${ADAPTIVE_WINDOW} iterations), grant \`adaptive_extension\` more iterations — capped at \`adaptive_max_total\`. Stagnation, completion_promise, and abort_promise still win over the adaptive extension. Default ${DEFAULTS.adaptive_budget} (off).`,
                        default: DEFAULTS.adaptive_budget,
                    },
                    adaptive_extension: {
                        type: "integer",
                        description: `Iterations granted per adaptive extension (default ${DEFAULTS.adaptive_extension}, ignored when adaptive_budget is false).`,
                        default: DEFAULTS.adaptive_extension,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                    adaptive_max_total: {
                        type: "integer",
                        description: `Hard ceiling for the effective max even after extensions (default min(max_iterations*5, ${MAX_ALLOWED_ITERATIONS}); must be ≥ max_iterations and ≤ ${MAX_ALLOWED_ITERATIONS}).`,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                },
                required: ["prompt"],
                additionalProperties: false,
            },
            handler: async (args) => {
                const notAttached = requireAttachedSession("ralph_loop");
                if (notAttached) return notAttached;
                const guard = activeLoopGuard();
                if (guard) return guard;
                const parsed = validateArgs(args);
                if (parsed.error) return failure(parsed.error);
                const composed = composeRalphLoopPrompt(parsed.value.prompt);
                if (composed.error) return failure(composed.error);
                parsed.value.prompt = composed.value;
                return armLoop(parsed.value);
            },
        },
        {
            name: "ralph_stop",
            description:
                "Cancel a currently-running ralph_loop, self_improve, or grow_project. Returns the iteration count at the moment of stop. Returns failure if no loop is active. Optionally pass a `reason` describing why the loop is being stopped (recorded as `note` on the result).",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: `Optional human-readable reason for stopping the loop (≤${PREVIEW_CHARS} chars).`,
                        maxLength: PREVIEW_CHARS,
                    },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                if (!state.active) return failure("ralph_stop: no ralph_loop, self_improve, or grow_project is currently running.");
                // ralph_stop's `reason` is optional (null/undefined valid).
                // Anything else goes through the same shape + unknown-keys
                // gate as ralph_loop so typos surface loudly.
                const bad = validateOptionalArgShape("ralph_stop", args, RALPH_STOP_KEYS);
                if (bad) return bad;
                const { i, max, label } = state.active;
                // parseUserReason: shared with ralph_pause. Flattens
                // multi-line input + caps length + coerces empty to
                // null. result.note (single-line below) is consumed by
                // collapseNote-driven additionalContext + terminal event.
                const reason = parseUserReason(args?.reason);
                finish("user_stopped", reason ?? undefined);
                return success(
                    `${label} stopped after ${i}/${max} iterations${reason ? ` (${reason})` : ""}.`,
                    { iterations: i, note: reason ?? undefined },
                );
            },
        },
        {
            name: "ralph_status",
            description:
                "Return a structured live snapshot of the active ralph_loop / self_improve / grow_project (iteration count, elapsed time, configured promises, pause state, last response excerpt, files changed since arm-time). Read-only — never mutates loop state. When no loop is active, returns { active: false } plus the previous run's summary if available. Cheap (<10ms typically); safe to call repeatedly.",
            parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
            handler: async (args) => {
                const bad = validateOptionalArgShape("ralph_status", args, new Set());
                if (bad) return bad;
                const snapshot = buildStatusSnapshot();
                // The structured payload is the primary product. The
                // textResultForLlm string is a one-line summary so a model
                // reading the result still gets a useful summary even if it
                // doesn't introspect the JSON.
                const summary = snapshot.active
                    ? `${snapshot.label}: iteration ${snapshot.iteration}/${snapshot.max_iterations}, elapsed ${snapshot.elapsed_ms}ms${snapshot.paused ? ` (PAUSED${snapshot.pause_reason ? ` — ${snapshot.pause_reason}` : ""}, for ${snapshot.paused_for_ms}ms)` : ""}`
                    : snapshot.last
                        ? `no active loop; last ${snapshot.last.label} ${snapshot.last.reason} after ${snapshot.last.iterations} iterations`
                        : "no active loop and no prior run in this session";
                return success(summary, { status: snapshot });
            },
        },
        {
            name: "ralph_pause",
            description:
                "Pause the active ralph_loop / self_improve / grow_project loop without losing iteration count or conversation context. The currently-running iteration (if any) finishes normally; subsequent session.idle events are short-circuited until ralph_resume is called. While paused, the user may chat freely with the agent — those turns do NOT consume iterations. Idempotent: pausing an already-paused loop is a no-op. Returns failure if no loop is active.",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: `Optional human-readable reason for pausing (≤${PREVIEW_CHARS} chars). Surfaced in logs and ralph_status.`,
                        maxLength: PREVIEW_CHARS,
                    },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                if (!state.active) return failure("ralph_pause: no ralph_loop, self_improve, or grow_project is currently running.");
                const bad = validateOptionalArgShape("ralph_pause", args, RALPH_PAUSE_KEYS);
                if (bad) return bad;
                const a = state.active;
                const { i, max, label } = a;
                if (a.paused) {
                    return success(
                        `${label} already paused at ${i}/${max}${a.pauseReason ? ` (${a.pauseReason})` : ""}.`,
                        { iterations: i, paused: true, reason: a.pauseReason ?? null },
                    );
                }
                // parseUserReason: shared with ralph_stop. Flatten +
                // truncate the user-supplied reason at entry so a
                // multi-line paste (e.g. an Error stack, a blockquote, a
                // CRLF-terminated input) cannot break the single-line
                // timeline log marker, the `pause_reason` field rendered
                // in the ralph_status JSON snapshot, or the `reason` on
                // the emitted `pause` event.
                const reason = parseUserReason(args?.reason);
                a.paused = true;
                a.pauseReason = reason;
                a.pausedAt = Date.now();
                log(`⏸ ${label} paused at ${i}/${max}${reason ? ` (${reason})` : ""}`);
                safeEmit(a, { type: "pause", runId: a.runId, iteration: i, reason, ts: a.pausedAt });
                return success(
                    `${label} paused at ${i}/${max}${reason ? ` (${reason})` : ""}. Use ralph_resume to continue.`,
                    { iterations: i, paused: true, reason },
                );
            },
        },
        {
            name: "ralph_resume",
            description:
                "Resume a paused ralph_loop / self_improve / grow_project from the same iteration counter. Stagnation streak is reset (manual intervention almost always changes context). Returns failure if no loop is active or the loop is not currently paused. The next session.idle event after resume will fire the next iteration normally.",
            parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
            handler: async (args) => {
                if (!state.active) return failure("ralph_resume: no ralph_loop, self_improve, or grow_project is currently running.");
                const bad = validateOptionalArgShape("ralph_resume", args, RALPH_RESUME_KEYS);
                if (bad) return bad;
                const a = state.active;
                if (!a.paused) {
                    return failure(`ralph_resume: ${a.label} is not paused. Use ralph_pause first, or ralph_stop to cancel.`);
                }
                const pausedFor = a.pausedAt > 0 ? Date.now() - a.pausedAt : 0;
                a.totalPausedMs += pausedFor;
                a.paused = false;
                a.pauseReason = null;
                a.pausedAt = 0;
                a.streak = 0;
                a.prev = null;
                log(`▶ ${a.label} resumed at ${a.i}/${a.max} (paused for ${pausedFor}ms)`);
                safeEmit(a, { type: "resume", runId: a.runId, iteration: a.i, pausedForMs: pausedFor, ts: Date.now() });
                return success(
                    `${a.label} resumed at ${a.i}/${a.max}. Next iteration will fire on the next session.idle.`,
                    { iterations: a.i, paused: false, pausedForMs: pausedFor },
                );
            },
        },
        {
            name: "self_improve",
            description:
                "Arms ralph_loop with a baked-in, project-agnostic SDLC self-improvement prompt (orient → ideate → critique → baseline → implement → test → commit → push → COMPLETE), suitable for any repo. Optional `focus` string narrows the run to a specific area without altering the SDLC scaffolding. Only one loop runs per session; cancel with ralph_stop. Returns failure if a ralph_loop, self_improve, or grow_project loop is already active.",
            parameters: {
                type: "object",
                properties: {
                    max_iterations: {
                        type: "integer",
                        description: `Maximum iterations before stopping (default ${SELF_IMPROVE_DEFAULTS.max_iterations}, max ${MAX_ALLOWED_ITERATIONS}).`,
                        default: SELF_IMPROVE_DEFAULTS.max_iterations,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                    min_iterations: {
                        type: "integer",
                        description: `Minimum iterations before completion_promise / abort_promise are honored (default ${SELF_IMPROVE_DEFAULTS.min_iterations}; must not exceed max_iterations). Use this to force the agent to run additional verification passes even if it declares completion early.`,
                        default: SELF_IMPROVE_DEFAULTS.min_iterations,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                    focus: {
                        type: "string",
                        description: `Optional focus area appended to the SDLC prompt as "Focus this run on: <focus>". Steers ideation and improvement selection without altering the SDLC stages. Max ${MAX_FOCUS_CHARS} chars.`,
                        minLength: 1,
                        maxLength: MAX_FOCUS_CHARS,
                    },
                    completion_promise: {
                        type: "string",
                        description: `Substring that, when present in an assistant turn's response, signals completion (default '${DEFAULTS.completion_promise}'). The baked SDLC prompt instructs the agent to emit '${DEFAULTS.completion_promise}'; overriding here without also editing the prompt body silently runs the loop to max_iterations. Max ${MAX_PROMISE_CHARS} chars.`,
                        default: DEFAULTS.completion_promise,
                        minLength: 1,
                        maxLength: MAX_PROMISE_CHARS,
                    },
                    abort_promise: {
                        type: "string",
                        description: `Optional substring that, when present in an assistant turn's response, aborts the loop early (the baked SDLC prompt instructs the agent to emit '${BAKED_ABORT_TOKEN}' when no worthwhile improvement exists, but the field has no default — supply this token explicitly to honor the abort signal). Max ${MAX_PROMISE_CHARS} chars.`,
                        minLength: 1,
                        maxLength: MAX_PROMISE_CHARS,
                    },
                    stagnation_limit: {
                        type: "integer",
                        description: `Abort if the assistant returns N consecutive byte-identical responses (default ${DEFAULTS.stagnation_limit}, 0 to disable). Must be 0 or ≥ 2 — the value 1 is rejected at runtime since no comparison is possible after a single response.`,
                        default: DEFAULTS.stagnation_limit,
                        minimum: 0,
                        not: { const: 1 },
                    },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                const notAttached = requireAttachedSession("self_improve");
                if (notAttached) return notAttached;
                const guard = activeLoopGuard();
                if (guard) return guard;
                const bad = validateOptionalArgShape("self_improve", args, SELF_IMPROVE_KEYS);
                if (bad) return bad;
                const a = args ?? {};
                // Validate `focus` independently (the rest is delegated to
                // validateArgs via the constructed prompt below).
                const focusParse = parseFocus(a.focus);
                if (focusParse.error) return failure(focusParse.error);
                const focus = focusParse.value;
                const prompt = focus
                    ? `${PROMPT_SELF_IMPROVE}\n\nFocus this run on: ${focus}`
                    : PROMPT_SELF_IMPROVE;
                // Footgun guard: PROMPT_SELF_IMPROVE bakes in "emit COMPLETE"
                // and "emit ABORT_NO_IMPROVEMENTS" as the literal signal
                // tokens. If the caller overrides completion_promise /
                // abort_promise to anything else, the prompt instructs the
                // agent to emit one token while the runtime watches for
                // another — silently running to max_iterations on an
                // otherwise-successful loop. Emit a single arm-time warning
                // so the mismatch is visible in the timeline. Helper is
                // shared with grow_project; see warnPromiseDrift definition.
                warnPromiseDrift("self_improve", "completion_promise", a.completion_promise, DEFAULTS.completion_promise, "loop may run to max_iterations");
                warnPromiseDrift("self_improve", "abort_promise", a.abort_promise, BAKED_ABORT_TOKEN, "abort signal may never fire");
                const parsed = validateArgs({
                    prompt,
                    max_iterations: a.max_iterations ?? SELF_IMPROVE_DEFAULTS.max_iterations,
                    min_iterations: a.min_iterations ?? SELF_IMPROVE_DEFAULTS.min_iterations,
                    completion_promise: a.completion_promise,
                    abort_promise: a.abort_promise,
                    stagnation_limit: a.stagnation_limit,
                });
                if (parsed.error) {
                    // Re-prefix delegated validateArgs errors so users see
                    // self_improve in the error stream rather than ralph_loop.
                    // Defensive fallback: if a future validateArgs path forgets
                    // the "ralph_loop:" prefix, the regex rewrite would no-op
                    // and leak an un-prefixed error to self_improve callers.
                    // Force a "self_improve:" prefix instead so the tool name
                    // is always present in the error stream.
                    const msg = parsed.error.startsWith("ralph_loop:")
                        ? parsed.error.replace(/^ralph_loop:/, "self_improve:")
                        : `self_improve: ${parsed.error}`;
                    return failure(msg);
                }
                return armLoop(parsed.value, "self_improve");
            },
        },
        {
            name: "grow_project",
            description:
                "Arms ralph_loop with a baked-in SDLC prompt that grows a project from a GitHub-issue backlog (via the `gh` CLI). On the first iter it ideates 5-10 small, well-scoped feature issues; on each subsequent iter it picks one `proposed` issue, ships it end-to-end against a three-part gate (tests green + executable acceptance check + demo invocation), commits with `Closes #N`, and closes the issue. Optional `focus` narrows the run. Only one loop runs per session; cancel with ralph_stop. Returns failure if a ralph_loop, self_improve, or grow_project loop is already active.",
            parameters: {
                type: "object",
                properties: {
                    max_iterations: {
                        type: "integer",
                        description: `Maximum iterations before stopping (default ${GROW_PROJECT_DEFAULTS.max_iterations}, max ${MAX_ALLOWED_ITERATIONS}).`,
                        default: GROW_PROJECT_DEFAULTS.max_iterations,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                    min_iterations: {
                        type: "integer",
                        description: `Minimum iterations before completion_promise / abort_promise are honored (default ${GROW_PROJECT_DEFAULTS.min_iterations}; must not exceed max_iterations). Use this to force the agent to drain a baseline portion of the backlog before honoring an early ABORT_NO_BACKLOG.`,
                        default: GROW_PROJECT_DEFAULTS.min_iterations,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                    focus: {
                        type: "string",
                        description: `Optional focus area appended to the SDLC prompt as "Focus this run on: <focus>". Steers ideation and feature selection without altering the SDLC scaffolding. Max ${MAX_FOCUS_CHARS} chars.`,
                        minLength: 1,
                        maxLength: MAX_FOCUS_CHARS,
                    },
                    completion_promise: {
                        type: "string",
                        description: `Substring that, when present in an assistant turn's response, signals completion (default '${DEFAULTS.completion_promise}'). The baked SDLC prompt instructs the agent to emit '${DEFAULTS.completion_promise}'; overriding here without also editing the prompt body silently runs the loop to max_iterations. Max ${MAX_PROMISE_CHARS} chars.`,
                        default: DEFAULTS.completion_promise,
                        minLength: 1,
                        maxLength: MAX_PROMISE_CHARS,
                    },
                    abort_promise: {
                        type: "string",
                        description: `Optional substring that, when present in an assistant turn's response, aborts the loop early (default '${BAKED_BACKLOG_ABORT_TOKEN}', emitted by the agent when the backlog is drained). Max ${MAX_PROMISE_CHARS} chars.`,
                        default: BAKED_BACKLOG_ABORT_TOKEN,
                        minLength: 1,
                        maxLength: MAX_PROMISE_CHARS,
                    },
                    stagnation_limit: {
                        type: "integer",
                        description: `Abort if the assistant returns N consecutive byte-identical responses (default ${DEFAULTS.stagnation_limit}, 0 to disable). Must be 0 or ≥ 2 — the value 1 is rejected at runtime since no comparison is possible after a single response.`,
                        default: DEFAULTS.stagnation_limit,
                        minimum: 0,
                        not: { const: 1 },
                    },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                const notAttached = requireAttachedSession("grow_project");
                if (notAttached) return notAttached;
                const guard = activeLoopGuard();
                if (guard) return guard;
                const bad = validateOptionalArgShape("grow_project", args, GROW_PROJECT_KEYS);
                if (bad) return bad;
                const a = args ?? {};
                const focusParse = parseFocus(a.focus, "grow_project");
                if (focusParse.error) return failure(focusParse.error);
                const focus = focusParse.value;
                const prompt = focus
                    ? `${PROMPT_GROW_PROJECT}\n\nFocus this run on: ${focus}`
                    : PROMPT_GROW_PROJECT;
                // Same footgun guard as self_improve: PROMPT_GROW_PROJECT
                // bakes in "emit COMPLETE" / "emit ABORT_NO_BACKLOG" as
                // the literal signal tokens. If the caller overrides
                // completion_promise / abort_promise, prompt and runtime
                // watch different tokens — silently running to
                // max_iterations on an otherwise-successful drain. Helper
                // is shared with self_improve; see warnPromiseDrift defn.
                warnPromiseDrift("grow_project", "completion_promise", a.completion_promise, DEFAULTS.completion_promise, "loop may run to max_iterations");
                warnPromiseDrift("grow_project", "abort_promise", a.abort_promise, BAKED_BACKLOG_ABORT_TOKEN, "abort signal may never fire");
                const parsed = validateArgs({
                    prompt,
                    max_iterations: a.max_iterations ?? GROW_PROJECT_DEFAULTS.max_iterations,
                    min_iterations: a.min_iterations ?? GROW_PROJECT_DEFAULTS.min_iterations,
                    completion_promise: a.completion_promise,
                    abort_promise: a.abort_promise ?? BAKED_BACKLOG_ABORT_TOKEN,
                    stagnation_limit: a.stagnation_limit,
                });
                if (parsed.error) {
                    // Re-prefix delegated validateArgs errors so users see
                    // grow_project in the error stream rather than ralph_loop.
                    // Defensive fallback mirroring iter 17 self_improve fix:
                    // force a "grow_project:" prefix even if a future
                    // validateArgs path forgets the ralph_loop: prefix.
                    const msg = parsed.error.startsWith("ralph_loop:")
                        ? parsed.error.replace(/^ralph_loop:/, "grow_project:")
                        : `grow_project: ${parsed.error}`;
                    return failure(msg);
                }
                return armLoop(parsed.value, "grow_project");
            },
        },
    ];
    // Deep-freeze the public tool surface so consumers can't swap handlers
    // or desync declared schema bounds from runtime validation.
    for (const t of tools) deepFreeze(t);
    Object.freeze(tools);

    const hooks = Object.freeze({
        onUserPromptSubmitted: async () => {
            if (!state.lastResult) return;
            const { iterations, reason, note, durationMs, label } = state.lastResult;
            state.lastResult = null;
            // Collapse whitespace so a multi-line note (e.g. an Error stack from
            // send_error) doesn't break the bracketed context line.
            const noteOneLine = collapseNote(note);
            const lbl = label ?? "ralph_loop";
            const ctx = `[${lbl} just finished — iterations=${iterations}, reason=${reason}${noteOneLine ? `, note=${noteOneLine}` : ""}, durationMs=${durationMs}]`;
            log(`${lbl}: injecting post-loop context into next user prompt (reason=${reason}, iterations=${iterations})`);
            return { additionalContext: ctx };
        },
    });

    let currentDetach = null;
    /**
     * Wire the controller to a Copilot CLI session. Subscribes to the three
     * events the controller needs (assistant.message, session.idle, abort).
     * Idempotent: calling attach(s2) after attach(s1) tears down s1's
     * listeners first, so duplicate listeners can never double-count events.
     *
     * @param {object} session - SDK session with .send(message) and .on(event, handler).
     * @returns {() => void} Detach function: unsubscribes all listeners and,
     *   if a loop is currently active on THIS attachment, finishes it with
     *   reason="detached". Stale detaches (superseded by a later attach())
     *   are no-ops against state.
     */
    function attach(session) {
        if (!session || typeof session !== "object") {
            throw new TypeError("ralph: attach(session) requires a session object.");
        }
        // Bundled so adding a third required method (e.g. session.off) stays a one-liner.
        const requireMethod = (name, signature) => {
            if (typeof session[name] !== "function") {
                throw new TypeError(`ralph: attached session is missing required method '${signature}'.`);
            }
        };
        requireMethod("send", "send(message)");
        requireMethod("on", "on(event, handler)");
        // Idempotent re-attach: tear down any existing wiring first so we don't
        // end up with duplicate listeners that double-count every event.
        if (currentDetach) {
            try { currentDetach(); } catch { /* ignore */ }
            currentDetach = null;
        }
        sessionRef = session;
        // Wire the three session events. Subscribing one-at-a-time + tracking
        // unsubs lets us roll back if session.on throws partway through;
        // without rollback the earlier listeners would leak.
        const unsubs = [];
        // Best-effort teardown: swallow per-unsub throws so one buggy listener
        // can't strand the rest. Shared by subscribeOrFail's rollback and detach.
        const unsubscribeAll = () => {
            for (const u of unsubs) {
                try { u(); } catch { /* ignore */ }
            }
        };
        const subscribeOrFail = (evName, handler) => {
            let ret;
            try {
                ret = session.on(evName, handler);
            } catch (err) {
                unsubscribeAll();
                sessionRef = null;
                throw err;
            }
            // Per SDK contract session.on() returns an unsubscribe fn. If we got
            // something else, log the leak — we can't remove the listener on detach.
            if (typeof ret === "function") {
                unsubs.push(ret);
            } else {
                log(`ralph: warning — session.on(${JSON.stringify(evName)}) did not return an unsubscribe function (got ${describeArgType(ret)}); listener may leak on detach.`);
            }
        };
        subscribeOrFail("assistant.message", onAssistantMessage);
        subscribeOrFail("session.idle", onIdle);
        subscribeOrFail("abort", onAbort);
        const detach = () => {
            // If THIS detach is still the current wiring AND a loop is in flight,
            // finish it gracefully. A stale detach (one whose attach() has since
            // been superseded) must NOT touch state.active — that would interrupt
            // the loop running on the newer session.
            const isCurrent = currentDetach === detach;
            if (isCurrent && state.active) finish("detached");
            unsubscribeAll();
            if (isCurrent) currentDetach = null;
            if (sessionRef === session) sessionRef = null;
        };
        currentDetach = detach;
        return detach;
    }

    return {
        tools,
        hooks,
        attach,
        state,
        // Exposed for tests so they can drive events deterministically.
        _internal: { onAssistantMessage, onIdle, onAbort, finish, success, failure },
    };
}

export const __test__ = { DEFAULTS, SELF_IMPROVE_DEFAULTS, GROW_PROJECT_DEFAULTS, MAX_ALLOWED_ITERATIONS, PREVIEW_CHARS, MAX_PROMPT_CHARS, MAX_PROMISE_CHARS, MAX_CONTENT_CHARS, MAX_FOCUS_CHARS, PROMPT_SELF_IMPROVE, PROMPT_GROW_PROJECT, BAKED_ABORT_TOKEN, BAKED_BACKLOG_ABORT_TOKEN, BAKED_COPILOT_TRAILER, BAKED_RALPH_TRAILER, BAKED_ATTRIBUTION_OPT_OUT, BAKED_RALPH_LOOP_RIDER, composeRalphLoopPrompt, previewOf, evaluateAdaptiveSignals, ADAPTIVE_WINDOW };
