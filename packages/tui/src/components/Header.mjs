// <Header> — top status banner for `ralph-tui watch` (issue #22).
//
// Pure presentational component. Uses React.createElement directly so
// the file loads in plain Node ESM (no JSX/TypeScript build step).

import React from "react";
import { Box, Text } from "ink";

const h = React.createElement;

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

export default function Header({ snapshot }) {
    const status = snapshot?.status ?? "idle";
    const label = snapshot?.label ?? "(unknown)";
    const runId = snapshot?.runId ?? "(no run)";
    const iter = snapshot?.iteration ?? 0;
    const max = snapshot?.maxIterations ?? "?";
    const min = snapshot?.minIterations ?? null;
    const tokens = snapshot?.tokens ?? { input: 0, output: 0 };
    const total = (tokens.input || 0) + (tokens.output || 0);

    const left = h(Box, { flexDirection: "row" },
        h(Text, { color: STATUS_COLOR[status] ?? "white", bold: true }, STATUS_LABEL[status] ?? String(status).toUpperCase()),
        h(Text, null, "  "),
        h(Text, { bold: true }, label),
        h(Text, { dimColor: true }, "  " + runId),
    );

    const right = h(Box, { flexDirection: "row" },
        h(Text, null, "iter "),
        h(Text, { bold: true }, String(iter)),
        h(Text, null, "/" + String(max)),
        min != null ? h(Text, { dimColor: true }, " (min " + min + ")") : null,
        h(Text, null, "   "),
        h(Text, { dimColor: true }, "tokens "),
        h(Text, null, String(total)),
    );

    return h(Box, {
        borderStyle: "round",
        borderColor: "blue",
        paddingX: 1,
        flexDirection: "row",
        justifyContent: "space-between",
    }, left, right);
}
