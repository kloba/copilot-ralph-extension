// Tests for issue #66 — per-iter git worktree lifecycle helpers in
// `runner.mjs`. Covers:
//   - createIterWorktree path / branch composition + invocation shape
//   - removeIterWorktree happy path + branch deletion
//   - verifyMerged ancestor check (true / false / git error)
//   - sweepOrphanWorktrees skips active runs, removes terminated ones
//   - end-to-end: an iter that COMPLETEs spawns + tears down a worktree
//   - end-to-end: an iter that fails BEFORE END preserves the worktree
//
// All tests use an injected `gitExec` so no real `git` is invoked.
// One stretch-goal e2e exercises `git --version`-gated real worktree
// creation in a tmp repo; it is `t.skip()`-ed when git is unavailable.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    existsSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
    runRalphTui,
    createIterWorktree,
    removeIterWorktree,
    verifyMerged,
    sweepOrphanWorktrees,
    worktreePathFor,
    worktreeBranchFor,
    DEFAULT_WORKTREE_BASE_REF,
} from "../src/runner.mjs";

function tmp() {
    return mkdtempSync(join(tmpdir(), "ralph-tui-worktree-"));
}

function makeEnv(extra = {}) {
    return {
        RALPH_TUI_RUNS_DIR: extra.RALPH_TUI_RUNS_DIR ?? tmp(),
        ...extra,
    };
}

// Mock spawn that returns scripted stdout/exitCode for each call.
function makeMockSpawn(scripts) {
    let i = 0;
    return function mockSpawn(_bin, args) {
        const script = scripts[i++] ?? scripts[scripts.length - 1];
        const handlers = { stdout: [], stderr: [], close: [], error: [] };
        const child = {
            stdout: { on: (ev, fn) => handlers.stdout.push(fn) },
            stderr: { on: (ev, fn) => handlers.stderr.push(fn) },
            on: (ev, fn) => { if (ev === "close") handlers.close.push(fn); if (ev === "error") handlers.error.push(fn); },
            kill: () => {},
            __args: args,
        };
        setImmediate(() => {
            for (const fn of handlers.stdout) fn(Buffer.from(script.stdout ?? ""));
            for (const fn of handlers.close) fn(script.exitCode ?? 0);
        });
        return child;
    };
}

// ───────────── Pure helpers ─────────────

test("worktreePathFor: composes the canonical iter path under the runs root", () => {
    const out = worktreePathFor({
        runsRoot: "/runs",
        runId: "ralph-tui-self-improve-1700000000000",
        iter: 5,
    });
    assert.equal(out, "/runs/ralph-tui-self-improve-1700000000000/worktrees/iter-5");
});

test("worktreePathFor: rejects bad input", () => {
    assert.throws(() => worktreePathFor({ runsRoot: "", runId: "r", iter: 1 }), /runsRoot/);
    assert.throws(() => worktreePathFor({ runsRoot: "/r", runId: "", iter: 1 }), /runId/);
    assert.throws(() => worktreePathFor({ runsRoot: "/r", runId: "r", iter: 0 }), /positive integer/);
    assert.throws(() => worktreePathFor({ runsRoot: "/r", runId: "r", iter: -1 }), /positive integer/);
});

test("worktreeBranchFor: composes the canonical autopilot/<runId>/iter-<N> branch", () => {
    assert.equal(
        worktreeBranchFor({ runId: "ralph-tui-grow-project-1700000000000", iter: 12 }),
        "autopilot/ralph-tui-grow-project-1700000000000/iter-12",
    );
});

test("DEFAULT_WORKTREE_BASE_REF is `main`", () => {
    assert.equal(DEFAULT_WORKTREE_BASE_REF, "main");
});

// ───────────── createIterWorktree ─────────────

test("createIterWorktree: invokes `git worktree add -b <branch> <path> <baseRef>`", () => {
    const calls = [];
    const gitExec = (req) => {
        calls.push(req);
        return ""; // success
    };
    const out = createIterWorktree({
        runId: "r-1",
        iter: 3,
        baseRef: "main",
        runsRoot: "/runs",
        cwd: "/repo",
        env: { X: "y" },
        gitExec,
        mkdir: () => {},
    });
    assert.deepEqual(out, {
        path: "/runs/r-1/worktrees/iter-3",
        branch: "autopilot/r-1/iter-3",
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
        "worktree", "add", "-b",
        "autopilot/r-1/iter-3",
        "/runs/r-1/worktrees/iter-3",
        "main",
    ]);
    assert.equal(calls[0].cwd, "/repo");
});

test("createIterWorktree: defaults baseRef to main when missing", () => {
    const calls = [];
    const gitExec = (req) => { calls.push(req); return ""; };
    createIterWorktree({
        runId: "r-1",
        iter: 1,
        runsRoot: "/runs",
        cwd: "/repo",
        env: {},
        gitExec,
        mkdir: () => {},
    });
    assert.equal(calls[0].args[5], "main");
});

test("createIterWorktree: returns null when gitExec returns null (git missing / branch collision)", () => {
    const out = createIterWorktree({
        runId: "r-1",
        iter: 1,
        runsRoot: "/runs",
        cwd: "/repo",
        env: {},
        gitExec: () => null,
        mkdir: () => {},
    });
    assert.equal(out, null);
});

test("createIterWorktree: returns null when gitExec is missing", () => {
    const out = createIterWorktree({
        runId: "r-1",
        iter: 1,
        runsRoot: "/runs",
        cwd: "/repo",
        env: {},
    });
    assert.equal(out, null);
});

test("createIterWorktree: returns null when mkdir throws", () => {
    const out = createIterWorktree({
        runId: "r-1",
        iter: 1,
        runsRoot: "/runs",
        cwd: "/repo",
        env: {},
        gitExec: () => "",
        mkdir: () => { throw new Error("EACCES"); },
    });
    assert.equal(out, null);
});

// ───────────── removeIterWorktree ─────────────

test("removeIterWorktree: invokes `git worktree remove --force` then `git branch -D`", () => {
    const calls = [];
    const gitExec = (req) => { calls.push(req); return ""; };
    const ok = removeIterWorktree({
        path: "/runs/r-1/worktrees/iter-3",
        branch: "autopilot/r-1/iter-3",
        cwd: "/repo",
        env: {},
        gitExec,
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", "/runs/r-1/worktrees/iter-3"]);
    assert.deepEqual(calls[1].args, ["branch", "-D", "autopilot/r-1/iter-3"]);
});

test("removeIterWorktree: false when worktree remove fails", () => {
    const ok = removeIterWorktree({
        path: "/p",
        branch: "b",
        cwd: "/repo",
        env: {},
        gitExec: () => null,
    });
    assert.equal(ok, false);
});

test("removeIterWorktree: false when branch delete fails (worktree was removed but branch still around)", () => {
    let n = 0;
    const gitExec = () => (++n === 1 ? "" : null);
    const ok = removeIterWorktree({
        path: "/p",
        branch: "b",
        cwd: "/repo",
        env: {},
        gitExec,
    });
    assert.equal(ok, false);
    assert.equal(n, 2, "both calls attempted");
});

test("removeIterWorktree: skips branch deletion when branch is empty (only removes worktree)", () => {
    const calls = [];
    const gitExec = (req) => { calls.push(req); return ""; };
    const ok = removeIterWorktree({
        path: "/p",
        branch: "",
        cwd: "/repo",
        env: {},
        gitExec,
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
});

// ───────────── verifyMerged ─────────────

test("verifyMerged: returns true when merge-base --is-ancestor exits 0", () => {
    const calls = [];
    const gitExec = (req) => {
        calls.push(req.args.join(" "));
        return ""; // success on every call
    };
    assert.equal(
        verifyMerged({ branch: "autopilot/r/iter-1", baseRef: "main", cwd: "/repo", env: {}, gitExec }),
        true,
    );
    // First a fetch, then merge-base.
    assert.equal(calls[0], "fetch --quiet");
    assert.equal(calls[1], "merge-base --is-ancestor autopilot/r/iter-1 main");
});

test("verifyMerged: returns false when merge-base returns null", () => {
    let n = 0;
    const gitExec = () => (++n === 1 ? "" : null); // fetch ok, merge-base says NO
    assert.equal(
        verifyMerged({ branch: "b", baseRef: "main", cwd: "/repo", env: {}, gitExec }),
        false,
    );
});

test("verifyMerged: tolerates fetch failure (offline/auth) and still runs merge-base", () => {
    let n = 0;
    const calls = [];
    const gitExec = (req) => {
        calls.push(req.args[0]);
        n += 1;
        if (n === 1) return null; // fetch fails
        return "";                 // merge-base succeeds
    };
    assert.equal(
        verifyMerged({ branch: "b", baseRef: "main", cwd: "/repo", env: {}, gitExec }),
        true,
    );
    assert.deepEqual(calls, ["fetch", "merge-base"]);
});

test("verifyMerged: returns false when gitExec missing or branch empty", () => {
    assert.equal(verifyMerged({ branch: "b", baseRef: "main", cwd: "/r", env: {} }), false);
    assert.equal(verifyMerged({ branch: "", baseRef: "main", cwd: "/r", env: {}, gitExec: () => "" }), false);
});

// ───────────── sweepOrphanWorktrees (D7) ─────────────

test("sweepOrphanWorktrees: removes orphan dirs whose state.json says terminated", () => {
    const root = tmp();
    const runId = "ralph-tui-self-improve-1";
    mkdirSync(join(root, runId, "worktrees", "iter-1"), { recursive: true });
    writeFileSync(
        join(root, runId, "state.json"),
        JSON.stringify({ terminated: true, runId, mode: "self-improve" }),
    );
    const calls = [];
    const gitExec = (req) => { calls.push(req); return ""; };
    const removed = sweepOrphanWorktrees({
        runsRoot: root,
        cwd: "/repo",
        env: { RALPH_TUI_RUNS_DIR: root },
        gitExec,
    });
    rmSync(root, { recursive: true, force: true });
    assert.equal(removed, 1);
    assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", join(root, runId, "worktrees", "iter-1")]);
});

test("sweepOrphanWorktrees: leaves worktrees of in-flight (non-terminated) runs alone", () => {
    const root = tmp();
    const runId = "ralph-tui-self-improve-2";
    mkdirSync(join(root, runId, "worktrees", "iter-1"), { recursive: true });
    writeFileSync(
        join(root, runId, "state.json"),
        JSON.stringify({ terminated: false, runId, mode: "self-improve" }),
    );
    const calls = [];
    const gitExec = (req) => { calls.push(req); return ""; };
    const removed = sweepOrphanWorktrees({
        runsRoot: root,
        cwd: "/repo",
        env: { RALPH_TUI_RUNS_DIR: root },
        gitExec,
    });
    rmSync(root, { recursive: true, force: true });
    assert.equal(removed, 0);
    assert.equal(calls.length, 0);
});

test("sweepOrphanWorktrees: returns 0 when runsRoot does not exist", () => {
    const root = join(tmp(), "nope");
    const removed = sweepOrphanWorktrees({
        runsRoot: root,
        cwd: "/repo",
        env: {},
        gitExec: () => "",
    });
    assert.equal(removed, 0);
});

test("sweepOrphanWorktrees: stops when budgetMs exhausted", () => {
    const root = tmp();
    for (const r of ["a", "b"]) {
        mkdirSync(join(root, r, "worktrees", "iter-1"), { recursive: true });
        writeFileSync(join(root, r, "state.json"),
            JSON.stringify({ terminated: true, runId: r, mode: "self-improve" }));
    }
    let nowMs = 1000;
    const calls = [];
    const gitExec = (req) => { calls.push(req); nowMs += 500; return ""; };
    const removed = sweepOrphanWorktrees({
        runsRoot: root,
        cwd: "/repo",
        env: { RALPH_TUI_RUNS_DIR: root },
        gitExec,
        budgetMs: 200,
        now: () => nowMs,
    });
    rmSync(root, { recursive: true, force: true });
    // First call drains the budget; second run dir gets skipped.
    assert.equal(removed, 1);
});

// ───────────── End-to-end: runRalphTui with worktree on ─────────────

test("runRalphTui: COMPLETE iter with worktree=true triggers create + remove + worktree_removed event", async () => {
    const events = [];
    const eventEmitter = {
        runId: "wt-complete",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    // gitExec stub: handle worktree add, fetch, merge-base, worktree
    // remove, branch -D. Returns "" (success) for all.
    const gitCalls = [];
    const gitExec = ({ args }) => {
        gitCalls.push(args.join(" "));
        return "";
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: "[STAGE: ORIENT]\n[STAGE: COMMIT]\n[STAGE: PUSH]\n[STAGE: END]\nCOMPLETE" } }),
        JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
    ].join("\n") + "\n";
    const spawn = makeMockSpawn([{ stdout, exitCode: 0 }]);
    await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
        gitExec,
        // worktree default-on for self-improve, but be explicit.
        worktree: true,
    });
    // worktree_created emitted at iter start.
    const created = events.filter((e) => e.type === "worktree_created");
    assert.equal(created.length, 1);
    assert.equal(created[0].iteration, 1);
    assert.match(created[0].path, /worktrees\/iter-1$/);
    assert.match(created[0].branch, /autopilot\/.+\/iter-1$/);
    // worktree_removed (not _kept) — END seen + verifyMerged true.
    const removed = events.filter((e) => e.type === "worktree_removed");
    assert.equal(removed.length, 1);
    assert.equal(events.filter((e) => e.type === "worktree_kept").length, 0);
    // Subprocess cwd was the worktree path (iter cwd != process.cwd()).
    // We can check this by ensuring the spawn arg log saw it via the
    // mock's __args (cwd is opts, not args; check via the post-iter
    // commit_observed cwd if possible). Since our mock doesn't capture
    // opts here, assert the worktree_created event's path was non-empty
    // — that's the same value the runner passed as cwd.
    assert.ok(created[0].path);
});

test("runRalphTui: iter without END marker keeps worktree (worktree_kept event with absolute path)", async () => {
    const events = [];
    const eventEmitter = {
        runId: "wt-keep",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const gitExec = () => ""; // every git call succeeds
    // No [STAGE: END] marker — agent emits ABORT_NO_IMPROVEMENTS so
    // the iter terminates without reaching the canonical end.
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: "[STAGE: ORIENT]\nABORT_NO_IMPROVEMENTS" } }),
        JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
    ].join("\n") + "\n";
    const spawn = makeMockSpawn([{ stdout, exitCode: 0 }]);
    await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
        gitExec,
        worktree: true,
    });
    const created = events.filter((e) => e.type === "worktree_created");
    const kept = events.filter((e) => e.type === "worktree_kept");
    const removed = events.filter((e) => e.type === "worktree_removed");
    assert.equal(created.length, 1, "worktree_created emitted on iter start");
    assert.equal(removed.length, 0, "no worktree_removed because END not seen");
    assert.equal(kept.length, 1, "worktree_kept records the preserved sandbox");
    assert.equal(kept[0].path, created[0].path);
    assert.equal(kept[0].branch, created[0].branch);
    // Worktree path is absolute under the runs root.
    assert.ok(kept[0].path.startsWith("/") || /^[A-Z]:/.test(kept[0].path),
        "worktree path is absolute");
});

test("runRalphTui: END seen but verifyMerged false → worktree_kept (changes not merged)", async () => {
    const events = [];
    const eventEmitter = {
        runId: "wt-not-merged",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    // gitExec: succeed at create + fetch, FAIL at merge-base
    // (returns null = "not an ancestor"). The runner should treat
    // the iter as not-merged and emit worktree_kept.
    const gitExec = ({ args }) => {
        if (args[0] === "merge-base") return null; // not merged
        return "";
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: "[STAGE: COMMIT]\n[STAGE: PUSH]\n[STAGE: END]\nCOMPLETE" } }),
        JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
    ].join("\n") + "\n";
    const spawn = makeMockSpawn([{ stdout, exitCode: 0 }]);
    await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
        gitExec,
        worktree: true,
    });
    assert.equal(events.filter((e) => e.type === "worktree_removed").length, 0);
    assert.equal(events.filter((e) => e.type === "worktree_kept").length, 1);
});

test("runRalphTui: worktree=false (explicit opt-out) skips worktree machinery entirely", async () => {
    const events = [];
    const eventEmitter = {
        runId: "wt-disabled",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const gitCalls = [];
    const gitExec = ({ args }) => {
        gitCalls.push(args.join(" "));
        return null; // every call returns null so no commit_observed fires
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: "[STAGE: END]\nCOMPLETE" } }),
        JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
    ].join("\n") + "\n";
    const spawn = makeMockSpawn([{ stdout, exitCode: 0 }]);
    await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
        gitExec,
        worktree: false,
    });
    assert.equal(events.filter((e) => e.type === "worktree_created").length, 0);
    assert.equal(events.filter((e) => e.type === "worktree_kept").length, 0);
    assert.equal(events.filter((e) => e.type === "worktree_removed").length, 0);
    // No worktree-add / fetch / merge-base / worktree-remove calls.
    assert.equal(gitCalls.filter((c) => c.startsWith("worktree")).length, 0);
    assert.equal(gitCalls.filter((c) => c.startsWith("merge-base")).length, 0);
});

test("runRalphTui: --prompt mode defaults worktree=false (opt-in only)", async () => {
    const events = [];
    const eventEmitter = {
        runId: "wt-prompt-default",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const gitExec = () => null;
    const stdout = [
        JSON.stringify({ type: "assistant.message", data: { content: "COMPLETE" } }),
        JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
    ].join("\n") + "\n";
    const spawn = makeMockSpawn([{ stdout, exitCode: 0 }]);
    await runRalphTui({
        mode: "prompt",
        prompt: "do thing",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
        gitExec,
        // worktree omitted → defaults to false for --prompt mode.
    });
    assert.equal(events.filter((e) => e.type === "worktree_created").length, 0);
});

test("runRalphTui: iter cwd != process.cwd() when worktree mode is on (regression pin)", async () => {
    // Capture the cwd actually passed to the spawn call.
    let spawnCwd = null;
    const spawn = function (_bin, _args, opts) {
        spawnCwd = opts?.cwd;
        const handlers = { stdout: [], close: [] };
        const child = {
            stdout: { on: (ev, fn) => handlers.stdout.push(fn) },
            stderr: { on: () => {} },
            on: (ev, fn) => { if (ev === "close") handlers.close.push(fn); },
            kill: () => {},
        };
        setImmediate(() => {
            for (const fn of handlers.stdout) {
                fn(Buffer.from([
                    JSON.stringify({ type: "assistant.message", data: { content: "[STAGE: END]\nCOMPLETE" } }),
                    JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
                ].join("\n") + "\n"));
            }
            for (const fn of handlers.close) fn(0);
        });
        return child;
    };
    const events = [];
    const eventEmitter = {
        runId: "wt-cwd-pin",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        cwd: "/parent/repo",
        spawn,
        eventEmitter,
        gitExec: () => "", // every git call succeeds → worktree created OK
        worktree: true,
    });
    assert.ok(spawnCwd, "spawn cwd captured");
    assert.notEqual(spawnCwd, "/parent/repo",
        "iter cwd is the worktree path, NOT the parent repo cwd");
    assert.match(spawnCwd, /worktrees\/iter-1$/);
});

// ───────────── End-to-end: real git (skipped when git missing) ─────

const GIT_AVAILABLE = (() => {
    try {
        execSync("git --version", { stdio: "ignore", timeout: 2000 });
        return true;
    } catch {
        return false;
    }
})();

test("e2e: real git create+remove worktree round-trip in a tmp repo", { skip: !GIT_AVAILABLE }, () => {
    const repoRoot = tmp();
    try {
        execSync("git init -q -b main", { cwd: repoRoot, stdio: "ignore" });
        execSync("git config user.email t@e", { cwd: repoRoot, stdio: "ignore" });
        execSync("git config user.name tester", { cwd: repoRoot, stdio: "ignore" });
        writeFileSync(join(repoRoot, "x"), "hello\n");
        execSync("git add x", { cwd: repoRoot, stdio: "ignore" });
        execSync("git commit -q -m initial", { cwd: repoRoot, stdio: "ignore" });

        const runsRoot = tmp();
        const runId = "real-1";
        // Use the production gitExec implementation by passing
        // the runner without injecting a stub.
        const gitExec = ({ args, cwd, env, timeoutMs }) => {
            try {
                return execSync(`git ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
                    cwd, env, encoding: "utf8", timeout: timeoutMs ?? 5000,
                    stdio: ["ignore", "pipe", "pipe"],
                });
            } catch {
                return null;
            }
        };
        const created = createIterWorktree({
            runId, iter: 1, baseRef: "main", runsRoot, cwd: repoRoot, env: process.env, gitExec,
        });
        assert.ok(created, "createIterWorktree returned a path");
        assert.ok(existsSync(created.path), "worktree dir exists on disk");
        assert.ok(existsSync(join(created.path, "x")), "worktree contains the base ref's files");

        const removed = removeIterWorktree({
            path: created.path, branch: created.branch, cwd: repoRoot, env: process.env, gitExec,
        });
        assert.equal(removed, true);
        assert.equal(existsSync(created.path), false, "worktree dir is gone after remove");

        rmSync(runsRoot, { recursive: true, force: true });
    } finally {
        rmSync(repoRoot, { recursive: true, force: true });
    }
});
