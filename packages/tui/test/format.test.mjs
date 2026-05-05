// Tests for the pure-function formatters in
// packages/tui/src/format.mjs. Every formatter is deterministic and
// does no I/O — these tests stay tight and fast.

import test from "node:test";
import assert from "node:assert/strict";

import {
    formatDuration,
    formatClock,
    describeOutcome,
    truncate,
    recentOutcomes,
    summarizeHeader,
} from "../src/format.mjs";

test("formatDuration: sub-minute renders as Ns", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(-1), "0s");
    assert.equal(formatDuration(NaN), "0s");
    assert.equal(formatDuration(1500), "1s");
    assert.equal(formatDuration(59 * 1000), "59s");
});

test("formatDuration: minutes without seconds when whole, with otherwise", () => {
    assert.equal(formatDuration(60 * 1000), "1m");
    assert.equal(formatDuration(2 * 60 * 1000 + 30 * 1000), "2m 30s");
});

test("formatDuration: hours / days roll-up", () => {
    assert.equal(formatDuration(60 * 60 * 1000), "1h");
    assert.equal(formatDuration(60 * 60 * 1000 + 30 * 60 * 1000), "1h 30m");
    assert.equal(formatDuration(2 * 24 * 60 * 60 * 1000), "2d");
    assert.equal(formatDuration(24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000), "1d 6h");
});

test("formatClock: epoch ms render as HH:MM:SS", () => {
    // 2025-01-01T12:34:56Z — local-time render so we just assert shape.
    const out = formatClock(Date.UTC(2025, 0, 1, 12, 34, 56));
    assert.match(out, /^\d{2}:\d{2}:\d{2}$/);
});

test("formatClock: invalid input renders the placeholder", () => {
    assert.equal(formatClock(undefined), "--:--:--");
    assert.equal(formatClock(null), "--:--:--");
    assert.equal(formatClock(""), "--:--:--");
    assert.equal(formatClock("not-a-date"), "--:--:--");
});

test("describeOutcome: shipped renders 'shipped <sha>' clipped to 12 chars", () => {
    assert.equal(describeOutcome({ outcome: "shipped", sha: "abc1234567890def" }), "shipped abc123456789");
    assert.equal(describeOutcome({ outcome: "shipped" }), "shipped (no sha)");
});

test("describeOutcome: blocked renders 'blocked: <reason>' truncated at 60", () => {
    assert.equal(describeOutcome({ outcome: "blocked", reason: "gh_unauth" }), "blocked: gh_unauth");
    const long = "x".repeat(120);
    const out = describeOutcome({ outcome: "blocked", reason: long });
    assert.ok(out.endsWith("…"), `expected ellipsis suffix, got ${out}`);
    assert.ok(out.length <= "blocked: ".length + 60);
});

test("describeOutcome: complete renders the constant word", () => {
    assert.equal(describeOutcome({ outcome: "complete" }), "complete");
});

test("describeOutcome: malformed inputs render '(unknown)' for null/undefined and '(<word>)' for objects", () => {
    assert.equal(describeOutcome(null), "(unknown)");
    assert.equal(describeOutcome({}), "(unknown)");
    assert.equal(describeOutcome({ outcome: "weird" }), "(weird)");
});

test("truncate: leaves short strings alone", () => {
    assert.equal(truncate("hi", 10), "hi");
});

test("truncate: clips and appends a single ellipsis", () => {
    assert.equal(truncate("abcdefghij", 5), "abcd…");
});

test("recentOutcomes: returns last N rows newest-first, filtering parse_failure", () => {
    const snap = {
        history: [
            { iter: 1, event: "outcome", outcome: "shipped", sha: "a" },
            { iter: 2, event: "parse_failure", error: "x" },
            { iter: 3, event: "outcome", outcome: "blocked", reason: "r" },
            { iter: 4, event: "outcome", outcome: "complete" },
        ],
    };
    const out = recentOutcomes(snap, 2);
    assert.equal(out.length, 2);
    assert.equal(out[0].iter, 4);
    assert.equal(out[1].iter, 3);
});

test("recentOutcomes: empty history → empty array", () => {
    assert.deepEqual(recentOutcomes(null), []);
    assert.deepEqual(recentOutcomes({}), []);
    assert.deepEqual(recentOutcomes({ history: [] }), []);
});

test("summarizeHeader: null snapshot → IDLE placeholder", () => {
    const out = summarizeHeader(null);
    assert.equal(out.statusWord, "IDLE");
    assert.match(out.line, /no state file yet/);
});

test("summarizeHeader: armed snapshot → RUNNING with iter / max / runtime", () => {
    const now = 1_700_000_010_000;
    const snap = {
        armed: true,
        paused: false,
        iter: 4,
        max_iters: 200,
        started_at: 1_700_000_000_000,
        version: "0.7.0",
    };
    const out = summarizeHeader(snap, { now });
    assert.equal(out.statusWord, "RUNNING");
    assert.equal(out.armed, true);
    assert.match(out.line, /iter 4\/200/);
    assert.match(out.line, /running 10s/);
    assert.match(out.line, /v0\.7\.0/);
});

test("summarizeHeader: paused snapshot → PAUSED status", () => {
    const out = summarizeHeader({ armed: true, paused: true, iter: 1, max_iters: 200, started_at: 0 });
    assert.equal(out.statusWord, "PAUSED");
});

test("summarizeHeader: completed → DONE with reason", () => {
    const out = summarizeHeader({ armed: false, stop_reason: "complete", iter: 5, max_iters: 200 });
    assert.equal(out.statusWord, "DONE");
});

test("summarizeHeader: stopped non-complete → STOPPED", () => {
    const out = summarizeHeader({ armed: false, stop_reason: "user_stopped", iter: 3, max_iters: 200 });
    assert.equal(out.statusWord, "STOPPED");
    assert.match(out.line, /reason: user_stopped/);
});

test("summarizeHeader: post-loop hook cleared stop_reason → falls back to last_run.stop_reason", () => {
    // Rubber-duck fix #5: after `armOnNextRun` clears the active
    // `stop_reason` (so the next arm starts clean), the snapshot
    // briefly has `stop_reason: null` while the just-finished run
    // sits in `last_run`. Without the fallback, the TUI flips to
    // IDLE — the user loses sight of WHY the loop stopped.
    const out = summarizeHeader({
        armed: false,
        stop_reason: null,
        iter: 7,
        max_iters: 200,
        last_run: {
            stop_reason: "shipper_blocked",
            started_at: 1000,
            finished_at: 5000,
            iter: 7,
            history: [],
        },
    });
    assert.equal(out.statusWord, "STOPPED");
    assert.match(out.line, /reason: shipper_blocked/);
});

test("summarizeHeader: complete carries through last_run after stop_reason cleared", () => {
    const out = summarizeHeader({
        armed: false,
        stop_reason: null,
        iter: 12,
        max_iters: 200,
        last_run: {
            stop_reason: "complete",
            started_at: 1000,
            finished_at: 5000,
            iter: 12,
            history: [],
        },
    });
    assert.equal(out.statusWord, "DONE");
});

test("summarizeHeader: armed snapshot does NOT use last_run.stop_reason", () => {
    // While armed, the TUI must show RUNNING — a stale `last_run`
    // from the previous run must not bleed into the active label.
    const out = summarizeHeader({
        armed: true,
        stop_reason: null,
        iter: 1,
        max_iters: 200,
        started_at: Date.now(),
        last_run: {
            stop_reason: "shipper_blocked",
            started_at: 1000,
            finished_at: 5000,
            iter: 7,
            history: [],
        },
    });
    assert.equal(out.statusWord, "RUNNING");
});
