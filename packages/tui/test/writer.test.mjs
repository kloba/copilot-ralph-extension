import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    createEventWriter,
    readRunIndex,
    resolveRunEventsPath,
    resolveRunsRoot,
    aggregateRuns,
} from "../src/writer.mjs";
import { makeRunId } from "../src/events.mjs";

function mkTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ralph-tui-writer-"));
}

function readLines(filePath) {
    return fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
}

test("resolveRunsRoot honours $RALPH_EVENTS_DIR", () => {
    assert.equal(resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "/tmp/x" } }), "/tmp/x");
});

test("resolveRunsRoot defaults to $HOME/.copilot/ralph/runs", () => {
    const fakeOs = { homedir: () => "/h" };
    assert.equal(resolveRunsRoot({ env: {}, os: fakeOs }), "/h/.copilot/ralph/runs");
});

test("resolveRunEventsPath joins runId under the runs root", () => {
    const p = resolveRunEventsPath("ralph_loop-1", { env: { RALPH_EVENTS_DIR: "/tmp/r" } });
    assert.equal(p, "/tmp/r/ralph_loop-1/events.jsonl");
});

test("resolveRunEventsPath rejects empty runId", () => {
    assert.throws(() => resolveRunEventsPath("", {}), /non-empty string/);
});

test("resolveRunEventsPath rejects path-traversal runIds", () => {
    const env = { RALPH_EVENTS_DIR: "/tmp/r" };
    for (const bad of ["..", ".", "../etc", "foo/../bar", "foo/bar", "foo\\bar", "..\\etc", "foo\0bar"]) {
        assert.throws(
            () => resolveRunEventsPath(bad, { env }),
            /path separators or traversal segments/,
            `expected ${JSON.stringify(bad)} to be rejected`,
        );
    }
});

test("resolveRunEventsPath accepts legitimately-shaped runIds", () => {
    const env = { RALPH_EVENTS_DIR: "/tmp/r" };
    // Emitter-produced shape: [A-Za-z0-9_-]+
    for (const ok of ["ralph_loop-1", "self_improve-1700000000000", "grow_project-42", "a-b_c-1"]) {
        assert.doesNotThrow(() => resolveRunEventsPath(ok, { env }));
    }
});

test("createEventWriter: emits a valid armed line and creates the run dir", () => {
    const root = mkTmp();
    const runId = makeRunId("ralph_loop", 1700000000000);
    const w = createEventWriter({
        runId,
        label: "ralph_loop",
        env: { RALPH_EVENTS_DIR: root },
        now: () => 1700000000000,
    });
    w.emit({ type: "armed", maxIterations: 20, minIterations: 5 });
    const lines = readLines(w.path);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, "armed");
    assert.equal(lines[0].runId, runId);
    assert.equal(lines[0].label, "ralph_loop");
    assert.equal(lines[0].maxIterations, 20);
    assert.equal(lines[0].ts, 1700000000000);
});

test("createEventWriter: index.jsonl gains a row only on armed events", () => {
    const root = mkTmp();
    const w = createEventWriter({
        runId: "self_improve-2",
        label: "self_improve",
        env: { RALPH_EVENTS_DIR: root },
        now: () => 2,
    });
    w.emit({ type: "armed" });
    w.emit({ type: "iteration_start", iteration: 1 });
    w.emit({ type: "iteration_end", iteration: 1, excerpt: "hi" });
    const indexLines = readLines(path.join(root, "index.jsonl"));
    assert.equal(indexLines.length, 1);
    assert.equal(indexLines[0].type, "armed");
    assert.equal(indexLines[0].runId, "self_improve-2");
});

test("createEventWriter: ts is auto-filled from injected clock when caller omits it", () => {
    const root = mkTmp();
    const ticks = [10, 20, 30];
    const w = createEventWriter({
        runId: "r-ts",
        env: { RALPH_EVENTS_DIR: root },
        now: () => ticks.shift(),
    });
    w.emit({ type: "armed" });
    w.emit({ type: "iteration_start", iteration: 1 });
    w.emit({ type: "iteration_end", iteration: 1 });
    const lines = readLines(w.path);
    assert.deepEqual(lines.map((l) => l.ts), [10, 20, 30]);
});

test("createEventWriter: caller-provided ts is preserved", () => {
    const root = mkTmp();
    const w = createEventWriter({
        runId: "r-ts2",
        env: { RALPH_EVENTS_DIR: root },
        now: () => 999,
    });
    w.emit({ type: "armed", ts: 1234 });
    const lines = readLines(w.path);
    assert.equal(lines[0].ts, 1234);
});

test("createEventWriter: serializer failures route through onError, not throw", () => {
    const root = mkTmp();
    const errs = [];
    const w = createEventWriter({
        runId: "r-bad",
        env: { RALPH_EVENTS_DIR: root },
        now: () => 1,
        onError: (e) => errs.push(e),
    });
    w.emit({ type: "totally-not-real" });
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /unknown event type/);
    // The events file must NOT have gained a line for the rejected event.
    assert.equal(fs.existsSync(w.path), false, "no file should be created from a rejected event");
});

test("createEventWriter: close() makes subsequent emits no-ops", () => {
    const root = mkTmp();
    const w = createEventWriter({
        runId: "r-close",
        env: { RALPH_EVENTS_DIR: root },
        now: () => 1,
    });
    w.emit({ type: "armed" });
    w.close();
    w.emit({ type: "iteration_start", iteration: 1 });
    const lines = readLines(w.path);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, "armed");
});

test("createEventWriter: rejects non-object events through onError (no throw)", () => {
    const root = mkTmp();
    const errs = [];
    const w = createEventWriter({
        runId: "r-nono",
        env: { RALPH_EVENTS_DIR: root },
        onError: (e) => errs.push(e),
    });
    w.emit("oops");
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /event must be an object/);
});

test("createEventWriter: armed getter flips after first armed emit", () => {
    const root = mkTmp();
    const w = createEventWriter({ runId: "r-armed", env: { RALPH_EVENTS_DIR: root } });
    assert.equal(w.armed, false);
    w.emit({ type: "armed" });
    assert.equal(w.armed, true);
});

test("readRunIndex: empty when index.jsonl is missing", () => {
    const root = mkTmp();
    assert.deepEqual(readRunIndex({ env: { RALPH_EVENTS_DIR: root } }), []);
});

test("readRunIndex: returns entries newest-first", () => {
    const root = mkTmp();
    const w1 = createEventWriter({ runId: "r-1", label: "ralph_loop", env: { RALPH_EVENTS_DIR: root }, now: () => 100 });
    w1.emit({ type: "armed" });
    const w2 = createEventWriter({ runId: "r-2", label: "self_improve", env: { RALPH_EVENTS_DIR: root }, now: () => 200 });
    w2.emit({ type: "armed" });
    const w3 = createEventWriter({ runId: "r-3", label: "grow_project", env: { RALPH_EVENTS_DIR: root }, now: () => 300 });
    w3.emit({ type: "armed" });
    const entries = readRunIndex({ env: { RALPH_EVENTS_DIR: root } });
    assert.deepEqual(entries.map((e) => e.runId), ["r-3", "r-2", "r-1"]);
    assert.equal(entries[0].label, "grow_project");
});

test("readRunIndex: skips malformed lines, keeps good ones", () => {
    const root = mkTmp();
    const indexPath = path.join(root, "index.jsonl");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(indexPath, [
        "{not json}",
        JSON.stringify({ type: "armed", ts: 1, runId: "ok-1", label: "ralph_loop" }),
        "",
        JSON.stringify({ type: "weird", ts: 2, runId: "skip" }),
        JSON.stringify({ type: "armed", ts: 3, runId: "ok-2", label: "ralph_loop" }),
    ].join("\n") + "\n");
    const entries = readRunIndex({ env: { RALPH_EVENTS_DIR: root } });
    assert.deepEqual(entries.map((e) => e.runId), ["ok-2", "ok-1"]);
});

// ---- aggregateRuns ----

function writeRun(root, runId, label, lines) {
    fs.mkdirSync(path.join(root, runId), { recursive: true });
    fs.writeFileSync(path.join(root, runId, "events.jsonl"), lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
    fs.appendFileSync(path.join(root, "index.jsonl"),
        JSON.stringify({ type: "armed", ts: lines[0]?.ts ?? 0, runId, label }) + "\n");
}

test("aggregateRuns: empty index yields zero totals", () => {
    const root = mkTmp();
    const r = aggregateRuns({ env: { RALPH_EVENTS_DIR: root } });
    assert.equal(r.total, 0);
    assert.deepEqual(r.byTool, {});
    assert.deepEqual(r.byReason, {});
    assert.equal(r.iters.max, 0);
    assert.equal(r.iters.mean, 0);
});

test("aggregateRuns: run with no terminal event counts toward total + byTool but not byReason", () => {
    const root = mkTmp();
    writeRun(root, "ralph_loop-1", "ralph_loop", [
        { type: "armed", ts: 1, runId: "ralph_loop-1", label: "ralph_loop" },
        { type: "iteration_start", ts: 2, runId: "ralph_loop-1", iteration: 1 },
        { type: "iteration_end", ts: 3, runId: "ralph_loop-1", iteration: 1 },
    ]);
    const r = aggregateRuns({ env: { RALPH_EVENTS_DIR: root } });
    assert.equal(r.total, 1);
    assert.deepEqual(r.byTool, { ralph_loop: 1 });
    assert.deepEqual(r.byReason, {});
    assert.equal(r.iters.max, 1);
    assert.equal(r.iters.mean, 1);
});

test("aggregateRuns: last terminal event wins when multiple are present", () => {
    const root = mkTmp();
    // Pathological but possible: a writer somehow appended both abort and
    // complete. The aggregator should bucket the LAST one (complete).
    writeRun(root, "self_improve-1", "self_improve", [
        { type: "armed", ts: 1, runId: "self_improve-1", label: "self_improve" },
        { type: "abort", ts: 2, runId: "self_improve-1", reason: "stagnation", iteration: 3 },
        { type: "complete", ts: 3, runId: "self_improve-1", reason: "completion_promise", iteration: 5 },
    ]);
    const r = aggregateRuns({ env: { RALPH_EVENTS_DIR: root } });
    assert.deepEqual(r.byReason, { "complete:completion_promise": 1 });
    assert.equal(r.iters.max, 5);
});

test("aggregateRuns: skips runs whose events.jsonl is missing", () => {
    const root = mkTmp();
    // Index claims a run exists, but no events.jsonl on disk.
    fs.writeFileSync(path.join(root, "index.jsonl"),
        JSON.stringify({ type: "armed", ts: 1, runId: "ghost-1", label: "ralph_loop" }) + "\n");
    const r = aggregateRuns({ env: { RALPH_EVENTS_DIR: root } });
    assert.equal(r.total, 1);
    assert.deepEqual(r.byTool, { ralph_loop: 1 });
    assert.deepEqual(r.byReason, {});
    assert.equal(r.iters.max, 0);
});

test("aggregateRuns: malformed JSONL lines are skipped silently", () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, "rl-1"), { recursive: true });
    fs.writeFileSync(path.join(root, "rl-1", "events.jsonl"), [
        JSON.stringify({ type: "armed", ts: 1, runId: "rl-1", label: "ralph_loop" }),
        "{not-json",
        "",
        JSON.stringify({ type: "iteration_end", ts: 2, runId: "rl-1", iteration: 4 }),
        JSON.stringify({ type: "complete", ts: 3, runId: "rl-1", reason: "completion_promise", iteration: 4 }),
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(root, "index.jsonl"),
        JSON.stringify({ type: "armed", ts: 1, runId: "rl-1", label: "ralph_loop" }) + "\n");
    const r = aggregateRuns({ env: { RALPH_EVENTS_DIR: root } });
    assert.equal(r.total, 1);
    assert.deepEqual(r.byReason, { "complete:completion_promise": 1 });
    assert.equal(r.iters.max, 4);
});

test("aggregateRuns: terminal event without reason buckets under bare type", () => {
    const root = mkTmp();
    writeRun(root, "rl-2", "ralph_loop", [
        { type: "armed", ts: 1, runId: "rl-2", label: "ralph_loop" },
        { type: "abort", ts: 2, runId: "rl-2", iteration: 2 },
    ]);
    const r = aggregateRuns({ env: { RALPH_EVENTS_DIR: root } });
    assert.deepEqual(r.byReason, { abort: 1 });
});

test("aggregateRuns: mean is arithmetic over runs with iterations", () => {
    const root = mkTmp();
    writeRun(root, "a-1", "ralph_loop", [
        { type: "armed", ts: 1, runId: "a-1", label: "ralph_loop" },
        { type: "complete", ts: 2, runId: "a-1", reason: "completion_promise", iteration: 2 },
    ]);
    writeRun(root, "a-2", "ralph_loop", [
        { type: "armed", ts: 3, runId: "a-2", label: "ralph_loop" },
        { type: "complete", ts: 4, runId: "a-2", reason: "completion_promise", iteration: 8 },
    ]);
    const r = aggregateRuns({ env: { RALPH_EVENTS_DIR: root } });
    assert.equal(r.total, 2);
    assert.equal(r.iters.max, 8);
    assert.equal(r.iters.mean, 5);
});
