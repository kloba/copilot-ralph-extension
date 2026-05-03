// Event contract for the ralph TUI (issue #22).
//
// `ralph-tui run` (`./runner.mjs` + `./events-emit.mjs`) writes one JSON
// object per line to `<runs-root>/<runId>/events.jsonl`. The TUI tails
// that file, parses each line with `parseEventLine()`, and renders the
// resulting state.
//
// Dependency-free (Node stdlib only) so it can be imported by both the
// emit and read sides without dragging Ink/React along.

/**
 * @typedef {(
 *   "armed" |
 *   "iteration_start" |
 *   "iteration_end" |
 *   "pause" |
 *   "resume" |
 *   "stagnation" |
 *   "complete" |
 *   "abort"
 * )} EventType
 */

/**
 * @typedef {Object} LoopEvent
 * @property {EventType} type
 * @property {number} ts            Epoch ms when the event was emitted.
 * @property {string} runId         Stable per-loop identifier (label + startedAt).
 * @property {string} [label]       "ralph_loop" | "self_improve" | "grow_project".
 * @property {number} [iteration]   1-indexed iteration counter.
 * @property {number} [maxIterations]
 * @property {number} [minIterations]
 * @property {string} [reason]      finish() reason on complete/abort.
 * @property {string} [excerpt]     Short response preview for iteration_end.
 * @property {number} [streak]      Stagnation streak length on stagnation events.
 * @property {{input:number, output:number}} [tokens]
 * @property {string} [note]        Free-form trailer (truncated to 500 chars).
 */

/** Hard cap on a single emitted event line, enforced by the writer. */
export const MAX_EVENT_LINE_BYTES = 16 * 1024;

/** Set of recognised event types — used by parseEventLine for validation.
 *
 * Strictly additive: a new event type appends to this list and never
 * reorders / removes existing entries, so historical `events.jsonl`
 * files keep replaying through the latest reader unchanged. The three
 * stage-level types (`stage_start`, `stage_end`, `substage`) plus
 * `backlog_snapshot` were added in slice 1 of issue #48 to enable the
 * 3-level hierarchical TUI (iteration → SDLC stage → sub-stage) and
 * the backlog-pressure header. The `workitem_start` / `workitem_end`
 * pair (issue #48 slice 3) names the L1 work item — the single
 * issue / PR / red-CI run the loop is currently fixing — so the TUI
 * header can render `work item: issue #42 …` and so a replay can
 * compute "(N already closed by loop)" purely from the event stream
 * without re-running `gh`.
 *
 * Slice 9 of issue #48 adds the deeper hierarchy levels:
 *
 * - `stage_plan` — `{ stages: string[] }` emitted on the iter that
 *   generates the per-work-item stage plan. The plan replaces the old
 *   "fixed 9-step SDLC baked into the prompt" model: the agent picks
 *   stages appropriate to the work-item kind (e.g. `REPRO` instead of
 *   `BASELINE` for a red-CI work item) and the runner enforces the
 *   pinned tail (`COMMIT → PUSH → END`) via `enforcePinnedTail()`.
 *   See `PINNED_TAIL_STAGES`.
 * - `stage_plan_amend` — `{ add?, remove?, after?, reason }` emitted
 *   whenever the plan is modified mid-run. Issued by the agent when
 *   it discovers a missing stage AND by the runner when it had to
 *   normalize the agent's plan (`reason: "pinned-tail-enforcement"`).
 *   The TUI surfaces these as growing badges in the Stage-plan row so
 *   the user sees what was added / corrected.
 * - `task_list` — `{ stage, items: string[] }` emitted lazily when
 *   the loop first enters a stage. Each stage on the plan gets a
 *   fresh task list scoped to the current work item.
 * - `task_start` — `{ stage, sub, desc }` emitted when the loop
 *   pops a pending task off the list and starts running it.
 * - `task_end` — `{ stage, sub, outcome, durationMs? }` paired with
 *   `task_start`. `outcome` is one of `TASK_OUTCOMES` (`ok` / `fail`
 *   / `skip`).
 * - `commit_observed` — `{ sha, subject, trailers? }` emitted when
 *   the runner spots a `git commit` substage completing successfully.
 *   Drives the LastCommit footer in the TUI directly off the event
 *   stream so replay fidelity survives `git reset`s after the run. */
export const EVENT_TYPES = Object.freeze([
    "armed",
    "iteration_start",
    "iteration_end",
    "pause",
    "resume",
    "stagnation",
    "complete",
    "abort",
    "stage_start",
    "stage_end",
    "substage",
    "backlog_snapshot",
    "workitem_start",
    "workitem_end",
    "stage_plan",
    "stage_plan_amend",
    "task_list",
    "task_start",
    "task_end",
    "commit_observed",
    "usage_update",
    // Issue #57 / live-output panel — `runner.mjs` emits this once
    // a Copilot CLI session id is captured for the active iter, so
    // the TUI can mount a tail against the per-session log file.
    "session_attached",
    // Issue #66 — per-iter git worktree lifecycle events. Strictly
    // additive (appended at end). `worktree_created` fires before
    // `iteration_start` for each iter that runs in a fresh worktree;
    // `worktree_removed` fires after `[STAGE: END]` when the iter's
    // changes were merged into the base ref; `worktree_kept` fires
    // when the iter ended without its changes being merged (aborted,
    // failed, or the agent didn't push), so the user can inspect
    // the leftover sandbox at the recorded path.
    "worktree_created",
    "worktree_removed",
    "worktree_kept",
]);

/** Recognised L1 work-item kinds — the categorisation used in the
 *  ORIENT scan: an open issue, a stale open PR, or a failing CI run.
 *  `workitem_start` events MUST set `kind` to one of these values; the
 *  serializer rejects anything else so a typo in the runner can't
 *  silently corrupt the L1 column. */
export const WORKITEM_KINDS = Object.freeze(["issue", "pr", "red_ci"]);
const WORKITEM_KIND_SET = new Set(WORKITEM_KINDS);

/** Pinned tail stages — every `stage_plan` MUST end with these three
 *  stages, in this order. The agent generates the per-work-item stage
 *  plan but cannot remove or reorder this tail: a work item always
 *  finishes by committing, pushing, and emitting an END marker that
 *  releases the L1 slot. The runner enforces this contract via
 *  `enforcePinnedTail()` and emits a visible `stage_plan_amend` event
 *  (reason: `pinned-tail-enforcement`) whenever it had to repair the
 *  agent's plan — the issue body explicitly forbids silent rewrites
 *  ("the agent may not silently rewrite the plan; if it discovers a
 *  missing stage … it must emit a `stage_plan_amend` event with a
 *  clear reason"), so the same visibility contract applies when the
 *  enforcer is the runner instead of the agent. */
export const PINNED_TAIL_STAGES = Object.freeze(["COMMIT", "PUSH", "END"]);

/** Recognised outcomes for a `task_end` event — `ok` for a task that
 *  completed normally, `fail` for one that errored out (the loop will
 *  decide whether to retry or skip), `skip` for one the agent
 *  intentionally bypassed (e.g. a duplicate finding under PLAN). The
 *  serializer rejects anything else so a typo in the runner cannot
 *  silently corrupt outcome reporting in the TUI's task pane. */
export const TASK_OUTCOMES = Object.freeze(["ok", "fail", "skip"]);
const TASK_OUTCOME_SET = new Set(TASK_OUTCOMES);

/** Issue #66 — set of per-iter worktree-lifecycle event types. Used
 *  by the serializer / fold / plain renderer to gate path/branch
 *  field validation. Pinned at module scope so a future event type
 *  with an unrelated `path` field can't accidentally pick up the
 *  validation. */
export const WORKTREE_EVENT_TYPES = Object.freeze([
    "worktree_created",
    "worktree_removed",
    "worktree_kept",
]);
const WORKTREE_EVENT_TYPE_SET = new Set(WORKTREE_EVENT_TYPES);

/** Normalize a candidate stage list so the pinned tail (`COMMIT → PUSH
 *  → END`) is always present, in the canonical order, at the end.
 *
 *  Behaviour:
 *  - Strips any pre-existing `COMMIT` / `PUSH` / `END` from anywhere in
 *    the list so a misplaced pinned stage in the middle is not
 *    duplicated at the tail.
 *  - Appends `[COMMIT, PUSH, END]` in that order. Always exactly
 *    three pinned stages at the end.
 *  - Returns a fresh frozen array so callers cannot mutate the result.
 *  - Returns the canonical pinned tail alone when the input is empty
 *    or non-array (defensive: an empty plan still has the closing
 *    rituals).
 *
 *  Provenance: `repaired` is true iff the output differs from the
 *  input as a sequence (case-sensitive). The runner uses this flag to
 *  emit a `stage_plan_amend` event (`reason: "pinned-tail-enforcement"`)
 *  whenever it had to repair the agent's plan, so replay shows
 *  exactly what the agent said vs what the runner enforced.
 *
 *  @param {string[]} stages
 *  @returns {{ stages: readonly string[], repaired: boolean }}
 */
export function enforcePinnedTail(stages) {
    const input = Array.isArray(stages) ? stages.filter((s) => typeof s === "string" && s) : [];
    const pinnedSet = new Set(PINNED_TAIL_STAGES);
    const head = input.filter((s) => !pinnedSet.has(s));
    const out = Object.freeze([...head, ...PINNED_TAIL_STAGES]);

    let repaired = input.length !== out.length;
    if (!repaired) {
        for (let i = 0; i < out.length; i++) {
            if (input[i] !== out[i]) { repaired = true; break; }
        }
    }
    return { stages: out, repaired };
}

/** Canonical SDLC stage list for self_improve, in execution order.
 *
 * The runner's `[STAGE: NAME]` marker parser (slice 4) and the renderer
 * (slice 7) both reference this list so a drift between the prompt
 * body and the consumers of the event stream is impossible. The
 * `grow_project` SDLC has its own stage list in PROMPT_GROW_PROJECT;
 * each loop label maps to its own stage list at parse time. */
export const SDLC_STAGES_SELF_IMPROVE = Object.freeze([
    "ORIENT",
    "IDEATE",
    "CRITIQUE",
    "BASELINE",
    "IMPLEMENT",
    "TEST",
    "COMMIT",
    "PUSH",
    "END",
]);

/** Canonical SDLC stage list for grow_project, in execution order.
 *
 * `IDEATE` is conditional (only when the backlog is empty) and may be
 * skipped — the runner emits no event for a skipped stage rather than
 * inventing a synthetic one. */
export const SDLC_STAGES_GROW_PROJECT = Object.freeze([
    "ORIENT",
    "IDEATE",
    "SELECT",
    "CRITIQUE",
    "BASELINE",
    "IMPLEMENT",
    "TEST",
    "ACCEPTANCE",
    "DEMO",
    "COMMIT",
    "PUSH",
    "CLOSE",
    "END",
]);

/** Map a loop label to its canonical stage list. Returns null for
 *  custom-prompt loops (no stage row rendered). */
export function stagesForLabel(label) {
    if (label === "self_improve") return SDLC_STAGES_SELF_IMPROVE;
    if (label === "grow_project") return SDLC_STAGES_GROW_PROJECT;
    return null;
}

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

/**
 * Build a stable runId from a label + epoch ms. Including the label makes
 * concurrent loops in the same session disambiguate even if their startedAt
 * collides at ms resolution.
 */
export function makeRunId(label, startedAt) {
    if (typeof label !== "string" || !label) {
        throw new TypeError("makeRunId: label must be a non-empty string");
    }
    if (!Number.isFinite(startedAt)) {
        throw new TypeError("makeRunId: startedAt must be a finite number");
    }
    return `${label}-${startedAt}`;
}

/**
 * Truncate `s` to at most `max` characters without splitting a UTF-16
 * surrogate pair. A naïve `s.slice(0, max)` can land between the
 * high+low halves of a 4-byte char (emoji / astral plane) and emit a
 * lone surrogate — technically valid UTF-16 but renders as a
 * replacement glyph in most terminals AND breaks any consumer doing
 * strict UTF-8 validation downstream. When the last kept code unit
 * is a high surrogate (0xD800..0xDBFF), back off by one so the pair
 * stays intact (we drop a single astral char rather than emit a lone
 * half). Mirrors the inline guard in `./events-emit.mjs`'s
 * `clipExcerpt`.
 *
 * Exported so other TUI rendering paths (e.g. `plain.mjs`'s 80-char
 * excerpt cap) can share the same surrogate-safe truncation rather
 * than re-deriving the off-by-one boundary check at every call site.
 *
 * @param {string} s
 * @param {number} max  - non-negative integer; the maximum number of
 *                        UTF-16 code units to retain. Pre-condition:
 *                        finite and >= 1; non-conforming inputs
 *                        return the original string unmodified.
 * @returns {string}
 */
export function safeSliceChars(s, max) {
    if (typeof s !== "string") return s;
    if (!Number.isFinite(max) || max < 1) return s;
    if (s.length <= max) return s;
    const code = s.charCodeAt(max - 1);
    return s.slice(0, code >= 0xD800 && code <= 0xDBFF ? max - 1 : max);
}

/**
 * Serialize a LoopEvent to a single JSONL line (no trailing newline; the
 * writer appends one). Throws if the resulting payload exceeds
 * MAX_EVENT_LINE_BYTES so a runaway `excerpt` can't blow up the events file.
 *
 * Invariants enforced:
 *   - `type` must be a known event kind.
 *   - `ts` and `runId` are required.
 *   - `excerpt`/`note` are truncated to 500 chars (defence in depth; the
 *     writer should already have shortened them).
 */
export function serializeEvent(ev) {
    if (!ev || typeof ev !== "object") {
        throw new TypeError("serializeEvent: event must be an object");
    }
    if (!EVENT_TYPE_SET.has(ev.type)) {
        throw new TypeError(`serializeEvent: unknown event type ${JSON.stringify(ev.type)}`);
    }
    if (!Number.isFinite(ev.ts)) {
        throw new TypeError("serializeEvent: ts must be a finite number");
    }
    if (typeof ev.runId !== "string" || !ev.runId) {
        throw new TypeError("serializeEvent: runId must be a non-empty string");
    }
    const out = { type: ev.type, ts: ev.ts, runId: ev.runId };
    if (ev.label != null) out.label = String(ev.label);
    if (Number.isFinite(ev.iteration)) out.iteration = ev.iteration;
    if (Number.isFinite(ev.maxIterations)) out.maxIterations = ev.maxIterations;
    if (Number.isFinite(ev.minIterations)) out.minIterations = ev.minIterations;
    // Cap `reason` at 500 chars (surrogate-safely) for symmetry with
    // `note` and `excerpt`. Baked-token reasons (`completion_promise`,
    // `abort_promise`, `stagnation`, `max_iterations`, `send_error`, …)
    // are all under 30 chars; the serializer cap is defensive so a
    // future code path that emits a `reason` without going through a
    // hygiene helper can't bloat events.jsonl past the 16 KB per-line
    // ceiling on a single pathological input.
    if (typeof ev.reason === "string") out.reason = safeSliceChars(ev.reason, 500);
    if (typeof ev.excerpt === "string") out.excerpt = safeSliceChars(ev.excerpt, 500);
    if (Number.isFinite(ev.streak)) out.streak = ev.streak;
    if (ev.tokens && typeof ev.tokens === "object") {
        const input = Number.isFinite(ev.tokens.input) ? ev.tokens.input : 0;
        const output = Number.isFinite(ev.tokens.output) ? ev.tokens.output : 0;
        out.tokens = { input, output };
    }
    // `premiumRequests` is a cumulative-for-the-run counter emitted on
    // `iteration_end` (post-iter reconciled) and on each `usage_update`
    // (live, mid-iter). Reject NaN / Infinity / negative values rather
    // than coercing to 0 so a runner bug surfaces instead of silently
    // resetting the displayed counter mid-run. The runner clamps at
    // emit time too, but a defensive serializer means a third-party
    // event source can't poison the stream.
    if (Number.isFinite(ev.premiumRequests) && ev.premiumRequests >= 0) {
        out.premiumRequests = ev.premiumRequests;
    }
    // Per-iter file-change count (committed delta + uncommitted
    // churn). Strictly opt-in: emitted only when finite and
    // non-negative so a missing field on old runs renders dim (`—`)
    // in the Timeline rather than `0` (which would be a lie).
    if (Number.isFinite(ev.filesChanged) && ev.filesChanged >= 0) {
        out.filesChanged = ev.filesChanged;
    }
    if (typeof ev.note === "string") out.note = safeSliceChars(ev.note, 500);

    // Stage-level fields (issue #48 slice 1). Strictly opt-in: only
    // appear on event objects whose type set them, so a plain
    // iteration_end roundtrip is unchanged.
    if (Number.isFinite(ev.stage)) out.stage = ev.stage;
    if (typeof ev.stageName === "string" && ev.stageName) {
        // Cap at 64 chars — well above any baked stage name (longest is
        // `IMPLEMENT` at 9) but loose enough for a future custom-prompt
        // mode that names stages descriptively.
        out.stageName = safeSliceChars(ev.stageName, 64);
    }
    if (Number.isFinite(ev.sub)) out.sub = ev.sub;
    if (typeof ev.verb === "string" && ev.verb) {
        out.verb = safeSliceChars(ev.verb, 32);
    }
    if (typeof ev.argsSummary === "string") {
        out.argsSummary = safeSliceChars(ev.argsSummary, 500);
    }
    if (typeof ev.outcome === "string" && ev.outcome) {
        out.outcome = safeSliceChars(ev.outcome, 32);
    }
    if (Number.isFinite(ev.durationMs)) out.durationMs = ev.durationMs;
    // Backlog snapshot fields. All optional — the writer emits whatever
    // probes returned; missing fields render as `?` in the TUI rather
    // than silently zeroing.
    if (Number.isFinite(ev.redCi)) out.redCi = ev.redCi;
    if (Number.isFinite(ev.openPrs)) out.openPrs = ev.openPrs;
    if (Number.isFinite(ev.openIssues)) out.openIssues = ev.openIssues;
    if (Number.isFinite(ev.closedByLoop)) out.closedByLoop = ev.closedByLoop;

    // Work-item fields (issue #48 slice 3). `kind` is validated against
    // WORKITEM_KIND_SET only when the event type is workitem_start /
    // workitem_end so a future event type can reuse the field name
    // without inheriting the validation. Required on workitem_start —
    // we throw if missing, matching the strictness of `runId` / `ts`.
    if (ev.type === "workitem_start" || ev.type === "workitem_end") {
        if (!WORKITEM_KIND_SET.has(ev.kind)) {
            throw new TypeError(
                `serializeEvent: ${ev.type} requires kind in ${JSON.stringify(WORKITEM_KINDS)} ` +
                `(got ${JSON.stringify(ev.kind)})`,
            );
        }
        out.kind = ev.kind;
        if (Number.isFinite(ev.ref)) out.ref = ev.ref;
        if (typeof ev.title === "string" && ev.title) {
            // Cap at 200 chars — issue / PR titles can be long but the
            // TUI header truncates at ~80 visible chars anyway and the
            // event-line ceiling is 16 KB. 200 leaves headroom for
            // emoji-heavy titles without bloating events.jsonl.
            out.title = safeSliceChars(ev.title, 200);
        }
    }
    if (Number.isFinite(ev.closesN)) out.closesN = ev.closesN;

    // Stage-plan / task / commit-observed fields (issue #48 slice 9).
    // All gated on event type so an unrelated event with a `stages`
    // field (none today) cannot accidentally pick up the validation.
    if (ev.type === "stage_plan") {
        if (!Array.isArray(ev.stages) || ev.stages.length === 0) {
            throw new TypeError(
                "serializeEvent: stage_plan requires non-empty stages[] of strings",
            );
        }
        // Each stage is capped at 64 chars (matching `stageName`); the
        // whole plan is capped at 64 entries so a malformed agent
        // output that emits `[STAGE_PLAN: …100 stages…]` cannot blow
        // past the per-line ceiling. 64 stages is well above any real
        // SDLC the agent would emit (default skeleton is 6 stages;
        // even an aggressively expanded plan tops out under 20).
        const stages = [];
        for (const s of ev.stages) {
            if (typeof s !== "string" || !s) continue;
            stages.push(safeSliceChars(s, 64));
            if (stages.length >= 64) break;
        }
        if (stages.length === 0) {
            throw new TypeError(
                "serializeEvent: stage_plan requires at least one non-empty string stage",
            );
        }
        out.stages = stages;
    }
    if (ev.type === "stage_plan_amend") {
        // amend events MUST set at least one of `add` / `remove` so a
        // no-op amendment cannot bloat the stream. `reason` is also
        // required: the issue body explicitly says amendments must
        // surface a clear reason for replay.
        const hasAdd = typeof ev.add === "string" && ev.add;
        const hasRemove = typeof ev.remove === "string" && ev.remove;
        if (!hasAdd && !hasRemove) {
            throw new TypeError(
                "serializeEvent: stage_plan_amend requires at least one of add/remove",
            );
        }
        if (typeof ev.reason !== "string" || !ev.reason) {
            throw new TypeError(
                "serializeEvent: stage_plan_amend requires a non-empty reason",
            );
        }
        if (hasAdd) out.add = safeSliceChars(ev.add, 64);
        if (hasRemove) out.remove = safeSliceChars(ev.remove, 64);
        if (typeof ev.after === "string" && ev.after) out.after = safeSliceChars(ev.after, 64);
        // `reason` already serialized above (line ~219) via the shared
        // 500-char cap, so it's already in `out`.
    }
    if (ev.type === "task_list") {
        if (typeof ev.stage !== "string" || !ev.stage) {
            throw new TypeError("serializeEvent: task_list requires a non-empty stage name");
        }
        if (!Array.isArray(ev.items)) {
            throw new TypeError("serializeEvent: task_list requires items[] (may be empty)");
        }
        out.stage = safeSliceChars(ev.stage, 64);
        const items = [];
        for (const it of ev.items) {
            if (typeof it !== "string") continue;
            // Tasks are short imperative descriptions; cap at 200
            // chars. Empty strings are filtered out so an off-by-one
            // in the agent's marker emission can't poison the list.
            const capped = safeSliceChars(it, 200);
            if (capped) items.push(capped);
            if (items.length >= 64) break;
        }
        out.items = items;
    }
    if (ev.type === "task_start" || ev.type === "task_end") {
        if (typeof ev.stage !== "string" || !ev.stage) {
            throw new TypeError(`serializeEvent: ${ev.type} requires a non-empty stage name`);
        }
        if (!Number.isFinite(ev.sub) || ev.sub < 1) {
            throw new TypeError(`serializeEvent: ${ev.type} requires sub >= 1`);
        }
        out.stage = safeSliceChars(ev.stage, 64);
        out.sub = ev.sub;
        if (ev.type === "task_start") {
            if (typeof ev.desc !== "string" || !ev.desc) {
                throw new TypeError("serializeEvent: task_start requires a non-empty desc");
            }
            out.desc = safeSliceChars(ev.desc, 500);
        }
        if (ev.type === "task_end") {
            if (!TASK_OUTCOME_SET.has(ev.outcome)) {
                throw new TypeError(
                    `serializeEvent: task_end requires outcome in ${JSON.stringify(TASK_OUTCOMES)} ` +
                    `(got ${JSON.stringify(ev.outcome)})`,
                );
            }
            out.outcome = ev.outcome;
            if (Number.isFinite(ev.durationMs)) out.durationMs = ev.durationMs;
        }
    }
    if (ev.type === "commit_observed") {
        if (typeof ev.sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(ev.sha)) {
            throw new TypeError(
                "serializeEvent: commit_observed requires sha matching [0-9a-f]{7,40}",
            );
        }
        if (typeof ev.subject !== "string" || !ev.subject) {
            throw new TypeError("serializeEvent: commit_observed requires a non-empty subject");
        }
        out.sha = ev.sha.toLowerCase();
        out.subject = safeSliceChars(ev.subject, 200);
        if (Array.isArray(ev.trailers)) {
            // Each trailer is a short `Key: value` string; cap each at
            // 200 chars and the whole list at 8 entries so a runaway
            // agent commit message with dozens of co-author trailers
            // cannot bloat the event line.
            const trailers = [];
            for (const t of ev.trailers) {
                if (typeof t !== "string" || !t) continue;
                trailers.push(safeSliceChars(t, 200));
                if (trailers.length >= 8) break;
            }
            if (trailers.length) out.trailers = trailers;
        }
    }

    // Issue #57 / live-output panel — `session_attached` carries the
    // Copilot CLI session id (an opaque uuid-like string from the
    // child JSONL stream's terminal `result` event) so the TUI can
    // mount a tail against ~/.copilot/session-state/<sessionId>.jsonl.
    // Gated on the event type so other events cannot accidentally
    // pick up the field. Required on this event type — we throw if
    // missing, matching the strictness of `runId` / `ts`. Capped at
    // 64 chars (Copilot CLI session ids are ~36-char uuids; the cap
    // is a defensive belt-and-suspenders against a malformed
    // upstream value).
    if (ev.type === "session_attached") {
        if (typeof ev.sessionId !== "string" || !ev.sessionId) {
            throw new TypeError(
                "serializeEvent: session_attached requires a non-empty sessionId string",
            );
        }
        out.sessionId = safeSliceChars(ev.sessionId, 64);
    }

    // Issue #66 — per-iter git worktree lifecycle events. All three
    // share a `path` (capped at 1024 chars; well above any real
    // `$RALPH_TUI_RUNS_DIR/<runId>/worktrees/iter-<N>/`) and a
    // `branch` (capped at 200 chars; canonical `autopilot/<runId>/
    // iter-<N>` is ~60 chars). `worktree_created` carries `baseRef`
    // so replay can audit which ref the iter forked from.
    if (WORKTREE_EVENT_TYPE_SET.has(ev.type)) {
        if (typeof ev.path !== "string" || !ev.path) {
            throw new TypeError(
                `serializeEvent: ${ev.type} requires a non-empty path string`,
            );
        }
        if (typeof ev.branch !== "string" || !ev.branch) {
            throw new TypeError(
                `serializeEvent: ${ev.type} requires a non-empty branch string`,
            );
        }
        out.path = safeSliceChars(ev.path, 1024);
        out.branch = safeSliceChars(ev.branch, 200);
        if (ev.type === "worktree_created" && typeof ev.baseRef === "string" && ev.baseRef) {
            out.baseRef = safeSliceChars(ev.baseRef, 200);
        }
    }

    const line = JSON.stringify(out);
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
        throw new RangeError(
            `serializeEvent: line exceeds ${MAX_EVENT_LINE_BYTES} bytes (got ${Buffer.byteLength(line, "utf8")})`,
        );
    }
    return line;
}

/**
 * Parse a single JSONL line into a LoopEvent, returning null on any
 * recoverable error (malformed JSON, missing required field, unknown type).
 *
 * Returning null rather than throwing matches the TUI's tail-and-render
 * loop: a corrupt line should be silently skipped, not crash the UI.
 * Catastrophic problems (non-string input) still throw.
 */
export function parseEventLine(line) {
    if (typeof line !== "string") {
        throw new TypeError("parseEventLine: line must be a string");
    }
    const trimmed = line.trim();
    if (!trimmed) return null;
    let obj;
    try {
        obj = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (!obj || typeof obj !== "object") return null;
    if (!EVENT_TYPE_SET.has(obj.type)) return null;
    if (!Number.isFinite(obj.ts)) return null;
    if (typeof obj.runId !== "string" || !obj.runId) return null;
    return obj;
}

/**
 * Build the initial snapshot literal used as the seed for an
 * event-by-event fold. Exported so consumers (the TUI App) can hold a
 * mutable snapshot in a ref and apply `foldEvent` incrementally
 * instead of allocating a fresh snapshot per render — that pattern
 * blew the heap during long `--self-improve --min 100` runs because
 * `foldEvents(events)` was O(n) per render with `events` growing
 * unboundedly (issue #115 / OOM repro).
 *
 * Pure / deterministic: every call returns a brand-new object graph
 * so callers can safely mutate the result without aliasing across
 * mounts.
 */
export function createInitialSnapshot() {
    /** @type {{
     *   runId: string|null,
     *   label: string|null,
     *   status: "idle"|"running"|"paused"|"complete"|"aborted",
     *   iteration: number,
     *   maxIterations: number|null,
     *   minIterations: number|null,
     *   stagnationStreak: number,
     *   reason: string|null,
     *   tokens: {input:number, output:number},
     *   lastExcerpt: string|null,
     *   startedAt: number|null,
     *   updatedAt: number|null,
     *   terminalAt: number|null,
     *   iterations: Array<{iteration:number, startedAt:number, endedAt:number|null, excerpt:string|null}>,
     *   activeStage: {stage:number, name:string, startedAt:number}|null,
     *   recentStages: Array<{stage:number, name:string, startedAt:number, endedAt:number|null, durationMs:number|null, outcome:string|null}>,
     *   currentStageSubstages: Array<{sub:number, ts:number, verb:string|null, argsSummary:string|null, outcome:string|null, durationMs:number|null}>,
     *   backlog: {redCi:number|null, openPrs:number|null, openIssues:number|null, closedByLoop:number|null}|null,
     *   activeWorkItem: {kind:string, ref:number|null, title:string|null, startedAt:number}|null,
     *   completedWorkItems: Array<{kind:string, ref:number|null, title:string|null, startedAt:number|null, endedAt:number, closesN:number|null}>,
     *   closedByLoop: number,
     *   currentPlan: {stages: string[], setAt: number}|null,
     *   planAmendments: Array<{add:string|null, remove:string|null, after:string|null, reason:string, ts:number}>,
     *   currentTaskList: {stage: string, items: string[], setAt: number}|null,
     *   taskInFlight: {stage: string, sub: number, desc: string, startedAt: number}|null,
     *   recentTasks: Array<{stage: string, sub: number, desc: string|null, outcome: string, durationMs: number|null, startedAt: number|null, endedAt: number}>,
     *   lastCommit: {sha: string, subject: string, trailers: string[], ts: number}|null,
     * }} */
    const snap = {
        runId: null,
        label: null,
        status: "idle",
        iteration: 0,
        maxIterations: null,
        minIterations: null,
        stagnationStreak: 0,
        reason: null,
        tokens: { input: 0, output: 0 },
        // Cumulative-for-the-run Copilot premium-request count. `null`
        // means "no data yet" — the TUI Header hides the counter in
        // that state rather than rendering `premium 0`. First credible
        // value comes from a `usage_update` (mid-iter) or
        // `iteration_end` event the runner emits.
        premiumRequests: null,
        lastExcerpt: null,
        startedAt: null,
        updatedAt: null,
        // TUI elapsed-clock display: pin the wallclock ts of the
        // `complete` / `abort` event so the Header's elapsed
        // counter freezes at the run's actual end ts rather than
        // tracking `updatedAt` (which would shift if a late /
        // replayed event arrived after termination). Stays null
        // until a terminal event fires; resets on `armed` for
        // multi-run replays.
        terminalAt: null,
        // Issue #57 / live-output panel — Copilot CLI session id
        // captured by `runner.mjs` from the active iter's terminal
        // `result.sessionId`. Surfaced through a `session_attached`
        // event. Null until the runner emits one (older runs
        // without the event, or pre-iter-1 frames). The TUI mounts
        // tailSessionFile() against
        // `~/.copilot/session-state/<sessionId>.jsonl` once this
        // value is known.
        sessionId: null,
        iterations: [],
        activeStage: null,
        recentStages: [],
        currentStageSubstages: [],
        backlog: null,
        // Issue #48 slice 3 — L1 work-item tracking. activeWorkItem is
        // the unit currently being addressed (one issue / PR / red CI
        // run); it nulls out at workitem_end. completedWorkItems is
        // the run-local log of finished L1 units, used by the renderer
        // to render the "(N of M backlog already done)" pip in the
        // header. closedByLoop is the number of completed work items
        // that emitted a `closesN` (i.e. closed an issue), derived
        // strictly from workitem_end events — kept separate from
        // backlog.closedByLoop (the runner's snapshot value) so the
        // two cannot drift.
        activeWorkItem: null,
        completedWorkItems: [],
        closedByLoop: 0,
        // Issue #48 slice 9 — L2 stage plan + L2.5 task list + L3
        // task-in-flight cursor + LastCommit footer source.
        // currentPlan tracks the agent-emitted stage plan for the
        // active L1 work item; nulls out at workitem_start (each
        // work item gets a fresh plan). planAmendments accumulates
        // every stage_plan_amend the run has seen, used by the TUI
        // to render `+ added` / `- removed` badges in the Stage-plan
        // row. currentTaskList tracks the L2.5 list for the active
        // stage; nulls out at stage_start (each stage has a fresh
        // task list). taskInFlight names the L3 task currently
        // running; nulls out at task_end. recentTasks is the
        // run-local log of finished L3 tasks the TUI surfaces under
        // the Tasks pane. lastCommit is fed strictly by
        // commit_observed events so replay fidelity survives a
        // post-run `git reset` — `git log -1` is NOT consulted.
        currentPlan: null,
        planAmendments: [],
        currentTaskList: null,
        taskInFlight: null,
        recentTasks: [],
        lastCommit: null,
        // Issue #66 — per-iter git worktree state for the LastCommit /
        // DetailPane row. `activeWorktree` tracks the in-flight iter's
        // sandbox path / branch / baseRef; nulls out on
        // `worktree_removed` (merged + cleaned up). `keptWorktrees`
        // is the run-local log of preserved sandboxes — each
        // `worktree_kept` event appends an entry so the TUI can show
        // "kept N: <path>" lines below the active row.
        activeWorktree: null,
        keptWorktrees: [],
    };
    return snap;
}

/**
 * Apply a single LoopEvent to a snapshot in-place. Returns `snap` for
 * convenience so callers can chain. Used by the TUI App for
 * incremental folding (one event at a time as the tail emits) AND by
 * `foldEvents` below for batch replay — both paths share semantics
 * exactly.
 *
 * Pre-iter-115 the App re-ran `foldEvents(allEvents)` from scratch on
 * every render, which kept O(n) work per event AND retained every
 * raw event for the whole run lifetime. A long `--self-improve --min
 * 100` run would push that array into the tens of thousands of
 * entries (each `usage_update` event during streaming) and the
 * ensuing allocation churn killed the heap. The split lets the TUI
 * keep the snapshot in a `useRef` and apply each new event to the
 * existing object, dropping the raw event afterwards.
 *
 * Defensive against junk: ignores non-object inputs, unknown event
 * types fall through the switch's `default`, and individual case
 * bodies validate their fields the same way the batch fold did.
 */
export function foldEvent(snap, ev) {
    if (!ev || typeof ev !== "object") return snap;
    snap.updatedAt = Number.isFinite(ev.ts) ? ev.ts : snap.updatedAt;
    switch (ev.type) {
        case "armed":
            snap.runId = ev.runId;
            snap.label = ev.label ?? snap.label;
            snap.status = "running";
            snap.iteration = 0;
            snap.maxIterations = ev.maxIterations ?? snap.maxIterations;
            snap.minIterations = ev.minIterations ?? snap.minIterations;
            snap.stagnationStreak = 0;
            snap.reason = null;
            snap.tokens = { input: 0, output: 0 };
            snap.premiumRequests = null;
            snap.lastExcerpt = null;
            snap.startedAt = ev.ts;
            snap.terminalAt = null;
            // Issue #57 — a re-armed run produces a fresh sessionId
            // (or none yet). Reset so the previous run's value
            // doesn't bleed into the new one's first frames.
            snap.sessionId = null;
            snap.iterations = [];
            snap.activeStage = null;
            snap.recentStages = [];
            snap.currentStageSubstages = [];
            snap.backlog = null;
            snap.activeWorkItem = null;
            snap.completedWorkItems = [];
            snap.closedByLoop = 0;
            snap.currentPlan = null;
            snap.planAmendments = [];
            snap.currentTaskList = null;
            snap.taskInFlight = null;
            snap.recentTasks = [];
            snap.lastCommit = null;
            snap.activeWorktree = null;
            snap.keptWorktrees = [];
            break;
        case "iteration_start":
            if (Number.isFinite(ev.iteration)) {
                snap.iteration = ev.iteration;
                snap.iterations.push({
                    iteration: ev.iteration,
                    startedAt: ev.ts,
                    endedAt: null,
                    excerpt: null,
                    // Snapshot cumulative-for-the-run counters at
                    // iter open so the Timeline can derive
                    // per-iter deltas (tokens, premium). The
                    // `filesChanged` field is set later on
                    // `iteration_end`.
                    tokensAtStart: { ...snap.tokens },
                    premiumAtStart: snap.premiumRequests,
                });
            }
            snap.status = "running";
            // A fresh iteration starts with no active stage and an
            // empty per-iter stage history. The active loop loops
            // over its SDLC stages from the top each iter, so the
            // header's "Stages — iter N" pane is per-iter.
            snap.activeStage = null;
            snap.recentStages = [];
            snap.currentStageSubstages = [];
            break;
        case "iteration_end": {
            const last = snap.iterations[snap.iterations.length - 1];
            if (last && (!Number.isFinite(ev.iteration) || last.iteration === ev.iteration)) {
                last.endedAt = ev.ts;
                if (typeof ev.excerpt === "string") last.excerpt = ev.excerpt;
                // Strictly opt-in: missing on old runs leaves
                // the iter without a `filesChanged` field so
                // the Timeline cell stays hidden (replay-safe).
                if (Number.isFinite(ev.filesChanged) && ev.filesChanged >= 0) {
                    last.filesChanged = ev.filesChanged;
                }
            }
            if (typeof ev.excerpt === "string") snap.lastExcerpt = ev.excerpt;
            if (ev.tokens) {
                snap.tokens = {
                    input: Number.isFinite(ev.tokens.input) ? ev.tokens.input : snap.tokens.input,
                    output: Number.isFinite(ev.tokens.output) ? ev.tokens.output : snap.tokens.output,
                };
            }
            if (Number.isFinite(ev.premiumRequests) && ev.premiumRequests >= 0) {
                snap.premiumRequests = ev.premiumRequests;
            }
            break;
        }
        // Live mid-iter usage update emitted by the runner whenever
        // a root-agent `assistant.message` (per-message
        // outputTokens delta) or terminal `result` (premiumRequests
        // for that iter) lands. Carries cumulative-for-the-run
        // totals so the TUI Header snapshot updates
        // within seconds of agent output rather than waiting for
        // `iteration_end` at iter close.
        case "usage_update": {
            if (ev.tokens) {
                snap.tokens = {
                    input: Number.isFinite(ev.tokens.input) ? ev.tokens.input : snap.tokens.input,
                    output: Number.isFinite(ev.tokens.output) ? ev.tokens.output : snap.tokens.output,
                };
            }
            if (Number.isFinite(ev.premiumRequests) && ev.premiumRequests >= 0) {
                snap.premiumRequests = ev.premiumRequests;
            }
            // Issue #54 slice 2a — live Timeline excerpt. The
            // runner streams root-agent `assistant.message`
            // content into `usage_update` events whenever 80+
            // new chars accumulate so the in-flight iter row
            // shows live progress instead of `(working…)`. Both
            // `snap.lastExcerpt` (run-scope) and
            // `iterations[last].excerpt` (per-iter) are updated
            // together, gated by the same `endedAt == null` +
            // iter-match check so a late event landing after
            // `iteration_end` (e.g. delayed delivery during the
            // iter rollover) cannot regress either surface to a
            // stale value. The closed iter's excerpt stays as
            // the canonical post-iter reduction wrote it, and
            // lastExcerpt stays on the most-recent observed
            // iter — preserving Detail/Timeline parity.
            if (typeof ev.excerpt === "string" && ev.excerpt) {
                const last = snap.iterations[snap.iterations.length - 1];
                if (
                    last
                    && last.endedAt == null
                    && (!Number.isFinite(ev.iteration) || last.iteration === ev.iteration)
                ) {
                    last.excerpt = ev.excerpt;
                    snap.lastExcerpt = ev.excerpt;
                }
            }
            break;
        }
        case "pause":
            snap.status = "paused";
            break;
        case "resume":
            snap.status = "running";
            break;
        case "stagnation":
            if (Number.isFinite(ev.streak)) snap.stagnationStreak = ev.streak;
            break;
        case "complete":
            snap.status = "complete";
            snap.reason = ev.reason ?? snap.reason;
            if (Number.isFinite(ev.ts)) snap.terminalAt = ev.ts;
            break;
        case "abort":
            snap.status = "aborted";
            snap.reason = ev.reason ?? snap.reason;
            if (Number.isFinite(ev.ts)) snap.terminalAt = ev.ts;
            break;
        case "stage_start": {
            if (!Number.isFinite(ev.stage)) break;
            const name = typeof ev.stageName === "string" && ev.stageName
                ? ev.stageName : `STAGE_${ev.stage}`;
            snap.activeStage = { stage: ev.stage, name, startedAt: ev.ts };
            snap.currentStageSubstages = [];
            // Each L2 stage has its own L2.5 task list — null it
            // out so a stale list from the previous stage cannot
            // bleed into the new one. taskInFlight follows: a
            // task that was running when the stage ended is no
            // longer "in flight" once the new stage begins.
            snap.currentTaskList = null;
            snap.taskInFlight = null;
            break;
        }
        case "stage_end": {
            if (!Number.isFinite(ev.stage)) break;
            const name = typeof ev.stageName === "string" && ev.stageName
                ? ev.stageName
                : (snap.activeStage && snap.activeStage.stage === ev.stage
                    ? snap.activeStage.name : `STAGE_${ev.stage}`);
            const startedAt = snap.activeStage && snap.activeStage.stage === ev.stage
                ? snap.activeStage.startedAt : null;
            const durationMs = Number.isFinite(ev.durationMs)
                ? ev.durationMs
                : (Number.isFinite(startedAt) && Number.isFinite(ev.ts)
                    ? ev.ts - startedAt : null);
            snap.recentStages.push({
                stage: ev.stage,
                name,
                startedAt,
                endedAt: ev.ts,
                durationMs,
                outcome: typeof ev.outcome === "string" ? ev.outcome : null,
            });
            if (snap.activeStage && snap.activeStage.stage === ev.stage) {
                snap.activeStage = null;
            }
            break;
        }
        case "substage": {
            if (!Number.isFinite(ev.sub)) break;
            snap.currentStageSubstages.push({
                sub: ev.sub,
                ts: ev.ts,
                verb: typeof ev.verb === "string" ? ev.verb : null,
                argsSummary: typeof ev.argsSummary === "string" ? ev.argsSummary : null,
                outcome: typeof ev.outcome === "string" ? ev.outcome : null,
                durationMs: Number.isFinite(ev.durationMs) ? ev.durationMs : null,
            });
            break;
        }
        case "backlog_snapshot": {
            // Replace whole-record so "absent field on later event"
            // doesn't accidentally forget a value the older event
            // had — the runner is the source of truth and emits
            // every field it managed to capture.
            snap.backlog = {
                redCi: Number.isFinite(ev.redCi) ? ev.redCi : null,
                openPrs: Number.isFinite(ev.openPrs) ? ev.openPrs : null,
                openIssues: Number.isFinite(ev.openIssues) ? ev.openIssues : null,
                closedByLoop: Number.isFinite(ev.closedByLoop) ? ev.closedByLoop : null,
            };
            break;
        }
        case "workitem_start": {
            if (!WORKITEM_KIND_SET.has(ev.kind)) break;
            snap.activeWorkItem = {
                kind: ev.kind,
                ref: Number.isFinite(ev.ref) ? ev.ref : null,
                title: typeof ev.title === "string" && ev.title ? ev.title : null,
                startedAt: ev.ts,
            };
            // Each L1 work item gets a fresh plan + task list.
            // Reset the L2/L2.5/L3 cursor so the new work item
            // doesn't inherit the previous work item's stages or
            // tasks (the issue body says the agent generates a
            // *per-work-item* stage plan).
            snap.currentPlan = null;
            snap.currentTaskList = null;
            snap.taskInFlight = null;
            break;
        }
        case "workitem_end": {
            if (!WORKITEM_KIND_SET.has(ev.kind)) break;
            // Match the closing event to the active item by (kind, ref)
            // when a ref is present; otherwise fall back to the active
            // item's identity. A workitem_end with no preceding
            // workitem_start (replay started mid-run) still appends to
            // completedWorkItems so the renderer's count stays right —
            // we just have no startedAt to record.
            const startedAt = snap.activeWorkItem
                && snap.activeWorkItem.kind === ev.kind
                && (
                    (Number.isFinite(ev.ref) && snap.activeWorkItem.ref === ev.ref)
                    || !Number.isFinite(ev.ref)
                )
                ? snap.activeWorkItem.startedAt
                : null;
            const title = typeof ev.title === "string" && ev.title
                ? ev.title
                : (snap.activeWorkItem && startedAt !== null ? snap.activeWorkItem.title : null);
            const closesN = Number.isFinite(ev.closesN) ? ev.closesN : null;
            snap.completedWorkItems.push({
                kind: ev.kind,
                ref: Number.isFinite(ev.ref) ? ev.ref : null,
                title,
                startedAt,
                endedAt: ev.ts,
                closesN,
            });
            if (closesN !== null) snap.closedByLoop += 1;
            if (
                snap.activeWorkItem
                && snap.activeWorkItem.kind === ev.kind
                && (
                    (Number.isFinite(ev.ref) && snap.activeWorkItem.ref === ev.ref)
                    || !Number.isFinite(ev.ref)
                )
            ) {
                snap.activeWorkItem = null;
            }
            break;
        }
        case "stage_plan": {
            if (!Array.isArray(ev.stages) || ev.stages.length === 0) break;
            const stages = ev.stages
                .filter((s) => typeof s === "string" && s)
                .map(String);
            if (stages.length === 0) break;
            snap.currentPlan = { stages, setAt: ev.ts };
            break;
        }
        case "stage_plan_amend": {
            const hasAdd = typeof ev.add === "string" && ev.add;
            const hasRemove = typeof ev.remove === "string" && ev.remove;
            if (!hasAdd && !hasRemove) break;
            const amendment = {
                add: hasAdd ? ev.add : null,
                remove: hasRemove ? ev.remove : null,
                after: typeof ev.after === "string" && ev.after ? ev.after : null,
                reason: typeof ev.reason === "string" ? ev.reason : "",
                ts: ev.ts,
            };
            snap.planAmendments.push(amendment);
            // Apply the amendment to the current plan so the
            // renderer can show the up-to-date plan + the badge
            // history side by side. Insert-after semantics: when
            // `after` is provided, splice the new stage right
            // after that anchor; otherwise append to the tail.
            if (snap.currentPlan) {
                const next = [...snap.currentPlan.stages];
                if (hasRemove) {
                    const idx = next.indexOf(ev.remove);
                    if (idx !== -1) next.splice(idx, 1);
                }
                if (hasAdd) {
                    let insertAt = next.length;
                    if (amendment.after) {
                        const anchor = next.indexOf(amendment.after);
                        if (anchor !== -1) insertAt = anchor + 1;
                    }
                    next.splice(insertAt, 0, ev.add);
                }
                snap.currentPlan = { stages: next, setAt: ev.ts };
            }
            break;
        }
        case "task_list": {
            if (typeof ev.stage !== "string" || !ev.stage) break;
            if (!Array.isArray(ev.items)) break;
            const items = ev.items.filter((s) => typeof s === "string" && s);
            snap.currentTaskList = { stage: ev.stage, items, setAt: ev.ts };
            break;
        }
        case "task_start": {
            if (typeof ev.stage !== "string" || !ev.stage) break;
            if (!Number.isFinite(ev.sub)) break;
            snap.taskInFlight = {
                stage: ev.stage,
                sub: ev.sub,
                desc: typeof ev.desc === "string" ? ev.desc : "",
                startedAt: ev.ts,
            };
            break;
        }
        case "task_end": {
            if (typeof ev.stage !== "string" || !ev.stage) break;
            if (!Number.isFinite(ev.sub)) break;
            if (!TASK_OUTCOME_SET.has(ev.outcome)) break;
            const startedAt = snap.taskInFlight
                && snap.taskInFlight.stage === ev.stage
                && snap.taskInFlight.sub === ev.sub
                ? snap.taskInFlight.startedAt
                : null;
            const desc = snap.taskInFlight
                && snap.taskInFlight.stage === ev.stage
                && snap.taskInFlight.sub === ev.sub
                ? snap.taskInFlight.desc
                : null;
            const durationMs = Number.isFinite(ev.durationMs)
                ? ev.durationMs
                : (startedAt !== null && Number.isFinite(ev.ts) ? ev.ts - startedAt : null);
            snap.recentTasks.push({
                stage: ev.stage,
                sub: ev.sub,
                desc,
                outcome: ev.outcome,
                durationMs,
                startedAt,
                endedAt: ev.ts,
            });
            if (
                snap.taskInFlight
                && snap.taskInFlight.stage === ev.stage
                && snap.taskInFlight.sub === ev.sub
            ) {
                snap.taskInFlight = null;
            }
            break;
        }
        case "commit_observed": {
            if (typeof ev.sha !== "string" || !ev.sha) break;
            if (typeof ev.subject !== "string" || !ev.subject) break;
            snap.lastCommit = {
                sha: ev.sha,
                subject: ev.subject,
                trailers: Array.isArray(ev.trailers)
                    ? ev.trailers.filter((t) => typeof t === "string" && t)
                    : [],
                ts: ev.ts,
            };
            break;
        }
        case "session_attached": {
            // Issue #57 — surface the Copilot CLI session id so
            // the App can mount tailSessionFile() against the
            // matching `~/.copilot/session-state/<id>.jsonl`.
            // Defensive validation mirrors the serializer's
            // contract (non-empty string, ≤64 chars); a
            // serializer that ever emits a malformed value
            // produces a no-op fold rather than poisoning the
            // snapshot.
            if (typeof ev.sessionId !== "string" || !ev.sessionId) break;
            if (ev.sessionId.length > 64) break;
            snap.sessionId = ev.sessionId;
            break;
        }
        // Issue #66 — per-iter git worktree lifecycle. Each iter
        // that runs in worktree mode emits `worktree_created` at
        // the top of its `iteration_start` block, then either
        // `worktree_removed` (changes merged into base ref →
        // sandbox + branch deleted) or `worktree_kept` (changes
        // not merged → sandbox preserved on disk for inspection).
        // Defensive shape validation mirrors the serializer.
        case "worktree_created": {
            if (typeof ev.path !== "string" || !ev.path) break;
            if (typeof ev.branch !== "string" || !ev.branch) break;
            snap.activeWorktree = {
                path: ev.path,
                branch: ev.branch,
                baseRef: typeof ev.baseRef === "string" && ev.baseRef ? ev.baseRef : null,
                iteration: Number.isFinite(ev.iteration) ? ev.iteration : null,
                startedAt: ev.ts,
            };
            break;
        }
        case "worktree_removed": {
            if (typeof ev.path !== "string" || !ev.path) break;
            if (
                snap.activeWorktree
                && snap.activeWorktree.path === ev.path
            ) {
                snap.activeWorktree = null;
            }
            break;
        }
        case "worktree_kept": {
            if (typeof ev.path !== "string" || !ev.path) break;
            if (typeof ev.branch !== "string" || !ev.branch) break;
            snap.keptWorktrees.push({
                path: ev.path,
                branch: ev.branch,
                iteration: Number.isFinite(ev.iteration) ? ev.iteration : null,
                ts: ev.ts,
            });
            if (
                snap.activeWorktree
                && snap.activeWorktree.path === ev.path
            ) {
                snap.activeWorktree = null;
            }
            break;
        }
        default:
            // Unreachable — parseEventLine filters unknown types.
            break;
    }
    return snap;
}

/**
 * Reduce a list of LoopEvents into a snapshot describing the run's current
 * state. Pure function — used by the TUI's render path and by tests as the
 * canonical event-stream interpreter.
 *
 * The fold prefers the *latest* armed/complete/abort markers so a replay
 * file containing multiple runs will only show the final one (the writer
 * truncates the file at arm-time, but a replay tool may concatenate runs).
 *
 * Implementation note: thin wrapper over `createInitialSnapshot()` +
 * `foldEvent()`. Public contract preserved byte-for-byte so the
 * ~100 existing tests keep working without churn.
 */
export function foldEvents(events) {
    if (!Array.isArray(events)) {
        throw new TypeError("foldEvents: events must be an array");
    }
    const snap = createInitialSnapshot();
    for (const ev of events) {
        foldEvent(snap, ev);
    }
    return snap;
}
