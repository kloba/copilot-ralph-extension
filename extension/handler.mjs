// Pure handler logic for ralph_loop, decoupled from the Copilot SDK so it
// can be unit-tested with a mocked session.

const DEFAULTS = {
    max_iterations: 20,
    completion_promise: "COMPLETE",
    timeout_ms: 600000,
    stagnation_limit: 3,
};

const MAX_ALLOWED_ITERATIONS = 1000;
const MIN_TIMEOUT_MS = 1000;
const PREVIEW_CHARS = 500;

function previewOf(text) {
    if (!text) return "";
    return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "…" : text;
}

function failure(message, extra = {}) {
    return {
        textResultForLlm: message,
        resultType: "failure",
        ...extra,
    };
}

function success(message, extra = {}) {
    return {
        textResultForLlm: message,
        resultType: "success",
        ...extra,
    };
}

export function validateArgs(args) {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) {
        return { error: "ralph_loop: prompt is required and must be non-empty." };
    }

    const rawMax = args.max_iterations ?? DEFAULTS.max_iterations;
    const max = Number(rawMax);
    if (!Number.isInteger(max) || max < 1 || max > MAX_ALLOWED_ITERATIONS) {
        return {
            error: `ralph_loop: max_iterations must be an integer in [1, ${MAX_ALLOWED_ITERATIONS}] (got ${rawMax}).`,
        };
    }

    const rawTimeout = args.timeout_ms ?? DEFAULTS.timeout_ms;
    const timeout = Number(rawTimeout);
    if (!Number.isFinite(timeout) || timeout < MIN_TIMEOUT_MS) {
        return {
            error: `ralph_loop: timeout_ms must be a number ≥ ${MIN_TIMEOUT_MS} (got ${rawTimeout}).`,
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

    return {
        value: {
            prompt,
            max,
            timeout,
            completionPromise,
            abortPromise,
            stagnationLimit,
        },
    };
}

export async function runRalphLoop(session, args) {
    const parsed = validateArgs(args);
    if (parsed.error) {
        return failure(parsed.error);
    }
    const { prompt, max, timeout, completionPromise, abortPromise, stagnationLimit } = parsed.value;

    session.log?.(
        `🔁 ralph_loop starting — max=${max}, completion='${completionPromise}'${
            abortPromise ? `, abort='${abortPromise}'` : ""
        }${stagnationLimit > 0 ? `, stagnation_limit=${stagnationLimit}` : ""}`,
    );

    let lastContent = "";
    let prevContent = null;
    let stagnationStreak = 0;

    for (let i = 1; i <= max; i++) {
        session.log?.(`🔁 ralph_loop iteration ${i}/${max}`);

        let event;
        try {
            event = await session.sendAndWait({ prompt }, timeout);
        } catch (err) {
            const msg = err?.message ?? String(err);
            return failure(
                `ralph_loop: iteration ${i} failed: ${msg}. Stopping.`,
                { iterations: i, reason: "send_error", last_content_preview: previewOf(lastContent) },
            );
        }

        lastContent = event?.data?.content ?? "";

        if (abortPromise && lastContent.includes(abortPromise)) {
            session.log?.(`⏹ ralph_loop aborted after ${i} iterations (abort_promise hit).`);
            return failure(
                `ralph_loop aborted after ${i} iterations: assistant emitted abort_promise '${abortPromise}'.`,
                { iterations: i, reason: "abort_promise", last_content_preview: previewOf(lastContent) },
            );
        }

        if (lastContent.includes(completionPromise)) {
            session.log?.(`✅ ralph_loop completed after ${i} iterations.`);
            return success(
                `ralph_loop completed successfully after ${i} iterations (completion_promise '${completionPromise}' found).`,
                { iterations: i, reason: "completion_promise", last_content_preview: previewOf(lastContent) },
            );
        }

        if (stagnationLimit > 0) {
            if (prevContent !== null && lastContent === prevContent) {
                stagnationStreak += 1;
            } else {
                stagnationStreak = 1;
            }
            if (stagnationStreak >= stagnationLimit) {
                session.log?.(
                    `⏹ ralph_loop aborted after ${i} iterations: ${stagnationStreak} identical responses in a row.`,
                );
                return failure(
                    `ralph_loop aborted after ${i} iterations: ${stagnationStreak} consecutive identical responses (stagnation_limit=${stagnationLimit}). The agent appears to be stuck.`,
                    { iterations: i, reason: "stagnation", last_content_preview: previewOf(lastContent) },
                );
            }
            prevContent = lastContent;
        }
    }

    session.log?.(`⏹ ralph_loop stopped after ${max} iterations without completion_promise.`);
    return failure(
        `ralph_loop stopped after ${max} iterations without completion_promise '${completionPromise}'. Consider increasing max_iterations or revising the prompt to make the agent emit the completion phrase.`,
        { iterations: max, reason: "max_iterations", last_content_preview: previewOf(lastContent) },
    );
}

export const TOOL_SPEC = {
    name: "ralph_loop",
    description:
        "Run a Ralph Wiggum-style iterative loop: re-feed a prompt to this same session until the assistant's response contains the completion_promise string, or until max_iterations is reached. Useful for autonomous coding loops where the agent should keep working until a task is done. The loop runs IN-SESSION so conversation context is retained across iterations. Tip: instruct the agent in the prompt to emit the completion_promise (default 'COMPLETE') when finished, otherwise the loop only stops at max_iterations.",
    parameters: {
        type: "object",
        properties: {
            prompt: {
                type: "string",
                description:
                    "The task prompt to re-feed each iteration. Should instruct the agent to emit the completion_promise when done.",
            },
            max_iterations: {
                type: "integer",
                description: `Maximum iterations before stopping (default ${DEFAULTS.max_iterations}, max ${MAX_ALLOWED_ITERATIONS}).`,
                default: DEFAULTS.max_iterations,
            },
            completion_promise: {
                type: "string",
                description:
                    "Substring that, when present in the assistant's response, signals completion (default 'COMPLETE').",
                default: DEFAULTS.completion_promise,
            },
            abort_promise: {
                type: "string",
                description:
                    "Optional substring that, when present in the assistant's response, aborts the loop early (e.g. when the agent signals a precondition failure).",
            },
            timeout_ms: {
                type: "integer",
                description: `Per-iteration timeout in milliseconds (default ${DEFAULTS.timeout_ms} = 10 min, min ${MIN_TIMEOUT_MS}).`,
                default: DEFAULTS.timeout_ms,
            },
            stagnation_limit: {
                type: "integer",
                description: `Abort if the assistant returns N consecutive byte-identical responses (default ${DEFAULTS.stagnation_limit}, 0 to disable).`,
                default: DEFAULTS.stagnation_limit,
            },
        },
        required: ["prompt"],
    },
};

export const __test__ = { DEFAULTS, MAX_ALLOWED_ITERATIONS, MIN_TIMEOUT_MS, PREVIEW_CHARS };
