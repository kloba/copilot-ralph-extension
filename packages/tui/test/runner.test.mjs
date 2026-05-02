// Tests for `ralph-tui run` driver (packages/tui/src/runner.mjs).
//
// Strategy:
//   - Pure helpers (validateFocus, composePrompt, reduceCopilotEvents)
//     get straightforward unit tests.
//   - State-file CAS (initState/updateState/pauseRun/resumeRun/stopRun)
//     gets isolated tmp-dir tests via $RALPH_TUI_RUNS_DIR.
//   - End-to-end loop tests use a Node-script "fake copilot" shim that
//     emits scripted JSONL on stdout. The shim is parameterised by a
//     SCRIPT env var (path to a JSON file describing the iter's
//     output) so a single binary covers every test scenario.
//
// All tests are pure-stdlib node:test — no extra deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    validateFocus,
    composePrompt,
    reduceCopilotEvents,
    resolveStateRoot,
    resolveStatePath,
    readState,
    updateState,
    pauseRun,
    resumeRun,
    stopRun,
    statusRun,
    runRalphTui,
    runOneIteration,
    PROMPT_SELF_IMPROVE,
    PROMPT_GROW_PROJECT,
    COMPLETION_PROMISE,
    BAKED_ABORT_TOKEN,
    BAKED_BACKLOG_ABORT_TOKEN,
    MAX_FOCUS_CHARS,
    DEFAULT_MAX_ITERATIONS,
    MAX_ALLOWED_ITERATIONS,
} from "../src/runner.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FAKE_COPILOT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-copilot.mjs");

function tmp() {
    return mkdtempSync(join(tmpdir(), "ralph-tui-runner-"));
}

function makeEnv(extra = {}) {
    return {
        RALPH_TUI_RUNS_DIR: extra.RALPH_TUI_RUNS_DIR ?? tmp(),
        RALPH_EVENTS_DIR: extra.RALPH_EVENTS_DIR ?? tmp(),
        ...extra,
    };
}

// ───────────── Pure helpers ─────────────

test("validateFocus: undefined / null pass through", () => {
    assert.deepEqual(validateFocus(undefined), { value: undefined });
    assert.deepEqual(validateFocus(null), { value: undefined });
});

test("validateFocus: rejects non-string", () => {
    assert.match(validateFocus(123).error, /must be a string/);
});

test("validateFocus: rejects empty / whitespace-only", () => {
    assert.match(validateFocus("").error, /must not be empty/);
    assert.match(validateFocus("   ").error, /must not be empty/);
});

test("validateFocus: rejects over MAX_FOCUS_CHARS", () => {
    const long = "x".repeat(MAX_FOCUS_CHARS + 1);
    assert.match(validateFocus(long).error, /exceeds 2000 characters/);
});

test("validateFocus: trims and accepts", () => {
    assert.equal(validateFocus("  hello  ").value, "hello");
});

test("composePrompt: self-improve no focus = baked prompt verbatim", () => {
    assert.equal(composePrompt({ mode: "self-improve" }), PROMPT_SELF_IMPROVE);
});

test("composePrompt: grow-project with focus appends suffix", () => {
    const out = composePrompt({ mode: "grow-project", focus: "X" });
    assert.ok(out.startsWith(PROMPT_GROW_PROJECT));
    assert.ok(out.endsWith("\n\nFocus this run on: X"));
});

test("composePrompt: prompt mode uses raw user prompt", () => {
    assert.equal(composePrompt({ mode: "prompt", prompt: "do thing" }), "do thing");
});

test("composePrompt: throws on unknown mode", () => {
    assert.throws(() => composePrompt({ mode: "weird" }), /unknown mode/);
});

test("reduceCopilotEvents: concatenates root assistant.message content, skips agentId", () => {
    const events = [
        { type: "assistant.message", data: { content: "root-1\n" } },
        { type: "assistant.message", agentId: "explore", data: { content: "sub-agent noise" } },
        { type: "assistant.message", data: { content: "root-2 COMPLETE" } },
    ];
    const r = reduceCopilotEvents(events);
    assert.equal(r.assistantContent, "root-1\nroot-2 COMPLETE");
    assert.ok(r.assistantContent.includes("COMPLETE"));
    assert.ok(!r.assistantContent.includes("sub-agent noise"));
});

test("reduceCopilotEvents: captures sessionId from terminal result", () => {
    const events = [
        { type: "assistant.message", data: { content: "hello" } },
        { type: "result", success: true, result: { sessionId: "sess-abc" } },
    ];
    const r = reduceCopilotEvents(events);
    assert.equal(r.sessionId, "sess-abc");
    assert.equal(r.exitOk, true);
});

test("reduceCopilotEvents: empty stream returns empty content + null sessionId", () => {
    assert.deepEqual(reduceCopilotEvents([]), {
        assistantContent: "",
        sessionId: null,
        exitOk: null,
    });
});

// ───────────── State root + path ─────────────

test("resolveStateRoot: honors $RALPH_TUI_RUNS_DIR", () => {
    assert.equal(resolveStateRoot({ RALPH_TUI_RUNS_DIR: "/tmp/whatever" }), "/tmp/whatever");
});

test("resolveStateRoot: defaults under ~/.copilot/ralph-tui/runs", () => {
    const r = resolveStateRoot({});
    assert.match(r, /\.copilot\/ralph-tui\/runs$/);
});

test("resolveStatePath: joins root + runId + state.json", () => {
    const env = { RALPH_TUI_RUNS_DIR: "/tmp/r" };
    assert.equal(resolveStatePath("foo-1", env), "/tmp/r/foo-1/state.json");
});

// ───────────── State-file CAS ─────────────

test("updateState: throws TypeError when state.json missing", () => {
    const dir = tmp();
    const env = { RALPH_TUI_RUNS_DIR: dir };
    assert.throws(() => updateState("nonexistent", (s) => s, env), TypeError);
    rmSync(dir, { recursive: true, force: true });
});

test("readState: returns null when state.json missing", () => {
    const dir = tmp();
    assert.equal(readState("nope", { RALPH_TUI_RUNS_DIR: dir }), null);
    rmSync(dir, { recursive: true, force: true });
});

test("pauseRun → resumeRun: idempotent + accumulates totalPausedMs", () => {
    const dir = tmp();
    const env = { RALPH_TUI_RUNS_DIR: dir };
    // Seed a state file directly.
    const runId = "test-1";
    mkdirSync(join(dir, runId), { recursive: true });
    writeFileSync(join(dir, runId, "state.json"),
        JSON.stringify({ version: 1, runId, mode: "self-improve", contextMode: "continue", iter: 0, max: 10, paused: false, stopRequested: false, terminated: false, totalPausedMs: 0 }));

    let t = 1000;
    const now = () => t;
    pauseRun(runId, { env, now });
    assert.equal(readState(runId, env).paused, true);
    assert.equal(readState(runId, env).pausedAt, 1000);

    // Idempotent: pausing again doesn't touch pausedAt or totalPausedMs.
    t = 5000;
    pauseRun(runId, { env, now });
    assert.equal(readState(runId, env).pausedAt, 1000, "idempotent pause keeps original pausedAt");

    // Resume accumulates totalPausedMs and clears pausedAt.
    t = 6500;
    resumeRun(runId, { env, now });
    const after = readState(runId, env);
    assert.equal(after.paused, false);
    assert.equal(after.totalPausedMs, 5500);
    assert.equal(after.pausedAt, undefined);

    // Idempotent resume.
    t = 7000;
    resumeRun(runId, { env, now });
    assert.equal(readState(runId, env).totalPausedMs, 5500);

    rmSync(dir, { recursive: true, force: true });
});

test("stopRun: sets stopRequested + stopReason, idempotent on terminated runs", () => {
    const dir = tmp();
    const env = { RALPH_TUI_RUNS_DIR: dir };
    const runId = "test-2";
    mkdirSync(join(dir, runId), { recursive: true });
    writeFileSync(join(dir, runId, "state.json"),
        JSON.stringify({ version: 1, runId, mode: "prompt", contextMode: "fresh", iter: 0, max: 10, paused: false, stopRequested: false, terminated: false, totalPausedMs: 0 }));
    stopRun(runId, { env, reason: "user_stop" });
    const s1 = readState(runId, env);
    assert.equal(s1.stopRequested, true);
    assert.equal(s1.stopReason, "user_stop");
    // Terminated → no-op.
    updateState(runId, (s) => { s.terminated = true; return s; }, env);
    stopRun(runId, { env, reason: "ignored" });
    const s2 = readState(runId, env);
    assert.equal(s2.stopReason, "user_stop"); // not overwritten
    rmSync(dir, { recursive: true, force: true });
});

test("statusRun: throws TypeError on missing", () => {
    const dir = tmp();
    assert.throws(() => statusRun("missing", { env: { RALPH_TUI_RUNS_DIR: dir } }), TypeError);
    rmSync(dir, { recursive: true, force: true });
});

test("updateState: increments version monotonically under sequential writes", () => {
    const dir = tmp();
    const env = { RALPH_TUI_RUNS_DIR: dir };
    const runId = "v";
    mkdirSync(join(dir, runId), { recursive: true });
    writeFileSync(join(dir, runId, "state.json"), JSON.stringify({ version: 1, runId, n: 0 }));
    for (let i = 0; i < 10; i++) {
        updateState(runId, (s) => { s.n = i; return s; }, env);
    }
    assert.equal(readState(runId, env).version, 11);
    rmSync(dir, { recursive: true, force: true });
});

// ───────────── Validation ─────────────

test("runRalphTui: rejects invalid mode", async () => {
    await assert.rejects(runRalphTui({ mode: "bogus", contextMode: "fresh" }), /invalid mode/);
});

test("runRalphTui: rejects missing prompt for prompt mode", async () => {
    await assert.rejects(runRalphTui({ mode: "prompt", contextMode: "fresh" }), /requires a non-empty string/);
});

test("runRalphTui: rejects max out of range", async () => {
    await assert.rejects(runRalphTui({ mode: "self-improve", contextMode: "fresh", max: 0 }), /max must be an integer/);
    await assert.rejects(runRalphTui({ mode: "self-improve", contextMode: "fresh", max: MAX_ALLOWED_ITERATIONS + 1 }), /max must be an integer/);
});

test("runRalphTui: rejects bad contextMode", async () => {
    await assert.rejects(runRalphTui({ mode: "self-improve", contextMode: "weird" }), /contextMode must be/);
});

test("runRalphTui: rejects oversize focus", async () => {
    const focus = "x".repeat(MAX_FOCUS_CHARS + 1);
    await assert.rejects(runRalphTui({ mode: "self-improve", contextMode: "fresh", focus }), /exceeds 2000 characters/);
});

// ───────────── End-to-end with fake-copilot shim ─────────────

function makeShimEnv(scenario) {
    const dir = tmp();
    const scriptPath = join(dir, "scenario.json");
    writeFileSync(scriptPath, JSON.stringify(scenario));
    return {
        env: {
            ...makeEnv(),
            FAKE_COPILOT_SCRIPT: scriptPath,
        },
        dir,
    };
}

test("runRalphTui: --self-improve --continue iter 1 emits COMPLETE → reason=complete, sessionId captured", async () => {
    const { env } = makeShimEnv({
        iters: [
            {
                events: [
                    { type: "assistant.message", data: { content: "Did the work.\nCOMPLETE" } },
                    { type: "result", success: true, result: { sessionId: "sess-iter1" } },
                ],
                exitCode: 0,
            },
        ],
    });
    const result = await runRalphTui({
        mode: "self-improve",
        contextMode: "continue",
        max: 5,
        copilotBin: process.execPath,
        env: { ...env, RALPH_TUI_FAKE_AS: FAKE_COPILOT },
        // Use process.execPath as the bin and prepend the fake-copilot
        // script as argv[0]. We achieve this via a tiny wrapper: just
        // pass copilotBin = node and set env that the fake script
        // reads… but child_process.spawn's `args` array starts after
        // bin. Solution: the runner already passes `-p prompt …`.
        // Override copilotBin to a pre-baked node-shim path that
        // accepts these args and reads the script from env.
        // Simpler: test the runner via an injected `spawn` mock.
        spawn: makeMockSpawn([
            {
                stdout: [
                    JSON.stringify({ type: "assistant.message", data: { content: "Did the work.\nCOMPLETE" } }),
                    JSON.stringify({ type: "result", success: true, result: { sessionId: "sess-iter1" } }),
                ].join("\n") + "\n",
                exitCode: 0,
            },
        ]),
    });
    assert.equal(result.terminationReason, "complete");
    assert.equal(result.sessionId, "sess-iter1");
});

// Build a mock spawn that returns scripted stdout/stderr/exitCode for
// each successive invocation. Each entry: { stdout, stderr?, exitCode }.
function makeMockSpawn(scripts) {
    let i = 0;
    return function mockSpawn(_bin, args, _opts) {
        const script = scripts[i++] ?? scripts[scripts.length - 1];
        const handlers = { stdout: [], stderr: [], close: [], error: [] };
        const child = {
            stdout: { on: (ev, fn) => handlers.stdout.push(fn), pipe: () => {} },
            stderr: { on: (ev, fn) => handlers.stderr.push(fn), pipe: () => {} },
            on: (ev, fn) => { if (ev === "close") handlers.close.push(fn); if (ev === "error") handlers.error.push(fn); },
            kill: () => {},
            __args: args,
        };
        // Schedule async data + close.
        setImmediate(() => {
            for (const fn of handlers.stdout) fn(Buffer.from(script.stdout ?? ""));
            if (script.stderr) for (const fn of handlers.stderr) fn(Buffer.from(script.stderr));
            for (const fn of handlers.close) fn(script.exitCode ?? 0);
        });
        return child;
    };
}

test("runRalphTui: --continue resumes via --resume=<sessionId> on iter 2", async () => {
    const argLog = [];
    const spawn = function (bin, args, opts) {
        argLog.push([...args]);
        const handlers = { stdout: [], close: [] };
        const child = {
            stdout: { on: (ev, fn) => handlers.stdout.push(fn), pipe: () => {} },
            stderr: { on: () => {}, pipe: () => {} },
            on: (ev, fn) => { if (ev === "close") handlers.close.push(fn); },
            kill: () => {},
        };
        setImmediate(() => {
            const isFirst = argLog.length === 1;
            const events = isFirst
                ? [
                    JSON.stringify({ type: "assistant.message", data: { content: "iter 1 working" } }),
                    JSON.stringify({ type: "result", success: true, result: { sessionId: "SID-RESUMABLE" } }),
                ]
                : [
                    JSON.stringify({ type: "assistant.message", data: { content: "wrap up COMPLETE" } }),
                    JSON.stringify({ type: "result", success: true, result: { sessionId: "SID-RESUMABLE" } }),
                ];
            for (const fn of handlers.stdout) fn(Buffer.from(events.join("\n") + "\n"));
            for (const fn of handlers.close) fn(0);
        });
        return child;
    };

    const result = await runRalphTui({
        mode: "self-improve",
        contextMode: "continue",
        max: 5,
        env: makeEnv(),
        spawn,
    });
    assert.equal(result.terminationReason, "complete");
    assert.equal(result.sessionId, "SID-RESUMABLE");
    // First invocation: -n <runId>, no --resume.
    assert.ok(argLog[0].some((a) => a === "-n"), "iter 1 must use -n to name the session");
    assert.ok(!argLog[0].some((a) => typeof a === "string" && a.startsWith("--resume=")), "iter 1 must not pass --resume");
    // Second invocation: --resume=SID-RESUMABLE, no -n.
    assert.ok(argLog[1].some((a) => a === "--resume=SID-RESUMABLE"), "iter 2 must resume by sessionId");
    assert.ok(!argLog[1].some((a) => a === "-n"), "iter 2 must not pass -n");
});

test("runRalphTui: --fresh never resumes and never reuses sessionId", async () => {
    const argLog = [];
    const spawn = function (bin, args) {
        argLog.push([...args]);
        const handlers = { stdout: [], close: [] };
        const child = {
            stdout: { on: (ev, fn) => handlers.stdout.push(fn), pipe: () => {} },
            stderr: { on: () => {}, pipe: () => {} },
            on: (ev, fn) => { if (ev === "close") handlers.close.push(fn); },
            kill: () => {},
        };
        setImmediate(() => {
            const events = argLog.length < 2
                ? [JSON.stringify({ type: "assistant.message", data: { content: "still going" } }),
                    JSON.stringify({ type: "result", success: true, result: { sessionId: "ignored" } })]
                : [JSON.stringify({ type: "assistant.message", data: { content: "done COMPLETE" } }),
                    JSON.stringify({ type: "result", success: true, result: { sessionId: "ignored" } })];
            for (const fn of handlers.stdout) fn(Buffer.from(events.join("\n") + "\n"));
            for (const fn of handlers.close) fn(0);
        });
        return child;
    };

    await runRalphTui({
        mode: "grow-project",
        contextMode: "fresh",
        max: 5,
        env: makeEnv(),
        spawn,
    });
    for (const args of argLog) {
        assert.ok(!args.some((a) => typeof a === "string" && a.startsWith("--resume=")), "fresh mode must never --resume");
        assert.ok(!args.some((a) => a === "-n"), "fresh mode must never -n");
    }
});

test("runRalphTui: ABORT_NO_IMPROVEMENTS triggers abort termination", async () => {
    const spawn = makeMockSpawn([
        {
            stdout: [
                JSON.stringify({ type: "assistant.message", data: { content: "Nothing to do.\n" + BAKED_ABORT_TOKEN } }),
                JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
            ].join("\n") + "\n",
            exitCode: 0,
        },
    ]);
    const result = await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 5,
        env: makeEnv(),
        spawn,
    });
    assert.equal(result.terminationReason, "abort");
    assert.match(result.terminationNote, /ABORT_NO_IMPROVEMENTS/);
});

test("runRalphTui: ABORT_NO_BACKLOG default abort for grow-project", async () => {
    const spawn = makeMockSpawn([
        {
            stdout: [
                JSON.stringify({ type: "assistant.message", data: { content: BAKED_BACKLOG_ABORT_TOKEN } }),
                JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
            ].join("\n") + "\n",
            exitCode: 0,
        },
    ]);
    const result = await runRalphTui({
        mode: "grow-project",
        contextMode: "fresh",
        max: 5,
        env: makeEnv(),
        spawn,
    });
    assert.equal(result.terminationReason, "abort");
});

test("runRalphTui: max-iter cap fires when no terminator is emitted", async () => {
    let n = 0;
    const spawn = function () {
        n++;
        const handlers = { stdout: [], close: [] };
        const child = {
            stdout: { on: (ev, fn) => handlers.stdout.push(fn), pipe: () => {} },
            stderr: { on: () => {}, pipe: () => {} },
            on: (ev, fn) => { if (ev === "close") handlers.close.push(fn); },
            kill: () => {},
        };
        setImmediate(() => {
            const events = [
                JSON.stringify({ type: "assistant.message", data: { content: "stuck in a loop" } }),
                JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
            ];
            for (const fn of handlers.stdout) fn(Buffer.from(events.join("\n") + "\n"));
            for (const fn of handlers.close) fn(0);
        });
        return child;
    };
    const result = await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 3,
        env: makeEnv(),
        spawn,
    });
    assert.equal(result.terminationReason, "max_iterations");
    assert.equal(n, 3);
});

test("runRalphTui: subprocess exit code != 0 ends loop with subprocess_failed", async () => {
    const spawn = makeMockSpawn([
        { stdout: "", stderr: "auth error\n", exitCode: 1 },
    ]);
    const result = await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 5,
        env: makeEnv(),
        spawn,
    });
    assert.equal(result.terminationReason, "subprocess_failed");
});

test("runRalphTui: stopRun mid-loop ends with terminationReason=stopped", async () => {
    let runIdSeen = null;
    let envSeen = null;
    const spawn = function () {
        const handlers = { stdout: [], close: [] };
        const child = {
            stdout: { on: (ev, fn) => handlers.stdout.push(fn), pipe: () => {} },
            stderr: { on: () => {}, pipe: () => {} },
            on: (ev, fn) => { if (ev === "close") handlers.close.push(fn); },
            kill: () => {},
        };
        setImmediate(() => {
            // After iter 1 finishes, request stop so iter 2 never starts.
            if (runIdSeen) {
                try { stopRun(runIdSeen, { env: envSeen }); } catch { /* swallow */ }
            }
            const events = [
                JSON.stringify({ type: "assistant.message", data: { content: "done" } }),
                JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
            ];
            for (const fn of handlers.stdout) fn(Buffer.from(events.join("\n") + "\n"));
            for (const fn of handlers.close) fn(0);
        });
        return child;
    };
    const env = makeEnv();
    envSeen = env;
    const result = await runRalphTui({
        mode: "prompt",
        prompt: "hi",
        contextMode: "fresh",
        max: 5,
        env,
        spawn,
        onRunId: (id) => { runIdSeen = id; },
    });
    assert.equal(result.terminationReason, "stopped");
    // State file should reflect terminated.
    const s = readState(runIdSeen, env);
    assert.equal(s.terminated, true);
    assert.equal(s.terminationReason, "stopped");
});

test("runRalphTui: emits armed → iteration_start → iteration_end → terminal sequence", async () => {
    const events = [];
    const eventEmitter = {
        runId: "test-run-fixed",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const spawn = makeMockSpawn([
        {
            stdout: [
                JSON.stringify({ type: "assistant.message", data: { content: "wrap up COMPLETE" } }),
                JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
            ].join("\n") + "\n",
            exitCode: 0,
        },
    ]);
    await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
    });
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["armed", "iteration_start", "iteration_end", "complete"]);
    // armed event must carry contextMode + mode + maxIterations for ralph-tui list.
    assert.equal(events[0].contextMode, "fresh");
    assert.equal(events[0].mode, "self-improve");
    assert.equal(events[0].maxIterations, 1);
});

test("runRalphTui: emits abort (NOT 'aborted') for early-terminate", async () => {
    const events = [];
    const eventEmitter = {
        runId: "x",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const spawn = makeMockSpawn([
        {
            stdout: [
                JSON.stringify({ type: "assistant.message", data: { content: BAKED_ABORT_TOKEN } }),
                JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
            ].join("\n") + "\n",
            exitCode: 0,
        },
    ]);
    await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
    });
    // Critical: the event-type must be "abort", not "aborted".
    // packages/tui/src/events.mjs's parseEventLine drops unknown types.
    const last = events[events.length - 1];
    assert.equal(last.type, "abort", "terminal event must be 'abort' not 'aborted'");
});
