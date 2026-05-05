// Pure-function formatters shared by the Ink components and the
// plain-text renderer. Splitting them out keeps the React layer thin
// and lets the formatters be unit-tested without spinning up Ink.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format a millisecond duration as a short human string ("12m",
 * "2h 13m", "3d 4h"). Returns "0s" for zero / negative durations
 * — a non-running loop has `started_at = null` and the caller
 * shows "(not running)" instead, so the 0s fallback is only ever
 * seen in the half-second between `armed=true` being persisted
 * and `started_at` being filled.
 */
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "0s";
    if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
    if (ms < HOUR) {
        const m = Math.floor(ms / MINUTE);
        const s = Math.floor((ms % MINUTE) / SECOND);
        return s > 0 ? `${m}m ${s}s` : `${m}m`;
    }
    if (ms < DAY) {
        const h = Math.floor(ms / HOUR);
        const m = Math.floor((ms % HOUR) / MINUTE);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(ms / DAY);
    const h = Math.floor((ms % DAY) / HOUR);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Format a wall-clock timestamp (epoch ms or ISO string) as a short
 * `HH:MM:SS` for the timeline column. Returns "--:--:--" when the
 * input is missing / unparseable.
 */
export function formatClock(input) {
    let date;
    if (typeof input === "number" && Number.isFinite(input)) {
        date = new Date(input);
    } else if (typeof input === "string" && input.length > 0) {
        const t = Date.parse(input);
        if (!Number.isFinite(t)) return "--:--:--";
        date = new Date(t);
    } else {
        return "--:--:--";
    }
    if (Number.isNaN(date.getTime())) return "--:--:--";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Map an iter outcome row into a short, single-line description.
 * Handles the three outcome shapes the loop driver emits:
 *   - { outcome: "complete" }
 *   - { outcome: "shipped", sha?: string }
 *   - { outcome: "blocked", reason?: string }
 * Plus best-effort handling of the legacy `reason` field on
 * `complete` entries that some early state files carried.
 */
export function describeOutcome(outcome) {
    if (!outcome || typeof outcome !== "object") return "(unknown)";
    if (outcome.outcome === "shipped") {
        const sha = typeof outcome.sha === "string" && outcome.sha.length > 0
            ? outcome.sha.slice(0, 12)
            : "(no sha)";
        return `shipped ${sha}`;
    }
    if (outcome.outcome === "blocked") {
        const reason = typeof outcome.reason === "string" && outcome.reason.length > 0
            ? truncate(outcome.reason, 60)
            : "(no reason)";
        return `blocked: ${reason}`;
    }
    if (outcome.outcome === "complete") return "complete";
    return `(${String(outcome.outcome ?? "unknown")})`;
}

/**
 * Truncate a string to `n` UTF-16 code units, appending an ellipsis
 * when truncation happened. The reserved char for the ellipsis is
 * taken out of `n` so the output never exceeds the requested width.
 */
export function truncate(s, n) {
    const flat = String(s).replace(/\s+/g, " ");
    if (flat.length <= n) return flat;
    return flat.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * Compute the `last N` outcome rows from a state snapshot's
 * `history` field, newest-first. The extension records every
 * `outcome` and `parse_failure` event in `history`; the timeline
 * only shows outcomes (parse failures are surfaced as a header
 * streak counter, not a row).
 */
export function recentOutcomes(snapshot, n = 10) {
    const history = Array.isArray(snapshot?.history) ? snapshot.history : [];
    const rows = [];
    for (let i = history.length - 1; i >= 0 && rows.length < n; i--) {
        const row = history[i];
        if (!row || row.event !== "outcome") continue;
        rows.push(row);
    }
    return rows;
}

/**
 * Build a one-line header describing the loop state. Used by both
 * the Ink Header component and the plain-mode renderer. Includes:
 *   - status word (RUNNING / IDLE / DONE)
 *   - iter / max
 *   - elapsed runtime when armed
 *   - paused indicator
 *   - extension version
 */
export function summarizeHeader(snapshot, { now = Date.now() } = {}) {
    if (!snapshot) {
        return {
            statusWord: "IDLE",
            statusColor: "gray",
            line: "IDLE  ·  autopilot — no state file yet (start /autopilot run in another session)",
            version: null,
            armed: false,
            paused: false,
        };
    }
    const armed = Boolean(snapshot.armed);
    const paused = Boolean(snapshot.paused);
    const iter = Number.isFinite(snapshot.iter) ? snapshot.iter : 0;
    const maxIters = Number.isFinite(snapshot.max_iters) ? snapshot.max_iters : "?";
    const version = typeof snapshot.version === "string" ? snapshot.version : null;

    let runtime = null;
    if (armed && Number.isFinite(snapshot.started_at)) {
        runtime = formatDuration(now - snapshot.started_at);
    } else if (!armed && snapshot.last_run && Number.isFinite(snapshot.last_run.finished_at) && Number.isFinite(snapshot.last_run.started_at)) {
        runtime = formatDuration(snapshot.last_run.finished_at - snapshot.last_run.started_at);
    }

    // Rubber-duck fix #5: after the post-loop hook fires, the
    // extension's `armOnNextRun` clears `stop_reason` from the active
    // snapshot but preserves the just-finished run in `last_run`. The
    // TUI must keep showing "STOPPED · reason: …" until a new arm
    // happens, so we fall back to `last_run.stop_reason` when armed
    // is false and the active reason was cleared.
    const reason = snapshot.stop_reason
        ?? (armed ? null : snapshot.last_run?.stop_reason ?? null);

    let statusWord;
    let statusColor;
    if (armed && paused) { statusWord = "PAUSED"; statusColor = "yellow"; }
    else if (armed) { statusWord = "RUNNING"; statusColor = "cyan"; }
    else if (reason === "complete") { statusWord = "DONE"; statusColor = "green"; }
    else if (reason) { statusWord = "STOPPED"; statusColor = "red"; }
    else { statusWord = "IDLE"; statusColor = "gray"; }

    const parts = [`autopilot ${version ? `v${version} ` : ""}${statusWord}`];
    parts.push(`iter ${iter}/${maxIters}`);
    if (runtime) parts.push(armed ? `running ${runtime}` : `ran ${runtime}`);
    if (reason && !armed) parts.push(`reason: ${reason}`);

    return {
        statusWord,
        statusColor,
        line: parts.join("  ·  "),
        version,
        armed,
        paused,
        iter,
        maxIters,
        runtime,
    };
}
