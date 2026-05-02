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
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    validateFocus,
    composePrompt,
    reduceCopilotEvents,
    resolveStateRoot,
    resolveStatePath,
    resolveCopilotBin,
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
        AUTOPILOT_RUNS_DIR: extra.AUTOPILOT_RUNS_DIR ?? tmp(),
        AUTOPILOT_EVENTS_DIR: extra.AUTOPILOT_EVENTS_DIR ?? tmp(),
        ...extra,
    };
}

// Stage 3 (issue #49): resolveStateRoot / resolveCopilotBin now perform
// sentinel-gated stderr deprecation notices when legacy
// $RALPH_TUI_RUNS_DIR / $RALPH_TUI_COPILOT_BIN are used. Tests inject
// a fake fs (no sentinel, accepts mkdir/append silently) and a fake
// stderr (captures into messages[]). The sentinelPath points at a fake
// location so deprecation writes never touch the real ~/.copilot.
function makeFakeFs({ sentinel = "", existingPaths = new Set() } = {}) {
    let written = "";
    const fake = {
        readFileSync: (p) => {
            if (p === fake._sentinelPath) return sentinel + written;
            const e = new Error("ENOENT");
            e.code = "ENOENT";
            throw e;
        },
        appendFileSync: (p, data) => {
            if (p === fake._sentinelPath) written += data;
        },
        mkdirSync: () => {},
        existsSync: (p) => existingPaths.has(p),
    };
    fake._sentinelPath = "/fake/sentinel";
    fake.writtenSentinel = () => written;
    return fake;
}

function makeFakeStderr() {
    const messages = [];
    return {
        write: (m) => { messages.push(String(m)); },
        messages,
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
        outputTokens: 0,
        premiumRequests: null,
    });
});

// ───────────── Issue: TUI tokens / premium-request extraction ─────────────
// `reduceCopilotEvents` must read `data.outputTokens` (per-message
// delta from the Copilot CLI JSONL stream) and `result.usage.premiumRequests`
// (per-iter cost-weighted count). Pre-fix it ignored both, so the
// TUI Header rendered `tokens 0` for the whole run.

test("reduceCopilotEvents: sums outputTokens across multiple root assistant.message events", () => {
    const events = [
        { type: "assistant.message", data: { content: "a", outputTokens: 190 } },
        { type: "assistant.message", data: { content: "b", outputTokens: 88 } },
        { type: "assistant.message", data: { content: "c", outputTokens: 50 } },
    ];
    const r = reduceCopilotEvents(events);
    assert.equal(r.outputTokens, 190 + 88 + 50);
});

test("reduceCopilotEvents: skips outputTokens on sub-agent (agentId) events", () => {
    const events = [
        { type: "assistant.message", data: { content: "root", outputTokens: 100 } },
        { type: "assistant.message", agentId: "explore", data: { content: "sub", outputTokens: 9999 } },
        { type: "assistant.message", data: { content: "root2", outputTokens: 50 } },
    ];
    const r = reduceCopilotEvents(events);
    assert.equal(r.outputTokens, 150);
});

test("reduceCopilotEvents: ignores malformed outputTokens (NaN, Infinity, negative, non-number)", () => {
    const events = [
        { type: "assistant.message", data: { content: "a", outputTokens: 100 } },
        { type: "assistant.message", data: { content: "b", outputTokens: Number.NaN } },
        { type: "assistant.message", data: { content: "c", outputTokens: Infinity } },
        { type: "assistant.message", data: { content: "d", outputTokens: -50 } },
        { type: "assistant.message", data: { content: "e", outputTokens: "200" } },
        { type: "assistant.message", data: { content: "f", outputTokens: 30 } },
    ];
    const r = reduceCopilotEvents(events);
    // Only the two finite, non-negative numeric values count: 100 + 30.
    // String "200" and the malformed values are skipped.
    assert.equal(r.outputTokens, 130);
});

test("reduceCopilotEvents: extracts premiumRequests from terminal result.usage", () => {
    const events = [
        { type: "assistant.message", data: { content: "hi", outputTokens: 10 } },
        { type: "result", usage: { premiumRequests: 3 } },
    ];
    const r = reduceCopilotEvents(events);
    assert.equal(r.premiumRequests, 3);
});

test("reduceCopilotEvents: premiumRequests is null when result is missing or malformed", () => {
    assert.equal(reduceCopilotEvents([{ type: "result" }]).premiumRequests, null);
    assert.equal(reduceCopilotEvents([{ type: "result", usage: {} }]).premiumRequests, null);
    assert.equal(reduceCopilotEvents([{ type: "result", usage: { premiumRequests: -1 } }]).premiumRequests, null);
    assert.equal(reduceCopilotEvents([{ type: "result", usage: { premiumRequests: Number.NaN } }]).premiumRequests, null);
});

// ───────────── State root + path ─────────────

test("resolveStateRoot: honors $AUTOPILOT_RUNS_DIR (primary)", () => {
    assert.equal(resolveStateRoot({ env: { AUTOPILOT_RUNS_DIR: "/tmp/whatever" } }), "/tmp/whatever");
});

test("resolveStateRoot: honors $RALPH_TUI_RUNS_DIR (legacy, with notice)", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    assert.equal(
        resolveStateRoot({ env: { RALPH_TUI_RUNS_DIR: "/tmp/x" }, fs, stderr, sentinelPath: "/fake/sentinel" }),
        "/tmp/x",
    );
    assert.equal(stderr.messages.length, 1);
    assert.match(stderr.messages[0], /RALPH_TUI_RUNS_DIR is deprecated/);
});

test("resolveStateRoot: defaults under ~/.copilot/autopilot/runs", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    const r = resolveStateRoot({ env: {}, fs, stderr, sentinelPath: "/fake/sentinel" });
    assert.match(r, /\.copilot\/autopilot\/runs$/);
    assert.equal(stderr.messages.length, 0);
});

test("resolveStateRoot: AUTOPILOT primary wins over RALPH_TUI legacy (no notice)", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    assert.equal(
        resolveStateRoot({
            env: { AUTOPILOT_RUNS_DIR: "/ap", RALPH_TUI_RUNS_DIR: "/legacy" },
            fs, stderr, sentinelPath: "/fake/sentinel",
        }),
        "/ap",
    );
    assert.equal(stderr.messages.length, 0);
});

test("resolveStateRoot: legacy default path is honoured with deprecation notice", () => {
    const legacyDefault = join(homedir(), ".copilot", "ralph-tui", "runs");
    const fs = makeFakeFs({ existingPaths: new Set([legacyDefault]) });
    const stderr = makeFakeStderr();
    assert.equal(
        resolveStateRoot({ env: {}, fs, stderr, sentinelPath: "/fake/sentinel" }),
        legacyDefault,
    );
    assert.equal(stderr.messages.length, 1);
    assert.match(stderr.messages[0], /reading from legacy/);
});

test("resolveStateRoot: when both default paths exist, primary wins (no notice)", () => {
    const newDefault = join(homedir(), ".copilot", "autopilot", "runs");
    const oldDefault = join(homedir(), ".copilot", "ralph-tui", "runs");
    const fs = makeFakeFs({ existingPaths: new Set([newDefault, oldDefault]) });
    const stderr = makeFakeStderr();
    assert.equal(
        resolveStateRoot({ env: {}, fs, stderr, sentinelPath: "/fake/sentinel" }),
        newDefault,
    );
    assert.equal(stderr.messages.length, 0);
});

test("resolveStateRoot: deprecation notice is one-shot per process (sentinel-gated)", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    const sentinelPath = "/fake/sentinel";
    resolveStateRoot({ env: { RALPH_TUI_RUNS_DIR: "/x" }, fs, stderr, sentinelPath });
    resolveStateRoot({ env: { RALPH_TUI_RUNS_DIR: "/x" }, fs, stderr, sentinelPath });
    resolveStateRoot({ env: { RALPH_TUI_RUNS_DIR: "/x" }, fs, stderr, sentinelPath });
    assert.equal(stderr.messages.length, 1);
    assert.match(fs.writtenSentinel(), /RALPH_TUI_RUNS_DIR/);
});

test("resolveStateRoot: pre-existing sentinel suppresses the notice", () => {
    const fs = makeFakeFs({ sentinel: "env:RALPH_TUI_RUNS_DIR\n" });
    const stderr = makeFakeStderr();
    assert.equal(
        resolveStateRoot({ env: { RALPH_TUI_RUNS_DIR: "/tmp/x" }, fs, stderr, sentinelPath: "/fake/sentinel" }),
        "/tmp/x",
    );
    assert.equal(stderr.messages.length, 0);
});

// resolveCopilotBin (issue #49) — same DI shape as resolveStateRoot
test("resolveCopilotBin: defaults to 'copilot'", () => {
    assert.equal(resolveCopilotBin({ env: {} }), "copilot");
});

test("resolveCopilotBin: honours $AUTOPILOT_COPILOT_BIN (primary, no notice)", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    assert.equal(
        resolveCopilotBin({ env: { AUTOPILOT_COPILOT_BIN: "/usr/local/bin/copilot" }, fs, stderr, sentinelPath: "/fake/sentinel" }),
        "/usr/local/bin/copilot",
    );
    assert.equal(stderr.messages.length, 0);
});

test("resolveCopilotBin: honours $RALPH_TUI_COPILOT_BIN (legacy, with notice)", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    assert.equal(
        resolveCopilotBin({ env: { RALPH_TUI_COPILOT_BIN: "/usr/local/bin/copilot-old" }, fs, stderr, sentinelPath: "/fake/sentinel" }),
        "/usr/local/bin/copilot-old",
    );
    assert.equal(stderr.messages.length, 1);
    assert.match(stderr.messages[0], /RALPH_TUI_COPILOT_BIN is deprecated/);
});

test("resolveStatePath: joins root + runId + state.json", () => {
    const env = { AUTOPILOT_RUNS_DIR: "/tmp/r" };
    assert.equal(resolveStatePath("foo-1", env), "/tmp/r/foo-1/state.json");
});

// ───────────── State-file CAS ─────────────

test("updateState: throws TypeError when state.json missing", () => {
    const dir = tmp();
    const env = { AUTOPILOT_RUNS_DIR: dir };
    assert.throws(() => updateState("nonexistent", (s) => s, env), TypeError);
    rmSync(dir, { recursive: true, force: true });
});

test("readState: returns null when state.json missing", () => {
    const dir = tmp();
    assert.equal(readState("nope", { AUTOPILOT_RUNS_DIR: dir }), null);
    rmSync(dir, { recursive: true, force: true });
});

test("pauseRun → resumeRun: idempotent + accumulates totalPausedMs", () => {
    const dir = tmp();
    const env = { AUTOPILOT_RUNS_DIR: dir };
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
    const env = { AUTOPILOT_RUNS_DIR: dir };
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
    assert.throws(() => statusRun("missing", { env: { AUTOPILOT_RUNS_DIR: dir } }), TypeError);
    rmSync(dir, { recursive: true, force: true });
});

test("updateState: increments version monotonically under sequential writes", () => {
    const dir = tmp();
    const env = { AUTOPILOT_RUNS_DIR: dir };
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
    // The skeleton sequence is armed → iteration_start →
    // (any number of usage_update for live tokens / excerpt
    // streaming, issue #54 slice 2a) → iteration_end → complete.
    // Drop usage_update before asserting the skeleton so this test
    // stays focused on the iteration-lifecycle contract and doesn't
    // regress every time we tweak live-emission cadence.
    const skeleton = events.map((e) => e.type).filter((t) => t !== "usage_update");
    assert.deepEqual(skeleton, ["armed", "iteration_start", "iteration_end", "complete"]);
    // armed event must carry contextMode + mode + maxIterations for ralph-tui list.
    assert.equal(events[0].contextMode, "fresh");
    assert.equal(events[0].mode, "self-improve");
    assert.equal(events[0].maxIterations, 1);
});

// Issue: TUI Header rendered `tokens 0` for entire run because the
// runner emitted `iteration_end` without a `tokens` field. The fix
// streams a `usage_update` event live (mid-iter) on each root-agent
// `assistant.message` and on the terminal `result`, then includes
// the same cumulative totals on `iteration_end` for replay
// resilience. This test pins both halves of the contract.
test("runRalphTui: emits usage_update mid-iter and cumulative tokens+premium on iteration_end", async () => {
    const events = [];
    const eventEmitter = {
        runId: "usage-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    // Two iterations with distinct token deltas + premium counts so
    // we can verify the runner sums both across iters into a run total.
    const spawn = makeMockSpawn([
        {
            stdout: [
                JSON.stringify({ type: "assistant.message", data: { content: "iter1-a", outputTokens: 100 } }),
                JSON.stringify({ type: "assistant.message", agentId: "explore", data: { content: "sub-agent", outputTokens: 9999 } }),
                JSON.stringify({ type: "assistant.message", data: { content: "iter1-b", outputTokens: 50 } }),
                JSON.stringify({ type: "result", success: true, usage: { premiumRequests: 2 }, result: { sessionId: "s1" } }),
            ].join("\n") + "\n",
            exitCode: 0,
        },
        {
            stdout: [
                JSON.stringify({ type: "assistant.message", data: { content: "iter2 COMPLETE", outputTokens: 30 } }),
                JSON.stringify({ type: "result", success: true, usage: { premiumRequests: 1 }, result: { sessionId: "s1" } }),
            ].join("\n") + "\n",
            exitCode: 0,
        },
    ]);
    await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 2,
        env: makeEnv(),
        spawn,
        eventEmitter,
    });
    const usageUpdates = events.filter((e) => e.type === "usage_update");
    // Must have at least one usage_update during iter 1 (mid-iter
    // visibility — the screenshot's pain point) and one for the
    // terminal result of each iter.
    assert.ok(usageUpdates.length >= 3, `expected ≥3 usage_update events, got ${usageUpdates.length}`);
    // Sub-agent message (agentId=explore) must NOT contribute to any
    // usage_update tokens — totals stay capped by root-agent tokens.
    for (const u of usageUpdates) {
        assert.ok(u.tokens.output <= 100 + 50 + 30, `usage_update output=${u.tokens.output} exceeds root-only sum`);
    }
    // First mid-iter usage_update (after the 100-token message)
    // should report cumulative tokens.output = 100, no premium yet.
    const firstMid = usageUpdates[0];
    assert.equal(firstMid.tokens.input, 0);
    assert.equal(firstMid.tokens.output, 100);
    assert.equal(firstMid.premiumRequests, undefined);
    // The terminal `result` for iter 1 fires a usage_update with
    // cumulative tokens (100+50=150) AND premium=2.
    const iter1Result = usageUpdates.find(u => u.iteration === 1 && u.premiumRequests != null);
    assert.equal(iter1Result.tokens.output, 150);
    assert.equal(iter1Result.premiumRequests, 2);
    // iteration_end events carry the post-iter reconciled cumulatives.
    const iterEnds = events.filter((e) => e.type === "iteration_end");
    assert.equal(iterEnds.length, 2);
    assert.equal(iterEnds[0].iteration, 1);
    assert.equal(iterEnds[0].tokens.output, 150);
    assert.equal(iterEnds[0].premiumRequests, 2);
    assert.equal(iterEnds[1].iteration, 2);
    assert.equal(iterEnds[1].tokens.output, 150 + 30); // run total
    assert.equal(iterEnds[1].premiumRequests, 2 + 1);  // run total
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

// ─── Issue #48: live event streaming (regression for the
// "(no active stage) / (no activity yet)" empty-pane bug
// reported on `ralph-tui run --self-improve --fresh`).
//
// Pre-fix, the runner buffered every child JSONL event in
// memory and emitted the synthetic stage_start / substage
// events to events.jsonl in a single batch AFTER the child
// exited. For an iter that took minutes, the TUI saw nothing
// land in events.jsonl between iteration_start and
// iteration_end and rendered every pane empty. Post-fix, each
// child JSONL line streams through `runOneIteration`'s
// `onLine` hook, which incrementally re-runs
// extractAgentTimeline and emits any new tail items live.
//
// This test pins the live-before-close guarantee: a spawn
// shim that emits stdout, then DELAYS close behind a gate,
// must see the stage_start event in eventEmitter.write
// BEFORE the close gate is released. The pre-fix runner
// would not emit stage_start until close fired, so the
// assertion `stageStartBeforeClose === true` would fail.
test("runRalphTui: stage_start emits LIVE during the iter, not in a post-close batch (issue #48)", async () => {
    const events = [];
    const eventEmitter = {
        runId: "stream-live",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    let closeGate;
    const closeGatePromise = new Promise((res) => { closeGate = res; });
    let stageStartBeforeClose = false;
    let closeFired = false;

    const spawn = function () {
        const handlers = { stdout: [], close: [], error: [] };
        const child = {
            stdout: { on: (ev, fn) => handlers.stdout.push(fn), pipe: () => {} },
            stderr: { on: () => {}, pipe: () => {} },
            on: (ev, fn) => {
                if (ev === "close") handlers.close.push(fn);
                if (ev === "error") handlers.error.push(fn);
            },
            kill: () => {},
        };
        // Emit the agent's two stage markers + COMPLETE + result on
        // ONE batch of stdout, then PAUSE. The test takes a sample
        // of `events` during the pause: it MUST contain stage_start
        // already, proving the streaming path emits live.
        const stdout = [
            JSON.stringify({ type: "assistant.message", data: { content: "[STAGE: ORIENT]\nlooking around\n[STAGE: IDEATE]\nideating\nCOMPLETE" } }),
            JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
        ].join("\n") + "\n";
        setImmediate(() => {
            for (const fn of handlers.stdout) fn(Buffer.from(stdout));
            // Sample after stdout has been processed by `onStdout` →
            // `onLine` → live emit. setImmediate gives the streaming
            // path one tick to drain. Then we await the gate before
            // firing close, so the pre-close window stays open long
            // enough for the test to assert.
            setImmediate(() => {
                stageStartBeforeClose = events.some((e) => e.type === "stage_start");
                closeGatePromise.then(() => {
                    closeFired = true;
                    for (const fn of handlers.close) fn(0);
                });
            });
        });
        return child;
    };

    const runPromise = runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
    });

    // Give the stream + sample-after-setImmediate path time to run.
    // 4 ticks is plenty; we don't actually want to wait long since
    // the test should be deterministic. The gate ensures the run
    // can't complete until we say so.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(closeFired, false,
        "guard: gate must still be held — otherwise the test cannot prove live-before-close");
    assert.equal(stageStartBeforeClose, true,
        "stage_start must be in the events array BEFORE child close fires; "
        + "pre-fix runner emitted everything in a post-close batch and this would be false");

    closeGate();
    const result = await runPromise;
    assert.equal(result.terminationReason, "complete");

    // Final event order must still be canonical: iter_start →
    // stage events → iter_end. This pins that the streaming path
    // is byte-equivalent to the post-close batch in final ordering.
    const stageEvents = events.filter((e) => e.type === "stage_start" || e.type === "stage_end");
    assert.deepEqual(stageEvents.map((e) => `${e.type}:${e.stageName}`),
        ["stage_start:ORIENT", "stage_end:ORIENT", "stage_start:IDEATE", "stage_end:IDEATE"]);
});

// Companion regression: when the agent's final JSONL line is
// NOT newline-terminated, the close-handler's trailing-buffer
// drain recovers it. That drain MUST also fire `onLine` so the
// streaming emitter sees the final event — without that, the
// post-fix runner would silently drop the last
// tool.execution_complete (or final `[STAGE: ]` marker) and the
// TUI's last-iter snapshot would be subtly wrong. The
// streaming + suffix-replay design in `runRalphTui` defends
// against this in two ways (onLine-on-drain + suffix replay
// against result.events), so even if only one path were
// somehow broken, this assertion still holds.
test("runRalphTui: final un-newline-terminated JSONL line is captured live (close-drain → onLine)", async () => {
    const events = [];
    const eventEmitter = {
        runId: "drain-live",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };

    const spawn = function () {
        const handlers = { stdout: [], close: [] };
        const child = {
            stdout: { on: (ev, fn) => handlers.stdout.push(fn), pipe: () => {} },
            stderr: { on: () => {}, pipe: () => {} },
            on: (ev, fn) => { if (ev === "close") handlers.close.push(fn); },
            kill: () => {},
        };
        // No trailing newline on the LAST line — emulates a child
        // that exits mid-line. Without onLine-on-drain (or the
        // suffix-replay safety net), the second [STAGE: IDEATE]
        // marker would be invisible until close, then the
        // suffix-replay would catch it; with onLine-on-drain it
        // streams live just like every other event. Either path
        // passes this assertion — the test pins the contract,
        // not the path.
        const stdout =
            JSON.stringify({ type: "assistant.message", data: { content: "[STAGE: ORIENT]\nlooked\n[STAGE: IDEATE]\nplanning\nCOMPLETE" } })
            + "\n"
            + JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } });
        setImmediate(() => {
            for (const fn of handlers.stdout) fn(Buffer.from(stdout));
            for (const fn of handlers.close) fn(0);
        });
        return child;
    };

    const result = await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
    });
    assert.equal(result.terminationReason, "complete");
    const stageEvents = events.filter((e) => e.type === "stage_start" || e.type === "stage_end");
    assert.deepEqual(stageEvents.map((e) => `${e.type}:${e.stageName}`),
        ["stage_start:ORIENT", "stage_end:ORIENT", "stage_start:IDEATE", "stage_end:IDEATE"],
        "trailing un-newline-terminated JSONL line must produce its stage events");
});

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

// ─── Issue #48 slice 9: structured markers + commit_observed ────────

import {
    extractStructuredMarkers,
    STRUCTURED_MARKER_KEYS,
    computePinnedTailAmendments,
    looksLikeGitCommit,
    readHeadCommit,
} from "../src/runner.mjs";
import { PINNED_TAIL_STAGES } from "../src/events.mjs";

test("STRUCTURED_MARKER_KEYS exports the 7 documented marker keys (pinned)", () => {
    assert.deepEqual([...STRUCTURED_MARKER_KEYS].sort(), [
        "STAGE_PLAN",
        "STAGE_PLAN_AMEND",
        "TASK_END",
        "TASK_LIST",
        "TASK_START",
        "WORKITEM_END",
        "WORKITEM_START",
    ]);
});

test("extractStructuredMarkers: empty / non-string input → []", () => {
    assert.deepEqual(extractStructuredMarkers(null), []);
    assert.deepEqual(extractStructuredMarkers(undefined), []);
    assert.deepEqual(extractStructuredMarkers(42), []);
    assert.deepEqual(extractStructuredMarkers(""), []);
});

test("extractStructuredMarkers: parses each documented marker on its own line", () => {
    const text = [
        '[WORKITEM_START: {"kind":"issue","ref":42,"title":"x"}]',
        '[STAGE_PLAN: {"stages":["REPRO","FIX","TEST"]}]',
        '[TASK_LIST: {"stage":"FIX","items":["a","b"]}]',
        '[TASK_START: {"stage":"FIX","sub":1,"desc":"a"}]',
        '[TASK_END: {"stage":"FIX","sub":1,"outcome":"ok","durationMs":120}]',
        '[STAGE_PLAN_AMEND: {"add":"DOCS","after":"TEST","reason":"add"}]',
        '[WORKITEM_END: {"kind":"issue","ref":42,"closesN":1}]',
    ].join("\n");
    const out = extractStructuredMarkers(text);
    assert.deepEqual(out.map((m) => m.key), [
        "WORKITEM_START", "STAGE_PLAN", "TASK_LIST", "TASK_START",
        "TASK_END", "STAGE_PLAN_AMEND", "WORKITEM_END",
    ]);
    assert.deepEqual(out[1].payload, { stages: ["REPRO", "FIX", "TEST"] });
    assert.equal(out[3].payload.sub, 1);
    assert.equal(out[4].payload.outcome, "ok");
});

test("extractStructuredMarkers: malformed JSON, non-object payload, unknown key → silently skipped", () => {
    const text = [
        "[STAGE_PLAN: not json at all]",
        '[STAGE_PLAN: ["array","payload"]]',     // valid JSON, not object
        '[STAGE_PLAN: "plain string"]',          // valid JSON, not object
        '[BOGUS_KEY: {"x":1}]',                   // unknown key
        '[STAGE_PLAN: {"stages":["A"]}]',         // good — should pass
    ].join("\n");
    const out = extractStructuredMarkers(text);
    assert.equal(out.length, 1);
    assert.equal(out[0].key, "STAGE_PLAN");
});

test("extractStructuredMarkers: whole-line-only — inline mention in prose does NOT fire", () => {
    const text = [
        'I will emit [STAGE_PLAN: {"stages":["X"]}] later',  // inline — must NOT match
        'Now: [STAGE_PLAN: {"stages":["Y"]}]',                // inline (preceded by "Now:") — must NOT match
        '[STAGE_PLAN: {"stages":["Z"]}]',                     // own line — MUST match
    ].join("\n");
    const out = extractStructuredMarkers(text);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].payload.stages, ["Z"]);
});

test("extractStructuredMarkers: tolerates leading/trailing whitespace on the marker line", () => {
    const text = '   [STAGE_PLAN: {"stages":["A"]}]   \n\t[TASK_END: {"stage":"A","sub":1,"outcome":"ok"}]\t';
    const out = extractStructuredMarkers(text);
    assert.equal(out.length, 2);
    assert.equal(out[0].key, "STAGE_PLAN");
    assert.equal(out[1].key, "TASK_END");
});

test("computePinnedTailAmendments: empty raw → 3 add ops in canonical order", () => {
    const out = computePinnedTailAmendments([], PINNED_TAIL_STAGES);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((a) => a.add), [...PINNED_TAIL_STAGES]);
    // First add anchors after... nothing (empty raw); subsequent adds
    // chain after the previously-appended pinned stage.
    assert.equal(out[1].after, PINNED_TAIL_STAGES[0]);
    assert.equal(out[2].after, PINNED_TAIL_STAGES[1]);
    for (const a of out) assert.equal(a.reason, "pinned-tail-enforcement");
});

test("computePinnedTailAmendments: raw has all 3 pinned correctly placed at tail → 3 remove + 3 add (symmetric)", () => {
    const raw = ["A", "B", ...PINNED_TAIL_STAGES];
    const out = computePinnedTailAmendments(raw, PINNED_TAIL_STAGES);
    const removes = out.filter((a) => a.remove);
    const adds = out.filter((a) => a.add);
    assert.equal(removes.length, 3, "each pinned stage in raw is removed first");
    assert.equal(adds.length, 3, "then each is re-added in canonical order");
    assert.deepEqual(removes.map((a) => a.remove).sort(),
        [...PINNED_TAIL_STAGES].sort());
    assert.deepEqual(adds.map((a) => a.add), [...PINNED_TAIL_STAGES]);
    // First add anchors after the last head stage.
    assert.equal(adds[0].after, "B");
});

test("computePinnedTailAmendments: misplaced pinned mid-list → remove + chained adds at tail", () => {
    const raw = ["REPRO", "COMMIT", "TEST"];  // COMMIT in the middle
    const out = computePinnedTailAmendments(raw, PINNED_TAIL_STAGES);
    // Must remove COMMIT (the only pinned in raw), then add COMMIT,
    // PUSH, END at tail anchored after TEST → COMMIT → PUSH.
    const removes = out.filter((a) => a.remove).map((a) => a.remove);
    assert.deepEqual(removes, ["COMMIT"]);
    const adds = out.filter((a) => a.add).map((a) => `${a.add}@${a.after ?? ""}`);
    assert.deepEqual(adds, ["COMMIT@TEST", "PUSH@COMMIT", "END@PUSH"]);
});

test("computePinnedTailAmendments: empty pinnedTail → []", () => {
    assert.deepEqual(computePinnedTailAmendments(["A", "B"], []), []);
    assert.deepEqual(computePinnedTailAmendments(["A"], null), []);
});

test("looksLikeGitCommit: positive cases", () => {
    assert.ok(looksLikeGitCommit("git commit -m 'msg'"));
    assert.ok(looksLikeGitCommit("git commit -F /tmp/msg"));
    assert.ok(looksLikeGitCommit("git -c user.name=foo commit -m 'x'"));
    assert.ok(looksLikeGitCommit("git -c user.name=foo -c user.email=bar commit -F /tmp/m"));
    assert.ok(looksLikeGitCommit("cd subdir && git commit -m 'x'"));
    assert.ok(looksLikeGitCommit("  git commit --amend --no-edit  "));
    assert.ok(looksLikeGitCommit("git status\ngit commit -m 'multi'\ngit push"));
    assert.ok(looksLikeGitCommit("git commit"));
});

test("looksLikeGitCommit: negative cases", () => {
    assert.ok(!looksLikeGitCommit("echo 'git commit me'"));
    assert.ok(!looksLikeGitCommit("git status"));
    assert.ok(!looksLikeGitCommit("git --help commit"));
    assert.ok(!looksLikeGitCommit("git commit-tree HEAD^{tree}"));
    assert.ok(!looksLikeGitCommit("ls /repo"));
    assert.ok(!looksLikeGitCommit(""));
    assert.ok(!looksLikeGitCommit(null));
    assert.ok(!looksLikeGitCommit(42));
});

test("readHeadCommit: returns sha + subject + trailers from injected gitExec", () => {
    const NUL = "\u0000";
    const gitExec = ({ args }) => {
        if (args[0] === "rev-parse" && args[1] === "--short") return "abc1234\n";
        if (args[0] === "log") {
            return `feat(x): subject${NUL}Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\nCo-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>`;
        }
        return null;
    };
    const out = readHeadCommit({ gitExec, cwd: "/repo", env: {} });
    assert.equal(out.sha, "abc1234");
    assert.equal(out.subject, "feat(x): subject");
    assert.equal(out.trailers.length, 2);
    assert.match(out.trailers[0], /^Co-authored-by: Copilot/);
});

test("readHeadCommit: gitExec returning null for rev-parse → null (not a repo)", () => {
    const gitExec = () => null;
    assert.equal(readHeadCommit({ gitExec, cwd: "/repo", env: {} }), null);
});

test("readHeadCommit: rev-parse non-sha output → null (defensive)", () => {
    const gitExec = ({ args }) => {
        if (args[0] === "rev-parse") return "fatal: not a git repository\n";
        return null;
    };
    assert.equal(readHeadCommit({ gitExec, cwd: "/repo", env: {} }), null);
});

test("readHeadCommit: log without trailer block → empty trailers array", () => {
    const NUL = "\u0000";
    const gitExec = ({ args }) => {
        if (args[0] === "rev-parse") return "abc1234\n";
        if (args[0] === "log") return `subject only${NUL}`;
        return null;
    };
    const out = readHeadCommit({ gitExec, cwd: "/repo", env: {} });
    assert.equal(out.subject, "subject only");
    assert.deepEqual(out.trailers, []);
});

test("extractAgentTimeline: tool_complete now carries toolCallId + raw args (slice 9)", () => {
    const events = [
        { type: "tool.execution_start", timestamp: "2026-01-01T00:00:00.000Z",
          data: { toolCallId: "tc-1", toolName: "bash",
                  arguments: { command: "git commit -m 'x'", working_dir: "/repo" } } },
        { type: "tool.execution_complete", timestamp: "2026-01-01T00:00:00.500Z",
          data: { toolCallId: "tc-1", success: true } },
    ];
    const tl = extractAgentTimeline(events, []);
    assert.equal(tl.length, 1);
    assert.equal(tl[0].toolCallId, "tc-1");
    assert.equal(tl[0].args?.command, "git commit -m 'x'");
});

test("extractAgentTimeline: structured markers from root-agent assistant.message surface as timeline items", () => {
    const events = [
        { type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
          data: { content: '[STAGE_PLAN: {"stages":["A","B"]}]' } },
        { type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
          data: { content: '[TASK_LIST: {"stage":"A","items":["t1"]}]\n[TASK_START: {"stage":"A","sub":1,"desc":"t1"}]' } },
    ];
    const tl = extractAgentTimeline(events, []);
    const kinds = tl.map((it) => it.kind);
    assert.deepEqual(kinds, ["stage_plan", "task_list", "task_start"]);
    assert.deepEqual(tl[0].payload.stages, ["A", "B"]);
    assert.equal(tl[1].payload.stage, "A");
    assert.equal(tl[2].payload.sub, 1);
});

test("extractAgentTimeline: structured markers from sub-agents (agentId set) are ignored", () => {
    const events = [
        { type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
          agentId: "explore",
          data: { content: '[STAGE_PLAN: {"stages":["A"]}]' } },
        { type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
          data: { content: '[STAGE_PLAN: {"stages":["B"]}]' } },
    ];
    const tl = extractAgentTimeline(events, []);
    assert.equal(tl.length, 1, "only root-agent's marker fires");
    assert.deepEqual(tl[0].payload.stages, ["B"]);
});

test("runRalphTui: STAGE_PLAN marker → emits stage_plan event followed by pinned-tail amendments", async () => {
    const events = [];
    const eventEmitter = {
        runId: "stage-plan-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: '[STAGE_PLAN: {"stages":["REPRO","FIX","TEST"]}]' } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
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
    const planEvents = events.filter((e) => e.type === "stage_plan");
    assert.equal(planEvents.length, 1, "raw stage_plan emitted once");
    assert.deepEqual(planEvents[0].stages, ["REPRO", "FIX", "TEST"]);
    const amends = events.filter((e) => e.type === "stage_plan_amend");
    assert.equal(amends.length, 3, "three amend ops to pin COMMIT/PUSH/END at tail");
    assert.deepEqual(amends.map((a) => a.add), [...PINNED_TAIL_STAGES]);
    for (const a of amends) assert.equal(a.reason, "pinned-tail-enforcement");
    // Ordering: stage_plan must precede all amends so foldEvents sees
    // the raw plan first then transforms it.
    const planIdx = events.findIndex((e) => e.type === "stage_plan");
    const firstAmendIdx = events.findIndex((e) => e.type === "stage_plan_amend");
    assert.ok(planIdx >= 0 && planIdx < firstAmendIdx, "stage_plan precedes amends");
});

test("runRalphTui: bash 'git commit' substage → emits commit_observed with sha+subject+trailers", async () => {
    const events = [];
    const eventEmitter = {
        runId: "commit-observed-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const NUL = "\u0000";
    // Issue #54 slice 2c — runner now also probes HEAD at arm time
    // (replay-on-mount) so the LastCommit pane is never empty when
    // the run starts. Stateful gitExec returns the pre-loop HEAD on
    // the first rev-parse+log pair (arm-time), then advances to the
    // post-commit HEAD for subsequent calls (the iter-1 commit
    // substage probe). This pins both legitimate emit sites.
    let revParseCalls = 0;
    let logCalls = 0;
    const gitExec = ({ args }) => {
        if (args[0] === "rev-parse" && args[1] === "--short") {
            revParseCalls += 1;
            return revParseCalls === 1 ? "0000000\n" : "abc1234\n";
        }
        if (args[0] === "log") {
            logCalls += 1;
            return logCalls === 1
                ? `chore: pre-loop baseline${NUL}`
                : `feat(x): test commit${NUL}Co-authored-by: Copilot <copilot@users.noreply.github.com>`;
        }
        return null;
    };
    const stdout = [
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:00.000Z",
            data: { toolCallId: "tc-commit", toolName: "bash", arguments: { command: "git commit -m 'feat(x): test commit'" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:00.300Z",
            data: { toolCallId: "tc-commit", success: true } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
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
        gitExec,
    });
    const cos = events.filter((e) => e.type === "commit_observed");
    // Two events: arm-time HEAD replay (iteration:0) +
    // iter-1 git commit substage observation (iteration:1).
    assert.equal(cos.length, 2, "arm-time replay + iter-1 commit substage");
    assert.equal(cos[0].iteration, 0, "first event is arm-time replay");
    assert.equal(cos[0].sha, "0000000");
    assert.equal(cos[0].subject, "chore: pre-loop baseline");
    assert.equal(cos[1].iteration, 1, "second event is iter-1 commit");
    assert.equal(cos[1].sha, "abc1234");
    assert.equal(cos[1].subject, "feat(x): test commit");
    assert.equal(cos[1].trailers.length, 1);
});

test("runRalphTui: failed git commit substage does NOT trigger commit_observed", async () => {
    const events = [];
    const eventEmitter = {
        runId: "commit-fail-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    // Issue #54 slice 2c — runner now also probes HEAD at arm time
    // for replay-on-mount. With a stub returning null (simulating
    // "not a git repo"), the arm-time probe still calls gitExec
    // (rev-parse) but gets null back, so no commit_observed event
    // is emitted. The bash-substage path (which is what this test
    // pins) is unrelated and would not emit either since success=
    // false. Net: 0 commit_observed events, but gitExec IS called
    // once at arm-time.
    let gitExecCalls = 0;
    const gitExec = () => { gitExecCalls += 1; return null; };
    const stdout = [
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:00.000Z",
            data: { toolCallId: "tc-fail", toolName: "bash", arguments: { command: "git commit -m 'x'" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:00.300Z",
            data: { toolCallId: "tc-fail", success: false, error: { code: "exit-1" } } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
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
        gitExec,
    });
    assert.equal(events.filter((e) => e.type === "commit_observed").length, 0);
    // Arm-time replay-on-mount calls gitExec once (rev-parse).
    // Returns null → readHeadCommit short-circuits, no log call.
    // Failed-commit substage path doesn't shell to git either.
    assert.equal(gitExecCalls, 1, "gitExec called once at arm-time replay (rev-parse), short-circuits on null");
});

test("runRalphTui: non-bash tool with 'git commit' in argsSummary does NOT fire commit_observed", async () => {
    const events = [];
    const eventEmitter = {
        runId: "non-bash-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const gitExec = () => null;
    const stdout = [
        // grep tool with pattern matching 'git commit' should NOT trigger.
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:00.000Z",
            data: { toolCallId: "g1", toolName: "grep", arguments: { pattern: "git commit -m" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:00.100Z",
            data: { toolCallId: "g1", success: true } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
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
        gitExec,
    });
    assert.equal(events.filter((e) => e.type === "commit_observed").length, 0);
});

// ─── Issue #54 slice 2c: arm-time HEAD replay-on-mount ──────────────

test("Issue #54 slice 2c: runRalphTui emits commit_observed at arm time when HEAD exists, even if iter makes no commits", async () => {
    const events = [];
    const eventEmitter = {
        runId: "arm-replay-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const NUL = "\u0000";
    const gitExec = ({ args }) => {
        if (args[0] === "rev-parse" && args[1] === "--short") return "deadbee\n";
        if (args[0] === "log") return `chore: pre-loop baseline${NUL}Co-authored-by: Copilot <c@e>`;
        return null;
    };
    // Iter that DOESN'T commit — just emits COMPLETE. The arm-time
    // replay is what populates LastCommit so the user sees HEAD on
    // mount instead of an empty pane.
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
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
        gitExec,
    });
    const cos = events.filter((e) => e.type === "commit_observed");
    assert.equal(cos.length, 1, "exactly one commit_observed emitted at arm time");
    assert.equal(cos[0].iteration, 0, "arm-time replay carries iteration: 0");
    assert.equal(cos[0].sha, "deadbee");
    assert.equal(cos[0].subject, "chore: pre-loop baseline");
    assert.equal(cos[0].trailers.length, 1);
});

test("Issue #54 slice 2c: arm-time replay is silent when gitExec returns null (not a repo)", async () => {
    const events = [];
    const eventEmitter = {
        runId: "no-repo-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    // gitExec returns null for everything → not a repo / git missing.
    const gitExec = () => null;
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
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
        gitExec,
    });
    assert.equal(events.filter((e) => e.type === "commit_observed").length, 0,
        "no commit_observed emitted when gitExec returns null");
});

test("runRalphTui: WORKITEM_START + WORKITEM_END markers emit workitem events", async () => {
    const events = [];
    const eventEmitter = {
        runId: "wi-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: '[WORKITEM_START: {"kind":"issue","ref":48,"title":"3-level renderer"}]' } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
            data: { content: '[WORKITEM_END: {"kind":"issue","ref":48,"closesN":1}]' } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:02.000Z",
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
    const start = events.find((e) => e.type === "workitem_start");
    const end = events.find((e) => e.type === "workitem_end");
    assert.ok(start, "workitem_start emitted");
    assert.equal(start.kind, "issue");
    assert.equal(start.ref, 48);
    assert.equal(start.title, "3-level renderer");
    assert.ok(end, "workitem_end emitted");
    assert.equal(end.closesN, 1);
});

test("runRalphTui: TASK_LIST + TASK_START + TASK_END markers emit task events", async () => {
    const events = [];
    const eventEmitter = {
        runId: "task-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: '[TASK_LIST: {"stage":"FIX","items":["a","b"]}]' } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
            data: { content: '[TASK_START: {"stage":"FIX","sub":1,"desc":"a"}]' } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:02.000Z",
            data: { content: '[TASK_END: {"stage":"FIX","sub":1,"outcome":"ok","durationMs":500}]' } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:03.000Z",
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
    const list = events.find((e) => e.type === "task_list");
    const start = events.find((e) => e.type === "task_start");
    const end = events.find((e) => e.type === "task_end");
    assert.ok(list && start && end);
    assert.deepEqual(list.items, ["a", "b"]);
    assert.equal(start.stage, "FIX");
    assert.equal(start.sub, 1);
    assert.equal(end.outcome, "ok");
    assert.equal(end.durationMs, 500);
});

test("runRalphTui: malformed marker payload (missing required field) is silently dropped", async () => {
    const events = [];
    const eventEmitter = {
        runId: "bad-marker-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        // missing "kind" → should be dropped at the runner layer
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: '[WORKITEM_START: {"ref":1,"title":"x"}]' } }),
        // bogus "kind" → should also be dropped
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:01.000Z",
            data: { content: '[WORKITEM_START: {"kind":"feature_request","ref":1}]' } }),
        // missing "stage" on task_list → dropped
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:02.000Z",
            data: { content: '[TASK_LIST: {"items":["a"]}]' } }),
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:03.000Z",
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
    assert.equal(events.filter((e) => e.type === "workitem_start").length, 0);
    assert.equal(events.filter((e) => e.type === "task_list").length, 0);
});

// ─── Issue #48 slice 6: backlog snapshot from agent gh probes ────────

import { parseGhListCount, extractBacklogFromEvents } from "../src/runner.mjs";

test("parseGhListCount: counts tab-delimited rows in gh list output", () => {
    // Realistic gh issue list shape (header line is also tab-delimited
    // when present, but in the agent's `2>/dev/null || true` invocation
    // there is no header — just data rows). Each data row has at least
    // one tab.
    const stdout = [
        "12345\tFix the thing\tbug,priority\t\tabout 1 hour ago",
        "12346\tAnother bug\t\t\tabout 2 hours ago",
        "12347\tTest issue\tlabel1\tassignee\t1 day ago",
    ].join("\n") + "\n";
    assert.equal(parseGhListCount(stdout), 3);
});

test("parseGhListCount: empty stdout → 0", () => {
    assert.equal(parseGhListCount(""), 0);
    assert.equal(parseGhListCount("\n"), 0);
    assert.equal(parseGhListCount("   \n  \n"), 0,
        "whitespace-only lines without tabs don't count as rows");
});

test("parseGhListCount: lines without tabs are not counted", () => {
    // A banner like "no open issues match your search" has no tabs.
    const stdout = "no open issues match your search\n";
    assert.equal(parseGhListCount(stdout), 0);
});

test("parseGhListCount: non-string input → null", () => {
    assert.equal(parseGhListCount(null), null);
    assert.equal(parseGhListCount(undefined), null);
    assert.equal(parseGhListCount(42), null);
});

test("parseGhListCount: handles \\r\\n line endings", () => {
    const stdout = "12345\tA\r\n12346\tB\r\n";
    assert.equal(parseGhListCount(stdout), 2);
});

test("extractBacklogFromEvents: captures all three probes when the agent runs them", () => {
    const events = [
        { type: "tool.execution_start",
          data: { toolCallId: "c1", toolName: "bash",
            arguments: { command: "gh run list --status failure --limit 10 2>/dev/null || true" } } },
        { type: "tool.execution_complete",
          data: { toolCallId: "c1", success: true,
            result: { content: "X\tfailure\tBuild\tmain\tpush\t1m\nX\tfailure\tCI\tmain\tpush\t2m\n" } } },
        { type: "tool.execution_start",
          data: { toolCallId: "c2", toolName: "bash",
            arguments: { command: "gh pr list --state open --limit 20 2>/dev/null || true" } } },
        { type: "tool.execution_complete",
          data: { toolCallId: "c2", success: true,
            result: { content: "42\tFix\tcopilot\topen\t1d\n43\tDocs\tuser\topen\t2d\n44\tWIP\tbot\topen\t3d\n" } } },
        { type: "tool.execution_start",
          data: { toolCallId: "c3", toolName: "bash",
            arguments: { command: "gh issue list --state open --limit 30 2>/dev/null || true" } } },
        { type: "tool.execution_complete",
          data: { toolCallId: "c3", success: true,
            result: { content: "100\tA\t\t\t1h\n101\tB\t\t\t2h\n102\tC\t\t\t3h\n103\tD\t\t\t4h\n104\tE\t\t\t5h\n" } } },
    ];
    const got = extractBacklogFromEvents(events);
    assert.deepEqual(got, { redCi: 2, openPrs: 3, openIssues: 5 });
});

test("extractBacklogFromEvents: missing probes leave fields null", () => {
    // Only the issue probe ran — the renderer shows ? for the other two.
    const events = [
        { type: "tool.execution_start",
          data: { toolCallId: "c1", toolName: "bash",
            arguments: { command: "gh issue list --state open" } } },
        { type: "tool.execution_complete",
          data: { toolCallId: "c1", success: true,
            result: { content: "1\ta\n2\tb\n" } } },
    ];
    const got = extractBacklogFromEvents(events);
    assert.deepEqual(got, { redCi: null, openPrs: null, openIssues: 2 });
});

test("extractBacklogFromEvents: no probes ran → returns null (no event emitted)", () => {
    const events = [
        { type: "tool.execution_start",
          data: { toolCallId: "c1", toolName: "bash",
            arguments: { command: "git status" } } },
        { type: "tool.execution_complete",
          data: { toolCallId: "c1", success: true,
            result: { content: "clean" } } },
    ];
    assert.equal(extractBacklogFromEvents(events), null);
});

test("extractBacklogFromEvents: failed probe (success=false) ignored", () => {
    // gh might be missing or unauthenticated → tool.execution_complete
    // arrives with success=false. The agent's `|| true` swallows the
    // error at command level, but if the bash tool itself reports
    // failure, we don't trust the partial stdout.
    const events = [
        { type: "tool.execution_start",
          data: { toolCallId: "c1", toolName: "bash",
            arguments: { command: "gh issue list --state open" } } },
        { type: "tool.execution_complete",
          data: { toolCallId: "c1", success: false,
            error: { code: "denied", message: "..." },
            result: { content: "1\tspurious\n" } } },
    ];
    assert.equal(extractBacklogFromEvents(events), null,
        "a failed bash tool result must not poison the snapshot");
});

test("extractBacklogFromEvents: regex anchors prevent grow_project's labelled probe from counting as the open-issue probe", () => {
    // grow_project's ORIENT runs `gh issue list --label grow-project
    // --state open` which only lists feature backlog. We DO want to
    // count that as open issues (it has --state open) — but this
    // test pins that even with the extra --label flag, the match
    // still fires. (If a future iteration of the prompt drops
    // --state open, the field stays null, which the renderer
    // gracefully handles.)
    const events = [
        { type: "tool.execution_start",
          data: { toolCallId: "c1", toolName: "bash",
            arguments: { command: "gh issue list --label grow-project --state open" } } },
        { type: "tool.execution_complete",
          data: { toolCallId: "c1", success: true,
            result: { content: "200\tFeature1\tgrow-project\t\t1d\n201\tFeature2\tgrow-project\t\t2d\n" } } },
    ];
    const got = extractBacklogFromEvents(events);
    assert.deepEqual(got, { redCi: null, openPrs: null, openIssues: 2 });
});

test("extractBacklogFromEvents: non-array input → null", () => {
    assert.equal(extractBacklogFromEvents(null), null);
    assert.equal(extractBacklogFromEvents(undefined), null);
    assert.equal(extractBacklogFromEvents("not events"), null);
});

test("runRalphTui: emits backlog_snapshot when the agent runs gh probes during ORIENT", async () => {
    const events = [];
    const eventEmitter = {
        runId: "backlog-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: "[STAGE: ORIENT]" } }),
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:01.000Z",
            data: { toolCallId: "c1", toolName: "bash",
                arguments: { command: "gh run list --status failure --limit 10 2>/dev/null || true" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:01.500Z",
            data: { toolCallId: "c1", success: true, result: { content: "" } } }),
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:02.000Z",
            data: { toolCallId: "c2", toolName: "bash",
                arguments: { command: "gh pr list --state open --limit 20 2>/dev/null || true" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:02.500Z",
            data: { toolCallId: "c2", success: true,
                result: { content: "42\tFix\tcopilot\topen\t1d\n" } } }),
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-01-01T00:00:03.000Z",
            data: { toolCallId: "c3", toolName: "bash",
                arguments: { command: "gh issue list --state open --limit 30 2>/dev/null || true" } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-01-01T00:00:03.500Z",
            data: { toolCallId: "c3", success: true,
                result: { content: "1\tA\n2\tB\n3\tC\n" } } }),
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
    const snapEvents = events.filter((e) => e.type === "backlog_snapshot");
    assert.equal(snapEvents.length, 1, "exactly one backlog_snapshot per iter when probes run");
    assert.equal(snapEvents[0].redCi, 0, "no failure rows → 0");
    assert.equal(snapEvents[0].openPrs, 1);
    assert.equal(snapEvents[0].openIssues, 3);
    assert.equal(snapEvents[0].iteration, 1);
    // Snapshot must come before iteration_end so the renderer's per-iter
    // backlog row matches that iter.
    const snapIdx = events.findIndex((e) => e.type === "backlog_snapshot");
    const iterEndIdx = events.findIndex((e) => e.type === "iteration_end");
    assert.ok(snapIdx < iterEndIdx, "backlog_snapshot must precede iteration_end");
});

test("runRalphTui: no backlog_snapshot when the agent ran no gh probes (e.g. --prompt mode)", async () => {
    const events = [];
    const eventEmitter = {
        runId: "no-backlog-test",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-01-01T00:00:00.000Z",
            data: { content: "did the work\nCOMPLETE" } }),
        JSON.stringify({ type: "result", success: true, result: { sessionId: "s" } }),
    ].join("\n") + "\n";
    const spawn = makeMockSpawn([{ stdout, exitCode: 0 }]);
    await runRalphTui({
        mode: "prompt",
        contextMode: "fresh",
        prompt: "do something",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
    });
    assert.equal(events.filter((e) => e.type === "backlog_snapshot").length, 0,
        "no probes ran → no backlog_snapshot event (renderer shows ?)");
});

// ─── Issue #48 slice 9 commit 4: smoke test — full marker stream ────────
//
// Drives runRalphTui end-to-end with a single iter that emits the
// complete marker hierarchy:
//   workitem_start → stage_plan → task_list → task_start →
//   tool_complete (git commit) → commit_observed (runner side) →
//   task_end → workitem_end → COMPLETE
// then asserts that all the new event types fire, the foldEvents
// snapshot picks them up, the runner's gitExec stub was called for
// the commit_observed path (idempotence respected), and the loop
// terminates cleanly with terminationReason="complete".

import { foldEvents } from "../src/events.mjs";

test("runRalphTui smoke: full marker stream surfaces stage_plan + task_list + task_start/end + commit_observed + workitem_start/end", async () => {
    const events = [];
    const eventEmitter = {
        runId: "smoke-r-48",
        eventsPath: "/dev/null",
        write: (ev) => events.push(ev),
        close: () => {},
    };
    // Realistic agent stdout: one assistant message that lays out the
    // whole iter as a multi-line content blob (mirrors how a real
    // self-improve iter would narrate one workitem). The stage_plan
    // includes the canonical pinned tail so the runner does NOT
    // amend-in COMMIT/PUSH/END.
    const content = [
        '[WORKITEM_START: {"kind":"issue","ref":48,"title":"3-level hierarchical TUI"}]',
        '[STAGE_PLAN: {"stages":["DIAG","FIX","TEST","COMMIT","PUSH","END"]}]',
        '[TASK_LIST: {"stage":"FIX","items":["wire TasksPane into App","add stageOrdinal helper"]}]',
        '[TASK_START: {"stage":"FIX","sub":1,"desc":"wire TasksPane into App"}]',
        // Substage stream: the agent hits bash to commit. The runner
        // side-channels `tool.execution_complete` to detect a successful
        // git commit and shells out to git for HEAD.
        '[TASK_END: {"stage":"FIX","sub":1,"outcome":"ok","durationMs":4200}]',
        '[WORKITEM_END: {"kind":"issue","ref":48,"closesN":1}]',
        'COMPLETE',
    ].join("\n");
    const stdout = [
        JSON.stringify({ type: "assistant.message", timestamp: "2026-06-01T00:00:00.000Z",
            data: { content } }),
        // tool.execution_complete for `git commit -m "feat(tui): land
        // 3-level renderer"` — runner detects this via looksLikeGitCommit
        // + the success flag and emits a commit_observed event.
        JSON.stringify({ type: "tool.execution_start", timestamp: "2026-06-01T00:00:01.000Z",
            data: { toolCallId: "c-commit", toolName: "bash",
                arguments: { command: 'git commit -m "feat(tui): smoke" --no-verify' } } }),
        JSON.stringify({ type: "tool.execution_complete", timestamp: "2026-06-01T00:00:01.500Z",
            data: { toolCallId: "c-commit", success: true,
                result: { content: "[main abc1234] feat(tui): smoke\n" } } }),
        JSON.stringify({ type: "result", success: true, result: { sessionId: "sess-smoke" } }),
    ].join("\n") + "\n";
    const spawn = makeMockSpawn([{ stdout, exitCode: 0 }]);
    // Stub gitExec so the smoke test doesn't depend on the test's cwd
    // being a real git repo. Returns canned data for the two
    // composing calls readHeadCommit makes. Issue #54 slice 2c —
    // arm-time replay-on-mount calls readHeadCommit once before
    // iter-1 starts, then the iter-1 git commit substage calls it
    // again. The stub uses distinct SHAs so the two emissions are
    // distinguishable in the assertions below.
    let gitCalls = 0;
    let revParseCalls = 0;
    let logCalls = 0;
    const gitExec = ({ args }) => {
        gitCalls++;
        if (args[0] === "rev-parse" && args[1] === "--short") {
            revParseCalls += 1;
            // Arm-time HEAD before any iter has run.
            // Iter-1 commit observation lands on the post-commit HEAD.
            return revParseCalls === 1 ? "0000000\n" : "abc1234\n";
        }
        if (args[0] === "log") {
            logCalls += 1;
            return logCalls === 1
                ? "chore: pre-loop baseline\u0000"
                : "feat(tui): smoke\u0000Co-authored-by: Copilot <c@e>\nCo-authored-by: copilot-ralph <r@e>\n";
        }
        return null;
    };
    const result = await runRalphTui({
        mode: "self-improve",
        contextMode: "fresh",
        max: 1,
        env: makeEnv(),
        spawn,
        eventEmitter,
        gitExec,
    });
    assert.equal(result.terminationReason, "complete");

    // All slice 9 event types must have surfaced exactly once.
    const types = events.map((e) => e.type);
    assert.ok(types.includes("workitem_start"), "workitem_start emitted");
    assert.ok(types.includes("stage_plan"), "stage_plan emitted");
    assert.ok(types.includes("task_list"), "task_list emitted");
    assert.ok(types.includes("task_start"), "task_start emitted");
    assert.ok(types.includes("task_end"), "task_end emitted");
    assert.ok(types.includes("workitem_end"), "workitem_end emitted");
    assert.ok(types.includes("commit_observed"), "commit_observed emitted");

    // Verify the marker payloads round-tripped intact.
    const stagePlan = events.find((e) => e.type === "stage_plan");
    assert.deepEqual(stagePlan.stages, ["DIAG", "FIX", "TEST", "COMMIT", "PUSH", "END"]);
    const taskList = events.find((e) => e.type === "task_list");
    assert.equal(taskList.stage, "FIX");
    assert.deepEqual(taskList.items, ["wire TasksPane into App", "add stageOrdinal helper"]);
    const taskStart = events.find((e) => e.type === "task_start");
    assert.equal(taskStart.sub, 1);
    const taskEnd = events.find((e) => e.type === "task_end");
    assert.equal(taskEnd.outcome, "ok");
    // Two commit_observed events in order: arm-time replay then
    // iter-1 commit substage. Pinning both proves slice 2c is wired
    // and the iter-loop's per-toolCallId path is still idempotent.
    const commitObsList = events.filter((e) => e.type === "commit_observed");
    assert.equal(commitObsList.length, 2, "arm-time replay + iter-1 commit substage");
    assert.equal(commitObsList[0].iteration, 0);
    assert.equal(commitObsList[0].sha, "0000000");
    assert.equal(commitObsList[0].subject, "chore: pre-loop baseline");
    assert.equal(commitObsList[1].iteration, 1);
    assert.equal(commitObsList[1].sha, "abc1234");
    assert.equal(commitObsList[1].subject, "feat(tui): smoke");
    assert.equal(commitObsList[1].trailers.length, 2);

    // foldEvents must build a snapshot the renderer can consume.
    const snap = foldEvents(events);
    // After workitem_end, activeWorkItem clears; the completed item
    // moves into completedWorkItems.
    assert.ok(
        (Array.isArray(snap.completedWorkItems) && snap.completedWorkItems.length > 0) || snap.activeWorkItem,
        "work item recorded in snapshot",
    );
    assert.deepEqual(snap.currentPlan?.stages, ["DIAG", "FIX", "TEST", "COMMIT", "PUSH", "END"]);
    assert.equal(snap.currentTaskList?.stage, "FIX");
    // After both commit_observed emissions, snap.lastCommit reflects
    // the most-recent (iter-1 commit), not the arm-time baseline.
    assert.equal(snap.lastCommit?.sha, "abc1234");
    assert.equal(snap.lastCommit?.subject, "feat(tui): smoke");

    // The runner shelled out to git four times: arm-time
    // (rev-parse + log) + iter-1 commit (rev-parse + log).
    assert.equal(gitCalls, 4, "arm-time + iter-1 each compose rev-parse + log");
});
