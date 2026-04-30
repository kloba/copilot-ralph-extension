import { test } from "node:test";
import assert from "node:assert/strict";

import { runRalphLoop, validateArgs, TOOL_SPEC } from "../extension/handler.mjs";

function makeSession(responses, { throwOn = null } = {}) {
    const calls = [];
    const logs = [];
    let i = 0;
    return {
        calls,
        logs,
        log: (msg) => logs.push(msg),
        sendAndWait: async (payload, timeout) => {
            calls.push({ payload, timeout });
            const idx = i++;
            if (throwOn !== null && idx + 1 === throwOn) {
                throw new Error("simulated send failure");
            }
            const content = responses[idx] ?? "";
            return { data: { content } };
        },
    };
}

test("TOOL_SPEC has the expected shape", () => {
    assert.equal(TOOL_SPEC.name, "ralph_loop");
    assert.ok(TOOL_SPEC.parameters.properties.prompt);
    assert.ok(TOOL_SPEC.parameters.properties.stagnation_limit);
    assert.deepEqual(TOOL_SPEC.parameters.required, ["prompt"]);
});

test("validateArgs: rejects empty prompt", () => {
    assert.match(validateArgs({}).error, /prompt is required/);
    assert.match(validateArgs({ prompt: "   " }).error, /prompt is required/);
});

test("validateArgs: rejects bad max_iterations", () => {
    assert.match(validateArgs({ prompt: "x", max_iterations: 0 }).error, /max_iterations/);
    assert.match(validateArgs({ prompt: "x", max_iterations: -1 }).error, /max_iterations/);
    assert.match(validateArgs({ prompt: "x", max_iterations: 1.5 }).error, /max_iterations/);
    assert.match(validateArgs({ prompt: "x", max_iterations: 10001 }).error, /max_iterations/);
    assert.ok(validateArgs({ prompt: "x", max_iterations: 5 }).value);
});

test("validateArgs: rejects bad timeout_ms", () => {
    assert.match(validateArgs({ prompt: "x", timeout_ms: 999 }).error, /timeout_ms/);
    assert.match(validateArgs({ prompt: "x", timeout_ms: "nope" }).error, /timeout_ms/);
    assert.ok(validateArgs({ prompt: "x", timeout_ms: 1000 }).value);
});

test("validateArgs: rejects empty completion/abort promise strings", () => {
    assert.match(validateArgs({ prompt: "x", completion_promise: "" }).error, /completion_promise/);
    assert.match(validateArgs({ prompt: "x", abort_promise: "" }).error, /abort_promise/);
});

test("validateArgs: rejects identical completion and abort promise", () => {
    const r = validateArgs({ prompt: "x", completion_promise: "DONE", abort_promise: "DONE" });
    assert.match(r.error, /must differ/);
});

test("validateArgs: rejects negative stagnation_limit", () => {
    assert.match(validateArgs({ prompt: "x", stagnation_limit: -1 }).error, /stagnation_limit/);
    assert.match(validateArgs({ prompt: "x", stagnation_limit: 1.5 }).error, /stagnation_limit/);
    assert.ok(validateArgs({ prompt: "x", stagnation_limit: 0 }).value);
});

test("runRalphLoop: returns failure for invalid args without calling session", async () => {
    const session = makeSession([]);
    const r = await runRalphLoop(session, { prompt: "" });
    assert.equal(r.resultType, "failure");
    assert.equal(session.calls.length, 0);
});

test("runRalphLoop: completes on first iteration when completion_promise present", async () => {
    const session = makeSession(["all done COMPLETE here"]);
    const r = await runRalphLoop(session, { prompt: "go", max_iterations: 5 });
    assert.equal(r.resultType, "success");
    assert.equal(r.iterations, 1);
    assert.equal(r.reason, "completion_promise");
    assert.equal(session.calls.length, 1);
    assert.match(r.last_content_preview, /COMPLETE/);
});

test("runRalphLoop: completes on later iteration", async () => {
    const session = makeSession(["working", "still working", "yes COMPLETE"]);
    const r = await runRalphLoop(session, { prompt: "go", max_iterations: 5 });
    assert.equal(r.resultType, "success");
    assert.equal(r.iterations, 3);
    assert.equal(session.calls.length, 3);
});

test("runRalphLoop: exhausts max_iterations", async () => {
    const session = makeSession(["a", "b", "c"]);
    const r = await runRalphLoop(session, { prompt: "go", max_iterations: 3, stagnation_limit: 0 });
    assert.equal(r.resultType, "failure");
    assert.equal(r.iterations, 3);
    assert.equal(r.reason, "max_iterations");
    assert.equal(session.calls.length, 3);
});

test("runRalphLoop: hits abort_promise", async () => {
    const session = makeSession(["working", "PRECONDITION_FAILED missing config"]);
    const r = await runRalphLoop(session, {
        prompt: "go",
        max_iterations: 5,
        abort_promise: "PRECONDITION_FAILED",
    });
    assert.equal(r.resultType, "failure");
    assert.equal(r.reason, "abort_promise");
    assert.equal(r.iterations, 2);
});

test("runRalphLoop: detects stagnation (3 identical responses)", async () => {
    const session = makeSession(["same", "same", "same", "same", "same"]);
    const r = await runRalphLoop(session, {
        prompt: "go",
        max_iterations: 10,
        stagnation_limit: 3,
    });
    assert.equal(r.resultType, "failure");
    assert.equal(r.reason, "stagnation");
    assert.equal(r.iterations, 3);
});

test("runRalphLoop: stagnation streak resets on different response", async () => {
    const session = makeSession(["a", "a", "b", "b", "b"]);
    const r = await runRalphLoop(session, {
        prompt: "go",
        max_iterations: 10,
        stagnation_limit: 3,
    });
    assert.equal(r.resultType, "failure");
    assert.equal(r.reason, "stagnation");
    assert.equal(r.iterations, 5);
});

test("runRalphLoop: stagnation_limit=0 disables detection", async () => {
    const session = makeSession(["same", "same", "same", "same"]);
    const r = await runRalphLoop(session, {
        prompt: "go",
        max_iterations: 4,
        stagnation_limit: 0,
    });
    assert.equal(r.resultType, "failure");
    assert.equal(r.reason, "max_iterations");
    assert.equal(r.iterations, 4);
});

test("runRalphLoop: handles sendAndWait throwing", async () => {
    const session = makeSession(["ok", "ok"], { throwOn: 2 });
    const r = await runRalphLoop(session, { prompt: "go", max_iterations: 5 });
    assert.equal(r.resultType, "failure");
    assert.equal(r.reason, "send_error");
    assert.equal(r.iterations, 2);
    assert.match(r.textResultForLlm, /simulated send failure/);
});

test("runRalphLoop: passes prompt and timeout to sendAndWait", async () => {
    const session = makeSession(["COMPLETE"]);
    await runRalphLoop(session, { prompt: "  hello  ", max_iterations: 1, timeout_ms: 2500 });
    assert.equal(session.calls[0].payload.prompt, "hello");
    assert.equal(session.calls[0].timeout, 2500);
});

test("runRalphLoop: last_content_preview is truncated to 500 chars + ellipsis", async () => {
    const long = "x".repeat(600);
    const session = makeSession([long, long, long]);
    const r = await runRalphLoop(session, {
        prompt: "go",
        max_iterations: 3,
        stagnation_limit: 0,
    });
    assert.equal(r.last_content_preview.length, 501);
    assert.ok(r.last_content_preview.endsWith("…"));
});

test("runRalphLoop: works without session.log (optional chaining)", async () => {
    const session = {
        sendAndWait: async () => ({ data: { content: "COMPLETE" } }),
    };
    const r = await runRalphLoop(session, { prompt: "go", max_iterations: 1 });
    assert.equal(r.resultType, "success");
});
