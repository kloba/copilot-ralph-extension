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

test("formatEventLine: pause renders verb=pause + iteration + reason", () => {
    // Issue #3: ap_pause emits `{ type: "pause", runId, iteration,
    // reason, ts }`. The plain renderer must surface verb / runId /
    // iteration / reason so a `tail -f`'d stream of events lets a
    // human (or `awk`) know which iteration paused and why. Pin the
    // contract so a future renderer refactor doesn't accidentally
    // drop the iteration or reason field.
    const line = formatEventLine({
        type: "pause",
        ts: 3723456,
        runId: "ralph_loop-7",
        iteration: 4,
        reason: "user requested",
    });
    assert.match(line, /^01:02:03\.456\s+pause\s+ralph_loop-7/);
    assert.match(line, /iter=4/);
    // Multi-word user reasons are JSON-quoted so a `tail -f` consumer
    // (awk / grep -o columns) sees one token after `reason=` instead
    // of three. Iter 137 fix.
    assert.match(line, /reason="user requested"/);
});

test("formatEventLine: pause with null reason omits the reason segment", () => {
    // ap_pause without a reason emits `reason: null`. The renderer
    // must skip the segment entirely (not render `reason=null`) so
    // empty-reason pause lines stay tidy in the plain log.
    const line = formatEventLine({
        type: "pause",
        ts: 0,
        runId: "r-1",
        iteration: 2,
        reason: null,
    });
    assert.match(line, /pause/);
    assert.match(line, /iter=2/);
    assert.doesNotMatch(line, /reason=/);
});

test("formatEventLine: resume renders verb=resume + iteration + pausedForMs", () => {
    // ralph_resume emits `{ type: "resume", runId, iteration,
    // pausedForMs, ts }`. The plain renderer surfaces verb / runId /
    // iteration / pausedForMs so a `tail -f`'d log of events lets a
    // human (or `awk`) see exactly how long the loop slept — without
    // pausedForMs the user would have to compute it from the
    // pause→resume timestamp diff, which is fragile across log
    // rotation or clock skew.
    const line = formatEventLine({
        type: "resume",
        ts: 0,
        runId: "ralph_loop-3",
        iteration: 5,
        pausedForMs: 1234,
    });
    assert.match(line, /resume\s+ralph_loop-3/);
    assert.match(line, /iter=5/);
    assert.match(line, /pausedForMs=1234/);
});

test("formatEventLine: pausedForMs=0 still renders (Number.isFinite, not truthy)", () => {
    // Boundary pin: pausedForMs=0 is a legitimate value (resume
    // happened in the same millisecond as pause). The render guard
    // uses Number.isFinite, NOT a truthy-check, so 0 must still
    // surface in the log line. A future refactor that flipped this
    // to `if (ev.pausedForMs)` would drop the segment for the
    // zero-elapsed-pause case — pin the contract here.
    const line = formatEventLine({
        type: "resume",
        ts: 0,
        runId: "r-1",
        iteration: 1,
        pausedForMs: 0,
    });
    assert.match(line, /pausedForMs=0/);
});

test("formatEventLine: pausedForMs is omitted on non-resume events", () => {
    // Defence in depth: the field guard is shape-only (`Number.isFinite`),
    // not type-gated, so any future event that happens to carry a
    // numeric `pausedForMs` would render the segment. Today only
    // `resume` does, but a contributor adding a new event type that
    // reuses the field name should remain consistent. Pin the
    // current behaviour: pause events carry no pausedForMs and the
    // segment must be absent.
    const line = formatEventLine({
        type: "pause",
        ts: 0,
        runId: "r-1",
        iteration: 2,
        reason: "x",
        // no pausedForMs
    });
    assert.doesNotMatch(line, /pausedForMs=/);
});

// Iter 119 — plain-mode excerpt cap at 80 chars must not split a
// UTF-16 surrogate pair. Pre-iter-119 the cap used a naive
// `.slice(0, 80)` which would keep a lone high surrogate when an
// emoji landed at the boundary; the resulting lone surrogate would
// be rendered by `JSON.stringify` as a verbose `\uD83D` escape in
// the `tail -f`'d line — surprising the user with a literal escape
// sequence where they expected either the emoji or its safe
// truncation. The fix routes the slice through `safeSliceChars`
// shared with `serializeEvent` (events.mjs).
test("formatEventLine: 80-char excerpt cap is surrogate-safe", () => {
    // Place 💀 (U+1F480, two code units 0xD83D + 0xDC80) at indices
    // 79..80 so a naive `.slice(0, 80)` would keep the high
    // surrogate at 79 and drop the low surrogate at 80.
    const skull = String.fromCharCode(0xD83D, 0xDC80);
    const excerpt = "x".repeat(79) + skull + skull.repeat(20);
    assert.equal(excerpt.charCodeAt(79), 0xD83D, "test setup: index 79 must be the high surrogate");
    assert.equal(excerpt.charCodeAt(80), 0xDC80, "test setup: index 80 must be the low surrogate");
    const line = formatEventLine({
        type: "iteration_end",
        ts: 0,
        runId: "r-1",
        iteration: 1,
        excerpt,
    });
    const m = line.match(/excerpt="([^"]*)"/);
    assert.ok(m, "excerpt segment present");
    // The rendered line must not contain a `\uD83D` JSON escape (the
    // tell-tale sign of a lone high surrogate). If the slice landed
    // INSIDE the surrogate pair, JSON.stringify would emit `\\uD83D`
    // verbatim — surprising the user.
    assert.ok(
        !line.includes("\\uD83D") && !line.includes("\\ud83d"),
        `formatEventLine emitted a lone high surrogate escape: ${line}`,
    );
    // The captured excerpt segment itself must contain no lone
    // high surrogate when re-parsed (defence in depth — the regex
    // above captures the post-JSON.stringify form, so the captured
    // string is already escape-decoded by the regex... actually no,
    // the regex captures the literal between the quotes which still
    // contains JSON escapes. The negative-include check above is
    // the canonical assertion).
    assert.ok(m[1].length <= 80, `cap must hold (got length ${m[1].length})`);
});

// Iter 132 — pin the two terminal/lifecycle verbs that previously
// only had indirect coverage through serializeEvent + the "armed"
// and "iteration_end" tests. plain.mjs's VERB map is the sole place
// where event `type` is translated to a stable column-aligned
// `tail -f` verb; if a refactor renamed `iteration_start` →
// `iter+` directly in the emitter (or dropped the `abort` mapping)
// the rendered logs would silently regress to printing the raw
// type string. These tests pin both the verb literal AND the
// surrounding render contract (runId + iter= for iteration_start,
// reason= for abort) so a future stylesheet pass cannot silently
// drop a column.
test("formatEventLine: iteration_start renders verb=iter+ + iter=", () => {
    // Iteration_start fires at the top of every iter, before the
    // assistant turn lands. The plain log surfaces the iter counter
    // so a `tail -f` viewer can tell the loop is making progress
    // even when the assistant is mid-turn (no iteration_end yet).
    // Pin the two-character verb (`iter+` vs the closing `iter-`)
    // so a future contributor can't accidentally collapse them to
    // the same string and break the visual pairing.
    const line = formatEventLine({
        type: "iteration_start",
        ts: 0,
        runId: "ralph_loop-7",
        iteration: 7,
        maxIterations: 100,
    });
    assert.match(line, /\biter\+\s+ralph_loop-7\b/);
    assert.match(line, /iter=7\/100/);
    // No tokens / excerpt on iteration_start — those land on the
    // matching iteration_end.
    assert.doesNotMatch(line, /tokens=/);
    assert.doesNotMatch(line, /excerpt=/);
});

test("formatEventLine: abort verb renders + reason= + note=", () => {
    // Abort events are emitted for failure-flavored reasons (per
    // handler.mjs ABORT_REASONS: aborted, abort_promise,
    // send_error, stagnation). The plain renderer exposes verb +
    // runId + reason + note so a `grep abort` over the log is
    // enough to surface why the loop ended without re-reading the
    // jsonl. Note: abort events carry `iterations` (plural, total
    // count) — not `iteration` (singular, per-iter index). The
    // formatter intentionally renders only `iteration`, so the
    // `iter=` segment is OMITTED on abort/complete events; pin
    // that absence so a future "render iterations on abort too"
    // refactor must update the test.
    const line = formatEventLine({
        type: "abort",
        ts: 0,
        runId: "ralph_loop-9",
        iterations: 12,
        reason: "stagnation",
        note: "3 identical responses",
    });
    assert.match(line, /\babort\s+ralph_loop-9\b/);
    assert.match(line, /reason=stagnation/);
    assert.match(line, /note="3 identical responses"/);
    assert.doesNotMatch(line, /\biter=/, "abort events do not carry per-iter index");
});

test("formatEventLine: abort with abort_promise reason renders cleanly", () => {
    // Smoke-pin the most common user-driven abort reason
    // (assistant emitted the abort_promise token). Same shape as
    // the stagnation case — verb + runId + reason — but with no
    // note (the emitter passes note=undefined when the reason is
    // promise-based). Confirms the optional-note branch doesn't
    // render a stray `note=` segment.
    const line = formatEventLine({
        type: "abort",
        ts: 0,
        runId: "ralph_loop-1",
        iterations: 5,
        reason: "abort_promise",
    });
    assert.match(line, /\babort\s+ralph_loop-1\b/);
    assert.match(line, /reason=abort_promise/);
    assert.doesNotMatch(line, /note=/, "absent note must not render an empty segment");
});

test("formatEventLine: reason= field quotes whitespace-bearing user reasons but not baked tokens", () => {
    // Iter 137 fix: pause/stop events with a user-supplied reason
    // (via ap_pause / ap_stop) routinely contain spaces — the
    // user types "lunch break", "context-window pressure", or
    // similar. Pre-iter-137 the renderer emitted them unquoted, so
    // the line collapsed multiple tokens after `reason=` and
    // misaligned every column to its right for awk-/grep-based
    // consumers (the same hazard the `note` field already escaped via
    // JSON.stringify for years). Pin both branches:
    //   (a) baked single-token reasons — UNCHANGED, unquoted, so a
    //       log scraper that already parses `reason=completion_promise`
    //       across thousands of historical lines doesn't suddenly see
    //       a quoted form on new runs.
    //   (b) user-text reasons — JSON-stringified, one token after
    //       `reason=`, so awk's $4-style column lookups work.
    //
    // Cross-property check: a hostile reason value (multi-word) MUST
    // not change the count of whitespace-separated tokens on the
    // rendered line beyond exactly one (the quoted reason itself).
    const baked = formatEventLine({
        type: "abort",
        ts: 1_000_000,
        runId: "ralph_loop-baked",
        iterations: 3,
        reason: "completion_promise",
    });
    assert.match(baked, /reason=completion_promise(?:$|\s)/,
        `baked single-token reasons must remain unquoted; got: ${baked}`);
    assert.doesNotMatch(baked, /reason="completion_promise"/,
        `baked single-token reasons must NOT gain JSON quotes (would break existing log scrapers); got: ${baked}`);

    const userText = formatEventLine({
        type: "pause",
        ts: 1_000_000,
        runId: "ralph_loop-user",
        iteration: 7,
        reason: "context window pressure",
    });
    assert.match(userText, /reason="context window pressure"/,
        `multi-word user reasons must be JSON-stringified so the line stays awk-parseable; got: ${userText}`);
    // Token count check: split on whitespace, find the index of the
    // `reason=...` token, assert it is exactly one token (not three).
    const tokens = userText.split(/\s+/).filter(Boolean);
    const reasonTokens = tokens.filter((t) => t.startsWith("reason="));
    assert.equal(reasonTokens.length, 1,
        `multi-word reason must collapse to exactly one whitespace-separated token after reason=; got ${reasonTokens.length} reason-prefixed tokens in: ${userText}`);

    // Tab / CRLF / mixed whitespace classes are also caught by the
    // `\s` regex — pin so a future "optimisation" that switches to
    // ` ` (literal space) doesn't silently regress on tab-bearing
    // reasons (e.g. a flattened reason with embedded tabs).
    const tabbed = formatEventLine({
        type: "pause",
        ts: 1_000_000,
        runId: "ralph_loop-tab",
        iteration: 1,
        reason: "lunch\tbreak",
    });
    assert.match(tabbed, /reason="lunch\\tbreak"/,
        `reasons containing tabs must also be JSON-stringified (\\s regex catches \\t); got: ${tabbed}`);
});

test("formatTimestamp: out-of-range finite ts collapses to ?? sentinel (Invalid Date guard)", () => {
    // JS Date tops out at ±8.64e15 ms from epoch. A finite value
    // beyond that constructs an Invalid Date whose getUTC* accessors
    // all return NaN — without the post-construction guard,
    // formatTimestamp would emit "NaN:NaN:NaN.NaN" (16 chars) instead
    // of the 12-char `"??:??:??.???"` sentinel and silently break the
    // column-aligned awk/grep contract every other formatted line
    // upholds.
    assert.equal(formatTimestamp(8.64e15 + 1), "??:??:??.???",
        "ts just past the JS Date upper bound must collapse to the sentinel, not 'NaN:NaN:...'");
    assert.equal(formatTimestamp(-(8.64e15 + 1)), "??:??:??.???",
        "ts just past the JS Date lower bound must also collapse to the sentinel");
    assert.equal(formatTimestamp(Number.MAX_SAFE_INTEGER), "??:??:??.???",
        "MAX_SAFE_INTEGER ms is finite but unrepresentable as Date — must collapse to the sentinel");
    // Symmetry: the JS Date max itself MUST still render normally,
    // proving the guard is exact (not an over-broad "anything > 1e13"
    // sledgehammer that would clip plausible far-future timestamps).
    assert.notEqual(formatTimestamp(8.64e15), "??:??:??.???",
        "the JS Date upper bound itself must still render — guard must be exact, not over-broad");
});

test("formatEventLine: min=N segment is type-gated to 'armed' (defensive)", () => {
    // Iter 156 — `formatEventLine` only renders the `min=N` segment
    // when `ev.type === "armed"`. Pre-iter-156 only the positive
    // case (armed-event includes min=) was pinned; the defensive
    // type-gate had no negative test, so a future "simplify" pass
    // that dropped the `&& ev.type === "armed"` clause would render
    // `min=N` on any event carrying a stray `minIterations` field.
    // The emitter never emits `minIterations` on non-armed events,
    // but a corrupted events.jsonl row replayed by the TUI tail
    // mode COULD smuggle one in — the gate is a defence-in-depth
    // contract worth pinning. Cover the four most-trafficked
    // non-armed event types so an over-broad regex strip cannot
    // pass by accident.
    for (const type of ["iteration_start", "iteration_end", "pause", "resume", "complete", "abort", "stagnation"]) {
        const line = formatEventLine({
            type,
            ts: 0,
            runId: "r-1",
            iteration: 1,
            maxIterations: 5,
            // Stray minIterations field — must NOT render on non-armed events.
            minIterations: 2,
        });
        assert.doesNotMatch(line, /\bmin=/,
            `non-armed event (type=${type}) must NOT render min=N even when the event carries minIterations`);
    }
    // Sanity check the inverse — armed event with minIterations DOES render.
    const armed = formatEventLine({
        type: "armed",
        ts: 0,
        runId: "r-1",
        maxIterations: 5,
        minIterations: 2,
    });
    assert.match(armed, /\bmin=2\b/, "armed event with minIterations must render min=N");
});

// ─── Issue #48 slice 1: stage / substage / backlog plain-line shape ──

test("formatEventLine: stage_start uses stge+ verb and renders stage + name", () => {
    const line = formatEventLine({
        type: "stage_start", ts: 0, runId: "r-1",
        iteration: 4, stage: 1, stageName: "ORIENT",
    });
    assert.match(line, /\sstge\+\s/);
    assert.match(line, /stage=1/);
    assert.match(line, /name=ORIENT/);
    assert.match(line, /iter=4\b/);
});

test("formatEventLine: stage_end uses stge- verb and renders durationMs + outcome", () => {
    const line = formatEventLine({
        type: "stage_end", ts: 0, runId: "r-1",
        iteration: 4, stage: 1, stageName: "ORIENT",
        durationMs: 3407, outcome: "ok",
    });
    assert.match(line, /\sstge-\s/);
    assert.match(line, /durationMs=3407/);
    assert.match(line, /outcome=ok/);
});

test("formatEventLine: substage uses `sub` verb and renders verb + args", () => {
    const line = formatEventLine({
        type: "substage", ts: 0, runId: "r-1",
        iteration: 4, stage: 5, sub: 3,
        verb: "edit", argsSummary: "extension/handler.mjs (-12, +18)",
        outcome: "ok",
    });
    // Verb column is 5 chars wide ("sub  ") — match a leading word boundary
    // so a future verb rename keeps a single token but the test still
    // catches an accidental column shift.
    assert.match(line, /\bsub\b/);
    assert.match(line, /sub=3/);
    assert.match(line, /verb=edit/);
    assert.match(line, /args="extension\/handler\.mjs/);
    assert.match(line, /outcome=ok/);
});

test("formatEventLine: substage args field collapses internal whitespace and quotes the result", () => {
    const line = formatEventLine({
        type: "substage", ts: 0, runId: "r-1",
        iteration: 1, stage: 1, sub: 1,
        verb: "shell", argsSummary: "git\nlog\t--oneline   -20",
    });
    assert.match(line, /args="git log --oneline -20"/);
});

test("formatEventLine: backlog_snapshot renders all four counters", () => {
    const line = formatEventLine({
        type: "backlog_snapshot", ts: 0, runId: "r-1",
        redCi: 0, openPrs: 2, openIssues: 11, closedByLoop: 3,
    });
    assert.match(line, /\bback\b/);
    assert.match(line, /redCi=0/);
    assert.match(line, /openPrs=2/);
    assert.match(line, /openIssues=11/);
    assert.match(line, /closedByLoop=3/);
});

test("formatEventLine: backlog_snapshot omits absent counters (null != 0)", () => {
    const line = formatEventLine({
        type: "backlog_snapshot", ts: 0, runId: "r-1",
        openPrs: 5,
    });
    assert.match(line, /openPrs=5/);
    assert.doesNotMatch(line, /redCi=/);
    assert.doesNotMatch(line, /openIssues=/);
    assert.doesNotMatch(line, /closedByLoop=/);
});

// ─── Issue #48 slice 3: workitem plain-line shape ────────────────────

test("formatEventLine: workitem_start uses wkit+ verb and renders kind + ref + title", () => {
    const line = formatEventLine({
        type: "workitem_start", ts: 0, runId: "r-1", iteration: 4,
        kind: "issue", ref: 42, title: "fix flaky parser test",
    });
    assert.match(line, /\swkit\+\s/);
    assert.match(line, /kind=issue/);
    assert.match(line, /ref=42/);
    assert.match(line, /title="fix flaky parser test"/);
});

test("formatEventLine: workitem_end uses wkit- verb and renders closesN", () => {
    const line = formatEventLine({
        type: "workitem_end", ts: 0, runId: "r-1", iteration: 8,
        kind: "issue", ref: 42, closesN: 42,
    });
    assert.match(line, /\swkit-\s/);
    assert.match(line, /kind=issue/);
    assert.match(line, /ref=42/);
    assert.match(line, /closesN=42/);
});

test("formatEventLine: workitem title field collapses internal whitespace and JSON-quotes it", () => {
    const line = formatEventLine({
        type: "workitem_start", ts: 0, runId: "r",
        kind: "issue", ref: 1, title: "fix\nflaky\tparser   test",
    });
    // JSON.stringify is used so a title containing whitespace stays a
    // single awk-parseable token. Internal whitespace collapses to one
    // space (matching the args / excerpt convention).
    assert.match(line, /title="fix flaky parser test"/);
});

test("formatEventLine: workitem_end without closesN omits the field (PR / red_ci case)", () => {
    const line = formatEventLine({
        type: "workitem_end", ts: 0, runId: "r",
        kind: "pr", ref: 41,
    });
    assert.match(line, /kind=pr/);
    assert.doesNotMatch(line, /closesN=/);
});

// ─── usage_update verb + premium= field ─────────────────────────────
// `usage_update` is the live mid-iter usage event the runner streams
// so the TUI Header / DetailPane snapshot updates while an iter is
// still running. Plain-mode log lines should render its 5-char verb
// AND the new `premium=N` column so `awk`/`grep` users can extract
// the same info from a tail.

test("formatEventLine: usage_update renders the 'usage' verb and tokens=I/O", () => {
    const line = formatEventLine({
        type: "usage_update", ts: 0, runId: "r", iteration: 2,
        tokens: { input: 0, output: 415 },
    });
    assert.match(line, /\busage\b/);
    assert.match(line, /\btokens=0\/415\b/);
    assert.match(line, /\biter=2\b/);
});

test("formatEventLine: usage_update with premiumRequests renders premium=N", () => {
    const line = formatEventLine({
        type: "usage_update", ts: 0, runId: "r", iteration: 2,
        tokens: { input: 0, output: 415 }, premiumRequests: 7,
    });
    assert.match(line, /\bpremium=7\b/);
});

test("formatEventLine: iteration_end with premiumRequests renders premium=N alongside tokens", () => {
    const line = formatEventLine({
        type: "iteration_end", ts: 0, runId: "r", iteration: 1,
        excerpt: "done", tokens: { input: 0, output: 100 }, premiumRequests: 2,
    });
    assert.match(line, /\btokens=0\/100\b/);
    assert.match(line, /\bpremium=2\b/);
});

test("formatEventLine: omits premium= when the field is absent or malformed", () => {
    for (const bad of [undefined, null, Number.NaN, Infinity, -1]) {
        const line = formatEventLine({
            type: "iteration_end", ts: 0, runId: "r", iteration: 1,
            excerpt: "x", tokens: { input: 0, output: 0 }, premiumRequests: bad,
        });
        assert.doesNotMatch(line, /\bpremium=/, `should omit for ${bad}`);
    }
});
