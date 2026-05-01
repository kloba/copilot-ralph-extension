// Hook/event-driven Ralph Wiggum controller for Copilot CLI.
//
// Architecture: the ralph_loop tool returns immediately after arming the loop.
// Iterations are driven by listening to `session.idle` events (the root
// agent's "agentic loop fully done" signal) and re-injecting the prompt via
// `session.send` (fire-and-forget). Using `session.idle` rather than
// `assistant.turn_end` is critical: the SDK emits a turn_end per agentic-loop
// sub-turn (one per tool-call boundary), so a single root response with N
// tool calls produces N+ turn_ends. Only `session.idle` fires exactly once
// per root response. Every iteration is a real assistant turn the user sees,
// keeping full conversation context across the loop.
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
// Cap completion_promise / abort_promise — short substring signals; megabyte-
// long signals would waste memory and slow `.includes()` matching.
const MAX_PROMISE_CHARS = 200;
// Cap the per-iteration accumulated assistant content. Only used for
// substring matching (completion/abort/stagnation) and the preview.
const MAX_CONTENT_CHARS = 1_048_576; // 1 MiB

// Map finish reason → log-line verb. Reasons not listed fall through
// to "⏹ stopped" (max_iterations, abort_promise, stagnation,
// user_stopped, detached).
//   ✅ completed — completion_promise
//   ⚠️  ended   — send_error, aborted (something went wrong)
const VERB_BY_REASON = Object.freeze({
    completion_promise: "✅ completed",
    send_error: "⚠️ ended",
    aborted: "⚠️ ended",
});

// Find a slice length ≤ `cut` that doesn't split a UTF-16 surrogate pair
// (4-byte chars like emoji), so we never produce a lone-surrogate tail.
function safeSliceEnd(s, cut) {
    const code = s.charCodeAt(cut - 1);
    return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
}

// Mirror of safeSliceEnd for the START side: if the kept slice would begin
// on a lone low surrogate (high surrogate dropped by the head trim), advance
// start by 1 to avoid producing an invalid UTF-16 string.
function safeSliceStart(s, start) {
    const code = s.charCodeAt(start);
    return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
}

function previewOf(text) {
    if (!text) return "";
    if (text.length <= PREVIEW_CHARS) return text;
    return text.slice(0, safeSliceEnd(text, PREVIEW_CHARS)) + "…";
}

// English pluralization for log lines: "" when n===1, "s" otherwise.
function pluralS(n) {
    return n === 1 ? "" : "s";
}

// Truncate `note` to PREVIEW_CHARS without splitting a surrogate pair (notes
// can carry user-supplied or error strings containing 4-byte chars like emoji).
function truncateNote(text) {
    const s = String(text);
    if (s.length <= PREVIEW_CHARS) return s;
    return s.slice(0, safeSliceEnd(s, PREVIEW_CHARS));
}

// Collapse whitespace (newlines, tabs, runs of spaces) into single spaces and
// trim — flattens multi-line notes (e.g. Error stacks) to single-line markers.
function collapseNote(text) {
    return text ? String(text).replace(/\s+/g, " ").trim() : "";
}

// Cap length at PREVIEW_CHARS (surrogate-safely) and flatten whitespace
// for log sites embedding external strings (abort reason, send-error
// message), so the timeline can't be flooded by a pathological payload.
function boundedNoteForLog(text) {
    return collapseNote(truncateNote(text));
}

// Recursively freeze obj + nested values; skips already-frozen entries so
// cycles terminate. Returns the input (for fluent `return deepFreeze(...)`).
function deepFreeze(obj) {
    if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) return obj;
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
    return obj;
}

function failure(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "failure" };
}

function success(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "success" };
}

// Every session event carries an optional `agentId` — string on sub-agent
// events (task / explore / code-review / rubber-duck …), absent on root.
// Sub-agent events bubble on the same bus, so root-only handlers must
// filter — else sub-agents trigger spurious refires or interrupt the loop.
function isSubAgentEvent(ev) {
    return ev != null && ev.agentId !== undefined && ev.agentId !== null;
}

/**
 * @typedef {Object} RalphArgs
 * @property {string} prompt - Required. The prompt re-injected each iteration. ≤ MAX_PROMPT_CHARS (65 536) UTF-16 code units. Note: emoji and other 4-byte chars consume two code units each, so worst-case byte length can be larger than 64 KiB.
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
 * @property {string} [note] - Optional human-readable context: caller-supplied via ralph_stop({reason}), or the underlying error message on send_error, or the SDK abort reason on aborted. Truncated silently to PREVIEW_CHARS (500) (surrogate-safe) — no "…" indicator is appended (unlike `preview`). Notes are flowed inline into single-line log markers and the post-loop additionalContext bracket, where a trailing "…" would be misread as part of the message.
 */

// Type name for error messages: distinguishes null/array from generic
// "object" (so `[]` shows as "array" instead of the misleading "object").
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

// Reject malformed shapes (null/array/primitive) and unknown keys (so a
// typo like `resaon` or `max_iter` surfaces loudly instead of being
// silently dropped). Returns null on valid shape, else { error }.
function validateArgShape(toolName, args, knownKeys) {
    // typeof null === "object" so null needs an explicit check.
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return { error: `${toolName}: arguments must be an object (got ${describeArgType(args)}).` };
    }
    const unknown = Object.keys(args).filter((k) => !knownKeys.has(k));
    if (unknown.length) {
        return {
            error: `${toolName}: unknown argument${pluralS(unknown.length)}: ${unknown.map((k) => JSON.stringify(k)).join(", ")}. Valid keys: ${[...knownKeys].join(", ")}.`,
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

// Validate completion_promise / abort_promise: string, non-whitespace,
// ≤ MAX_PROMISE_CHARS, trimmed before matching. `whenProvided` injects
// ", when provided," into abort_promise's empty error (it has no default).
function validatePromiseField(fieldName, raw, { whenProvided = false } = {}) {
    if (typeof raw !== "string") {
        return { error: `ralph_loop: ${fieldName} must be a string (got ${describeArgType(raw)}).` };
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        const interjection = whenProvided ? ", when provided," : "";
        return { error: `ralph_loop: ${fieldName}${interjection} must contain at least one non-whitespace character.` };
    }
    if (raw.length > MAX_PROMISE_CHARS) {
        return { error: `ralph_loop: ${fieldName} exceeds ${MAX_PROMISE_CHARS} characters (got ${raw.length}). Use a short signal phrase.` };
    }
    return { value: trimmed };
}

// Like validatePromiseField but treats undefined/null as "not supplied"
// (so `{ abort_promise: null }` means "no abort signal", not a type error).
function resolveOptionalPromise(fieldName, raw, fallback, opts) {
    if (raw === undefined || raw === null) return { value: fallback };
    return validatePromiseField(fieldName, raw, opts);
}

// Type-check + Number() coerce for max/min_iterations and stagnation_limit.
// Range validation stays at the call site since each field's bounds differ.
function coerceNumberField(fieldName, raw) {
    if (typeof raw !== "number" && typeof raw !== "string") {
        return { error: `ralph_loop: ${fieldName} must be a number (got ${describeArgType(raw)}).` };
    }
    return { value: Number(raw) };
}

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
        // Distinguish "missing" from "whitespace-only" — the latter
        // usually signals a templating bug (variable interpolated to "").
        if (!args.prompt) {
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
    const maxC = coerceNumberField("max_iterations", rawMax);
    if (maxC.error) return maxC;
    const max = maxC.value;
    if (!Number.isInteger(max) || max < 1 || max > MAX_ALLOWED_ITERATIONS) {
        return {
            error: `ralph_loop: max_iterations must be an integer in [1, ${MAX_ALLOWED_ITERATIONS}] (got ${displayValue(rawMax)}).`,
        };
    }

    const rawMin = args.min_iterations ?? DEFAULTS.min_iterations;
    const minC = coerceNumberField("min_iterations", rawMin);
    if (minC.error) return minC;
    const min = minC.value;
    if (!Number.isInteger(min) || min < 1 || min > max) {
        return {
            error: `ralph_loop: min_iterations must be an integer in [1, max_iterations=${max}] (got ${displayValue(rawMin)}).`,
        };
    }

    const cp = resolveOptionalPromise("completion_promise", args.completion_promise, DEFAULTS.completion_promise);
    if (cp.error) return cp;
    const completionPromise = cp.value;

    const ap = resolveOptionalPromise("abort_promise", args.abort_promise, null, { whenProvided: true });
    if (ap.error) return ap;
    const abortPromise = ap.value;

    if (abortPromise !== null) {
        if (abortPromise === completionPromise) {
            return {
                error: `ralph_loop: abort_promise must differ from completion_promise (both are ${JSON.stringify(completionPromise)} — the signal would be ambiguous).`,
            };
        }
        if (abortPromise.includes(completionPromise) || completionPromise.includes(abortPromise)) {
            return {
                error: `ralph_loop: completion_promise (${JSON.stringify(completionPromise)}) and abort_promise (${JSON.stringify(abortPromise)}) overlap as substrings — whichever check runs first will always fire. Pick disjoint phrases.`,
            };
        }
    }

    const rawStagnation = args.stagnation_limit ?? DEFAULTS.stagnation_limit;
    const stagC = coerceNumberField("stagnation_limit", rawStagnation);
    if (stagC.error) return stagC;
    const stagnationLimit = stagC.value;
    if (!Number.isInteger(stagnationLimit) || stagnationLimit < 0 || stagnationLimit === 1) {
        return {
            error: `ralph_loop: stagnation_limit must be 0 (disabled) or an integer ≥ 2 (got ${displayValue(rawStagnation)}). 1 is meaningless because no comparison is possible after a single response.`,
        };
    }

    return { value: { prompt, max, min, completionPromise, abortPromise, stagnationLimit } };
}

/**
 * @typedef {Object} ActiveLoopState
 * @property {string} prompt - Validated, trimmed prompt re-fired each iteration.
 * @property {number} max - Hard iteration cap (1..MAX_ALLOWED_ITERATIONS).
 * @property {number} min - Iterations that must complete before completion/abort phrases are honored (1..max).
 * @property {string} completionPromise - Trimmed substring whose presence finishes with reason "completion_promise".
 * @property {string|null} abortPromise - Trimmed substring whose presence finishes with reason "abort_promise"; null when not configured.
 * @property {number} stagnationLimit - 0 disables; otherwise N≥2 consecutive byte-identical responses fire reason "stagnation".
 * @property {number} i - Current iteration counter (0 between arm and first idle, 1..max thereafter).
 * @property {string|null} prev - Last iteration's accumulated text, captured for stagnation comparison; null until the first iteration evaluation.
 * @property {number} streak - Count of consecutive byte-identical responses (resets to 1 on any change).
 * @property {boolean} pendingFire - True from arm-time until the first session.idle fires iteration 1.
 * @property {boolean} fireInFlight - True between a successful tryFire and the next assistant.message that "consumes" it.
 * @property {boolean} observedMessageThisFire - True once the in-flight fire has produced at least one root assistant.message.
 * @property {number} startedAt - Epoch ms captured at arm-time, used for durationMs.
 */

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
 *   state: { active: ActiveLoopState|null, lastAssistantContent: string, lastResult: RalphResult|null },
 *   _internal: { onAssistantMessage: Function, onIdle: Function, onAbort: Function, finish: Function, success: Function, failure: Function }
 * }} Controller. See `attach()` for the detach contract.
 */
export function createRalphController() {
    const state = {
        active: null,           // ActiveLoopState; null when no loop is armed.
        lastAssistantContent: "",
        // Shape: see the RalphResult typedef. Frozen on assignment.
        lastResult: null,
    };
    let sessionRef = null;

    // Clamp elapsed to ≥ 0 so a backward clock jump (NTP correction mid-loop)
    // never surfaces a negative duration in logs or result.durationMs.
    const clampedElapsed = (start) => Math.max(0, Date.now() - start);

    const log = (msg) => {
        try { sessionRef?.log?.(msg); } catch { /* swallow */ }
    };

    // Fire iteration prompt; handle both sync throws and async rejections.
    // Captures the active-loop identity at fire-time so a late rejection from a
    // previous arming can't poison a freshly-armed loop. Queue-bloat protection:
    // back-to-back signals would otherwise queue duplicate prompts — visible as
    // `Queued (3)` of identical messages.
    const tryFire = (prompt) => {
        const armedFor = state.active;
        if (!armedFor) return;
        if (armedFor.fireInFlight) {
            log("ralph_loop: skipping refire — previous prompt still queued (no assistant.message observed yet)");
            return;
        }
        armedFor.fireInFlight = true;
        armedFor.observedMessageThisFire = false;
        // kind: "rejected" (async rejection) or "failed" (sync throw) — both prefixes
        // are part of the public log/note contract. boundedNoteForLog caps the log
        // line; finish() does its own truncate on result.note.
        const handleSendFailure = (err, kind) => {
            if (state.active !== armedFor) return;
            armedFor.fireInFlight = false;
            const raw = err?.message ?? String(err);
            const prefix = `send ${kind}`;
            log(`ralph_loop: ${prefix}: ${boundedNoteForLog(raw)}`);
            finish("send_error", `${prefix}: ${raw}`);
        };
        try {
            if (!sessionRef?.send) throw new Error("session not attached");
            const r = sessionRef.send({ prompt });
            if (typeof r?.then === "function") {
                r.catch((err) => handleSendFailure(err, "rejected"));
            }
        } catch (err) {
            handleSendFailure(err, "failed");
        }
    };

    const finish = (reason, note) => {
        if (!state.active) return;
        const { startedAt, i: iterations } = state.active;
        const finishedAt = Date.now();
        const durationMs = clampedElapsed(startedAt);
        const result = {
            reason,
            iterations,
            preview: previewOf(state.lastAssistantContent),
            startedAt,
            finishedAt,
            durationMs,
        };
        if (note) result.note = truncateNote(note);
        const verb = VERB_BY_REASON[reason] ?? "⏹ stopped";
        // Single-line log format: collapse newlines/tabs in note (Error
        // stacks would otherwise break alignment in the timeline).
        const noteForLog = collapseNote(result.note);
        log(`${verb} ralph_loop after ${iterations} iteration${pluralS(iterations)} (reason: ${reason}${noteForLog ? `, note: ${noteForLog}` : ""}, ${durationMs}ms)`);
        state.active = null;
        state.lastResult = Object.freeze(result);
    };

    const onAssistantMessage = (ev) => {
        const text = ev?.data?.content;
        if (typeof text !== "string") return;
        // Ignore sub-agent messages — see isSubAgentEvent() rationale.
        // Otherwise their content would be checked for completion/abort tokens.
        if (isSubAgentEvent(ev)) return;
        // Mark this fire "consumed" so the next idle is treated as a real
        // response cycle, not a spurious signal that would queue another copy.
        if (state.active?.fireInFlight) {
            state.active.observedMessageThisFire = true;
        }
        // Accumulate across multiple assistant.message events in the same turn
        // (the SDK can emit several per turn); reset on each iteration fire-out.
        const prev = state.lastAssistantContent;
        const next = prev ? `${prev}\n${text}` : text;
        // Bound memory: keep a tail ≤ MAX_CONTENT_CHARS — completion/abort/
        // stagnation only inspect this string. safeSliceStart guards against
        // the head-trim leaving a lone low surrogate at position 0.
        state.lastAssistantContent = next.length > MAX_CONTENT_CHARS
            ? next.slice(safeSliceStart(next, next.length - MAX_CONTENT_CHARS))
            : next;
    };

    // Run an iteration: log start, clear the accumulator (so a silent
    // iteration is evaluated as empty rather than the prior turn), and
    // fire the prompt. Caller is responsible for incrementing `a.i`.
    const fireIteration = (a) => {
        log(`🔁 ralph_loop iter ${a.i}/${a.max} (elapsed ${clampedElapsed(a.startedAt)}ms)`);
        state.lastAssistantContent = "";
        tryFire(a.prompt);
    };

    const onIdle = (ev) => {
        const a = state.active;
        if (!a) return;

        // Only react to root-agent idles — see isSubAgentEvent() rationale.
        // A sub-agent finishing its own loop (task / explore / …) must NOT
        // queue an extra copy of our prompt.
        if (isSubAgentEvent(ev)) return;

        // The turn that *called* ralph_loop goes idle before any iteration runs.
        // Use that idle to fire iteration 1; evaluate completion/abort on later ones.
        if (a.pendingFire) {
            a.pendingFire = false;
            a.i = 1;
            fireIteration(a);
            return;
        }

        // Queue-bloat protection: if the prompt we previously fired hasn't
        // produced any assistant.message yet, this idle is a stale signal.
        if (a.fireInFlight && !a.observedMessageThisFire) {
            log("ralph_loop: skipping idle — previous prompt not yet picked up by agent");
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
            // First iteration: a.prev is null, text is a string — `text ===
            // a.prev` is false so we take the reset branch and set streak=1.
            a.streak = text === a.prev ? a.streak + 1 : 1;
            a.prev = text;
            if (a.streak >= a.stagnationLimit) return finish("stagnation");
        }

        if (a.i >= a.max) return finish("max_iterations");

        a.i += 1;
        fireIteration(a);
    };

    const onAbort = (ev) => {
        // Only react to root-agent aborts — see isSubAgentEvent() rationale.
        // A sub-agent that gets aborted (task / explore / rubber-duck
        // failure) must NOT tear down the root ralph_loop along with it.
        if (isSubAgentEvent(ev)) return;
        if (!state.active) return;
        // If the SDK supplies an abort reason in the event payload,
        // capture it so it shows up in the log line and additionalContext.
        const reasonRaw = ev?.data?.reason ?? ev?.reason;
        const note = (typeof reasonRaw === "string" ? reasonRaw.trim() : "") || undefined;
        // Log line capped via boundedNoteForLog; result.note is capped
        // independently by finish() → truncateNote.
        log(`⏹ ralph_loop interrupted by session abort${note ? ` (${boundedNoteForLog(note)})` : ""}.`);
        finish("aborted", note);
    };

    const tools = [
        {
            name: "ralph_loop",
            description:
                `Run a Ralph Wiggum-style autonomous iterative loop. The tool returns immediately after arming the loop; iterations are driven by reacting to each session.idle (root-agent agentic-loop completion) and re-injecting the prompt as a new user message. Each iteration is a real conversation turn — context is retained, and progress is visible inline. Use ralph_stop to cancel an active loop. Tip: instruct the agent in the prompt to emit the completion_promise (default '${DEFAULTS.completion_promise}') when finished, otherwise the loop only stops at max_iterations.`,
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
                            `Substring that, when present in an assistant turn's response, signals completion (default '${DEFAULTS.completion_promise}'). Max ${MAX_PROMISE_CHARS} chars.`,
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
                        // Schema-level guard mirroring validateArgs's rejection of 1,
                        // so LLM clients honoring `not` see it up front instead of
                        // via a tool-call failure.
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
                    const { pendingFire, i, max } = state.active;
                    // Both branches share the same "— call ralph_stop first" tail;
                    // only the iteration counter and arm-vs-run verb differ.
                    const status = pendingFire
                        ? `armed (iteration 1/${max} pending`
                        : `running (iteration ${i}/${max}`;
                    return failure(`ralph_loop is already ${status} — call ralph_stop first).`);
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

                // Build the arm log line as an array of "key=value" parts
                // so optional fields drop out cleanly without nested ternaries.
                const { max, min, completionPromise, abortPromise, stagnationLimit } = parsed.value;
                const armParts = [`max=${max}`];
                if (min > 1) armParts.push(`min=${min}`);
                armParts.push(`completion=${JSON.stringify(completionPromise)}`);
                if (abortPromise) armParts.push(`abort=${JSON.stringify(abortPromise)}`);
                if (stagnationLimit > 0) armParts.push(`stagnation_limit=${stagnationLimit}`);
                log(`🔁 ralph_loop armed — ${armParts.join(", ")}`);
                return success(
                    `ralph_loop armed (max=${max}${min > 1 ? `, min=${min}` : ""}). Iterations will run as conversation turns. Use ralph_stop to cancel.`,
                    { armed: true, max, min },
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
                // ralph_stop's `reason` is optional (null/undefined valid).
                // Anything else goes through the same shape + unknown-keys
                // gate as ralph_loop so typos surface loudly.
                if (args !== null && args !== undefined) {
                    const shape = validateArgShape("ralph_stop", args, RALPH_STOP_KEYS);
                    if (shape) return failure(shape.error);
                }
                const { i, max } = state.active;
                // truncateNote caps the stored value so a giant user-supplied
                // reason can't pollute the LLM context.
                const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
                const note = reason ? truncateNote(reason) : undefined;
                finish("user_stopped", note);
                return success(
                    `ralph_loop stopped after ${i}/${max} iterations${note ? ` (${note})` : ""}.`,
                    { iterations: i, note },
                );
            },
        },
        {
            name: "self_improve",
            description:
                "Arms ralph_loop with a baked-in, project-agnostic SDLC self-improvement prompt (orient → ideate → critique → baseline → implement → test → commit → push → COMPLETE). Stub: not yet implemented.",
            parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
            handler: async () => failure("self_improve: not implemented yet."),
        },
    ];
    // Deep-freeze the public tool surface so consumers can't swap handlers
    // or desync declared schema bounds from runtime validation.
    for (const t of tools) deepFreeze(t);
    Object.freeze(tools);

    const hooks = Object.freeze({
        onUserPromptSubmitted: async () => {
            if (!state.lastResult) return;
            const { iterations, reason, note, durationMs } = state.lastResult;
            state.lastResult = null;
            // Collapse whitespace so a multi-line note (e.g. an Error stack from
            // send_error) doesn't break the bracketed context line.
            const noteOneLine = collapseNote(note);
            const ctx = `[ralph_loop just finished — iterations=${iterations}, reason=${reason}${noteOneLine ? `, note=${noteOneLine}` : ""}, durationMs=${durationMs}]`;
            log(`ralph_loop: injecting post-loop context into next user prompt (reason=${reason}, iterations=${iterations})`);
            return { additionalContext: ctx };
        },
    });

    let currentDetach = null;
    /**
     * Wire the controller to a Copilot CLI session. Subscribes to the three
     * events the controller needs (assistant.message, session.idle, abort).
     * Idempotent: calling attach(s2) after attach(s1) tears down s1's
     * listeners first, so duplicate listeners can never double-count events.
     *
     * @param {object} session - SDK session with .send(message) and .on(event, handler).
     * @returns {() => void} Detach function: unsubscribes all listeners and,
     *   if a loop is currently active on THIS attachment, finishes it with
     *   reason="detached". Stale detaches (superseded by a later attach())
     *   are no-ops against state.
     */
    function attach(session) {
        if (!session || typeof session !== "object") {
            throw new TypeError("ralph: attach(session) requires a session object.");
        }
        // Bundled so adding a third required method (e.g. session.off) stays a one-liner.
        const requireMethod = (name, signature) => {
            if (typeof session[name] !== "function") {
                throw new TypeError(`ralph: attached session is missing required method '${signature}'.`);
            }
        };
        requireMethod("send", "send(message)");
        requireMethod("on", "on(event, handler)");
        // Idempotent re-attach: tear down any existing wiring first so we don't
        // end up with duplicate listeners that double-count every event.
        if (currentDetach) {
            try { currentDetach(); } catch { /* ignore */ }
            currentDetach = null;
        }
        sessionRef = session;
        // Wire the three session events. Subscribing one-at-a-time + tracking
        // unsubs lets us roll back if session.on throws partway through;
        // without rollback the earlier listeners would leak.
        const unsubs = [];
        // Best-effort teardown: swallow per-unsub throws so one buggy listener
        // can't strand the rest. Shared by subscribeOrFail's rollback and detach.
        const unsubscribeAll = () => {
            for (const u of unsubs) {
                try { u(); } catch { /* ignore */ }
            }
        };
        const subscribeOrFail = (evName, handler) => {
            let ret;
            try {
                ret = session.on(evName, handler);
            } catch (err) {
                unsubscribeAll();
                sessionRef = null;
                throw err;
            }
            // Per SDK contract session.on() returns an unsubscribe fn. If we got
            // something else, log the leak — we can't remove the listener on detach.
            if (typeof ret === "function") {
                unsubs.push(ret);
            } else {
                log(`ralph: warning — session.on(${JSON.stringify(evName)}) did not return an unsubscribe function (got ${describeArgType(ret)}); listener may leak on detach.`);
            }
        };
        subscribeOrFail("assistant.message", onAssistantMessage);
        subscribeOrFail("session.idle", onIdle);
        subscribeOrFail("abort", onAbort);
        const detach = () => {
            // If THIS detach is still the current wiring AND a loop is in flight,
            // finish it gracefully. A stale detach (one whose attach() has since
            // been superseded) must NOT touch state.active — that would interrupt
            // the loop running on the newer session.
            const isCurrent = currentDetach === detach;
            if (isCurrent && state.active) finish("detached");
            unsubscribeAll();
            if (isCurrent) currentDetach = null;
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
