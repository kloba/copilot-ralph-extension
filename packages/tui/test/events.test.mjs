import { test } from "node:test";
import assert from "node:assert/strict";

import {
    EVENT_TYPES,
    MAX_EVENT_LINE_BYTES,
    foldEvents,
    makeRunId,
    parseEventLine,
    serializeEvent,
} from "../src/events.mjs";

test("EVENT_TYPES is the closed set documented in the issue", () => {
    assert.deepEqual([...EVENT_TYPES], [
        "armed",
        "iteration_start",
        "iteration_end",
        "pause",
        "resume",
        "stagnation",
        "complete",
        "abort",
    ]);
});

test("makeRunId combines label + startedAt", () => {
    assert.equal(makeRunId("ralph_loop", 1700000000000), "ralph_loop-1700000000000");
});

test("makeRunId rejects bad input", () => {
    assert.throws(() => makeRunId("", 1), /non-empty string/);
    assert.throws(() => makeRunId("x", Number.NaN), /finite number/);
});

test("serializeEvent: minimal happy path round-trips through parseEventLine", () => {
    const ev = { type: "armed", ts: 1, runId: "r-1", label: "ralph_loop", maxIterations: 20, minIterations: 5 };
    const line = serializeEvent(ev);
    const back = parseEventLine(line);
    assert.deepEqual(back, ev);
});

test("serializeEvent: drops nullish fields and truncates excerpt to 500 chars", () => {
    const huge = "x".repeat(2000);
    const line = serializeEvent({ type: "iteration_end", ts: 2, runId: "r-1", iteration: 3, excerpt: huge });
    const obj = JSON.parse(line);
    assert.equal(obj.excerpt.length, 500);
    assert.equal(obj.iteration, 3);
    assert.ok(!("note" in obj));
});

test("serializeEvent rejects unknown type", () => {
    assert.throws(
        () => serializeEvent({ type: "weird", ts: 1, runId: "r" }),
        /unknown event type/,
    );
});

test("serializeEvent rejects missing required fields", () => {
    assert.throws(() => serializeEvent({ type: "armed", runId: "r" }), /ts must be/);
    assert.throws(() => serializeEvent({ type: "armed", ts: 1 }), /runId must be/);
});

test("serializeEvent enforces MAX_EVENT_LINE_BYTES", () => {
    const ev = { type: "iteration_end", ts: 1, runId: "r" };
    // The function caps excerpt to 500, so we have to spike a different field.
    ev.note = "x".repeat(MAX_EVENT_LINE_BYTES + 100);
    // note is also truncated to 500; manually overflow via runId instead.
    ev.note = undefined;
    ev.runId = "r" + "x".repeat(MAX_EVENT_LINE_BYTES);
    assert.throws(() => serializeEvent(ev), /exceeds .* bytes/);
});

test("parseEventLine: blank lines yield null", () => {
    assert.equal(parseEventLine(""), null);
    assert.equal(parseEventLine("   \n  "), null);
});

test("parseEventLine: malformed JSON yields null (no throw)", () => {
    assert.equal(parseEventLine("not json"), null);
    assert.equal(parseEventLine("{"), null);
});

test("parseEventLine: rejects unknown event type", () => {
    assert.equal(parseEventLine(JSON.stringify({ type: "weird", ts: 1, runId: "r" })), null);
});

test("parseEventLine: rejects missing runId or ts", () => {
    assert.equal(parseEventLine(JSON.stringify({ type: "armed", ts: 1 })), null);
    assert.equal(parseEventLine(JSON.stringify({ type: "armed", runId: "r" })), null);
});

test("parseEventLine: bad input type throws (programmer error, not data error)", () => {
    assert.throws(() => parseEventLine(42), /must be a string/);
});

test("foldEvents: armed → iteration_start/end → complete produces expected snapshot", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r1", label: "ralph_loop", maxIterations: 20, minIterations: 5 },
        { type: "iteration_start", ts: 110, runId: "r1", iteration: 1 },
        { type: "iteration_end", ts: 120, runId: "r1", iteration: 1, excerpt: "hello", tokens: { input: 100, output: 50 } },
        { type: "iteration_start", ts: 130, runId: "r1", iteration: 2 },
        { type: "iteration_end", ts: 140, runId: "r1", iteration: 2, excerpt: "world", tokens: { input: 200, output: 90 } },
        { type: "complete", ts: 150, runId: "r1", reason: "completion_promise" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.runId, "r1");
    assert.equal(snap.label, "ralph_loop");
    assert.equal(snap.status, "complete");
    assert.equal(snap.reason, "completion_promise");
    assert.equal(snap.iteration, 2);
    assert.equal(snap.maxIterations, 20);
    assert.equal(snap.minIterations, 5);
    assert.equal(snap.lastExcerpt, "world");
    assert.deepEqual(snap.tokens, { input: 200, output: 90 });
    assert.equal(snap.iterations.length, 2);
    assert.equal(snap.iterations[0].excerpt, "hello");
    assert.equal(snap.iterations[1].endedAt, 140);
});

test("foldEvents: pause / resume toggle status without losing progress", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
        { type: "pause", ts: 3, runId: "r" },
    ]);
    assert.equal(snap.status, "paused");
    assert.equal(snap.iteration, 1);
    const resumed = foldEvents([
        ...[
            { type: "armed", ts: 1, runId: "r", label: "self_improve" },
            { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
            { type: "pause", ts: 3, runId: "r" },
            { type: "resume", ts: 4, runId: "r" },
        ],
    ]);
    assert.equal(resumed.status, "running");
});

test("foldEvents: stagnation event records streak", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "ralph_loop" },
        { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
        { type: "stagnation", ts: 3, runId: "r", streak: 3 },
    ]);
    assert.equal(snap.stagnationStreak, 3);
});

test("foldEvents: abort sets status + reason", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "grow_project" },
        { type: "abort", ts: 2, runId: "r", reason: "aborted" },
    ]);
    assert.equal(snap.status, "aborted");
    assert.equal(snap.reason, "aborted");
});

test("foldEvents: a fresh `armed` resets iterations array (replay-with-multiple-runs case)", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r1", label: "ralph_loop" },
        { type: "iteration_start", ts: 2, runId: "r1", iteration: 1 },
        { type: "iteration_end", ts: 3, runId: "r1", iteration: 1, excerpt: "old" },
        { type: "complete", ts: 4, runId: "r1", reason: "max_iterations" },
        { type: "armed", ts: 5, runId: "r2", label: "self_improve" },
        { type: "iteration_start", ts: 6, runId: "r2", iteration: 1 },
    ]);
    assert.equal(snap.runId, "r2");
    assert.equal(snap.label, "self_improve");
    assert.equal(snap.iterations.length, 1);
    assert.equal(snap.iterations[0].iteration, 1);
});

test("foldEvents: rejects non-array input", () => {
    assert.throws(() => foldEvents(null), /must be an array/);
});
