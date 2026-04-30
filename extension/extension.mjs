// Extension: ralph
// Ralph Wiggum iterative loop — re-fires a prompt until completion-promise appears
// or max_iterations is reached. In-session: retains conversation context across iterations.
// Inspired by Anthropic's Ralph Wiggum plugin and Th0rgal/open-ralph-wiggum.

import { joinSession } from "@github/copilot-sdk/extension";

const session = await joinSession({
    tools: [
        {
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
                        description: "Maximum iterations before stopping (default 20).",
                        default: 20,
                    },
                    completion_promise: {
                        type: "string",
                        description:
                            "Substring that, when present in the assistant's response, signals completion (default 'COMPLETE').",
                        default: "COMPLETE",
                    },
                    abort_promise: {
                        type: "string",
                        description:
                            "Optional substring that, when present in the assistant's response, aborts the loop early (e.g. when the agent signals a precondition failure).",
                    },
                    timeout_ms: {
                        type: "integer",
                        description: "Per-iteration timeout in milliseconds (default 600000 = 10 min).",
                        default: 600000,
                    },
                },
                required: ["prompt"],
            },
            handler: async (args) => {
                const max = Math.max(1, Number(args.max_iterations) || 20);
                const completionPromise = args.completion_promise || "COMPLETE";
                const abortPromise = args.abort_promise || null;
                const timeout = Math.max(1000, Number(args.timeout_ms) || 600000);
                const prompt = String(args.prompt || "").trim();

                if (!prompt) {
                    return {
                        textResultForLlm: "ralph_loop: prompt is required and must be non-empty.",
                        resultType: "failure",
                    };
                }

                session.log(
                    `🔁 ralph_loop starting — max=${max}, completion='${completionPromise}'${
                        abortPromise ? `, abort='${abortPromise}'` : ""
                    }`,
                );

                let lastContent = "";
                for (let i = 1; i <= max; i++) {
                    session.log(`🔁 ralph_loop iteration ${i}/${max}`);
                    let event;
                    try {
                        event = await session.sendAndWait({ prompt }, timeout);
                    } catch (err) {
                        return {
                            textResultForLlm: `ralph_loop: iteration ${i} failed: ${
                                err?.message ?? err
                            }. Stopping.`,
                            resultType: "failure",
                        };
                    }

                    lastContent = event?.data?.content ?? "";

                    if (abortPromise && lastContent.includes(abortPromise)) {
                        session.log(`⏹ ralph_loop aborted after ${i} iterations (abort_promise hit).`);
                        return `ralph_loop aborted after ${i} iterations: assistant emitted abort_promise '${abortPromise}'.`;
                    }

                    if (lastContent.includes(completionPromise)) {
                        session.log(`✅ ralph_loop completed after ${i} iterations.`);
                        return `ralph_loop completed successfully after ${i} iterations (completion_promise '${completionPromise}' found).`;
                    }
                }

                session.log(`⏹ ralph_loop stopped after ${max} iterations without completion_promise.`);
                return {
                    textResultForLlm: `ralph_loop stopped after ${max} iterations without completion_promise '${completionPromise}'. Consider increasing max_iterations or revising the prompt to make the agent emit the completion phrase.`,
                    resultType: "failure",
                };
            },
        },
    ],
});
