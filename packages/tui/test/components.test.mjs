// Smoke tests for the Ink components (issue #22 slice 5).
//
// `ink` and `ink-testing-library` aren't required to ship the CLI bin
// (a fresh checkout falls back to plain mode), so these tests skip
// automatically when the deps haven't been installed in
// packages/tui/node_modules. Run `cd packages/tui && npm install` then
// `npm test` from the repo root to actually exercise them.

import test from "node:test";
import assert from "node:assert/strict";

let render, React, App, Header, Timeline, DetailPane, Controls, truncateTimeline;
let inkAvailable = false;
try {
    ({ render } = await import("ink-testing-library"));
    React = (await import("react")).default;
    App = (await import("../src/components/App.mjs")).default;
    Header = (await import("../src/components/Header.mjs")).default;
    const TimelineMod = await import("../src/components/Timeline.mjs");
    Timeline = TimelineMod.default;
    truncateTimeline = TimelineMod.truncate;
    DetailPane = (await import("../src/components/DetailPane.mjs")).default;
    Controls = (await import("../src/components/Controls.mjs")).default;
    inkAvailable = true;
} catch {
    // ink / ink-testing-library not installed; tests are skipped below.
}

const skip = inkAvailable ? false : "ink-testing-library not installed (cd packages/tui && npm install)";

test("Header shows status badge, label, run id and iter counter", { skip }, () => {
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
    assert.match(out, /iter/);
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

test("DetailPane shows tokens, reason, and last excerpt", { skip }, () => {
    const snapshot = {
        tokens: { input: 5, output: 7 },
        stagnationStreak: 2,
        reason: "stagnation",
        status: "aborted",
        lastExcerpt: "no progress for 2 turns",
    };
    const out = render(React.createElement(DetailPane, { snapshot })).lastFrame();
    assert.match(out, /tokens/);
    assert.match(out, /in=5/);
    assert.match(out, /out=7/);
    assert.match(out, /streak=2/);
    assert.match(out, /reason/);
    assert.match(out, /stagnation/);
    assert.match(out, /no progress for 2 turns/);
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
    assert.match(out, /Detail/);
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
    for (const expected of ["DONE", "self_improve", "snap", "iter ", "1", "alpha", "promise"]) {
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
    // Avoid showing the literal "1000" in the iter row.
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

test("App composes Header, StagesRow, SubstagesPane, Timeline, DetailPane, Controls", { skip }, () => {
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
