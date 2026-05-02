// Shared helpers used by every backend adapter under
// `packages/tui/src/agents/` (issue #83). The `_` prefix marks the
// module as adapter-internal — adapter modules import it; the
// runner does not.
//
// Stdlib-only. Pure ESM.

/** Parse an NDJSON / JSONL stream. Accepts either an array of pre-
 *  split lines or a single concatenated string (split on `\n`).
 *  Blank lines and malformed JSON are silently dropped — mirrors the
 *  runner's existing internal `parseJsonLine` tolerance, but at the
 *  whole-stream granularity each adapter's `parseStream` needs.
 */
export function parseNdjsonLines(stdoutLines) {
    const lines = Array.isArray(stdoutLines) ? stdoutLines : String(stdoutLines).split("\n");
    const events = [];
    for (const line of lines) {
        const trimmed = String(line).trim();
        if (!trimmed) continue;
        try { events.push(JSON.parse(trimmed)); } catch { /* skip */ }
    }
    return events;
}
