import { test } from "node:test";
import assert from "node:assert/strict";

import { formatEventLine, formatTimestamp } from "../src/plain.mjs";

test("formatTimestamp: pads each field, UTC, ms precision", () => {
    assert.equal(formatTimestamp(0), "00:00:00.000");
    // 1970-01-01T01:02:03.456Z
    assert.equal(formatTimestamp(3723456), "01:02:03.456");
});

test("formatTimestamp: non-finite → ?? sentinel", () => {
    assert.equal(formatTimestamp(NaN), "??:??:??.???");
    assert.equal(formatTimestamp(undefined), "??:??:??.???");
});

test("formatEventLine: armed includes max/min", () => {
    const line = formatEventLine({
        type: "armed",
        ts: 0,
        runId: "ralph_loop-0",
        maxIterations: 5,
        minIterations: 2,
    });
    assert.match(line, /00:00:00\.000\s+armed\s+ralph_loop-0/);
    assert.match(line, /min=2/);
});

test("formatEventLine: iteration_end renders tokens + excerpt", () => {
    const line = formatEventLine({
        type: "iteration_end",
        ts: 0,
        runId: "r-1",
        iteration: 3,
        maxIterations: 10,
        tokens: { input: 10, output: 20 },
        excerpt: "the\nquick\tbrown   fox",
    });
    assert.match(line, /iter-/);
    assert.match(line, /iter=3\/10/);
    assert.match(line, /tokens=10\/20/);
    // Whitespace collapsed to single spaces inside excerpt.
    assert.match(line, /excerpt="the quick brown fox"/);
});

test("formatEventLine: stagnation surfaces streak", () => {
    const line = formatEventLine({
        type: "stagnation",
        ts: 0,
        runId: "r-1",
        iteration: 4,
        streak: 3,
    });
    assert.match(line, /streak=3/);
});

test("formatEventLine: complete includes reason + note", () => {
    const line = formatEventLine({
        type: "complete",
        ts: 0,
        runId: "r-1",
        iteration: 7,
        reason: "completion_promise",
        note: "shipped",
    });
    assert.match(line, /reason=completion_promise/);
    assert.match(line, /note="shipped"/);
});

test("formatEventLine: empty/garbage event → empty string", () => {
    assert.equal(formatEventLine(null), "");
    assert.equal(formatEventLine(undefined), "");
    assert.equal(formatEventLine("nope"), "");
});

test("formatEventLine: unknown type still renders something", () => {
    // Defence in depth — if a future event slips past parseEventLine the
    // plain renderer still produces a row instead of a blank line.
    const line = formatEventLine({ type: "future_kind", ts: 0, runId: "r-1" });
    assert.match(line, /future_kind/);
});

test("formatEventLine: caps long excerpt at 80 chars", () => {
    const long = "x".repeat(200);
    const line = formatEventLine({
        type: "iteration_end",
        ts: 0,
        runId: "r-1",
        iteration: 1,
        excerpt: long,
    });
    const m = line.match(/excerpt="([^"]*)"/);
    assert.ok(m, "excerpt segment present");
    assert.equal(m[1].length, 80);
});
