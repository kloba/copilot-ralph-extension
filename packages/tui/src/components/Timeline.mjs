// <Timeline> — scrolling iteration list for `ralph-tui watch` (issue #22).
//
// Renders the most recent N iterations newest-first. Pure component;
// uses React.createElement (no JSX) so it runs in plain Node ESM.

import React from "react";
import { Box, Text } from "ink";

import { safeSliceChars } from "../events.mjs";

const h = React.createElement;

const DEFAULT_LIMIT = 12;

const GLYPH = {
    pending: "·",
    done: "✓",
    stagnant: "≈",
    aborted: "✗",
};

function classify(it, snap) {
    if (it.endedAt == null) return "pending";
    if (snap.status === "aborted" && it.iteration === snap.iteration) return "aborted";
    if (snap.stagnationStreak > 0 && it.iteration === snap.iteration && snap.status !== "complete") return "stagnant";
    return "done";
}

function pad(n, w) {
    return String(n).padStart(w, " ");
}

// Flatten whitespace and cap a string at `n` UTF-16 code units, then
// append a single trailing "…" iff truncation actually happened. The
// reserved byte for the ellipsis is taken from `n` so the rendered
// output never exceeds the requested width. Iter 140: route the cap
// through `safeSliceChars` (shared with plain.mjs / serializeEvent)
// so a 4-byte emoji landing on the boundary doesn't split into a
// lone high-surrogate code unit — a pre-iter-140 `truncate` would
// have called `flat.slice(0, n - 1)` directly, emitting an invalid
// UTF-16 fragment to the terminal.
//
// Exported for direct unit-testability so the surrogate-safety
// contract can be pinned without spinning up the full Ink renderer.
export function truncate(s, n) {
    const flat = String(s).replace(/\s+/g, " ");
    if (flat.length <= n) return flat;
    return safeSliceChars(flat, n - 1) + "…";
}

export default function Timeline({ snapshot, limit = DEFAULT_LIMIT }) {
    const all = snapshot?.iterations ?? [];
    const recent = all.slice(-limit).reverse();
    const totalWidth = String(snapshot?.maxIterations ?? all.length ?? 0).length || 1;

    const heading = h(Text, { bold: true, underline: true }, "Timeline");
    const empty = recent.length === 0
        ? h(Text, { dimColor: true }, "(no iterations yet — waiting for the first event…)")
        : null;

    const rows = recent.map((it) => {
        const kind = classify(it, snapshot ?? {});
        const color = kind === "done" ? "green"
            : kind === "pending" ? "cyan"
            : kind === "stagnant" ? "yellow"
            : "red";
        return h(Box, { key: it.iteration, flexDirection: "row" },
            h(Text, { color }, GLYPH[kind]),
            h(Text, null, " "),
            h(Text, null, "#" + pad(it.iteration, totalWidth)),
            h(Text, null, "  "),
            h(Text, { dimColor: true }, it.excerpt ? truncate(it.excerpt, 80) : "(no excerpt)"),
        );
    });

    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "column",
        flexGrow: 1,
    }, heading, empty, ...rows);
}
