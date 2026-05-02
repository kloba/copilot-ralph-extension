// <LiveOutputPane> — live tail of the agent's output for the active task
// (issue #57). Replaces the previous DetailPane.
//
// Renders up to LIVE_VISIBLE_LINES (10) lines from a ring buffer fed by
// App.mjs's `tailSessionFile()` reader. Lines come pre-formatted from
// `stream-format.mjs::formatSessionEvent` as `{kind, line}` objects;
// this component only handles layout + per-kind colors.
//
// Empty states:
//   - replay (no live tail): "(session log unavailable for replay)"
//   - live but no sessionId yet: "(waiting for session)"
//   - live + sessionId but no lines yet: "(no output yet)"
//
// Uses React.createElement (no JSX) so the file runs in plain Node ESM.

import React from "react";
import { Box, Text } from "ink";

const h = React.createElement;

// Fixed body height — locked from the issue #57 clarifying form. Larger
// would crowd out the existing panes; smaller would feel choppy when
// the agent is mid-iteration spitting out 5+ lines at once.
export const LIVE_VISIBLE_LINES = 10;

const LINE_COLOR = {
    text: undefined,        // default fg, kept dim for prose
    tool_start: "cyan",
    tool_ok: "green",
    tool_fail: "red",
};

// `dimColor` for prose lines so the eye treats tool calls / results as
// the high-signal events. Tool lines are bold-ish-looking via color
// alone; we don't bold them because that double-emphasises them with
// the colored arrow already.
const LINE_DIM = {
    text: true,
    tool_start: false,
    tool_ok: false,
    tool_fail: false,
};

/**
 * @param {Object} props
 * @param {object} props.snapshot     foldEvents() snapshot.
 * @param {Array<{kind:string,line:string}>} props.lines  Buffer slice.
 * @param {boolean} props.isLive      Whether a live tail is active
 *                                    (false in static / replay mode).
 */
export default function LiveOutputPane({ snapshot, lines = [], isLive = false }) {
    const taskInFlight = snapshot?.taskInFlight ?? null;
    const sessionId = snapshot?.sessionId ?? null;

    // Sub-header: when a task is active, show its identity. Otherwise
    // omit so the empty-state placeholder centres in the box.
    const subhead = taskInFlight
        ? h(Box, { flexDirection: "row", marginBottom: 0 },
            h(Text, { color: "magenta" }, taskInFlight.stage),
            h(Text, { dimColor: true }, " · "),
            h(Text, null, "task " + String(taskInFlight.sub)),
            taskInFlight.desc
                ? h(Text, { dimColor: true }, " — " + clip(taskInFlight.desc, 80))
                : null,
          )
        : null;

    let body;
    if (!isLive && !lines.length) {
        // Static / replay mode: the live session log is gone (the
        // Copilot CLI rotates/cleans these); be honest.
        body = h(Text, { dimColor: true, italic: true },
            "(session log unavailable for replay)");
    } else if (isLive && !sessionId) {
        // Pre-arm or older armed event without sessionId — buffer
        // can't mount yet.
        body = h(Text, { dimColor: true, italic: true },
            "(waiting for session)");
    } else if (!lines.length) {
        body = h(Text, { dimColor: true, italic: true },
            "(no output yet)");
    } else {
        const visible = lines.slice(-LIVE_VISIBLE_LINES);
        body = h(Box, { flexDirection: "column" },
            ...visible.map((entry, i) => h(Text, {
                key: i,
                color: LINE_COLOR[entry.kind],
                dimColor: LINE_DIM[entry.kind] ?? false,
                wrap: "truncate",
            }, entry.line)),
        );
    }

    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "column",
    },
        h(Text, { bold: true, underline: true }, "Live"),
        subhead,
        body,
    );
}

function clip(s, max) {
    if (typeof s !== "string") return "";
    if (s.length <= max) return s;
    // Plain JS `slice` is safe enough at the renderer boundary —
    // safeSliceChars (which guards surrogate pairs) was already
    // applied in stream-format.mjs before this point. The `desc`
    // field here comes from our own foldEvents snapshot, which the
    // test harness controls, so a stray surrogate is not a realistic
    // concern.
    return s.slice(0, max - 1) + "…";
}
