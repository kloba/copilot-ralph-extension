// Event contract for the ralph TUI (issue #22).
//
// The loop handler (extension/handler.mjs) writes one JSON object per line
// to ~/.copilot/session-state/<id>/events.jsonl. The TUI tails that file,
// parses each line with parseEventLine(), and renders the resulting state.
//
// Keeping this module dependency-free (Node stdlib only) means handler.mjs
// can import the same serializer without pulling Ink/React into the core
// extension's runtime — issue #22's hard constraint.

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

/** Set of recognised event types — used by parseEventLine for validation. */
export const EVENT_TYPES = Object.freeze([
    "armed",
    "iteration_start",
    "iteration_end",
    "pause",
    "resume",
    "stagnation",
    "complete",
    "abort",
]);

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
 * half). Mirrors the inline guard in extension/events-emit.mjs's
 * `clipExcerpt` and the `safeSliceEnd` helper in extension/handler.mjs.
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
    if (typeof ev.reason === "string") out.reason = ev.reason;
    if (typeof ev.excerpt === "string") out.excerpt = safeSliceChars(ev.excerpt, 500);
    if (Number.isFinite(ev.streak)) out.streak = ev.streak;
    if (ev.tokens && typeof ev.tokens === "object") {
        const input = Number.isFinite(ev.tokens.input) ? ev.tokens.input : 0;
        const output = Number.isFinite(ev.tokens.output) ? ev.tokens.output : 0;
        out.tokens = { input, output };
    }
    if (typeof ev.note === "string") out.note = safeSliceChars(ev.note, 500);

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
 * Reduce a list of LoopEvents into a snapshot describing the run's current
 * state. Pure function — used by the TUI's render path and by tests as the
 * canonical event-stream interpreter.
 *
 * The fold prefers the *latest* armed/complete/abort markers so a replay
 * file containing multiple runs will only show the final one (the writer
 * truncates the file at arm-time, but a replay tool may concatenate runs).
 */
export function foldEvents(events) {
    if (!Array.isArray(events)) {
        throw new TypeError("foldEvents: events must be an array");
    }
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
     *   iterations: Array<{iteration:number, startedAt:number, endedAt:number|null, excerpt:string|null}>,
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
        lastExcerpt: null,
        startedAt: null,
        updatedAt: null,
        iterations: [],
    };

    for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
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
                snap.lastExcerpt = null;
                snap.startedAt = ev.ts;
                snap.iterations = [];
                break;
            case "iteration_start":
                if (Number.isFinite(ev.iteration)) {
                    snap.iteration = ev.iteration;
                    snap.iterations.push({
                        iteration: ev.iteration,
                        startedAt: ev.ts,
                        endedAt: null,
                        excerpt: null,
                    });
                }
                snap.status = "running";
                break;
            case "iteration_end": {
                const last = snap.iterations[snap.iterations.length - 1];
                if (last && (!Number.isFinite(ev.iteration) || last.iteration === ev.iteration)) {
                    last.endedAt = ev.ts;
                    if (typeof ev.excerpt === "string") last.excerpt = ev.excerpt;
                }
                if (typeof ev.excerpt === "string") snap.lastExcerpt = ev.excerpt;
                if (ev.tokens) {
                    snap.tokens = {
                        input: Number.isFinite(ev.tokens.input) ? ev.tokens.input : snap.tokens.input,
                        output: Number.isFinite(ev.tokens.output) ? ev.tokens.output : snap.tokens.output,
                    };
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
                break;
            case "abort":
                snap.status = "aborted";
                snap.reason = ev.reason ?? snap.reason;
                break;
            default:
                // Unreachable — parseEventLine filters unknown types.
                break;
        }
    }
    return snap;
}
