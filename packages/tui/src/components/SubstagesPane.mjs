// <SubstagesPane> — Level 3 of the 3-level hierarchical TUI (issue
// #48 slice 7).
//
// Renders the substage activity log for the currently-active stage:
// each tool call within the stage gets one row showing
// `[N] verb argsSummary  outcome  durationMs`. When no stage is
// active (or when the active stage has no substages yet), the pane
// renders a single "(no activity yet)" placeholder so the layout
// stays stable.
//
// Pure presentational. Pass the snapshot from `foldEvents`.

import React from "react";
import { Box, Text } from "ink";

const h = React.createElement;

const OUTCOME_COLOR = {
    ok: "green",
    error: "red",
    denied: "red",
};

/** Format a substage's duration for display: integer ms when known,
 *  "?" when null. Capped at 99999 with a `>` prefix to keep rows
 *  visually aligned. Pure / exported for testing. */
export function formatDurationMs(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return "?";
    const n = Math.round(ms);
    if (n > 99999) return ">99999ms";
    return `${n}ms`;
}

export default function SubstagesPane({ snapshot, maxRows = 12 }) {
    const active = snapshot?.activeStage ?? null;
    const subs = snapshot?.currentStageSubstages ?? [];

    // Issue #54 slice 1 — heading "Activity" decouples the pane
    // title from the `▸ STAGE_NAME` line, which now sits as the
    // first body row. Matches the inside-border heading convention
    // used by Timeline / DetailPane / TasksPane.
    const heading = h(Text, { bold: true, underline: true }, "Activity");

    const stageRowText = active
        ? `▸ ${active.name}  (substage activity)`
        : "▸ (no active stage)";
    const stageRow = h(Text, { bold: true, color: "cyan" }, stageRowText);

    let body;
    if (!subs || subs.length === 0) {
        body = h(Text, { dimColor: true }, "  (no activity yet)");
    } else {
        // Show the most recent maxRows; the renderer pane is
        // bounded so a long stage doesn't push the rest of the UI
        // off-screen.
        const visible = subs.slice(-maxRows);
        const rows = visible.map((sub, i) => {
            const idx = subs.length - visible.length + i + 1;
            const verb = sub.verb ?? "?";
            const args = sub.argsSummary ?? "";
            const outcome = sub.outcome ?? "?";
            const dur = formatDurationMs(sub.durationMs);
            const outcomeColor = OUTCOME_COLOR[outcome] ?? "yellow";
            return h(Box, { key: `row-${i}`, flexDirection: "row" },
                h(Text, { dimColor: true }, `  [${String(idx).padStart(2)}] `),
                h(Text, { bold: true }, verb.padEnd(6)),
                h(Text, null, " "),
                h(Text, null, args),
                h(Text, { dimColor: true }, "  "),
                h(Text, { color: outcomeColor }, outcome),
                h(Text, { dimColor: true }, "  " + dur),
            );
        });
        body = h(Box, { flexDirection: "column" }, ...rows);
    }

    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "column",
    }, heading, stageRow, body);
}
