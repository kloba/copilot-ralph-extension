// Tests for the cursor-state preamble (packages/tui/src/runner.mjs).
//
// The baked SDLC prompts (`PROMPT_SELF_IMPROVE`, `PROMPT_GROW_PROJECT`)
// are one-step-per-iter. Without help, a fresh-session iter has no
// memory of prior iters' markers and re-derives the cursor as state 1
// (orient + pick a work item) every iter — so the loop never advances
// past `[WORKITEM_START]`. The runner now reads its own events.jsonl
// before each iter, summarises the cursor, and prepends a
// `[CURSOR_STATE]` block to the prompt so the agent advances correctly.
//
// These tests pin:
//   - `summarizeCursor` state-machine derivation (states 2..6, null for
//     state 1 / corrupt).
//   - `formatCursorPreamble` block layout.
//   - `buildCursorPreamble` filesystem-side contract: missing file →
//     "", trailing partial JSONL line is ignored, interior malformed
//     line suppresses preamble.
//
// All tests are pure-stdlib node:test — no extra deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    summarizeCursor,
    formatCursorPreamble,
    buildCursorPreamble,
} from "../src/runner.mjs";

function makeRunsRootEnv() {
    const root = mkdtempSync(join(tmpdir(), "cursor-preamble-"));
    return {
        env: { AUTOPILOT_RUNS_DIR: root },
        root,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

// ─── summarizeCursor ────────────────────────────────────────────────

test("summarizeCursor: empty event array → null", () => {
    assert.equal(summarizeCursor([]), null);
});

test("summarizeCursor: only iteration_start markers → null", () => {
    const cursor = summarizeCursor([
        { type: "iteration_start", iteration: 1 },
        { type: "iteration_end", iteration: 1 },
        { type: "iteration_start", iteration: 2 },
    ]);
    assert.equal(cursor, null);
});

test("summarizeCursor: workitem_start only → state 2", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 112, title: "t" },
    ]);
    assert.equal(cursor.state, 2);
    assert.deepEqual(cursor.workItem, { kind: "issue", ref: 112, title: "t" });
    assert.equal(cursor.plan, null);
    assert.equal(cursor.activeStage, null);
});

test("summarizeCursor: workitem_start + stage_plan → state 3 for first stage", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "IMPLEMENT", "TEST", "COMMIT", "PUSH", "END"] },
    ]);
    assert.equal(cursor.state, 3);
    assert.equal(cursor.activeStage, "DESIGN");
    assert.deepEqual(cursor.plan, ["DESIGN", "IMPLEMENT", "TEST", "COMMIT", "PUSH", "END"]);
});

test("summarizeCursor: workitem_start + stage_plan + task_list → state 4 with pending tasks", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "IMPLEMENT", "COMMIT", "PUSH", "END"] },
        { type: "task_list", stage: "DESIGN", items: ["a", "b", "c"] },
    ]);
    assert.equal(cursor.state, 4);
    assert.equal(cursor.activeStage, "DESIGN");
    assert.deepEqual(cursor.taskList, ["a", "b", "c"]);
    assert.deepEqual(cursor.pendingTasks, [
        { sub: 1, desc: "a" },
        { sub: 2, desc: "b" },
        { sub: 3, desc: "c" },
    ]);
});

test("summarizeCursor: tasks completed in order → next pending tasks are pending", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "IMPLEMENT", "END"] },
        { type: "task_list", stage: "DESIGN", items: ["a", "b", "c"] },
        { type: "task_start", stage: "DESIGN", sub: 1, desc: "a" },
        { type: "task_end", stage: "DESIGN", sub: 1, outcome: "ok" },
    ]);
    assert.equal(cursor.state, 4);
    assert.equal(cursor.activeStage, "DESIGN");
    assert.deepEqual(cursor.pendingTasks, [
        { sub: 2, desc: "b" },
        { sub: 3, desc: "c" },
    ]);
});

test("summarizeCursor: all tasks in stage drained AND more stages → state 5", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "IMPLEMENT", "END"] },
        { type: "task_list", stage: "DESIGN", items: ["a", "b"] },
        { type: "task_end", stage: "DESIGN", sub: 1, outcome: "ok" },
        { type: "task_end", stage: "DESIGN", sub: 2, outcome: "ok" },
    ]);
    // First non-done stage is IMPLEMENT (no task_list). State 3 wins
    // over state 5 because the cursor walks the plan and stops at
    // the first stage that needs work — IMPLEMENT needs a TASK_LIST.
    assert.equal(cursor.state, 3);
    assert.equal(cursor.activeStage, "IMPLEMENT");
});

test("summarizeCursor: every stage drained except END (which has no task_list) → state 3 for END", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "END"] },
        { type: "task_list", stage: "DESIGN", items: ["a"] },
        { type: "task_end", stage: "DESIGN", sub: 1, outcome: "ok" },
    ]);
    assert.equal(cursor.state, 3);
    assert.equal(cursor.activeStage, "END");
});

test("summarizeCursor: every stage drained including END → state 6", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["IMPLEMENT", "END"] },
        { type: "task_list", stage: "IMPLEMENT", items: ["a"] },
        { type: "task_end", stage: "IMPLEMENT", sub: 1, outcome: "ok" },
        { type: "task_list", stage: "END", items: ["verify"] },
        { type: "task_end", stage: "END", sub: 1, outcome: "ok" },
    ]);
    assert.equal(cursor.state, 6);
    assert.equal(cursor.activeStage, "END");
});

test("summarizeCursor: grow-project plan reaches state 6 only at END (rubber-duck pin)", () => {
    // grow-project illustrative plan: ... CLOSE → COMMIT → PUSH → END.
    // Draining CLOSE must NOT trigger workitem_end — the cursor must
    // keep advancing through COMMIT, PUSH, END.
    const baseEvents = [
        { type: "workitem_start", kind: "issue", ref: 42, title: "t" },
        { type: "stage_plan", stages: ["IMPLEMENT", "CLOSE", "COMMIT", "PUSH", "END"] },
        { type: "task_list", stage: "IMPLEMENT", items: ["a"] },
        { type: "task_end", stage: "IMPLEMENT", sub: 1, outcome: "ok" },
        { type: "task_list", stage: "CLOSE", items: ["c"] },
        { type: "task_end", stage: "CLOSE", sub: 1, outcome: "ok" },
    ];
    // After CLOSE drained, cursor must move to COMMIT, NOT state 6.
    let cursor = summarizeCursor(baseEvents);
    assert.equal(cursor.state, 3);
    assert.equal(cursor.activeStage, "COMMIT");

    cursor = summarizeCursor([
        ...baseEvents,
        { type: "task_list", stage: "COMMIT", items: ["x"] },
        { type: "task_end", stage: "COMMIT", sub: 1, outcome: "ok" },
        { type: "task_list", stage: "PUSH", items: ["y"] },
        { type: "task_end", stage: "PUSH", sub: 1, outcome: "ok" },
        { type: "task_list", stage: "END", items: ["z"] },
        { type: "task_end", stage: "END", sub: 1, outcome: "ok" },
    ]);
    assert.equal(cursor.state, 6);
    assert.equal(cursor.activeStage, "END");
});

test("summarizeCursor: workitem_end resets cursor → null", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "END"] },
        { type: "workitem_end", kind: "issue", ref: 7 },
    ]);
    assert.equal(cursor, null);
});

test("summarizeCursor: duplicate same-ref workitem_start does NOT reset cursor (rubber-duck pin)", () => {
    // A fresh-session iter that re-emits [WORKITEM_START] for the
    // SAME work item should NOT blow plan/task state back to state 2.
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "END"] },
        { type: "task_list", stage: "DESIGN", items: ["a"] },
        // Duplicate same-ref workitem_start (the bug we're fixing):
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
    ]);
    assert.equal(cursor.state, 4);
    assert.equal(cursor.activeStage, "DESIGN");
    assert.deepEqual(cursor.pendingTasks, [{ sub: 1, desc: "a" }]);
});

test("summarizeCursor: duplicate different-ref workitem_start → null (corrupt stream)", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "a" },
        // Different ref while one is still active without an
        // intervening workitem_end → corrupt.
        { type: "workitem_start", kind: "issue", ref: 8, title: "b" },
    ]);
    assert.equal(cursor, null);
});

test("summarizeCursor: sequential workitems (with workitem_end between) work correctly", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "first" },
        { type: "workitem_end", kind: "issue", ref: 7 },
        { type: "workitem_start", kind: "issue", ref: 8, title: "second" },
    ]);
    assert.equal(cursor.state, 2);
    assert.equal(cursor.workItem.ref, 8);
    assert.equal(cursor.workItem.title, "second");
});

test("summarizeCursor: task_start without task_end → in-flight task surfaces (rubber-duck pin)", () => {
    // Iter killed mid-task: agent should resume the SAME pending task,
    // not advance to the next one.
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "END"] },
        { type: "task_list", stage: "DESIGN", items: ["a", "b", "c"] },
        { type: "task_start", stage: "DESIGN", sub: 1, desc: "a" },
        // No matching task_end — task_start is in flight.
    ]);
    assert.equal(cursor.state, 4);
    assert.equal(cursor.activeStage, "DESIGN");
    // All three tasks still pending (none ended).
    assert.deepEqual(cursor.pendingTasks, [
        { sub: 1, desc: "a" },
        { sub: 2, desc: "b" },
        { sub: 3, desc: "c" },
    ]);
    // taskInFlight surfaces so the preamble can flag "RESUME this task".
    assert.deepEqual(cursor.taskInFlight, { stage: "DESIGN", sub: 1, desc: "a" });
});

test("summarizeCursor: stage_plan_amend with `add` extends the plan", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "END"] },
        { type: "stage_plan_amend", add: "TEST", after: "DESIGN", reason: "agent-amendment" },
    ]);
    assert.equal(cursor.state, 3);
    assert.deepEqual(cursor.plan, ["DESIGN", "TEST", "END"]);
});

test("summarizeCursor: stage_plan_amend with `remove` deletes a stage (rubber-duck pin)", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "REVIEW", "END"] },
        { type: "stage_plan_amend", remove: "REVIEW", reason: "no-longer-needed" },
    ]);
    assert.equal(cursor.state, 3);
    assert.deepEqual(cursor.plan, ["DESIGN", "END"]);
});

test("summarizeCursor: pinned-tail-enforcement remove+add pairs fold correctly", () => {
    // Mirrors what computePinnedTailAmendments emits when the agent
    // misplaced a pinned stage in the head: a remove followed by an
    // add at the tail.
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "COMMIT", "TEST"] },
        { type: "stage_plan_amend", remove: "COMMIT", reason: "pinned-tail-enforcement" },
        { type: "stage_plan_amend", add: "COMMIT", after: "TEST", reason: "pinned-tail-enforcement" },
        { type: "stage_plan_amend", add: "PUSH", after: "COMMIT", reason: "pinned-tail-enforcement" },
        { type: "stage_plan_amend", add: "END", after: "PUSH", reason: "pinned-tail-enforcement" },
    ]);
    assert.deepEqual(cursor.plan, ["DESIGN", "TEST", "COMMIT", "PUSH", "END"]);
});

test("summarizeCursor: iter-close auto-emitted stage_end does NOT advance cursor (rubber-duck pin)", () => {
    // The runner auto-emits a final `stage_end` for the live stage at
    // every iter exit even if the stage isn't drained. The cursor
    // reducer must ignore stage_end events entirely and derive stage
    // progression purely from task_list + task_end coverage.
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "IMPLEMENT", "END"] },
        { type: "task_list", stage: "DESIGN", items: ["a", "b"] },
        { type: "task_end", stage: "DESIGN", sub: 1, outcome: "ok" },
        // Iter ended here. Runner auto-emitted stage_end. Naïve
        // reducers would treat this as "DESIGN finished" and advance
        // to IMPLEMENT, but DESIGN still has task #2 pending.
        { type: "stage_end", stage: 1, stageName: "DESIGN" },
    ]);
    assert.equal(cursor.state, 4, "must stay in state 4 because DESIGN task #2 is still pending");
    assert.equal(cursor.activeStage, "DESIGN");
    assert.deepEqual(cursor.pendingTasks, [{ sub: 2, desc: "b" }]);
});

test("summarizeCursor: defensive — task_list for a stage not in plan is ignored", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "END"] },
        // Bogus task_list for a stage not in plan:
        { type: "task_list", stage: "PHANTOM", items: ["x"] },
    ]);
    assert.equal(cursor.state, 3);
    assert.equal(cursor.activeStage, "DESIGN");
});

test("summarizeCursor: rejects malformed workitem_start (non-finite ref)", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: NaN, title: "t" },
    ]);
    assert.equal(cursor, null);
});

test("summarizeCursor: tolerates non-array input gracefully", () => {
    assert.equal(summarizeCursor(null), null);
    assert.equal(summarizeCursor(undefined), null);
    assert.equal(summarizeCursor("oops"), null);
});

// ─── formatCursorPreamble ───────────────────────────────────────────

test("formatCursorPreamble: state 2 produces a [CURSOR_STATE] block naming the work item", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 112, title: "feat: do thing" },
    ]);
    const preamble = formatCursorPreamble(cursor);
    assert.match(preamble, /^\[CURSOR_STATE\]/);
    assert.match(preamble, /\[\/CURSOR_STATE\]$/);
    assert.match(preamble, /Active work item: issue #112/);
    assert.match(preamble, /STATE 2/);
    assert.match(preamble, /STAGE_PLAN/);
});

test("formatCursorPreamble: state 4 lists active stage + next pending task", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "IMPLEMENT", "END"] },
        { type: "task_list", stage: "DESIGN", items: ["draft API", "list test cases"] },
    ]);
    const preamble = formatCursorPreamble(cursor);
    assert.match(preamble, /Active stage: DESIGN/);
    assert.match(preamble, /Next pending task: #1 "draft API"/);
    assert.match(preamble, /STATE 4/);
});

test("formatCursorPreamble: in-flight task surfaces a RESUME hint (rubber-duck pin)", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 7, title: "t" },
        { type: "stage_plan", stages: ["DESIGN", "END"] },
        { type: "task_list", stage: "DESIGN", items: ["a", "b"] },
        { type: "task_start", stage: "DESIGN", sub: 1, desc: "a" },
    ]);
    const preamble = formatCursorPreamble(cursor);
    assert.match(preamble, /Task in flight/);
    assert.match(preamble, /RESUME this same task/);
});

test("formatCursorPreamble: state 6 directs WORKITEM_END + COMPLETE", () => {
    const cursor = summarizeCursor([
        { type: "workitem_start", kind: "issue", ref: 42, title: "t" },
        { type: "stage_plan", stages: ["IMPLEMENT", "END"] },
        { type: "task_list", stage: "IMPLEMENT", items: ["a"] },
        { type: "task_end", stage: "IMPLEMENT", sub: 1, outcome: "ok" },
        { type: "task_list", stage: "END", items: ["verify"] },
        { type: "task_end", stage: "END", sub: 1, outcome: "ok" },
    ]);
    const preamble = formatCursorPreamble(cursor);
    assert.match(preamble, /STATE 6/);
    assert.match(preamble, /WORKITEM_END/);
    assert.match(preamble, /COMPLETE/);
});

test("formatCursorPreamble: null cursor → empty string", () => {
    assert.equal(formatCursorPreamble(null), "");
    assert.equal(formatCursorPreamble({ workItem: null }), "");
});

// ─── buildCursorPreamble (filesystem I/O) ──────────────────────────

test("buildCursorPreamble: missing events.jsonl returns empty string", () => {
    const { env, cleanup } = makeRunsRootEnv();
    try {
        const out = buildCursorPreamble({ runId: "no-such-run", env });
        assert.equal(out, "");
    } finally { cleanup(); }
});

test("buildCursorPreamble: well-formed events.jsonl produces preamble", () => {
    const { env, root, cleanup } = makeRunsRootEnv();
    try {
        const runId = "test-run-1";
        mkdirSync(join(root, runId), { recursive: true });
        const lines = [
            { type: "armed", runId, ts: 1 },
            { type: "iteration_start", runId, iteration: 1, ts: 2 },
            { type: "workitem_start", runId, iteration: 1, ts: 3, kind: "issue", ref: 99, title: "fix the thing" },
            { type: "iteration_end", runId, iteration: 1, ts: 4 },
        ].map((o) => JSON.stringify(o)).join("\n") + "\n";
        writeFileSync(join(root, runId, "events.jsonl"), lines);
        const out = buildCursorPreamble({ runId, env });
        assert.match(out, /\[CURSOR_STATE\]/);
        assert.match(out, /Active work item: issue #99 — "fix the thing"/);
        assert.match(out, /STATE 2/);
    } finally { cleanup(); }
});

test("buildCursorPreamble: trailing partial JSONL line is silently ignored", () => {
    const { env, root, cleanup } = makeRunsRootEnv();
    try {
        const runId = "test-run-partial";
        mkdirSync(join(root, runId), { recursive: true });
        const goodLine = JSON.stringify({ type: "workitem_start", kind: "issue", ref: 7, title: "t" });
        // Trailing partial line (no \n) — emitter is mid-write.
        const raw = `${goodLine}\n{"type":"workitem_st`;
        writeFileSync(join(root, runId, "events.jsonl"), raw);
        const out = buildCursorPreamble({ runId, env });
        assert.match(out, /Active work item: issue #7/);
    } finally { cleanup(); }
});

test("buildCursorPreamble: interior malformed JSONL line suppresses preamble (rubber-duck pin)", () => {
    const { env, root, cleanup } = makeRunsRootEnv();
    try {
        const runId = "test-run-corrupt";
        mkdirSync(join(root, runId), { recursive: true });
        const raw = [
            JSON.stringify({ type: "workitem_start", kind: "issue", ref: 7, title: "t" }),
            "{not valid json}",
            JSON.stringify({ type: "stage_plan", stages: ["DESIGN", "END"] }),
        ].join("\n") + "\n";
        writeFileSync(join(root, runId, "events.jsonl"), raw);
        const out = buildCursorPreamble({ runId, env });
        assert.equal(out, "");
    } finally { cleanup(); }
});

test("buildCursorPreamble: empty file returns empty string", () => {
    const { env, root, cleanup } = makeRunsRootEnv();
    try {
        const runId = "test-run-empty";
        mkdirSync(join(root, runId), { recursive: true });
        writeFileSync(join(root, runId, "events.jsonl"), "");
        const out = buildCursorPreamble({ runId, env });
        assert.equal(out, "");
    } finally { cleanup(); }
});

test("buildCursorPreamble: empty / missing runId returns empty string", () => {
    const { env, cleanup } = makeRunsRootEnv();
    try {
        assert.equal(buildCursorPreamble({ runId: "", env }), "");
        assert.equal(buildCursorPreamble({ env }), "");
    } finally { cleanup(); }
});

test("buildCursorPreamble: nine workitem_start events for the same ref (the user's bug) → state 2 preamble", () => {
    // Reproduces the user-reported failure mode: 9 iters, 9
    // workitem_start events for the SAME issue, never advancing
    // past state 2. The cursor preamble should now correctly
    // surface "STATE 2 — emit STAGE_PLAN" so iter 10 advances.
    const { env, root, cleanup } = makeRunsRootEnv();
    try {
        const runId = "test-run-9-dup";
        mkdirSync(join(root, runId), { recursive: true });
        const events = [{ type: "armed", runId }];
        for (let i = 1; i <= 9; i++) {
            events.push({ type: "iteration_start", runId, iteration: i });
            events.push({ type: "workitem_start", runId, iteration: i, kind: "issue", ref: 112, title: "feat(prompts): release-cutting stages" });
            events.push({ type: "iteration_end", runId, iteration: i });
        }
        const raw = events.map((o) => JSON.stringify(o)).join("\n") + "\n";
        writeFileSync(join(root, runId, "events.jsonl"), raw);
        const out = buildCursorPreamble({ runId, env });
        assert.match(out, /Active work item: issue #112/);
        assert.match(out, /STATE 2/);
    } finally { cleanup(); }
});
