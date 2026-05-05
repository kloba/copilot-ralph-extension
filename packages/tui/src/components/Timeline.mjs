// <Timeline> — last N iter outcomes from state.history, newest first.

import React from "react";
import { Box, Text } from "ink";

import { describeOutcome, formatClock, recentOutcomes } from "../format.mjs";

const h = React.createElement;

const GLYPH_FOR = {
    complete: "✓",
    shipped: "↑",
    blocked: "✗",
};
const COLOR_FOR = {
    complete: "green",
    shipped: "cyan",
    blocked: "red",
};

export default function Timeline({ snapshot, limit = 10 }) {
    const rows = recentOutcomes(snapshot, limit);
    const heading = h(Text, { bold: true, underline: true }, "Timeline");

    if (rows.length === 0) {
        const placeholder = snapshot?.armed
            ? "(waiting for the first iter outcome…)"
            : "(no iter outcomes recorded — has the loop run yet?)";
        return h(Box, {
            borderStyle: "single",
            borderColor: "gray",
            paddingX: 1,
            flexDirection: "column",
            flexGrow: 1,
        },
            heading,
            h(Text, { dimColor: true }, placeholder),
        );
    }

    const totalWidth = String(rows[0]?.iter ?? 0).length || 1;
    const renderedRows = rows.map((row) => {
        const glyph = GLYPH_FOR[row.outcome] ?? "·";
        const color = COLOR_FOR[row.outcome] ?? "white";
        const iterCol = `#${String(row.iter ?? "?").padStart(totalWidth, " ")}`;
        return h(Box, { key: `${row.iter}-${row.ts}`, flexDirection: "row" },
            h(Text, { color }, glyph),
            h(Text, null, " "),
            h(Text, null, iterCol),
            h(Text, null, "  "),
            h(Text, { dimColor: true }, formatClock(row.ts)),
            h(Text, null, "  "),
            h(Text, null, describeOutcome(row)),
        );
    });

    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "column",
        flexGrow: 1,
    },
        heading,
        ...renderedRows,
    );
}
