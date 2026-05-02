// <StagesRow> — Level 2 of the 3-level hierarchical TUI (issue #48
// slice 7).
//
// Renders a horizontal pill row showing the canonical SDLC stage list
// for the current loop with three states per pill:
//   - completed (✓, green)  — already in `snapshot.recentStages`
//   - active    (●, cyan)   — currently `snapshot.activeStage`
//   - pending   ( , dim)    — neither completed nor active yet
//
// Issue #48 slice 9: when the agent has emitted a `[STAGE_PLAN: …]`
// marker, foldEvents populates `snapshot.currentPlan.stages` and
// THIS component renders that plan instead of the canonical static
// list. Stages in the plan that match `PINNED_TAIL_STAGES` (COMMIT /
// PUSH / END or CLOSE for grow-project) display a 📌 glyph so the
// user sees they're loop-mandated. Stages that were added by a
// `stage_plan_amend` (any reason other than the runner's
// `pinned-tail-enforcement`) get a `+` glyph so amend churn is
// visible. Falls back to the canonical static list when no plan has
// been emitted yet (early-iter / pre-marker state).
//
// Pure presentational. Pass the snapshot from `foldEvents`.

import React from "react";
import { Box, Text } from "ink";

import { stagesForLabel, PINNED_TAIL_STAGES } from "../events.mjs";

const h = React.createElement;

const PINNED_TAIL_SET = new Set(PINNED_TAIL_STAGES);

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

/** Decide which stage list to render. Pure helper — exported so the
 *  test suite can pin the precedence (plan > canonical) without
 *  rendering. */
export function selectStages(snapshot) {
    const plan = snapshot?.currentPlan?.stages;
    if (Array.isArray(plan) && plan.length > 0) {
        const seen = new Set();
        const out = [];
        for (const name of plan) {
            if (typeof name !== "string" || !name) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            out.push(name);
        }
        if (out.length > 0) return out;
    }
    return stagesForLabel(snapshot?.label) ?? [];
}

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

/** Identify which stages were added by an agent-emitted amendment
 *  (not by the runner's `pinned-tail-enforcement`). The `+` glyph
 *  surfaces these so the user sees mid-iter plan changes. Pure /
 *  exported. */
export function computeAmendmentAdds(snapshot) {
    const amends = snapshot?.planAmendments ?? [];
    const added = new Set();
    for (const a of amends) {
        if (!a) continue;
        if (typeof a.add !== "string" || !a.add) continue;
        // Runner-driven pinned-tail enforcement is implementation
        // noise — don't decorate those with `+`. Anything with a
        // non-pinned-tail reason is "real" agent intent.
        if (a.reason === "pinned-tail-enforcement") continue;
        added.add(a.add);
    }
    return added;
}

export default function StagesRow({ snapshot }) {
    const stages = selectStages(snapshot);
    if (!stages || stages.length === 0) return null;

    const items = computeStageStates(snapshot, stages);
    const amendAdds = computeAmendmentAdds(snapshot);
    const pills = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const color = PILL_COLORS[it.state];
        const glyph = PILL_GLYPHS[it.state];
        const isPinned = PINNED_TAIL_SET.has(it.name);
        const isAmended = amendAdds.has(it.name);
        // Glyph layout inside the pill: state-glyph + name +
        // optional decoration (📌 for pinned, + for amend-added).
        const decoration = isPinned ? "📌" : (isAmended ? "+" : "");
        const label = decoration
            ? `[${glyph} ${it.name}${decoration}]`
            : `[${glyph} ${it.name}]`;
        pills.push(h(Text, {
            key: `pill-${i}`,
            color,
            dimColor: it.state === "pending" ? true : false,
            bold: it.state === "active",
        }, label));
        if (i < items.length - 1) {
            pills.push(h(Text, { key: `sep-${i}`, dimColor: true }, " "));
        }
    }

    // Issue #54 slice 1 — heading "Stages" matches the inside-
    // border convention used by the rest of the panes (Timeline /
    // DetailPane / TasksPane).
    const heading = h(Text, { bold: true, underline: true }, "Stages");

    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "column",
    },
        heading,
        h(Box, { flexDirection: "row", flexWrap: "wrap" }, ...pills),
    );
}
