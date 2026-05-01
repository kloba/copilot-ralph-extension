// Hook/event-driven Ralph Wiggum controller for Copilot CLI.
//
// Architecture: the ralph_loop tool returns immediately after arming the loop.
// Iterations are driven by listening to `session.idle` events (the root
// agent's "agentic loop fully done" signal) and re-injecting the prompt via
// `session.send` (fire-and-forget). Using `session.idle` rather than
// `assistant.turn_end` is critical: the SDK emits a turn_end per agentic-loop
// sub-turn (one per tool-call boundary), so a single root response with N
// tool calls produces N+ turn_ends. Only `session.idle` fires exactly once
// per root response. This avoids
// the deadlock that the older `sendAndWait`-based design hit when invoked
// in-session, while still keeping full conversation context — every
// iteration is a real assistant turn the user sees.
//
// Inspired by the Stop-hook re-injection pattern.

const DEFAULTS = Object.freeze({
    max_iterations: 20,
    min_iterations: 1,
    completion_promise: "COMPLETE",
    stagnation_limit: 3,
});
const MAX_ALLOWED_ITERATIONS = 1000;
const PREVIEW_CHARS = 500;
const MAX_PROMPT_CHARS = 65536;
// Cap completion_promise / abort_promise length. These are short signals
// (default "COMPLETE") that we substring-match against every assistant
// turn's accumulated content; allowing megabyte-long signals would waste
// memory in state.active and slow each `.includes()` check unnecessarily.
const MAX_PROMISE_CHARS = 200;
// Cap the per-iteration accumulated assistant content. We only need it for
// substring matching (completion/abort/stagnation) and a 500-char preview;
// extremely chatty turns shouldn't be allowed to consume unbounded memory.
const MAX_CONTENT_CHARS = 1_048_576; // 1 MiB

// Find a slice length ≤ `cut` that doesn't split a UTF-16 surrogate
// pair (4-byte chars like emoji). Used by both previewOf and truncateNote
// so a string ending mid-emoji never produces an invalid lone surrogate.
function safeSliceEnd(s, cut) {
    const code = s.charCodeAt(cut - 1);
    return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
}

// Mirror of safeSliceEnd for the START side: if the kept slice would begin
// on a lone low surrogate (0xdc00..0xdfff) — its high surrogate was just
// dropped by the head-trim — bump the start forward by 1 so we never
// produce an invalid UTF-16 string. Matters for the 1 MiB rolling buffer
// in onAssistantMessage where slicing from the head can otherwise leave
// a torn pair at position 0 that prints as a replacement char and reads
// like garbage to anything inspecting state.lastAssistantContent.
function safeSliceStart(s, start) {
    const code = s.charCodeAt(start);
    return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
}

function previewOf(text) {
    if (!text) return "";
    if (text.length <= PREVIEW_CHARS) return text;
    return text.slice(0, safeSliceEnd(text, PREVIEW_CHARS)) + "…";
}

// Truncate `note` to PREVIEW_CHARS without splitting a surrogate pair —
// same risk as previewOf since notes can carry user-supplied or error
// strings containing emoji or other 4-byte chars.
function truncateNote(text) {
    const s = String(text);
    if (s.length <= PREVIEW_CHARS) return s;
    return s.slice(0, safeSliceEnd(s, PREVIEW_CHARS));
}
// Collapse whitespace (newlines, tabs, runs of spaces) into single spaces and
// trim. Used to flatten a multi-line note (e.g. an Error stack) into the
// single-line log marker and additionalContext bracket.
function collapseNote(text) {
    return text ? String(text).replace(/\s+/g, " ").trim() : "";
}
// Bound an arbitrary user/SDK-supplied string for embedding in a single-line
// log message: cap length at PREVIEW_CHARS (surrogate-safely) and flatten
// whitespace. Used by every log site that interpolates an external value
// (abort reason, send-error message) so the timeline can't be flooded by a
// pathological payload.
function boundedNoteForLog(text) {
    return collapseNote(truncateNote(text));
}
function failure(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "failure" };
}
function success(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "success" };
}

// Per the SDK schema, every session event carries an optional `agentId`
// field that is *absent* on root-agent events and *present* (a string)
// on sub-agent events (task / explore / code-review / rubber-duck …).
// Sub-agent events bubble up the session bus alongside root-agent
// events, so any handler that should only fire for the root must filter
// them out — otherwise sub-agents trigger spurious refires (turn_end /
// message) or kill the root loop (abort).
function isSubAgentEvent(ev) {
    return ev != null && ev.agentId !== undefined && ev.agentId !== null;
}

/**
 * @typedef {Object} RalphArgs
 * @property {string} prompt - Required. The prompt re-injected each iteration. ≤ 64KiB.
 * @property {number} [max_iterations=20] - Hard cap on iterations (1..1000).
 * @property {number} [min_iterations=1] - Floor before completion/abort phrases honored (1..max_iterations).
 * @property {string} [completion_promise="COMPLETE"] - Substring → finish with reason "completion_promise".
 * @property {string} [abort_promise] - Optional substring → finish with reason "abort_promise". Must differ from completion_promise.
 * @property {number} [stagnation_limit=3] - Abort after N consecutive byte-identical responses (0 disables).
 */

/**
 * @typedef {Object} RalphResult
 * @property {string} reason - One of: completion_promise, abort_promise, stagnation, max_iterations, send_error, aborted, user_stopped, detached.
 * @property {number} iterations - Number of iterations completed (post-fire count).
 * @property {string} preview - Up to PREVIEW_CHARS (500) chars of the LAST iteration's accumulated assistant content. If the content was longer, an ellipsis ("…") is appended (so the truncated form is 501 chars). If finish runs before any iteration produced output (e.g. send_error before iter 1, or ralph_stop right after arm), this is the empty string. Surrogate-safe — never ends on a lone high surrogate.
 * @property {number} startedAt - Epoch ms when the loop was armed.
 * @property {number} finishedAt - Epoch ms when the loop finished.
 * @property {number} durationMs - Elapsed wall-clock ms from arming to finish, clamped to ≥ 0 (a backward clock jump mid-loop reports 0 instead of a negative).
 * @property {string} [note] - Optional human-readable context: caller-supplied via ralph_stop({reason}), or the underlying error message on send_error, or the SDK abort reason on aborted. Truncated silently to 500 chars (surrogate-safe) — no "…" indicator is appended (unlike `preview`). Notes are flowed inline into single-line log markers and the post-loop additionalContext bracket, where a trailing "…" would be misread as part of the message.
 */

// Shared helper: every tool handler that accepts an args object should
// (a) reject malformed shapes (null/array/primitive) and (b) reject
// unknown keys — so a typo like `resaon` or `max_iter` surfaces loudly
// instead of being silently dropped. Returning a string means "no error",
// otherwise returns `{ error: <message> }`. Centralising this logic keeps
// ralph_loop and ralph_stop's validation in lockstep.
function describeArgType(args) {
    if (args === null) return "null";
    if (Array.isArray(args)) return "array";
    return typeof args;
}

// Render a raw arg value for human-readable error messages. Quotes string
// inputs so an empty/whitespace-only value displays as `""` instead of an
// invisible blank, and stringifies NaN/Infinity as themselves rather than
// JSON.stringify's "null".
function displayValue(v) {
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
}

function validateArgShape(toolName, args, knownKeys) {
    if (args === null || args === undefined || typeof args !== "object" || Array.isArray(args)) {
        return { error: `${toolName}: arguments must be an object (got ${describeArgType(args)}).` };
    }
    const unknown = Object.keys(args).filter((k) => !knownKeys.has(k));
    if (unknown.length > 0) {
        return {
            error: `${toolName}: unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.map((k) => JSON.stringify(k)).join(", ")}. Valid keys: ${[...knownKeys].join(", ")}.`,
        };
    }
    return null;
}

const RALPH_LOOP_KEYS = new Set([
    "prompt",
    "max_iterations",
    "min_iterations",
    "completion_promise",
    "abort_promise",
    "stagnation_limit",
]);
const RALPH_STOP_KEYS = new Set(["reason"]);

/**
 * Validate ralph_loop arguments.
 *
 * @param {RalphArgs} args
 * @returns {{value: object} | {error: string}} Validated values or a single human-readable error.
 */
export function validateArgs(args) {
    const shape = validateArgShape("ralph_loop", args, RALPH_LOOP_KEYS);
    if (shape) return shape;
    if (args.prompt !== undefined && args.prompt !== null && typeof args.prompt !== "string") {
        return { error: `ralph_loop: prompt must be a string (got ${describeArgType(args.prompt)}).` };
    }
    const prompt = (args.prompt ?? "").trim();
    if (!prompt) {
        // Distinguish "you forgot to pass a prompt" from "you passed a
        // string but it's only whitespace" — the second case is usually
        // a templating bug (variable interpolated to empty), and saying
        // so loudly helps the agent fix the right layer.
        if (args.prompt === undefined || args.prompt === null || args.prompt === "") {
            return { error: "ralph_loop: prompt is required and must be non-empty." };
        }
        return { error: "ralph_loop: prompt must contain at least one non-whitespace character (got a whitespace-only string)." };
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
        return {
            error: `ralph_loop: prompt exceeds ${MAX_PROMPT_CHARS} characters (got ${prompt.length}). Shorten the prompt or split the work.`,
        };
    }

    const rawMax = args.max_iterations ?? DEFAULTS.max_iterations;
    if (typeof rawMax !== "number" && typeof rawMax !== "string") {
        return { error: `ralph_loop: max_iterations must be a number (got ${describeArgType(rawMax)}).` };
    }
    const max = Number(rawMax);
    if (!Number.isInteger(max) || max < 1 || max > MAX_ALLOWED_ITERATIONS) {
        return {
            error: `ralph_loop: max_iterations must be an integer in [1, ${MAX_ALLOWED_ITERATIONS}] (got ${displayValue(rawMax)}).`,
        };
    }

    const rawMin = args.min_iterations ?? DEFAULTS.min_iterations;
    if (typeof rawMin !== "number" && typeof rawMin !== "string") {
        return { error: `ralph_loop: min_iterations must be a number (got ${describeArgType(rawMin)}).` };
    }
    const min = Number(rawMin);
    if (!Number.isInteger(min) || min < 1 || min > max) {
        return {
            error: `ralph_loop: min_iterations must be an integer in [1, max_iterations=${max}] (got ${displayValue(rawMin)}).`,
        };
    }

    let completionPromise = DEFAULTS.completion_promise;
    if (args.completion_promise !== undefined && args.completion_promise !== null) {
        if (typeof args.completion_promise !== "string") {
            return { error: `ralph_loop: completion_promise must be a string (got ${describeArgType(args.completion_promise)}).` };
        }
        if (args.completion_promise.trim().length === 0) {
            return { error: "ralph_loop: completion_promise must contain at least one non-whitespace character." };
        }
        if (args.completion_promise.length > MAX_PROMISE_CHARS) {
            return { error: `ralph_loop: completion_promise exceeds ${MAX_PROMISE_CHARS} characters (got ${args.completion_promise.length}). Use a short signal phrase.` };
        }
        // Trim padding so a copy-paste artifact like `"  COMPLETE\n"` still
        // matches a clean `COMPLETE` in the assistant's reply. Without this
        // the substring check requires exact surrounding whitespace and the
        // loop silently never terminates.
        completionPromise = args.completion_promise.trim();
    }

    let abortPromise = null;
    if (args.abort_promise !== undefined && args.abort_promise !== null) {
        if (typeof args.abort_promise !== "string") {
            return { error: `ralph_loop: abort_promise must be a string (got ${describeArgType(args.abort_promise)}).` };
        }
        if (args.abort_promise.trim().length === 0) {
            return { error: "ralph_loop: abort_promise, when provided, must contain at least one non-whitespace character." };
        }
        if (args.abort_promise.length > MAX_PROMISE_CHARS) {
            return { error: `ralph_loop: abort_promise exceeds ${MAX_PROMISE_CHARS} characters (got ${args.abort_promise.length}). Use a short signal phrase.` };
        }
        abortPromise = args.abort_promise.trim();
    }

    if (abortPromise !== null && abortPromise === completionPromise) {
        return {
            error: "ralph_loop: abort_promise must differ from completion_promise (otherwise the signal is ambiguous).",
        };
    }
    if (abortPromise !== null && (abortPromise.includes(completionPromise) || completionPromise.includes(abortPromise))) {
        return {
            error: `ralph_loop: completion_promise (${JSON.stringify(completionPromise)}) and abort_promise (${JSON.stringify(abortPromise)}) overlap as substrings — whichever check runs first will always fire. Pick disjoint phrases.`,
        };
    }

    const rawStagnation = args.stagnation_limit ?? DEFAULTS.stagnation_limit;
    if (typeof rawStagnation !== "number" && typeof rawStagnation !== "string") {
        return { error: `ralph_loop: stagnation_limit must be a number (got ${describeArgType(rawStagnation)}).` };
    }
    const stagnationLimit = Number(rawStagnation);
    if (!Number.isInteger(stagnationLimit) || stagnationLimit < 0 || stagnationLimit === 1) {
        return {
            error: `ralph_loop: stagnation_limit must be 0 (disabled) or an integer ≥ 2 (got ${displayValue(rawStagnation)}). 1 is meaningless because no comparison is possible after a single response.`,
        };
    }

    return { value: { prompt, max, min, completionPromise, abortPromise, stagnationLimit } };
}

/**
 * Build a Ralph controller.
 *
 * Use `tools` and `hooks` directly in `joinSession({ tools, hooks })`.
 * Then call `attach(session)` once with the resolved session to wire up
 * event listeners and bind the session reference used by tool handlers.
 *
 * @returns {{
 *   tools: Array<object>,
 *   hooks: { onUserPromptSubmitted: Function },
 *   attach: (session: object) => () => void,
 *   state: { active: object|null, lastAssistantContent: string, lastResult: RalphResult|null },
 *   _internal: { onAssistantMessage: Function, onIdle: Function, onAbort: Function, finish: Function, success: Function, failure: Function }
 * }} Controller. `attach` returns an unsubscribe function that detaches all listeners and finalizes any active loop with reason='detached'.
 */
export function createRalphController() {
    const state = {
        active: null,           // see arming below for shape
        lastAssistantContent: "",
        // Shape: see the RalphResult typedef. Frozen on assignment.
        lastResult: null,
    };
    let sessionRef = null;

    // Clamp `Date.now() - start` to ≥ 0 so a backward clock jump (NTP
    // correction mid-loop) never surfaces a negative elapsed time in
    // logs or in result.durationMs. Same defense in two places — keep
    // them in lockstep via a single helper so future tweaks don't drift.
    const clampedElapsed = (start) => Math.max(0, Date.now() - start);

    const log = (msg) => {
        try { sessionRef?.log?.(msg); } catch { /* swallow */ }
    };
    const logIterStart = (a) => {
        log(`🔁 ralph_loop iter ${a.i}/${a.max} (elapsed ${clampedElapsed(a.startedAt)}ms)`);
    };
    const sendPrompt = (prompt) => {
        if (!sessionRef?.send) throw new Error("session not attached");
        return sessionRef.send({ prompt });
    };

    // Fire iteration prompt; handle both sync throws and async rejections.
    // Captures the active-loop identity at fire-time so a late rejection from
    // a previous arming can't poison a freshly-armed loop.
    //
    // Queue-bloat protection: refuse to fire if a previously-fired prompt
    // hasn't been picked up by the agent yet (no assistant.message
    // observed since the last fire). Without this, the SDK can emit
    // multiple turn_ends back-to-back (sub-turn boundaries, tool-call
    // events, etc.) and each one would queue another copy of the same
    // prompt — visible to the user as `Queued (3)` of identical messages.
    const tryFire = (prompt) => {
        const armedFor = state.active;
        if (!armedFor) return;
        if (armedFor.fireInFlight) {
            log(`ralph_loop: skipping refire — previous prompt still queued (no assistant.message observed yet)`);
            return;
        }
        armedFor.fireInFlight = true;
        armedFor.observedMessageThisFire = false;
        // Bound logged err.message so a pathologically large error payload
        // (giant JSON, multi-line stack) doesn't dump megabytes into the
        // timeline. result.note is already truncated by finish(); mirror
        // the same cap on the pre-finish log line via boundedNoteForLog.
        const formatErrForLog = (err) => boundedNoteForLog(err?.message ?? String(err));
        try {
            const r = sendPrompt(prompt);
            if (r && typeof r.then === "function") {
                r.then(undefined, (err) => {
                    if (state.active !== armedFor) return;
                    armedFor.fireInFlight = false;
                    const msg = err?.message ?? String(err);
                    log(`ralph_loop: send rejected: ${formatErrForLog(err)}`);
                    finish("send_error", `send rejected: ${msg}`);
                });
            }
        } catch (err) {
            if (state.active !== armedFor) return;
            armedFor.fireInFlight = false;
            const msg = err?.message ?? String(err);
            log(`ralph_loop: send failed: ${formatErrForLog(err)}`);
            finish("send_error", `send failed: ${msg}`);
        }
    };

    const finish = (reason, note) => {
        if (!state.active) return;
        // state.active.startedAt is always set at arming time (see the
        // `state.active = { ...startedAt: Date.now() }` block in the
        // ralph_loop handler), so the `??` fallback is dead — but clamp
        // durationMs to ≥ 0 in case the system clock jumps backward
        // mid-loop (NTP correction) and finishedAt < startedAt.
        const startedAt = state.active.startedAt;
        const finishedAt = Date.now();
        const result = {
            reason,
            iterations: state.active.i,
            preview: previewOf(state.lastAssistantContent),
            startedAt,
            finishedAt,
            durationMs: clampedElapsed(startedAt),
        };
        if (note) result.note = truncateNote(note);
        // Differentiate the log marker by category so an error finish doesn't
        // visually read like a clean cancellation:
        //   ✅ completed  — completion_promise
        //   ⚠️  ended    — send_error, aborted (something went wrong)
        //   ⏹ stopped    — everything else (max_iter, abort_promise, stagnation, user_stopped, detached)
        const verb =
            reason === "completion_promise" ? "✅ completed" :
            reason === "send_error" || reason === "aborted" ? "⚠️ ended" :
            "⏹ stopped";
        // Collapse note whitespace for the single-line log format (a multi-
        // line Error stack would otherwise break alignment in the timeline).
        const noteForLog = collapseNote(result.note);
        log(`${verb} ralph_loop after ${result.iterations} iteration${result.iterations === 1 ? "" : "s"} (reason: ${reason}${noteForLog ? `, note: ${noteForLog}` : ""}, ${result.durationMs}ms)`);
        state.active = null;
        state.lastResult = Object.freeze(result);
    };

    const onAssistantMessage = (ev) => {
        const text = ev?.data?.content;
        if (typeof text !== "string") return;
        // Ignore sub-agent messages — they're not part of the root
        // agent's response to our queued prompt and would otherwise
        // be checked for completion_promise / abort_promise tokens.
        if (isSubAgentEvent(ev)) return;
        // Mark the in-flight fire as "consumed by the agent" so the next
        // turn_end is treated as a real response cycle rather than a
        // spurious sub-turn boundary that would otherwise queue another
        // copy of the prompt.
        if (state.active && state.active.fireInFlight) {
            state.active.observedMessageThisFire = true;
        }
        // Accumulate across multiple assistant.message events within the same
        // turn (the SDK can emit several distinct messages per turn). The
        // accumulator is reset on each iteration fire-out.
        const next = state.lastAssistantContent
            ? state.lastAssistantContent + "\n" + text
            : text;
        // Bound memory: drop oldest content past the cap. The completion /
        // abort / stagnation checks only ever inspect this string, and a
        // 1 MiB tail is more than enough to find any reasonable signal.
        // Use safeSliceStart so the head-trim never leaves a lone low
        // surrogate at position 0 (which would corrupt the buffer for any
        // downstream consumer that tries to render it).
        state.lastAssistantContent = next.length > MAX_CONTENT_CHARS
            ? next.slice(safeSliceStart(next, next.length - MAX_CONTENT_CHARS))
            : next;
    };

    const onIdle = (ev) => {
        const a = state.active;
        if (!a) return;

        // Only refire on the root agent's idle transitions — sub-agents
        // (task / explore / code-review / rubber-duck …) report their own
        // session.idle on the shared bus and would otherwise queue an
        // extra copy of our prompt every time one finishes.
        if (isSubAgentEvent(ev)) return;

        // The turn that *called* ralph_loop will go idle before any
        // iteration runs. Use that first idle to fire iteration 1's
        // prompt; only evaluate completion/abort on subsequent idles.
        if (a.pendingFire) {
            a.pendingFire = false;
            a.i = 1;
            logIterStart(a);
            // Clear before firing so a silent iteration (no assistant.message)
            // is correctly evaluated as empty content rather than the prior turn.
            state.lastAssistantContent = "";
            tryFire(a.prompt);
            return;
        }

        // Queue-bloat protection: if the prompt we previously fired hasn't
        // produced any assistant.message yet, this idle is a stale signal
        // (e.g. the SDK fired idle before the agent picked up our send).
        // Refiring here would queue another identical copy.
        if (a.fireInFlight && !a.observedMessageThisFire) {
            log(`ralph_loop: skipping idle — previous prompt not yet picked up by agent`);
            return;
        }
        // Consume the in-flight marker now that the agent has fully
        // responded to our last fire (assistant.message + session.idle).
        a.fireInFlight = false;
        a.observedMessageThisFire = false;

        const text = state.lastAssistantContent;

        // completion/abort only honored once min_iterations have completed
        if (a.i >= a.min) {
            if (text.includes(a.completionPromise)) return finish("completion_promise");
            if (a.abortPromise && text.includes(a.abortPromise)) return finish("abort_promise");
        }

        if (a.stagnationLimit > 0) {
            a.streak = a.prev !== null && text === a.prev ? a.streak + 1 : 1;
            a.prev = text;
            if (a.streak >= a.stagnationLimit) return finish("stagnation");
        }

        if (a.i >= a.max) return finish("max_iterations");

        a.i += 1;
        logIterStart(a);
        state.lastAssistantContent = "";
        tryFire(a.prompt);
    };

    const onAbort = (ev) => {
        // Only react to root-agent aborts — see isSubAgentEvent() rationale.
        // A sub-agent that gets aborted (task / explore / rubber-duck
        // failure) must NOT tear down the root ralph_loop along with it.
        if (isSubAgentEvent(ev)) return;
        if (state.active) {
            // If the SDK supplies an abort reason in the event payload,
            // capture it so it shows up in the log line and additionalContext.
            const reasonRaw = ev?.data?.reason ?? ev?.reason;
            const trimmed = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
            const note = trimmed ? trimmed : undefined;
            // Bound the log line: boundedNoteForLog so a pathologically large
            // SDK abort reason doesn't dump megabytes into the timeline. The
            // structured note on the result is also truncated by finish(),
            // but the pre-finish log line was previously printing the raw
            // value uncapped — fix that.
            const noteForLog = note ? boundedNoteForLog(note) : "";
            log(`⏹ ralph_loop interrupted by session abort${noteForLog ? ` (${noteForLog})` : ""}.`);
            finish("aborted", note);
        }
    };

    const tools = [
        {
            name: "ralph_loop",
            description:
                "Run a Ralph Wiggum-style autonomous iterative loop. The tool returns immediately after arming the loop; iterations are driven by reacting to each session.idle (root-agent agentic-loop completion) and re-injecting the prompt as a new user message. Each iteration is a real conversation turn — context is retained, and progress is visible inline. Use ralph_stop to cancel an active loop. Tip: instruct the agent in the prompt to emit the completion_promise (default 'COMPLETE') when finished, otherwise the loop only stops at max_iterations.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description:
                            `The task prompt that gets re-fed each iteration. Should instruct the agent to emit the completion_promise when done. Max ${MAX_PROMPT_CHARS} chars.`,
                        minLength: 1,
                        maxLength: MAX_PROMPT_CHARS,
                    },
                    max_iterations: {
                        type: "integer",
                        description: `Maximum iterations before stopping (default ${DEFAULTS.max_iterations}, max ${MAX_ALLOWED_ITERATIONS}).`,
                        default: DEFAULTS.max_iterations,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                    min_iterations: {
                        type: "integer",
                        description: `Minimum iterations before completion_promise / abort_promise are honored (default ${DEFAULTS.min_iterations}; must not exceed max_iterations). Use this to force the agent to run additional verification passes even if it declares completion early.`,
                        default: DEFAULTS.min_iterations,
                        minimum: 1,
                        maximum: MAX_ALLOWED_ITERATIONS,
                    },
                    completion_promise: {
                        type: "string",
                        description:
                            `Substring that, when present in an assistant turn's response, signals completion (default 'COMPLETE'). Max ${MAX_PROMISE_CHARS} chars.`,
                        default: DEFAULTS.completion_promise,
                        minLength: 1,
                        maxLength: MAX_PROMISE_CHARS,
                    },
                    abort_promise: {
                        type: "string",
                        description:
                            `Optional substring that, when present in an assistant turn's response, aborts the loop early (e.g. when the agent signals a precondition failure). Max ${MAX_PROMISE_CHARS} chars.`,
                        minLength: 1,
                        maxLength: MAX_PROMISE_CHARS,
                    },
                    stagnation_limit: {
                        type: "integer",
                        description: `Abort if the assistant returns N consecutive byte-identical responses (default ${DEFAULTS.stagnation_limit}, 0 to disable). Must be 0 or ≥ 2 — the value 1 is rejected at runtime since no comparison is possible after a single response.`,
                        default: DEFAULTS.stagnation_limit,
                        minimum: 0,
                        // Schema-level guard mirroring the runtime check
                        // (validateArgs rejects 1) so LLM clients that
                        // honor `not` see the constraint up front instead
                        // of discovering it via a tool-call failure.
                        not: { const: 1 },
                    },
                },
                required: ["prompt"],
                additionalProperties: false,
            },
            handler: async (args) => {
                if (!sessionRef?.send) {
                    return failure(
                        "ralph_loop: session not attached — controller.attach(session) must be called before invoking ralph_loop.",
                    );
                }
                if (state.active) {
                    const a = state.active;
                    const where = a.pendingFire
                        ? `armed (iteration 1/${a.max} pending — call ralph_stop first)`
                        : `running (iteration ${a.i}/${a.max} — call ralph_stop first)`;
                    return failure(`ralph_loop is already ${where}.`);
                }
                const parsed = validateArgs(args);
                if (parsed.error) return failure(parsed.error);

                state.active = {
                    ...parsed.value,
                    i: 0,
                    prev: null,
                    streak: 0,
                    pendingFire: true,
                    fireInFlight: false,
                    observedMessageThisFire: false,
                    startedAt: Date.now(),
                };
                state.lastAssistantContent = "";
                state.lastResult = null;

                log(
                    `🔁 ralph_loop armed — max=${parsed.value.max}${parsed.value.min > 1 ? `, min=${parsed.value.min}` : ""}, completion=${JSON.stringify(parsed.value.completionPromise)}${
                        parsed.value.abortPromise ? `, abort=${JSON.stringify(parsed.value.abortPromise)}` : ""
                    }${parsed.value.stagnationLimit > 0 ? `, stagnation_limit=${parsed.value.stagnationLimit}` : ""}`,
                );
                return success(
                    `ralph_loop armed (max=${parsed.value.max}${parsed.value.min > 1 ? `, min=${parsed.value.min}` : ""}). Iterations will run as conversation turns. Use ralph_stop to cancel.`,
                    { armed: true, max: parsed.value.max, min: parsed.value.min },
                );
            },
        },
        {
            name: "ralph_stop",
            description:
                "Cancel a currently-running ralph_loop. Returns the iteration count at the moment of stop. Returns failure if no loop is active. Optionally pass a `reason` describing why the loop is being stopped (recorded as `note` on the result).",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: `Optional human-readable reason for stopping the loop (≤${PREVIEW_CHARS} chars).`,
                        maxLength: PREVIEW_CHARS,
                    },
                },
                additionalProperties: false,
            },
            handler: async (args) => {
                if (!state.active) return failure("ralph_stop: no ralph_loop is currently running.");
                // ralph_stop's `reason` is optional, so null/undefined are
                // valid. Anything else goes through the same shape +
                // unknown-keys gate as ralph_loop so typos and bogus
                // shapes surface loudly.
                if (args !== null && args !== undefined) {
                    const shape = validateArgShape("ralph_stop", args, RALPH_STOP_KEYS);
                    if (shape) return failure(shape.error);
                }
                const i = state.active.i;
                const max = state.active.max;
                const reason = args && typeof args === "object" && !Array.isArray(args) ? args.reason : undefined;
                const trimmed = typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
                // Cap before surfacing in the response or storing in result.note
                // so a giant user-supplied reason can't pollute the LLM context.
                const note = trimmed !== undefined ? truncateNote(trimmed) : undefined;
                finish("user_stopped", note);
                return success(
                    `ralph_loop stopped after ${i}/${max} iterations${note ? ` (${note})` : ""}.`,
                    { iterations: i, note },
                );
            },
        },
    ];
    // Deep-freeze the public tool surface so consumers can't accidentally
    // mutate tool descriptors, swap out handlers, OR tweak the JSON schema
    // (which would break clients that introspected our parameters and
    // would silently desync runtime validation from declared bounds).
    const deepFreeze = (obj) => {
        if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) return obj;
        Object.freeze(obj);
        for (const key of Object.keys(obj)) deepFreeze(obj[key]);
        return obj;
    };
    for (const t of tools) deepFreeze(t);
    Object.freeze(tools);

    const hooks = Object.freeze({
        onUserPromptSubmitted: async () => {
            if (!state.lastResult) return;
            const r = state.lastResult;
            state.lastResult = null;
            // Collapse whitespace so a multi-line note (e.g. an Error stack
            // surfaced via send_error) doesn't break the bracketed context
            // line presented to the agent.
            const noteOneLine = collapseNote(r.note);
            const ctx = `[ralph_loop just finished — iterations=${r.iterations}, reason=${r.reason}${noteOneLine ? `, note=${noteOneLine}` : ""}, durationMs=${r.durationMs}]`;
            log(`ralph_loop: injecting post-loop context into next user prompt (reason=${r.reason}, iterations=${r.iterations})`);
            return { additionalContext: ctx };
        },
    });

    let currentDetach = null;
    /**
     * Wire the controller to a Copilot CLI session. Subscribes to the three
     * events the controller needs (assistant.message, session.idle, abort).
     * Idempotent: calling attach(s2) after attach(s1) tears down s1's
     * listeners first, so duplicate listeners can never double-count
     * events. Calling attach() before any session is fatal — ralph_loop
     * fails fast with a clear error.
     *
     * @param {object} session - SDK session with .send(message) and .on(event, handler).
     * @returns {() => void} A detach function that unsubscribes all listeners
     *   and, if a loop is currently active on THIS attachment, finishes it
     *   with reason="detached". A stale detach (one returned by an earlier
     *   attach() that has since been superseded by a later attach()) is a
     *   no-op against state — calling it will not kill a loop running on
     *   the newer session.
     */
    function attach(session) {
        if (!session || typeof session !== "object") {
            throw new TypeError("ralph: attach(session) requires a session object.");
        }
        if (typeof session.send !== "function") {
            throw new TypeError("ralph: attached session is missing required method 'send(message)'.");
        }
        if (typeof session.on !== "function") {
            throw new TypeError("ralph: attached session is missing required method 'on(event, handler)'.");
        }
        // Idempotent re-attach: if we're already wired (possibly to a
        // different session), tear that down first so we don't end up with
        // duplicate listeners that would double-count every event.
        if (currentDetach) {
            try { currentDetach(); } catch { /* ignore */ }
            currentDetach = null;
        }
        sessionRef = session;
        // Subscribe to the three events we care about. Per the SDK
        // contract `session.on()` returns an unsubscribe function — if a
        // session implementation returns anything else we'd have no way
        // to remove the listener on detach (memory/listener leak). Warn
        // loudly with the event name so the issue is debuggable, then
        // drop the bogus value so detach doesn't crash.
        const subs = [
            ["assistant.message", session.on("assistant.message", onAssistantMessage)],
            ["session.idle", session.on("session.idle", onIdle)],
            ["abort", session.on("abort", onAbort)],
        ];
        const unsubs = [];
        for (const [evName, ret] of subs) {
            if (typeof ret === "function") {
                unsubs.push(ret);
            } else {
                log(`ralph: warning — session.on(${JSON.stringify(evName)}) did not return an unsubscribe function (got ${describeArgType(ret)}); listener may leak on detach.`);
            }
        }
        const detach = () => {
            // If THIS detach is still the current wiring AND a loop is in flight,
            // finish it gracefully instead of leaving orphaned state behind.
            // A stale detach (e.g. one returned by a previous attach() that has
            // since been superseded) must NOT touch state.active — that would
            // kill the loop running on the newer session.
            if (currentDetach === detach && state.active) finish("detached");
            for (const u of unsubs) {
                try { u(); } catch { /* ignore */ }
            }
            if (currentDetach === detach) currentDetach = null;
            if (sessionRef === session) sessionRef = null;
        };
        currentDetach = detach;
        return detach;
    }

    return {
        tools,
        hooks,
        attach,
        state,
        // Exposed for tests so they can drive events deterministically.
        _internal: { onAssistantMessage, onIdle, onAbort, finish, success, failure },
    };
}

export const __test__ = { DEFAULTS, MAX_ALLOWED_ITERATIONS, PREVIEW_CHARS, MAX_PROMPT_CHARS, MAX_PROMISE_CHARS, MAX_CONTENT_CHARS, previewOf };
