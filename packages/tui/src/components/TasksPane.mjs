// <TasksPane> — Level 3 of the 3-level hierarchical TUI (issue #48
// slice 9).
//
// Renders the current task list (the agent-emitted `[TASK_LIST: …]`
// for the active stage) with completion glyphs:
//
//   ✓ N.M  done task         (in snapshot.recentTasks)
//   ▶ N.M  in-flight task    (snapshot.taskInFlight) + " ← this iter"
//   · N.M  pending task      (declared in TASK_LIST, not yet started)
//
// Where N is the parent stage ordinal (1-based, derived from the
// current plan / canonical stage list) and M is the task's `sub`
// number within that stage.
//
// When no task list has been emitted yet (early-iter / pre-marker
// state, or a `--prompt` run that doesn't emit task markers), the
// pane collapses to a dim placeholder so the layout stays consistent
// without forcing the agent to invent a task list.
//
// Pure presentational. Pass the snapshot from `foldEvents`.

import React from "react";
import { Box, Text } from "ink";

import { stagesForLabel } from "../events.mjs";

const h = React.createElement;

// Cap the number of recent-task rows we render so a long-running
// stage with dozens of completed tasks doesn't push the next pane
// off-screen. Mirrors recentStages cap semantics in the foldEvents
// snapshot.
const MAX_RECENT_TASK_ROWS = 12;

/** Pure helper: locate the 1-based ordinal of a stage name within
 *  the active plan (or canonical stage list as fallback). Returns
 *  `null` when the stage isn't found, so the renderer can fall back
 *  to bare `M.` numbering. Exported for tests. */
export function stageOrdinal(snapshot, stageName) {
    if (typeof stageName !== "string" || !stageName) return null;
    const planStages = snapshot?.currentPlan?.stages;
    const stages = (Array.isArray(planStages) && planStages.length > 0)
        ? planStages
        : (stagesForLabel(snapshot?.label) ?? []);
    const idx = stages.indexOf(stageName);
    return idx >= 0 ? idx + 1 : null;
}

/** Pure helper: build the rendered row list from the snapshot.
 *  Exported for tests so they can pin precedence (in-flight beats
 *  recent beats pending) without rendering. */
export function computeTaskRows(snapshot) {
    const taskList = snapshot?.currentTaskList ?? null;
    const inFlight = snapshot?.taskInFlight ?? null;
    const recent = snapshot?.recentTasks ?? [];
    if (!taskList && !inFlight && recent.length === 0) return [];

    // Build a {stage, sub} → state map. Recent tasks are
    // {stage, sub, outcome, ...}; in-flight is a single object.
    // Tasks declared in TASK_LIST.items but neither in-flight nor
    // recent are rendered as pending (1-based positional sub).
    const rows = [];
    if (taskList && Array.isArray(taskList.items) && taskList.items.length > 0) {
        for (let i = 0; i < taskList.items.length; i++) {
            const desc = taskList.items[i];
            if (typeof desc !== "string") continue;
            const sub = i + 1;
            const isInFlight = inFlight
                && inFlight.stage === taskList.stage
                && inFlight.sub === sub;
            const recentMatch = recent.find((r) =>
                r && r.stage === taskList.stage && r.sub === sub);
            let state;
            if (isInFlight) state = "in_flight";
            else if (recentMatch) state = recentMatch.outcome ?? "ok";
            else state = "pending";
            rows.push({
                stage: taskList.stage,
                sub,
                desc,
                state,
            });
        }
    }
    // Recent tasks not present in the current task list (e.g. tasks
    // from a prior stage that's already closed) — also render so the
    // user sees the loop's progression. Cap.
    const taskListKey = (t) => `${t.stage}#${t.sub}`;
    const inListKeys = new Set(rows.map(taskListKey));
    const tail = [];
    for (const r of recent) {
        if (!r || typeof r.stage !== "string" || typeof r.sub !== "number") continue;
        if (inListKeys.has(taskListKey(r))) continue;
        tail.push({
            stage: r.stage,
            sub: r.sub,
            desc: r.desc ?? "",
            state: r.outcome ?? "ok",
        });
    }
    // Cap recent-tail tasks; keep the most-recent N (foldEvents
    // already keeps them in arrival order, so slice from the end).
    const tailCapped = tail.slice(Math.max(0, tail.length - MAX_RECENT_TASK_ROWS));
    return [...tailCapped, ...rows];
}

const STATE_GLYPH = {
    ok: "✓",
    fail: "✗",
    skip: "↷",
    pending: "·",
    in_flight: "▶",
};

const STATE_COLOR = {
    ok: "green",
    fail: "red",
    skip: "yellow",
    pending: undefined,
    in_flight: "cyan",
};

export default function TasksPane({ snapshot }) {
    const rows = computeTaskRows(snapshot);
    if (rows.length === 0) {
        return h(Box, {
            borderStyle: "single",
            borderColor: "gray",
            paddingX: 1,
            flexDirection: "column",
        },
            h(Text, { dimColor: true }, "tasks: (no task list yet)"),
        );
    }

    const elements = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const ord = stageOrdinal(snapshot, r.stage);
        const numbering = ord != null ? `${ord}.${r.sub}` : `${r.sub}`;
        const glyph = STATE_GLYPH[r.state] ?? "·";
        const color = STATE_COLOR[r.state];
        const dim = r.state === "pending";
        const bold = r.state === "in_flight";
        elements.push(h(Box, { key: `t-${i}`, flexDirection: "row" },
            h(Text, { color, dimColor: dim, bold }, glyph + " "),
            h(Text, { color, dimColor: dim, bold }, numbering + "  "),
            h(Text, { color, dimColor: dim, bold }, r.desc),
            r.state === "in_flight"
                ? h(Text, { dimColor: true }, "  ← this iter")
                : null,
        ));
    }

    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "column",
    }, ...elements);
}
