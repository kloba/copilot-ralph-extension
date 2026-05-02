// Smoke tests for the Ink components (issue #22 slice 5).
//
// `ink` and `ink-testing-library` aren't required to ship the CLI bin
// (a fresh checkout falls back to plain mode), so these tests skip
// automatically when the deps haven't been installed in
// packages/tui/node_modules. Run `cd packages/tui && npm install` then
// `npm test` from the repo root to actually exercise them.

import test from "node:test";
import assert from "node:assert/strict";

let render, React, App, Header, Timeline, LiveOutputPane, Controls, truncateTimeline, formatElapsed;
let formatDuration, formatTokenDelta, computeTokenDelta, computePremiumDelta;
let inkAvailable = false;
try {
    ({ render } = await import("ink-testing-library"));
    React = (await import("react")).default;
    App = (await import("../src/components/App.mjs")).default;
    const HeaderMod = await import("../src/components/Header.mjs");
    Header = HeaderMod.default;
    formatElapsed = HeaderMod.formatElapsed;
    const TimelineMod = await import("../src/components/Timeline.mjs");
    Timeline = TimelineMod.default;
    truncateTimeline = TimelineMod.truncate;
    formatDuration = TimelineMod.formatDuration;
    formatTokenDelta = TimelineMod.formatTokenDelta;
    computeTokenDelta = TimelineMod.computeTokenDelta;
    computePremiumDelta = TimelineMod.computePremiumDelta;
    LiveOutputPane = (await import("../src/components/LiveOutputPane.mjs")).default;
    Controls = (await import("../src/components/Controls.mjs")).default;
    inkAvailable = true;
} catch {
    // ink / ink-testing-library not installed; tests are skipped below.
}

const skip = inkAvailable ? false : "ink-testing-library not installed (cd packages/tui && npm install)";

test("Header shows status badge, label, run id and task counter", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "ralph_loop",
        runId: "ralph_loop-1700000000000",
        iteration: 3,
        maxIterations: 100,
        minIterations: 5,
        tokens: { input: 10, output: 20 },
    };
    const { lastFrame } = render(React.createElement(Header, { snapshot }));
    const out = lastFrame();
    assert.match(out, /RUN/);
    assert.match(out, /ralph_loop/);
    assert.match(out, /1700000000000/);
    assert.match(out, /task/);
    assert.match(out, /3/);
    assert.match(out, /100/);
    assert.match(out, /tokens/);
});

test("Timeline renders empty state when no iterations", { skip }, () => {
    const { lastFrame } = render(React.createElement(Timeline, { snapshot: { iterations: [] } }));
    assert.match(lastFrame(), /no iterations yet/);
});

test("Timeline renders iteration rows with excerpts", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, endedAt: 1, excerpt: "first thing" },
            { iteration: 2, endedAt: 2, excerpt: "second thing" },
        ],
        maxIterations: 10,
        status: "running",
        stagnationStreak: 0,
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.match(out, /#\s*1/);
    assert.match(out, /first thing/);
    assert.match(out, /#\s*2/);
    assert.match(out, /second thing/);
});

test("LiveOutputPane shows 'waiting for session' before sessionId is known (live mode)", { skip }, () => {
    const snapshot = { sessionId: null, taskInFlight: null };
    const out = render(React.createElement(LiveOutputPane, {
        snapshot, lines: [], isLive: true,
    })).lastFrame();
    assert.match(out, /Live/);
    assert.match(out, /waiting for session/);
});

test("LiveOutputPane shows 'no output yet' when sessionId is known but buffer empty", { skip }, () => {
    const snapshot = { sessionId: "uuid", taskInFlight: null };
    const out = render(React.createElement(LiveOutputPane, {
        snapshot, lines: [], isLive: true,
    })).lastFrame();
    assert.match(out, /no output yet/);
});

test("LiveOutputPane shows replay placeholder in static / replay mode", { skip }, () => {
    const snapshot = { sessionId: "uuid", taskInFlight: null };
    const out = render(React.createElement(LiveOutputPane, {
        snapshot, lines: [], isLive: false,
    })).lastFrame();
    assert.match(out, /unavailable for replay/);
});

test("LiveOutputPane renders the last 10 lines of a populated buffer", { skip }, () => {
    const lines = Array.from({ length: 25 }, (_, i) => ({
        kind: "text", line: `line-${i + 1}`,
    }));
    const snapshot = {
        sessionId: "uuid",
        taskInFlight: { stage: "IDEATE", sub: 1, desc: "brainstorm", startedAt: 100 },
    };
    const out = render(React.createElement(LiveOutputPane, {
        snapshot, lines, isLive: true,
    })).lastFrame();
    // Only the last 10 (line-16..line-25) should appear.
    assert.match(out, /line-25/);
    assert.match(out, /line-16/);
    assert.doesNotMatch(out, /line-15/);
    // Sub-header surfaces the active task identity.
    assert.match(out, /IDEATE/);
});

test("LiveOutputPane: omits subhead when no task is in flight", { skip }, () => {
    const snapshot = { sessionId: "uuid", taskInFlight: null };
    const out = render(React.createElement(LiveOutputPane, {
        snapshot, lines: [{ kind: "text", line: "foo" }], isLive: true,
    })).lastFrame();
    assert.doesNotMatch(out, /task /);
    assert.match(out, /foo/);
});

// ─── premiumRequests rendering ───────────────────────────────────
// The Header's right row appends ` premium <N>` after the tokens
// counter when snapshot.premiumRequests is finite; the DetailPane
// adds a `premium req <N>` row below the tokens row. Both surfaces
// hide the field when the value is null (pre-iter-1 / post-armed)
// so the user doesn't see a confident `premium 0`.

test("Header: shows premium counter when snapshot.premiumRequests is set", { skip }, () => {
    const snapshot = {
        status: "running", label: "ralph_loop",
        runId: "ralph_loop-1700000000000",
        iteration: 2, maxIterations: 10,
        tokens: { input: 0, output: 415 },
        premiumRequests: 7,
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.match(out, /premium\s+7/);
});

test("Header: hides premium counter when premiumRequests is null", { skip }, () => {
    const snapshot = {
        status: "running", label: "ralph_loop",
        runId: "ralph_loop-1700000000000",
        iteration: 1, maxIterations: 10,
        tokens: { input: 0, output: 0 },
        premiumRequests: null,
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.doesNotMatch(out, /premium/);
});

// ─── Issue: elapsed wallclock counter ─────────────────────────────
// The Header's right row appends `elapsed HH:MM:SS` after the
// tokens (and premium) counters when `snapshot.startedAt` is finite
// AND a clock endpoint is available — caller-supplied `now` while
// the loop runs, or `snapshot.terminalAt` after `complete` /
// `abort`. Hidden otherwise so static-render snapshots don't drift
// across CI machines and pre-`armed` states stay compact.

test("Header: shows elapsed HH:MM:SS for a running loop using injected now", { skip }, () => {
    const snapshot = {
        status: "running", label: "self_improve",
        runId: "self_improve-100", iteration: 1, maxIterations: 1000,
        tokens: { input: 0, output: 0 },
        startedAt: 1_000_000,           // armed at t=1_000_000 ms
        updatedAt: 1_500_000,
        terminalAt: null,
    };
    const now = 1_000_000 + ((14 * 60 + 32) * 1000); // +14m32s
    const out = render(React.createElement(Header, { snapshot, now })).lastFrame();
    assert.match(out, /elapsed\s+00:14:32/);
});

test("Header: elapsed freezes at terminalAt for complete status (ignores now)", { skip }, () => {
    const snapshot = {
        status: "complete", label: "self_improve",
        runId: "self_improve-100", iteration: 5, maxIterations: 5,
        tokens: { input: 1, output: 2 },
        startedAt: 1_000_000,
        updatedAt: 9_999_999_999,       // late event, do NOT use this
        terminalAt: 1_000_000 + 5_000,  // run finished after 5s
    };
    const now = 1_000_000 + ((14 * 60 + 32) * 1000);
    const out = render(React.createElement(Header, { snapshot, now })).lastFrame();
    assert.match(out, /elapsed\s+00:00:05/);
    assert.doesNotMatch(out, /14:32/);
});

test("Header: elapsed freezes at terminalAt for aborted status", { skip }, () => {
    const snapshot = {
        status: "aborted", label: "ralph_loop",
        runId: "ralph_loop-200", iteration: 2, maxIterations: 100,
        tokens: { input: 0, output: 0 },
        startedAt: 1_000_000, updatedAt: 1_002_000,
        terminalAt: 1_000_000 + 90_000, // 1m30s run
    };
    const now = 1_000_000 + 999_999_999; // any now value, ignored
    const out = render(React.createElement(Header, { snapshot, now })).lastFrame();
    assert.match(out, /elapsed\s+00:01:30/);
});

test("Header: elapsed hidden when startedAt is null (pre-armed)", { skip }, () => {
    const snapshot = {
        status: "idle", label: "(unknown)", runId: "(no run)",
        iteration: 0, maxIterations: 100,
        tokens: { input: 0, output: 0 },
        startedAt: null, updatedAt: null, terminalAt: null,
    };
    const out = render(React.createElement(Header, { snapshot, now: 12345 })).lastFrame();
    assert.doesNotMatch(out, /elapsed/);
});

test("Header: elapsed hidden in static-mode (no `now`) for non-terminal status", { skip }, () => {
    // Static renders (e.g. snapshot tests, fixtures) deliberately
    // pass no `now` — Header must NOT fall back to `Date.now()`
    // because that would make the rendered frame change every
    // millisecond and break deterministic test pinning.
    const snapshot = {
        status: "running", label: "ralph_loop", runId: "ralph_loop-300",
        iteration: 1, maxIterations: 10, tokens: { input: 0, output: 0 },
        startedAt: 1_000_000, updatedAt: 1_500_000, terminalAt: null,
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.doesNotMatch(out, /elapsed/);
});

test("Header: elapsed visible without `now` once status is terminal (uses terminalAt)", { skip }, () => {
    // Terminal status pins the elapsed value to `terminalAt -
    // startedAt`, so even a static-mode render (no `now`) must
    // show the frozen elapsed once the loop is done.
    const snapshot = {
        status: "complete", label: "self_improve", runId: "self_improve-400",
        iteration: 3, maxIterations: 3, tokens: { input: 0, output: 0 },
        startedAt: 1_000_000, updatedAt: 1_007_000,
        terminalAt: 1_000_000 + 7_000,
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.match(out, /elapsed\s+00:00:07/);
});

test("Header.formatElapsed: pads with zeroes and grows past 24 hours without wrap", { skip }, () => {
    // Long self-improve runs can chew through several days; the
    // elapsed counter must NOT wrap at 24h (a `Date`-based
    // formatter would). Pin manual H/M/S so a 30h run reads
    // `30:00:00`, not `06:00:00`.
    assert.equal(formatElapsed(0), "00:00:00");
    assert.equal(formatElapsed(999), "00:00:00");           // sub-second floors
    assert.equal(formatElapsed(1_000), "00:00:01");
    assert.equal(formatElapsed(60_000), "00:01:00");
    assert.equal(formatElapsed((14 * 60 + 32) * 1000), "00:14:32");
    assert.equal(formatElapsed(60 * 60 * 1000), "01:00:00");
    assert.equal(formatElapsed(30 * 60 * 60 * 1000), "30:00:00"); // 30h, no wrap
});

test("Header.formatElapsed: returns null for non-finite or negative input", { skip }, () => {
    assert.equal(formatElapsed(null), null);
    assert.equal(formatElapsed(undefined), null);
    assert.equal(formatElapsed(NaN), null);
    assert.equal(formatElapsed(Infinity), null);
    assert.equal(formatElapsed(-1), null);
});

// ─── appVersion pip rendering (issue #59) ────────────────────────
// The Header's heading row renders a dim `v<X.Y.Z>` pip pinned to
// the right edge when the `appVersion` prop is supplied. Hidden
// otherwise so snapshot tests + pre-issue-59 callers stay
// deterministic.

test("Header: renders dim version pip when appVersion is supplied", { skip }, () => {
    const snapshot = {
        status: "idle",
        label: "ralph_loop",
        runId: "ralph_loop-1",
        iteration: 0,
        maxIterations: 10,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, { snapshot, appVersion: "1.2.3" })).lastFrame();
    assert.match(out, /v1\.2\.3/);
    // The heading text and version pip both still render — neither
    // collapses the other.
    assert.match(out, /Run/);
});

test("Header: hides version pip when appVersion is omitted", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "ralph_loop",
        runId: "ralph_loop-2",
        iteration: 1,
        maxIterations: 10,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    // Asserting no `v` followed by a digit in the heading line — the
    // existing label / runId can contain digits but not the `vN`
    // pattern. Use a tight regex anchored to `v\d`.
    assert.doesNotMatch(out, /v\d/);
});

test("Header: hides version pip when appVersion is empty string", { skip }, () => {
    // Defensive: a future caller might pass `""` if version lookup
    // fails. Header should hide rather than render `v` with no
    // value (which would look broken).
    const snapshot = {
        status: "idle",
        label: "ralph_loop",
        runId: "ralph_loop-3",
        iteration: 0,
        maxIterations: 10,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, { snapshot, appVersion: "" })).lastFrame();
    assert.doesNotMatch(out, /v\d/);
});

test("Header: renders 'unknown' version pip when readTuiVersion's fallback is passed through", { skip }, () => {
    // version.mjs returns the literal string "unknown" on any
    // read/parse failure. Header should still render that — `vunknown`
    // is more informative than nothing when something went wrong.
    const snapshot = {
        status: "idle",
        label: "ralph_loop",
        runId: "ralph_loop-4",
        iteration: 0,
        maxIterations: 10,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, { snapshot, appVersion: "unknown" })).lastFrame();
    assert.match(out, /vunknown/);
});

test("App: forwards appVersion prop through to Header pip", { skip }, () => {
    const events = [
        { type: "armed", runId: "r1", at: 1, label: "ralph_loop", maxIterations: 10 },
    ];
    const out = render(React.createElement(App, {
        events, runId: "r1", appVersion: "9.8.7",
    })).lastFrame();
    assert.match(out, /v9\.8\.7/);
});

// ─── caffeinateActive pip rendering (issue #75) ──────────────────
// The Header's heading row renders a dim `☕ awake` pip alongside
// the version pip when the `caffeinateActive` prop is truthy. Hidden
// otherwise so non-darwin renders + snapshot tests stay deterministic
// and the row layout doesn't reflow.

test("Header: renders caffeinate pip when caffeinateActive is true", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "self_improve",
        runId: "self_improve-1",
        iteration: 0,
        maxIterations: 10,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, {
        snapshot, caffeinateActive: true,
    })).lastFrame();
    assert.match(out, /awake/);
});

test("Header: hides caffeinate pip when caffeinateActive is false", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "self_improve",
        runId: "self_improve-2",
        iteration: 0,
        maxIterations: 10,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, {
        snapshot, caffeinateActive: false,
    })).lastFrame();
    assert.doesNotMatch(out, /awake/);
});

test("Header: hides caffeinate pip when caffeinateActive is omitted", { skip }, () => {
    const snapshot = {
        status: "idle",
        label: "ralph_loop",
        runId: "ralph_loop-3",
        iteration: 0,
        maxIterations: 10,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.doesNotMatch(out, /awake/);
});

test("Header: renders both caffeinate and version pips together", { skip }, () => {
    // When both pips are active, both must render — the heading row
    // becomes a flex row with the cluster pinned to the right edge.
    const snapshot = {
        status: "running",
        label: "self_improve",
        runId: "self_improve-4",
        iteration: 1,
        maxIterations: 10,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, {
        snapshot, appVersion: "1.2.3", caffeinateActive: true,
    })).lastFrame();
    assert.match(out, /awake/);
    assert.match(out, /v1\.2\.3/);
    assert.match(out, /Run/);
});

test("App: forwards caffeinateActive prop through to Header pip", { skip }, () => {
    const events = [
        { type: "armed", runId: "r1", at: 1, label: "ralph_loop", maxIterations: 10 },
    ];
    const out = render(React.createElement(App, {
        events, runId: "r1", caffeinateActive: true,
    })).lastFrame();
    assert.match(out, /awake/);
});

test("Controls hint row shows live indicator when status is running", { skip }, () => {
    const out = render(React.createElement(Controls, { status: "running" })).lastFrame();
    assert.match(out, /quit/);
    assert.match(out, /scroll/);
    assert.match(out, /reload/);
    assert.match(out, /live/);
});

test("Controls hint row shows idle indicator when not running", { skip }, () => {
    const out = render(React.createElement(Controls, { status: "complete" })).lastFrame();
    assert.match(out, /idle/);
});

test("App renders all four panes from a static event log", { skip }, () => {
    const events = [
        { type: "armed", runId: "r1", label: "ralph_loop", maxIterations: 10, minIterations: 1, ts: 1 },
        { type: "iteration_start", runId: "r1", iteration: 1, ts: 2 },
        { type: "iteration_end", runId: "r1", iteration: 1, excerpt: "did some work", tokens: { input: 3, output: 4 }, ts: 3 },
        { type: "iteration_start", runId: "r1", iteration: 2, ts: 4 },
    ];
    const out = render(React.createElement(App, { events, runId: "r1" })).lastFrame();
    assert.match(out, /ralph_loop/);
    assert.match(out, /Timeline/);
    // Issue #57 — DetailPane was replaced by LiveOutputPane (heading "Live").
    assert.match(out, /Live/);
    assert.match(out, /quit/);
    assert.match(out, /did some work/);
});

test("App snapshot is stable for a fixed event log", { skip }, () => {
    const events = [
        { type: "armed", runId: "snap", label: "self_improve", maxIterations: 5, minIterations: 1, ts: 1 },
        { type: "iteration_start", runId: "snap", iteration: 1, ts: 2 },
        { type: "iteration_end", runId: "snap", iteration: 1, excerpt: "alpha", tokens: { input: 1, output: 2 }, ts: 3 },
        { type: "complete", runId: "snap", reason: "promise", ts: 4 },
    ];
    const out = render(React.createElement(App, { events, runId: "snap" })).lastFrame();
    // Pin the substrings we promise externally; full ANSI snapshot would
    // be brittle across Ink versions.
    for (const expected of ["DONE", "self_improve", "snap", "task ", "1", "alpha", "promise"]) {
        assert.match(out, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
});

test("Timeline.truncate: short string passes through verbatim (no ellipsis)", { skip }, () => {
    assert.equal(truncateTimeline("hello", 10), "hello");
});

test("Timeline.truncate: whitespace is collapsed to single spaces", { skip }, () => {
    // Multi-line / tabs flatten to single spaces so the row stays one line.
    assert.equal(truncateTimeline("foo\nbar\tbaz   qux", 80), "foo bar baz qux");
});

test("Timeline.truncate: overflow is capped and gains a trailing ellipsis", { skip }, () => {
    const out = truncateTimeline("a".repeat(100), 10);
    assert.equal(out.length, 10);
    assert.equal(out, "aaaaaaaaa…");
});

test("Timeline.truncate: surrogate-safe — emoji at the boundary doesn't split", { skip }, () => {
    // Iter 140 refactor: pre-iter-140 the truncate helper called
    // `flat.slice(0, n - 1)` directly, so a 4-byte emoji whose
    // high-surrogate code unit landed on `n - 1` rendered as a lone
    // half + "…", producing an invalid UTF-16 fragment in the
    // terminal frame. Pin the surrogate-aware back-off via the
    // shared safeSliceChars helper.
    //
    // Build a string of 8 ASCII chars + 1 emoji (2 code units = 10
    // total). Truncate to 10 chars: the natural slice point at 9
    // would land between the high and low surrogate of the emoji,
    // so safeSliceChars must back off to 8, dropping the emoji
    // entirely, and the helper appends "…".
    const tricky = "a".repeat(8) + "\u{1F480}"; // 💀 (U+1F480 = surrogate pair)
    assert.equal(tricky.length, 10, "sanity: tricky string is 10 UTF-16 code units (8 + 2)");
    const out = truncateTimeline(tricky, 10);
    // The output may contain a "…" (overflow detected by .length > n
    // — wait, 10 <= 10 is short-circuit; let's force overflow):
    const longerTricky = tricky + "x"; // 11 code units → triggers overflow path
    const outLong = truncateTimeline(longerTricky, 10);
    assert.equal(outLong.length, 9, "with surrogate-aware back-off, capped output is 8 ASCII + ellipsis (9 code units, dropping the emoji entirely)");
    assert.equal(outLong, "aaaaaaaa…");
    // Negative property: under no circumstances may the rendered
    // output contain a lone high-surrogate code unit. Iterate the
    // output and assert every high surrogate (D800-DBFF) is followed
    // by a low surrogate (DC00-DFFF).
    for (let i = 0; i < outLong.length; i++) {
        const code = outLong.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = outLong.charCodeAt(i + 1);
            assert.ok(next >= 0xDC00 && next <= 0xDFFF,
                `lone high surrogate at index ${i} (0x${code.toString(16)}) — surrogate-pair safety regressed`);
            i++;
        } else {
            assert.ok(!(code >= 0xDC00 && code <= 0xDFFF),
                `lone low surrogate at index ${i} (0x${code.toString(16)})`);
        }
    }
    // Sanity: under-cap path also doesn't add an ellipsis.
    assert.equal(truncateTimeline(tricky, 10), tricky,
        "under-cap surrogate-bearing string passes through unchanged (no ellipsis)");
});

let StagesRow, SubstagesPane, computeStageStates, formatDurationMs;
if (inkAvailable) {
    const StagesMod = await import("../src/components/StagesRow.mjs");
    StagesRow = StagesMod.default;
    computeStageStates = StagesMod.computeStageStates;
    const SubstagesMod = await import("../src/components/SubstagesPane.mjs");
    SubstagesPane = SubstagesMod.default;
    formatDurationMs = SubstagesMod.formatDurationMs;
}

test("Header renders backlog row when snapshot.backlog is present", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "self_improve",
        runId: "abc",
        iteration: 2,
        maxIterations: 1000,
        tokens: { input: 0, output: 0 },
        backlog: { openIssues: 5, openPrs: 1, redCi: 0 },
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.match(out, /backlog/);
    assert.match(out, /5/);
    assert.match(out, /open issues/);
    assert.match(out, /1/);
    assert.match(out, /open PRs/);
    assert.match(out, /red CI/);
});

test("Header omits backlog row when snapshot.backlog is null", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "ralph_loop",
        runId: "abc",
        iteration: 1,
        maxIterations: 100,
        tokens: { input: 0, output: 0 },
        backlog: null,
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.doesNotMatch(out, /backlog/);
});

test("Header renders ∞ when maxIterations equals runaway-guard ceiling", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "self_improve",
        runId: "abc",
        iteration: 7,
        maxIterations: 1000,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.match(out, /∞/);
    // Avoid showing the literal "1000" in the task row.
    assert.doesNotMatch(out, /\/1000/);
});

test("Header still shows literal max when below the runaway-guard ceiling", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "ralph_loop",
        runId: "abc",
        iteration: 3,
        maxIterations: 50,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.match(out, /\/50/);
    assert.doesNotMatch(out, /∞/);
});

test("Header.backlog shows ? for null fields without crashing", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "self_improve",
        runId: "abc",
        iteration: 1,
        maxIterations: 1000,
        tokens: { input: 0, output: 0 },
        backlog: { openIssues: null, openPrs: 2, redCi: null },
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.match(out, /backlog/);
    assert.match(out, /\?/);
    assert.match(out, /2/);
});

test("StagesRow.computeStageStates marks active, completed, and pending correctly", { skip }, () => {
    const stages = ["A", "B", "C", "D"];
    const snapshot = {
        activeStage: { name: "C" },
        recentStages: [{ name: "A" }, { name: "B" }],
    };
    const items = computeStageStates(snapshot, stages);
    assert.equal(items.length, 4);
    assert.equal(items[0].state, "completed");
    assert.equal(items[1].state, "completed");
    assert.equal(items[2].state, "active");
    assert.equal(items[3].state, "pending");
});

test("StagesRow.computeStageStates: active wins over completed when same name in recentStages", { skip }, () => {
    // Defensive: if a stage name is in `recentStages` AND is the
    // current `activeStage` (e.g., the agent re-entered it), the
    // pill should render as active, not completed.
    const stages = ["A", "B"];
    const snapshot = {
        activeStage: { name: "A" },
        recentStages: [{ name: "A" }],
    };
    const items = computeStageStates(snapshot, stages);
    assert.equal(items[0].state, "active");
});

test("StagesRow renders nothing for unknown label (custom --prompt run)", { skip }, () => {
    const snapshot = { label: "custom_prompt", activeStage: null, recentStages: [] };
    const out = render(React.createElement(StagesRow, { snapshot })).lastFrame();
    assert.equal(out, "");
});

test("StagesRow renders SDLC pill row for self_improve label", { skip }, () => {
    const snapshot = {
        label: "self_improve",
        activeStage: { name: "BASELINE" },
        recentStages: [{ name: "ORIENT" }, { name: "IDEATE" }, { name: "CRITIQUE" }],
    };
    const out = render(React.createElement(StagesRow, { snapshot })).lastFrame();
    assert.match(out, /ORIENT/);
    assert.match(out, /IDEATE/);
    assert.match(out, /BASELINE/);
    assert.match(out, /COMMIT/);
    // Active stage pill carries the ● glyph; pending pills get a
    // blank (space) placeholder.
    assert.match(out, /●/);
    assert.match(out, /✓/);
});

test("SubstagesPane.formatDurationMs handles null, finite, and overflow", { skip }, () => {
    assert.equal(formatDurationMs(null), "?");
    assert.equal(formatDurationMs(undefined), "?");
    assert.equal(formatDurationMs(NaN), "?");
    assert.equal(formatDurationMs(0), "0ms");
    assert.equal(formatDurationMs(123), "123ms");
    assert.equal(formatDurationMs(123.7), "124ms");
    assert.equal(formatDurationMs(100000), ">99999ms");
});

test("SubstagesPane shows placeholder when no active stage", { skip }, () => {
    const snapshot = { activeStage: null, currentStageSubstages: [] };
    const out = render(React.createElement(SubstagesPane, { snapshot })).lastFrame();
    assert.match(out, /no active stage/);
});

test("SubstagesPane shows placeholder when active stage has no substages", { skip }, () => {
    const snapshot = {
        activeStage: { name: "ORIENT" },
        currentStageSubstages: [],
    };
    const out = render(React.createElement(SubstagesPane, { snapshot })).lastFrame();
    assert.match(out, /ORIENT/);
    assert.match(out, /no activity yet/);
});

test("SubstagesPane renders substage rows with verb, args, outcome, duration", { skip }, () => {
    const snapshot = {
        activeStage: { name: "BASELINE" },
        currentStageSubstages: [
            { sub: 1, verb: "bash", argsSummary: "npm test", outcome: "ok", durationMs: 42 },
            { sub: 2, verb: "view", argsSummary: "src/main.mjs", outcome: "ok", durationMs: 5 },
            { sub: 3, verb: "edit", argsSummary: "src/main.mjs", outcome: "error", durationMs: 17 },
        ],
    };
    const out = render(React.createElement(SubstagesPane, { snapshot })).lastFrame();
    assert.match(out, /BASELINE/);
    assert.match(out, /bash/);
    assert.match(out, /npm test/);
    assert.match(out, /view/);
    assert.match(out, /src\/main\.mjs/);
    assert.match(out, /edit/);
    assert.match(out, /ok/);
    assert.match(out, /error/);
    assert.match(out, /42ms/);
    assert.match(out, /5ms/);
    assert.match(out, /17ms/);
});

test("SubstagesPane caps to maxRows tail for long stages (no overflow)", { skip }, () => {
    const subs = [];
    for (let i = 0; i < 30; i++) {
        subs.push({ sub: i + 1, verb: "bash", argsSummary: `cmd-${i}`, outcome: "ok", durationMs: 1 });
    }
    const snapshot = { activeStage: { name: "X" }, currentStageSubstages: subs };
    const out = render(React.createElement(SubstagesPane, { snapshot, maxRows: 3 })).lastFrame();
    // Last 3 must appear; earlier ones must not — confirms tail
    // behaviour rather than head behaviour.
    assert.match(out, /cmd-29/);
    assert.match(out, /cmd-28/);
    assert.match(out, /cmd-27/);
    assert.doesNotMatch(out, /cmd-0\b/);
    assert.doesNotMatch(out, /cmd-26\b/);
});

test("App composes Header, StagesRow, SubstagesPane, Timeline, LiveOutputPane, Controls", { skip }, () => {
    const events = [
        { type: "armed", runId: "r1", label: "self_improve", maxIterations: 1000, minIterations: 5, ts: 1 },
        { type: "iteration_start", runId: "r1", iteration: 1, ts: 2 },
        { type: "stage_start", runId: "r1", iteration: 1, name: "ORIENT", ts: 3 },
        { type: "substage", runId: "r1", iteration: 1, sub: 1, verb: "bash", argsSummary: "git status", outcome: "ok", durationMs: 12, ts: 4 },
        { type: "stage_end", runId: "r1", iteration: 1, name: "ORIENT", ts: 5 },
        { type: "stage_start", runId: "r1", iteration: 1, name: "IDEATE", ts: 6 },
        { type: "substage", runId: "r1", iteration: 1, sub: 1, verb: "view", argsSummary: "AGENTS.md", outcome: "ok", durationMs: 4, ts: 7 },
        { type: "backlog_snapshot", runId: "r1", iteration: 1, openIssues: 7, openPrs: 2, redCi: 1, ts: 8 },
        { type: "iteration_end", runId: "r1", iteration: 1, excerpt: "ideated", tokens: { input: 1, output: 1 }, ts: 9 },
    ];
    const out = render(React.createElement(App, { events, runId: "r1" })).lastFrame();
    // Header backlog row + ∞ for unbounded max.
    assert.match(out, /backlog/);
    assert.match(out, /7/);
    assert.match(out, /∞/);
    // StagesRow shows the SDLC pills.
    assert.match(out, /ORIENT/);
    assert.match(out, /IDEATE/);
    assert.match(out, /CRITIQUE/);
    // SubstagesPane shows the latest substage.
    assert.match(out, /AGENTS\.md/);
    assert.match(out, /view/);
});

test("App.onUserAbort fires on q with 'user_quit' reason (issue #48 slice 8)", { skip }, async () => {
    const calls = [];
    const onUserAbort = (reason) => { calls.push(reason); };
    const inst = render(React.createElement(App, {
        events: [{ type: "armed", runId: "r1", label: "self_improve", maxIterations: 1000, ts: 1 }],
        runId: "r1",
        onUserAbort,
    }));
    // useInput's effect installs the listener on the next microtask;
    // wait for that AND for setRawMode's setImmediate gating before
    // writing input or it'll be dropped.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    inst.stdin.write("q");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ["user_quit"]);
    inst.unmount();
});

test("App.onUserAbort fires on Ctrl-C with 'signal_SIGINT' reason (issue #48 slice 8)", { skip }, async () => {
    // In Ink raw mode, Ctrl-C does NOT produce SIGINT; it arrives as
    // the byte \x03 (ETX). Without an explicit useInput handler the
    // `process.on("SIGINT", …)` registered by bin/tui.mjs would never
    // fire while the TUI owns the tty, leaving the runner orphaned.
    const calls = [];
    const onUserAbort = (reason) => { calls.push(reason); };
    const inst = render(React.createElement(App, {
        events: [{ type: "armed", runId: "r1", label: "self_improve", maxIterations: 1000, ts: 1 }],
        runId: "r1",
        onUserAbort,
    }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    inst.stdin.write("\x03");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ["signal_SIGINT"]);
    inst.unmount();
});

test("App without onUserAbort still exits on q (read-only watch mode)", { skip }, async () => {
    // autopilot watch supplies no onUserAbort — the App must still
    // tear down cleanly without throwing on the missing callback.
    const inst = render(React.createElement(App, {
        events: [{ type: "armed", runId: "r1", label: "ralph_loop", maxIterations: 100, ts: 1 }],
        runId: "r1",
    }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    inst.stdin.write("q");
    await new Promise((r) => setImmediate(r));
    inst.unmount();
});

// ─── Issue #48 slice 9: 3-level renderer (work item → plan → tasks) ─────

let TasksPane, LastCommit;
let stageOrdinal, computeTaskRows, countCoAuthors, computeAmendmentAdds, selectStages;
if (inkAvailable) {
    const tp = await import("../src/components/TasksPane.mjs");
    TasksPane = tp.default;
    stageOrdinal = tp.stageOrdinal;
    computeTaskRows = tp.computeTaskRows;
    const lc = await import("../src/components/LastCommit.mjs");
    LastCommit = lc.default;
    countCoAuthors = lc.countCoAuthors;
    const sr = await import("../src/components/StagesRow.mjs");
    selectStages = sr.selectStages;
    computeAmendmentAdds = sr.computeAmendmentAdds;
}

test("Header: active work item row renders kind + #ref + title", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "self_improve",
        runId: "r1",
        iteration: 5,
        maxIterations: 1000,
        tokens: { input: 0, output: 0 },
        activeWorkItem: { kind: "issue", ref: 48, title: "3-level hierarchical TUI", startedAt: 1 },
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.match(out, /#48/);
    assert.match(out, /3-level hierarchical TUI/);
    assert.match(out, /issue/);
});

test("Header: ∞ shown when maxIterations is the runaway-guard ceiling", { skip }, () => {
    const snapshot = {
        status: "running", label: "self_improve", runId: "r1",
        iteration: 5, maxIterations: 1000, tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.match(out, /task\s+5/);
    assert.match(out, /∞/);
});

test("Header: backlog row shows '(N done)' pip when closedByLoop > 0", { skip }, () => {
    const snapshot = {
        status: "running", label: "self_improve", runId: "r1",
        iteration: 5, maxIterations: 1000, tokens: { input: 0, output: 0 },
        backlog: { openIssues: 3, openPrs: 1, redCi: 0 },
        closedByLoop: 7,
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.match(out, /3 open issues/);
    assert.match(out, /\(7 done\)/);
});

test("Header: no work-item row when activeWorkItem is null", { skip }, () => {
    const snapshot = {
        status: "running", label: "self_improve", runId: "r1",
        iteration: 5, maxIterations: 1000, tokens: { input: 0, output: 0 },
        activeWorkItem: null,
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    assert.equal(out.match(/issue/), null, "no 'issue' label when no active work item");
});

test("StagesRow.selectStages: prefers snapshot.currentPlan.stages over canonical list", () => {
    if (!inkAvailable) return;
    const stages = selectStages({
        label: "self_improve",
        currentPlan: { stages: ["DIAGNOSE", "REPRO", "FIX"] },
    });
    assert.deepEqual(stages, ["DIAGNOSE", "REPRO", "FIX"]);
});

test("StagesRow.selectStages: falls back to canonical list when no plan", () => {
    if (!inkAvailable) return;
    const stages = selectStages({ label: "self_improve" });
    assert.ok(stages.includes("ORIENT"));
    assert.ok(stages.includes("COMMIT"));
});

test("StagesRow.selectStages: dedupes stages within plan (defensive)", () => {
    if (!inkAvailable) return;
    const stages = selectStages({
        currentPlan: { stages: ["A", "B", "A", "B", "C"] },
    });
    assert.deepEqual(stages, ["A", "B", "C"]);
});

test("StagesRow.computeAmendmentAdds: skips runner-driven pinned-tail-enforcement amends", () => {
    if (!inkAvailable) return;
    const adds = computeAmendmentAdds({
        planAmendments: [
            { add: "COMMIT", reason: "pinned-tail-enforcement" },
            { add: "DOCS", reason: "agent-amendment" },
            { remove: "FOO", reason: "agent-amendment" },
        ],
    });
    assert.equal(adds.has("COMMIT"), false, "pinned-tail-enforcement adds are runner noise");
    assert.equal(adds.has("DOCS"), true, "agent amendments are surfaced");
    assert.equal(adds.size, 1);
});

test("StagesRow renders 📌 glyph on pinned tail stages (COMMIT / PUSH / END)", { skip }, () => {
    const snapshot = {
        label: "self_improve",
        recentStages: [],
        activeStage: { name: "ORIENT" },
    };
    const out = render(React.createElement(StagesRow, { snapshot })).lastFrame();
    assert.match(out, /COMMIT📌|COMMIT 📌|COMMIT.*📌/);
});

test("StagesRow renders agent-emitted plan stages instead of canonical when currentPlan is set", { skip }, () => {
    const snapshot = {
        label: "self_improve",
        currentPlan: { stages: ["DIAG", "REPRO", "FIX", "TEST", "COMMIT", "PUSH", "END"] },
        recentStages: [],
        activeStage: { name: "DIAG" },
    };
    const out = render(React.createElement(StagesRow, { snapshot })).lastFrame();
    assert.match(out, /DIAG/);
    assert.match(out, /REPRO/);
    // Canonical-only stages (e.g. CRITIQUE) must NOT appear.
    assert.equal(out.match(/CRITIQUE/), null);
});

test("TasksPane.stageOrdinal: returns 1-based index from current plan", () => {
    if (!inkAvailable) return;
    const snap = {
        currentPlan: { stages: ["DIAG", "FIX", "TEST"] },
    };
    assert.equal(stageOrdinal(snap, "DIAG"), 1);
    assert.equal(stageOrdinal(snap, "FIX"), 2);
    assert.equal(stageOrdinal(snap, "TEST"), 3);
    assert.equal(stageOrdinal(snap, "MISSING"), null);
});

test("TasksPane.stageOrdinal: falls back to canonical stage list", () => {
    if (!inkAvailable) return;
    const snap = { label: "self_improve" };
    assert.equal(stageOrdinal(snap, "ORIENT"), 1);
    assert.equal(stageOrdinal(snap, "COMMIT"), 7);
});

test("TasksPane.computeTaskRows: empty inputs → []", () => {
    if (!inkAvailable) return;
    assert.deepEqual(computeTaskRows({}), []);
    assert.deepEqual(computeTaskRows(null), []);
});

test("TasksPane.computeTaskRows: in-flight / recent / pending precedence (one of each)", () => {
    if (!inkAvailable) return;
    const snap = {
        currentTaskList: { stage: "FIX", items: ["task-a", "task-b", "task-c"] },
        taskInFlight: { stage: "FIX", sub: 2, desc: "task-b" },
        recentTasks: [
            { stage: "FIX", sub: 1, outcome: "ok", desc: "task-a" },
        ],
    };
    const rows = computeTaskRows(snap);
    const states = rows.map((r) => `${r.sub}:${r.state}`);
    // sub 1 in recent → "ok"; sub 2 in flight → "in_flight"; sub 3 not started → "pending"
    assert.deepEqual(states, ["1:ok", "2:in_flight", "3:pending"]);
});

test("TasksPane: empty placeholder when no task list emitted yet", { skip }, () => {
    const out = render(React.createElement(TasksPane, { snapshot: {} })).lastFrame();
    assert.match(out, /no task list yet/);
});

test("TasksPane: renders ▶ on in-flight + '← this iter' marker", { skip }, () => {
    const snap = {
        currentPlan: { stages: ["FIX"] },
        currentTaskList: { stage: "FIX", items: ["task-a"] },
        taskInFlight: { stage: "FIX", sub: 1, desc: "task-a" },
        recentTasks: [],
    };
    const out = render(React.createElement(TasksPane, { snapshot: snap })).lastFrame();
    assert.match(out, /▶/);
    assert.match(out, /1\.1/);
    assert.match(out, /task-a/);
    assert.match(out, /← this iter/);
});

test("TasksPane: renders ✓ on completed tasks (recentTasks ok outcome)", { skip }, () => {
    const snap = {
        currentPlan: { stages: ["FIX"] },
        currentTaskList: { stage: "FIX", items: ["task-a", "task-b"] },
        recentTasks: [
            { stage: "FIX", sub: 1, outcome: "ok", desc: "task-a" },
            { stage: "FIX", sub: 2, outcome: "ok", desc: "task-b" },
        ],
    };
    const out = render(React.createElement(TasksPane, { snapshot: snap })).lastFrame();
    assert.match(out, /✓/);
    assert.match(out, /1\.1/);
    assert.match(out, /1\.2/);
});

test("LastCommit.countCoAuthors: counts only Co-authored-by trailers", () => {
    if (!inkAvailable) return;
    assert.equal(countCoAuthors([
        "Co-authored-by: Copilot <c@example.com>",
        "Co-authored-by: ralph <r@example.com>",
        "Closes #42",
        "Refs #1",
    ]), 2);
    assert.equal(countCoAuthors([]), 0);
    assert.equal(countCoAuthors(null), 0);
});

test("LastCommit: placeholder when no commit observed yet", { skip }, () => {
    const out = render(React.createElement(LastCommit, { snapshot: {} })).lastFrame();
    assert.match(out, /last commit/i);
    assert.match(out, /none yet/i);
});

test("LastCommit: renders sha + subject + trailer count + co-author badge", { skip }, () => {
    const snap = {
        lastCommit: {
            sha: "abc1234567890",
            subject: "feat(x): test commit",
            trailers: [
                "Co-authored-by: Copilot <c@example.com>",
                "Co-authored-by: ralph <r@example.com>",
            ],
        },
    };
    const out = render(React.createElement(LastCommit, { snapshot: snap })).lastFrame();
    assert.match(out, /abc1234/);
    assert.match(out, /feat\(x\): test commit/);
    assert.match(out, /2 trailers/);
    assert.match(out, /2 co-authors/);
});

test("App: 3-level layout — work item header, plan stages, tasks pane, last commit footer all surface together", { skip }, () => {
    const events = [
        { type: "armed", runId: "r1", label: "self_improve", maxIterations: 1000, minIterations: 1, ts: 1 },
        { type: "iteration_start", runId: "r1", iteration: 1, ts: 2 },
        { type: "workitem_start", runId: "r1", iteration: 1, kind: "issue", ref: 48,
          title: "3-level hierarchical TUI", ts: 3 },
        { type: "stage_plan", runId: "r1", iteration: 1, stages: ["DIAG", "FIX", "TEST"], ts: 4 },
        { type: "stage_start", runId: "r1", iteration: 1, stage: 1, stageName: "DIAG", ts: 5 },
        { type: "task_list", runId: "r1", iteration: 1, stage: "DIAG", items: ["read code", "form hypothesis"], ts: 6 },
        { type: "task_start", runId: "r1", iteration: 1, stage: "DIAG", sub: 1, desc: "read code", ts: 7 },
        { type: "commit_observed", runId: "r1", iteration: 1, sha: "deadbeef1234567",
          subject: "feat(x): land 3-level renderer",
          trailers: ["Co-authored-by: Copilot <c@example.com>"], ts: 8 },
    ];
    const out = render(React.createElement(App, { events, runId: "r1" })).lastFrame();
    // L1: work item
    assert.match(out, /#48/);
    assert.match(out, /3-level hierarchical TUI/);
    // L2: plan stages (must be DIAG/FIX/TEST, NOT canonical CRITIQUE etc.)
    assert.match(out, /DIAG/);
    assert.match(out, /FIX/);
    // L3: tasks
    assert.match(out, /read code/);
    assert.match(out, /← this iter/);
    // Footer: last commit
    assert.match(out, /deadbee/);
    assert.match(out, /land 3-level renderer/);
});

// ─── Issue #54: panel headings + live excerpt + replay-on-mount ──────

test("Issue #54 slice 1: Header renders 'Run' heading inside the bordered Box", { skip }, () => {
    const snapshot = {
        status: "running",
        label: "self_improve",
        runId: "r1700000000000",
        iteration: 1,
        maxIterations: 5,
        minIterations: 1,
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Header, { snapshot })).lastFrame();
    // The heading must appear before the status badge / task counter
    // line so users see "Run" as the pane label, not buried below.
    assert.match(out, /Run/);
    const runIdx = out.indexOf("Run");
    const taskIdx = out.indexOf("task");
    assert.ok(runIdx >= 0 && taskIdx > runIdx, "Run heading appears before task counter");
});

test("Issue #54 slice 1: Timeline renders 'Timeline' heading", { skip }, () => {
    const out = render(React.createElement(Timeline, { snapshot: { iterations: [] } })).lastFrame();
    assert.match(out, /Timeline/);
});

test("Issue #54 slice 1: StagesRow renders 'Stages' heading", { skip }, async () => {
    const StagesRow = (await import("../src/components/StagesRow.mjs")).default;
    const snapshot = {
        currentPlan: { stages: ["DIAG", "FIX", "TEST", "COMMIT", "PUSH", "END"] },
        activeStage: { stage: 2, name: "FIX" },
        recentStages: [{ stage: 1, name: "DIAG" }],
    };
    const out = render(React.createElement(StagesRow, { snapshot })).lastFrame();
    assert.match(out, /Stages/);
    // Heading sits ABOVE the pill row.
    const headingIdx = out.indexOf("Stages");
    const pillIdx = out.indexOf("DIAG");
    assert.ok(headingIdx >= 0 && pillIdx > headingIdx, "Stages heading before pills");
});

test("Issue #54 slice 1: TasksPane renders 'Tasks' heading", { skip }, async () => {
    const TasksPane = (await import("../src/components/TasksPane.mjs")).default;
    // Empty-rows path.
    const out1 = render(React.createElement(TasksPane, { snapshot: {} })).lastFrame();
    assert.match(out1, /Tasks/);
    // Rendered-rows path.
    const snapshot = {
        currentPlan: { stages: ["DIAG"] },
        activeStage: { stage: 1, name: "DIAG" },
        currentTaskList: { stage: "DIAG", items: ["read code", "form hypothesis"] },
        taskInFlight: { stage: "DIAG", sub: 1, desc: "read code" },
        recentTasks: [],
    };
    const out2 = render(React.createElement(TasksPane, { snapshot })).lastFrame();
    assert.match(out2, /Tasks/);
    const headingIdx = out2.indexOf("Tasks");
    const taskIdx = out2.indexOf("read code");
    assert.ok(headingIdx >= 0 && taskIdx > headingIdx, "Tasks heading before task rows");
});

test("Issue #54 slice 1: SubstagesPane renders 'Activity' heading separate from STAGE marker", { skip }, async () => {
    const SubstagesPane = (await import("../src/components/SubstagesPane.mjs")).default;
    const snapshot = {
        activeStage: { stage: 2, name: "FIX" },
        currentStageSubstages: [],
    };
    const out = render(React.createElement(SubstagesPane, { snapshot })).lastFrame();
    // Heading is "Activity" (NOT "STAGE: FIX" — that lives in the body row).
    assert.match(out, /Activity/);
    // The stage-marker body row still surfaces the active stage name.
    assert.match(out, /FIX/);
    // Heading appears BEFORE the stage marker row.
    const headingIdx = out.indexOf("Activity");
    const stageIdx = out.indexOf("FIX");
    assert.ok(headingIdx >= 0 && stageIdx > headingIdx, "Activity heading before STAGE marker row");
});

test("Issue #54 slice 2a: Timeline shows '(working…)' for in-flight iter with no excerpt", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, endedAt: 1, excerpt: "first" },
            { iteration: 2, endedAt: null, excerpt: null },
        ],
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.match(out, /first/);
    assert.match(out, /working…/);
    // Finished iters with no excerpt still get the historical
    // "(no excerpt)" placeholder — replay fidelity for old runs.
    const snapshot2 = {
        iterations: [{ iteration: 1, endedAt: 1, excerpt: null }],
    };
    const out2 = render(React.createElement(Timeline, { snapshot: snapshot2 })).lastFrame();
    assert.match(out2, /no excerpt/);
});

test("Issue #54 slice 2a: Timeline shows live-streamed excerpt on the in-flight iter", { skip }, () => {
    // Excerpt streamed via usage_update during the iter — endedAt is
    // still null, but excerpt is now non-empty. Timeline must
    // render the excerpt (truncated to 80 chars) instead of
    // "(working…)".
    const snapshot = {
        iterations: [
            { iteration: 1, endedAt: null, excerpt: "ORIENT: scanning the backlog for stale CI runs" },
        ],
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.match(out, /ORIENT: scanning the backlog/);
    assert.doesNotMatch(out, /working…/);
    assert.doesNotMatch(out, /no excerpt/);
});

// ─── Issue #56 — per-iter stats cells on Timeline rows ────────────

test("Issue #56 slice 1: formatDuration < 60s renders one decimal seconds", { skip }, () => {
    assert.equal(formatDuration(0), "0.0s");
    assert.equal(formatDuration(4200), "4.2s");
    assert.equal(formatDuration(59999), "60.0s");
});

test("Issue #56 slice 1: formatDuration >= 60s renders MmSSs", { skip }, () => {
    assert.equal(formatDuration(60000), "1m0s");
    assert.equal(formatDuration(83000), "1m23s");
    assert.equal(formatDuration(3600000), "60m0s");
});

test("Issue #56 slice 1: formatDuration NaN / negative renders dash", { skip }, () => {
    assert.equal(formatDuration(NaN), "—");
    assert.equal(formatDuration(undefined), "—");
    assert.equal(formatDuration(null), "—");
    assert.equal(formatDuration(-1), "—");
});

test("Issue #56 slice 1: Timeline closed iter renders duration cell from endedAt - startedAt", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 1000, endedAt: 5200, excerpt: "ok" },
        ],
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.match(out, /4\.2s/);
});

test("Issue #56 slice 1: Timeline in-flight iter ticks live elapsed against `now`", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 0, endedAt: null, excerpt: null },
        ],
    };
    // Pass a deterministic `now` so the elapsed cell renders 5.0s.
    const out = render(React.createElement(Timeline, { snapshot, now: 5000 })).lastFrame();
    assert.match(out, /5\.0s/);
});

test("Issue #56 slice 1: Timeline 0-ms iter renders 0.0s (not NaN / -0)", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 1000, endedAt: 1000, excerpt: "instant" },
        ],
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.match(out, /0\.0s/);
    assert.doesNotMatch(out, /NaN/);
});

test("Issue #56 slice 2: formatTokenDelta renders 1.2k for >= 1000, raw int otherwise", { skip }, () => {
    assert.equal(formatTokenDelta(0), "0");
    assert.equal(formatTokenDelta(42), "42");
    assert.equal(formatTokenDelta(999), "999");
    assert.equal(formatTokenDelta(1000), "1.0k");
    assert.equal(formatTokenDelta(1234), "1.2k");
    assert.equal(formatTokenDelta(12500), "12.5k");
});

test("Issue #56 slice 2: formatTokenDelta null/non-finite renders dash", { skip }, () => {
    assert.equal(formatTokenDelta(null), "—");
    assert.equal(formatTokenDelta(undefined), "—");
    assert.equal(formatTokenDelta(NaN), "—");
});

test("Issue #56 slice 2: computeTokenDelta sums input+output minus tokensAtStart", { skip }, () => {
    const iter = { tokensAtStart: { input: 100, output: 200 } };
    const snap = { tokens: { input: 150, output: 1450 } };
    // (150+1450) - (100+200) = 1300
    assert.equal(computeTokenDelta(iter, snap), 1300);
});

test("Issue #56 slice 2: computeTokenDelta returns null when tokensAtStart missing (replay-safe)", { skip }, () => {
    const iter = { iteration: 1 };  // old iter without tokensAtStart
    const snap = { tokens: { input: 100, output: 200 } };
    assert.equal(computeTokenDelta(iter, snap), null);
});

test("Issue #56 slice 2: Timeline renders '1.2k tok' for a closed iter with token delta >= 1000", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 0, endedAt: 1000,
              tokensAtStart: { input: 0, output: 0 }, excerpt: "ok" },
        ],
        tokens: { input: 0, output: 1234 },
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.match(out, /1\.2k tok/);
});

test("Issue #56 slice 2: Timeline renders dash for old iter without tokensAtStart (replay-safety)", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 0, endedAt: 1000, excerpt: "ok" }, // no tokensAtStart
        ],
        tokens: { input: 0, output: 1234 },
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    // The token cell renders `—` standalone (not `— tok`) for missing data.
    assert.match(out, /—/);
    assert.doesNotMatch(out, /1\.2k/);
});

test("Issue #56 slice 2: Timeline in-flight iter ticks token delta from live snap.tokens", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 0, endedAt: null,
              tokensAtStart: { input: 0, output: 0 }, excerpt: "working" },
        ],
        tokens: { input: 0, output: 500 },  // 500 tok delta live
    };
    const out = render(React.createElement(Timeline, { snapshot, now: 1000 })).lastFrame();
    assert.match(out, /500 tok/);
});

test("Issue #56 slice 3: computePremiumDelta returns null when both null (hidden cell)", { skip }, () => {
    const iter = { premiumAtStart: null };
    const snap = { premiumRequests: null };
    assert.equal(computePremiumDelta(iter, snap), null);
});

test("Issue #56 slice 3: computePremiumDelta returns delta when both present", { skip }, () => {
    const iter = { premiumAtStart: 5 };
    const snap = { premiumRequests: 8 };
    assert.equal(computePremiumDelta(iter, snap), 3);
});

test("Issue #56 slice 3: Timeline renders ⊕N for premium delta when data present", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 0, endedAt: 1000,
              tokensAtStart: { input: 0, output: 0 },
              premiumAtStart: 0, excerpt: "ok" },
        ],
        tokens: { input: 0, output: 0 },
        premiumRequests: 2,
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.match(out, /⊕2/);
});

test("Issue #56 slice 3: Timeline hides premium cell when both snap and iter values null", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 0, endedAt: 1000,
              tokensAtStart: { input: 0, output: 0 },
              premiumAtStart: null, excerpt: "ok" },
        ],
        tokens: { input: 0, output: 0 },
        premiumRequests: null,
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.doesNotMatch(out, /⊕/);
});

test("Issue #56 slice 4: Timeline renders 📁N for filesChanged when present", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 0, endedAt: 1000,
              tokensAtStart: { input: 0, output: 0 },
              filesChanged: 3, excerpt: "ok" },
        ],
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.match(out, /📁3/);
});

test("Issue #56 slice 4: Timeline hides files-changed cell when filesChanged absent (replay-safety)", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 0, endedAt: 1000,
              tokensAtStart: { input: 0, output: 0 }, excerpt: "ok" }, // no filesChanged
        ],
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.doesNotMatch(out, /📁/);
});

test("Issue #56 slice 4: Timeline renders 📁0 (dim) when filesChanged is 0", { skip }, () => {
    const snapshot = {
        iterations: [
            { iteration: 1, startedAt: 0, endedAt: 1000,
              tokensAtStart: { input: 0, output: 0 },
              filesChanged: 0, excerpt: "ok" },
        ],
        tokens: { input: 0, output: 0 },
    };
    const out = render(React.createElement(Timeline, { snapshot })).lastFrame();
    assert.match(out, /📁0/);
});
