import { test } from "node:test";
import assert from "node:assert/strict";

import { createRalphController, validateArgs, __test__ } from "../extension/handler.mjs";

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

let _turnCounter = 0;
function runTurn(session, content) {
    _turnCounter += 1;
    session.emit("assistant.message", { data: { content } });
    session.emit("assistant.turn_end", { data: { turnId: `t${_turnCounter}` } });
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

test("validateArgs: rejects non-string prompt (number, boolean, array, object)", () => {
    assert.match(validateArgs({ prompt: 42 }).error, /prompt must be a string \(got number\)/);
    assert.match(validateArgs({ prompt: false }).error, /prompt must be a string \(got boolean\)/);
    assert.match(validateArgs({ prompt: ["a", "b"] }).error, /prompt must be a string \(got array\)/);
    assert.match(validateArgs({ prompt: { x: 1 } }).error, /prompt must be a string \(got object\)/);
});

test("success/failure helpers: extra cannot override message or resultType", () => {
    const c = createRalphController();
    const f = c._internal.failure("real error", { textResultForLlm: "OVERRIDE", resultType: "success", note: "ok" });
    assert.equal(f.textResultForLlm, "real error");
    assert.equal(f.resultType, "failure");
    assert.equal(f.note, "ok");
    const s = c._internal.success("real ok", { textResultForLlm: "OVERRIDE", resultType: "failure", iterations: 7 });
    assert.equal(s.textResultForLlm, "real ok");
    assert.equal(s.resultType, "success");
    assert.equal(s.iterations, 7);
});

test("validateArgs: rejects bad max_iterations", () => {
    assert.match(validateArgs({ prompt: "x", max_iterations: 0 }).error, /max_iterations/);
    assert.match(validateArgs({ prompt: "x", max_iterations: -1 }).error, /max_iterations/);
    assert.match(validateArgs({ prompt: "x", max_iterations: 1.5 }).error, /max_iterations/);
    assert.match(validateArgs({ prompt: "x", max_iterations: 1001 }).error, /max_iterations/);
    assert.ok(validateArgs({ prompt: "x", max_iterations: 5 }).value);
});

test("validateArgs: rejects empty/whitespace-only completion/abort promise strings", () => {
    assert.match(validateArgs({ prompt: "x", completion_promise: "" }).error, /completion_promise/);
    assert.match(validateArgs({ prompt: "x", completion_promise: "   " }).error, /whitespace-only/);
    assert.match(validateArgs({ prompt: "x", completion_promise: "\t\n" }).error, /whitespace-only/);
    assert.match(validateArgs({ prompt: "x", abort_promise: "" }).error, /abort_promise/);
    assert.match(validateArgs({ prompt: "x", abort_promise: "  " }).error, /whitespace-only/);
});

test("validateArgs: rejects identical completion and abort promise", () => {
    const r = validateArgs({ prompt: "x", completion_promise: "DONE", abort_promise: "DONE" });
    assert.match(r.error, /must differ/);
});

test("validateArgs: rejects substring overlap between completion and abort promises", () => {
    // abort contains completion → completion would always match first
    const r1 = validateArgs({ prompt: "x", completion_promise: "DONE", abort_promise: "DONE_FAIL" });
    assert.match(r1.error, /overlap/);
    // completion contains abort → abort would always match too
    const r2 = validateArgs({ prompt: "x", completion_promise: "ALL_DONE", abort_promise: "DONE" });
    assert.match(r2.error, /overlap/);
    // disjoint phrases pass
    assert.ok(validateArgs({ prompt: "x", completion_promise: "COMPLETE", abort_promise: "ABORT" }).value);
});

test("validateArgs: rejects negative/non-integer/=1 stagnation_limit", () => {
    assert.match(validateArgs({ prompt: "x", stagnation_limit: -1 }).error, /stagnation_limit/);
    assert.match(validateArgs({ prompt: "x", stagnation_limit: 1.5 }).error, /stagnation_limit/);
    assert.match(validateArgs({ prompt: "x", stagnation_limit: 1 }).error, /meaningless/);
    assert.ok(validateArgs({ prompt: "x", stagnation_limit: 0 }).value);
    assert.ok(validateArgs({ prompt: "x", stagnation_limit: 2 }).value);
});

test("validateArgs: rejects boolean/array numerics (no silent type coercion)", () => {
    // Number(true) === 1, Number([5]) === 5 — both would silently coerce
    // through Number()/Number.isInteger() and arm a loop the caller didn't
    // ask for. Reject them at the type-check stage with a clear message.
    for (const bad of [true, false, [5], [], { v: 5 }]) {
        assert.match(validateArgs({ prompt: "x", max_iterations: bad }).error, /max_iterations must be a number/, `max_iterations=${JSON.stringify(bad)}`);
        assert.match(validateArgs({ prompt: "x", min_iterations: bad }).error, /min_iterations must be a number/, `min_iterations=${JSON.stringify(bad)}`);
        assert.match(validateArgs({ prompt: "x", stagnation_limit: bad }).error, /stagnation_limit must be a number/, `stagnation_limit=${JSON.stringify(bad)}`);
    }
    // Numeric strings still accepted (LLM tool callers commonly pass strings).
    assert.ok(validateArgs({ prompt: "x", max_iterations: "5" }).value);
    assert.ok(validateArgs({ prompt: "x", min_iterations: "2", max_iterations: "5" }).value);
    assert.ok(validateArgs({ prompt: "x", stagnation_limit: "0" }).value);
});

test("validateArgs: prompt at exactly MAX_PROMPT_CHARS is accepted (boundary)", () => {
    // Off-by-one guard: the check is `> MAX_PROMPT_CHARS`, so === should pass.
    const atLimit = "x".repeat(__test__.MAX_PROMPT_CHARS);
    const r = validateArgs({ prompt: atLimit });
    assert.ok(r.value, r.error);
    assert.equal(r.value.prompt.length, __test__.MAX_PROMPT_CHARS);
    // One char over → rejected.
    const overLimit = "x".repeat(__test__.MAX_PROMPT_CHARS + 1);
    assert.match(validateArgs({ prompt: overLimit }).error, /exceeds/);
});

test("validateArgs: rejects unknown keys (typo guard)", () => {
    // Common typo for max_iterations — would silently use the default.
    const r1 = validateArgs({ prompt: "x", max_iter: 100 });
    assert.match(r1.error, /unknown argument.*"max_iter"/);
    // Multiple unknowns reported together.
    const r2 = validateArgs({ prompt: "x", foo: 1, bar: 2 });
    assert.match(r2.error, /unknown arguments.*"foo".*"bar"/);
    // Lists valid keys to help the caller fix their call.
    assert.match(r1.error, /Valid keys:.*max_iterations/);
    // All-known keys still pass.
    assert.ok(validateArgs({
        prompt: "x", max_iterations: 5, min_iterations: 1,
        completion_promise: "DONE", abort_promise: "FAIL", stagnation_limit: 0,
    }).value);
});

test("ralph_loop & ralph_stop schemas declare additionalProperties:false (mirrors runtime validation)", () => {
    const c = createRalphController();
    const ralph = c.tools.find((t) => t.name === "ralph_loop");
    const stop = c.tools.find((t) => t.name === "ralph_stop");
    assert.equal(ralph.parameters.additionalProperties, false);
    assert.equal(stop.parameters.additionalProperties, false);
});

// ── tool spec ─────────────────────────────────────────────────────────────

test("controller exposes ralph_loop and ralph_stop tools and hooks", () => {
    const c = createRalphController();
    assert.deepEqual(c.tools.map((t) => t.name).sort(), ["ralph_loop", "ralph_stop"]);
    assert.equal(typeof c.hooks.onUserPromptSubmitted, "function");
    assert.equal(typeof c.attach, "function");
});

test("public tools and hooks surface is frozen (defensive against accidental mutation)", () => {
    const c = createRalphController();
    assert.ok(Object.isFrozen(c.tools));
    assert.ok(Object.isFrozen(c.hooks));
    for (const t of c.tools) assert.ok(Object.isFrozen(t), `${t.name} not frozen`);
    assert.throws(() => { c.tools.push({}); }, TypeError);
    assert.throws(() => { c.tools[0].handler = () => {}; }, TypeError);
    assert.throws(() => { c.hooks.onUserPromptSubmitted = null; }, TypeError);
    // Deep freeze: nested parameters/properties also locked so a consumer
    // can't tweak the declared JSON-schema bounds at runtime.
    const ralphTool = c.tools.find((t) => t.name === "ralph_loop");
    assert.ok(Object.isFrozen(ralphTool.parameters));
    assert.ok(Object.isFrozen(ralphTool.parameters.properties));
    assert.ok(Object.isFrozen(ralphTool.parameters.properties.prompt));
    assert.throws(() => { ralphTool.parameters.properties.prompt.maxLength = 9999; }, TypeError);
});

test("ralph_loop tool spec includes stagnation_limit and required prompt", () => {
    const c = createRalphController();
    const t = c.tools.find((x) => x.name === "ralph_loop");
    assert.ok(t.parameters.properties.stagnation_limit);
    assert.deepEqual(t.parameters.required, ["prompt"]);
});

test("ralph_loop tool spec declares numeric ranges (minimum/maximum) on integer params", () => {
    const c = createRalphController();
    const t = c.tools.find((x) => x.name === "ralph_loop");
    const p = t.parameters.properties;
    // max_iterations: 1..1000
    assert.equal(p.max_iterations.minimum, 1);
    assert.equal(p.max_iterations.maximum, 1000);
    // min_iterations: 1..1000
    assert.equal(p.min_iterations.minimum, 1);
    // stagnation_limit: ≥ 0 (0 disables)
    assert.equal(p.stagnation_limit.minimum, 0);
    // completion_promise / abort_promise: minLength=1 (no empty strings)
    assert.equal(p.completion_promise.minLength, 1);
    assert.equal(p.abort_promise.minLength, 1);
    // prompt: minLength=1, maxLength=65536 (matches MAX_PROMPT_CHARS guard)
    assert.equal(p.prompt.minLength, 1);
    assert.equal(p.prompt.maxLength, 65536);
});

test("ralph_stop tool spec declares maxLength on optional reason", () => {
    const c = createRalphController();
    const t = c.tools.find((x) => x.name === "ralph_stop");
    // Matches PREVIEW_CHARS / truncateNote cap so clients learn the bound up-front.
    assert.equal(t.parameters.properties.reason.maxLength, 500);
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

test("arming twice before first turn_end shows clearer 'armed' message", async () => {
    // Race: ralph_loop called, then ralph_loop called again before any
    // turn_end has fired (state.active.i === 0). The error message used to
    // confusingly say "iteration 0/max"; now it says "armed (iteration 1/max
    // pending …)".
    const { ralph, controller } = await arm({ max_iterations: 7 });
    // No turn_end fired yet — pendingFire is true, i is 0.
    assert.equal(controller.state.active.i, 0);
    assert.equal(controller.state.active.pendingFire, true);
    const r = await ralph.handler({ prompt: "again" });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /already armed/);
    assert.match(r.textResultForLlm, /iteration 1\/7 pending/);
    assert.doesNotMatch(r.textResultForLlm, /iteration 0/);
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

test("validateArgs guards against null/undefined/array args", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const r1 = await c.tools[0].handler(null);
    assert.equal(r1.resultType, "failure");
    assert.match(r1.textResultForLlm, /arguments must be an object \(got null\)/);
    const r2 = await c.tools[0].handler(undefined);
    assert.equal(r2.resultType, "failure");
    assert.match(r2.textResultForLlm, /got undefined/);
    const r3 = await c.tools[0].handler("not-an-object");
    assert.equal(r3.resultType, "failure");
    assert.match(r3.textResultForLlm, /got string/);
    const r4 = await c.tools[0].handler(["prompt"]);
    assert.equal(r4.resultType, "failure");
    assert.match(r4.textResultForLlm, /got array/);
    assert.equal(c.state.active, null);
});

test("prompt length cap: rejects prompts over 64KiB", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const huge = "x".repeat(__test__.MAX_PROMPT_CHARS + 1);
    const r = await c.tools[0].handler({ prompt: huge });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, new RegExp(`exceeds ${__test__.MAX_PROMPT_CHARS} characters`));
    assert.equal(c.state.active, null);
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

test("ralph_stop accepts an optional reason and records it as note", async () => {
    const { stop, controller, session } = await arm({ max_iterations: 5 });
    runTurn(session, "still working");
    const r = await stop.handler({ reason: "user changed plan" });
    assert.equal(r.resultType, "success");
    assert.match(r.textResultForLlm, /user changed plan/);
    assert.equal(controller.state.lastResult.reason, "user_stopped");
    assert.equal(controller.state.lastResult.note, "user changed plan");
});

test("ralph_stop with no active loop returns failure", async () => {
    const c = createRalphController();
    const stop = c.tools.find((t) => t.name === "ralph_stop");
    const r = await stop.handler({});
    assert.equal(r.resultType, "failure");
});

test("ralph_stop tolerates null/undefined/array args without crashing", async () => {
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    // null instead of {} — JS default params don't catch null
    const r = await stop.handler(null);
    assert.equal(r.resultType, "success");
    assert.equal(controller.state.lastResult.reason, "user_stopped");
    assert.equal(controller.state.lastResult.note, undefined);

    // Re-arm and try undefined
    await controller.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t1" } });
    const r2 = await stop.handler(undefined);
    assert.equal(r2.resultType, "success");

    // Array: must not throw, reason just ignored
    await controller.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t2" } });
    const r3 = await stop.handler(["reason"]);
    assert.equal(r3.resultType, "success");
    assert.equal(controller.state.lastResult.note, undefined);
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
    // The underlying error message should be surfaced on the result.
    assert.match(c.state.lastResult.note, /simulated send failure/);
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
    assert.match(c.state.lastResult.note, /simulated async rejection/);
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

test("abort event with reason payload captures it as note on the result", async () => {
    const { session, controller } = await arm({ max_iterations: 10 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "halfway");
    session.emit("abort", { data: { reason: "user pressed Ctrl-C" } });
    assert.equal(controller.state.lastResult.reason, "aborted");
    assert.equal(controller.state.lastResult.note, "user pressed Ctrl-C");
    const joined = session.logs.join("\n");
    assert.match(joined, /interrupted by session abort \(user pressed Ctrl-C\)/);
});

test("abort event falls back to top-level ev.reason when ev.data.reason is absent", async () => {
    // SDKs vary; some put reason at the event root rather than under data.
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    session.emit("abort", { reason: "  network blip  " });
    assert.equal(controller.state.lastResult.reason, "aborted");
    // Whitespace must be trimmed so it lands cleanly in logs / additionalContext.
    assert.equal(controller.state.lastResult.note, "network blip");
});

test("abort event with non-string reason ignores it (no note)", async () => {
    // Defensive: a numeric / object reason must not be stringified into the note.
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    session.emit("abort", { data: { reason: 42 } });
    assert.equal(controller.state.lastResult.reason, "aborted");
    assert.equal(controller.state.lastResult.note, undefined);
});

test("abort event with whitespace-only reason ignores it (no note)", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    session.emit("abort", { data: { reason: "   \t\n  " } });
    assert.equal(controller.state.lastResult.reason, "aborted");
    assert.equal(controller.state.lastResult.note, undefined);
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
    // Injection should be visible in the session log so users can see
    // why the next prompt was rewritten.
    assert.ok(
        session.logs.some((l) => /injecting post-loop context/.test(l)),
        "expected log line announcing the injection",
    );

    const r2 = await controller.hooks.onUserPromptSubmitted({ prompt: "again" });
    assert.equal(r2, undefined);
});

test("onUserPromptSubmitted is a no-op when no loop has finished", async () => {
    const c = createRalphController();
    const r = await c.hooks.onUserPromptSubmitted({ prompt: "anything" });
    assert.equal(r, undefined);
});

test("onUserPromptSubmitted collapses multi-line note into single line", async () => {
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    // Stop with a multi-line reason — note should land on the result, then
    // be flattened inside additionalContext.
    await stop.handler({ reason: "first line\n  second line\n\nthird" });
    const r = await controller.hooks.onUserPromptSubmitted({ prompt: "next" });
    assert.match(r.additionalContext, /note=first line second line third/);
    // Ensure no raw newlines made it into the bracketed context.
    assert.equal(r.additionalContext.includes("\n"), false);
});

test("finish log line collapses multi-line note (single-line timeline marker)", async () => {
    // A note with newlines (e.g. an Error stack from send_error) must not
    // break the timeline log into multiple lines.
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    await stop.handler({ reason: "line1\nline2\n  line3" });
    // Find the finish log entry.
    const finishLog = session.logs.find((l) => /ralph_loop after \d+ iteration/.test(l));
    assert.ok(finishLog, "expected a finish log line");
    assert.equal(finishLog.includes("\n"), false, `finish log contains newline: ${JSON.stringify(finishLog)}`);
    assert.match(finishLog, /note: line1 line2 line3/);
});

// ── content tracking ──────────────────────────────────────────────────────

test("missing assistant.message before turn_end skips refire (queue-bloat protection)", async () => {
    // Without an assistant.message between fires, the SDK is emitting
    // sub-turn boundaries (or similar) faster than the agent picks up our
    // prompt. Refiring would queue duplicate prompts; instead we wait.
    const { session, controller } = await arm({ max_iterations: 3, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } }); // pendingFire → iter 1
    assert.equal(controller.state.active.i, 1);
    assert.equal(session.sent.length, 1);
    session.emit("assistant.turn_end", { data: { turnId: "t1" } }); // skipped (no msg)
    assert.equal(controller.state.active.i, 1, "iter must not advance without assistant.message");
    assert.equal(session.sent.length, 1, "no duplicate prompt queued");
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

    // Now: same scenario but min=3. Iter 1 contains MAGIC but is below min,
    // so iter 2 is fired. A subsequent silent turn_end (no assistant.message)
    // is now treated as a spurious sub-turn boundary and skipped — the loop
    // stays armed waiting for iter 2's real response.
    const { session: s2, controller: c2 } = await arm({
        max_iterations: 5,
        min_iterations: 3,
        completion_promise: "MAGIC",
        stagnation_limit: 0,
    });
    s2.emit("assistant.turn_end", { data: { turnId: "t0" } }); // fire iter 1
    runTurn(s2, "MAGIC at iter 1"); // iter 1 ignored (min=3), fires iter 2
    assert.equal(c2.state.active.i, 2);
    s2.emit("assistant.turn_end", { data: { turnId: "t2" } }); // silent → skipped
    assert.notEqual(c2.state.active, null);
    assert.equal(c2.state.active.i, 2, "silent turn_end must not advance the loop");
    assert.equal(s2.sent.length, 2, "no duplicate prompt queued");
    // lastAssistantContent must still be "" (cleared at iter 2 fire) so that
    // when iter 2's real response arrives it isn't polluted by iter 1's text.
    assert.equal(c2.state.lastAssistantContent, "");
});

test("duplicate turn_end with same turnId is ignored (no double-count)", async () => {
    const { session, controller } = await arm({ max_iterations: 5, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t-init" } }); // fires iter 1
    // Iter 1 produces "step 1"
    session.emit("assistant.message", { data: { content: "step 1" } });
    session.emit("assistant.turn_end", { data: { turnId: "t-iter-1" } }); // i=2, sends iter 2 prompt
    assert.equal(controller.state.active.i, 2);
    assert.equal(session.sent.length, 2);
    // Duplicate emit of the same turnId should be a no-op.
    session.emit("assistant.turn_end", { data: { turnId: "t-iter-1" } });
    assert.equal(controller.state.active.i, 2);
    assert.equal(session.sent.length, 2);
});

test("turn_end with turnId=null is NOT mistaken for duplicate of initial sentinel", async () => {
    // Regression: lastTurnId used to be initialized to null, so the very first
    // turn_end carrying turnId:null would self-match and be dropped, leaving
    // the loop stuck before iter 1 ever fired.
    const { session, controller } = await arm({ max_iterations: 5, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: null } });
    assert.equal(controller.state.active.i, 1, "iter 1 must have armed despite turnId=null");
    assert.equal(session.sent.length, 1, "prompt must have been sent");
});

test("sub-agent turn_end events (agentId set) do not refire — root only", async () => {
    // Regression for the user-reported `Queued (5)` bug: when the root
    // agent invokes sub-agents (task/explore/code-review/rubber-duck),
    // each sub-agent's own assistant.turn_end bubbles up to the session
    // bus. Per the SDK schema, those carry an `agentId` while the root
    // agent's events do not. Refiring on a sub-agent boundary queues
    // duplicate prompts.
    const { session, controller } = await arm({ max_iterations: 10, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } }); // pendingFire → iter 1 sent
    assert.equal(session.sent.length, 1);
    // Root emits a real message so the in-flight gate is cleared.
    session.emit("assistant.message", { data: { content: "thinking…" } });
    // 5 sub-agent turn_ends in a row — must all be ignored.
    for (let k = 0; k < 5; k++) {
        session.emit("assistant.turn_end", {
            agentId: `sub-${k}`,
            data: { turnId: `sub-turn-${k}` },
        });
    }
    assert.equal(session.sent.length, 1, "sub-agent turn_ends must not queue more prompts");
    assert.equal(controller.state.active.i, 1);
    // The root agent's actual turn_end (no agentId) finally fires next iter.
    session.emit("assistant.turn_end", { data: { turnId: "root-1" } });
    assert.equal(controller.state.active.i, 2);
    assert.equal(session.sent.length, 2);
});

test("sub-agent assistant.message content is NOT scanned for completion_promise", async () => {
    // A sub-agent's response containing the completion token must not
    // terminate the root loop early — only the root agent's own message
    // counts.
    const { session, controller } = await arm({
        max_iterations: 5,
        completion_promise: "ALL_DONE",
        stagnation_limit: 0,
    });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } }); // fire iter 1
    // Sub-agent says ALL_DONE — must be ignored.
    session.emit("assistant.message", {
        agentId: "explore-1",
        data: { content: "ALL_DONE from sub-agent" },
    });
    // Root agent emits its own (non-completion) message and turn_end.
    session.emit("assistant.message", { data: { content: "root response" } });
    session.emit("assistant.turn_end", { data: { turnId: "root-1" } });
    assert.notEqual(controller.state.active, null, "loop should still be running");
    assert.equal(controller.state.active.i, 2);
});


test("multiple turn_ends without intervening assistant.message do not bloat queue", async () => {
    // Regression for the user-reported `Queued (3)` bug: when the SDK emits
    // several turn_ends in quick succession (sub-turn boundaries, tool-call
    // events, etc.) before the agent has actually picked up our prompt,
    // each extra turn_end must be skipped rather than queueing another copy.
    const { session, controller } = await arm({ max_iterations: 10, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } }); // pendingFire → iter 1 sent
    assert.equal(session.sent.length, 1);
    // Five spurious turn_ends with no assistant.message in between.
    for (let k = 0; k < 5; k++) {
        session.emit("assistant.turn_end", { data: { turnId: `spurious-${k}` } });
    }
    assert.equal(session.sent.length, 1, "no duplicate prompts queued");
    assert.equal(controller.state.active.i, 1);
    // Once the agent finally responds, the next turn_end advances normally.
    session.emit("assistant.message", { data: { content: "ack" } });
    session.emit("assistant.turn_end", { data: { turnId: "real" } });
    assert.equal(controller.state.active.i, 2);
    assert.equal(session.sent.length, 2);
});

test("multiple assistant.message events in one turn are accumulated", async () => {
    const { session, controller } = await arm({
        max_iterations: 5,
        completion_promise: "ALL_DONE",
        stagnation_limit: 0,
    });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } }); // fire iter 1
    // Iter 1: agent emits TWO messages, completion phrase only in the first.
    session.emit("assistant.message", { data: { content: "first chunk ALL_DONE here" } });
    session.emit("assistant.message", { data: { content: "second chunk follow-up" } });
    session.emit("assistant.turn_end", { data: { turnId: "t1" } });
    // Without accumulation, "ALL_DONE" would have been overwritten by the second
    // message and the loop would not finish. With accumulation it does.
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 1);
});

test("preview is truncated to PREVIEW_CHARS + ellipsis", async () => {
    const { session, controller } = await arm({ max_iterations: 1, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "x".repeat(700));
    assert.equal(controller.state.lastResult.preview.length, 501);
    assert.ok(controller.state.lastResult.preview.endsWith("…"));
});

test("preview does not split UTF-16 surrogate pairs (no lone high surrogate)", async () => {
    // 499 'a's + "🎉" (D83C DF89) + filler. Naive slice(0, 500) would leave
    // a lone high surrogate at index 499.
    const content = "a".repeat(499) + "🎉" + "z".repeat(100);
    const { session, controller } = await arm({ max_iterations: 1, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t-init" } });
    runTurn(session, content);
    const preview = controller.state.lastResult.preview;
    assert.ok(preview.endsWith("…"));
    // No replacement char should appear (would indicate a lone surrogate).
    assert.equal(preview.indexOf("\uFFFD"), -1, "preview contains replacement char");
    // Round-trip via JSON should be loss-less.
    assert.deepEqual(JSON.parse(JSON.stringify(preview)), preview);
});

test("note truncation does not split UTF-16 surrogate pairs", async () => {
    // 499 'a's + "🎉" + filler — same surrogate-edge as preview test, but
    // exercising the note path via ralph_stop reason.
    const longReason = "a".repeat(499) + "🎉" + "z".repeat(100);
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    await stop.handler({ reason: longReason });
    const note = controller.state.lastResult.note;
    assert.equal(note.length <= 500, true);
    assert.equal(note.indexOf("\uFFFD"), -1, "note contains replacement char");
    assert.deepEqual(JSON.parse(JSON.stringify(note)), note);
});

test("ralph_stop caps oversized user-supplied reason in response and result.note", async () => {
    // A pathologically large reason must not balloon the LLM-visible response
    // string nor the structured note field. Both should be ≤ PREVIEW_CHARS.
    const huge = "x".repeat(50_000);
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    const r = await stop.handler({ reason: huge });
    assert.equal(r.resultType, "success");
    // Structured note in tool reply
    assert.ok(r.note, "response should carry note");
    assert.ok(r.note.length <= 500, `r.note.length=${r.note.length} > 500`);
    // Visible text should be the bounded "stopped after … (note)." form,
    // not 50 KiB of x's.
    assert.ok(r.textResultForLlm.length < 1000, `textResultForLlm too long: ${r.textResultForLlm.length}`);
    // Result note matches the visible note
    assert.equal(controller.state.lastResult.note, r.note);
    assert.ok(controller.state.lastResult.note.length <= 500);
});

test("lastAssistantContent is capped at MAX_CONTENT_CHARS (1 MiB)", async () => {
    const { session, controller } = await arm({ max_iterations: 5, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "t-init" } });
    // Emit several 400KB messages within one turn → would be 2 MB+ unbounded.
    for (let i = 0; i < 6; i++) {
        session.emit("assistant.message", { data: { content: String.fromCharCode(65 + i).repeat(400_000) } });
    }
    assert.ok(
        controller.state.lastAssistantContent.length <= __test__.MAX_CONTENT_CHARS,
        `expected lastAssistantContent ≤ ${__test__.MAX_CONTENT_CHARS}, got ${controller.state.lastAssistantContent.length}`,
    );
    // The most recent content (tail) is preserved → completion check still works.
    const lastChar = String.fromCharCode(65 + 5); // 'F'
    assert.ok(
        controller.state.lastAssistantContent.endsWith(lastChar.repeat(1000)),
        "tail should contain the most recent message",
    );
});

test("late send-rejection from a stale arming does NOT poison a freshly-armed loop", async () => {
    // Sequence:
    //  1. Arm loop A1; capture its pending send-promise so we can reject it later.
    //  2. Stop A1 cleanly via ralph_stop. state.active becomes null.
    //  3. Arm loop A2.
    //  4. Late-reject the A1 promise. Without per-arming identity capture, the
    //     rejection handler would call finish('send_error') on A2 and kill it.
    let rejectA1;
    const session = {
        sent: [],
        log: () => {},
        send: (opts) => {
            session.sent.push(opts);
            // First send (A1's): hand-controlled promise. Subsequent sends (A2's
            // arming send): resolve normally.
            if (session.sent.length === 1) {
                return new Promise((_resolve, reject) => { rejectA1 = reject; });
            }
            return Promise.resolve("ok");
        },
        on: (type, handler) => {
            session._h = session._h || new Map();
            if (!session._h.has(type)) session._h.set(type, new Set());
            session._h.get(type).add(handler);
            return () => session._h.get(type).delete(handler);
        },
        emit: (type, payload) => {
            const set = session._h?.get(type);
            if (!set) return;
            for (const h of [...set]) h(payload);
        },
    };
    const controller = createRalphController();
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    const stop = controller.tools.find((t) => t.name === "ralph_stop");

    // A1
    await ralph.handler({ prompt: "first", max_iterations: 5, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "a1-init" } }); // fire iter 1 (the pending-promise send)
    assert.equal(controller.state.active.i, 1);
    await stop.handler({ reason: "manual" });
    assert.equal(controller.state.active, null);

    // A2
    await ralph.handler({ prompt: "second", max_iterations: 5, stagnation_limit: 0 });
    session.emit("assistant.turn_end", { data: { turnId: "a2-init" } });
    const a2 = controller.state.active;
    assert.ok(a2, "A2 should be active");

    // Late rejection of A1's send-promise
    rejectA1(new Error("stale rejection from A1"));
    // Allow the rejection microtask to run.
    await new Promise((r) => setTimeout(r, 0));

    assert.strictEqual(controller.state.active, a2, "A2 must NOT be killed by stale A1 rejection");
    assert.equal(controller.state.lastResult, null, "no result should have been recorded");
});

// ── attach/detach ─────────────────────────────────────────────────────────

test("calling ralph_loop before attach fails fast with a clear error and does NOT arm", async () => {
    const c = createRalphController();
    // No attach() call.
    const r = await c.tools[0].handler({ prompt: "go" });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /session not attached/);
    assert.equal(c.state.active, null, "must not leave armed state behind");
});

test("attach validates session shape (must have send and on)", () => {
    const c = createRalphController();
    assert.throws(() => c.attach(null), /requires a session object/);
    assert.throws(() => c.attach("not-an-object"), /requires a session object/);
    assert.throws(() => c.attach({}), /missing required method 'send/);
    assert.throws(() => c.attach({ send: () => {} }), /missing required method 'on/);
    // valid shape: passes
    const ok = c.attach({ send: () => {}, on: () => () => {} });
    assert.equal(typeof ok, "function");
    ok();
});

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

test("detach during pendingFire records iterations=0 (loop never fired)", async () => {
    // Arm a loop, then detach BEFORE any turn_end fires. The result should
    // honestly report iterations=0 — no iteration ever ran. Previously this
    // was tested only for reason='detached'; this asserts the count too.
    const session = makeFakeSession();
    const c = createRalphController();
    const detach = c.attach(session);
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    assert.equal(c.state.active.pendingFire, true);
    assert.equal(c.state.active.i, 0);
    detach();
    assert.equal(c.state.lastResult.reason, "detached");
    assert.equal(c.state.lastResult.iterations, 0, "no iteration should be reported");
    assert.equal(session.sent.length, 0, "no prompt should have been sent");
    // durationMs is meaningful (≥ 0) even for a 0-iteration result.
    assert.ok(c.state.lastResult.durationMs >= 0);
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

test("attach warns when session.on() returns non-function (listener-leak risk)", () => {
    // SDK contract: session.on(eventName, handler) returns an unsubscribe
    // function. A misbehaving session that returns void / undefined / null
    // / a non-function leaves us with no way to remove the listener — a
    // memory leak. We don't crash, but we MUST log a clear warning per
    // affected event so the integrator can see it.
    const logs = [];
    const session = {
        log: (m) => logs.push(m),
        send: () => Promise.resolve("msg"),
        on: (evName, _handler) => {
            // turn_end returns a proper unsub; the other two violate contract.
            if (evName === "assistant.turn_end") return () => {};
            if (evName === "assistant.message") return undefined;
            if (evName === "abort") return null;
            return undefined;
        },
    };
    const c = createRalphController();
    // Should not throw — just warn.
    const detach = c.attach(session);
    const warnings = logs.filter((l) => /session\.on\(.*\) did not return an unsubscribe/.test(l));
    assert.equal(warnings.length, 2, `expected 2 warnings, got: ${JSON.stringify(logs)}`);
    assert.match(warnings.find((l) => l.includes("assistant.message")) ?? "", /undefined/);
    assert.match(warnings.find((l) => l.includes("abort")) ?? "", /null/);
    // Detach must still be safe to call.
    detach();
});

// ── log progress ──────────────────────────────────────────────────────────

test("double attach without detach: second attach replaces first (no duplicate listeners)", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    const detach1 = c.attach(session);
    // Second attach on the same session — should tear down the first
    // wiring rather than register a duplicate set of listeners.
    const detach2 = c.attach(session);
    assert.notEqual(detach1, detach2);

    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("assistant.turn_end", { data: { turnId: "t1" } });
    // Exactly ONE prompt re-injection — would be 2 if listeners had doubled.
    assert.equal(session.sent.length, 1);
    assert.equal(c.state.active.i, 1);

    detach2();
    // Calling the now-stale detach1 must be a safe no-op: state is gone.
    detach1();
    assert.equal(c.state.active, null);
});

test("stale detach after re-attach does NOT kill the new session's active loop", async () => {
    // Regression: a detach returned by a SUPERSEDED attach() must not call
    // finish('detached') on the controller's currently-active loop.
    const sessionA = makeFakeSession();
    const sessionB = makeFakeSession();
    const c = createRalphController();
    const detachA = c.attach(sessionA);   // wiring #1
    c.attach(sessionB);                   // wiring #2 supersedes #1
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    assert.ok(c.state.active, "loop should be armed on session B");
    detachA();                             // stale — must be a no-op for active state
    assert.ok(c.state.active, "stale detach must NOT have killed the active loop");
    assert.equal(c.state.lastResult, null);
});

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

test("lastResult is frozen so consumers can't mutate the historical record", async () => {
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "all done COMPLETE");
    const r = controller.state.lastResult;
    assert.ok(Object.isFrozen(r));
    assert.throws(() => { r.reason = "tampered"; }, TypeError);
    assert.throws(() => { r.iterations = 999; }, TypeError);
    // Original values intact.
    assert.equal(r.reason, "completion_promise");
});

test("session.log records arming, iter markers, and finish reason", async () => {
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("assistant.turn_end", { data: { turnId: "t0" } });
    runTurn(session, "ok COMPLETE");
    const joined = session.logs.join("\n");
    assert.match(joined, /armed/);
    assert.match(joined, /iter 1\/3 \(elapsed \d+ms\)/);
    assert.match(joined, /completed.*1 iteration/);
});

test("finish log marker differentiates by reason category", async () => {
    // send_error → ⚠️ ended (not ⏹ stopped)
    const session1 = makeFakeSession({ failSend: true });
    const c1 = createRalphController();
    c1.attach(session1);
    await c1.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session1.emit("assistant.turn_end", { data: { turnId: "t0" } });
    assert.match(session1.logs.join("\n"), /⚠️ ended ralph_loop.*reason: send_error/);

    // user_stopped → ⏹ stopped (not ⚠️)
    const { session: s2, stop } = await arm({ max_iterations: 5 });
    s2.emit("assistant.turn_end", { data: { turnId: "t0" } });
    await stop.handler({});
    assert.match(s2.logs.join("\n"), /⏹ stopped ralph_loop.*reason: user_stopped/);
});
