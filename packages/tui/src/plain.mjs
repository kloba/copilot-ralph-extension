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

import { safeSliceChars } from "./events.mjs";

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
    if (Number.isFinite(ev.streak)) parts.push(`streak=${ev.streak}`);
    if (Number.isFinite(ev.pausedForMs)) parts.push(`pausedForMs=${ev.pausedForMs}`);
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
