// <LastCommit> — bottom-of-stack pane showing the latest
// `commit_observed` event from the current run (issue #48 slice 9).
//
// Layout: SHA (short, 7-char prefix matching `git rev-parse --short`)
// + commit subject + co-author trailer count badge.
//
//   abc1234  feat(x): add CSV export   2 trailers
//
// When no commit has been observed yet (early-iter / pre-first-
// commit state, or a `--prompt` run that doesn't produce commits),
// the pane collapses to a dim placeholder so the layout stays
// stable.
//
// Pure presentational. Pass the snapshot from `foldEvents`.

import React from "react";
import { Box, Text } from "ink";

const h = React.createElement;

// Subject clip — `git log --oneline` defaults to ~50 chars; we
// allow a bit more so most conventional-commit subjects
// (`feat(scope): summary`) fit without ellipsis on a typical
// 80-col terminal. Beyond this we ellipsize.
const SUBJECT_MAX = 64;

function clipSubject(subject) {
    if (typeof subject !== "string") return "";
    if (subject.length <= SUBJECT_MAX) return subject;
    return subject.slice(0, SUBJECT_MAX - 1) + "…";
}

/** Pure helper: count co-author trailers (the slice that the
 *  loop's commit-attribution rider adds). Other trailers
 *  (`Closes #N`, `Refs #N`, `Signed-off-by`) don't count toward the
 *  co-author badge — they're displayed separately if we ever wire
 *  a richer footer. Exported for tests. */
export function countCoAuthors(trailers) {
    if (!Array.isArray(trailers)) return 0;
    let n = 0;
    for (const t of trailers) {
        if (typeof t === "string" && /^Co-authored-by:/i.test(t)) n += 1;
    }
    return n;
}

// Worktree paths can run long (`/home/user/.copilot/ralph-tui/runs/
// <runId>/worktrees/iter-<N>`). Ellipsize from the front so the
// distinguishing iter-N tail stays visible.
const WORKTREE_PATH_MAX = 60;

function clipPath(p) {
    if (typeof p !== "string") return "";
    if (p.length <= WORKTREE_PATH_MAX) return p;
    return "…" + p.slice(p.length - WORKTREE_PATH_MAX + 1);
}

export default function LastCommit({ snapshot }) {
    const last = snapshot?.lastCommit ?? null;
    // Issue #66 — per-iter worktree status row. Surface the active
    // worktree path for in-flight iters and a "kept N at <path>" tag
    // when one or more prior iters left their sandboxes preserved.
    // Single-line, dim — same visual weight as the trailer count
    // badge so the row stays scannable.
    const activeWt = snapshot?.activeWorktree ?? null;
    const keptCount = Array.isArray(snapshot?.keptWorktrees) ? snapshot.keptWorktrees.length : 0;
    const lastKept = keptCount > 0 ? snapshot.keptWorktrees[keptCount - 1] : null;
    if (!last || typeof last.sha !== "string") {
        return h(Box, {
            borderStyle: "single",
            borderColor: "gray",
            paddingX: 1,
            flexDirection: "column",
        },
            h(Text, { dimColor: true }, "last commit: (none yet)"),
            activeWt
                ? h(Text, { dimColor: true }, "worktree: " + clipPath(activeWt.path))
                : null,
            lastKept
                ? h(Text, { dimColor: true }, "kept " + String(keptCount) + ": " + clipPath(lastKept.path))
                : null,
        );
    }
    const sha7 = last.sha.length >= 7 ? last.sha.slice(0, 7) : last.sha;
    const subject = clipSubject(last.subject ?? "");
    const coAuthors = countCoAuthors(last.trailers);
    const totalTrailers = Array.isArray(last.trailers) ? last.trailers.length : 0;
    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "column",
    },
        h(Box, { flexDirection: "row" },
            h(Text, { color: "yellow", bold: true }, sha7),
            h(Text, null, "  "),
            h(Text, null, subject),
            totalTrailers > 0
                ? h(Text, { dimColor: true }, "   " + String(totalTrailers) + " trailer" + (totalTrailers === 1 ? "" : "s"))
                : null,
            coAuthors > 0
                ? h(Text, { color: "magenta" }, " (" + String(coAuthors) + " co-author" + (coAuthors === 1 ? "" : "s") + ")")
                : null,
        ),
        activeWt
            ? h(Text, { dimColor: true }, "worktree: " + clipPath(activeWt.path))
            : null,
        lastKept
            ? h(Text, { dimColor: true }, "kept " + String(keptCount) + ": " + clipPath(lastKept.path))
            : null,
    );
}
