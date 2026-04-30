// Hook/event-driven Ralph Wiggum controller for Copilot CLI.
//
// Architecture: the ralph_loop tool returns immediately after arming the loop.
// Iterations are driven by listening to `assistant.turn_end` events and
// re-injecting the prompt via `session.send` (fire-and-forget). This avoids
// the deadlock that the older `sendAndWait`-based design hit when invoked
// in-session, while still keeping full conversation context — every
// iteration is a real assistant turn the user sees.
//
// Inspired by Anthropic's Claude Code ralph-wiggum plugin (Stop hook
// re-injection pattern) and Th0rgal/open-ralph-wiggum.

const DEFAULTS = {
    max_iterations: 20,
    min_iterations: 1,
    completion_promise: "COMPLETE",
    stagnation_limit: 3,
};
const MAX_ALLOWED_ITERATIONS = 1000;
const PREVIEW_CHARS = 500;
const MAX_PROMPT_CHARS = 65536;
// Cap the per-iteration accumulated assistant content. We only need it for
// substring matching (completion/abort/stagnation) and a 500-char preview;
// extremely chatty turns shouldn't be allowed to consume unbounded memory.
const MAX_CONTENT_CHARS = 1_048_576; // 1 MiB

function previewOf(text) {
    if (!text) return "";
    if (text.length <= PREVIEW_CHARS) return text;
    let cut = PREVIEW_CHARS;
    // Avoid splitting a UTF-16 surrogate pair (4-byte char like emoji).
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    return text.slice(0, cut) + "…";
}
function failure(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "failure" };
}
function success(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "success" };
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
 * @property {string} preview - First 500 chars of the final assistant content.
 * @property {number} startedAt - Epoch ms when the loop was armed.
 * @property {number} finishedAt - Epoch ms when the loop finished.
 * @property {number} durationMs - finishedAt - startedAt.
 * @property {string} [note] - Optional reason text passed to ralph_stop.
 */

/**
 * Validate ralph_loop arguments.
 *
 * @param {RalphArgs} args
 * @returns {{value: object} | {error: string}} Validated values or a single human-readable error.
 */
export function validateArgs(args) {
    if (args === null || args === undefined || typeof args !== "object" || Array.isArray(args)) {
        return { error: "ralph_loop: arguments must be an object (got " + (args === null ? "null" : Array.isArray(args) ? "array" : typeof args) + ")." };
    }
    if (args.prompt !== undefined && args.prompt !== null && typeof args.prompt !== "string") {
        return { error: `ralph_loop: prompt must be a string (got ${Array.isArray(args.prompt) ? "array" : typeof args.prompt}).` };
    }
    const prompt = (args.prompt ?? "").trim();
    if (!prompt) return { error: "ralph_loop: prompt is required and must be non-empty." };
    if (prompt.length > MAX_PROMPT_CHARS) {
        return {
            error: `ralph_loop: prompt exceeds ${MAX_PROMPT_CHARS} characters (got ${prompt.length}). Shorten the prompt or split the work.`,
        };
    }

    const rawMax = args.max_iterations ?? DEFAULTS.max_iterations;
    const max = Number(rawMax);
    if (!Number.isInteger(max) || max < 1 || max > MAX_ALLOWED_ITERATIONS) {
        return {
            error: `ralph_loop: max_iterations must be an integer in [1, ${MAX_ALLOWED_ITERATIONS}] (got ${rawMax}).`,
        };
    }

    const rawMin = args.min_iterations ?? DEFAULTS.min_iterations;
    const min = Number(rawMin);
    if (!Number.isInteger(min) || min < 1 || min > max) {
        return {
            error: `ralph_loop: min_iterations must be an integer in [1, max_iterations=${max}] (got ${rawMin}).`,
        };
    }

    let completionPromise = DEFAULTS.completion_promise;
    if (args.completion_promise !== undefined && args.completion_promise !== null) {
        if (typeof args.completion_promise !== "string" || args.completion_promise.trim().length === 0) {
            return { error: "ralph_loop: completion_promise must be a non-empty, non-whitespace-only string." };
        }
        completionPromise = args.completion_promise;
    }

    let abortPromise = null;
    if (args.abort_promise !== undefined && args.abort_promise !== null) {
        if (typeof args.abort_promise !== "string" || args.abort_promise.trim().length === 0) {
            return { error: "ralph_loop: abort_promise, when provided, must be a non-empty, non-whitespace-only string." };
        }
        abortPromise = args.abort_promise;
    }

    if (abortPromise !== null && abortPromise === completionPromise) {
        return {
            error: "ralph_loop: abort_promise must differ from completion_promise (otherwise the signal is ambiguous).",
        };
    }

    const rawStagnation = args.stagnation_limit ?? DEFAULTS.stagnation_limit;
    const stagnationLimit = Number(rawStagnation);
    if (!Number.isInteger(stagnationLimit) || stagnationLimit < 0 || stagnationLimit === 1) {
        return {
            error: `ralph_loop: stagnation_limit must be 0 (disabled) or an integer ≥ 2 (got ${rawStagnation}). 1 is meaningless because no comparison is possible after a single response.`,
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
 *   _internal: { onAssistantMessage: Function, onTurnEnd: Function, onAbort: Function, finish: Function, success: Function, failure: Function }
 * }} Controller. `attach` returns an unsubscribe function that detaches all listeners and finalizes any active loop with reason='detached'.
 */
export function createRalphController() {
    const state = {
        active: null,           // see arming below for shape
        lastAssistantContent: "",
        lastResult: null,       // { reason, iterations, preview }
    };
    let sessionRef = null;

    const log = (msg) => {
        try { sessionRef?.log?.(msg); } catch { /* swallow */ }
    };
    const sendPrompt = (prompt) => {
        if (!sessionRef?.send) throw new Error("session not attached");
        return sessionRef.send({ prompt });
    };

    // Fire iteration prompt; handle both sync throws and async rejections.
    const tryFire = (prompt) => {
        try {
            const r = sendPrompt(prompt);
            if (r && typeof r.then === "function") {
                r.then(undefined, (err) => {
                    if (!state.active) return;
                    const msg = err?.message ?? String(err);
                    log(`ralph_loop: send rejected: ${msg}`);
                    finish("send_error", `send rejected: ${msg}`);
                });
            }
        } catch (err) {
            const msg = err?.message ?? String(err);
            log(`ralph_loop: send failed: ${msg}`);
            finish("send_error", `send failed: ${msg}`);
        }
    };

    const finish = (reason, note) => {
        if (!state.active) return;
        const startedAt = state.active.startedAt ?? Date.now();
        const finishedAt = Date.now();
        const result = {
            reason,
            iterations: state.active.i,
            preview: previewOf(state.lastAssistantContent),
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
        };
        if (note) result.note = String(note).slice(0, PREVIEW_CHARS);
        const verb = reason === "completion_promise" ? "✅ completed" : "⏹ stopped";
        log(`${verb} ralph_loop after ${result.iterations} iteration${result.iterations === 1 ? "" : "s"} (reason: ${reason}${result.note ? `, note: ${result.note}` : ""}, ${result.durationMs}ms)`);
        state.active = null;
        state.lastResult = Object.freeze(result);
    };

    const onAssistantMessage = (ev) => {
        const text = ev?.data?.content;
        if (typeof text !== "string") return;
        // Accumulate across multiple assistant.message events within the same
        // turn (the SDK can emit several distinct messages per turn). The
        // accumulator is reset on each iteration fire-out.
        const next = state.lastAssistantContent
            ? state.lastAssistantContent + "\n" + text
            : text;
        // Bound memory: drop oldest content past the cap. The completion /
        // abort / stagnation checks only ever inspect this string, and a
        // 1 MiB tail is more than enough to find any reasonable signal.
        state.lastAssistantContent = next.length > MAX_CONTENT_CHARS
            ? next.slice(next.length - MAX_CONTENT_CHARS)
            : next;
    };

    const onTurnEnd = (ev) => {
        const a = state.active;
        if (!a) return;

        // Dedupe: the SDK should only emit one turn_end per turnId, but a
        // misbehaving session implementation that double-emits would otherwise
        // double-count iterations. Track the last turnId we processed.
        const turnId = ev?.data?.turnId;
        if (turnId !== undefined && turnId === a.lastTurnId) return;
        if (turnId !== undefined) a.lastTurnId = turnId;

        // The turn that *called* ralph_loop will end before any iteration runs.
        // Use that first turn_end to fire iteration 1's prompt; only evaluate
        // completion/abort on subsequent turn_ends.
        if (a.pendingFire) {
            a.pendingFire = false;
            a.i = 1;
            log(`🔁 ralph_loop iter 1/${a.max} (elapsed ${Date.now() - a.startedAt}ms)`);
            // Clear before firing so a silent iteration (no assistant.message)
            // is correctly evaluated as empty content rather than the prior turn.
            state.lastAssistantContent = "";
            tryFire(a.prompt);
            return;
        }

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
        const elapsed = Date.now() - a.startedAt;
        log(`🔁 ralph_loop iter ${a.i}/${a.max} (elapsed ${elapsed}ms)`);
        state.lastAssistantContent = "";
        tryFire(a.prompt);
    };

    const onAbort = (ev) => {
        if (state.active) {
            // If the SDK supplies an abort reason in the event payload,
            // capture it so it shows up in the log line and additionalContext.
            const reason = ev?.data?.reason ?? ev?.reason;
            const note = typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
            log(`⏹ ralph_loop interrupted by session abort${note ? ` (${note})` : ""}.`);
            finish("aborted", note);
        }
    };

    const tools = [
        {
            name: "ralph_loop",
            description:
                "Run a Ralph Wiggum-style autonomous iterative loop. The tool returns immediately after arming the loop; iterations are driven by reacting to each assistant turn_end and re-injecting the prompt as a new user message. Each iteration is a real conversation turn — context is retained, and progress is visible inline. Use ralph_stop to cancel an active loop. Tip: instruct the agent in the prompt to emit the completion_promise (default 'COMPLETE') when finished, otherwise the loop only stops at max_iterations.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description:
                            "The task prompt that gets re-fed each iteration. Should instruct the agent to emit the completion_promise when done.",
                    },
                    max_iterations: {
                        type: "integer",
                        description: `Maximum iterations before stopping (default ${DEFAULTS.max_iterations}, max ${MAX_ALLOWED_ITERATIONS}).`,
                        default: DEFAULTS.max_iterations,
                    },
                    min_iterations: {
                        type: "integer",
                        description: `Minimum iterations before completion_promise / abort_promise are honored (default ${DEFAULTS.min_iterations}). Use this to force the agent to run additional verification passes even if it declares completion early.`,
                        default: DEFAULTS.min_iterations,
                    },
                    completion_promise: {
                        type: "string",
                        description:
                            "Substring that, when present in an assistant turn's response, signals completion (default 'COMPLETE').",
                        default: DEFAULTS.completion_promise,
                    },
                    abort_promise: {
                        type: "string",
                        description:
                            "Optional substring that, when present in an assistant turn's response, aborts the loop early (e.g. when the agent signals a precondition failure).",
                    },
                    stagnation_limit: {
                        type: "integer",
                        description: `Abort if the assistant returns N consecutive byte-identical responses (default ${DEFAULTS.stagnation_limit}, 0 to disable).`,
                        default: DEFAULTS.stagnation_limit,
                    },
                },
                required: ["prompt"],
            },
            handler: async (args) => {
                if (!sessionRef?.send) {
                    return failure(
                        "ralph_loop: session not attached — controller.attach(session) must be called before invoking ralph_loop.",
                    );
                }
                if (state.active) {
                    return failure(
                        `ralph_loop is already running (iteration ${state.active.i}/${state.active.max}). Use ralph_stop first.`,
                    );
                }
                const parsed = validateArgs(args);
                if (parsed.error) return failure(parsed.error);

                state.active = {
                    ...parsed.value,
                    i: 0,
                    prev: null,
                    streak: 0,
                    pendingFire: true,
                    startedAt: Date.now(),
                    lastTurnId: null,
                };
                state.lastAssistantContent = "";
                state.lastResult = null;

                log(
                    `🔁 ralph_loop armed — max=${parsed.value.max}${parsed.value.min > 1 ? `, min=${parsed.value.min}` : ""}, completion='${parsed.value.completionPromise}'${
                        parsed.value.abortPromise ? `, abort='${parsed.value.abortPromise}'` : ""
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
                        description: "Optional human-readable reason for stopping the loop (≤500 chars).",
                    },
                },
            },
            handler: async (args) => {
                if (!state.active) return failure("ralph_stop: no ralph_loop is currently running.");
                const i = state.active.i;
                const max = state.active.max;
                const reason = (args && typeof args === "object" && !Array.isArray(args)) ? args.reason : undefined;
                const note = typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
                finish("user_stopped", note);
                return success(
                    `ralph_loop stopped after ${i}/${max} iterations${note ? ` (${note})` : ""}.`,
                    { iterations: i, note },
                );
            },
        },
    ];
    // Freeze the public tool surface so consumers can't accidentally mutate
    // tool descriptors or swap out handlers (would break the controller and
    // any test that depends on tools[0]).
    for (const t of tools) Object.freeze(t);
    Object.freeze(tools);

    const hooks = Object.freeze({
        onUserPromptSubmitted: async () => {
            if (!state.lastResult) return;
            const r = state.lastResult;
            state.lastResult = null;
            return {
                additionalContext: `[ralph_loop just finished — iterations=${r.iterations}, reason=${r.reason}${r.note ? `, note=${r.note}` : ""}, durationMs=${r.durationMs}]`,
            };
        },
    });

    let currentDetach = null;
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
        const unsubs = [
            session.on("assistant.message", onAssistantMessage),
            session.on("assistant.turn_end", onTurnEnd),
            session.on("abort", onAbort),
        ].filter((fn) => typeof fn === "function");
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
        _internal: { onAssistantMessage, onTurnEnd, onAbort, finish, success, failure },
    };
}

export const __test__ = { DEFAULTS, MAX_ALLOWED_ITERATIONS, PREVIEW_CHARS, previewOf };
