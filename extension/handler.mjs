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

function previewOf(text) {
    if (!text) return "";
    return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "…" : text;
}
function failure(message, extra = {}) {
    return { textResultForLlm: message, resultType: "failure", ...extra };
}
function success(message, extra = {}) {
    return { textResultForLlm: message, resultType: "success", ...extra };
}

export function validateArgs(args) {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) return { error: "ralph_loop: prompt is required and must be non-empty." };

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
        if (typeof args.completion_promise !== "string" || args.completion_promise.length === 0) {
            return { error: "ralph_loop: completion_promise must be a non-empty string." };
        }
        completionPromise = args.completion_promise;
    }

    let abortPromise = null;
    if (args.abort_promise !== undefined && args.abort_promise !== null) {
        if (typeof args.abort_promise !== "string" || args.abort_promise.length === 0) {
            return { error: "ralph_loop: abort_promise, when provided, must be a non-empty string." };
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
    if (!Number.isInteger(stagnationLimit) || stagnationLimit < 0) {
        return {
            error: `ralph_loop: stagnation_limit must be a non-negative integer (got ${rawStagnation}). Use 0 to disable.`,
        };
    }

    return { value: { prompt, max, min, completionPromise, abortPromise, stagnationLimit } };
}

/**
 * Build a Ralph controller. Returns { tools, hooks, attach, state }.
 *
 * Use `tools` and `hooks` directly in `joinSession({ tools, hooks })`.
 * Then call `attach(session)` once with the resolved session to wire up
 * event listeners and bind the session reference used by tool handlers.
 *
 * `attach` returns an unsubscribe function that detaches all listeners.
 */
export function createRalphController() {
    const state = {
        active: null,           // see arming below for shape
        lastAssistantContent: "",
        lastResult: null,       // { reason, iterations, preview }
    };
    let sessionRef = null;

    const log = (msg) => sessionRef?.log?.(msg);
    const sendPrompt = (prompt) => {
        if (!sessionRef?.send) throw new Error("session not attached");
        return sessionRef.send({ prompt });
    };

    const finish = (reason) => {
        if (!state.active) return;
        const result = {
            reason,
            iterations: state.active.i,
            preview: previewOf(state.lastAssistantContent),
        };
        const verb = reason === "completion_promise" ? "✅ completed" : "⏹ stopped";
        log(`${verb} ralph_loop after ${result.iterations} iteration${result.iterations === 1 ? "" : "s"} (reason: ${reason})`);
        state.active = null;
        state.lastResult = result;
    };

    const onAssistantMessage = (ev) => {
        const text = ev?.data?.content;
        if (typeof text === "string") state.lastAssistantContent = text;
    };

    const onTurnEnd = () => {
        const a = state.active;
        if (!a) return;

        // The turn that *called* ralph_loop will end before any iteration runs.
        // Use that first turn_end to fire iteration 1's prompt; only evaluate
        // completion/abort on subsequent turn_ends.
        if (a.pendingFire) {
            a.pendingFire = false;
            a.i = 1;
            log(`🔁 ralph_loop iter 1/${a.max}`);
            try { sendPrompt(a.prompt); }
            catch (err) { log(`ralph_loop: send failed: ${err?.message ?? err}`); finish("send_error"); }
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
        log(`🔁 ralph_loop iter ${a.i}/${a.max}`);
        try { sendPrompt(a.prompt); }
        catch (err) { log(`ralph_loop: send failed: ${err?.message ?? err}`); finish("send_error"); }
    };

    const onAbort = () => {
        if (state.active) {
            log("⏹ ralph_loop interrupted by session abort.");
            finish("aborted");
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
                "Cancel a currently-running ralph_loop. Returns the iteration count at the moment of stop. Returns failure if no loop is active.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                if (!state.active) return failure("ralph_stop: no ralph_loop is currently running.");
                const i = state.active.i;
                const max = state.active.max;
                finish("user_stopped");
                return success(`ralph_loop stopped after ${i}/${max} iterations.`, { iterations: i });
            },
        },
    ];

    const hooks = {
        onUserPromptSubmitted: async () => {
            if (!state.lastResult) return;
            const r = state.lastResult;
            state.lastResult = null;
            return {
                additionalContext: `[ralph_loop just finished — iterations=${r.iterations}, reason=${r.reason}]`,
            };
        },
    };

    function attach(session) {
        sessionRef = session;
        const unsubs = [
            session.on?.("assistant.message", onAssistantMessage),
            session.on?.("assistant.turn_end", onTurnEnd),
            session.on?.("abort", onAbort),
        ].filter((fn) => typeof fn === "function");
        return () => {
            for (const u of unsubs) {
                try { u(); } catch { /* ignore */ }
            }
            sessionRef = null;
        };
    }

    return {
        tools,
        hooks,
        attach,
        state,
        // Exposed for tests so they can drive events deterministically.
        _internal: { onAssistantMessage, onTurnEnd, onAbort, finish },
    };
}

export const __test__ = { DEFAULTS, MAX_ALLOWED_ITERATIONS, PREVIEW_CHARS, previewOf };
