// Tests for the plain-text dashboard renderer
// (packages/tui/src/render-plain.mjs).

import test from "node:test";
import assert from "node:assert/strict";

import { renderPlain } from "../src/render-plain.mjs";

test("renderPlain: null snapshot prints the IDLE preamble + arm hint", () => {
    const out = renderPlain(null);
    assert.match(out, /IDLE/);
    assert.match(out, /\/autopilot run/);
});

test("renderPlain: armed snapshot includes status, iter, version, runtime", () => {
    const now = 1_700_000_005_000;
    const snap = {
        armed: true,
        paused: false,
        iter: 1,
        max_iters: 50,
        started_at: 1_700_000_000_000,
        version: "0.7.0",
        history: [],
    };
    const out = renderPlain(snap, { now });
    assert.match(out, /RUNNING/);
    assert.match(out, /iter 1\/50/);
    assert.match(out, /running 5s/);
    assert.match(out, /\(no iter outcomes yet\)/);
});

test("renderPlain: timeline rows render newest-first with sha/reason", () => {
    const out = renderPlain({
        armed: true,
        iter: 3,
        max_iters: 200,
        started_at: 0,
        version: "0.7.0",
        history: [
            { iter: 1, ts: Date.UTC(2025, 0, 1, 0, 0, 0), event: "outcome", outcome: "shipped", sha: "abcd1234" },
            { iter: 2, ts: Date.UTC(2025, 0, 1, 0, 0, 30), event: "outcome", outcome: "blocked", reason: "gh_rate_limited" },
            { iter: 3, ts: Date.UTC(2025, 0, 1, 0, 1, 0), event: "outcome", outcome: "complete" },
        ],
    }, { now: Date.UTC(2025, 0, 1, 0, 1, 0) });
    // newest-first means iter 3 comes before iter 1
    const idx3 = out.indexOf("#  3");
    const idx1 = out.indexOf("#  1");
    assert.ok(idx3 > 0 && idx1 > 0 && idx3 < idx1, `expected #3 before #1 in:\n${out}`);
    assert.match(out, /shipped abcd1234/);
    assert.match(out, /blocked: gh_rate_limited/);
    assert.match(out, /complete/);
});

test("renderPlain: focus + streak metadata surfaced when set", () => {
    const out = renderPlain({
        armed: true,
        iter: 0,
        max_iters: 200,
        started_at: 0,
        focus: "shrink the TUI",
        shipper_streak_blocked: 2,
        parse_failure_streak: 1,
        history: [],
    });
    assert.match(out, /focus: shrink the TUI/);
    assert.match(out, /shipper blocked streak: 2/);
    assert.match(out, /parse failure streak: 1/);
});

test("renderPlain: post-stop snapshot reports reason and ran-duration", () => {
    const out = renderPlain({
        armed: false,
        iter: 7,
        max_iters: 200,
        version: "0.7.0",
        stop_reason: "complete",
        last_run: {
            started_at: 1_700_000_000_000,
            finished_at: 1_700_000_120_000,
            iter: 7,
            stop_reason: "complete",
            history: [],
        },
        history: [
            { iter: 7, ts: 1_700_000_120_000, event: "outcome", outcome: "complete" },
        ],
    });
    assert.match(out, /DONE/);
    assert.match(out, /ran 2m/);
    assert.match(out, /reason: complete/);
});
