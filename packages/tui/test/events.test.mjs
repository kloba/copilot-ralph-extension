import { test } from "node:test";
import assert from "node:assert/strict";

import {
    EVENT_TYPES,
    MAX_EVENT_LINE_BYTES,
    foldEvents,
    makeRunId,
    parseEventLine,
    safeSliceChars,
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

// Iter 117 — serializeEvent's excerpt/note truncation must not split a
// UTF-16 surrogate pair at the 500-char boundary. Mirrors iter 115's
// fix on the writer side (extension/events-emit.mjs's clipExcerpt) so
// every disk writer in the workspace is surrogate-safe — defence in
// depth: events-emit.mjs already pre-truncates, but a malicious or
// malformed >500-char `excerpt`/`note` reaching this serializer (e.g.
// via a future TUI-emitted event or a third-party consumer of
// serializeEvent) must not produce a lone high surrogate.
test("serializeEvent: excerpt truncation does not split a surrogate pair at the 500-char boundary", () => {
    // Place 💀 (U+1F480, two code units 0xD83D + 0xDC80) at indices
    // 499..500 so a naïve `s.slice(0, 500)` would keep the high
    // surrogate at 499 and drop the low surrogate at 500.
    const skull = String.fromCharCode(0xD83D, 0xDC80);
    const excerpt = "x".repeat(499) + skull + skull.repeat(20);
    assert.equal(excerpt.charCodeAt(499), 0xD83D, "test setup: index 499 must be the high surrogate");
    assert.equal(excerpt.charCodeAt(500), 0xDC80, "test setup: index 500 must be the low surrogate");
    const line = serializeEvent({
        type: "iteration_end",
        ts: 1,
        runId: "r",
        iteration: 1,
        excerpt,
    });
    const parsed = JSON.parse(line);
    // Walk every code unit of `parsed.excerpt`: every high surrogate
    // must be immediately followed by a low surrogate.
    for (let i = 0; i < parsed.excerpt.length; i++) {
        const c = parsed.excerpt.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            const next = parsed.excerpt.charCodeAt(i + 1);
            assert.ok(
                next >= 0xDC00 && next <= 0xDFFF,
                `lone high surrogate at index ${i} (next code unit: 0x${(next || 0).toString(16)}) — serializeEvent split a surrogate pair`,
            );
            i += 1;
        } else {
            assert.ok(
                !(c >= 0xDC00 && c <= 0xDFFF),
                `unmatched low surrogate at index ${i} — serializeEvent produced an invalid UTF-16 string`,
            );
        }
    }
    // Length stays ≤ 500 (the guard can only ever shrink the result).
    assert.ok(parsed.excerpt.length <= 500, `clipped excerpt length must stay ≤ 500 (got ${parsed.excerpt.length})`);
});

test("serializeEvent: note truncation is also surrogate-safe", () => {
    // Same construction targeting `note` rather than `excerpt`. Both
    // fields share the truncation helper, so the guard applies to both.
    const skull = String.fromCharCode(0xD83D, 0xDC80);
    const note = "y".repeat(499) + skull + skull.repeat(10);
    const line = serializeEvent({
        type: "abort",
        ts: 1,
        runId: "r",
        reason: "user_stop",
        iteration: 1,
        note,
    });
    const parsed = JSON.parse(line);
    for (let i = 0; i < parsed.note.length; i++) {
        const c = parsed.note.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            const next = parsed.note.charCodeAt(i + 1);
            assert.ok(next >= 0xDC00 && next <= 0xDFFF, `lone high surrogate in note at index ${i}`);
            i += 1;
        } else {
            assert.ok(!(c >= 0xDC00 && c <= 0xDFFF), `unmatched low surrogate in note at index ${i}`);
        }
    }
    assert.ok(parsed.note.length <= 500);
});

// Iter 120 — direct unit-test coverage for `safeSliceChars`'s defensive
// guards (extracted in iter 119). Two callers wire it up today
// (serializeEvent's 500-char excerpt/note cap, plain.mjs's 80-char
// excerpt cap) — both pass well-formed string + finite max. The
// helper's non-string / non-finite-max / max<1 fall-through branches
// were added defensively against future callers and are not exercised
// by either of the existing two callers' regression tests. Without a
// direct unit test pinning them, a "simplify safeSliceChars" PR could
// silently drop the guards (e.g. assume the caller always passes a
// string), and an accidental call site like `safeSliceChars(null, 80)`
// would start throwing TypeError on `s.length` lookup.
test("safeSliceChars: non-string input is returned unchanged", () => {
    // Covers every typeof JS could give us. Each must round-trip to
    // the same identity (===) — no coercion, no throw.
    assert.equal(safeSliceChars(null, 80), null);
    assert.equal(safeSliceChars(undefined, 80), undefined);
    assert.equal(safeSliceChars(42, 80), 42);
    assert.equal(safeSliceChars(true, 80), true);
    const obj = { a: 1 };
    assert.equal(safeSliceChars(obj, 80), obj, "object identity preserved");
});

test("safeSliceChars: non-finite or invalid max is returned unchanged", () => {
    // NaN, Infinity, -Infinity, 0, negative integers — none are valid
    // truncation lengths. The helper must return the original string
    // verbatim rather than fall through to a slice with a bogus index
    // (e.g. `s.slice(0, NaN)` returns "" — a silent data-loss bug).
    const long = "x".repeat(200);
    assert.equal(safeSliceChars(long, NaN), long);
    assert.equal(safeSliceChars(long, Infinity), long);
    assert.equal(safeSliceChars(long, -Infinity), long);
    assert.equal(safeSliceChars(long, 0), long);
    assert.equal(safeSliceChars(long, -1), long);
});

test("safeSliceChars: short input (length <= max) is returned unchanged", () => {
    // No allocation, no slice — the existing serializeEvent test on
    // a sub-500-char excerpt relies on this fast-path. Pin it so a
    // future "always slice" simplification can't slow the common case.
    assert.equal(safeSliceChars("hi", 80), "hi");
    assert.equal(safeSliceChars("x".repeat(80), 80), "x".repeat(80), "boundary equality");
});

test("safeSliceChars: ASCII input at the boundary is sliced to exactly max", () => {
    // No surrogate involved; result length must be exactly `max`.
    const s = "x".repeat(200);
    assert.equal(safeSliceChars(s, 80).length, 80);
    assert.equal(safeSliceChars(s, 1).length, 1);
});

test("safeSliceChars: high surrogate at the boundary backs off by one", () => {
    // U+1F480 (💀) — high+low = 0xD83D + 0xDC80. Place high surrogate
    // at index max-1 so the helper backs off (length = max-1).
    const skull = String.fromCharCode(0xD83D, 0xDC80);
    const s = "x".repeat(79) + skull + skull.repeat(20);
    assert.equal(s.charCodeAt(79), 0xD83D, "test setup: high surrogate at index 79");
    const out = safeSliceChars(s, 80);
    assert.equal(out.length, 79, "backed off by one to keep the surrogate pair intact");
    // Last code unit is the LAST `x` (the 79th), not the high surrogate.
    assert.equal(out.charCodeAt(out.length - 1), "x".charCodeAt(0));
});

test("safeSliceChars: low surrogate at the boundary is fine (no back-off)", () => {
    // If the BMP/4-byte char ENDS at index max-1 (i.e. low surrogate
    // at max-1, high surrogate at max-2), the helper must NOT back off
    // — the pair is fully retained. Cover this corner so a future
    // refactor that tightens the check doesn't regress to backing off
    // unnecessarily.
    const skull = String.fromCharCode(0xD83D, 0xDC80);
    // Place the pair at indices 78..79, then plain x's after.
    const s = "x".repeat(78) + skull + "x".repeat(120);
    assert.equal(s.charCodeAt(78), 0xD83D);
    assert.equal(s.charCodeAt(79), 0xDC80);
    const out = safeSliceChars(s, 80);
    assert.equal(out.length, 80, "no back-off when boundary lands AFTER a complete pair");
    // The pair must still be intact in the output.
    assert.equal(out.charCodeAt(78), 0xD83D);
    assert.equal(out.charCodeAt(79), 0xDC80);
});

test("serializeEvent: reason field is capped at 500 chars (defensive symmetry with note/excerpt)", () => {
    // Iter 139 hardening: caller hygiene (parseUserReason → boundedNoteForLog
    // in handler.mjs) already caps user-supplied reasons at 500 chars, but
    // the event serializer must enforce its own ceiling so a future code
    // path emitting `reason` directly cannot blow past the 16 KB per-line
    // limit on a single pathological input. Mirrors the existing
    // safeSliceChars(…, 500) treatment of `note` and `excerpt`.

    // (a) overflow: 600-char reason is truncated to exactly 500 chars.
    const overflow = "x".repeat(600);
    const lineOver = serializeEvent({
        type: "abort",
        ts: 1_000_000,
        runId: "ralph_loop-cap",
        reason: overflow,
    });
    const parsedOver = JSON.parse(lineOver);
    assert.equal(parsedOver.reason.length, 500,
        `overflow reason must be capped at 500 chars; got ${parsedOver.reason.length} for input of ${overflow.length}`);
    assert.ok(parsedOver.reason.startsWith("x"),
        `truncation must keep the leading bytes (left-trim is wrong; we anchor on the start of the string)`);

    // (b) under-cap: 100-char reason passes through unchanged.
    const small = "y".repeat(100);
    const lineSmall = serializeEvent({
        type: "abort",
        ts: 1_000_000,
        runId: "ralph_loop-cap",
        reason: small,
    });
    const parsedSmall = JSON.parse(lineSmall);
    assert.equal(parsedSmall.reason, small,
        `under-cap reasons must pass through unchanged so existing baked tokens (completion_promise, abort_promise, stagnation, max_iterations, …) are not silently rewritten`);

    // (c) surrogate-pair safety: a reason whose 500th char would split a
    // surrogate pair must back off so the rendered line is still valid
    // UTF-16. Build a string of 499 ASCII + one 4-byte emoji (2 UTF-16
    // code units) — the natural slice at 500 would land between the
    // high and low surrogate; safeSliceChars must back off to 499.
    const head = "a".repeat(499);
    const tricky = head + "\u{1F480}"; // 💀 (U+1F480 = surrogate pair)
    assert.equal(tricky.length, 501, "sanity: tricky string is 501 UTF-16 code units (499 + 2)");
    const lineTricky = serializeEvent({
        type: "abort",
        ts: 1_000_000,
        runId: "ralph_loop-cap",
        reason: tricky,
    });
    const parsedTricky = JSON.parse(lineTricky);
    assert.equal(parsedTricky.reason.length, 499,
        `surrogate-pair-aware truncation must back off to 499 (drop the entire emoji) rather than emit a lone high surrogate at index 499; got ${parsedTricky.reason.length}`);

    // (d) the 16 KB per-line ceiling holds for a maxed-out reason.
    // Even a 500-char reason combined with the rest of the event shape
    // must stay well under MAX_EVENT_LINE_BYTES.
    assert.ok(Buffer.byteLength(lineOver, "utf8") < MAX_EVENT_LINE_BYTES,
        `capped event line must stay under MAX_EVENT_LINE_BYTES (${MAX_EVENT_LINE_BYTES}); got ${Buffer.byteLength(lineOver, "utf8")}`);
});
