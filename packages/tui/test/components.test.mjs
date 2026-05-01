// Smoke tests for the Ink components (issue #22 slice 5).
//
// `ink` and `ink-testing-library` aren't required to ship the CLI bin
// (a fresh checkout falls back to plain mode), so these tests skip
// automatically when the deps haven't been installed in
// packages/tui/node_modules. Run `cd packages/tui && npm install` then
// `npm test` from the repo root to actually exercise them.

import test from "node:test";
import assert from "node:assert/strict";

let render, React, App, Header, Timeline, DetailPane, Controls;
let inkAvailable = false;
try {
    ({ render } = await import("ink-testing-library"));
    React = (await import("react")).default;
    App = (await import("../src/components/App.mjs")).default;
    Header = (await import("../src/components/Header.mjs")).default;
    Timeline = (await import("../src/components/Timeline.mjs")).default;
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
