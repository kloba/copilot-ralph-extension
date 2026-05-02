// Live-output formatter for the Copilot CLI session log (issue #57).
//
// Converts a single session event (the lines you'd find in
// `~/.copilot/session-state/<sessionId>.jsonl`) into 0+ "display lines"
// the LiveOutputPane component renders. Returning structured objects
// rather than ANSI-colored strings keeps the formatter pure and lets
// the React layer decide colors via Ink's <Text color={…}> prop.
//
// Defensive contract:
//   - Unknown / suppressed event types → [].
//   - Missing or wrong-typed fields → [] for the source event (never
//     throws). The whole function body is wrapped in a try/catch so a
//     surprise schema change can't crash the renderer.
//   - Lines are length-bounded via safeSliceChars to keep wide-char
//     truncation correct (the same helper events.mjs uses on every
//     wire-format string).
//
// Rendering rules — locked from the issue #57 clarifying form:
//   - text from `assistant.message.data.content` is split on newlines;
//     each non-empty line becomes one {kind:"text"} entry.
//   - `tool.execution_start` becomes a single `→ <tool>(<argsSummary>)`
//     line (kind:"tool_start").
//   - `tool.execution_complete` (success) becomes `← ok: <80 chars>`
//     (kind:"tool_ok"); failure becomes `← FAIL: <80 chars>`
//     (kind:"tool_fail").
//   - Turn boundaries, user prompts, and session housekeeping are
//     suppressed — they're noise inside the iter-streaming view.
//
// Zero deps (Node stdlib only); shares safeSliceChars with events.mjs.

import { safeSliceChars } from "./events.mjs";

const TEXT_LINE_MAX = 240;
const TOOL_RESULT_PREVIEW = 80;
const ARGS_SUMMARY_MAX = 60;

// Suppressed: turn boundaries dupe the structural progress the live
// pane already shows via Stage / Tasks; user.message is our own loop
// prompt re-injection (we *wrote* it, no point re-rendering); session.*
// is initialisation chatter that lands once per session and adds zero
// signal to the live tail.
const SUPPRESSED_TYPES = new Set([
    "assistant.turn_start",
    "assistant.turn_end",
    "user.message",
    "session.start",
    "session.info",
    "session.truncation",
    "session.end",
    "session.checkpoint",
]);

// Per-tool argument summary: pick the most useful 1-arg description.
// Generic fallback below covers the long tail; only add a hint here
// when the tool has multiple plausible "primary" string fields and the
// generic first-string heuristic would surface the wrong one.
const ARG_HINTS = {
    bash: (a) => a?.command,
    view: (a) => a?.path,
    grep: (a) => a?.pattern,
    edit: (a) => a?.path,
    create: (a) => a?.path,
    glob: (a) => a?.pattern,
    report_intent: (a) => a?.intent,
    web_fetch: (a) => a?.url,
    web_search: (a) => a?.query,
    show_file: (a) => a?.path,
    str_replace_editor: (a) => a?.path,
};

/**
 * Build a 1-line summary of a tool's arguments. Returns "" when no
 * meaningful summary exists (the renderer then falls back to
 * `<tool>()` rather than `<tool>(undefined)`).
 *
 * Preference order: (1) per-tool hint, (2) first string field,
 * (3) first finite number field. Strings beat numbers because a tool
 * with a numeric id alongside a descriptive string almost always
 * surfaces better with the string.
 *
 * @param {string} toolName
 * @param {object|null|undefined} args
 * @returns {string}
 */
export function argsSummaryFor(toolName, args) {
    if (!args || typeof args !== "object") return "";
    const hint = ARG_HINTS[toolName];
    if (hint) {
        try {
            const v = hint(args);
            if (typeof v === "string" && v.trim()) {
                return safeSliceChars(collapseWhitespace(v), ARGS_SUMMARY_MAX);
            }
        } catch {
            /* fall through to generic */
        }
    }
    // Generic fallback: prefer strings, fall back to finite numbers.
    // Each property access is try/catch-guarded because a hint that
    // threw earlier was likely a getter that will throw again.
    let numericFallback = "";
    let keys = [];
    try { keys = Object.keys(args); } catch { return ""; }
    for (const k of keys) {
        let v;
        try { v = args[k]; } catch { continue; }
        if (typeof v === "string" && v.trim()) {
            return safeSliceChars(collapseWhitespace(v), ARGS_SUMMARY_MAX);
        }
        if (!numericFallback && typeof v === "number" && Number.isFinite(v)) {
            numericFallback = String(v);
        }
    }
    return numericFallback;
}

/**
 * Format one Copilot CLI session event into 0+ live-pane display
 * lines. Each line is `{kind, line}` where kind is one of:
 *   - "text"         : assistant prose (dim)
 *   - "tool_start"   : `→ tool(args)` (cyan)
 *   - "tool_ok"      : `← ok: …`     (green)
 *   - "tool_fail"    : `← FAIL: …`   (red)
 *
 * @param {object|null|undefined} ev
 * @returns {Array<{kind: string, line: string}>}
 */
export function formatSessionEvent(ev) {
    try {
        if (!ev || typeof ev !== "object") return [];
        if (typeof ev.type !== "string") return [];
        if (SUPPRESSED_TYPES.has(ev.type)) return [];
        const data = ev.data;
        if (!data || typeof data !== "object") return [];

        switch (ev.type) {
            case "assistant.message":
                return formatAssistantMessage(data);
            case "tool.execution_start":
                return formatToolStart(data);
            case "tool.execution_complete":
                return formatToolComplete(data);
            default:
                return [];
        }
    } catch {
        // Defensive: any surprise in the SDK shape collapses to a
        // silently-dropped line rather than crashing the renderer.
        return [];
    }
}

function formatAssistantMessage(data) {
    const content = typeof data.content === "string" ? data.content : "";
    if (!content.trim()) return [];
    const out = [];
    for (const raw of content.split("\n")) {
        const line = raw.trimEnd();
        if (!line) continue;
        out.push({ kind: "text", line: safeSliceChars(line, TEXT_LINE_MAX) });
    }
    return out;
}

function formatToolStart(data) {
    const name = typeof data.toolName === "string" && data.toolName
        ? data.toolName
        : "(unknown)";
    const summary = argsSummaryFor(name, data.arguments);
    const line = summary ? `→ ${name}(${summary})` : `→ ${name}()`;
    return [{ kind: "tool_start", line: safeSliceChars(line, TEXT_LINE_MAX) }];
}

function formatToolComplete(data) {
    if (data.success === false) {
        // Failure path — try error.message first (richer), fall back to
        // result.content (some tools route their stderr there).
        let err = "";
        if (data.error && typeof data.error.message === "string") {
            err = data.error.message;
        } else if (typeof data.error === "string") {
            err = data.error;
        } else if (data.result && typeof data.result.content === "string") {
            err = data.result.content;
        }
        const preview = err
            ? safeSliceChars(collapseWhitespace(err), TOOL_RESULT_PREVIEW)
            : "(no error message)";
        return [{ kind: "tool_fail", line: `← FAIL: ${preview}` }];
    }
    const result = data.result && typeof data.result.content === "string"
        ? data.result.content
        : "";
    if (!result.trim()) return [{ kind: "tool_ok", line: "← ok" }];
    const preview = safeSliceChars(collapseWhitespace(result), TOOL_RESULT_PREVIEW);
    return [{ kind: "tool_ok", line: `← ok: ${preview}` }];
}

function collapseWhitespace(s) {
    return s.replace(/\s+/g, " ").trim();
}
