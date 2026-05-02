// <Header> — top status banner for `ralph-tui watch` (issue #22).
//
// Issue #48 slice 7: extended with a backlog row (open issues / open
// PRs / red CI runs) so the user can see the loop's external scope at
// a glance, and renders `∞` for the iteration cap when max equals the
// runaway-guard ceiling (the new self-improve default per slice 3).
//
// Issue #48 slice 9: extended with a Level-1 active work-item row
// (kind / ref / title) above the backlog row when foldEvents has
// observed a `workitem_start` without a matching `workitem_end`. The
// row collapses to nothing when no work item is active, so single-
// shot `--prompt` runs and pre-iter-1 states stay compact. Also
// gained a "(N done)" pip on the backlog row showing the count of
// work items the loop has already closed (`closedByLoop`) so the
// user sees forward motion as the backlog drains.
//
// Issue #59: optional `appVersion` prop renders a dim `v<X.Y.Z>`
// pip in the heading row's right edge — at-a-glance read of which
// build is running, useful when filing issues or confirming an
// update took effect. Component stays purely presentational; the
// caller (run-ui.mjs / watch.mjs) is responsible for resolving the
// version string from `src/version.mjs`. Hidden when the prop is
// absent so snapshot tests stay deterministic.
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

const TERMINAL_STATUSES = new Set(["complete", "aborted"]);

/** Format a positive ms duration as `HH:MM:SS`, manually computed so
 *  hours grow past 24 without wrap (a 30-hour self-improve run should
 *  read `30:00:00`, not `06:00:00` from a `Date`-based formatter).
 *  Returns `null` when input is non-finite or negative so the Header
 *  can collapse the row when there's no credible elapsed window
 *  (e.g. pre-`armed`, or a replayed event whose ts predates start).
 *  Pure / exported for unit tests. */
export function formatElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

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

// Single source of truth for kind → display glyph. Keep these
// short — the row lives next to the title and we want the title to
// fit on one terminal line for typical widths (~80 cols).
const WORKITEM_GLYPH = {
    issue: "⊘",
    pr: "⤷",
    red_ci: "✗",
};

// Work item title cap — Header is one line; a 60-char title plus the
// kind glyph + ref leaves room on a typical 80-col terminal. Longer
// titles ellipsize. (Surrogate-safe slice via Array.from is not
// needed here — this is for display, not storage; the canonical
// title clip lives in events.mjs:serializeEvent.)
const WORKITEM_TITLE_MAX = 60;

function clipTitle(title) {
    if (typeof title !== "string") return "";
    if (title.length <= WORKITEM_TITLE_MAX) return title;
    return title.slice(0, WORKITEM_TITLE_MAX - 1) + "…";
}

/** Render a backlog field — number when present, `?` when null. The
 *  renderer always reserves space for all three fields so the header
 *  doesn't reflow as the agent populates them across iters. */
function backlogField(value) {
    return value === null || value === undefined ? "?" : String(value);
}

export default function Header({ snapshot, now, appVersion }) {
    const status = snapshot?.status ?? "idle";
    const label = snapshot?.label ?? "(unknown)";
    const runId = snapshot?.runId ?? "(no run)";
    const iter = snapshot?.iteration ?? 0;
    const max = snapshot?.maxIterations ?? "?";
    const min = snapshot?.minIterations ?? null;
    const tokens = snapshot?.tokens ?? { input: 0, output: 0 };
    const total = (tokens.input || 0) + (tokens.output || 0);
    const premiumRequests = snapshot?.premiumRequests;
    const backlog = snapshot?.backlog ?? null;
    const activeWorkItem = snapshot?.activeWorkItem ?? null;
    // Issue #57 — surface the terminal `reason` (e.g. `promise` /
    // `stagnation` / `abort_promise`) inline next to the status badge.
    // The previous DetailPane carried this; LiveOutputPane (which
    // replaced it) is busy streaming the agent's output and would
    // lose the signal in the noise. Showing it here keeps "why did
    // the run end?" one glance away. Null pre-terminal — the
    // parenthetical is rendered conditionally below.
    const reason = snapshot?.reason ?? null;
    const closedByLoop = snapshot?.closedByLoop ?? 0;

    const maxLabel = max === RUNAWAY_GUARD_CEILING ? "∞" : String(max);

    // Elapsed wallclock since the loop armed. Frozen at the terminal
    // event's own ts (`snapshot.terminalAt`, set by foldEvents on
    // `complete` / `abort`) for terminal statuses; otherwise tracks
    // the caller-supplied `now` so <App>'s 1 Hz tick keeps the value
    // live during running/paused. Hidden when `startedAt` is null
    // (pre-iter-1), when the computed window is non-finite/negative,
    // or when no `now` is supplied for a non-terminal status (the
    // static-render path — keeps snapshot tests deterministic by
    // refusing to fall back to wallclock).
    const startedAt = snapshot?.startedAt;
    const terminalAt = snapshot?.terminalAt;
    let elapsedMs = null;
    if (Number.isFinite(startedAt)) {
        let end = null;
        if (TERMINAL_STATUSES.has(status) && Number.isFinite(terminalAt)) {
            end = terminalAt;
        } else if (Number.isFinite(now)) {
            end = now;
        }
        if (end !== null) elapsedMs = end - startedAt;
    }
    const elapsedLabel = formatElapsed(elapsedMs);

    const left = h(Box, { flexDirection: "row" },
        h(Text, { color: STATUS_COLOR[status] ?? "white", bold: true }, STATUS_LABEL[status] ?? String(status).toUpperCase()),
        // Issue #57 — dim parenthetical reason next to status badge
        // so DONE / ABORTED carry the "why" inline. Suppressed
        // pre-terminal (reason is null) so non-terminal layouts are
        // unchanged.
        reason ? h(Text, { dimColor: true }, " (" + String(reason) + ")") : null,
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
        // Premium-request counter — hidden until the first credible
        // value arrives (`snapshot.premiumRequests` is `null`
        // pre-iter-1 and after each `armed` event). Once shown, value
        // is the cumulative-for-the-run cost-weighted count from
        // `result.usage.premiumRequests` per iter, summed.
        Number.isFinite(premiumRequests)
            ? h(Box, { flexDirection: "row" },
                h(Text, null, "   "),
                h(Text, { dimColor: true }, "premium "),
                h(Text, null, String(premiumRequests)),
              )
            : null,
        // Elapsed wallclock counter — only rendered once the loop
        // has armed (startedAt is finite) so single-shot static
        // renders without an `armed` event don't display 00:00:00.
        elapsedLabel
            ? h(Box, { flexDirection: "row" },
                h(Text, null, "   "),
                h(Text, { dimColor: true }, "elapsed "),
                h(Text, null, elapsedLabel),
              )
            : null,
    );

    const topRow = h(Box, {
        flexDirection: "row",
        justifyContent: "space-between",
    }, left, right);

    // Issue #48 slice 9 — Level 1 work-item row. Renders only when
    // foldEvents reports an active work item (workitem_start without
    // a matching workitem_end). Layout: glyph + kind + #ref + title.
    const workItemRow = activeWorkItem
        ? h(Box, { flexDirection: "row", marginTop: 0 },
            h(Text, { color: "magenta", bold: true },
                WORKITEM_GLYPH[activeWorkItem.kind] ?? "•"),
            h(Text, { dimColor: true }, " " + activeWorkItem.kind),
            activeWorkItem.ref != null
                ? h(Text, null, " #" + activeWorkItem.ref)
                : null,
            activeWorkItem.title
                ? h(Text, { bold: true }, "  " + clipTitle(activeWorkItem.title))
                : null,
          )
        : null;

    // Backlog row — only rendered for SDLC modes that emit
    // `backlog_snapshot`. When the snapshot is absent (e.g. --prompt
    // mode or pre-iter-1), the row collapses to nothing so the
    // header stays compact. Issue #48 slice 9: appended a "(N done)"
    // pip showing how many work items the loop has closed so far.
    const backlogRow = backlog
        ? h(Box, { flexDirection: "row", marginTop: 0 },
            h(Text, { dimColor: true }, "backlog: "),
            h(Text, null, backlogField(backlog.openIssues)),
            h(Text, { dimColor: true }, " open issues · "),
            h(Text, null, backlogField(backlog.openPrs)),
            h(Text, { dimColor: true }, " open PRs · "),
            h(Text, { color: backlog.redCi > 0 ? "red" : undefined }, backlogField(backlog.redCi)),
            h(Text, { dimColor: true }, " red CI runs"),
            closedByLoop > 0
                ? h(Text, { color: "green" }, "  (" + String(closedByLoop) + " done)")
                : null,
          )
        : null;

    // Issue #54 slice 1 — heading "Run" sits as the first child
    // inside the bordered Box, matching the existing inside-border
    // heading convention used by Timeline / LiveOutputPane / TasksPane.
    // The status badge (RUN / DONE / PAUSE) lives in the topRow
    // right of the heading, so the heading is the user-facing pane
    // label rather than a duplicate of the status.
    //
    // Issue #59: when `appVersion` is supplied, the heading row
    // becomes a flex row with the version pip pinned to the right
    // edge. The pip renders as a dim `v<value>` so it doesn't
    // compete visually with the active heading text. Absent /
    // empty prop ⇒ no pip, and the row collapses to a single
    // bold-underline "Run" text node (existing behaviour for
    // pre-issue-59 callers + snapshot tests).
    const versionPip = (typeof appVersion === "string" && appVersion.length > 0)
        ? h(Text, { dimColor: true }, "v" + appVersion)
        : null;
    const headingText = h(Text, { bold: true, underline: true }, "Run");
    const heading = versionPip
        ? h(Box, { flexDirection: "row", justifyContent: "space-between" },
            headingText, versionPip)
        : headingText;

    return h(Box, {
        borderStyle: "round",
        borderColor: "blue",
        paddingX: 1,
        flexDirection: "column",
    }, heading, topRow, workItemRow, backlogRow);
}
