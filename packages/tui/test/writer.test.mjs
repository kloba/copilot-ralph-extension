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
    pruneRuns,
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

test("aggregateRuns: handles >150k recorded runs without blowing the call stack", () => {
    // Regression: the previous implementation computed iters.max via
    // `Math.max(...iterCounts)`. That spread form throws "Maximum
    // call stack size exceeded" once iterCounts crosses Node's
    // argument-count limit (~150k on V8). A long-lived user with
    // daily self_improve runs would eventually hit that ceiling and
    // `ralph-tui stats` would crash silently. We pump 200_001
    // synthetic entries through aggregateRuns via an in-memory fs
    // stub and assert it returns the expected aggregates.
    const N = 200_001;
    const armedLine = '{"type":"armed","runId":"r","label":"ralph_loop"}';
    const completeLine = '{"type":"complete","runId":"r","reason":"completion_promise","iteration":42}';
    const indexContent = (armedLine + "\n").repeat(N);
    const eventsContent = completeLine + "\n";
    const fakeFs = {
        readFileSync(p) {
            if (typeof p === "string" && p.endsWith("index.jsonl")) return indexContent;
            return eventsContent;
        },
    };
    const r = aggregateRuns({
        fs: fakeFs,
        env: { RALPH_EVENTS_DIR: "/fake" },
    });
    assert.equal(r.total, N);
    assert.equal(r.iters.max, 42);
    assert.equal(r.iters.mean, 42);
    assert.equal(r.byTool.ralph_loop, N);
});

test("pruneRuns: refuses to delete entries whose runId contains traversal segments", () => {
    const root = mkTmp();
    const indexPath = path.join(root, "index.jsonl");
    // Two armed rows: one legitimate (old enough to prune) and one
    // hostile entry whose runId would escape the runs root via
    // path.join. The hostile sibling directory is a sentinel we set
    // up OUTSIDE the runs root and assert is still present after the
    // prune.
    const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-tui-sentinel-"));
    const sentinelMarker = path.join(sentinel, "do-not-delete.txt");
    fs.writeFileSync(sentinelMarker, "keep me\n");
    const goodId = "good-run-id";
    fs.mkdirSync(path.join(root, goodId), { recursive: true });
    fs.writeFileSync(path.join(root, goodId, "events.jsonl"), "");
    const hostileId = `../${path.basename(sentinel)}`;
    fs.writeFileSync(
        indexPath,
        JSON.stringify({ type: "armed", runId: goodId, ts: 100 }) + "\n" +
            JSON.stringify({ type: "armed", runId: hostileId, ts: 100 }) + "\n",
    );
    const result = pruneRuns({
        olderThanMs: 10,
        now: () => 10_000,
        env: { RALPH_EVENTS_DIR: root },
    });
    // Only the legitimate run was removed.
    assert.deepEqual(result.removed.map((r) => r.runId), [goodId]);
    // The hostile row remains in the index (defence-in-depth survival).
    assert.equal(result.kept, 1);
    const survivingIndex = fs.readFileSync(indexPath, "utf8").trim().split("\n")
        .map((l) => JSON.parse(l));
    assert.equal(survivingIndex.length, 1);
    assert.equal(survivingIndex[0].runId, hostileId);
    // And the sibling directory is still on disk.
    assert.ok(fs.existsSync(sentinelMarker), "sentinel must survive prune");
    fs.rmSync(sentinel, { recursive: true, force: true });
});

test("pruneRuns: deletes only the per-run dir, leaves index for fresh runs", () => {
    const root = mkTmp();
    const indexPath = path.join(root, "index.jsonl");
    const oldId = "old-run";
    const newId = "new-run";
    fs.mkdirSync(path.join(root, oldId), { recursive: true });
    fs.writeFileSync(path.join(root, oldId, "events.jsonl"), "x\n");
    fs.mkdirSync(path.join(root, newId), { recursive: true });
    fs.writeFileSync(path.join(root, newId, "events.jsonl"), "y\n");
    fs.writeFileSync(
        indexPath,
        JSON.stringify({ type: "armed", runId: oldId, ts: 1 }) + "\n" +
            JSON.stringify({ type: "armed", runId: newId, ts: 9_500 }) + "\n",
    );
    const result = pruneRuns({
        olderThanMs: 1_000,
        now: () => 10_000,
        env: { RALPH_EVENTS_DIR: root },
    });
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].runId, oldId);
    assert.equal(result.kept, 1);
    assert.ok(!fs.existsSync(path.join(root, oldId)), "old run dir should be gone");
    assert.ok(fs.existsSync(path.join(root, newId)), "new run dir should survive");
});

test("pruneRuns: dryRun never touches the filesystem", () => {
    const root = mkTmp();
    const indexPath = path.join(root, "index.jsonl");
    const oldId = "old-run";
    fs.mkdirSync(path.join(root, oldId), { recursive: true });
    fs.writeFileSync(
        indexPath,
        JSON.stringify({ type: "armed", runId: oldId, ts: 1 }) + "\n",
    );
    const before = fs.readFileSync(indexPath, "utf8");
    const result = pruneRuns({
        olderThanMs: 1,
        dryRun: true,
        now: () => 10_000,
        env: { RALPH_EVENTS_DIR: root },
    });
    assert.equal(result.removed.length, 1);
    assert.ok(fs.existsSync(path.join(root, oldId)), "dryRun must not delete");
    assert.equal(fs.readFileSync(indexPath, "utf8"), before, "dryRun must not rewrite index");
});

test("pruneRuns: rejects bad olderThanMs argument", () => {
    assert.throws(() => pruneRuns({ olderThanMs: -1 }), /non-negative/);
    assert.throws(() => pruneRuns({ olderThanMs: NaN }), /non-negative/);
    assert.throws(() => pruneRuns({ olderThanMs: "10" }), /non-negative/);
});

test("pruneRuns: missing index.jsonl returns empty result", () => {
    const root = mkTmp();
    const result = pruneRuns({
        olderThanMs: 1,
        env: { RALPH_EVENTS_DIR: root },
    });
    assert.deepEqual(result, { removed: [], kept: 0 });
});

test("createEventWriter: rejects path-traversal runIds (sandbox-escape guard)", () => {
    // Pre-iter-146 createEventWriter only validated runId for non-empty
    // string — its sibling resolveRunEventsPath (read path) and
    // pruneRuns (delete path) had isPathTraversalRunId guards but the
    // primary write surface did not. A runId like "../escape" or
    // "a/b" would silently escape the runs root via
    // path.join(root, runId, "events.jsonl"). Production runIds come
    // from makeRunId which only emits [A-Za-z0-9_-], so this is
    // defensive — but it brings the read/write/delete paths into the
    // same lockstep contract.
    const cases = [
        { runId: "../escape", label: "parent-relative" },
        { runId: "a/b", label: "embedded slash" },
        { runId: "a\\b", label: "embedded backslash" },
        { runId: ".", label: "current-dir literal" },
        { runId: "..", label: "parent-dir literal" },
        { runId: "ralph_loop-1/../etc", label: "valid prefix + traversal" },
        { runId: "with\0null", label: "null byte" },
    ];
    for (const { runId, label } of cases) {
        assert.throws(
            () => createEventWriter({ runId, env: { RALPH_EVENTS_DIR: "/tmp/ralph-test-traversal" } }),
            (err) => err instanceof TypeError && /path separators or traversal segments/.test(err.message),
            `runId ${JSON.stringify(runId)} (${label}) must throw a TypeError before any fs work`,
        );
    }

    // Symmetry: the canonical makeRunId-shape MUST still pass — the guard
    // must reject ONLY traversal payloads, never legitimate runIds.
    const tmp = mkTmp();
    try {
        const w = createEventWriter({
            runId: "ralph_loop-deadbeef",
            env: { RALPH_EVENTS_DIR: tmp },
        });
        assert.equal(typeof w.emit, "function", "legitimate runIds must still construct successfully");
        w.close();
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("traversal-guard error message prefixes the calling function name (assertSafeRunId)", () => {
    // Iter 148 — both `resolveRunEventsPath` and `createEventWriter`
    // route their traversal guard through a shared `assertSafeRunId`
    // helper (extracted to prevent the two call sites from drifting
    // apart on future edits, e.g. one of them updates the message and
    // the other doesn't). The contract `assertSafeRunId` provides is:
    // every caller prefixes its OWN function name in the TypeError
    // message so a stack-truncated error log still tells the operator
    // which surface rejected the runId. Pin that contract here so a
    // future regression that hardcodes a single name (or drops the
    // prefix entirely) fails loudly.
    assert.throws(
        () => resolveRunEventsPath("../etc"),
        (err) => err instanceof TypeError
            && err.message.startsWith("resolveRunEventsPath:")
            && /path separators or traversal segments/.test(err.message),
        "resolveRunEventsPath must prefix its own name in the traversal-guard TypeError",
    );
    assert.throws(
        () => createEventWriter({ runId: "../etc", env: { RALPH_EVENTS_DIR: "/tmp/ralph-test-traversal-prefix" } }),
        (err) => err instanceof TypeError
            && err.message.startsWith("createEventWriter:")
            && /path separators or traversal segments/.test(err.message),
        "createEventWriter must prefix its own name (NOT resolveRunEventsPath's) in the traversal-guard TypeError",
    );
});

test("aggregateRuns: hand-edited iteration=Infinity (1e500) row is skipped, not propagated to iters.max/mean", () => {
    // Iter 158 — JSON.parse('{"iteration": 1e500}') yields
    // `{iteration: Infinity}` because the literal overflows IEEE-754
    // double precision. Pre-iter-158, aggregateRuns' inner loop guarded
    // only `typeof obj.iteration === "number"` (Infinity passes), so the
    // value propagated to lastIter → iterCounts → `iters.max = Infinity`
    // and `iters.mean = NaN`/Infinity (Infinity participates in the sum;
    // dividing by length stays Infinity, but a mix of Infinity + finite
    // values yields NaN paths). The fix added a `Number.isFinite` guard.
    // Pin the contract so a future "simplify the conditional" refactor
    // that drops the guard fires this test red.
    //
    // The writer never emits Infinity (`JSON.stringify(Infinity)` → "null"),
    // but a hand-edited or corrupted events.jsonl row CAN reach
    // aggregateRuns through `readEventsFile`; the function is best-effort
    // and must not let a single malformed row poison the whole stats
    // output for `ralph-tui stats`.
    const root = mkTmp();
    fs.mkdirSync(path.join(root, "evil-1"), { recursive: true });
    // Hand-write the events.jsonl directly (writeRun would JSON.stringify
    // and lose the literal). The sane-row + crazy-row combination pins
    // that the OTHER row's iteration (a finite 4) wins.
    const lines = [
        JSON.stringify({ type: "armed", ts: 1, runId: "evil-1", label: "ralph_loop" }),
        JSON.stringify({ type: "iteration_end", ts: 2, runId: "evil-1", iteration: 4 }),
        // Hand-injected literal — Number.MAX_VALUE * 2 → Infinity in JS.
        '{"type": "iteration_end", "ts": 3, "runId": "evil-1", "iteration": 1e500}',
        JSON.stringify({ type: "complete", ts: 4, runId: "evil-1", reason: "max_iterations", iteration: 4 }),
    ];
    fs.writeFileSync(path.join(root, "evil-1", "events.jsonl"), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(root, "index.jsonl"),
        JSON.stringify({ type: "armed", ts: 1, runId: "evil-1", label: "ralph_loop" }) + "\n");
    const r = aggregateRuns({ env: { RALPH_EVENTS_DIR: root } });
    assert.equal(Number.isFinite(r.iters.max), true,
        "iters.max must stay finite even with a hand-edited 1e500 iteration row");
    assert.equal(Number.isFinite(r.iters.mean), true,
        "iters.mean must stay finite even with a hand-edited 1e500 iteration row");
    // The crazy row was skipped, so the surviving max comes from the
    // sane finite rows (iteration=4 in two events).
    assert.equal(r.iters.max, 4, "iters.max must reflect the highest FINITE iteration only");
    assert.equal(r.iters.mean, 4, "iters.mean must reflect the highest FINITE iteration only");
});
