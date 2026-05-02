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
        // Issue #48 slice 1 — three-level hierarchy event vocabulary.
        // Strictly additive; the eight pre-existing types above must
        // never reorder or drop so historical events.jsonl files
        // replay through this reader unchanged.
        "stage_start",
        "stage_end",
        "substage",
        "backlog_snapshot",
        // Issue #48 slice 3 — L1 work-item events. Names the single
        // issue / PR / red CI run the loop is currently fixing so
        // the TUI header can render `work item: issue #42 …` and
        // so a replay can compute "(N already closed by loop)"
        // purely from the event stream without re-running `gh`.
        "workitem_start",
        "workitem_end",
        // Issue #48 slice 9 — flex stage plan + per-stage task list +
        // one-task-per-iter cursor + LastCommit footer. Strictly
        // additive (appended below the slice-3 work-item pair); the
        // older 14 types above must never reorder so historical
        // events.jsonl files keep replaying unchanged.
        "stage_plan",
        "stage_plan_amend",
        "task_list",
        "task_start",
        "task_end",
        "commit_observed",
        // TUI tokens + premium-request live update. Strictly
        // additive (appended at end); see `usage_update` semantics
        // in events.mjs.
        "usage_update",
        // Issue #57 — live-output panel. Surfaces the Copilot CLI
        // session id (captured by `runner.mjs` from the active iter's
        // terminal `result.sessionId`) so the TUI can mount a tail
        // against `~/.copilot/session-state/<sessionId>.jsonl`.
        // Strictly additive — older runs without the event still
        // replay through this reader unchanged; the panel just shows
        // its "(waiting for session)" empty state.
        "session_attached",
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

// ─── terminalAt: pins the run's end-of-life timestamp ────────────
// `terminalAt` is set strictly from the `complete` / `abort` event's
// own `ts`, not from generic `updatedAt` (which would shift if a
// late/replayed event arrived after termination). The TUI's Header
// reads this field to freeze the elapsed-clock display at the
// run's actual end ts.

test("foldEvents: complete sets terminalAt to the event's ts", () => {
    const snap = foldEvents([
        { type: "armed", ts: 100, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 110, runId: "r", iteration: 1 },
        { type: "complete", ts: 200, runId: "r", reason: "completion_promise" },
    ]);
    assert.equal(snap.status, "complete");
    assert.equal(snap.terminalAt, 200);
});

test("foldEvents: abort sets terminalAt to the event's ts", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "grow_project" },
        { type: "abort", ts: 50, runId: "r", reason: "user_quit" },
    ]);
    assert.equal(snap.status, "aborted");
    assert.equal(snap.terminalAt, 50);
});

test("foldEvents: terminalAt is null pre-termination", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "ralph_loop" },
        { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
    ]);
    assert.equal(snap.terminalAt, null);
});

test("foldEvents: a fresh `armed` resets terminalAt for the new run", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r1", label: "ralph_loop" },
        { type: "complete", ts: 2, runId: "r1", reason: "promise" },
        { type: "armed", ts: 3, runId: "r2", label: "self_improve" },
    ]);
    assert.equal(snap.runId, "r2");
    assert.equal(snap.terminalAt, null,
        "fresh armed must wipe the previous run's terminalAt");
});

test("foldEvents: terminalAt is NOT shifted by a late post-termination event", () => {
    // Replay / out-of-band scenario: a stray event arrives with a
    // `ts` greater than the terminal event's `ts`. `updatedAt` will
    // (correctly) advance, but `terminalAt` must stay pinned to the
    // moment the run actually ended so the Header's elapsed counter
    // doesn't appear to keep ticking after `complete`.
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "complete", ts: 100, runId: "r", reason: "promise" },
        { type: "usage_update", ts: 9_999_999, runId: "r", iteration: 1, tokens: { input: 1, output: 1 } },
    ]);
    assert.equal(snap.terminalAt, 100,
        "terminalAt stays pinned to the complete event's ts even when later events arrive");
    assert.equal(snap.updatedAt, 9_999_999,
        "updatedAt still tracks the latest event observed (sanity)");
});

test("foldEvents: rejects non-array input", () => {
    assert.throws(() => foldEvents(null), /must be an array/);
});

// serializeEvent's excerpt/note truncation must not split a UTF-16
// surrogate pair at the 500-char boundary. Mirrors the writer-side
// fix in `events-emit.mjs`'s clipExcerpt so every disk writer in the
// workspace is surrogate-safe — defence in depth: events-emit.mjs
// already pre-truncates, but a malicious or malformed >500-char
// `excerpt`/`note` reaching this serializer must not produce a lone
// high surrogate.
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

// ─── Issue #48 slice 1: stage / substage / backlog event vocabulary ──

test("serializeEvent: stage_start round-trips iteration + stage + stageName", () => {
    const ev = { type: "stage_start", ts: 7, runId: "r-1", iteration: 4, stage: 1, stageName: "ORIENT" };
    const back = parseEventLine(serializeEvent(ev));
    assert.deepEqual(back, ev);
});

test("serializeEvent: stage_end round-trips with durationMs + outcome", () => {
    const ev = {
        type: "stage_end", ts: 10, runId: "r-1", iteration: 4, stage: 1,
        stageName: "ORIENT", durationMs: 3407, outcome: "ok",
    };
    const back = parseEventLine(serializeEvent(ev));
    assert.deepEqual(back, ev);
});

test("serializeEvent: substage round-trips verb + argsSummary + outcome + durationMs", () => {
    const ev = {
        type: "substage", ts: 20, runId: "r-1", iteration: 4, stage: 5, sub: 3,
        verb: "edit", argsSummary: "packages/tui/src/runner.mjs (-12, +18)",
        outcome: "ok", durationMs: 412,
    };
    const back = parseEventLine(serializeEvent(ev));
    assert.deepEqual(back, ev);
});

test("serializeEvent: substage clips an oversized argsSummary at 500 chars", () => {
    const huge = "x".repeat(2000);
    const line = serializeEvent({ type: "substage", ts: 1, runId: "r", iteration: 1, stage: 1, sub: 1, argsSummary: huge });
    const obj = JSON.parse(line);
    assert.equal(obj.argsSummary.length, 500);
});

test("serializeEvent: backlog_snapshot round-trips all four counters", () => {
    const ev = {
        type: "backlog_snapshot", ts: 30, runId: "r-1",
        redCi: 0, openPrs: 2, openIssues: 11, closedByLoop: 3,
    };
    const back = parseEventLine(serializeEvent(ev));
    assert.deepEqual(back, ev);
});

test("serializeEvent: backlog_snapshot drops missing counters (null != 0)", () => {
    // Distinguishes "we never probed" from "we probed and found 0" so
    // the header can render `?` vs `0` appropriately.
    const line = serializeEvent({ type: "backlog_snapshot", ts: 1, runId: "r", openPrs: 5 });
    const obj = JSON.parse(line);
    assert.equal(obj.openPrs, 5);
    assert.ok(!("redCi" in obj));
    assert.ok(!("openIssues" in obj));
    assert.ok(!("closedByLoop" in obj));
});

test("foldEvents: stage_start sets activeStage and clears currentStageSubstages", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
        { type: "stage_start", ts: 3, runId: "r", iteration: 1, stage: 1, stageName: "ORIENT" },
    ]);
    assert.deepEqual(snap.activeStage, { stage: 1, name: "ORIENT", startedAt: 3 });
    assert.deepEqual(snap.currentStageSubstages, []);
    assert.deepEqual(snap.recentStages, []);
});

test("foldEvents: stage_end appends to recentStages with computed durationMs", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
        { type: "stage_start", ts: 100, runId: "r", iteration: 1, stage: 1, stageName: "ORIENT" },
        { type: "stage_end", ts: 150, runId: "r", iteration: 1, stage: 1, stageName: "ORIENT", outcome: "ok" },
    ]);
    assert.equal(snap.activeStage, null);
    assert.equal(snap.recentStages.length, 1);
    assert.deepEqual(snap.recentStages[0], {
        stage: 1, name: "ORIENT", startedAt: 100, endedAt: 150, durationMs: 50, outcome: "ok",
    });
});

test("foldEvents: substage events accumulate on currentStageSubstages and reset on next stage_start", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
        { type: "stage_start", ts: 3, runId: "r", iteration: 1, stage: 1, stageName: "ORIENT" },
        { type: "substage", ts: 4, runId: "r", iteration: 1, stage: 1, sub: 1, verb: "shell", argsSummary: "git log -20", outcome: "ok" },
        { type: "substage", ts: 5, runId: "r", iteration: 1, stage: 1, sub: 2, verb: "gh", argsSummary: "gh run list", outcome: "ok" },
        { type: "stage_end", ts: 6, runId: "r", iteration: 1, stage: 1, stageName: "ORIENT", outcome: "ok" },
        { type: "stage_start", ts: 7, runId: "r", iteration: 1, stage: 2, stageName: "IDEATE" },
        { type: "substage", ts: 8, runId: "r", iteration: 1, stage: 2, sub: 1, verb: "view", argsSummary: "AGENTS.md", outcome: "ok" },
    ]);
    assert.equal(snap.activeStage.name, "IDEATE");
    assert.equal(snap.currentStageSubstages.length, 1, "substages reset on new stage_start");
    assert.equal(snap.currentStageSubstages[0].verb, "view");
    assert.equal(snap.recentStages.length, 1, "previous stage stays in recentStages");
});

test("foldEvents: iteration_start clears active+recent stages and substages", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
        { type: "stage_start", ts: 3, runId: "r", iteration: 1, stage: 1, stageName: "ORIENT" },
        { type: "stage_end", ts: 5, runId: "r", iteration: 1, stage: 1, stageName: "ORIENT", outcome: "ok" },
        { type: "iteration_end", ts: 6, runId: "r", iteration: 1 },
        { type: "iteration_start", ts: 7, runId: "r", iteration: 2 },
    ]);
    assert.equal(snap.activeStage, null);
    assert.deepEqual(snap.recentStages, [], "recentStages clears at the new iter boundary");
    assert.deepEqual(snap.currentStageSubstages, []);
});

test("foldEvents: backlog_snapshot replaces the whole record", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "backlog_snapshot", ts: 2, runId: "r", redCi: 0, openPrs: 2, openIssues: 11, closedByLoop: 3 },
        { type: "backlog_snapshot", ts: 5, runId: "r", redCi: 0, openPrs: 2, openIssues: 8, closedByLoop: 6 },
    ]);
    assert.deepEqual(snap.backlog, { redCi: 0, openPrs: 2, openIssues: 8, closedByLoop: 6 });
});

test("foldEvents: backlog_snapshot with missing fields renders them as null (not 0)", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "backlog_snapshot", ts: 2, runId: "r", openPrs: 5 },
    ]);
    assert.deepEqual(snap.backlog, { redCi: null, openPrs: 5, openIssues: null, closedByLoop: null });
});

test("foldEvents: armed resets all stage / substage / backlog state (replay-with-multiple-runs case)", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r1", label: "self_improve" },
        { type: "stage_start", ts: 2, runId: "r1", iteration: 1, stage: 1, stageName: "ORIENT" },
        { type: "substage", ts: 3, runId: "r1", iteration: 1, stage: 1, sub: 1, verb: "shell", argsSummary: "git log" },
        { type: "stage_end", ts: 4, runId: "r1", iteration: 1, stage: 1 },
        { type: "backlog_snapshot", ts: 5, runId: "r1", openPrs: 3 },
        { type: "armed", ts: 100, runId: "r2", label: "self_improve" },
    ]);
    assert.equal(snap.runId, "r2");
    assert.equal(snap.activeStage, null);
    assert.deepEqual(snap.recentStages, []);
    assert.deepEqual(snap.currentStageSubstages, []);
    assert.equal(snap.backlog, null);
});

// ─── Issue #48 slice 2: stage marker / prompt parity guards ──────────

import {
    SDLC_STAGES_SELF_IMPROVE,
    SDLC_STAGES_GROW_PROJECT,
    stagesForLabel,
} from "../src/events.mjs";
import { PROMPT_SELF_IMPROVE, PROMPT_GROW_PROJECT } from "../src/prompts.mjs";

test("SDLC_STAGES_SELF_IMPROVE: every stage name appears in PROMPT_SELF_IMPROVE", () => {
    for (const stage of SDLC_STAGES_SELF_IMPROVE) {
        assert.ok(
            PROMPT_SELF_IMPROVE.includes(`[STAGE: ${stage}]`),
            `PROMPT_SELF_IMPROVE missing marker [STAGE: ${stage}] — drift between events.mjs stage list and the baked prompt body`,
        );
    }
});

test("SDLC_STAGES_GROW_PROJECT: every stage name appears in PROMPT_GROW_PROJECT", () => {
    for (const stage of SDLC_STAGES_GROW_PROJECT) {
        assert.ok(
            PROMPT_GROW_PROJECT.includes(`[STAGE: ${stage}]`),
            `PROMPT_GROW_PROJECT missing marker [STAGE: ${stage}] — drift between events.mjs stage list and the baked prompt body`,
        );
    }
});

test("stagesForLabel: maps labels to their canonical lists; unknown → null", () => {
    assert.equal(stagesForLabel("self_improve"), SDLC_STAGES_SELF_IMPROVE);
    assert.equal(stagesForLabel("grow_project"), SDLC_STAGES_GROW_PROJECT);
    assert.equal(stagesForLabel("ralph_loop"), null, "ralph_loop / custom-prompt mode has no fixed stage list");
    assert.equal(stagesForLabel(undefined), null);
    assert.equal(stagesForLabel(""), null);
});

test("PROMPT_SELF_IMPROVE / PROMPT_GROW_PROJECT explicitly instruct the agent to emit stage markers", () => {
    // Pin the literal string so a future edit can't strip the
    // instruction without the test catching it. The runner depends on
    // the agent emitting these markers — without the instruction,
    // the live UI silently degrades to "no stage info".
    assert.match(PROMPT_SELF_IMPROVE, /STAGE MARKERS/, "PROMPT_SELF_IMPROVE must declare a STAGE MARKERS section");
    assert.match(PROMPT_SELF_IMPROVE, /\[STAGE: ORIENT\]/, "PROMPT_SELF_IMPROVE must include the literal [STAGE: ORIENT] example");
    assert.match(PROMPT_GROW_PROJECT, /STAGE MARKERS/, "PROMPT_GROW_PROJECT must declare a STAGE MARKERS section");
    assert.match(PROMPT_GROW_PROJECT, /\[STAGE: SELECT\]/, "PROMPT_GROW_PROJECT must include the literal [STAGE: SELECT] example");
});

// ─── Issue #48 slice 3: L1 work-item event vocabulary ────────────────

import { WORKITEM_KINDS } from "../src/events.mjs";

test("WORKITEM_KINDS is the closed enum from the issue body", () => {
    assert.deepEqual([...WORKITEM_KINDS], ["issue", "pr", "red_ci"]);
});

test("serializeEvent: workitem_start round-trips kind + ref + title", () => {
    const ev = {
        type: "workitem_start", ts: 100, runId: "r-1", iteration: 4,
        kind: "issue", ref: 42, title: "fix flaky parser test",
    };
    const back = parseEventLine(serializeEvent(ev));
    assert.deepEqual(back, ev);
});

test("serializeEvent: workitem_start accepts the pr and red_ci kinds", () => {
    const pr = parseEventLine(serializeEvent({
        type: "workitem_start", ts: 1, runId: "r", kind: "pr", ref: 41, title: "feat: extract gitExec",
    }));
    assert.equal(pr.kind, "pr");
    const red = parseEventLine(serializeEvent({
        type: "workitem_start", ts: 1, runId: "r", kind: "red_ci", ref: 1234, title: "Deploy docs site #1234",
    }));
    assert.equal(red.kind, "red_ci");
});

test("serializeEvent: workitem_start rejects an unknown kind", () => {
    assert.throws(
        () => serializeEvent({ type: "workitem_start", ts: 1, runId: "r", kind: "epic", ref: 1 }),
        /requires kind in \["issue","pr","red_ci"\]/,
    );
});

test("serializeEvent: workitem_end requires a kind too (symmetric validation)", () => {
    assert.throws(
        () => serializeEvent({ type: "workitem_end", ts: 1, runId: "r" }),
        /workitem_end requires kind/,
    );
});

test("serializeEvent: workitem_end round-trips kind + ref + closesN", () => {
    const ev = {
        type: "workitem_end", ts: 200, runId: "r-1", iteration: 8,
        kind: "issue", ref: 42, closesN: 42,
    };
    const back = parseEventLine(serializeEvent(ev));
    assert.deepEqual(back, ev);
});

test("serializeEvent: workitem_start clips an oversized title at 200 chars", () => {
    const huge = "x".repeat(2000);
    const line = serializeEvent({ type: "workitem_start", ts: 1, runId: "r", kind: "issue", ref: 1, title: huge });
    const obj = JSON.parse(line);
    assert.equal(obj.title.length, 200);
});

test("serializeEvent: workitem_start drops absent ref / title (workitem_start with kind only is valid)", () => {
    const line = serializeEvent({ type: "workitem_start", ts: 1, runId: "r", kind: "red_ci" });
    const obj = JSON.parse(line);
    assert.equal(obj.kind, "red_ci");
    assert.ok(!("ref" in obj), "absent ref must not be serialized as 0");
    assert.ok(!("title" in obj), "absent title must not be serialized as null");
});

test("foldEvents: workitem_start sets activeWorkItem; workitem_end clears it and appends to completedWorkItems", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "workitem_start", ts: 10, runId: "r", iteration: 1, kind: "issue", ref: 42, title: "fix flaky parser test" },
    ]);
    assert.deepEqual(snap.activeWorkItem, {
        kind: "issue", ref: 42, title: "fix flaky parser test", startedAt: 10,
    });
    assert.deepEqual(snap.completedWorkItems, []);

    const snap2 = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "workitem_start", ts: 10, runId: "r", iteration: 1, kind: "issue", ref: 42, title: "fix flaky parser test" },
        { type: "workitem_end", ts: 50, runId: "r", iteration: 1, kind: "issue", ref: 42, closesN: 42 },
    ]);
    assert.equal(snap2.activeWorkItem, null);
    assert.equal(snap2.completedWorkItems.length, 1);
    assert.deepEqual(snap2.completedWorkItems[0], {
        kind: "issue", ref: 42, title: "fix flaky parser test",
        startedAt: 10, endedAt: 50, closesN: 42,
    });
    assert.equal(snap2.closedByLoop, 1, "workitem_end with closesN bumps the closedByLoop counter");
});

test("foldEvents: workitem_end without closesN does not bump closedByLoop (PR merge / CI green isn't a closed issue)", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "workitem_start", ts: 10, runId: "r", kind: "pr", ref: 41, title: "feat: gitExec" },
        { type: "workitem_end", ts: 50, runId: "r", kind: "pr", ref: 41 },
    ]);
    assert.equal(snap.closedByLoop, 0);
    assert.equal(snap.completedWorkItems.length, 1);
    assert.equal(snap.completedWorkItems[0].closesN, null);
});

test("foldEvents: multiple workitem cycles accumulate on completedWorkItems", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "workitem_start", ts: 10, runId: "r", kind: "issue", ref: 1, title: "a" },
        { type: "workitem_end", ts: 20, runId: "r", kind: "issue", ref: 1, closesN: 1 },
        { type: "workitem_start", ts: 30, runId: "r", kind: "issue", ref: 2, title: "b" },
        { type: "workitem_end", ts: 40, runId: "r", kind: "issue", ref: 2, closesN: 2 },
        { type: "workitem_start", ts: 50, runId: "r", kind: "pr", ref: 41 },
        { type: "workitem_end", ts: 60, runId: "r", kind: "pr", ref: 41 },
    ]);
    assert.equal(snap.completedWorkItems.length, 3);
    assert.equal(snap.closedByLoop, 2, "PR end without closesN doesn't bump");
    assert.equal(snap.activeWorkItem, null);
});

test("foldEvents: armed clears active + completed work items and resets closedByLoop (replay across runs)", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r1", label: "self_improve" },
        { type: "workitem_start", ts: 10, runId: "r1", kind: "issue", ref: 1, title: "a" },
        { type: "workitem_end", ts: 20, runId: "r1", kind: "issue", ref: 1, closesN: 1 },
        { type: "armed", ts: 100, runId: "r2", label: "self_improve" },
    ]);
    assert.equal(snap.runId, "r2");
    assert.equal(snap.activeWorkItem, null);
    assert.deepEqual(snap.completedWorkItems, []);
    assert.equal(snap.closedByLoop, 0);
});

test("foldEvents: workitem_end with no preceding workitem_start still appends (mid-run replay)", () => {
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "workitem_end", ts: 50, runId: "r", kind: "issue", ref: 42, closesN: 42 },
    ]);
    assert.equal(snap.completedWorkItems.length, 1);
    assert.equal(snap.completedWorkItems[0].startedAt, null,
        "no preceding workitem_start ⇒ startedAt is null, not a stale value");
    assert.equal(snap.closedByLoop, 1);
});

test("foldEvents: workitem_end with mismatched (kind, ref) does NOT clear activeWorkItem", () => {
    // Defensive against a runner bug emitting workitem_end for the
    // wrong unit. The current item must stay active so the renderer
    // doesn't blank out mid-iter.
    const snap = foldEvents([
        { type: "armed", ts: 1, runId: "r", label: "self_improve" },
        { type: "workitem_start", ts: 10, runId: "r", kind: "issue", ref: 42, title: "active" },
        { type: "workitem_end", ts: 50, runId: "r", kind: "issue", ref: 99 },
    ]);
    assert.deepEqual(snap.activeWorkItem, {
        kind: "issue", ref: 42, title: "active", startedAt: 10,
    });
    // The mismatched end still appends to completedWorkItems — it
    // happened, even if it's an orphan. The renderer can decide
    // whether to surface it.
    assert.equal(snap.completedWorkItems.length, 1);
    assert.equal(snap.completedWorkItems[0].ref, 99);
});

// ---------------------------------------------------------------------------
// Issue #48 slice 9 — flex stage plan + per-stage task list +
// one-task-per-iter cursor + LastCommit footer.
// ---------------------------------------------------------------------------

import {
    PINNED_TAIL_STAGES,
    TASK_OUTCOMES,
    enforcePinnedTail,
} from "../src/events.mjs";

test("slice9: PINNED_TAIL_STAGES is the canonical [COMMIT, PUSH, END] tuple", () => {
    assert.deepEqual([...PINNED_TAIL_STAGES], ["COMMIT", "PUSH", "END"]);
    assert.ok(Object.isFrozen(PINNED_TAIL_STAGES),
        "PINNED_TAIL_STAGES must be frozen so a downstream consumer cannot mutate it");
});

test("slice9: TASK_OUTCOMES is the closed enum [ok, fail, skip]", () => {
    assert.deepEqual([...TASK_OUTCOMES], ["ok", "fail", "skip"]);
});

test("slice9: enforcePinnedTail appends [COMMIT, PUSH, END] when missing", () => {
    const r = enforcePinnedTail(["PLAN", "IMPLEMENT", "TEST"]);
    assert.deepEqual([...r.stages], ["PLAN", "IMPLEMENT", "TEST", "COMMIT", "PUSH", "END"]);
    assert.equal(r.repaired, true,
        "appending the pinned tail must mark the result as repaired so the runner emits a stage_plan_amend");
});

test("slice9: enforcePinnedTail leaves a correctly-tailed plan untouched and unrepaired", () => {
    const r = enforcePinnedTail(["PLAN", "IMPLEMENT", "TEST", "COMMIT", "PUSH", "END"]);
    assert.deepEqual([...r.stages], ["PLAN", "IMPLEMENT", "TEST", "COMMIT", "PUSH", "END"]);
    assert.equal(r.repaired, false);
});

test("slice9: enforcePinnedTail strips and re-appends a pinned stage in the wrong position", () => {
    // `COMMIT` appears mid-list (before TEST). The enforcer must
    // strip it and put it back at the tail in the canonical order so
    // the agent cannot accidentally COMMIT mid-stage.
    const r = enforcePinnedTail(["PLAN", "COMMIT", "IMPLEMENT", "TEST"]);
    assert.deepEqual([...r.stages], ["PLAN", "IMPLEMENT", "TEST", "COMMIT", "PUSH", "END"]);
    assert.equal(r.repaired, true);
});

test("slice9: enforcePinnedTail returns the canonical pinned tail alone for an empty input", () => {
    const r = enforcePinnedTail([]);
    assert.deepEqual([...r.stages], ["COMMIT", "PUSH", "END"]);
    assert.equal(r.repaired, true,
        "empty input still required the enforcer to append three stages, so repaired must be true");
});

test("slice9: enforcePinnedTail tolerates non-array input by falling back to the pinned tail alone", () => {
    // Defensive contract: a runner that passes through a malformed
    // marker payload (e.g. `[STAGE_PLAN: "not-an-array"]`) must not
    // throw — it must produce a usable plan with the pinned tail.
    const r = enforcePinnedTail(/** @type {any} */ (null));
    assert.deepEqual([...r.stages], ["COMMIT", "PUSH", "END"]);
    assert.equal(r.repaired, true);
});

test("slice9: enforcePinnedTail filters non-string entries before strip-and-tail", () => {
    const r = enforcePinnedTail(["PLAN", 42, null, "IMPLEMENT", undefined, "TEST"]);
    assert.deepEqual([...r.stages], ["PLAN", "IMPLEMENT", "TEST", "COMMIT", "PUSH", "END"]);
    assert.equal(r.repaired, true);
});

test("slice9: enforcePinnedTail returns a frozen array", () => {
    const r = enforcePinnedTail(["PLAN"]);
    assert.ok(Object.isFrozen(r.stages),
        "callers (the runner emit + the renderer) must not be able to mutate the result");
});

test("slice9: serializeEvent + parseEventLine round-trip a stage_plan event", () => {
    const ev = {
        type: "stage_plan",
        ts: 1_000,
        runId: "run-1",
        stages: ["PLAN", "IMPLEMENT", "TEST", "COMMIT", "PUSH", "END"],
    };
    const line = serializeEvent(ev);
    const parsed = parseEventLine(line);
    assert.deepEqual(parsed.stages, ev.stages);
    assert.equal(parsed.type, "stage_plan");
});

test("slice9: serializeEvent rejects stage_plan with empty stages[]", () => {
    assert.throws(() => serializeEvent({
        type: "stage_plan",
        ts: 1_000,
        runId: "run-1",
        stages: [],
    }), /stage_plan requires non-empty stages/);
});

test("slice9: serializeEvent caps stage_plan stages[] at 64 entries", () => {
    const stages = Array.from({ length: 100 }, (_, i) => `S${i}`);
    const line = serializeEvent({
        type: "stage_plan",
        ts: 1_000,
        runId: "run-1",
        stages,
    });
    const parsed = parseEventLine(line);
    assert.equal(parsed.stages.length, 64);
});

test("slice9: serializeEvent rejects stage_plan when every entry is empty/non-string", () => {
    // After filtering out the non-strings, we'd have no valid stages
    // left — that should throw rather than emit a synthetic empty plan.
    assert.throws(() => serializeEvent({
        type: "stage_plan",
        ts: 1_000,
        runId: "run-1",
        stages: [42, null, "", undefined],
    }), /at least one non-empty/);
});

test("slice9: serializeEvent + round-trip a stage_plan_amend with add", () => {
    const ev = {
        type: "stage_plan_amend",
        ts: 2_000,
        runId: "run-1",
        add: "HOTFIX",
        after: "TEST",
        reason: "flaky lint task surfaced an unrelated regression",
    };
    const line = serializeEvent(ev);
    const parsed = parseEventLine(line);
    assert.equal(parsed.add, "HOTFIX");
    assert.equal(parsed.after, "TEST");
    assert.equal(parsed.reason, ev.reason);
});

test("slice9: serializeEvent rejects stage_plan_amend without add OR remove", () => {
    assert.throws(() => serializeEvent({
        type: "stage_plan_amend",
        ts: 2_000,
        runId: "run-1",
        reason: "no-op",
    }), /requires at least one of add\/remove/);
});

test("slice9: serializeEvent rejects stage_plan_amend without reason", () => {
    assert.throws(() => serializeEvent({
        type: "stage_plan_amend",
        ts: 2_000,
        runId: "run-1",
        add: "HOTFIX",
    }), /requires a non-empty reason/);
});

test("slice9: serializeEvent + round-trip a task_list event", () => {
    const ev = {
        type: "task_list",
        ts: 3_000,
        runId: "run-1",
        stage: "FIX",
        items: [
            "extract gitExec helper",
            "replace inline git in handler.mjs",
            "add gitExec unit test",
        ],
    };
    const parsed = parseEventLine(serializeEvent(ev));
    assert.equal(parsed.stage, "FIX");
    assert.deepEqual(parsed.items, ev.items);
});

test("slice9: serializeEvent allows an empty task_list (a stage may end up no-op)", () => {
    const parsed = parseEventLine(serializeEvent({
        type: "task_list",
        ts: 3_000,
        runId: "run-1",
        stage: "PLAN",
        items: [],
    }));
    assert.deepEqual(parsed.items, []);
});

test("slice9: serializeEvent rejects task_list without a stage", () => {
    assert.throws(() => serializeEvent({
        type: "task_list",
        ts: 3_000,
        runId: "run-1",
        items: [],
    }), /requires a non-empty stage/);
});

test("slice9: serializeEvent + round-trip a task_start event", () => {
    const parsed = parseEventLine(serializeEvent({
        type: "task_start",
        ts: 4_000,
        runId: "run-1",
        stage: "FIX",
        sub: 3,
        desc: "add gitExec unit test in test/runner.test.mjs",
    }));
    assert.equal(parsed.stage, "FIX");
    assert.equal(parsed.sub, 3);
    assert.match(parsed.desc, /gitExec unit test/);
});

test("slice9: serializeEvent rejects task_start with sub<1", () => {
    assert.throws(() => serializeEvent({
        type: "task_start",
        ts: 4_000,
        runId: "run-1",
        stage: "FIX",
        sub: 0,
        desc: "do thing",
    }), /requires sub >= 1/);
});

test("slice9: serializeEvent + round-trip a task_end event with each outcome", () => {
    for (const outcome of TASK_OUTCOMES) {
        const parsed = parseEventLine(serializeEvent({
            type: "task_end",
            ts: 5_000,
            runId: "run-1",
            stage: "FIX",
            sub: 3,
            outcome,
            durationMs: 1234,
        }));
        assert.equal(parsed.outcome, outcome);
        assert.equal(parsed.durationMs, 1234);
    }
});

test("slice9: serializeEvent rejects task_end with an unknown outcome", () => {
    assert.throws(() => serializeEvent({
        type: "task_end",
        ts: 5_000,
        runId: "run-1",
        stage: "FIX",
        sub: 3,
        outcome: "weird",
    }), /requires outcome in/);
});

test("slice9: serializeEvent + round-trip a commit_observed event", () => {
    const parsed = parseEventLine(serializeEvent({
        type: "commit_observed",
        ts: 6_000,
        runId: "run-1",
        sha: "ABCDEF1234567890",
        subject: "fix(parser): tolerate trailing whitespace",
        trailers: [
            "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
            "Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>",
        ],
    }));
    // SHA stored lowercase so dedupe / equality works.
    assert.equal(parsed.sha, "abcdef1234567890");
    assert.match(parsed.subject, /trailing whitespace/);
    assert.equal(parsed.trailers.length, 2);
});

test("slice9: serializeEvent rejects commit_observed with a malformed sha", () => {
    assert.throws(() => serializeEvent({
        type: "commit_observed",
        ts: 6_000,
        runId: "run-1",
        sha: "not-a-sha",
        subject: "x",
    }), /sha matching/);
});

test("slice9: foldEvents tracks currentPlan + planAmendments + last applied amendment", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve", maxIterations: 10, minIterations: 1 },
        { type: "iteration_start", ts: 200, runId: "r", iteration: 1 },
        { type: "workitem_start", ts: 300, runId: "r", kind: "issue", ref: 42, title: "fix it" },
        { type: "stage_plan", ts: 400, runId: "r", stages: ["REPRO", "FIX", "TEST", "COMMIT", "PUSH", "END"] },
        { type: "stage_plan_amend", ts: 500, runId: "r", add: "HOTFIX", after: "TEST", reason: "regression" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.currentPlan.stages.length, 7,
        "the amend with `after: TEST` must splice HOTFIX in right after TEST");
    assert.deepEqual(snap.currentPlan.stages, [
        "REPRO", "FIX", "TEST", "HOTFIX", "COMMIT", "PUSH", "END",
    ]);
    assert.equal(snap.planAmendments.length, 1);
    assert.equal(snap.planAmendments[0].add, "HOTFIX");
    assert.equal(snap.planAmendments[0].reason, "regression");
});

test("slice9: foldEvents resets currentPlan + currentTaskList + taskInFlight on workitem_start", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve", maxIterations: 10, minIterations: 1 },
        { type: "iteration_start", ts: 200, runId: "r", iteration: 1 },
        { type: "workitem_start", ts: 300, runId: "r", kind: "issue", ref: 1, title: "first" },
        { type: "stage_plan", ts: 400, runId: "r", stages: ["A", "COMMIT", "PUSH", "END"] },
        { type: "task_list", ts: 500, runId: "r", stage: "A", items: ["t1", "t2"] },
        { type: "task_start", ts: 600, runId: "r", stage: "A", sub: 1, desc: "do t1" },
        // New work item kicks in BEFORE the task ended (the agent
        // abandoned the previous one). The fold must not carry the
        // stale plan / task list / in-flight task into the new work item.
        { type: "workitem_start", ts: 700, runId: "r", kind: "pr", ref: 42, title: "second" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.currentPlan, null);
    assert.equal(snap.currentTaskList, null);
    assert.equal(snap.taskInFlight, null);
    assert.equal(snap.activeWorkItem.ref, 42);
});

test("slice9: foldEvents resets currentTaskList and taskInFlight on stage_start", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve", maxIterations: 10, minIterations: 1 },
        { type: "iteration_start", ts: 200, runId: "r", iteration: 1 },
        { type: "workitem_start", ts: 300, runId: "r", kind: "issue", ref: 42, title: "x" },
        { type: "stage_plan", ts: 400, runId: "r", stages: ["A", "B", "COMMIT", "PUSH", "END"] },
        { type: "stage_start", ts: 500, runId: "r", stage: 1, stageName: "A" },
        { type: "task_list", ts: 600, runId: "r", stage: "A", items: ["t1"] },
        { type: "task_start", ts: 700, runId: "r", stage: "A", sub: 1, desc: "do t1" },
        // Stage advances before the task ended. The fold must clear
        // currentTaskList AND taskInFlight (so the renderer doesn't
        // show a stale "in flight" task across the stage boundary).
        { type: "stage_start", ts: 800, runId: "r", stage: 2, stageName: "B" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.currentTaskList, null);
    assert.equal(snap.taskInFlight, null);
    assert.equal(snap.activeStage.name, "B");
});

test("slice9: foldEvents records each task_end into recentTasks with computed duration", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve", maxIterations: 10, minIterations: 1 },
        { type: "task_start", ts: 1_000, runId: "r", stage: "FIX", sub: 1, desc: "do thing" },
        { type: "task_end", ts: 2_500, runId: "r", stage: "FIX", sub: 1, outcome: "ok" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.recentTasks.length, 1);
    assert.equal(snap.recentTasks[0].outcome, "ok");
    // Computed: ts - startedAt = 2500 - 1000.
    assert.equal(snap.recentTasks[0].durationMs, 1500);
    assert.equal(snap.recentTasks[0].desc, "do thing");
    assert.equal(snap.taskInFlight, null);
});

test("slice9: foldEvents commit_observed populates lastCommit", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve", maxIterations: 10, minIterations: 1 },
        { type: "commit_observed", ts: 1_000, runId: "r",
          sha: "abc1234567890",
          subject: "fix: thing",
          trailers: ["Co-authored-by: X <x@y.z>"] },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.lastCommit.sha, "abc1234567890");
    assert.equal(snap.lastCommit.subject, "fix: thing");
    assert.deepEqual(snap.lastCommit.trailers, ["Co-authored-by: X <x@y.z>"]);
});

import { formatEventLine } from "../src/plain.mjs";

test("slice9: formatEventLine renders stage_plan as `stages=[A,B,C,…]`", () => {
    const line = formatEventLine({
        type: "stage_plan",
        ts: 0,
        runId: "r",
        stages: ["REPRO", "FIX", "TEST", "COMMIT", "PUSH", "END"],
    });
    assert.match(line, /\bstages=\[REPRO,FIX,TEST,COMMIT,PUSH,END\]/);
    // Plain-mode verb is the 5-char `plan ` so `awk` users keep
    // column alignment with the existing 5-char verbs.
    assert.match(line, /\bplan /);
});

test("slice9: formatEventLine renders stage_plan_amend with add/after/reason", () => {
    const line = formatEventLine({
        type: "stage_plan_amend",
        ts: 0,
        runId: "r",
        add: "HOTFIX",
        after: "TEST",
        reason: "regression",
    });
    assert.match(line, /\badd=HOTFIX\b/);
    assert.match(line, /\bafter=TEST\b/);
    assert.match(line, /\breason=regression\b/);
    assert.match(line, /\bpamen\b/);
});

test("slice9: formatEventLine renders task_start with desc + sub", () => {
    const line = formatEventLine({
        type: "task_start",
        ts: 0,
        runId: "r",
        stage: "FIX",
        sub: 3,
        desc: "add gitExec unit test",
    });
    assert.match(line, /\btsk\+ /);
    assert.match(line, /\bsub=3\b/);
    assert.match(line, /desc="add gitExec unit test"/);
});

test("slice9: formatEventLine renders commit_observed with short sha + subject + trailer count", () => {
    const line = formatEventLine({
        type: "commit_observed",
        ts: 0,
        runId: "r",
        sha: "abcdef1234567890",
        subject: "fix(parser): trailing whitespace",
        trailers: [
            "Co-authored-by: A <a@b.c>",
            "Co-authored-by: B <b@b.c>",
        ],
    });
    assert.match(line, /\bcommt\b/);
    // Short SHA in plain mode (the JSONL keeps the full 16-char one).
    assert.match(line, /\bsha=abcdef123456\b/);
    assert.match(line, /subject="fix\(parser\): trailing whitespace"/);
    assert.match(line, /\btrailers=2\b/);
});

// ─── usage_update / premiumRequests round-trip + fold ───────────────
// The runner emits `usage_update` mid-iter (per assistant.message
// outputTokens delta + per result.usage.premiumRequests) so the
// TUI Header snapshot updates while the agent is
// still working — pre-fix, `tokens 0` / no premium counter were
// stuck for the entire iter because `iteration_end` was the only
// event carrying usage.

test("usage_update: serializeEvent + round-trip carries tokens + premiumRequests", () => {
    const parsed = parseEventLine(serializeEvent({
        type: "usage_update",
        ts: 7_000,
        runId: "run-x",
        label: "self_improve",
        iteration: 3,
        tokens: { input: 0, output: 415 },
        premiumRequests: 7,
    }));
    assert.equal(parsed.type, "usage_update");
    assert.equal(parsed.iteration, 3);
    assert.deepEqual(parsed.tokens, { input: 0, output: 415 });
    assert.equal(parsed.premiumRequests, 7);
});

test("usage_update: serializeEvent rejects malformed premiumRequests (NaN, Infinity, negative)", () => {
    // Each malformed value drops the premiumRequests field rather
    // than throwing — the runner is the source of truth and
    // upstream clamps; the serializer is a defensive line.
    for (const bad of [Number.NaN, Infinity, -1, -100, "5", null, undefined]) {
        const out = serializeEvent({
            type: "usage_update",
            ts: 1,
            runId: "r",
            tokens: { input: 0, output: 10 },
            premiumRequests: bad,
        });
        assert.equal(out.premiumRequests, undefined, `bad value ${bad} must be dropped`);
    }
});

test("foldEvents: usage_update mid-iter updates snap.tokens and snap.premiumRequests before iteration_end", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve", maxIterations: 10 },
        { type: "iteration_start", ts: 200, runId: "r", iteration: 1 },
        // Mid-iter usage update arrives BEFORE iteration_end.
        { type: "usage_update", ts: 300, runId: "r", iteration: 1,
          tokens: { input: 0, output: 150 } },
        { type: "usage_update", ts: 400, runId: "r", iteration: 1,
          tokens: { input: 0, output: 240 }, premiumRequests: 2 },
    ];
    const snap = foldEvents(events);
    // Without the usage_update path, snap.tokens.output would still
    // be 0 at this point — that was the pre-fix `tokens 0` symptom.
    assert.equal(snap.tokens.output, 240);
    assert.equal(snap.premiumRequests, 2);
});

test("foldEvents: armed resets snap.premiumRequests back to null", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r1", label: "self_improve" },
        { type: "iteration_start", ts: 200, runId: "r1", iteration: 1 },
        { type: "usage_update", ts: 300, runId: "r1", iteration: 1,
          tokens: { input: 0, output: 50 }, premiumRequests: 5 },
        // A second armed (e.g. tail attached to a new run on the
        // same emitter) must zero the counters out so the new run's
        // numbers don't accumulate on top of the old.
        { type: "armed", ts: 400, runId: "r2", label: "self_improve" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.premiumRequests, null);
    assert.deepEqual(snap.tokens, { input: 0, output: 0 });
});

test("foldEvents: iteration_end with tokens + premiumRequests pins snapshot to cumulative-for-run totals", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 200, runId: "r", iteration: 1 },
        { type: "iteration_end", ts: 300, runId: "r", iteration: 1, excerpt: "ok",
          tokens: { input: 0, output: 200 }, premiumRequests: 3 },
        { type: "iteration_start", ts: 400, runId: "r", iteration: 2 },
        { type: "iteration_end", ts: 500, runId: "r", iteration: 2, excerpt: "ok2",
          tokens: { input: 0, output: 350 }, premiumRequests: 5 },
    ];
    const snap = foldEvents(events);
    // Cumulative semantics: each iter_end carries run-total (not
    // per-iter delta), matching the runner's
    // `runOutputTokens` / `runPremiumRequests` rollover.
    assert.equal(snap.tokens.output, 350);
    assert.equal(snap.premiumRequests, 5);
});

// ─── Issue #54 slice 2a: usage_update with excerpt → live Timeline ────

test("Issue #54 slice 2a: usage_update with excerpt round-trips through serializer", () => {
    const ev = {
        type: "usage_update",
        ts: 1700000000000,
        runId: "r",
        label: "self_improve",
        iteration: 3,
        tokens: { input: 0, output: 250 },
        excerpt: "ORIENT: scanning the backlog for stale CI runs",
    };
    const line = serializeEvent(ev);
    const parsed = parseEventLine(line);
    assert.equal(parsed.type, "usage_update");
    assert.equal(parsed.excerpt, "ORIENT: scanning the backlog for stale CI runs");
    assert.equal(parsed.tokens.output, 250);
});

test("Issue #54 slice 2a: foldEvents — usage_update with excerpt updates iter[last].excerpt when iter is in-flight", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 200, runId: "r", iteration: 1 },
        { type: "usage_update", ts: 300, runId: "r", iteration: 1,
          tokens: { input: 0, output: 50 },
          excerpt: "ORIENT: scanning the backlog" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.iterations.length, 1);
    assert.equal(snap.iterations[0].excerpt, "ORIENT: scanning the backlog");
    assert.equal(snap.iterations[0].endedAt, null, "iter still in-flight");
    assert.equal(snap.lastExcerpt, "ORIENT: scanning the backlog");
});

test("Issue #54 slice 2a: foldEvents — usage_update excerpt does NOT clobber a closed iter's excerpt", () => {
    // After iteration_end has closed iter 1, a stray late
    // usage_update should leave iter 1's excerpt intact (replay
    // fidelity). snap.lastExcerpt may still update — that's a
    // run-scope field, not an iter-scope one — but the per-iter
    // excerpt history is preserved.
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 200, runId: "r", iteration: 1 },
        { type: "iteration_end", ts: 300, runId: "r", iteration: 1,
          excerpt: "FINAL: iter-1 done", tokens: { input: 0, output: 100 } },
        { type: "usage_update", ts: 400, runId: "r", iteration: 1,
          tokens: { input: 0, output: 100 }, excerpt: "STRAY late update" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.iterations[0].excerpt, "FINAL: iter-1 done",
        "closed iter excerpt is not overwritten by post-end usage_update");
});

test("Issue #54 slice 2a: foldEvents — usage_update with empty/missing excerpt is a no-op for iter excerpt", () => {
    const events = [
        { type: "armed", ts: 100, runId: "r", label: "self_improve" },
        { type: "iteration_start", ts: 200, runId: "r", iteration: 1 },
        // iter starts with excerpt: null (per iteration_start init)
        { type: "usage_update", ts: 300, runId: "r", iteration: 1,
          tokens: { input: 0, output: 50 } },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.iterations[0].excerpt, null);
});

// ─── Issue #57 — session_attached event + snapshot.sessionId ──────

test("session_attached: serialize→parse round-trips with sessionId field", () => {
    const ev = {
        type: "session_attached", ts: 100, runId: "r-1",
        iteration: 1, sessionId: "abc-123-def",
    };
    const line = serializeEvent(ev);
    const back = parseEventLine(line);
    assert.equal(back.type, "session_attached");
    assert.equal(back.sessionId, "abc-123-def");
    assert.equal(back.iteration, 1);
});

test("session_attached: serializeEvent rejects missing/empty sessionId", () => {
    assert.throws(
        () => serializeEvent({ type: "session_attached", ts: 1, runId: "r-1" }),
        /requires a non-empty sessionId/,
    );
    assert.throws(
        () => serializeEvent({ type: "session_attached", ts: 1, runId: "r-1", sessionId: "" }),
        /requires a non-empty sessionId/,
    );
});

test("session_attached: serializeEvent caps sessionId at 64 chars", () => {
    const long = "x".repeat(200);
    const line = serializeEvent({
        type: "session_attached", ts: 1, runId: "r-1", sessionId: long,
    });
    const back = parseEventLine(line);
    assert.equal(back.sessionId.length, 64);
});

test("foldEvents: session_attached populates snapshot.sessionId", () => {
    const events = [
        { type: "armed", ts: 1, runId: "r", label: "ralph_loop", maxIterations: 5 },
        { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
        { type: "session_attached", ts: 3, runId: "r", iteration: 1, sessionId: "uuid-1" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.sessionId, "uuid-1");
});

test("foldEvents: snapshot.sessionId is null before any session_attached fires", () => {
    const events = [
        { type: "armed", ts: 1, runId: "r", label: "ralph_loop", maxIterations: 5 },
        { type: "iteration_start", ts: 2, runId: "r", iteration: 1 },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.sessionId, null);
});

test("foldEvents: armed clears a prior run's sessionId (multi-run replay)", () => {
    const events = [
        { type: "armed", ts: 1, runId: "r1", label: "a", maxIterations: 1 },
        { type: "session_attached", ts: 2, runId: "r1", iteration: 1, sessionId: "s1" },
        { type: "complete", ts: 3, runId: "r1", reason: "promise" },
        { type: "armed", ts: 4, runId: "r2", label: "b", maxIterations: 1 },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.runId, "r2");
    assert.equal(snap.sessionId, null);
});

test("foldEvents: a later session_attached overrides an earlier one (non-continue mode iter rotation)", () => {
    const events = [
        { type: "armed", ts: 1, runId: "r", label: "a", maxIterations: 5 },
        { type: "session_attached", ts: 2, runId: "r", iteration: 1, sessionId: "s1" },
        { type: "session_attached", ts: 3, runId: "r", iteration: 2, sessionId: "s2" },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.sessionId, "s2");
});

test("foldEvents: malformed session_attached (empty sessionId) is a no-op", () => {
    // Defence-in-depth: the serializer rejects empty values so a
    // well-formed JSONL line cannot carry one, but a hand-crafted
    // events.jsonl might. The fold silently drops the bad value
    // rather than overwriting a prior good one.
    const events = [
        { type: "armed", ts: 1, runId: "r", label: "a", maxIterations: 1 },
        { type: "session_attached", ts: 2, runId: "r", iteration: 1, sessionId: "good" },
        { type: "session_attached", ts: 3, runId: "r", iteration: 1, sessionId: "" },
        { type: "session_attached", ts: 4, runId: "r", iteration: 1, sessionId: 123 },
    ];
    const snap = foldEvents(events);
    assert.equal(snap.sessionId, "good");
});
