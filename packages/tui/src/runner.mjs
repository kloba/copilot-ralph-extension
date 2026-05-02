// `ralph-tui run` driver — out-of-session sibling of the in-extension
// ralph_loop / self_improve / grow_project tools.
//
// Why a separate driver? Because the in-extension loop runs as part of
// the user's current Copilot session — so the LLM context grows
// monotonically across iterations. That is the right tradeoff for an
// in-session loop (the user sees every iter inline, and pause/resume
// mid-session lets the user chat with the agent), but it also creates
// a context-rot failure mode where late iterations are dominated by
// early-iteration noise. The `ralph-tui run` driver runs each
// iteration as a fresh `copilot -p ...` subprocess so:
//
//   --continue   resume the same Copilot session every iter (parity
//                with in-extension behavior; context grows)
//   --fresh      brand-new Copilot session every iter (clean context;
//                the iter sees only the prompt + tool results)
//
// Both modes use the SAME baked SDLC prompts (PROMPT_SELF_IMPROVE /
// PROMPT_GROW_PROJECT) imported from `extension/prompts.mjs` so the
// in-session and out-of-session loops can never drift in prompt body.
//
// The driver subprocess runs `copilot -p "..." --allow-all-tools
// --output-format json` and parses JSONL stdout for:
//   - root assistant.message.data.content (no agentId field) — the
//     iter's user-visible response, scanned for the
//     completion_promise / abort_promise tokens.
//   - terminal `result` event with `result.sessionId` — captured at
//     iter 1 and reused via `--resume=<sessionId>` for iter 2+ when
//     the driver is in --continue mode.
//
// Pause/resume/stop are out-of-band: a sibling `ralph-tui run --pause
// <runId>` flips a flag in the run's state.json (CAS-protected via
// lockfile so concurrent pause+stop don't lose updates), and the
// driver re-reads state at each iter boundary. The current child
// copilot subprocess is never killed mid-iter — the driver waits for
// it to finish naturally before honoring pause/stop. This matches the
// in-extension contract ("don't kill in-flight iters").

import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
    PROMPT_SELF_IMPROVE,
    PROMPT_GROW_PROJECT,
    COMPLETION_PROMISE,
    BAKED_ABORT_TOKEN,
    BAKED_BACKLOG_ABORT_TOKEN,
} from "../../../extension/prompts.mjs";

import { createEventEmitter } from "../../../extension/events-emit.mjs";

// Public re-export so the CLI can build the prompt text without
// re-importing extension/prompts.mjs (single import surface for the
// TUI package; downstream tooling that wants the prompt string for
// audit/dump only depends on this module).
export { PROMPT_SELF_IMPROVE, PROMPT_GROW_PROJECT, COMPLETION_PROMISE, BAKED_ABORT_TOKEN, BAKED_BACKLOG_ABORT_TOKEN };

// Cap to mirror the in-extension MAX_FOCUS_CHARS so a focus arg that
// would be rejected by handler.mjs is also rejected here.
export const MAX_FOCUS_CHARS = 2000;

// Cap on the user-supplied --prompt string for ralph_loop-style runs.
// Mirrors the in-extension MAX_PROMPT_CHARS.
export const MAX_PROMPT_CHARS = 65536;

// Default iteration cap when --max is omitted.
export const DEFAULT_MAX_ITERATIONS = 100;
// Hard ceiling — same as in-extension MAX_ALLOWED_ITERATIONS.
export const MAX_ALLOWED_ITERATIONS = 1000;

// Stop polling state.json this many ms between checks while waiting
// for resume after a pause. Long enough to avoid burning CPU in a
// tight loop, short enough that --resume feels responsive.
const PAUSE_POLL_INTERVAL_MS = 500;

// Lockfile retry tuning for state-file CAS. Each write tries
// `mkdir <state>.lock`; if EEXIST, sleep + retry up to MAX_LOCK_RETRIES.
// Total worst-case wait is MAX_LOCK_RETRIES * LOCK_RETRY_INTERVAL_MS.
const LOCK_RETRY_INTERVAL_MS = 25;
const MAX_LOCK_RETRIES = 200; // 5s worst-case

// ─── State-file CAS ────────────────────────────────────────────────

/** Resolve the state-files root, honoring $RALPH_TUI_RUNS_DIR. */
export function resolveStateRoot(env = process.env) {
    const override = env?.RALPH_TUI_RUNS_DIR;
    if (override && typeof override === "string" && override.trim()) {
        return override.trim();
    }
    return join(homedir(), ".copilot", "ralph-tui", "runs");
}

/** Path to a run's state.json. */
export function resolveStatePath(runId, env = process.env) {
    return join(resolveStateRoot(env), runId, "state.json");
}

/** Acquire a directory-based lock for the state file, retrying on EEXIST.
 *  Returns the lock path so the caller can release with releaseLock(). */
function acquireLock(statePath) {
    const lockPath = `${statePath}.lock`;
    for (let i = 0; i < MAX_LOCK_RETRIES; i++) {
        try {
            mkdirSync(lockPath); // EEXIST if held
            return lockPath;
        } catch (err) {
            if (err && err.code !== "EEXIST") throw err;
            // busy-wait synchronously — this is a per-write lock, the
            // critical section is microseconds, contention is rare.
            const start = Date.now();
            while (Date.now() - start < LOCK_RETRY_INTERVAL_MS) { /* spin */ }
        }
    }
    throw new Error(`acquireLock: could not lock ${statePath} after ${MAX_LOCK_RETRIES} retries`);
}

function releaseLock(lockPath) {
    try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* swallow */ }
}

/** Read state.json. Returns null if it doesn't exist. */
export function readState(runId, env = process.env) {
    const statePath = resolveStatePath(runId, env);
    if (!existsSync(statePath)) return null;
    try {
        return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
        return null;
    }
}

/** Read-modify-write state.json under a lock with version CAS.
 *  `mutator(state)` may return a new object (merged) or modify in
 *  place. Returns the new state. Throws TypeError when the run does
 *  not exist (state.json missing). */
export function updateState(runId, mutator, env = process.env) {
    const statePath = resolveStatePath(runId, env);
    if (!existsSync(statePath)) {
        throw new TypeError(`run "${runId}" not found at ${statePath}`);
    }
    const lockPath = acquireLock(statePath);
    try {
        // Re-check under the lock — another writer may have just
        // terminated and rmSync'd the run directory between our
        // existsSync above and acquireLock.
        if (!existsSync(statePath)) {
            throw new TypeError(`run "${runId}" not found at ${statePath}`);
        }
        const current = JSON.parse(readFileSync(statePath, "utf8"));
        const mutated = mutator({ ...current }) ?? current;
        const next = { ...mutated, version: (current.version ?? 0) + 1 };
        const tmp = `${statePath}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
        renameSync(tmp, statePath);
        return next;
    } finally {
        releaseLock(lockPath);
    }
}

/** Initial state-file write; creates the run directory.  */
function initState(runId, initial, env = process.env) {
    const statePath = resolveStatePath(runId, env);
    const dir = join(resolveStateRoot(env), runId);
    mkdirSync(dir, { recursive: true });
    const lockPath = acquireLock(statePath);
    try {
        const seed = { version: 1, ...initial };
        writeFileSync(statePath, JSON.stringify(seed, null, 2) + "\n");
        return seed;
    } finally {
        releaseLock(lockPath);
    }
}

// ─── Sibling commands (operate on state file) ──────────────────────

export function pauseRun(runId, opts = {}) {
    const env = opts.env ?? process.env;
    const next = updateState(runId, (s) => {
        if (s.terminated) return s; // no-op on a finished run
        if (s.paused) return s;     // idempotent
        s.paused = true;
        s.pausedAt = (opts.now ?? Date.now)();
        return s;
    }, env);
    return next;
}

export function resumeRun(runId, opts = {}) {
    const env = opts.env ?? process.env;
    const next = updateState(runId, (s) => {
        if (s.terminated || !s.paused) return s; // no-op
        s.paused = false;
        const pausedFor = Math.max(0, ((opts.now ?? Date.now)()) - (s.pausedAt ?? 0));
        s.totalPausedMs = (s.totalPausedMs ?? 0) + pausedFor;
        delete s.pausedAt;
        return s;
    }, env);
    return next;
}

export function stopRun(runId, opts = {}) {
    const env = opts.env ?? process.env;
    const next = updateState(runId, (s) => {
        if (s.terminated) return s;
        s.stopRequested = true;
        s.stopReason = opts.reason ?? "user_stop";
        return s;
    }, env);
    return next;
}

export function statusRun(runId, opts = {}) {
    const s = readState(runId, opts.env ?? process.env);
    if (!s) {
        const e = new TypeError(`run "${runId}" not found`);
        throw e;
    }
    return s;
}

// ─── Argument validation ────────────────────────────────────────────

/** Validate + normalise a focus string. Returns {value} or {error}. */
export function validateFocus(focus) {
    if (focus === undefined || focus === null) return { value: undefined };
    if (typeof focus !== "string") return { error: "--focus must be a string" };
    const trimmed = focus.trim();
    if (!trimmed) return { error: "--focus must not be empty" };
    if (trimmed.length > MAX_FOCUS_CHARS) {
        return { error: `--focus exceeds ${MAX_FOCUS_CHARS} characters (got ${trimmed.length})` };
    }
    return { value: trimmed };
}

/** Compose the per-iter prompt body. For --self-improve /
 *  --grow-project, this is the baked SDLC prompt with optional
 *  `Focus this run on: <focus>` suffix. For --prompt mode, it's the
 *  user's prompt verbatim. */
export function composePrompt({ mode, prompt, focus }) {
    let base;
    if (mode === "self-improve") base = PROMPT_SELF_IMPROVE;
    else if (mode === "grow-project") base = PROMPT_GROW_PROJECT;
    else if (mode === "prompt") base = prompt;
    else throw new TypeError(`composePrompt: unknown mode "${mode}"`);
    if (focus) return `${base}\n\nFocus this run on: ${focus}`;
    return base;
}

/** Mode → label used by the event emitter and the run directory name. */
function labelForMode(mode) {
    if (mode === "self-improve") return "ralph-tui-self-improve";
    if (mode === "grow-project") return "ralph-tui-grow-project";
    if (mode === "prompt") return "ralph-tui-prompt";
    throw new TypeError(`labelForMode: unknown mode "${mode}"`);
}

/** Default abort token per mode. */
function defaultAbortPromise(mode) {
    if (mode === "self-improve") return BAKED_ABORT_TOKEN;
    if (mode === "grow-project") return BAKED_BACKLOG_ABORT_TOKEN;
    return undefined; // --prompt mode has no default abort
}

// ─── JSONL stream parser ───────────────────────────────────────────

/** Parse a single JSONL line. Returns null on parse error. */
function parseJsonLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch { return null; }
}

/** From the stream of parsed events emitted by `copilot -p
 *  --output-format json`, extract:
 *    - `assistantContent`: concatenation of root-agent
 *      `assistant.message.data.content` chunks (skipping events that
 *      carry an `agentId`, which are sub-agent turns).
 *    - `sessionId`: from the terminal `result` event's
 *      `result.sessionId`. May be null if the run did not produce one.
 *    - `exitOk`: whether the terminal `result` event indicated success.
 *  This module is a pure data extractor — the runner glues it to
 *  child stdout. Exported so the test suite can exercise it
 *  independently of subprocess plumbing. */
export function reduceCopilotEvents(events) {
    let assistantContent = "";
    let sessionId = null;
    let exitOk = null;
    for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "assistant.message" && ev.data && typeof ev.data.content === "string") {
            // Root-agent turns have no `agentId` field. Sub-agent turns
            // (e.g. an explore agent) carry one. Only the root content
            // is what the user sees and what the prompt instructs the
            // agent to emit COMPLETE / ABORT_* in.
            if (!ev.agentId) assistantContent += ev.data.content;
        }
        if (ev.type === "result") {
            if (ev.result && typeof ev.result.sessionId === "string") sessionId = ev.result.sessionId;
            if (typeof ev.success === "boolean") exitOk = ev.success;
        }
    }
    return { assistantContent, sessionId, exitOk };
}

// ─── Single-iter subprocess driver ─────────────────────────────────

/** Spawn `copilot -p ...` and collect the JSONL stream. Resolves with
 *  { events, stderr, exitCode } once the child exits.
 *
 *  Tests inject `spawn` (a child_process.spawn-shaped function) +
 *  `copilotBin` to substitute a shim binary that emits scripted
 *  JSONL.
 */
export function runOneIteration({
    prompt,
    resumeSessionId,
    sessionName,
    spawn = nodeSpawn,
    copilotBin,
    cwd,
    env = process.env,
    extraArgs = [],
    onLine, // optional callback per parsed event (for live feedback)
}) {
    const bin = copilotBin ?? env.RALPH_TUI_COPILOT_BIN ?? "copilot";
    const args = ["-p", prompt, "--allow-all-tools", "--output-format", "json"];
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    else if (sessionName) args.push("-n", sessionName);
    for (const a of extraArgs) args.push(a);

    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(bin, args, {
                stdio: ["ignore", "pipe", "pipe"],
                cwd,
                env,
            });
        } catch (err) {
            reject(err);
            return;
        }

        const events = [];
        let stdoutBuf = "";
        let stderrBuf = "";
        let killed = false;

        const onStdout = (chunk) => {
            stdoutBuf += chunk.toString("utf8");
            let nl;
            while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
                const line = stdoutBuf.slice(0, nl);
                stdoutBuf = stdoutBuf.slice(nl + 1);
                const ev = parseJsonLine(line);
                if (ev) {
                    events.push(ev);
                    if (onLine) { try { onLine(ev); } catch { /* swallow */ } }
                }
            }
        };
        const onStderr = (chunk) => { stderrBuf += chunk.toString("utf8"); };

        child.stdout?.on("data", onStdout);
        child.stderr?.on("data", onStderr);

        child.on("error", (err) => { reject(err); });
        child.on("close", (code) => {
            // Drain trailing partial line.
            if (stdoutBuf.trim()) {
                const ev = parseJsonLine(stdoutBuf);
                if (ev) events.push(ev);
            }
            resolve({ events, stderr: stderrBuf, exitCode: code, killed });
        });

        // Expose the child handle to the caller for SIGINT plumbing
        // via the resolve hook; runRalphTui registers a stop-watcher
        // before awaiting.
        if (typeof onLine === "function" && onLine.__captureChild) {
            onLine.__captureChild(child, () => { killed = true; });
        }
    });
}

// ─── Multi-iter loop ────────────────────────────────────────────────

/**
 * Run the full multi-iter loop. Returns when the loop terminates via
 * completion_promise, abort_promise, max_iterations, stopRequested,
 * or unrecoverable subprocess error.
 *
 * Required:
 *   mode           "self-improve" | "grow-project" | "prompt"
 *   contextMode    "continue" | "fresh"
 *
 * Optional:
 *   prompt              Required when mode === "prompt".
 *   focus               Optional suffix; capped at MAX_FOCUS_CHARS.
 *   max                 Default DEFAULT_MAX_ITERATIONS.
 *   completionPromise   Default COMPLETION_PROMISE ("COMPLETE").
 *   abortPromise        Default = abort token of the chosen mode.
 *   spawn               Inject for tests.
 *   copilotBin          Inject for tests. Falls back to
 *                       $RALPH_TUI_COPILOT_BIN, then "copilot".
 *   env, fs, now        Inject for tests.
 *   eventEmitter        Inject for tests; otherwise createEventEmitter
 *                       is invoked.
 *   onRunId             Callback invoked once with the runId, fired
 *                       BEFORE iter 1 starts. The signal-handler
 *                       plumbing in the CLI uses this to resolve the
 *                       run before the loop body starts so a SIGINT
 *                       in iter 1 still finds the state file.
 *   onIteration         Callback fired between iters with state.
 *   stdout, stderr      Stream sinks for human-readable output.
 */
export async function runRalphTui(opts) {
    const {
        mode,
        contextMode,
        prompt,
        focus,
        max = DEFAULT_MAX_ITERATIONS,
        completionPromise = COMPLETION_PROMISE,
        abortPromise = defaultAbortPromise(mode),
        spawn = nodeSpawn,
        copilotBin,
        env = process.env,
        now = () => Date.now(),
        cwd = process.cwd(),
        eventEmitter,
        onRunId,
        onIteration,
        stdout = process.stdout,
        stderr = process.stderr,
    } = opts;

    if (mode !== "self-improve" && mode !== "grow-project" && mode !== "prompt") {
        throw new TypeError(`runRalphTui: invalid mode "${mode}"`);
    }
    if (contextMode !== "continue" && contextMode !== "fresh") {
        throw new TypeError(`runRalphTui: contextMode must be "continue" or "fresh"`);
    }
    if (mode === "prompt" && (!prompt || typeof prompt !== "string")) {
        throw new TypeError(`runRalphTui: --prompt requires a non-empty string when mode === "prompt"`);
    }
    if (mode === "prompt" && prompt.length > MAX_PROMPT_CHARS) {
        throw new TypeError(`runRalphTui: prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    if (!Number.isInteger(max) || max < 1 || max > MAX_ALLOWED_ITERATIONS) {
        throw new TypeError(`runRalphTui: max must be an integer in [1, ${MAX_ALLOWED_ITERATIONS}], got ${max}`);
    }
    const focusCheck = validateFocus(focus);
    if (focusCheck.error) throw new TypeError(`runRalphTui: ${focusCheck.error}`);

    const startedAt = now();
    const label = labelForMode(mode);
    const emitter = eventEmitter ?? createEventEmitter({ label, startedAt, env });
    const runId = emitter.runId;
    const sessionName = `${runId}`;
    const composedPrompt = composePrompt({ mode, prompt, focus: focusCheck.value });

    // Initial state-file. terminationReason starts as null; the loop
    // sets it on exit. sessionId is captured after iter 1 in
    // --continue mode.
    initState(runId, {
        runId,
        mode,
        contextMode,
        startedAt,
        max,
        iter: 0,
        paused: false,
        stopRequested: false,
        terminated: false,
        terminationReason: null,
        sessionId: null,
        totalPausedMs: 0,
    }, env);

    // Emit the canonical `armed` event so `ralph-tui list/stats`
    // pick up this run.
    emitter.write({
        type: "armed",
        ts: now(),
        runId,
        label,
        startedAt,
        maxIterations: max,
        minIterations: 1,
        contextMode,
        mode,
    });

    if (onRunId) {
        try { onRunId(runId); } catch { /* swallow */ }
    }

    let terminationReason = null;
    let terminationNote = null;
    let lastAssistantContent = "";
    let stopRequested = false;
    let capturedSessionId = null;

    for (let iter = 1; iter <= max; iter++) {
        // Honor pause/stop via state file.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const s = readState(runId, env);
            if (!s) break;
            if (s.stopRequested) {
                stopRequested = true;
                terminationReason = "stopped";
                terminationNote = s.stopReason ?? "user_stop";
                break;
            }
            if (!s.paused) break;
            await delay(PAUSE_POLL_INTERVAL_MS);
        }
        if (stopRequested) break;

        emitter.write({
            type: "iteration_start",
            ts: now(),
            runId,
            label,
            iteration: iter,
        });
        stdout.write?.(`# iter ${iter}/${max}\n`);

        // Decide whether to resume an existing session or start a
        // fresh one. --continue captures sessionId at iter 1 then
        // resumes it; --fresh always starts fresh.
        const resumeSessionId = (contextMode === "continue" && iter > 1) ? capturedSessionId : null;
        const sessionNameForIter = (contextMode === "continue" && iter === 1) ? sessionName : null;

        let result;
        try {
            result = await runOneIteration({
                prompt: composedPrompt,
                resumeSessionId,
                sessionName: sessionNameForIter,
                spawn,
                copilotBin,
                cwd,
                env,
            });
        } catch (err) {
            terminationReason = "error";
            terminationNote = err?.message ?? String(err);
            stderr.write?.(`ralph-tui run: subprocess error: ${terminationNote}\n`);
            emitter.write({
                type: "iteration_end",
                ts: now(),
                runId,
                label,
                iteration: iter,
                excerpt: "",
                note: terminationNote,
            });
            break;
        }

        const reduced = reduceCopilotEvents(result.events);
        lastAssistantContent = reduced.assistantContent;
        if (contextMode === "continue" && iter === 1 && reduced.sessionId) {
            capturedSessionId = reduced.sessionId;
            updateState(runId, (s) => { s.sessionId = capturedSessionId; return s; }, env);
        }

        const excerpt = lastAssistantContent.slice(0, 500);
        emitter.write({
            type: "iteration_end",
            ts: now(),
            runId,
            label,
            iteration: iter,
            excerpt,
        });
        updateState(runId, (s) => { s.iter = iter; return s; }, env);
        if (onIteration) {
            try { onIteration({ iter, excerpt, sessionId: capturedSessionId, exitCode: result.exitCode }); }
            catch { /* swallow */ }
        }

        if (result.exitCode !== 0) {
            terminationReason = "subprocess_failed";
            terminationNote = `copilot exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`;
            stderr.write?.(`ralph-tui run: ${terminationNote}\n`);
            break;
        }

        // Promise detection runs AFTER iteration_end so the run
        // history shows the iter that emitted COMPLETE / ABORT_*.
        if (completionPromise && lastAssistantContent.includes(completionPromise)) {
            terminationReason = "complete";
            break;
        }
        if (abortPromise && lastAssistantContent.includes(abortPromise)) {
            terminationReason = "abort";
            terminationNote = `agent emitted ${abortPromise}`;
            break;
        }
    }

    if (!terminationReason) {
        terminationReason = "max_iterations";
        terminationNote = `reached max=${max}`;
    }

    updateState(runId, (s) => {
        s.terminated = true;
        s.terminationReason = terminationReason;
        if (terminationNote) s.terminationNote = terminationNote;
        return s;
    }, env);

    const terminalType = terminationReason === "complete" ? "complete" : "abort";
    emitter.write({
        type: terminalType,
        ts: now(),
        runId,
        label,
        reason: terminationReason,
        note: terminationNote ?? undefined,
    });

    return { runId, terminationReason, terminationNote, iterations: lastAssistantContent ? undefined : 0, sessionId: capturedSessionId };
}
