// <Header> — top status banner for `ralph-tui watch` (issue #22).
//
// Issue #48 slice 7: extended with a backlog row (open issues / open
// PRs / red CI runs) so the user can see the loop's external scope at
// a glance, and renders `∞` for the iteration cap when max equals the
// runaway-guard ceiling (the new self-improve default per slice 3).
//
// Pure presentational component. Uses React.createElement directly so
// the file loads in plain Node ESM (no JSX/TypeScript build step).

import React from "react";
import { Box, Text } from "ink";

const h = React.createElement;

// Mirrors runner.MAX_ALLOWED_ITERATIONS (issue #48 slice 3 default).
// When `maxIterations` equals this ceiling, the header shows `∞`
// instead of the literal number — semantically the cap is "drain the
// whole backlog or hit the runaway guard", which is unbounded from
// the user's perspective.
const RUNAWAY_GUARD_CEILING = 1000;

const STATUS_COLOR = {
    idle: "gray",
    running: "cyan",
    paused: "yellow",
    complete: "green",
    aborted: "red",
};

const STATUS_LABEL = {
    idle: "IDLE",
    running: "RUN ",
    paused: "PAUSE",
    complete: "DONE",
    aborted: "ABORT",
};

/** Render a backlog field — number when present, `?` when null. The
 *  renderer always reserves space for all three fields so the header
 *  doesn't reflow as the agent populates them across iters. */
function backlogField(value) {
    return value === null || value === undefined ? "?" : String(value);
}

export default function Header({ snapshot }) {
    const status = snapshot?.status ?? "idle";
    const label = snapshot?.label ?? "(unknown)";
    const runId = snapshot?.runId ?? "(no run)";
    const iter = snapshot?.iteration ?? 0;
    const max = snapshot?.maxIterations ?? "?";
    const min = snapshot?.minIterations ?? null;
    const tokens = snapshot?.tokens ?? { input: 0, output: 0 };
    const total = (tokens.input || 0) + (tokens.output || 0);
    const backlog = snapshot?.backlog ?? null;

    const maxLabel = max === RUNAWAY_GUARD_CEILING ? "∞" : String(max);

    const left = h(Box, { flexDirection: "row" },
        h(Text, { color: STATUS_COLOR[status] ?? "white", bold: true }, STATUS_LABEL[status] ?? String(status).toUpperCase()),
        h(Text, null, "  "),
        h(Text, { bold: true }, label),
        h(Text, { dimColor: true }, "  " + runId),
    );

    const right = h(Box, { flexDirection: "row" },
        h(Text, null, "iter "),
        h(Text, { bold: true }, String(iter)),
        h(Text, null, "/" + maxLabel),
        min != null ? h(Text, { dimColor: true }, " (min " + min + ")") : null,
        h(Text, null, "   "),
        h(Text, { dimColor: true }, "tokens "),
        h(Text, null, String(total)),
    );

    const topRow = h(Box, {
        flexDirection: "row",
        justifyContent: "space-between",
    }, left, right);

    // Backlog row — only rendered for SDLC modes that emit
    // `backlog_snapshot`. When the snapshot is absent (e.g. --prompt
    // mode or pre-iter-1), the row collapses to nothing so the
    // header stays compact.
    const backlogRow = backlog
        ? h(Box, { flexDirection: "row", marginTop: 0 },
            h(Text, { dimColor: true }, "backlog: "),
            h(Text, null, backlogField(backlog.openIssues)),
            h(Text, { dimColor: true }, " open issues · "),
            h(Text, null, backlogField(backlog.openPrs)),
            h(Text, { dimColor: true }, " open PRs · "),
            h(Text, { color: backlog.redCi > 0 ? "red" : undefined }, backlogField(backlog.redCi)),
            h(Text, { dimColor: true }, " red CI runs"),
          )
        : null;

    return h(Box, {
        borderStyle: "round",
        borderColor: "blue",
        paddingX: 1,
        flexDirection: "column",
    }, topRow, backlogRow);
}
