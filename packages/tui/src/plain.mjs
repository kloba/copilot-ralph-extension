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
    if (typeof ev.reason === "string" && ev.reason) parts.push(`reason=${ev.reason}`);
    if (typeof ev.note === "string" && ev.note) parts.push(`note=${JSON.stringify(ev.note)}`);
    if (typeof ev.excerpt === "string" && ev.excerpt) {
        // Collapse whitespace so the excerpt stays single-line. Cap at 80
        // chars in plain mode to keep `tail -f` readable; the TUI's
        // detail pane shows the full excerpt.
        const collapsed = ev.excerpt.replace(/\s+/g, " ").slice(0, 80);
        parts.push(`excerpt=${JSON.stringify(collapsed)}`);
    }
    return parts.join("  ");
}
