// Plain-mode renderer for the ralph TUI (issue #22).
//
// The Ink-based watch UI (slice 5) requires a TTY plus user-space npm
// dependencies. CI logs, asciinema recordings, and `ralph-tui watch
// --plain` need a non-interactive stream of human-readable lines that
// preserves *every* event's information without ANSI tricks.
//
// formatEventLine() is a pure function — given an event, return a single
// log line. No I/O, no ANSI. Tests pin the exact wording for the
// snapshot suite.

import { safeSliceChars, WORKTREE_EVENT_TYPES } from "./events.mjs";

const WORKTREE_EVENT_TYPE_SET = new Set(WORKTREE_EVENT_TYPES);

const PAD2 = (n) => String(n).padStart(2, "0");
const PAD3 = (n) => String(n).padStart(3, "0");

/**
 * Format an epoch-ms timestamp as `HH:MM:SS.mmm` UTC. UTC keeps test
 * snapshots stable across CI machines / DST jumps. Use formatLocalTime()
 * if you ever need a per-user log instead.
 */
export function formatTimestamp(ts) {
    if (!Number.isFinite(ts)) return "??:??:??.???";
    const d = new Date(ts);
    // `Number.isFinite(ts)` is necessary but not sufficient: JS Date
    // tops out at ±8.64e15 ms (100M days from epoch), so a finite-but-
    // out-of-range value (e.g. Number.MAX_SAFE_INTEGER, or a corrupted
    // events.jsonl row that lost a digit) constructs an Invalid Date
    // whose getUTC* accessors all return NaN. Rendering that without a
    // guard emits the 16-char string "NaN:NaN:NaN.NaN", which is wider
    // than the 12-char `"??:??:??.???"` sentinel and silently knocks
    // every column to its right out of awk/grep alignment. Fall back
    // to the same sentinel a non-finite ts gets so downstream column
    // parsers see a stable width regardless of how the upstream `ts`
    // got mangled.
    if (Number.isNaN(d.getTime())) return "??:??:??.???";
    return `${PAD2(d.getUTCHours())}:${PAD2(d.getUTCMinutes())}:${PAD2(d.getUTCSeconds())}.${PAD3(d.getUTCMilliseconds())}`;
}

const VERB = {
    armed: "armed",
    iteration_start: "iter+",
    iteration_end: "iter-",
    pause: "pause",
    resume: "resume",
    stagnation: "stagn",
    complete: "done ",
    abort: "abort",
    // Issue #48 slice 1 — three-level hierarchy. Verbs are 5 chars
    // (or 5 with trailing space) so column alignment under
    // `tail -f`/`awk` stays uniform with the existing vocabulary.
    stage_start: "stge+",
    stage_end: "stge-",
    substage: "sub  ",
    backlog_snapshot: "back ",
    // Issue #48 slice 3 — L1 work-item events. `wkit+` / `wkit-` keep
    // the 5-char verb shape so the column layout under `awk` /
    // `cut` stays stable; the issue body's example (`workitem+`,
    // `workitem-`) is illustrative — we use the same shorter verb
    // family the existing rows use (`stge+`, `iter+`, `sub  `).
    workitem_start: "wkit+",
    workitem_end: "wkit-",
    // Issue #48 slice 9 — flex stage plan + task list + per-task
    // execution. `plan ` and `pamen` (5 chars each, padded) match the
    // existing 5-char verb width. Task verbs (`tsk+ ` / `tsk- `) follow
    // the `iter+/-` family. `commt` flags a commit-observed footer
    // record so a `grep ' commt '` selects every commit the loop made.
    stage_plan: "plan ",
    stage_plan_amend: "pamen",
    task_list: "tlist",
    task_start: "tsk+ ",
    task_end: "tsk- ",
    commit_observed: "commt",
    // 5-char verb so the column layout under awk/grep stays uniform.
    // Emitted live from the runner each time a root-agent
    // assistant.message (per-message outputTokens delta) or terminal
    // result (premiumRequests) lands during an iter, carrying
    // cumulative-for-the-run counters.
    usage_update: "usage",
    // Issue #66 — per-iter git worktree lifecycle. 5-char verbs so the
    // column layout under awk/grep stays uniform with the existing
    // vocabulary. `wt+ ` / `wt- ` follow the iter+/- family; `wtkep`
    // signals the kept-on-disk variant.
    worktree_created: "wt+  ",
    worktree_removed: "wt-  ",
    worktree_kept: "wtkep",
};

/**
 * Render a single event as a log line. Format:
 *
 *   HH:MM:SS.mmm  <verb> <runId>  iter=N/M tokens=I/O excerpt="…"
 *
 * Fields are space-separated and stable so `grep`/`awk` users get a
 * predictable column layout. Only fields present on the event get rendered.
 *
 * @param {object} ev
 * @returns {string}
 */
export function formatEventLine(ev) {
    if (!ev || typeof ev !== "object") return "";
    const verb = VERB[ev.type] ?? ev.type ?? "?????";
    const parts = [formatTimestamp(ev.ts), verb];
    if (typeof ev.runId === "string") parts.push(ev.runId);
    if (Number.isFinite(ev.iteration)) {
        const max = Number.isFinite(ev.maxIterations) ? `/${ev.maxIterations}` : "";
        parts.push(`iter=${ev.iteration}${max}`);
    }
    if (Number.isFinite(ev.minIterations) && ev.type === "armed") {
        parts.push(`min=${ev.minIterations}`);
    }
    if (ev.tokens && (Number.isFinite(ev.tokens.input) || Number.isFinite(ev.tokens.output))) {
        const i = Number.isFinite(ev.tokens.input) ? ev.tokens.input : 0;
        const o = Number.isFinite(ev.tokens.output) ? ev.tokens.output : 0;
        parts.push(`tokens=${i}/${o}`);
    }
    if (Number.isFinite(ev.premiumRequests) && ev.premiumRequests >= 0) {
        parts.push(`premium=${ev.premiumRequests}`);
    }
    if (Number.isFinite(ev.streak)) parts.push(`streak=${ev.streak}`);
    if (Number.isFinite(ev.pausedForMs)) parts.push(`pausedForMs=${ev.pausedForMs}`);
    // Issue #48 slice 1 — stage / substage / backlog fields. Each
    // gates on its own type/finiteness so a misordered or partial
    // event still renders the fields it does have.
    if (Number.isFinite(ev.stage)) parts.push(`stage=${ev.stage}`);
    if (typeof ev.stageName === "string" && ev.stageName) parts.push(`name=${ev.stageName}`);
    if (Number.isFinite(ev.sub)) parts.push(`sub=${ev.sub}`);
    if (typeof ev.verb === "string" && ev.verb) parts.push(`verb=${ev.verb}`);
    if (typeof ev.argsSummary === "string" && ev.argsSummary) {
        // Always JSON.stringify args — the "args" field is intrinsically
        // multi-token (e.g. `git log --oneline -20`) so quoting is not
        // optional. Cap at 80 chars on the rendered side; the events
        // file already caps at 500. Reuses the same surrogate-safe
        // truncate as the excerpt branch below.
        const collapsed = safeSliceChars(ev.argsSummary.replace(/\s+/g, " "), 80);
        parts.push(`args=${JSON.stringify(collapsed)}`);
    }
    if (typeof ev.outcome === "string" && ev.outcome) parts.push(`outcome=${ev.outcome}`);
    if (Number.isFinite(ev.durationMs)) parts.push(`durationMs=${ev.durationMs}`);
    if (Number.isFinite(ev.redCi)) parts.push(`redCi=${ev.redCi}`);
    if (Number.isFinite(ev.openPrs)) parts.push(`openPrs=${ev.openPrs}`);
    if (Number.isFinite(ev.openIssues)) parts.push(`openIssues=${ev.openIssues}`);
    if (Number.isFinite(ev.closedByLoop)) parts.push(`closedByLoop=${ev.closedByLoop}`);
    // Issue #48 slice 3 — L1 work-item fields. `kind` is rendered
    // unquoted (it's drawn from a closed enum: issue / pr / red_ci),
    // `ref` is unquoted (always numeric — issue/PR number, or run id
    // for red_ci), and `title` is JSON-stringified because human-
    // authored titles routinely contain whitespace and quotes.
    // `closesN` is the issue number a workitem_end event closed.
    if (typeof ev.kind === "string" && ev.kind) parts.push(`kind=${ev.kind}`);
    if (Number.isFinite(ev.ref)) parts.push(`ref=${ev.ref}`);
    if (typeof ev.title === "string" && ev.title) {
        const collapsed = safeSliceChars(ev.title.replace(/\s+/g, " "), 80);
        parts.push(`title=${JSON.stringify(collapsed)}`);
    }
    if (Number.isFinite(ev.closesN)) parts.push(`closesN=${ev.closesN}`);
    // Issue #48 slice 9 — stage_plan / stage_plan_amend / task_list /
    // task_start / task_end / commit_observed fields. Each gates on
    // its own type/finiteness so a partial event still renders the
    // fields it has.
    if (Array.isArray(ev.stages) && ev.stages.length) {
        // Render the plan compactly as `stages=[A,B,C,D]` so the
        // headless mode matches the issue's mockup line:
        //   stage_plan  …  stages=[REPRO,ROOT_CAUSE,FIX,…]
        // Filter out empty/non-string entries defensively even though
        // serializeEvent already does so.
        const items = ev.stages
            .filter((s) => typeof s === "string" && s)
            .map((s) => s.replace(/[\s,]+/g, "_"));
        parts.push(`stages=[${items.join(",")}]`);
    }
    if (typeof ev.add === "string" && ev.add) parts.push(`add=${ev.add}`);
    if (typeof ev.remove === "string" && ev.remove) parts.push(`remove=${ev.remove}`);
    if (typeof ev.after === "string" && ev.after) parts.push(`after=${ev.after}`);
    if (Array.isArray(ev.items) && ev.items.length) {
        // task_list `items=[...]`. JSON.stringify each item because
        // task descriptions are free-text imperatives and routinely
        // contain whitespace + punctuation.
        const items = ev.items
            .filter((s) => typeof s === "string" && s)
            .map((s) => JSON.stringify(safeSliceChars(s.replace(/\s+/g, " "), 80)));
        parts.push(`items=[${items.join(",")}]`);
    }
    if (typeof ev.desc === "string" && ev.desc) {
        const collapsed = safeSliceChars(ev.desc.replace(/\s+/g, " "), 80);
        parts.push(`desc=${JSON.stringify(collapsed)}`);
    }
    if (typeof ev.sha === "string" && ev.sha) {
        // Render only the first 12 hex chars so plain-mode lines stay
        // narrow; full SHA is preserved in the JSONL event itself.
        parts.push(`sha=${ev.sha.slice(0, 12)}`);
    }
    if (typeof ev.subject === "string" && ev.subject) {
        const collapsed = safeSliceChars(ev.subject.replace(/\s+/g, " "), 80);
        parts.push(`subject=${JSON.stringify(collapsed)}`);
    }
    if (Array.isArray(ev.trailers) && ev.trailers.length) {
        // Trailers are key:value short strings; render the count
        // rather than the full payload to keep plain-mode lines from
        // exploding when a commit has multiple Co-authored-by lines.
        // The TUI reads trailers from the JSONL event directly.
        parts.push(`trailers=${ev.trailers.length}`);
    }
    // Issue #66 — per-iter git worktree fields. `path` and `branch`
    // are JSON-stringified because absolute paths and branch names
    // can contain spaces (rare but legal); `baseRef` is unquoted
    // because refs are token-shaped.
    if (WORKTREE_EVENT_TYPE_SET.has(ev.type)) {
        if (typeof ev.path === "string" && ev.path) {
            const collapsed = safeSliceChars(ev.path.replace(/\s+/g, " "), 200);
            parts.push(`path=${JSON.stringify(collapsed)}`);
        }
        if (typeof ev.branch === "string" && ev.branch) {
            const collapsed = safeSliceChars(ev.branch.replace(/\s+/g, " "), 200);
            parts.push(`branch=${JSON.stringify(collapsed)}`);
        }
        if (typeof ev.baseRef === "string" && ev.baseRef && ev.type === "worktree_created") {
            parts.push(`baseRef=${ev.baseRef}`);
        }
    }
    if (typeof ev.reason === "string" && ev.reason) {
        // JSON.stringify the reason iff it contains whitespace, so a
        // user-supplied multi-word reason from ralph_pause / ralph_stop
        // (e.g. "user requested" or a flattened multi-line paste) stays
        // a single awk-parseable token in the rendered log line. Baked
        // single-token reasons (completion_promise, abort_promise,
        // stagnation, max_iterations, send_error, …) keep their
        // historical unquoted form so existing log scrapers don't
        // suddenly see `reason="completion_promise"` instead of
        // `reason=completion_promise`. Mirrors the per-field
        // single-line guarantee `note` already gets via JSON.stringify
        // — the asymmetry was a pre-iter-137 papercut: a `pause` event
        // emitted with `reason: "going to lunch"` rendered as
        // `pause <runId> iter=N/M reason=going to lunch` so an
        // awk-like consumer counted four extra tokens after `reason=`
        // and silently mis-aligned every column to its right.
        parts.push(/\s/.test(ev.reason) ? `reason=${JSON.stringify(ev.reason)}` : `reason=${ev.reason}`);
    }
    if (typeof ev.note === "string" && ev.note) parts.push(`note=${JSON.stringify(ev.note)}`);
    if (typeof ev.excerpt === "string" && ev.excerpt) {
        // Collapse whitespace so the excerpt stays single-line. Cap at 80
        // chars in plain mode to keep `tail -f` readable; the TUI's
        // detail pane shows the full excerpt. `safeSliceChars` (shared
        // with serializeEvent) ensures the 80-char boundary doesn't
        // split a UTF-16 surrogate pair — a naive `.slice(0, 80)`
        // landing on a high surrogate would emit a lone half that
        // JSON.stringify would then render as a verbose `\uD83D` escape
        // in the rendered line.
        const collapsed = safeSliceChars(ev.excerpt.replace(/\s+/g, " "), 80);
        parts.push(`excerpt=${JSON.stringify(collapsed)}`);
    }
    return parts.join("  ");
}
