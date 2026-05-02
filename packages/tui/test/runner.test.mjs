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

// ─── Issue #48 slice 4: stage marker parser + runner integration ─────

import { extractStageMarkers, stagesForMode } from "../src/runner.mjs";
import { SDLC_STAGES_SELF_IMPROVE, SDLC_STAGES_GROW_PROJECT } from "../src/events.mjs";

test("stagesForMode: maps modes to canonical lists", () => {
    assert.equal(stagesForMode("self-improve"), SDLC_STAGES_SELF_IMPROVE);
    assert.equal(stagesForMode("grow-project"), SDLC_STAGES_GROW_PROJECT);
    assert.equal(stagesForMode("prompt"), null,
        "prompt mode has no canonical stage list — the user supplies the prompt");
    assert.equal(stagesForMode("future-mode"), null);
});

test("extractStageMarkers: empty / non-string input returns []", () => {
    assert.deepEqual(extractStageMarkers("", SDLC_STAGES_SELF_IMPROVE), []);
    assert.deepEqual(extractStageMarkers(null, SDLC_STAGES_SELF_IMPROVE), []);
    assert.deepEqual(extractStageMarkers(undefined, SDLC_STAGES_SELF_IMPROVE), []);
    assert.deepEqual(extractStageMarkers(123, SDLC_STAGES_SELF_IMPROVE), []);
});

test("extractStageMarkers: empty / missing allowedStages returns []", () => {
    assert.deepEqual(extractStageMarkers("[STAGE: ORIENT]\n", []), []);
    assert.deepEqual(extractStageMarkers("[STAGE: ORIENT]\n", null), []);
    assert.deepEqual(extractStageMarkers("[STAGE: ORIENT]\n", undefined), []);
});

test("extractStageMarkers: anchored markers return name + 1-based stage ordinal", () => {
    const text = "preamble\n[STAGE: ORIENT]\nlooked at the tree\n[STAGE: IDEATE]\nthought about it\n";
    const got = extractStageMarkers(text, SDLC_STAGES_SELF_IMPROVE);
    assert.equal(got.length, 2);
    assert.equal(got[0].name, "ORIENT");
    assert.equal(got[0].stage, 1, "ORIENT is the 1st stage in SDLC_STAGES_SELF_IMPROVE");
    assert.equal(got[1].name, "IDEATE");
    assert.equal(got[1].stage, 2);
});

test("extractStageMarkers: silently drops markers whose name is not in allowedStages", () => {
    // A hallucinated marker (typo or invented stage) must NOT poison
    // the stream. Emitting an unknown stage would confuse the
    // renderer; the safety net is to drop it at parse time.
    const text = "[STAGE: ORIENT]\n[STAGE: REVIEW]\n[STAGE: IDEATE]\n";
    const got = extractStageMarkers(text, SDLC_STAGES_SELF_IMPROVE);
    assert.equal(got.length, 2, "REVIEW is not a self-improve stage; it must be dropped");
    assert.deepEqual(got.map((m) => m.name), ["ORIENT", "IDEATE"]);
});

test("extractStageMarkers: only matches markers on a line by themselves (anchor enforcement)", () => {
    // The prompt instructs the agent to emit the marker on a line by
    // itself. An inline mention of `[STAGE: ORIENT]` in narrative
    // prose must NOT fire — otherwise the agent describing what it
    // already did ("after [STAGE: ORIENT] I looked at …") would
    // double-emit a stage marker.
    const text = "After completing [STAGE: ORIENT] earlier, I started the next phase.\n";
    assert.deepEqual(extractStageMarkers(text, SDLC_STAGES_SELF_IMPROVE), []);
});

test("extractStageMarkers: tolerates leading/trailing whitespace on the marker line", () => {
    // A stray space or tab on either side must not break the match —
    // the agent's terminal renderer or copy-paste might insert one.
    const text = "  [STAGE: ORIENT]   \n\t[STAGE: IDEATE]\t\n";
    const got = extractStageMarkers(text, SDLC_STAGES_SELF_IMPROVE);
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((m) => m.name), ["ORIENT", "IDEATE"]);
});

test("extractStageMarkers: handles every grow_project stage, including SELECT and CLOSE", () => {
    const text = SDLC_STAGES_GROW_PROJECT.map((s) => `[STAGE: ${s}]`).join("\n") + "\n";
    const got = extractStageMarkers(text, SDLC_STAGES_GROW_PROJECT);
    assert.equal(got.length, SDLC_STAGES_GROW_PROJECT.length);
    assert.deepEqual(got.map((m) => m.name), [...SDLC_STAGES_GROW_PROJECT]);
    assert.deepEqual(got.map((m) => m.stage), SDLC_STAGES_GROW_PROJECT.map((_, i) => i + 1));
});

test("runRalphTui: parses [STAGE: NAME] markers from agent stdout and emits stage_start/stage_end pairs in order", async () => {
    const events = [];
    const eventEmitter = {
        runId: "stage-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    // Agent emits two stage markers then COMPLETE.
    const stdout = [
        JSON.stringify({ type: "assistant.message", data: { content: "[STAGE: ORIENT]\nlooked at tree\n[STAGE: IDEATE]\npicked target\nCOMPLETE" } }),
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
    });
    // Filter to stage events; must be: start ORIENT, end ORIENT,
    // start IDEATE, end IDEATE — emitted between iteration_start and
    // iteration_end of iter 1.
    const stageEvents = events.filter((e) => e.type === "stage_start" || e.type === "stage_end");
    assert.equal(stageEvents.length, 4, `expected 4 stage events (start/end x2); got ${stageEvents.length}`);
    assert.deepEqual(stageEvents.map((e) => `${e.type}:${e.stageName}`),
        ["stage_start:ORIENT", "stage_end:ORIENT", "stage_start:IDEATE", "stage_end:IDEATE"]);
    // Every stage event must carry the iteration number for fold().
    for (const ev of stageEvents) {
        assert.equal(ev.iteration, 1);
        assert.ok(Number.isInteger(ev.stage), "stage ordinal must be integer");
    }
    // Stage events must sit between iteration_start and iteration_end.
    const iterStartIdx = events.findIndex((e) => e.type === "iteration_start");
    const iterEndIdx = events.findIndex((e) => e.type === "iteration_end");
    const firstStageIdx = events.findIndex((e) => e.type === "stage_start");
    const lastStageIdx = events.map((e) => e.type).lastIndexOf("stage_end");
    assert.ok(iterStartIdx < firstStageIdx, "stage events must come AFTER iteration_start");
    assert.ok(lastStageIdx < iterEndIdx, "stage events must come BEFORE iteration_end so the iter scope is right");
});

test("runRalphTui: hallucinated [STAGE: REVIEW] marker is silently dropped (no event emitted)", async () => {
    const events = [];
    const eventEmitter = {
        runId: "stage-bad",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", data: { content: "[STAGE: REVIEW]\nmade up\n[STAGE: ORIENT]\nreal\nCOMPLETE" } }),
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
    });
    const stageEvents = events.filter((e) => e.type === "stage_start" || e.type === "stage_end");
    // Only ORIENT (canonical) survives.
    assert.equal(stageEvents.length, 2);
    assert.deepEqual(stageEvents.map((e) => `${e.type}:${e.stageName}`),
        ["stage_start:ORIENT", "stage_end:ORIENT"]);
});

test("runRalphTui: --prompt mode emits no stage events (no canonical stage list)", async () => {
    const events = [];
    const eventEmitter = {
        runId: "stage-prompt",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        // Even if the user's prompt instructs the agent to emit stage
        // markers, the runner has no canonical list to validate them
        // against — so no events are emitted. (A future extension could
        // accept a `--stages a,b,c` flag for prompt mode.)
        JSON.stringify({ type: "assistant.message", data: { content: "[STAGE: STEP_ONE]\n[STAGE: STEP_TWO]\nCOMPLETE" } }),
        JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
    ].join("\n") + "\n";
    const spawn = makeMockSpawn([{ stdout, exitCode: 0 }]);
    await runRalphTui({
        mode: "prompt",
        contextMode: "fresh",
        prompt: "drive the loop yourself",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
    });
    const stageEvents = events.filter((e) => e.type === "stage_start" || e.type === "stage_end");
    assert.equal(stageEvents.length, 0, "prompt mode has no canonical stage list, so no stage events");
});

// ─── Issue #48 slice 5: substage capture (tool.execution_complete) ───

import { extractAgentTimeline, summarizeToolArgs } from "../src/runner.mjs";

test("summarizeToolArgs: bash → first line of command, ≤80 chars with ellipsis", () => {
    assert.equal(summarizeToolArgs("bash", { command: "ls /tmp" }), "ls /tmp");
    assert.equal(summarizeToolArgs("bash", { command: "ls /tmp\nrm -rf /" }), "ls /tmp",
        "first line only — multi-line bash commands shouldn't expose the whole script");
    const long = "x".repeat(100);
    const got = summarizeToolArgs("bash", { command: long });
    assert.equal(got.length, 80, "truncated to 80 chars");
    assert.ok(got.endsWith("…"), "ellipsis marks truncation");
});

test("summarizeToolArgs: view/edit/create → path; grep/glob → pattern; task → description", () => {
    assert.equal(summarizeToolArgs("view", { path: "/repo/src/foo.js" }), "/repo/src/foo.js");
    assert.equal(summarizeToolArgs("edit", { path: "/p", old_str: "a", new_str: "b" }), "/p");
    assert.equal(summarizeToolArgs("create", { path: "/repo/new.js", file_text: "..." }), "/repo/new.js");
    assert.equal(summarizeToolArgs("grep", { pattern: "STAGE:", glob: "*.mjs" }), "STAGE:");
    assert.equal(summarizeToolArgs("glob", { pattern: "**/*.test.mjs" }), "**/*.test.mjs");
    assert.equal(summarizeToolArgs("task", { description: "Run tests", prompt: "..." }), "Run tests");
});

test("summarizeToolArgs: missing args / non-string fields → empty string", () => {
    assert.equal(summarizeToolArgs("bash", null), "");
    assert.equal(summarizeToolArgs("bash", undefined), "");
    assert.equal(summarizeToolArgs("bash", "not an object"), "");
    assert.equal(summarizeToolArgs("bash", {}), "", "empty args object → empty summary");
});

test("summarizeToolArgs: generic fallback picks first string-valued field", () => {
    assert.equal(summarizeToolArgs("custom_tool", { count: 5, label: "hello" }), "hello",
        "non-string fields skipped, first string field wins");
});

test("extractAgentTimeline: empty / non-array input → []", () => {
    assert.deepEqual(extractAgentTimeline(null, ["ORIENT"]), []);
    assert.deepEqual(extractAgentTimeline(undefined, ["ORIENT"]), []);
    assert.deepEqual(extractAgentTimeline([], ["ORIENT"]), []);
});

test("extractAgentTimeline: pairs tool.execution_start with tool.execution_complete by toolCallId", () => {
    const events = [
        { type: "tool.execution_start", timestamp: "2026-01-01T00:00:00.000Z",
          data: { toolCallId: "t1", toolName: "bash", arguments: { command: "ls" } } },
        { type: "tool.execution_complete", timestamp: "2026-01-01T00:00:00.500Z",
          data: { toolCallId: "t1", success: true } },
    ];
    const tl = extractAgentTimeline(events, []);
    assert.equal(tl.length, 1);
    assert.equal(tl[0].kind, "tool_complete");
    assert.equal(tl[0].verb, "bash");
    assert.equal(tl[0].argsSummary, "ls");
    assert.equal(tl[0].outcome, "ok");
    assert.equal(tl[0].durationMs, 500, "duration computed from start ts to complete ts");
});

test("extractAgentTimeline: failed tool.execution_complete → outcome = error.code (or 'error')", () => {
    const events = [
        { type: "tool.execution_start", timestamp: "2026-01-01T00:00:00.000Z",
          data: { toolCallId: "t1", toolName: "bash", arguments: { command: "ls /nope" } } },
        { type: "tool.execution_complete", timestamp: "2026-01-01T00:00:00.100Z",
          data: { toolCallId: "t1", success: false, error: { code: "denied", message: "Permission denied" } } },
    ];
    const tl = extractAgentTimeline(events, []);
    assert.equal(tl[0].outcome, "denied", "error.code wins when present");

    const events2 = [
        { type: "tool.execution_start", timestamp: "2026-01-01T00:00:00.000Z",
          data: { toolCallId: "t1", toolName: "bash", arguments: {} } },
        { type: "tool.execution_complete", timestamp: "2026-01-01T00:00:00.050Z",
          data: { toolCallId: "t1", success: false } },
    ];
    const tl2 = extractAgentTimeline(events2, []);
    assert.equal(tl2[0].outcome, "error", "fallback to 'error' when error.code missing");
});

test("extractAgentTimeline: tool_complete with missing/unparseable timestamp → durationMs null", () => {
    const events = [
        { type: "tool.execution_start", data: { toolCallId: "t1", toolName: "bash", arguments: { command: "ls" } } },
        { type: "tool.execution_complete", data: { toolCallId: "t1", success: true } },
    ];
    const tl = extractAgentTimeline(events, []);
    assert.equal(tl[0].durationMs, null, "no real timestamp → null duration; renderer shows '?'");
});

test("extractAgentTimeline: interleaves stage markers and tool completions in event order", () => {
    // Realistic scenario: agent emits [STAGE: ORIENT], runs `git status`,
    // then emits [STAGE: IDEATE], runs `grep`. The timeline preserves
    // arrival order so foldEvents attributes each substage to the
    // correct stage.
    const events = [
        { type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
          data: { content: "[STAGE: ORIENT]\nstarting" } },
        { type: "tool.execution_start", timestamp: "2026-01-01T00:00:01.000Z",
          data: { toolCallId: "t1", toolName: "bash", arguments: { command: "git status" } } },
        { type: "tool.execution_complete", timestamp: "2026-01-01T00:00:01.500Z",
          data: { toolCallId: "t1", success: true } },
        { type: "assistant.message", timestamp: "2026-01-01T00:00:02.000Z",
          data: { content: "[STAGE: IDEATE]\nthinking" } },
        { type: "tool.execution_start", timestamp: "2026-01-01T00:00:03.000Z",
          data: { toolCallId: "t2", toolName: "grep", arguments: { pattern: "TODO" } } },
        { type: "tool.execution_complete", timestamp: "2026-01-01T00:00:03.200Z",
          data: { toolCallId: "t2", success: true } },
    ];
    const tl = extractAgentTimeline(events, ["ORIENT", "IDEATE"]);
    assert.deepEqual(tl.map((it) => `${it.kind}:${it.name ?? it.verb}`),
        ["stage_marker:ORIENT", "tool_complete:bash", "stage_marker:IDEATE", "tool_complete:grep"]);
});

test("extractAgentTimeline: sub-agent (agentId set) assistant.message events are ignored for stage markers", () => {
    // An explore-agent's assistant.message could legitimately contain
    // `[STAGE: ORIENT]` in its prose (e.g. quoting the prompt). Only
    // the root agent's stage markers count.
    const events = [
        { type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
          agentId: "explore",
          data: { content: "[STAGE: ORIENT]\nshouldn't fire" } },
        { type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
          data: { content: "[STAGE: ORIENT]\nroot agent's marker" } },
    ];
    const tl = extractAgentTimeline(events, ["ORIENT"]);
    assert.equal(tl.length, 1, "only the root agent's marker counts");
});

test("runRalphTui: emits substage events with sub index, verb, argsSummary, outcome, durationMs", async () => {
    const events = [];
    const eventEmitter = {
        runId: "substage-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        // [STAGE: ORIENT] then 2 tool calls then [STAGE: IDEATE] then COMPLETE
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: "[STAGE: ORIENT]\nlooking" } }),
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:01.000Z",
            data: { toolCallId: "c1", toolName: "bash", arguments: { command: "git status" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:01.300Z",
            data: { toolCallId: "c1", success: true } }),
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:02.000Z",
            data: { toolCallId: "c2", toolName: "view", arguments: { path: "/repo/foo.mjs" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:02.100Z",
            data: { toolCallId: "c2", success: true } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:03.000Z",
            data: { content: "[STAGE: IDEATE]\nCOMPLETE" } }),
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
    });
    const subEvents = events.filter((e) => e.type === "substage");
    assert.equal(subEvents.length, 2, "two tool.execution_complete events → two substage events");
    assert.equal(subEvents[0].verb, "bash");
    assert.equal(subEvents[0].argsSummary, "git status");
    assert.equal(subEvents[0].outcome, "ok");
    assert.equal(subEvents[0].durationMs, 300);
    assert.equal(subEvents[0].sub, 1, "first substage in ORIENT is sub=1");
    assert.equal(subEvents[1].verb, "view");
    assert.equal(subEvents[1].argsSummary, "/repo/foo.mjs");
    assert.equal(subEvents[1].sub, 2, "second substage in ORIENT is sub=2");
    // Critical ordering: substages must sit BETWEEN stage_start ORIENT
    // and stage_start IDEATE so foldEvents attributes them to ORIENT.
    const types = events.map((e) => e.type);
    const orientStartIdx = events.findIndex((e) => e.type === "stage_start" && e.stageName === "ORIENT");
    const ideateStartIdx = events.findIndex((e) => e.type === "stage_start" && e.stageName === "IDEATE");
    const sub1Idx = events.findIndex((e, i) => i > orientStartIdx && e.type === "substage");
    assert.ok(orientStartIdx < sub1Idx, "substage must come AFTER ORIENT stage_start");
    assert.ok(sub1Idx < ideateStartIdx, "substage must come BEFORE IDEATE stage_start (attribution to ORIENT)");
    // Sub counter must reset on stage transition: IDEATE has no
    // substages here, but if it did they'd start at sub=1 again.
    assert.ok(types.includes("stage_end"), "stages must close so foldEvents bookkeeping is clean");
});

test("runRalphTui: substage sub-counter resets to 1 on each new stage_start", async () => {
    const events = [];
    const eventEmitter = {
        runId: "sub-reset-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: "[STAGE: ORIENT]" } }),
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:01.000Z",
            data: { toolCallId: "a1", toolName: "bash", arguments: { command: "echo a" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:01.100Z",
            data: { toolCallId: "a1", success: true } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:02.000Z",
            data: { content: "[STAGE: IDEATE]" } }),
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:03.000Z",
            data: { toolCallId: "b1", toolName: "bash", arguments: { command: "echo b" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:03.100Z",
            data: { toolCallId: "b1", success: true } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:04.000Z",
            data: { content: "COMPLETE" } }),
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
    });
    const subs = events.filter((e) => e.type === "substage");
    assert.equal(subs.length, 2);
    assert.equal(subs[0].sub, 1, "first substage of ORIENT is sub=1");
    assert.equal(subs[1].sub, 1, "first substage of IDEATE is also sub=1 (counter reset)");
});
