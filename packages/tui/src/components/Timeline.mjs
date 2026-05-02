// <Timeline> — scrolling iteration list for `ralph-tui watch` (issue #22).
//
// Renders the most recent N iterations newest-first. Pure component;
// uses React.createElement (no JSX) so it runs in plain Node ESM.
//
// Issue #56 — per-iter stats cells. Each row gets four cells between
// the iteration # and the excerpt: duration, token delta, premium
// delta, files changed. All render dim-on-zero so cheap iters stay
// quiet; cells with no data render `—` (replay-safe for old runs
// that lack the snapshot fields).

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

// Two-space gap between row cells. Factory rather than a shared
// element instance — React siblings should be distinct objects.
const sep = () => h(Text, null, "  ");

// Compute the duration ms for an iter row. Closed iters use
// `endedAt - startedAt`; in-flight iters use `now - startedAt`
// (where `now` is App's 1Hz tick when supplied, else `Date.now()`
// so static / non-live renders still get a number).
function computeDurMs(it, now) {
    if (Number.isFinite(it.endedAt) && Number.isFinite(it.startedAt)) {
        return it.endedAt - it.startedAt;
    }
    if (Number.isFinite(it.startedAt)) {
        const tickNow = Number.isFinite(now) ? now : Date.now();
        return tickNow - it.startedAt;
    }
    return null;
}

// Format an elapsed duration: `4.2s` for < 60s, `1m23s` otherwise.
// Non-finite or negative ms renders `—` so a runaway clock or a
// missing `startedAt` doesn't surface as `NaN` / `-Infinity`.
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m${seconds}s`;
}

// Format a per-iter token delta as `1.2k` for ≥ 1000, raw integer
// otherwise. `null`/non-finite renders `—` (old iters without a
// `tokensAtStart` snapshot). Negative deltas clamp to 0 defensively
// — cumulative tokens should only grow.
export function formatTokenDelta(delta) {
    if (delta == null || !Number.isFinite(delta)) return "—";
    const n = Math.max(0, Math.floor(delta));
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

// Per-iter token delta = cumulative `snap.tokens` − iter-start
// snapshot. Returns `null` for old iters lacking `tokensAtStart`
// (replay-safe).
export function computeTokenDelta(iter, snap) {
    if (!iter || !iter.tokensAtStart) return null;
    const cur = snap?.tokens;
    if (!cur) return null;
    const curTotal = (Number.isFinite(cur.input) ? cur.input : 0)
        + (Number.isFinite(cur.output) ? cur.output : 0);
    const startTotal = (Number.isFinite(iter.tokensAtStart.input) ? iter.tokensAtStart.input : 0)
        + (Number.isFinite(iter.tokensAtStart.output) ? iter.tokensAtStart.output : 0);
    return curTotal - startTotal;
}

// Per-iter premium-request delta. Returns `null` when both cur and
// start are null (pre-iter-1 / SDK that doesn't emit premium counts)
// so the renderer hides the cell entirely.
export function computePremiumDelta(iter, snap) {
    if (!iter) return null;
    const start = iter.premiumAtStart;
    const cur = snap?.premiumRequests;
    if (start == null && cur == null) return null;
    return (cur ?? 0) - (start ?? 0);
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

export default function Timeline({ snapshot, limit = DEFAULT_LIMIT, now }) {
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
        // Issue #54 slice 2a — surface live excerpt for in-flight
        // iters. When the iter has an excerpt set (mid-iter
        // streaming via `usage_update` excerpt field, or post-iter
        // `iteration_end`), render it. When the iter is in-flight
        // (endedAt == null) and no excerpt has streamed yet, show
        // a `(working…)` placeholder so the row signals progress
        // rather than looking broken with `(no excerpt)`. Finished
        // iters with no excerpt fall back to the historical
        // placeholder so replay-fidelity for old runs is intact.
        let excerptCell;
        if (it.excerpt) {
            excerptCell = h(Text, { dimColor: true }, truncate(it.excerpt, 80));
        } else if (it.endedAt == null) {
            excerptCell = h(Text, { dimColor: true }, "(working…)");
        } else {
            excerptCell = h(Text, { dimColor: true }, "(no excerpt)");
        }

        // Per-iter stats cells. Order: duration, tokens, premium,
        // files. Dim-on-zero so quiet iters don't fight for
        // attention; null cells are omitted entirely (replay-safe
        // for old runs missing the snapshot fields).
        const durMs = computeDurMs(it, now);
        const tokenDelta = computeTokenDelta(it, snapshot);
        const premiumDelta = computePremiumDelta(it, snapshot);
        const filesChanged = it.filesChanged;

        const cells = [
            h(Text, { color }, GLYPH[kind]),
            h(Text, null, " "),
            h(Text, null, "#" + pad(it.iteration, totalWidth)),
            sep(),
            h(Text, { dimColor: !Number.isFinite(durMs) || durMs === 0 }, formatDuration(durMs)),
            sep(),
            h(Text, { dimColor: tokenDelta == null || tokenDelta === 0 },
                tokenDelta == null ? "—" : `${formatTokenDelta(tokenDelta)} tok`),
        ];
        if (premiumDelta != null) {
            cells.push(sep(), h(Text, { dimColor: premiumDelta === 0 }, `⊕${premiumDelta}`));
        }
        if (filesChanged != null) {
            cells.push(sep(), h(Text, { dimColor: filesChanged === 0 }, `📁${filesChanged}`));
        }
        cells.push(sep(), excerptCell);

        return h(Box, { key: it.iteration, flexDirection: "row" }, ...cells);
    });

    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "column",
        flexGrow: 1,
    }, heading, empty, ...rows);
}
