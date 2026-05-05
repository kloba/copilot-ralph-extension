// Plain-text renderer for the autopilot TUI watcher.
//
// When stdout is not a TTY (CI, asciinema, piped to a file) or the
// user passes `--plain`, the watcher prints a fresh dashboard block
// every poll cycle instead of mounting Ink. The block is
// self-contained: header, timeline, footer. Successive blocks are
// separated by a blank line so a `tail -f` consumer can scroll
// back and read history.

import { describeOutcome, formatClock, recentOutcomes, summarizeHeader } from "./format.mjs";

/**
 * Render a state snapshot as a multi-line plain-text block.
 *
 * @param {object|null} snapshot
 * @param {Object} [opts]
 * @param {number}  [opts.now=Date.now()]
 * @param {number}  [opts.timelineLimit=10]
 * @returns {string}
 */
export function renderPlain(snapshot, { now = Date.now(), timelineLimit = 10 } = {}) {
    const lines = [];
    const header = summarizeHeader(snapshot, { now });
    lines.push(`# ${header.line}`);

    if (!snapshot) {
        lines.push(`  (run \`/autopilot run\` from a Copilot CLI session to arm the loop)`);
        return lines.join("\n");
    }

    if (snapshot.focus) {
        lines.push(`  focus: ${snapshot.focus}`);
    }
    if (Number.isFinite(snapshot.shipper_streak_blocked) && snapshot.shipper_streak_blocked > 0) {
        lines.push(`  shipper blocked streak: ${snapshot.shipper_streak_blocked}`);
    }
    if (Number.isFinite(snapshot.parse_failure_streak) && snapshot.parse_failure_streak > 0) {
        lines.push(`  parse failure streak: ${snapshot.parse_failure_streak}`);
    }

    const rows = recentOutcomes(snapshot, timelineLimit);
    if (rows.length === 0) {
        lines.push("  timeline: (no iter outcomes yet)");
    } else {
        lines.push(`  timeline (newest first, last ${rows.length}):`);
        for (const row of rows) {
            const iter = Number.isFinite(row.iter) ? `#${String(row.iter).padStart(3)}` : "  #?";
            const ts = formatClock(row.ts);
            lines.push(`    ${iter}  ${ts}  ${describeOutcome(row)}`);
        }
    }

    return lines.join("\n");
}
