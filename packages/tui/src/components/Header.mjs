// <Header> — top status banner for the autopilot watcher.
//
// Pure presentational. Reads the formatter output from
// summarizeHeader() so the same logic drives both this Ink panel
// and the plain-text renderer.

import React from "react";
import { Box, Text } from "ink";

import { summarizeHeader } from "../format.mjs";

const h = React.createElement;

export default function Header({ snapshot, now }) {
    const summary = summarizeHeader(snapshot, { now: now ?? Date.now() });
    const focus = snapshot && typeof snapshot.focus === "string" && snapshot.focus.length > 0
        ? snapshot.focus
        : null;
    const blockedStreak = Number.isFinite(snapshot?.shipper_streak_blocked) && snapshot.shipper_streak_blocked > 0
        ? snapshot.shipper_streak_blocked
        : null;
    const parseFailures = Number.isFinite(snapshot?.parse_failure_streak) && snapshot.parse_failure_streak > 0
        ? snapshot.parse_failure_streak
        : null;

    const headingRow = h(Box, { flexDirection: "row" },
        h(Text, { color: summary.statusColor, bold: true }, summary.statusWord.padEnd(7)),
        h(Text, null, "  "),
        h(Text, { dimColor: true },
            summary.version ? `autopilot v${summary.version}` : "autopilot",
        ),
        h(Text, null, "  "),
        h(Text, null, `iter ${summary.iter ?? 0}/${summary.maxIters ?? "?"}`),
        summary.runtime
            ? h(Text, { dimColor: true }, `  ·  ${summary.armed ? "running" : "ran"} ${summary.runtime}`)
            : null,
        snapshot?.stop_reason && !summary.armed
            ? h(Text, { dimColor: true }, `  ·  reason: ${snapshot.stop_reason}`)
            : null,
    );

    const detailRow = (focus || blockedStreak || parseFailures)
        ? h(Box, { flexDirection: "row" },
            focus ? h(Text, { dimColor: true }, `focus: ${focus}`) : null,
            blockedStreak
                ? h(Text, { color: "yellow" },
                    `${focus ? "  ·  " : ""}blocked streak: ${blockedStreak}`)
                : null,
            parseFailures
                ? h(Text, { color: "red" },
                    `${focus || blockedStreak ? "  ·  " : ""}parse failures: ${parseFailures}`)
                : null,
        )
        : null;

    return h(Box, {
        borderStyle: "round",
        borderColor: "blue",
        paddingX: 1,
        flexDirection: "column",
    },
        h(Text, { bold: true, underline: true }, "Autopilot"),
        headingRow,
        detailRow,
    );
}
