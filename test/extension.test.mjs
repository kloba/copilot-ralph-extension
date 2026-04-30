import { test } from "node:test";
import assert from "node:assert/strict";

import { createRalphController, validateArgs } from "../extension/handler.mjs";

function makeFakeSession({ failSend = false, rejectSend = false } = {}) {
    const sent = [];
    const logs = [];
    const handlers = new Map();
    return {
        sent,
        logs,
        log: (m) => logs.push(m),
        send: (opts) => {
            if (failSend) throw new Error("simulated send failure");
            sent.push(opts);
            if (rejectSend) return Promise.reject(new Error("simulated async rejection"));
            return Promise.resolve("msg-" + sent.length);
        },
        on: (type, handler) => {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type).add(handler);
            return () => handlers.get(type).delete(handler);
        },
        emit: (type, payload) => {
            const set = handlers.get(type);
            if (!set) return;
            for (const h of [...set]) h(payload);
        },
    };
}

function runTurn(session, content) {
    session.emit("assistant.message", { data: { content } });
    session.emit("assistant.turn_end", { data: { turnId: "t" } });
}

async function arm(args = {}) {
    const session = makeFakeSession();
    const controller = createRalphController();
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    const stop = controller.tools.find((t) => t.name === "ralph_stop");
    const armResult = await ralph.handler({ prompt: "go", max_iterations: 5, ...args });
    return { session, controller, ralph, stop, armResult };
}

// ── validation ────────────────────────────────────────────────────────────

test("validateArgs: rejects empty prompt", () => {
    assert.match(validateArgs({}).error, /prompt is required/);
    assert.match(validateArgs({ prompt: "   " }).error, /prompt is required/);
});

test("validateArgs: rejects bad max_iterations", () => {
    assert.match(validateArgs({ prompt: "x", max_iterations: 0 }).error, /max_iterations/);
    assert.match(validateArgs({ prompt: "x", max_iterations: -1 }).error, /max_iterations/);
    assert.match(validateArgs({ prompt: "x", max_iterations: 1.5 }).error, /max_iterations/);
    assert.match(validateArgs({ prompt: "x", max_iterations: 1001 }).error, /max_iterations/);
    assert.ok(validateArgs({ prompt: "x", max_iterations: 5 }).value);
});

test("validateArgs: rejects empty completion/abort promise strings", () => {
    assert.match(validateArgs({ prompt: "x", completion_promise: "" }).error, /completion_promise/);
    assert.match(validateArgs({ prompt: "x", abort_promise: "" }).error, /abort_promise/);
});

test("validateArgs: rejects identical completion and abort promise", () => {
    const r = validateArgs({ prompt: "x", completion_promise: "DONE", abort_promise: "DONE" });
    assert.match(r.error, /must differ/);
});

test("validateArgs: rejects negative/non-integer stagnation_limit", () => {
    assert.match(validateArgs({ prompt: "x", stagnation_limit: -1 }).error, /stagnation_limit/);
    assert.match(validateArgs({ prompt: "x", stagnation_limit: 1.5 }).error, /stagnation_limit/);
    assert.ok(validateArgs({ prompt: "x", stagnation_limit: 0 }).value);
});

// ── tool spec ─────────────────────────────────────────────────────────────

test("controller exposes ralph_loop and ralph_stop tools and hooks", () => {
    const c = createRalphController();
    assert.deepEqual(c.tools.map((t) => t.name).sort(), ["ralph_loop", "ralph_stop"]);
    assert.equal(typeof c.hooks.onUserPromptSubmitted, "function");
    assert.equal(typeof c.attach, "function");
});

test("ralph_loop tool spec includes stagnation_limit and required prompt", () => {
    const c = createRalphController();
    const t = c.tools.find((x) => x.name === "ralph_loop");
    assert.ok(t.parameters.properties.stagnation_limit);
    assert.deepEqual(t.parameters.required, ["prompt"]);
});

// ── arming behaviour ──────────────────────────────────────────────────────

test("arming returns success and does NOT send before first turn_end", async () => {
    const { armResult, session } = await arm();
    assert.equal(armResult.resultType, "success");
    assert.equal(armResult.armed, true);
    assert.equal(session.sent.length, 0);
});

test("arming validates args and rejects without changing state", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const r = await c.tools[0].handler({ prompt: "" });
    assert.equal(r.resultType, "failure");
    assert.equal(c.state.active, null);
});

test("arming twice while active is rejected", async () => {
    const { ralph, controller, session } = await arm();
    runTurn(session, "ack");
    const r = await ralph.handler({ prompt: "again" });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /already running/);
    assert.equal(controller.state.active.i, 1);
});

// ── iteration loop ────────────────────────────────────────────────────────

test("first turn_end after arming fires iter 1 prompt; subsequent turn_ends evaluate", async () => {
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    assert.equal(session.sent.length, 1);
    assert.equal(session.sent[0].prompt, "go");
    assert.equal(controller.state.active.i, 1);

    runTurn(session, "still working");
    assert.equal(session.sent.length, 2);
    assert.equal(controller.state.active.i, 2);
});

test("completion_promise on iteration 1 stops the loop", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "all done COMPLETE");
    assert.equal(controller.state.active, null);
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 1);
    assert.equal(session.sent.length, 1);
});

test("min_iterations: completion_promise ignored before min reached", async () => {
    const { session, controller } = await arm({ max_iterations: 5, min_iterations: 3 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "early COMPLETE 1"); // iter 1: ignored
    assert.equal(controller.state.active !== null, true, "still active after iter 1");
    runTurn(session, "early COMPLETE 2"); // iter 2: ignored
    assert.equal(controller.state.active !== null, true, "still active after iter 2");
    runTurn(session, "now COMPLETE 3"); // iter 3: honored
    assert.equal(controller.state.active, null);
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 3);
    assert.equal(session.sent.length, 3);
});

test("min_iterations: abort_promise also ignored before min", async () => {
    const { session, controller } = await arm({
        max_iterations: 5,
        min_iterations: 2,
        abort_promise: "GIVE_UP",
    });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "GIVE_UP early"); // iter 1: ignored
    assert.equal(controller.state.active !== null, true);
    runTurn(session, "GIVE_UP now"); // iter 2: honored
    assert.equal(controller.state.lastResult.reason, "abort_promise");
    assert.equal(controller.state.lastResult.iterations, 2);
});

test("min_iterations: stagnation still triggers before min (safety override)", async () => {
    const { session, controller } = await arm({
        max_iterations: 10,
        min_iterations: 5,
        stagnation_limit: 2,
    });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "same");
    runTurn(session, "same");
    runTurn(session, "same");
    assert.equal(controller.state.lastResult.reason, "stagnation");
});

test("min_iterations validation: must be >= 1 and <= max_iterations", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    let r = await c.tools[0].handler({ prompt: "x", min_iterations: 0 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /min_iterations/);
    r = await c.tools[0].handler({ prompt: "x", min_iterations: 5, max_iterations: 3 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /min_iterations/);
    r = await c.tools[0].handler({ prompt: "x", min_iterations: 1.5 });
    assert.equal(r.resultType, "failure");
    assert.equal(c.state.active, null);
});

test("completion_promise on iteration 3 stops the loop", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "step 1");
    runTurn(session, "step 2");
    runTurn(session, "yes COMPLETE here");
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 3);
    assert.equal(session.sent.length, 3);
});

test("max_iterations exhaustion finishes with reason=max_iterations", async () => {
    const { session, controller } = await arm({ max_iterations: 2, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "alpha");
    runTurn(session, "beta");
    assert.equal(controller.state.active, null);
    assert.equal(controller.state.lastResult.reason, "max_iterations");
    assert.equal(controller.state.lastResult.iterations, 2);
    assert.equal(session.sent.length, 2);
});

test("abort_promise stops the loop", async () => {
    const { session, controller } = await arm({
        max_iterations: 5,
        abort_promise: "PRECONDITION_FAILED",
    });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "PRECONDITION_FAILED missing config");
    assert.equal(controller.state.lastResult.reason, "abort_promise");
    assert.equal(controller.state.lastResult.iterations, 1);
});

test("stagnation: 3 identical responses trigger stagnation", async () => {
    const { session, controller } = await arm({ max_iterations: 10, stagnation_limit: 3 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "same");
    runTurn(session, "same");
    runTurn(session, "same");
    assert.equal(controller.state.lastResult.reason, "stagnation");
    assert.equal(controller.state.lastResult.iterations, 3);
});

test("stagnation streak resets on different response", async () => {
    const { session, controller } = await arm({ max_iterations: 10, stagnation_limit: 3 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "a");
    runTurn(session, "a");
    runTurn(session, "b");
    runTurn(session, "b");
    runTurn(session, "b");
    assert.equal(controller.state.lastResult.reason, "stagnation");
    assert.equal(controller.state.lastResult.iterations, 5);
});

test("stagnation_limit=0 disables detection", async () => {
    const { session, controller } = await arm({ max_iterations: 4, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "same");
    runTurn(session, "same");
    runTurn(session, "same");
    runTurn(session, "same");
    assert.equal(controller.state.lastResult.reason, "max_iterations");
    assert.equal(controller.state.lastResult.iterations, 4);
});

// ── ralph_stop tool ───────────────────────────────────────────────────────

test("ralph_stop cancels an active loop and reports iteration count", async () => {
    const { session, controller, stop } = await arm({ max_iterations: 10 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "still going");
    runTurn(session, "still going 2");
    const r = await stop.handler({});
    assert.equal(r.resultType, "success");
    assert.equal(r.iterations, 3);
    assert.equal(controller.state.active, null);
    assert.equal(controller.state.lastResult.reason, "user_stopped");
});

test("ralph_stop with no active loop returns failure", async () => {
    const c = createRalphController();
    const stop = c.tools.find((t) => t.name === "ralph_stop");
    const r = await stop.handler({});
    assert.equal(r.resultType, "failure");
});

// ── send error handling ───────────────────────────────────────────────────

test("send throwing during arm fire-out finishes with reason=send_error", async () => {
    const session = makeFakeSession({ failSend: true });
    const c = createRalphController();
    c.attach(session);
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    assert.equal(c.state.active, null);
    assert.equal(c.state.lastResult.reason, "send_error");
});

test("send rejecting asynchronously finishes with reason=send_error", async () => {
    const session = makeFakeSession({ rejectSend: true });
    const c = createRalphController();
    c.attach(session);
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    // give microtasks a tick
    await new Promise((r) => setImmediate(r));
    assert.equal(c.state.active, null);
    assert.equal(c.state.lastResult.reason, "send_error");
});

test("session.log throwing does not crash the controller", async () => {
    const session = makeFakeSession();
    session.log = () => { throw new Error("log failure"); };
    const c = createRalphController();
    c.attach(session);
    const r = await c.tools[0].handler({ prompt: "go", max_iterations: 3 });
    assert.equal(r.resultType, "success");
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    assert.equal(c.state.active.i, 1);
});

// ── abort event ───────────────────────────────────────────────────────────

test("session abort event finishes the loop with reason=aborted", async () => {
    const { session, controller } = await arm({ max_iterations: 10 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "halfway");
    session.emit("abort", {});
    assert.equal(controller.state.active, null);
    assert.equal(controller.state.lastResult.reason, "aborted");
});

test("abort event with no active loop is a no-op", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    session.emit("abort", {});
    assert.equal(c.state.lastResult, null);
});

// ── hook ──────────────────────────────────────────────────────────────────

test("onUserPromptSubmitted injects additionalContext exactly once after a finish", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "COMPLETE done");
    assert.equal(controller.state.lastResult.reason, "completion_promise");

    const r1 = await controller.hooks.onUserPromptSubmitted({ prompt: "next" });
    assert.match(r1.additionalContext, /ralph_loop just finished/);
    assert.match(r1.additionalContext, /reason=completion_promise/);

    const r2 = await controller.hooks.onUserPromptSubmitted({ prompt: "again" });
    assert.equal(r2, undefined);
});

test("onUserPromptSubmitted is a no-op when no loop has finished", async () => {
    const c = createRalphController();
    const r = await c.hooks.onUserPromptSubmitted({ prompt: "anything" });
    assert.equal(r, undefined);
});

// ── content tracking ──────────────────────────────────────────────────────

test("missing assistant.message before turn_end is treated as empty content", async () => {
    const { session, controller } = await arm({ max_iterations: 3, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    session.emit("assistant.turn_end", { data: { turnId: "t1" } });
    assert.equal(controller.state.active.i, 2);
});

test("silent iteration does not carry prior content into completion check (regression)", async () => {
    // Iteration N's content must not be re-evaluated for iteration N+1 if N+1 emits no message.
    const { session, controller } = await arm({
        max_iterations: 5,
        completion_promise: "MAGIC",
        stagnation_limit: 0,
    });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } }); // fire iter 1
    runTurn(session, "MAGIC happens here"); // iter 1 has MAGIC
    // iter 1's eval: contains MAGIC at i=1, min=1 → finishes immediately.
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 1);

    // Now: same scenario but min=3 so iter 1's MAGIC is ignored, then iter 2 is silent.
    const { session: s2, controller: c2 } = await arm({
        max_iterations: 5,
        min_iterations: 3,
        completion_promise: "MAGIC",
        stagnation_limit: 0,
    });
    s2.emit("assistant.turn_end", { data: { turnId: "t0" } }); // fire iter 1
    runTurn(s2, "MAGIC at iter 1"); // iter 1 ignored (min=3), fires iter 2
    s2.emit("assistant.turn_end", { data: { turnId: "t2" } }); // iter 2 silent
    // iter 2: lastAssistantContent must be "", NOT "MAGIC at iter 1" — so not finished yet.
    assert.notEqual(c2.state.active, null);
    assert.equal(c2.state.active.i, 3);
});

test("preview is truncated to PREVIEW_CHARS + ellipsis", async () => {
    const { session, controller } = await arm({ max_iterations: 1, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "x".repeat(700));
    assert.equal(controller.state.lastResult.preview.length, 501);
    assert.ok(controller.state.lastResult.preview.endsWith("…"));
});

// ── attach/detach ─────────────────────────────────────────────────────────

test("attach returns a detach function that unsubscribes listeners and finalizes active loop", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    const detach = c.attach(session);
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    detach();
    // Active loop is finalized with reason=detached
    assert.equal(c.state.active, null);
    assert.equal(c.state.lastResult.reason, "detached");
    // Listeners are unsubscribed: emitting after detach has no effect
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    assert.equal(session.sent.length, 0);
});

test("re-attach with a fresh session after detach starts cleanly", async () => {
    const session1 = makeFakeSession();
    const c = createRalphController();
    const detach1 = c.attach(session1);
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    detach1();
    assert.equal(c.state.lastResult.reason, "detached");

    const session2 = makeFakeSession();
    c.attach(session2);
    const r = await c.tools[0].handler({ prompt: "go again", max_iterations: 3 });
    assert.equal(r.resultType, "success");
    session2.emit("assistant.turn_end", { data: { turnId: "t1" } });
    assert.equal(session2.sent.length, 1);
    assert.equal(c.state.active.i, 1);
});

// ── log progress ──────────────────────────────────────────────────────────

test("result includes durationMs, startedAt, finishedAt", async () => {
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "all done COMPLETE");
    const r = controller.state.lastResult;
    assert.equal(typeof r.startedAt, "number");
    assert.equal(typeof r.finishedAt, "number");
    assert.equal(typeof r.durationMs, "number");
    assert.ok(r.finishedAt >= r.startedAt);
    assert.equal(r.durationMs, r.finishedAt - r.startedAt);
});

test("session.log records arming, iter markers, and finish reason", async () => {
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "ok COMPLETE");
    const joined = session.logs.join("\n");
    assert.match(joined, /armed/);
    assert.match(joined, /iter 1\/3/);
    assert.match(joined, /completed.*1 iteration/);
});
