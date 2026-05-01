import { test } from "node:test";
import assert from "node:assert/strict";

import { createRalphController, validateArgs, __test__ } from "../extension/handler.mjs";
const { MAX_PROMISE_CHARS, MAX_PROMPT_CHARS, MAX_ALLOWED_ITERATIONS, PREVIEW_CHARS, previewOf } = __test__;

function makeFakeSession({ failSend = false, rejectSend = false, sendErrorMessage } = {}) {
    const sent = [];
    const logs = [];
    const handlers = new Map();
    const errMsg = sendErrorMessage ?? null;
    return {
        sent,
        logs,
        log: (m) => logs.push(m),
        send: (opts) => {
            if (failSend) throw new Error(errMsg ?? "simulated send failure");
            sent.push(opts);
            if (rejectSend) return Promise.reject(new Error(errMsg ?? "simulated async rejection"));
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
    session.emit("session.idle", { data: {} });
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
    assert.match(validateArgs({ prompt: "" }).error, /prompt is required/);
});

test("validateArgs: whitespace-only prompt gets a distinct, more actionable error", () => {
    // "prompt is required" is misleading when the prompt was provided —
    // the user almost certainly hit a templating/interpolation bug. A
    // separate message points the agent at the actual layer to fix.
    assert.match(validateArgs({ prompt: "   " }).error, /whitespace-only/);
    assert.match(validateArgs({ prompt: "\t\n" }).error, /whitespace-only/);
});

test("validateArgs: explicit prompt:null is treated as missing (not 'wrong type')", () => {
    // Subtle contract: the SDK may pass `null` for an omitted optional
    // (e.g. some JSON layers normalize undefined → null). We treat it the
    // same as an absent prompt so the error message guides the user toward
    // *providing* a prompt rather than complaining about its type.
    assert.match(validateArgs({ prompt: null }).error, /prompt is required/);
    assert.match(validateArgs({ prompt: undefined }).error, /prompt is required/);
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

test("validateArgs: range error displays empty/string raw values clearly (got \"\")", () => {
    // Bare `${rawMax}` rendered an empty string as a phantom blank
    // — `(got ).` — which looks like a bug in the error message itself.
    // Quote string inputs so the user sees what they actually passed.
    assert.match(validateArgs({ prompt: "x", max_iterations: "" }).error, /\(got ""\)/);
    assert.match(validateArgs({ prompt: "x", max_iterations: "abc" }).error, /\(got "abc"\)/);
    // Numbers stay unquoted (no fake "1.5" string artifact).
    assert.match(validateArgs({ prompt: "x", max_iterations: 1.5 }).error, /\(got 1\.5\)/);
});

test("validateArgs: NaN / Infinity render as themselves, not 'null' (displayValue contract)", () => {
    // displayValue uses String(v) for non-strings specifically so
    // NaN/Infinity surface in the error as `NaN` / `Infinity` instead
    // of JSON.stringify's `null` — which would be a misleading
    // "the value you passed was null" when the user actually passed
    // a non-finite number. A future refactor that switches to
    // JSON.stringify would silently regress this.
    assert.match(validateArgs({ prompt: "x", max_iterations: NaN }).error, /\(got NaN\)/);
    assert.match(validateArgs({ prompt: "x", max_iterations: Infinity }).error, /\(got Infinity\)/);
    assert.match(validateArgs({ prompt: "x", max_iterations: -Infinity }).error, /\(got -Infinity\)/);
    // Same defense for the other numeric fields that go through displayValue.
    assert.match(validateArgs({ prompt: "x", min_iterations: NaN }).error, /\(got NaN\)/);
    assert.match(validateArgs({ prompt: "x", stagnation_limit: NaN }).error, /\(got NaN\)/);
});

test("validateArgs: rejects empty/whitespace-only completion/abort promise strings", () => {
    // Empty string is technically zero-length so it falls into the
    // whitespace branch (trim().length === 0 with no chars to trim).
    assert.match(validateArgs({ prompt: "x", completion_promise: "" }).error, /completion_promise must contain at least one non-whitespace/);
    assert.match(validateArgs({ prompt: "x", completion_promise: "   " }).error, /completion_promise must contain at least one non-whitespace/);
    assert.match(validateArgs({ prompt: "x", completion_promise: "\t\n" }).error, /completion_promise must contain at least one non-whitespace/);
    assert.match(validateArgs({ prompt: "x", abort_promise: "" }).error, /abort_promise.*must contain at least one non-whitespace/);
    assert.match(validateArgs({ prompt: "x", abort_promise: "  " }).error, /abort_promise.*must contain at least one non-whitespace/);
});

test("validateArgs: rejects non-string completion/abort promise with typed error", () => {
    // Splitting non-string vs whitespace-only mirrors the prompt
    // validation: a 42 / [] / {} arg gets a "must be a string (got X)"
    // diagnostic instead of being lumped into the generic
    // "non-empty, non-whitespace-only" message that was previously
    // misleading for type errors.
    assert.match(validateArgs({ prompt: "x", completion_promise: 42 }).error, /completion_promise must be a string \(got number\)/);
    assert.match(validateArgs({ prompt: "x", completion_promise: ["A"] }).error, /completion_promise must be a string \(got array\)/);
    assert.match(validateArgs({ prompt: "x", abort_promise: false }).error, /abort_promise must be a string \(got boolean\)/);
    assert.match(validateArgs({ prompt: "x", abort_promise: { x: 1 } }).error, /abort_promise must be a string \(got object\)/);
});

test("validateArgs: rejects identical completion and abort promise", () => {
    const r = validateArgs({ prompt: "x", completion_promise: "DONE", abort_promise: "DONE" });
    assert.match(r.error, /must differ/);
    // Pin diagnosability: the colliding value MUST appear in the message.
    // When promises come from upstream config / env vars rather than a
    // hand-typed call, surfacing the actual value tells the user *which*
    // signal was duplicated without making them rerun with logging.
    assert.match(r.error, /"DONE"/);
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

test("validateArgs: rejects oversized completion_promise / abort_promise", () => {
    // These signals are substring-matched on every assistant turn's
    // accumulated content; an unbounded length would waste memory and CPU.
    const tooLong = "X".repeat(MAX_PROMISE_CHARS + 1);
    const atLimit = "Y".repeat(MAX_PROMISE_CHARS);
    const r1 = validateArgs({ prompt: "x", completion_promise: tooLong });
    assert.match(r1.error, /completion_promise exceeds/, r1.error);
    assert.match(r1.error, new RegExp(String(MAX_PROMISE_CHARS)));
    const r2 = validateArgs({ prompt: "x", abort_promise: tooLong });
    assert.match(r2.error, /abort_promise exceeds/, r2.error);
    // Exactly at the cap is allowed.
    assert.ok(validateArgs({ prompt: "x", completion_promise: atLimit }).value);
    assert.ok(validateArgs({ prompt: "x", abort_promise: atLimit }).value);
});

test("validateArgs: trims surrounding whitespace from completion_promise / abort_promise", () => {
    // Subtle bug: a copy-paste artifact like `"  COMPLETE\n"` used to be
    // stored verbatim, so the substring match (`text.includes("  COMPLETE\n")`)
    // required exact surrounding whitespace and the loop silently never
    // terminated on a clean `COMPLETE` from the assistant. Trimming makes
    // the signal phrase robust to user padding.
    const r = validateArgs({
        prompt: "go",
        completion_promise: "  DONE\n",
        abort_promise: "\tFAIL  ",
    });
    assert.ok(r.value, r.error);
    assert.equal(r.value.completionPromise, "DONE");
    assert.equal(r.value.abortPromise, "FAIL");

    // Length validation runs against the *original* (pre-trim) string, so a
    // user can't smuggle an oversized promise through with leading spaces.
    const padded = " ".repeat(MAX_PROMISE_CHARS) + "DONE";
    const r2 = validateArgs({ prompt: "go", completion_promise: padded });
    assert.match(r2.error, /completion_promise exceeds/, r2.error);
});

test("validateArgs: identical/overlap check runs AFTER trimming, not before", () => {
    // Subtle: trimming runs first, so promises that look distinct verbatim
    // but collapse to the same trimmed string MUST still be flagged as
    // identical — otherwise a user who pads one signal with whitespace
    // could silently smuggle through an ambiguous pair.
    const collide = validateArgs({
        prompt: "go",
        completion_promise: "  DONE\n",
        abort_promise: "DONE\t",
    });
    assert.match(collide.error, /must differ/, collide.error);

    // Same logic for substring overlap: padded "DONE" vs "DONE_FAIL" should
    // still be caught (post-trim) as overlapping.
    const overlap = validateArgs({
        prompt: "go",
        completion_promise: "  DONE  ",
        abort_promise: "\tDONE_FAIL\n",
    });
    assert.match(overlap.error, /overlap/, overlap.error);
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

test("ralph_loop arm result has the documented shape (textResultForLlm + extras)", async () => {
    // Pin the user-facing arm message so the README's "Result shape"
    // example doesn't drift from reality. This caught one such drift
    // (the trailing "Use ralph_stop to cancel." sentence had been
    // added to the handler but the README example wasn't updated).
    //
    // We don't use the arm() helper here because we need the raw arming
    // return value, not the {session, controller} envelope arm() returns.
    const c = createRalphController();
    c.attach(makeFakeSession());
    const r = await c.tools.find((t) => t.name === "ralph_loop").handler({
        prompt: "go", max_iterations: 20,
    });
    assert.equal(r.resultType, "success");
    assert.equal(r.armed, true);
    assert.equal(r.max, 20);
    assert.equal(r.min, 1);
    assert.equal(
        r.textResultForLlm,
        "ralph_loop armed (max=20). Iterations will run as conversation turns. Use ralph_stop to cancel.",
    );
    // min > 1 path: the text adds ", min=N" inside the parens.
    const c2 = createRalphController();
    c2.attach(makeFakeSession());
    const r2 = await c2.tools.find((t) => t.name === "ralph_loop").handler({
        prompt: "go", max_iterations: 5, min_iterations: 3,
    });
    assert.equal(
        r2.textResultForLlm,
        "ralph_loop armed (max=5, min=3). Iterations will run as conversation turns. Use ralph_stop to cancel.",
    );
    assert.equal(r2.min, 3);
});

test("controller exposes ralph_loop and ralph_stop tools and hooks", () => {
    const c = createRalphController();
    assert.deepEqual(c.tools.map((t) => t.name).sort(), ["ralph_loop", "ralph_stop"]);
    assert.equal(typeof c.hooks.onUserPromptSubmitted, "function");
    assert.equal(typeof c.attach, "function");
    // Pin the EXACT hook surface — if a future change leaks an internal
    // helper into c.hooks (e.g. an onTurnEnd debugging hook), Copilot CLI
    // will treat it as a registered hook and start invoking it. The
    // shipping contract is exactly one hook: onUserPromptSubmitted.
    assert.deepEqual(Object.keys(c.hooks), ["onUserPromptSubmitted"]);
    // Pin the tools-array ORDER: dozens of integration tests in this file
    // index `c.tools[0]` for the ralph_loop handler. A future refactor
    // that reorders the array (e.g. puts ralph_stop first) would break
    // every one of those tests with confusing "wrong tool name" or
    // "missing prompt" failures. Surface the regression with one focused
    // assertion instead of a cascade of cryptic ones.
    assert.equal(c.tools[0].name, "ralph_loop", "tools[0] must be ralph_loop");
    assert.equal(c.tools[1].name, "ralph_stop", "tools[1] must be ralph_stop");
    assert.equal(c.tools.length, 2, "tools array must have exactly two entries");
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
    // Deep-freeze must reach EVERY descriptor — not just `prompt`. A regression
    // where deepFreeze stops at one level of nesting would let consumers bump
    // bounds at runtime (e.g. raise max_iterations.maximum past MAX_ALLOWED_ITERATIONS),
    // silently desynchronizing the declared JSON schema from validateArgs's
    // hardcoded caps. Pin freezing of every property + the `required` array.
    for (const propName of Object.keys(ralphTool.parameters.properties)) {
        const prop = ralphTool.parameters.properties[propName];
        assert.ok(Object.isFrozen(prop), `${propName} schema not frozen`);
    }
    assert.ok(Object.isFrozen(ralphTool.parameters.required));
    assert.throws(() => { ralphTool.parameters.required.push("max_iterations"); }, TypeError);
    assert.throws(() => { ralphTool.parameters.properties.max_iterations.maximum = 999999; }, TypeError);
    // ralph_stop tool surface is also frozen (same defensive contract).
    const stopTool = c.tools.find((t) => t.name === "ralph_stop");
    assert.ok(Object.isFrozen(stopTool.parameters));
    assert.ok(Object.isFrozen(stopTool.parameters.properties));
    assert.throws(() => { stopTool.parameters.properties.reason.maxLength = 9999; }, TypeError);
});

test("DEFAULTS object is frozen — defaults cannot be mutated at runtime", () => {
    // DEFAULTS is the single source of truth for default arg values across
    // validateArgs (lines 196/207/218/261), the JSON schema's `default`
    // hints, and the on-arm log line. A consumer mutating it (e.g.
    // `__test__.DEFAULTS.max_iterations = 9999`) would silently change
    // validation behavior for the rest of the process, bypassing the
    // hardcoded MAX_ALLOWED_ITERATIONS cap. Freeze prevents that.
    const { DEFAULTS } = __test__;
    assert.ok(Object.isFrozen(DEFAULTS));
    assert.throws(() => { DEFAULTS.max_iterations = 9999; }, TypeError);
    assert.throws(() => { DEFAULTS.completion_promise = "X"; }, TypeError);
    // Sanity-check the actual values so a refactor that swaps the freeze in
    // can't simultaneously change a default without surfacing here.
    assert.equal(DEFAULTS.max_iterations, 20);
    assert.equal(DEFAULTS.min_iterations, 1);
    assert.equal(DEFAULTS.completion_promise, "COMPLETE");
    assert.equal(DEFAULTS.stagnation_limit, 3);
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
    // max_iterations: 1..MAX_ALLOWED_ITERATIONS — bound to the runtime cap
    // so a future bump to MAX_ALLOWED_ITERATIONS automatically widens the
    // schema (or, if missed, fails this test loudly instead of silently
    // letting the schema advertise a stale ceiling).
    assert.equal(p.max_iterations.minimum, 1);
    assert.equal(p.max_iterations.maximum, MAX_ALLOWED_ITERATIONS);
    // min_iterations: same bound (validateArgs further constrains to <= max)
    assert.equal(p.min_iterations.minimum, 1);
    assert.equal(p.min_iterations.maximum, MAX_ALLOWED_ITERATIONS);
    // stagnation_limit: ≥ 0 (0 disables) AND not: const 1 (runtime rejects 1
    // because no comparison is possible after a single response — schema
    // guard surfaces this constraint to LLM clients up front).
    assert.equal(p.stagnation_limit.minimum, 0);
    assert.deepEqual(p.stagnation_limit.not, { const: 1 });
    // completion_promise / abort_promise: minLength=1 + maxLength locked
    // to MAX_PROMISE_CHARS so a runtime cap change ripples to the schema.
    assert.equal(p.completion_promise.minLength, 1);
    assert.equal(p.completion_promise.maxLength, MAX_PROMISE_CHARS);
    assert.equal(p.abort_promise.minLength, 1);
    assert.equal(p.abort_promise.maxLength, MAX_PROMISE_CHARS);
    // prompt: minLength=1, maxLength locked to MAX_PROMPT_CHARS guard
    assert.equal(p.prompt.minLength, 1);
    assert.equal(p.prompt.maxLength, MAX_PROMPT_CHARS);
});

test("ralph_stop tool spec declares maxLength on optional reason", () => {
    const c = createRalphController();
    const t = c.tools.find((x) => x.name === "ralph_stop");
    // Locked to PREVIEW_CHARS / truncateNote cap so clients learn the bound up-front
    // and a runtime cap change automatically updates the schema.
    assert.equal(t.parameters.properties.reason.maxLength, PREVIEW_CHARS);
});

test("schema `default` fields stay in lockstep with the DEFAULTS source-of-truth", () => {
    // The JSON schema advertises defaults to LLM clients via
    // `parameters.properties.X.default`. validateArgs reads them from the
    // runtime DEFAULTS object. If these drift (e.g. someone bumps
    // DEFAULTS.max_iterations from 20 to 50 but forgets the schema), the
    // LLM sees one number and the runtime applies another — the user gets
    // mysterious "expected default" surprises. Pin the equality.
    const c = createRalphController();
    const p = c.tools.find((x) => x.name === "ralph_loop").parameters.properties;
    const { DEFAULTS } = __test__;
    assert.equal(p.max_iterations.default, DEFAULTS.max_iterations);
    assert.equal(p.min_iterations.default, DEFAULTS.min_iterations);
    assert.equal(p.completion_promise.default, DEFAULTS.completion_promise);
    assert.equal(p.stagnation_limit.default, DEFAULTS.stagnation_limit);
    // abort_promise has no default (it's optional with no implicit fallback).
    assert.equal(p.abort_promise.default, undefined);
    // prompt is required, so no default field is appropriate.
    assert.equal(p.prompt.default, undefined);
});

test("tool parameters round-trip through JSON.stringify without losing fields", () => {
    // Some hosts ship the tool spec to remote LLM endpoints by serializing
    // it as JSON. A non-JSON-serializable value (Symbol, BigInt, Function,
    // undefined) sneaking into a schema would silently disappear on the
    // wire and the LLM would see a constraint-less spec. Round-trip each
    // tool's parameters and require the deserialized copy to deep-equal
    // the original, so any non-JSON value gets caught at test time.
    const c = createRalphController();
    for (const t of c.tools) {
        const round = JSON.parse(JSON.stringify(t.parameters));
        assert.deepEqual(round, t.parameters, `${t.name}.parameters must be JSON-serializable without loss`);
    }
});

test("ralph_loop tool description matches the actual refire trigger (session.idle)", () => {
    // Pin the user-facing description so a future refactor that changes the
    // event we listen on (or vice-versa, that re-introduces a stale "turn_end"
    // mention) is caught by tests rather than mis-informing tool consumers.
    // The earlier description still claimed "assistant turn_end" long after
    // the implementation switched to session.idle.
    const c = createRalphController();
    const t = c.tools.find((x) => x.name === "ralph_loop");
    assert.match(t.description, /session\.idle/, "description must mention session.idle");
    assert.doesNotMatch(t.description, /turn_end/, "description must not mention the obsolete turn_end trigger");
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
    const { ralph, controller, session } = await arm({ max_iterations: 9 });
    runTurn(session, "ack");
    const r = await ralph.handler({ prompt: "again" });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /already running/);
    // Mirror the "already armed" test: pin the iteration counter format
    // ("iteration N/max") so a regression that renders 0 / drops the
    // counter / shows max as a different number is caught loudly. After
    // one runTurn we're on iteration 1 of 9.
    assert.match(r.textResultForLlm, /iteration 1\/9/);
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
    session.emit("session.idle", { data: {} });
    assert.equal(session.sent.length, 1);
    assert.equal(session.sent[0].prompt, "go");
    assert.equal(controller.state.active.i, 1);

    runTurn(session, "still working");
    assert.equal(session.sent.length, 2);
    assert.equal(controller.state.active.i, 2);
});

test("completion_promise on iteration 1 stops the loop", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "all done COMPLETE");
    assert.equal(controller.state.active, null);
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 1);
    assert.equal(session.sent.length, 1);
});

test("min_iterations: completion_promise ignored before min reached", async () => {
    const { session, controller } = await arm({ max_iterations: 5, min_iterations: 3 });
    session.emit("session.idle", { data: {} });
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
    session.emit("session.idle", { data: {} });
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
    session.emit("session.idle", { data: {} });
    runTurn(session, "same");
    runTurn(session, "same");
    runTurn(session, "same");
    assert.equal(controller.state.lastResult.reason, "stagnation");
});

test("min_iterations === max_iterations: completion at iter N wins over max cap", async () => {
    // Boundary: when min === max, the very FIRST iteration eligible for the
    // completion check is also the LAST iteration overall. The decision
    // ladder runs completion BEFORE the max cap, so an agent that emits the
    // promise on iter N must finish "completion_promise", not
    // "max_iterations". This pins the `>=` (vs `>`) comparison in the min
    // gate AND the ladder ordering at a single tight boundary.
    const { session, controller } = await arm({
        max_iterations: 3,
        min_iterations: 3,
    });
    session.emit("session.idle", { data: {} });
    runTurn(session, "still working");        // iter 1: i < min, skip
    runTurn(session, "still working");        // iter 2: i < min, skip
    runTurn(session, "all done COMPLETE");    // iter 3: i >= min, completion fires
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 3);
});

test("min_iterations === max_iterations: no completion phrase still hits max cap exactly", async () => {
    // Same boundary, the other branch: if iter N runs without the promise,
    // the max cap fires on the SAME idle and reports `max_iterations` with
    // iterations === min === max (no off-by-one — N+1 iterations would
    // mean the gate let an extra fire through past the cap). Disable
    // stagnation so identical filler text doesn't pre-empt the max check.
    const { session, controller } = await arm({
        max_iterations: 3,
        min_iterations: 3,
        stagnation_limit: 0,
    });
    session.emit("session.idle", { data: {} });
    runTurn(session, "still working");
    runTurn(session, "still working");
    runTurn(session, "still working");
    assert.equal(controller.state.lastResult.reason, "max_iterations");
    assert.equal(controller.state.lastResult.iterations, 3);
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
    session.emit("session.idle", { data: {} });
    runTurn(session, "step 1");
    runTurn(session, "step 2");
    runTurn(session, "yes COMPLETE here");
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 3);
    assert.equal(session.sent.length, 3);
});

test("max_iterations exhaustion finishes with reason=max_iterations", async () => {
    const { session, controller } = await arm({ max_iterations: 2, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} });
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
    session.emit("session.idle", { data: {} });
    runTurn(session, "PRECONDITION_FAILED missing config");
    assert.equal(controller.state.lastResult.reason, "abort_promise");
    assert.equal(controller.state.lastResult.iterations, 1);
});

test("stagnation: 3 identical responses trigger stagnation", async () => {
    const { session, controller } = await arm({ max_iterations: 10, stagnation_limit: 3 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "same");
    runTurn(session, "same");
    runTurn(session, "same");
    assert.equal(controller.state.lastResult.reason, "stagnation");
    assert.equal(controller.state.lastResult.iterations, 3);
});

test("stagnation streak resets on different response", async () => {
    const { session, controller } = await arm({ max_iterations: 10, stagnation_limit: 3 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "a");
    runTurn(session, "a");
    runTurn(session, "b");
    runTurn(session, "b");
    runTurn(session, "b");
    assert.equal(controller.state.lastResult.reason, "stagnation");
    assert.equal(controller.state.lastResult.iterations, 5);
});

test("completion_promise wins over max_iterations when both could fire on same idle (boundary)", async () => {
    // Decision ladder runs completion check BEFORE max check. If the agent
    // emits the completion phrase on the very iteration where i == max, the
    // loop must report `completion_promise`, not `max_iterations` — the agent
    // *did* finish, the cap just happened to coincide.
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "still going");
    runTurn(session, "still going");
    runTurn(session, "all done COMPLETE");
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 3);
});

test("completion_promise wins over abort_promise when both substrings are present", async () => {
    // Decision ladder checks completion BEFORE abort. If the agent's final
    // message happens to contain both phrases (e.g. "DONE — would have
    // emitted FAIL but recovered"), the loop must report `completion_promise`
    // rather than `abort_promise`. Success takes precedence over abort.
    const { session, controller } = await arm({
        max_iterations: 5,
        completion_promise: "DONE",
        abort_promise: "FAIL",
    });
    session.emit("session.idle", { data: {} });
    runTurn(session, "recovered after FAIL — DONE");
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 1);
});

test("abort_promise wins over stagnation when both fire on same idle", async () => {
    // For a stagnation streak to be at limit, the current text must equal
    // prev — which means prev *also* contained the abort phrase. With min=2
    // we force the first abort-bearing iteration past the gate AND also
    // satisfy the streak; ladder must finish `abort_promise`, not
    // `stagnation`. Pin so a future ladder reorder can't silently relabel
    // a clean abort as "stuck".
    const { session, controller } = await arm({
        max_iterations: 10,
        min_iterations: 2,
        abort_promise: "FAIL",
        stagnation_limit: 2,
    });
    session.emit("session.idle", { data: {} });
    runTurn(session, "FAIL hit");
    runTurn(session, "FAIL hit");
    assert.equal(controller.state.lastResult.reason, "abort_promise");
    assert.equal(controller.state.lastResult.iterations, 2);
});

test("stagnation_limit=0 disables detection", async () => {
    const { session, controller } = await arm({ max_iterations: 4, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "same");
    runTurn(session, "same");
    runTurn(session, "same");
    runTurn(session, "same");
    assert.equal(controller.state.lastResult.reason, "max_iterations");
    assert.equal(controller.state.lastResult.iterations, 4);
});

test("stagnation: two identical empty-string responses trigger stagnation (silent-agent detector)", async () => {
    // Subtle: prev/streak compares text values, so an agent that
    // returns content:"" on every turn (a sub-agent error returning
    // an empty final message, a weird streaming edge that emits a
    // single empty chunk, etc.) is genuinely stagnating — repeating
    // the same empty content. Stagnation must catch this and finish
    // the loop rather than cycling at max_iterations.
    //
    // Note this is distinct from "no assistant.message at all" — that
    // path is blocked earlier by the queue-bloat guard (fireInFlight
    // && !observedMessageThisFire) and never reaches stagnation. The
    // empty-CONTENT case DOES flip observedMessageThisFire (pinned
    // elsewhere) so the loop advances and stagnation can compare.
    const { session, controller } = await arm({ max_iterations: 10, stagnation_limit: 2 });
    session.emit("session.idle", { data: {} }); // fire iter 1
    runTurn(session, ""); // iter 1 response: empty
    runTurn(session, ""); // iter 2 response: empty → streak hits 2
    assert.equal(controller.state.lastResult.reason, "stagnation");
    assert.equal(controller.state.lastResult.iterations, 2);
});

// ── ralph_stop tool ───────────────────────────────────────────────────────

test("ralph_stop cancels an active loop and reports iteration count", async () => {
    const { session, controller, stop } = await arm({ max_iterations: 10 });
    session.emit("session.idle", { data: {} });
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

test("ralph_stop with empty/whitespace-only reason silently drops it (note=undefined)", async () => {
    // The note path requires `reason.trim()` to be non-empty (handler.mjs
    // ~line 634). An empty-string or whitespace-only reason is treated
    // the same as omitting it: loop stops, no note attached, no quote
    // appended to the user-facing message. This mirrors the abort-event
    // handler's whitespace-only reason guard so callers see consistent
    // behavior across both stop paths.
    const cases = ["", " ", "   ", "\t\n", "\u00A0\u00A0"];
    for (const reason of cases) {
        const { stop, controller, session } = await arm({ max_iterations: 5 });
        const r = await stop.handler({ reason });
        assert.equal(r.resultType, "success", `reason=${JSON.stringify(reason)}: expected success`);
        assert.equal(r.note, undefined, `reason=${JSON.stringify(reason)}: structured note must be undefined`);
        assert.doesNotMatch(r.textResultForLlm, /\(\s*\)/, "user-facing text must not show empty '(...)' note suffix");
        assert.equal(controller.state.lastResult.reason, "user_stopped");
        assert.equal(controller.state.lastResult.note, undefined);
        // Detach for next iteration
        session.emit("session.idle", { data: {} });
    }
});

test("ralph_stop with non-string reason silently drops it (note=undefined, loop still stops)", async () => {
    // ralph_stop's `reason` arg accepts the loose contract "string or
    // missing"; passing a number / object / array is treated the same
    // as omitting it. This is intentional leniency — a buggy caller
    // that miscoerces should still be able to stop the loop rather
    // than wedging it. Lock in the contract so a future tightening
    // (e.g. rejecting non-string loudly) is a deliberate decision.
    const { stop, controller } = await arm({ max_iterations: 5 });
    const r = await stop.handler({ reason: 42 });
    assert.equal(r.resultType, "success");
    assert.equal(r.note, undefined, "non-string reason must NOT be coerced into the note");
    assert.doesNotMatch(r.textResultForLlm, /\(42\)/, "the numeric value must not leak into the user-facing message");
    assert.equal(controller.state.lastResult.reason, "user_stopped");
    assert.equal(controller.state.lastResult.note, undefined);
    assert.equal(controller.state.active, null);
});

test("ralph_stop rejects unknown keys (typo guard, mirrors ralph_loop)", async () => {
    // Without this, `ralph_stop({ resaon: "..." })` would silently drop
    // the user's note instead of surfacing it. The active loop must
    // remain untouched on validation failure (no premature finish()).
    const { stop, controller } = await arm({ max_iterations: 5 });
    const r = await stop.handler({ resaon: "typo" });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /unknown argument/);
    assert.match(r.textResultForLlm, /"resaon"/);
    assert.match(r.textResultForLlm, /Valid keys: reason/);
    assert.notEqual(controller.state.active, null, "loop must not be stopped when validation fails");
    // A correctly-spelled call still works.
    const ok = await stop.handler({ reason: "ok" });
    assert.equal(ok.resultType, "success");
    assert.equal(controller.state.lastResult.note, "ok");
});

test("ralph_stop with no active loop returns failure", async () => {
    const c = createRalphController();
    const stop = c.tools.find((t) => t.name === "ralph_stop");
    const r = await stop.handler({});
    assert.equal(r.resultType, "failure");
});

test("ralph_stop with no active loop reports 'no loop' even if args have a typo", async () => {
    // Priority pin: when no loop is active, the "nothing to stop" error
    // takes precedence over the unknown-arg shape error. The typo is
    // moot if there's nothing to act on, and reporting the validation
    // error first would confuse callers ("did my stop land or not?").
    // Pin this priority so a future refactor that hoists validateArgShape
    // above the active-check doesn't silently flip the message order.
    const c = createRalphController();
    const stop = c.tools.find((t) => t.name === "ralph_stop");
    const r = await stop.handler({ resaon: "typo" });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /no ralph_loop is currently running/);
    assert.doesNotMatch(r.textResultForLlm, /unknown argument/);
});

test("ralph_stop tolerates null/undefined args; rejects array shape loudly", async () => {
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    // null instead of {} — JS default params don't catch null
    const r = await stop.handler(null);
    assert.equal(r.resultType, "success");
    assert.equal(controller.state.lastResult.reason, "user_stopped");
    assert.equal(controller.state.lastResult.note, undefined);

    // Re-arm and try undefined
    await controller.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    const r2 = await stop.handler(undefined);
    assert.equal(r2.resultType, "success");

    // Array: rejected loudly (mirrors ralph_loop's shape guard) so a caller
    // who passed e.g. ["reason"] gets a clear error instead of silently
    // stopping with no note.
    await controller.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    const r3 = await stop.handler(["reason"]);
    assert.equal(r3.resultType, "failure");
    assert.match(r3.textResultForLlm, /arguments must be an object \(got array\)/);
    assert.notEqual(controller.state.active, null, "loop must remain active on validation failure");

    // Non-object primitive: also rejected loudly.
    const r4 = await stop.handler("done");
    assert.equal(r4.resultType, "failure");
    assert.match(r4.textResultForLlm, /arguments must be an object \(got string\)/);
});

// ── send error handling ───────────────────────────────────────────────────

test("send throwing during arm fire-out finishes with reason=send_error", async () => {
    const session = makeFakeSession({ failSend: true });
    const c = createRalphController();
    c.attach(session);
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    assert.equal(c.state.active, null);
    assert.equal(c.state.lastResult.reason, "send_error");
    // Prefix `send failed: ` distinguishes the sync-throw path from the
    // async-rejection path (`send rejected: `) for diagnosability.
    assert.match(c.state.lastResult.note, /^send failed: simulated send failure$/);
});

test("send rejecting asynchronously finishes with reason=send_error", async () => {
    const session = makeFakeSession({ rejectSend: true });
    const c = createRalphController();
    c.attach(session);
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    // give microtasks a tick
    await new Promise((r) => setImmediate(r));
    assert.equal(c.state.active, null);
    assert.equal(c.state.lastResult.reason, "send_error");
    // Prefix `send rejected: ` (note: ≠ `send failed:` for the sync path)
    // tells the operator the failure surfaced as an async promise rejection
    // rather than a thrown exception inside session.send().
    assert.match(c.state.lastResult.note, /^send rejected: simulated async rejection$/);
});

test("send_error log line bounded for oversized err.message (sync and async paths)", async () => {
    // Mirror of the abort-log-bound test: pre-finish log line must not
    // dump megabytes into the timeline if err.message is pathological.
    // Exercises BOTH the sync-throw branch and the async-rejection branch.
    const huge = "Q".repeat(50_000);
    for (const opts of [{ failSend: true, sendErrorMessage: huge }, { rejectSend: true, sendErrorMessage: huge }]) {
        const session = makeFakeSession(opts);
        const c = createRalphController();
        c.attach(session);
        await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
        session.emit("session.idle", { data: {} });
        await new Promise((r) => setImmediate(r));
        const errLog = session.logs.find((l) => /send (failed|rejected):/.test(l));
        assert.ok(errLog, `expected send-error log line for opts=${JSON.stringify(Object.keys(opts))}`);
        assert.ok(errLog.length < PREVIEW_CHARS + 200, `send-error log too long: ${errLog.length}`);
        // result.note still carries the full prefixed (truncated) form.
        assert.match(c.state.lastResult.note, /^send (failed|rejected): /);
        assert.ok(c.state.lastResult.note.length <= PREVIEW_CHARS + "send rejected: ".length);
    }
});

test("session.log throwing does not crash the controller", async () => {
    const session = makeFakeSession();
    session.log = () => { throw new Error("log failure"); };
    const c = createRalphController();
    c.attach(session);
    const r = await c.tools[0].handler({ prompt: "go", max_iterations: 3 });
    assert.equal(r.resultType, "success");
    session.emit("session.idle", { data: {} });
    assert.equal(c.state.active.i, 1);
});

// ── abort event ───────────────────────────────────────────────────────────

test("session abort event finishes the loop with reason=aborted", async () => {
    const { session, controller } = await arm({ max_iterations: 10 });
    session.emit("session.idle", { data: {} });
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
    session.emit("session.idle", { data: {} });
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
    session.emit("session.idle", { data: {} });
    session.emit("abort", { reason: "  network blip  " });
    assert.equal(controller.state.lastResult.reason, "aborted");
    // Whitespace must be trimmed so it lands cleanly in logs / additionalContext.
    assert.equal(controller.state.lastResult.note, "network blip");
});

test("abort event with non-string reason ignores it (no note)", async () => {
    // Defensive: a numeric / object reason must not be stringified into the note.
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    session.emit("abort", { data: { reason: 42 } });
    assert.equal(controller.state.lastResult.reason, "aborted");
    assert.equal(controller.state.lastResult.note, undefined);
});

test("abort event with whitespace-only reason ignores it (no note)", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    session.emit("abort", { data: { reason: "   \t\n  " } });
    assert.equal(controller.state.lastResult.reason, "aborted");
    assert.equal(controller.state.lastResult.note, undefined);
});

test("abort event with oversized reason truncates BOTH the log line and result.note", async () => {
    // A pathological abort reason (an entire stack trace, a huge SDK
    // payload, etc.) must not dump megabytes into the session log nor
    // into the structured note. result.note has been truncated all
    // along (via finish() → truncateNote); the abort log line was
    // previously printing the raw value uncapped — pin both bounds.
    const huge = "Z".repeat(50_000);
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    session.emit("abort", { data: { reason: huge } });
    assert.equal(controller.state.lastResult.reason, "aborted");
    assert.ok(controller.state.lastResult.note.length <= PREVIEW_CHARS);
    const abortLog = session.logs.find((l) => /interrupted by session abort/.test(l));
    assert.ok(abortLog, "expected abort log line");
    // Wrapper text "⏹ ralph_loop interrupted by session abort (…)." adds
    // ~50 chars; PREVIEW_CHARS + a generous slack still rules out 50KB.
    assert.ok(abortLog.length < PREVIEW_CHARS + 200, `abort log too long: ${abortLog.length}`);
});

test("calling ralph_stop immediately after arm (before any session.idle) finishes with iterations=0", async () => {
    // Arm but never emit session.idle — so the loop never even gets to
    // iteration 1. ralph_stop must still be able to clean up cleanly,
    // and the recorded iteration count must reflect reality (0), not
    // the user-facing "iter 1/max" label that pre-fire arming uses
    // for the "already armed" error message.
    const { controller, stop } = await arm({ max_iterations: 5 });
    const r = await stop.handler({ reason: "armed but never fired" });
    assert.equal(r.resultType, "success");
    assert.match(r.textResultForLlm, /stopped after 0\/5 iterations/);
    assert.equal(controller.state.lastResult.reason, "user_stopped");
    assert.equal(controller.state.lastResult.iterations, 0);
    assert.equal(controller.state.active, null, "state.active must be cleared");
    // No iteration ran → no assistant.message accumulated → preview must
    // be the empty string (not undefined, not the prior run's content).
    // Pins the JSDoc contract on RalphResult.preview.
    assert.equal(controller.state.lastResult.preview, "");
});

test("calling ralph_stop twice in a row: 2nd call reports no active loop", async () => {
    // After ralph_stop succeeds, finish() nulls state.active. A retried
    // stop (e.g. caller wasn't sure the first one landed) must not
    // silently succeed — the loop is already gone, and reporting
    // success would falsely imply we just stopped a fresh loop.
    const { controller, stop } = await arm({ max_iterations: 5 });
    const r1 = await stop.handler({ reason: "first" });
    assert.equal(r1.resultType, "success");
    assert.equal(controller.state.lastResult.reason, "user_stopped");
    const r2 = await stop.handler({ reason: "second" });
    assert.equal(r2.resultType, "failure");
    assert.match(r2.textResultForLlm, /no ralph_loop is currently running/);
    // The original result must NOT be overwritten by the failed second stop.
    assert.equal(controller.state.lastResult.note, "first");
});

// ── hook ──────────────────────────────────────────────────────────────────

test("onUserPromptSubmitted surfaces send_error note (Error message) in additionalContext", async () => {
    // After a send failure, the next user prompt's bracketed context must
    // include both reason=send_error and note=<error message> so the agent
    // learns *why* the loop ended rather than just "it ended". Pins the
    // wiring from finish('send_error', err.message) → state.lastResult.note
    // → onUserPromptSubmitted bracket.
    const session = makeFakeSession({ failSend: true });
    const c = createRalphController();
    c.attach(session);
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    assert.equal(c.state.lastResult.reason, "send_error");
    const r = await c.hooks.onUserPromptSubmitted({ prompt: "next" });
    assert.match(r.additionalContext, /reason=send_error/);
    assert.match(r.additionalContext, /note=send failed: simulated send failure/);
    // No raw newlines should make it into the bracket even if the underlying
    // error stack had them — collapseNote flattens them.
    assert.equal(r.additionalContext.includes("\n"), false);
});

test("onUserPromptSubmitted injects additionalContext exactly once after a finish", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
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

test("onUserPromptSubmitted consumes lastResult exactly once (no replay on subsequent prompts)", async () => {
    // The hook injects [ralph_loop just finished — …] on the FIRST user
    // prompt after a loop ends, then clears state.lastResult so a
    // SECOND prompt isn't decorated with the same stale context. A
    // future refactor that forgets the `state.lastResult = null` line
    // (or hoists `return` above it) would silently re-inject the same
    // outcome on every prompt forever, which is both noisy in the
    // timeline and confuses the agent into thinking the loop just
    // finished AGAIN. Pin the consume-once contract.
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "all done COMPLETE");
    assert.ok(controller.state.lastResult, "loop must have finished");

    const first = await controller.hooks.onUserPromptSubmitted({ prompt: "next" });
    assert.match(first.additionalContext, /reason=completion_promise/);
    assert.equal(controller.state.lastResult, null, "lastResult must be cleared after first injection");

    const second = await controller.hooks.onUserPromptSubmitted({ prompt: "and again" });
    assert.equal(second, undefined, "second prompt must NOT be decorated with stale outcome");
});

test("onUserPromptSubmitted collapses multi-line note into single line", async () => {
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    // Stop with a multi-line reason — note should land on the result, then
    // be flattened inside additionalContext.
    await stop.handler({ reason: "first line\n  second line\n\nthird" });
    const r = await controller.hooks.onUserPromptSubmitted({ prompt: "next" });
    assert.match(r.additionalContext, /note=first line second line third/);
    // Ensure no raw newlines made it into the bracketed context.
    assert.equal(r.additionalContext.includes("\n"), false);
});

test("onUserPromptSubmitted collapses tabs / CR / FF in note (not just LF)", async () => {
    // collapseNote uses /\s+/ — i.e. ALL whitespace, not just newlines.
    // Pin tabs, carriage returns, and form feeds so a future tweak that
    // narrows the regex (e.g. to /[\n\r]+/) would surface the regression.
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    await stop.handler({ reason: "a\tb\rc\fd" });
    const r = await controller.hooks.onUserPromptSubmitted({ prompt: "next" });
    assert.match(r.additionalContext, /note=a b c d/);
    assert.equal(/[\t\r\f]/.test(r.additionalContext), false);
});

test("finish log line collapses multi-line note (single-line timeline marker)", async () => {
    // A note with newlines (e.g. an Error stack from send_error) must not
    // break the timeline log into multiple lines.
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
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
    session.emit("session.idle", { data: {} }); // pendingFire → iter 1
    assert.equal(controller.state.active.i, 1);
    assert.equal(session.sent.length, 1);
    session.emit("session.idle", { data: {} }); // skipped (no msg)
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
    session.emit("session.idle", { data: {} }); // fire iter 1
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
    s2.emit("session.idle", { data: {} }); // fire iter 1
    runTurn(s2, "MAGIC at iter 1"); // iter 1 ignored (min=3), fires iter 2
    assert.equal(c2.state.active.i, 2);
    s2.emit("session.idle", { data: {} }); // silent → skipped
    assert.notEqual(c2.state.active, null);
    assert.equal(c2.state.active.i, 2, "silent turn_end must not advance the loop");
    assert.equal(s2.sent.length, 2, "no duplicate prompt queued");
    // lastAssistantContent must still be "" (cleared at iter 2 fire) so that
    // when iter 2's real response arrives it isn't polluted by iter 1's text.
    assert.equal(c2.state.lastAssistantContent, "");
});

test("duplicate session.idle is naturally idempotent (no double-count)", async () => {
    const { session, controller } = await arm({ max_iterations: 5, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} }); // fires iter 1
    // Iter 1 produces "step 1"
    session.emit("assistant.message", { data: { content: "step 1" } });
    session.emit("session.idle", { data: {} }); // i=2, sends iter 2 prompt
    assert.equal(controller.state.active.i, 2);
    assert.equal(session.sent.length, 2);
    // Duplicate idle without a new assistant.message hits the queue-bloat
    // gate (fireInFlight && !observedMessageThisFire) and is skipped.
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.active.i, 2);
    assert.equal(session.sent.length, 2);
});

test("empty assistant.message content still flips observedMessageThisFire (next idle advances, not skipped)", async () => {
    // The queue-bloat guard skips an idle when fireInFlight is set
    // and observedMessageThisFire is still false. An assistant.message
    // event with content === "" must still flip the flag — otherwise
    // a turn that produced no actual output (e.g. an aborted sub-call
    // that still emitted a final empty assistant.message) would wedge
    // the loop on the very next idle. The flag is a "did the agent
    // hand back the turn?" marker, not a "did it produce content?"
    // marker.
    const { session, controller } = await arm({ max_iterations: 4, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} }); // iter 1 prompt fires
    assert.equal(controller.state.active.i, 1);
    assert.equal(session.sent.length, 1);
    // Empty content still has typeof "string" → flag flips.
    session.emit("assistant.message", { data: { content: "" } });
    assert.equal(controller.state.active.observedMessageThisFire, true);
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.active.i, 2, "next idle must advance to iter 2 even after empty response");
    assert.equal(session.sent.length, 2);
});

test("pre-arm assistant content is discarded — does not satisfy iter-1 completion check", async () => {
    // The turn that *calls* ralph_loop is itself an assistant turn that
    // can have already emitted text before the tool call resolved. If
    // the agent happened to mention the completion_promise in that
    // pre-arm content (e.g. quoting the user "I'll loop until DONE"),
    // we must NOT count that as a satisfied completion the moment the
    // first iteration's idle arrives. onIdle clears the buffer right
    // before firing iter 1 specifically so iter 1 is evaluated against
    // its OWN response, not the arming-turn carryover. Pin that
    // contract here so a future refactor that drops the clear-on-arm
    // line silently regresses.
    const { session, controller } = await arm({
        max_iterations: 5,
        completion_promise: "DONE",
        stagnation_limit: 0,
    });
    // Simulate an assistant.message during the arming turn (before the
    // first idle) that already contains the completion phrase.
    session.emit("assistant.message", { data: { content: "I'll loop until DONE" } });
    // First idle: fires iter 1, must clear the pre-arm content.
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.active.i, 1, "iter 1 should have fired");
    assert.equal(controller.state.lastAssistantContent, "", "pre-arm content must be cleared");
    // Iter 1's response does NOT contain DONE → completion must not fire.
    session.emit("assistant.message", { data: { content: "still working" } });
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.lastResult, null, "loop must not have finished — pre-arm DONE was discarded");
    assert.equal(controller.state.active.i, 2, "loop should have advanced to iter 2");
});

test("session.idle with empty data fires iter 1 (no turnId required)", async () => {
    // Regression: the older implementation tracked lastTurnId and used a
    // sentinel because turnId:null could self-match. session.idle has no
    // turnId, so this edge case is gone — but cover it explicitly so a
    // future refactor doesn't reintroduce the bug.
    const { session, controller } = await arm({ max_iterations: 5, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.active.i, 1, "iter 1 must have armed");
    assert.equal(session.sent.length, 1, "prompt must have been sent");
});

test("sub-agent idle events (agentId set) do not refire — root only", async () => {
    // Regression for the user-reported `Queued (N)` bug: when the root
    // agent invokes sub-agents (task/explore/code-review/rubber-duck),
    // each sub-agent's own session.idle bubbles up to the shared session
    // bus. Per the SDK schema, those carry an `agentId` while the root
    // agent's events do not. Refiring on a sub-agent boundary queues
    // duplicate prompts.
    const { session, controller } = await arm({ max_iterations: 10, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} }); // pendingFire → iter 1 sent
    assert.equal(session.sent.length, 1);
    // Root emits a real message so the in-flight gate is cleared.
    session.emit("assistant.message", { data: { content: "thinking…" } });
    // 5 sub-agent idle events in a row — must all be ignored.
    for (let k = 0; k < 5; k++) {
        session.emit("session.idle", {
            agentId: `sub-${k}`,
            data: {},
        });
    }
    assert.equal(session.sent.length, 1, "sub-agent idle events must not queue more prompts");
    assert.equal(controller.state.active.i, 1);
    // The root agent's actual idle (no agentId) finally fires next iter.
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.active.i, 2);
    assert.equal(session.sent.length, 2);
});

test("sub-agent idle BEFORE iter 1 (during pendingFire) does NOT consume pendingFire", async () => {
    // Subtle ordering bug guard: in onIdle the sub-agent filter runs BEFORE
    // the `pendingFire` check. If those two were swapped (or someone
    // refactored to filter sub-agents *after* the pending-fire branch), a
    // sub-agent idle that arrives between arm-time and the first root
    // idle would silently consume `pendingFire`, fire iter 1 against
    // whatever was on the bus, and leave the *real* first root idle
    // mis-classified as a regular iteration boundary.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    await c.tools[0].handler({ prompt: "go", max_iterations: 5, stagnation_limit: 0 });
    assert.equal(c.state.active.pendingFire, true, "loop must be armed pre-fire");
    // 3 sub-agent idles in a row — pendingFire must remain true and no
    // prompt may have been fired yet.
    for (let k = 0; k < 3; k++) {
        session.emit("session.idle", { agentId: `sub-${k}`, data: {} });
    }
    assert.equal(c.state.active.pendingFire, true, "pendingFire must survive sub-agent idles");
    assert.equal(session.sent.length, 0, "no fire should have happened yet");
    assert.equal(c.state.active.i, 0, "iter must still be 0");
    // Root idle finally fires iter 1.
    session.emit("session.idle", { data: {} });
    assert.equal(c.state.active.pendingFire, false);
    assert.equal(c.state.active.i, 1);
    assert.equal(session.sent.length, 1);
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
    session.emit("session.idle", { data: {} }); // fire iter 1
    // Sub-agent says ALL_DONE — must be ignored.
    session.emit("assistant.message", {
        agentId: "explore-1",
        data: { content: "ALL_DONE from sub-agent" },
    });
    // Root agent emits its own (non-completion) message and turn_end.
    session.emit("assistant.message", { data: { content: "root response" } });
    session.emit("session.idle", { data: {} });
    assert.notEqual(controller.state.active, null, "loop should still be running");
    assert.equal(controller.state.active.i, 2);
});


test("assistant.message with non-string content is silently ignored (defensive type guard)", async () => {
    // The SDK contract says content is a string, but a misbehaving session
    // (or a future event variant) might emit non-string payloads. Without
    // the `typeof text !== "string"` guard, `lastAssistantContent + "\n" + null`
    // would inject "null" / "undefined" / "[object Object]" into the
    // accumulator and confuse the completion check. Pin that every
    // off-spec shape is dropped silently and the loop continues normally.
    const { session, controller } = await arm({
        max_iterations: 5,
        completion_promise: "ALL_DONE",
        stagnation_limit: 0,
    });
    session.emit("session.idle", { data: {} }); // fire iter 1
    // Each of these *would* poison the accumulator if the typeof guard
    // were missing. After: accumulator must still equal the one valid
    // string we emit at the end.
    session.emit("assistant.message", { data: { content: null } });
    session.emit("assistant.message", { data: { content: undefined } });
    session.emit("assistant.message", { data: { content: 42 } });
    session.emit("assistant.message", { data: { content: ["ALL_DONE"] } });
    session.emit("assistant.message", { data: { content: { text: "ALL_DONE" } } });
    session.emit("assistant.message", { data: {} });           // no content key
    session.emit("assistant.message", { data: null });         // no data.content path
    session.emit("assistant.message", null);                   // no ev.data path
    session.emit("assistant.message", undefined);              // no ev path
    // Now a real string — this and only this should land in the accumulator.
    session.emit("assistant.message", { data: { content: "real text" } });
    assert.equal(controller.state.lastAssistantContent, "real text");
    // And the completion phrase smuggled in via array/object content must
    // NOT have been substring-matched on the next idle.
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.lastResult, null, "off-spec content must not trigger completion");
    assert.equal(controller.state.active.i, 2);
});


test("sub-agent abort event does NOT terminate the root ralph_loop", async () => {
    // Sub-agents (task / explore / rubber-duck …) emit their own abort
    // events when they fail or are cancelled. Per the SDK schema, those
    // events carry an `agentId` field while root-agent events don't.
    // A sub-agent's abort must NOT tear down the root ralph_loop.
    const { session, controller } = await arm({ max_iterations: 5, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} }); // fire iter 1
    assert.equal(controller.state.active.i, 1);
    // A sub-agent reports abort — must be ignored by the root controller.
    session.emit("abort", { agentId: "explore-1", data: { reason: "subagent crashed" } });
    assert.notEqual(controller.state.active, null, "root loop should still be active");
    assert.equal(controller.state.active.i, 1);
    // A real root-level abort still tears the loop down.
    session.emit("abort", { data: { reason: "user pressed Esc" } });
    assert.equal(controller.state.active, null);
    assert.equal(controller.state.lastResult.reason, "aborted");
    assert.equal(controller.state.lastResult.note, "user pressed Esc");
});


test("isSubAgentEvent treats agentId='' as sub-agent (presence, not truthiness)", async () => {
    // The guard intentionally checks `agentId !== undefined && agentId !== null`
    // rather than truthiness. An empty-string agentId is malformed per the
    // SDK schema (sub-agent ids should be UUID strings) but if it ever
    // happens, the safer default is to TREAT IT AS A SUB-AGENT EVENT —
    // i.e. skip it — rather than refire the root loop on a possibly-bogus
    // event. A future refactor that simplifies the guard to `if (ev?.agentId)`
    // (truthy) would silently flip empty-string events from "sub-agent
    // (ignored)" to "root (act on)", which is the riskier direction.
    //
    // Pin all three event handlers (idle / assistant.message / abort)
    // against agentId="".
    const { session, controller } = await arm({
        max_iterations: 5,
        completion_promise: "DONE",
        stagnation_limit: 0,
    });
    session.emit("session.idle", { data: {} }); // fire iter 1
    assert.equal(session.sent.length, 1);

    // 1. assistant.message with agentId="" containing completion phrase —
    //    must NOT trigger completion (treated as sub-agent → ignored).
    session.emit("assistant.message", { agentId: "", data: { content: "DONE" } });
    // 2. idle with agentId="" — must NOT advance the iter or queue a fire.
    session.emit("session.idle", { agentId: "", data: {} });
    assert.equal(controller.state.active.i, 1, "agentId='' idle must be ignored");
    assert.equal(session.sent.length, 1, "no extra fire queued by agentId='' idle");
    // 3. abort with agentId="" — must NOT tear down the root loop.
    session.emit("abort", { agentId: "", data: { reason: "spurious" } });
    assert.notEqual(controller.state.active, null, "agentId='' abort must not finish loop");
    assert.equal(controller.state.lastResult, null);
});


test("multiple session.idle events without intervening assistant.message do not bloat queue", async () => {
    // Regression for the user-reported `Queued (N)` bug: even if the SDK
    // emits several spurious idle events in quick succession before the
    // agent has actually picked up our prompt, each extra idle must be
    // skipped rather than queueing another copy.
    const { session, controller } = await arm({ max_iterations: 10, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} }); // pendingFire → iter 1 sent
    assert.equal(session.sent.length, 1);
    // Five spurious idle events with no assistant.message in between.
    for (let k = 0; k < 5; k++) {
        session.emit("session.idle", { data: {} });
    }
    assert.equal(session.sent.length, 1, "no duplicate prompts queued");
    assert.equal(controller.state.active.i, 1);
    // Once the agent finally responds, the next idle advances normally.
    session.emit("assistant.message", { data: { content: "ack" } });
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.active.i, 2);
    assert.equal(session.sent.length, 2);
});

test("multiple assistant.message events in one turn are accumulated", async () => {
    const { session, controller } = await arm({
        max_iterations: 5,
        completion_promise: "ALL_DONE",
        stagnation_limit: 0,
    });
    session.emit("session.idle", { data: {} }); // fire iter 1
    // Iter 1: agent emits TWO messages, completion phrase only in the first.
    session.emit("assistant.message", { data: { content: "first chunk ALL_DONE here" } });
    session.emit("assistant.message", { data: { content: "second chunk follow-up" } });
    session.emit("session.idle", { data: {} });
    // Without accumulation, "ALL_DONE" would have been overwritten by the second
    // message and the loop would not finish. With accumulation it does.
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 1);
});

test("preview is truncated to PREVIEW_CHARS + ellipsis", async () => {
    const { session, controller } = await arm({ max_iterations: 1, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "x".repeat(700));
    assert.equal(controller.state.lastResult.preview.length, 501);
    assert.ok(controller.state.lastResult.preview.endsWith("…"));
});

test("previewOf: returns '' for empty / null / undefined inputs (defensive)", () => {
    // previewOf is called on state.lastAssistantContent which can briefly
    // hold any of these values during a loop's lifecycle (pre-iter-1 reset,
    // immediately post-arm). Pin the falsy short-circuit so a refactor that
    // accidentally drops the `!text` guard surfaces here, not as a runtime
    // TypeError reading `.length` of null.
    assert.equal(previewOf(""), "");
    assert.equal(previewOf(null), "");
    assert.equal(previewOf(undefined), "");
});

test("previewOf: short text passes through unchanged (no ellipsis added)", () => {
    // The "…" indicator is reserved for actual truncation. Adding it to
    // short content would mislead callers (and break tests like the
    // exact-PREVIEW_CHARS boundary below).
    assert.equal(previewOf("short"), "short");
    assert.equal(previewOf("X".repeat(PREVIEW_CHARS)), "X".repeat(PREVIEW_CHARS));
});

test("previewOf: text exactly PREVIEW_CHARS+1 chars truncates to PREVIEW_CHARS + '…'", () => {
    // Off-by-one regression guard: `<=` (correct) vs `<` (would add "…"
    // even at the exact-cap boundary).
    const overByOne = "X".repeat(PREVIEW_CHARS + 1);
    const out = previewOf(overByOne);
    assert.ok(out.endsWith("…"));
    // PREVIEW_CHARS code units of content + the single "…" character.
    assert.equal(out.length, PREVIEW_CHARS + 1);
    assert.equal(out.slice(0, PREVIEW_CHARS), "X".repeat(PREVIEW_CHARS));
});


test("preview does not split UTF-16 surrogate pairs (no lone high surrogate)", async () => {
    // 499 'a's + "🎉" (D83C DF89) + filler. Naive slice(0, 500) would leave
    // a lone high surrogate at index 499.
    const content = "a".repeat(499) + "🎉" + "z".repeat(100);
    const { session, controller } = await arm({ max_iterations: 1, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} });
    runTurn(session, content);
    const preview = controller.state.lastResult.preview;
    assert.ok(preview.endsWith("…"));
    // No replacement char should appear (would indicate a lone surrogate).
    assert.equal(preview.indexOf("\uFFFD"), -1, "preview contains replacement char");
    // Round-trip via JSON should be loss-less.
    assert.deepEqual(JSON.parse(JSON.stringify(preview)), preview);
});

test("note truncation is silent — no '…' indicator (asymmetric with preview)", async () => {
    // RalphResult typedef explicitly contracts that `note` is truncated
    // silently while `preview` appends "…". Notes flow inline into the
    // single-line log marker and the post-loop additionalContext bracket;
    // a trailing "…" there would be misread as part of the message
    // (e.g. `note=connection lost…` looks like a verb that trails off
    // rather than a hint that the note was truncated). Pin the contract
    // so a future "consistency cleanup" doesn't break log-line callers.
    const longReason = "x".repeat(PREVIEW_CHARS + 100);
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    await stop.handler({ reason: longReason });
    const note = controller.state.lastResult.note;
    assert.equal(note.length, PREVIEW_CHARS, "note must be capped at exactly PREVIEW_CHARS");
    assert.ok(!note.endsWith("…"), "note must NOT carry the '…' indicator (preview-only)");
    assert.equal(note, "x".repeat(PREVIEW_CHARS));
});

test("note truncation does not split UTF-16 surrogate pairs", async () => {
    // 499 'a's + "🎉" + filler — same surrogate-edge as preview test, but
    // exercising the note path via ralph_stop reason.
    const longReason = "a".repeat(499) + "🎉" + "z".repeat(100);
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
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
    session.emit("session.idle", { data: {} });
    const r = await stop.handler({ reason: huge });
    assert.equal(r.resultType, "success");
    // Structured note in tool reply
    assert.ok(r.note, "response should carry note");
    assert.ok(r.note.length <= PREVIEW_CHARS, `r.note.length=${r.note.length} > ${PREVIEW_CHARS}`);
    // Visible text should be the bounded "stopped after … (note)." form,
    // not 50 KiB of x's.
    assert.ok(r.textResultForLlm.length < 1000, `textResultForLlm too long: ${r.textResultForLlm.length}`);
    // Result note matches the visible note
    assert.equal(controller.state.lastResult.note, r.note);
    assert.ok(controller.state.lastResult.note.length <= PREVIEW_CHARS);
});

test("ralph_stop reason at exactly PREVIEW_CHARS passes through unchanged (boundary)", async () => {
    // Pin the boundary: reason length === PREVIEW_CHARS must NOT trip the
    // truncation path (no ellipsis added, no chars dropped). This guards
    // an off-by-one in truncateNote (uses `<=` not `<`) so the cap is
    // inclusive.
    const exactlyAtCap = "y".repeat(PREVIEW_CHARS);
    const { session, controller, stop } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    const r = await stop.handler({ reason: exactlyAtCap });
    assert.equal(r.resultType, "success");
    assert.equal(r.note, exactlyAtCap);
    assert.equal(controller.state.lastResult.note, exactlyAtCap);
});

test("lastAssistantContent head-trim does not split a UTF-16 surrogate pair", async () => {
    // The 1 MiB rolling buffer slices from the HEAD when overflowing. If
    // the slice boundary lands inside a surrogate pair, the new buffer
    // would start with a lone low surrogate (0xdc00..0xdfff) — invalid
    // UTF-16 that prints as a replacement char. safeSliceStart bumps the
    // start forward by 1 in that case. Pin it.
    const { session, controller } = await arm({ max_iterations: 5, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} });
    const cap = __test__.MAX_CONTENT_CHARS;
    // Construct content so the head-trim boundary lands EXACTLY between
    // the two halves of a surrogate pair:
    //   index 0: 'a'        (will be dropped)
    //   index 1: HIGH surr  (will be dropped)
    //   index 2: LOW surr   (would be kept as a LONE low surrogate without the fix)
    //   indices 3..cap+1: 'a' * (cap - 1)
    // Total length = cap + 2 → slice(next.length - cap) = slice(2) → kept buffer
    // starts at the lone low surrogate. safeSliceStart must bump to slice(3).
    const emoji = "\uD83D\uDE00"; // 😀, U+1F600
    const content = "a" + emoji + "a".repeat(cap - 1);
    assert.equal(content.length, cap + 2);
    session.emit("assistant.message", { data: { content } });
    const buf = controller.state.lastAssistantContent;
    assert.ok(buf.length <= cap, `length ${buf.length} > cap ${cap}`);
    // The first code unit must NOT be a lone low surrogate.
    const firstCode = buf.charCodeAt(0);
    assert.ok(
        firstCode < 0xdc00 || firstCode > 0xdfff,
        `expected no lone low surrogate at buffer head, got 0x${firstCode.toString(16)}`,
    );
});

test("lastAssistantContent is capped at MAX_CONTENT_CHARS (1 MiB)", async () => {
    const { session, controller } = await arm({ max_iterations: 5, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} });
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
    session.emit("session.idle", { data: {} }); // fire iter 1 (the pending-promise send)
    assert.equal(controller.state.active.i, 1);
    await stop.handler({ reason: "manual" });
    assert.equal(controller.state.active, null);

    // A2
    await ralph.handler({ prompt: "second", max_iterations: 5, stagnation_limit: 0 });
    session.emit("session.idle", { data: {} });
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
    session.emit("session.idle", { data: {} });
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
    session2.emit("session.idle", { data: {} });
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
            // session.idle returns a proper unsub; the other two violate contract.
            if (evName === "session.idle") return () => {};
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
    session.emit("session.idle", { data: {} });
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

test("re-attach unsubscribes prior session's listeners (no cross-session refires)", async () => {
    // A stale session whose attach() has been superseded must NOT be able
    // to refire iterations on the controller. If re-attach forgot to call
    // currentDetach() first, sessionA's handlers would still be live and
    // a session.idle on sessionA would push another prompt onto sessionB.
    const sessionA = makeFakeSession();
    const sessionB = makeFakeSession();
    const c = createRalphController();
    c.attach(sessionA);
    c.attach(sessionB);                    // supersedes — should clear A
    await c.tools[0].handler({ prompt: "go", max_iterations: 5 });
    sessionB.emit("session.idle", { data: {} });
    assert.equal(sessionB.sent.length, 1, "expected exactly one fire to B");

    // Now blast events at the stale session — none of these should
    // perturb the controller's loop on sessionB.
    sessionA.emit("session.idle", { data: {} });
    sessionA.emit("assistant.message", { data: { content: "stray COMPLETE" } });
    sessionA.emit("abort", { data: { reason: "should be ignored" } });
    assert.equal(sessionB.sent.length, 1, "stale-session events must not refire");
    assert.equal(c.state.active?.i, 1, "loop should still be on its original iter");
    assert.equal(c.state.lastResult, null, "stray events must not finish the loop");
});

test("result includes durationMs, startedAt, finishedAt", async () => {
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "all done COMPLETE");
    const r = controller.state.lastResult;
    assert.equal(typeof r.startedAt, "number");
    assert.equal(typeof r.finishedAt, "number");
    assert.equal(typeof r.durationMs, "number");
    assert.ok(r.finishedAt >= r.startedAt);
    assert.equal(r.durationMs, r.finishedAt - r.startedAt);
});

test("lastResult exposes exactly the documented shape (no stray keys, no missing keys)", async () => {
    // The RalphResult typedef pins which keys downstream consumers can
    // rely on. Each individual field is asserted by other tests, but
    // none of them pin the SET of keys, so a future refactor that
    // accidentally adds an internal field to the frozen object (e.g.
    // copying state.active in via spread) or drops a documented one
    // (e.g. forgets to populate preview on a synchronous early-finish
    // path) wouldn't fail any existing test.
    //
    // Pin both:
    //   1. completion path → no `note` (note is optional).
    //   2. user_stopped with reason → `note` present.
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "all done COMPLETE");
    const completion = controller.state.lastResult;
    assert.deepEqual(
        Object.keys(completion).sort(),
        ["durationMs", "finishedAt", "iterations", "preview", "reason", "startedAt"],
        "completion result must have exactly these 6 keys",
    );

    const a2 = await arm({ max_iterations: 3 });
    const r2 = await a2.stop.handler({ reason: "manual" });
    assert.equal(r2.resultType, "success");
    const stopped = a2.controller.state.lastResult;
    assert.deepEqual(
        Object.keys(stopped).sort(),
        ["durationMs", "finishedAt", "iterations", "note", "preview", "reason", "startedAt"],
        "user_stopped result must add exactly `note` to the 6-key base",
    );
});

test("durationMs is clamped to ≥ 0 if the system clock jumps backward", async () => {
    // Stub Date.now so the second sample (finish time) reads earlier
    // than the first (arm time) — simulates an NTP correction landing
    // mid-loop. Without the Math.max(0, …) clamp, durationMs would be
    // negative and confuse any downstream metric / log consumer.
    const realNow = Date.now;
    let calls = 0;
    Date.now = () => (calls++ === 0 ? 10_000 : 5_000);
    try {
        const { session, controller } = await arm({ max_iterations: 3 });
        session.emit("session.idle", { data: {} });
        runTurn(session, "done COMPLETE");
        const r = controller.state.lastResult;
        assert.equal(r.startedAt, 10_000);
        assert.equal(r.finishedAt, 5_000);
        assert.equal(r.durationMs, 0, "must clamp negative duration to 0, never report negative time");
    } finally {
        Date.now = realNow;
    }
});

test("arming a fresh ralph_loop clears stale lastResult from prior run", async () => {
    // First loop completes and records a result.
    const { session, controller, ralph } = await arm({ max_iterations: 2 });
    session.emit("session.idle", { data: {} });   // first idle fires iter 1 prompt
    runTurn(session, "first run done COMPLETE");  // second idle detects completion
    assert.equal(controller.state.lastResult.reason, "completion_promise");
    assert.equal(controller.state.lastResult.iterations, 1);

    // Arming a brand-new loop must wipe the prior result so a downstream
    // consumer (e.g. onUserPromptSubmitted) cannot accidentally inject the
    // previous run's preview into the next user prompt.
    const armResult = await ralph.handler({ prompt: "next", max_iterations: 3 });
    assert.equal(armResult.resultType, "success");
    assert.equal(controller.state.lastResult, null,
        "prior lastResult must be cleared on re-arm to prevent stale post-loop context");
});

test("lastResult is frozen so consumers can't mutate the historical record", async () => {
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "all done COMPLETE");
    const r = controller.state.lastResult;
    assert.ok(Object.isFrozen(r));
    assert.throws(() => { r.reason = "tampered"; }, TypeError);
    assert.throws(() => { r.iterations = 999; }, TypeError);
    // Original values intact.
    assert.equal(r.reason, "completion_promise");
});

test("iter log elapsed is clamped to ≥ 0 against backward clock jumps", async () => {
    // Same defense as durationMs: a backward clock jump (NTP) between
    // arming and the next idle would surface "elapsed -5000ms" otherwise,
    // which is confusing in the timeline. Stub Date.now so finish-time
    // < arm-time and assert the elapsed marker reads 0.
    const realNow = Date.now;
    let calls = 0;
    Date.now = () => (calls++ === 0 ? 10_000 : 5_000);
    try {
        const { session } = await arm({ max_iterations: 3 });
        session.emit("session.idle", { data: {} });   // fires iter 1, calls Date.now for elapsed
        const elapsedLine = session.logs.find((l) => /iter 1\/3 \(elapsed/.test(l));
        assert.ok(elapsedLine, "expected an iter-start log line");
        assert.match(elapsedLine, /elapsed 0ms/, `should clamp negative elapsed (got: ${elapsedLine})`);
    } finally {
        Date.now = realNow;
    }
});

test("session.log records arming, iter markers, and finish reason", async () => {
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("session.idle", { data: {} });
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
    session1.emit("session.idle", { data: {} });
    assert.match(session1.logs.join("\n"), /⚠️ ended ralph_loop.*reason: send_error/);

    // user_stopped → ⏹ stopped (not ⚠️)
    const { session: s2, stop } = await arm({ max_iterations: 5 });
    s2.emit("session.idle", { data: {} });
    await stop.handler({});
    assert.match(s2.logs.join("\n"), /⏹ stopped ralph_loop.*reason: user_stopped/);
});
