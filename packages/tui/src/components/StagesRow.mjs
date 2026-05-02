// <StagesRow> — Level 2 of the 3-level hierarchical TUI (issue #48
// slice 7).
//
// Renders a horizontal pill row showing the canonical SDLC stage list
// for the current loop with three states per pill:
//   - completed (✓, green)  — already in `snapshot.recentStages`
//   - active    (●, cyan)   — currently `snapshot.activeStage`
//   - pending   ( , dim)    — neither completed nor active yet
//
// The stage list is selected by the loop's `label`
// (`self_improve` / `grow_project`) via stagesForLabel(); custom
// `--prompt` runs (no canonical list) render nothing.
//
// Pure presentational. Pass the snapshot from `foldEvents`.

import React from "react";
import { Box, Text } from "ink";

import { stagesForLabel } from "../events.mjs";

const h = React.createElement;

const PILL_COLORS = {
    completed: "green",
    active: "cyan",
    pending: undefined, // dimColor instead of explicit color
};

const PILL_GLYPHS = {
    completed: "✓",
    active: "●",
    pending: " ",
};

/** Decide each stage's render state given the snapshot. Pure helper —
 *  exported so the test suite can pin the logic without rendering. */
export function computeStageStates(snapshot, stages) {
    const recent = snapshot?.recentStages ?? [];
    const active = snapshot?.activeStage ?? null;
    const completedSet = new Set(recent.map((s) => s.name));
    return stages.map((name) => {
        if (active && active.name === name) return { name, state: "active" };
        if (completedSet.has(name)) return { name, state: "completed" };
        return { name, state: "pending" };
    });
}

export default function StagesRow({ snapshot }) {
    const stages = stagesForLabel(snapshot?.label);
    if (!stages || stages.length === 0) return null;

    const items = computeStageStates(snapshot, stages);
    const pills = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const color = PILL_COLORS[it.state];
        const glyph = PILL_GLYPHS[it.state];
        pills.push(h(Text, {
            key: `pill-${i}`,
            color,
            dimColor: it.state === "pending" ? true : false,
            bold: it.state === "active",
        }, `[${glyph} ${it.name}]`));
        if (i < items.length - 1) {
            pills.push(h(Text, { key: `sep-${i}`, dimColor: true }, " "));
        }
    }

    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "row",
        flexWrap: "wrap",
    }, ...pills);
}
