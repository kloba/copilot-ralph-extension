// Autopilot loop driver (issue #120, #122; refs #116).
//
// Replaces the legacy 1.2 KLOC ap_loop / self_improve / grow_project
// controller with a thin re-injection driver around the
// `autopilot_scout` deterministic probe (#118) and the
// `autopilot-shipper` custom agent (#119). Each iter the parent agent
// MUST emit exactly one root token of the shape
//
//     [AUTOPILOT_RESULT: { ...JSON... }]
//
// on its own line. The driver parses that token from the assistant
// message stream and, on a `shipped` / `blocked` / `complete` outcome,
// updates state and either re-injects the per-iter prompt for the
// next iter or stops the loop.
//
// State is persisted to ~/.copilot/autopilot/state.json on every
// mutation (atomic temp+rename) so `/autopilot status` from a fresh
// session can still report the previous run's outcome.
//
// Re-injection pattern lifted from the original handler.mjs: drive
// iters via `session.idle` (root-agent agentic-loop completion), not
// per-tool `assistant.turn_end`, so a single root response with N
// tool calls produces exactly one iter rather than N+ duplicates.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    existsSync,
    unlinkSync,
} from "node:fs";

import {
    createScoutTool,
    SCOUT_TOOL_NAME,
} from "./scout-tool.mjs";
import {
    createShipperAgentConfig,
    SHIPPER_AGENT_NAME,
} from "./shipper-agent.mjs";

const moduleRequire = createRequire(import.meta.url);

// Hand-baked extension version. Kept in sync with `package.json#version`
// by the `VERSION matches package.json` test in test/extension.test.mjs.
// install.sh extracts it via awk so the --version flag and the dry-run
// header agree with what the running extension reports.
export const VERSION = "0.7.0";

// Defaults for autopilot_run. Bigger than the legacy ap_loop default of
// 20 because each iter does real work (scout → shipper); 200 mirrors
// the old grow_project budget which is the closest in shape.
const DEFAULTS = Object.freeze({
    max_iters: 200,
    max_tokens: null,
});
const MAX_ALLOWED_ITERS = 1000;
const MAX_FOCUS_CHARS = 2000;

// Block the loop after N consecutive shipper/blocked outcomes — points
// at a systemic problem (gh outage, broken baseline) the loop can't
// fix by repeating itself. 3 matches the old ap_loop stagnation_limit
// default for "we tried, it didn't take".
const BLOCKED_STREAK_LIMIT = 3;

// Block the loop after N consecutive iters where we couldn't parse a
// root token from the assistant message. One missed token may be a
// streaming truncation; two in a row is a contract violation we
// should surface loudly.
const PARSE_FAILURE_LIMIT = 2;

// The per-iter prompt re-injected as a user message. ≤ 1 KB. Tighter
// is better — every iter pays this in input tokens.
export const PER_ITER_PROMPT = `You are the AUTOPILOT loop driver. Per-iter loop:

STEP 1 — call the \`${SCOUT_TOOL_NAME}\` tool. It returns one of:
  { "kind": "no_work" }
  { "kind": "blocked", "reason": "...", "detail": "..." }
  { "kind": "candidate", "ref": "...", "ref_kind": "...",
    "title": "...", "scope_files": [...],
    "acceptance": "...", "evidence": {...} }

STEP 2 — based on the kind:
- "no_work":  emit ONE LINE on its own:
    [AUTOPILOT_RESULT: {"outcome":"complete"}]
  Then stop this iter.
- "blocked":  emit:
    [AUTOPILOT_RESULT: {"outcome":"blocked","reason":"<reason>: <detail>"}]
  Then stop this iter.
- "candidate": delegate to the \`${SHIPPER_AGENT_NAME}\` custom agent
  via the built-in delegation tool. Pass the entire scout JSON as the
  handoff. The shipper emits \`SHIPPED: <sha>\` or \`BLOCKED: <reason>\`
  as ITS terminal output. When delegation returns, parse the shipper's
  last assistant message for that token and echo it as YOUR root token:
    [AUTOPILOT_RESULT: {"outcome":"shipped","sha":"<sha>"}]
    [AUTOPILOT_RESULT: {"outcome":"blocked","reason":"<reason>"}]
  Then stop this iter.

CONSTRAINTS:
- Emit EXACTLY ONE [AUTOPILOT_RESULT: {…}] per iter, on its own line.
- The token must be valid JSON inside the brackets.
- Never ask the user. Never wait for input. Never make commits yourself
  — that is the shipper's job.`;

// Regex pinning the root-token contract. Kept as a non-greedy match
// inside a single line so the parser cannot accidentally swallow a
// later token (or stray brace) on a malformed iter. Exported for
// tests that pin the parser.
export const RESULT_TOKEN_RE =
    /\[AUTOPILOT_RESULT:\s*(\{[^\[\]]*?\})\s*\]/;

// State file. Lives under ~/.copilot/autopilot/ — same parent as the
// legacy events root so install.sh's existing $HOME-touching path
// stays a single tree.
const STATE_DIR = join(homedir(), ".copilot", "autopilot");
const STATE_FILE = join(STATE_DIR, "state.json");

function defaultStatePath() {
    return STATE_FILE;
}

// Atomic temp+rename so a concurrent reader (e.g. another Copilot CLI
// session calling /autopilot status) never sees a half-written file.
// All errors are swallowed: a read-only home (CI cache, sandbox) must
// not crash the loop.
function persistState(snapshot, { stateFile = defaultStatePath() } = {}) {
    try {
        mkdirSync(dirname(stateFile), { recursive: true });
        const tmp = `${stateFile}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
        renameSync(tmp, stateFile);
        return true;
    } catch {
        return false;
    }
}

// Read-on-startup. Tolerant of: missing file, unreadable file, corrupt
// JSON, mismatched shape. Any failure → returns null and the loop
// boots with a clean state.
export function loadPersistedState({ stateFile = defaultStatePath() } = {}) {
    try {
        if (!existsSync(stateFile)) return null;
        const raw = readFileSync(stateFile, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function makeFreshState({ persisted = null } = {}) {
    return {
        armed: false,
        iter: 0,
        max_iters: DEFAULTS.max_iters,
        max_tokens: null,
        focus: null,
        scout_streak_no_work: 0,
        shipper_streak_blocked: 0,
        parse_failure_streak: 0,
        last_iter_outcome: null,
        started_at: null,
        finished_at: null,
        paused: false,
        total_tokens: 0,
        stop_reason: null,
        history: [],
        // Persisted-snapshot reference so a fresh session can report
        // last_run for /autopilot status.
        last_run: persisted?.armed === false && persisted?.stop_reason
            ? {
                started_at: persisted.started_at ?? null,
                finished_at: persisted.finished_at ?? null,
                iter: persisted.iter ?? 0,
                stop_reason: persisted.stop_reason ?? null,
                history: Array.isArray(persisted.history)
                    ? persisted.history.slice(-10)
                    : [],
            }
            : null,
    };
}

// ─────────────────────────────────────────────────────────────────────
// Token parser. Scans assistant message text for the ONE root token,
// JSON-parses it, returns one of:
//   { ok: true, outcome: "complete" }
//   { ok: true, outcome: "shipped", sha: "<sha>" }
//   { ok: true, outcome: "blocked", reason: "<reason>" }
//   { ok: false, error: "<reason>" }
// ─────────────────────────────────────────────────────────────────────
export function parseAutopilotResult(text) {
    if (typeof text !== "string" || text.length === 0) {
        return { ok: false, error: "missing_token" };
    }
    const m = RESULT_TOKEN_RE.exec(text);
    if (!m) return { ok: false, error: "missing_token" };
    let payload;
    try {
        payload = JSON.parse(m[1]);
    } catch (err) {
        return { ok: false, error: `malformed_json: ${err?.message ?? err}` };
    }
    if (!payload || typeof payload !== "object") {
        return { ok: false, error: "non_object_payload" };
    }
    const outcome = payload.outcome;
    if (outcome === "complete") {
        return { ok: true, outcome: "complete" };
    }
    if (outcome === "shipped") {
        const sha = typeof payload.sha === "string" ? payload.sha : null;
        return { ok: true, outcome: "shipped", sha };
    }
    if (outcome === "blocked") {
        const reason = typeof payload.reason === "string" ? payload.reason : "unspecified";
        return { ok: true, outcome: "blocked", reason };
    }
    return { ok: false, error: `unknown_outcome: ${JSON.stringify(outcome)}` };
}

// ─────────────────────────────────────────────────────────────────────
// Validation helpers — kept tight; this surface is much smaller than
// the legacy ap_loop's so we do not need a generic shape-validator.
// ─────────────────────────────────────────────────────────────────────
function failure(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "failure" };
}

function success(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "success" };
}

function describeArgType(args) {
    if (args === null) return "null";
    if (Array.isArray(args)) return "array";
    return typeof args;
}

function validateRunArgs(args) {
    if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
        return { error: `autopilot_run: arguments must be an object (got ${describeArgType(args)}).` };
    }
    const a = args ?? {};
    const allowed = new Set(["max_iters", "max_tokens", "focus"]);
    const unknown = Object.keys(a).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
        return {
            error: `autopilot_run: unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.map((k) => JSON.stringify(k)).join(", ")}. Valid keys: max_iters, max_tokens, focus.`,
        };
    }
    let max_iters = DEFAULTS.max_iters;
    if (a.max_iters !== undefined && a.max_iters !== null) {
        const n = Number(a.max_iters);
        if (!Number.isInteger(n) || n < 1 || n > MAX_ALLOWED_ITERS) {
            return { error: `autopilot_run: max_iters must be an integer in [1, ${MAX_ALLOWED_ITERS}] (got ${JSON.stringify(a.max_iters)}).` };
        }
        max_iters = n;
    }
    let max_tokens = null;
    if (a.max_tokens !== undefined && a.max_tokens !== null) {
        const n = Number(a.max_tokens);
        if (!Number.isInteger(n) || n < 1 || n > 1_000_000_000) {
            return { error: `autopilot_run: max_tokens must be a positive integer ≤ 1e9 (got ${JSON.stringify(a.max_tokens)}).` };
        }
        max_tokens = n;
    }
    let focus = null;
    if (a.focus !== undefined && a.focus !== null) {
        if (typeof a.focus !== "string") {
            return { error: `autopilot_run: focus must be a string (got ${describeArgType(a.focus)}).` };
        }
        const trimmed = a.focus.trim();
        if (trimmed.length > MAX_FOCUS_CHARS) {
            return { error: `autopilot_run: focus exceeds ${MAX_FOCUS_CHARS} characters (got ${trimmed.length}).` };
        }
        focus = trimmed.length > 0 ? trimmed : null;
    }
    return { value: { max_iters, max_tokens, focus } };
}

// Sub-agent events bubble on the same bus and carry an `agentId`.
// Root-only handlers must filter — else a shipper sub-agent's terminal
// SHIPPED token would be parsed by the parent driver too.
function isSubAgentEvent(ev) {
    return ev != null && ev.agentId !== undefined && ev.agentId !== null;
}

// ─────────────────────────────────────────────────────────────────────
// Controller factory.
// ─────────────────────────────────────────────────────────────────────
export function createAutopilotController(opts = {}) {
    const stateFile = opts.stateFile ?? defaultStatePath();
    const scoutFactory = opts.scoutFactory ?? createScoutTool;
    const shipperFactory = opts.shipperFactory ?? createShipperAgentConfig;

    const persisted = loadPersistedState({ stateFile });
    const state = makeFreshState({ persisted });

    let sessionRef = null;

    const log = (msg) => {
        try { sessionRef?.log?.(msg); } catch { /* swallow */ }
    };

    const writeState = () => persistState(state, { stateFile });

    // Build per-iter prompt once. Focus is appended only when set so an
    // unfocused run does not waste tokens on an empty header.
    const buildIterPrompt = () =>
        state.focus
            ? `${PER_ITER_PROMPT}\n\nFocus this run on: ${state.focus}`
            : PER_ITER_PROMPT;

    const reinject = () => {
        if (!sessionRef?.send) {
            log("autopilot: cannot re-inject — session not attached");
            return;
        }
        try {
            const r = sessionRef.send({ prompt: buildIterPrompt() });
            if (r && typeof r.then === "function") {
                r.catch((err) => {
                    log(`autopilot: send rejected: ${err?.message ?? err}`);
                });
            }
        } catch (err) {
            log(`autopilot: send threw: ${err?.message ?? err}`);
        }
    };

    const fireIter = () => {
        state.iter += 1;
        log(`🔁 autopilot iter ${state.iter}/${state.max_iters}`);
        writeState();
        reinject();
    };

    const stopLoop = (reason, detail = null) => {
        if (!state.armed) return;
        state.armed = false;
        state.stop_reason = reason;
        state.finished_at = Date.now();
        if (detail) state.history.push({ iter: state.iter, event: "stop", reason, detail });
        const verb = reason === "complete" ? "✅ completed" : "⏹ stopped";
        log(`${verb} autopilot after ${state.iter} iter${state.iter === 1 ? "" : "s"} (reason: ${reason}${detail ? `, detail: ${detail}` : ""})`);
        // Move active-state into last_run for /autopilot status from a
        // future session — without losing the just-finished history.
        state.last_run = {
            started_at: state.started_at,
            finished_at: state.finished_at,
            iter: state.iter,
            stop_reason: reason,
            history: state.history.slice(-10),
        };
        writeState();
    };

    // Event handler — scans every assistant message for the result
    // token. On a parse hit, mutates state; on parse miss, increments
    // the parse-failure streak. Sub-agent events skipped (their tokens
    // are the shipper's `SHIPPED:` / `BLOCKED:` tokens, not ours).
    const onAssistantMessage = (ev) => {
        if (!state.armed) return;
        if (isSubAgentEvent(ev)) return;
        const text = ev?.data?.content;
        if (typeof text !== "string") return;
        const parsed = parseAutopilotResult(text);
        if (!parsed.ok) {
            // Don't penalise empty / non-token messages — only react
            // when a token attempt was clearly made (text contains
            // the literal `[AUTOPILOT_RESULT:`).
            if (text.includes("[AUTOPILOT_RESULT:")) {
                state.parse_failure_streak += 1;
                state.history.push({ iter: state.iter, event: "parse_failure", error: parsed.error });
                log(`autopilot: parse_failure streak=${state.parse_failure_streak} (${parsed.error})`);
                writeState();
                if (state.parse_failure_streak >= PARSE_FAILURE_LIMIT) {
                    stopLoop("parser_lost_lock", parsed.error);
                }
            }
            return;
        }
        // Valid token — clear parse-failure streak.
        state.parse_failure_streak = 0;
        state.last_iter_outcome = {
            outcome: parsed.outcome,
            sha: parsed.sha ?? null,
            reason: parsed.reason ?? null,
        };
        state.history.push({ iter: state.iter, event: "outcome", ...state.last_iter_outcome });
        if (parsed.outcome === "complete") {
            state.scout_streak_no_work += 1;
            stopLoop("complete");
            return;
        }
        if (parsed.outcome === "shipped") {
            state.shipper_streak_blocked = 0;
            state.scout_streak_no_work = 0;
            log(`autopilot: shipped ${parsed.sha ?? "(no sha)"}`);
            writeState();
            return;
        }
        if (parsed.outcome === "blocked") {
            state.shipper_streak_blocked += 1;
            log(`autopilot: blocked (${parsed.reason}) — streak=${state.shipper_streak_blocked}`);
            writeState();
            if (state.shipper_streak_blocked >= BLOCKED_STREAK_LIMIT) {
                stopLoop("repeated_blocked", parsed.reason);
            }
            return;
        }
    };

    const onIdle = (ev) => {
        if (!state.armed) return;
        if (state.paused) return;
        if (isSubAgentEvent(ev)) return;
        // Stop conditions that win before the next iter is fired.
        if (state.iter >= state.max_iters) {
            stopLoop("max_iters");
            return;
        }
        if (state.max_tokens !== null && state.total_tokens >= state.max_tokens) {
            stopLoop("max_tokens", `${state.total_tokens} ≥ ${state.max_tokens}`);
            return;
        }
        // Already-stopped? (e.g. complete/repeated_blocked fired during
        // onAssistantMessage.) onAssistantMessage clears `armed`; the
        // guard above caught it. So if we got here, fire the next iter.
        fireIter();
    };

    // Aggregate token usage from assistant.message events. Defensive
    // against multiple SDK shapes (matches the legacy handler).
    const onUsage = (ev) => {
        if (!state.armed) return;
        if (isSubAgentEvent(ev)) return;
        const data = ev?.data;
        if (!data || typeof data !== "object") return;
        const usage = data.usage ?? null;
        let input = 0;
        let output = 0;
        if (usage && typeof usage === "object") {
            if (Number.isFinite(usage.input_tokens)) input = usage.input_tokens;
            if (Number.isFinite(usage.output_tokens)) output = usage.output_tokens;
        } else {
            if (Number.isFinite(data.usage_input_tokens)) input = data.usage_input_tokens;
            if (Number.isFinite(data.usage_output_tokens)) output = data.usage_output_tokens;
        }
        if (input < 0 || output < 0) return;
        if (input === 0 && output === 0) return;
        state.total_tokens += input + output;
        // No persist on every usage event — too chatty. Persisted on
        // the next iter boundary or stop.
    };

    // ─────────────────────────────────────────────────────────────────
    // Tools.
    // ─────────────────────────────────────────────────────────────────
    const armLoop = (parsed) => {
        if (state.armed) {
            return failure(`autopilot_run: a loop is already running (iter ${state.iter}/${state.max_iters}). Call autopilot_stop first.`);
        }
        if (!sessionRef) {
            return failure("autopilot_run: session not attached. The extension must be loaded by Copilot CLI before calling this tool.");
        }
        // Reset state for the new run while preserving last_run.
        const last_run = state.last_run;
        Object.assign(state, makeFreshState({ persisted: null }), {
            armed: true,
            max_iters: parsed.max_iters,
            max_tokens: parsed.max_tokens,
            focus: parsed.focus,
            started_at: Date.now(),
            last_run,
        });
        log(`🔁 autopilot armed — max_iters=${state.max_iters}${state.max_tokens ? `, max_tokens=${state.max_tokens}` : ""}${state.focus ? `, focus=${JSON.stringify(state.focus)}` : ""}`);
        writeState();
        // Kick off iter 1 right away — don't wait for the next idle so
        // a user calling `autopilot_run` from a one-shot script gets
        // immediate progress.
        fireIter();
        return success(
            `autopilot armed (max_iters=${state.max_iters}). Iterations will run as conversation turns. Use autopilot_stop to cancel.`,
            {
                armed: true,
                max_iters: state.max_iters,
                max_tokens: state.max_tokens,
                focus: state.focus,
            },
        );
    };

    const buildStatusSnapshot = () => ({
        armed: state.armed,
        iter: state.iter,
        max_iters: state.max_iters,
        max_tokens: state.max_tokens,
        focus: state.focus,
        scout_streak_no_work: state.scout_streak_no_work,
        shipper_streak_blocked: state.shipper_streak_blocked,
        parse_failure_streak: state.parse_failure_streak,
        last_iter_outcome: state.last_iter_outcome,
        started_at: state.started_at,
        finished_at: state.finished_at,
        paused: state.paused,
        total_tokens: state.total_tokens,
        stop_reason: state.stop_reason,
        last_run: state.last_run,
        version: VERSION,
    });

    // ── Deprecation shim helper ─────────────────────────────────────
    const DEPRECATION_NOTE = "⚠️ deprecated: this tool is being removed in 0.8.0. Use autopilot_* instead.";
    const wrapDeprecation = (newToolName, originalResult) => {
        const note = `⚠️ deprecated: this tool is being removed in 0.8.0. Use ${newToolName} instead.`;
        return {
            ...originalResult,
            textResultForLlm: `${note}\n\n${originalResult.textResultForLlm ?? ""}`,
            deprecation_note: note,
        };
    };

    const runHandler = async (args) => {
        const parsed = validateRunArgs(args);
        if (parsed.error) return failure(parsed.error);
        return armLoop(parsed.value);
    };

    const stopHandler = async () => {
        if (!state.armed) {
            return success("autopilot_stop: no loop currently running.", {
                snapshot: buildStatusSnapshot(),
            });
        }
        stopLoop("user_stopped");
        return success(
            `autopilot stopped at iter ${state.iter}.`,
            { snapshot: buildStatusSnapshot() },
        );
    };

    const statusHandler = async () => {
        const snapshot = buildStatusSnapshot();
        const summary = snapshot.armed
            ? `autopilot: iter ${snapshot.iter}/${snapshot.max_iters}${snapshot.paused ? " (PAUSED)" : ""}`
            : snapshot.last_run
                ? `no active loop; last run ${snapshot.last_run.stop_reason} after ${snapshot.last_run.iter} iter${snapshot.last_run.iter === 1 ? "" : "s"}`
                : "no active loop and no prior run.";
        return success(summary, { snapshot });
    };

    const scout = scoutFactory({});

    const tools = [
        {
            name: "autopilot_run",
            description:
                "Arm the autopilot loop. Each iter the parent agent calls autopilot_scout to find the next work item (CI failure > stale PR > human-filed issue), then delegates to the autopilot-shipper custom agent to ship it as one atomic commit. The loop ends when scout returns no_work, the iter cap is hit, or 3 consecutive shipper blocks indicate a systemic problem. Returns immediately after arming — iters run as conversation turns.",
            parameters: {
                type: "object",
                properties: {
                    max_iters: {
                        type: "integer",
                        description: `Maximum iters before stopping (default ${DEFAULTS.max_iters}, max ${MAX_ALLOWED_ITERS}).`,
                        default: DEFAULTS.max_iters,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERS,
                    },
                    max_tokens: {
                        type: "integer",
                        description: "Optional cumulative token cap (input + output). Loop stops when crossed.",
                        minimum: 1,
                    },
                    focus: {
                        type: "string",
                        description: `Optional focus area appended to the per-iter prompt as "Focus this run on: <focus>". Steers the scout/shipper without altering the protocol. Max ${MAX_FOCUS_CHARS} chars.`,
                        minLength: 1,
                        maxLength: MAX_FOCUS_CHARS,
                    },
                },
                additionalProperties: false,
            },
            handler: runHandler,
        },
        {
            name: "autopilot_stop",
            description: "Stop the running autopilot loop. Returns the final state snapshot. No-op when no loop is running.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: stopHandler,
        },
        {
            name: "autopilot_status",
            description: "Return the current autopilot loop state (armed / iter / max_iters / streaks / last outcome). Read-only — never mutates state.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: statusHandler,
        },
        // ── Scout tool — delegates to scout-tool.mjs's factory. ──────
        {
            ...scout.definition,
            handler: scout.handler,
        },
        // ── Deprecation shims (one-release; remove in 0.8.0). ────────
        {
            name: "ap_loop",
            description:
                `${DEPRECATION_NOTE} ap_loop forwards to autopilot_run with the same arguments shape. The legacy ` +
                "completion_promise / abort_promise / stagnation_limit fields are ignored (the new loop uses the " +
                "[AUTOPILOT_RESULT: …] root-token contract instead).",
            parameters: {
                type: "object",
                properties: {
                    max_iters: { type: "integer", minimum: 1, maximum: MAX_ALLOWED_ITERS },
                    max_tokens: { type: "integer", minimum: 1 },
                    focus: { type: "string", minLength: 1, maxLength: MAX_FOCUS_CHARS },
                    // Tolerate legacy fields so an old caller does not
                    // see a "unknown argument" failure on first run.
                    prompt: { type: "string" },
                    max_iterations: { type: "integer", minimum: 1, maximum: MAX_ALLOWED_ITERS },
                    min_iterations: { type: "integer", minimum: 1 },
                    completion_promise: { type: "string" },
                    abort_promise: { type: "string" },
                    stagnation_limit: { type: "integer", minimum: 0 },
                },
                additionalProperties: true,
            },
            handler: async (args) => {
                const a = (args && typeof args === "object" && !Array.isArray(args)) ? args : {};
                const forwarded = {};
                if (a.max_iters !== undefined) forwarded.max_iters = a.max_iters;
                else if (a.max_iterations !== undefined) forwarded.max_iters = a.max_iterations;
                if (a.max_tokens !== undefined) forwarded.max_tokens = a.max_tokens;
                if (a.focus !== undefined) forwarded.focus = a.focus;
                const parsed = validateRunArgs(forwarded);
                if (parsed.error) {
                    return wrapDeprecation("autopilot_run", failure(parsed.error.replace(/^autopilot_run:/, "ap_loop:")));
                }
                return wrapDeprecation("autopilot_run", armLoop(parsed.value));
            },
        },
        {
            name: "ap_status",
            description: `${DEPRECATION_NOTE} ap_status forwards to autopilot_status.`,
            parameters: { type: "object", properties: {}, additionalProperties: true },
            handler: async () => wrapDeprecation("autopilot_status", await statusHandler()),
        },
        {
            name: "ap_stop",
            description: `${DEPRECATION_NOTE} ap_stop forwards to autopilot_stop.`,
            parameters: {
                type: "object",
                properties: { reason: { type: "string" } },
                additionalProperties: true,
            },
            handler: async () => wrapDeprecation("autopilot_stop", await stopHandler()),
        },
        {
            name: "ap_pause",
            description:
                `${DEPRECATION_NOTE} ap_pause is not implemented in 0.7.0 — pause/resume are deferred to v2.`,
            parameters: {
                type: "object",
                properties: { reason: { type: "string" } },
                additionalProperties: true,
            },
            handler: async () => failure(
                "ap_pause: deprecated — pause/resume are deferred to v2. Use autopilot_stop and autopilot_run to pause-and-resume manually for now.",
            ),
        },
        {
            name: "ap_resume",
            description:
                `${DEPRECATION_NOTE} ap_resume is not implemented in 0.7.0 — pause/resume are deferred to v2.`,
            parameters: { type: "object", properties: {}, additionalProperties: true },
            handler: async () => failure(
                "ap_resume: deprecated — pause/resume are deferred to v2. Use autopilot_stop and autopilot_run to pause-and-resume manually for now.",
            ),
        },
    ];

    Object.freeze(tools);

    // ─────────────────────────────────────────────────────────────────
    // Slash command — `/autopilot [run|stop|status]`.
    //
    // CommandHandler returns void per the SDK; we communicate state to
    // the user via session.log() and (for `run`) send() the user a
    // priming prompt. Args dispatch is positional first-token.
    // ─────────────────────────────────────────────────────────────────
    const dispatchCommand = async (ctx) => {
        const raw = (ctx?.args ?? "").trim();
        const sub = raw.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
        if (sub === "" || sub === "run") {
            const result = await runHandler({});
            const text = result.textResultForLlm ?? "autopilot started.";
            try { await sessionRef?.log?.(text); } catch { /* swallow */ }
            return;
        }
        if (sub === "stop") {
            const result = await stopHandler();
            try { await sessionRef?.log?.(result.textResultForLlm ?? "autopilot stopped."); } catch { /* swallow */ }
            return;
        }
        if (sub === "status") {
            const result = await statusHandler();
            try { await sessionRef?.log?.(result.textResultForLlm ?? "no active loop."); } catch { /* swallow */ }
            return;
        }
        try {
            await sessionRef?.log?.(`/autopilot: unknown subcommand ${JSON.stringify(sub)}. Use one of: run, stop, status.`);
        } catch { /* swallow */ }
    };

    const commands = Object.freeze([
        Object.freeze({
            name: "autopilot",
            description:
                "Control the autopilot loop. `/autopilot` or `/autopilot run` arms the loop; `/autopilot stop` stops it; `/autopilot status` shows the current state.",
            handler: dispatchCommand,
        }),
    ]);

    const customAgents = Object.freeze([shipperFactory()]);

    // ─────────────────────────────────────────────────────────────────
    // Hooks.
    // ─────────────────────────────────────────────────────────────────
    const hooks = Object.freeze({
        onUserPromptSubmitted: async () => {
            // If a loop just finished, drop a single bracketed context
            // line into the next user prompt so the agent sees the
            // outcome in the same turn the user spots it. Mirrors the
            // legacy onUserPromptSubmitted shape.
            if (state.armed) return;
            if (!state.last_run || !state.stop_reason) return;
            const ctx = `[autopilot just finished — iter=${state.last_run.iter}, stop_reason=${state.last_run.stop_reason}]`;
            // Clear the stop_reason so the context only fires once.
            const reason = state.stop_reason;
            state.stop_reason = null;
            writeState();
            log(`autopilot: injecting post-loop context (reason=${reason})`);
            return { additionalContext: ctx };
        },
    });

    // ─────────────────────────────────────────────────────────────────
    // attach(session) — wire event handlers + persist sessionRef.
    // Idempotent; returns a detach function.
    // ─────────────────────────────────────────────────────────────────
    let currentDetach = null;

    function attach(session) {
        if (!session || typeof session !== "object") {
            throw new TypeError("autopilot: attach(session) requires a session object.");
        }
        if (typeof session.send !== "function" || typeof session.on !== "function") {
            throw new TypeError("autopilot: attached session must expose send() and on().");
        }
        if (currentDetach) {
            try { currentDetach(); } catch { /* swallow */ }
            currentDetach = null;
        }
        sessionRef = session;
        const unsubs = [];
        const subscribe = (eventName, handler) => {
            const ret = session.on(eventName, handler);
            if (typeof ret === "function") unsubs.push(ret);
        };
        subscribe("assistant.message", onAssistantMessage);
        subscribe("session.idle", onIdle);
        subscribe("assistant.message", onUsage);
        const detach = () => {
            for (const u of unsubs) {
                try { u(); } catch { /* swallow */ }
            }
            if (state.armed && currentDetach === detach) {
                stopLoop("detached");
            }
            if (sessionRef === session) sessionRef = null;
            if (currentDetach === detach) currentDetach = null;
        };
        currentDetach = detach;
        return detach;
    }

    return {
        tools,
        commands,
        customAgents,
        hooks,
        attach,
        state,
        // Exposed for tests so they can drive events deterministically.
        _internal: {
            onAssistantMessage,
            onIdle,
            onUsage,
            stopLoop,
            buildStatusSnapshot,
            persistState: writeState,
        },
    };
}

// Backwards-compat alias for callers that still reach for
// `createRalphController` (test fixtures, package consumers using the
// legacy entry point). Forwards to createAutopilotController so a
// future deletion of this alias is mechanical.
export const createRalphController = createAutopilotController;

export const __test__ = Object.freeze({
    DEFAULTS,
    MAX_ALLOWED_ITERS,
    MAX_FOCUS_CHARS,
    BLOCKED_STREAK_LIMIT,
    PARSE_FAILURE_LIMIT,
    PER_ITER_PROMPT,
    RESULT_TOKEN_RE,
    VERSION,
    parseAutopilotResult,
    persistState,
    loadPersistedState,
    defaultStatePath,
    validateRunArgs,
    moduleRequire,
});
