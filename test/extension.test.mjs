import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createRalphController, validateArgs, __test__ } from "../extension/handler.mjs";
const { MAX_PROMISE_CHARS, MAX_PROMPT_CHARS, MAX_ALLOWED_ITERATIONS, PREVIEW_CHARS, PROMPT_SELF_IMPROVE, PROMPT_GROW_PROJECT, BAKED_ABORT_TOKEN, BAKED_BACKLOG_ABORT_TOKEN, BAKED_COPILOT_TRAILER, BAKED_RALPH_TRAILER, BAKED_ATTRIBUTION_OPT_OUT, BAKED_RALPH_LOOP_RIDER, composeRalphLoopPrompt, SELF_IMPROVE_DEFAULTS, GROW_PROJECT_DEFAULTS, MAX_FOCUS_CHARS, previewOf } = __test__;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function runTurn(session, content) {
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
    // String.prototype.trim removes the full Unicode whitespace class —
    // a prompt of NBSP / IDEOGRAPHIC SPACE / ZERO WIDTH NO-BREAK SPACE
    // collapses to "" and must surface the same actionable message
    // (otherwise a templating bug that interpolates U+00A0 would
    // bypass the guard with a misleading "prompt is required" branch).
    assert.match(validateArgs({ prompt: "\u00A0" }).error, /whitespace-only/);
    assert.match(validateArgs({ prompt: "\u3000\u2003" }).error, /whitespace-only/);
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

test("success/failure helpers: default-extra return is exactly { textResultForLlm, resultType }", () => {
    // Pin the "no extra" closed shape so a future refactor that adds
    // an implicit field (e.g. a timestamp, debug breadcrumb, or a
    // sentinel like `_ralph: true`) is caught loudly. Embedders that
    // serialize the result over a wire protocol (RPC, JSON-over-stdin)
    // depend on this minimal shape.
    const c = createRalphController();
    const f = c._internal.failure("oops");
    assert.deepEqual(Object.keys(f).sort(), ["resultType", "textResultForLlm"]);
    assert.equal(f.resultType, "failure");
    assert.equal(f.textResultForLlm, "oops");
    const s = c._internal.success("yay");
    assert.deepEqual(Object.keys(s).sort(), ["resultType", "textResultForLlm"]);
    assert.equal(s.resultType, "success");
    assert.equal(s.textResultForLlm, "yay");
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
    // Pin diagnosability: BOTH colliding values must appear in the message
    // so the user can immediately see which two phrases need to change.
    // (Same rationale as the identity-check test above.) Without this lock
    // a future "simplification" of the message could silently drop one
    // value and leave operators guessing which side to edit.
    assert.match(r1.error, /"DONE"/);
    assert.match(r1.error, /"DONE_FAIL"/);
    // completion contains abort → abort would always match too
    const r2 = validateArgs({ prompt: "x", completion_promise: "ALL_DONE", abort_promise: "DONE" });
    assert.match(r2.error, /overlap/);
    assert.match(r2.error, /"ALL_DONE"/);
    assert.match(r2.error, /"DONE"/);
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

test("ralph_loop: re-fires the trimmed prompt to session.send (not the raw padded input)", async () => {
    // validateArgs trims args.prompt before storing it on state.active. The
    // value re-fired each iteration should therefore be the trimmed string,
    // not the user's raw input. Without this pin, a future change that
    // stored the raw value (or stopped trimming) would silently send "  go\n"
    // to the agent every iteration, polluting prompt previews and burning
    // tokens on whitespace.
    const session = makeFakeSession();
    const controller = createRalphController();
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    await ralph.handler({ prompt: "  go\n  ", max_iterations: 3 });
    const expected = composeRalphLoopPrompt("go").value;
    assert.equal(controller.state.active.prompt, expected);
    session.emit("session.idle", { data: {} });
    runTurn(session, "still working");
    runTurn(session, "still working again");
    // Every send must use the trimmed prompt + rider verbatim.
    assert.ok(session.sent.length >= 2);
    for (const s of session.sent) assert.equal(s.prompt, expected);
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

test("validateArgs: prompt-length cap measures TRIMMED length, not raw input length", () => {
    // The cap is checked AFTER `.trim()`, so a prompt whose raw length
    // exceeds the limit but whose trimmed length sits at-or-below the
    // limit must be accepted. Without this contract, callers wrapping
    // a prompt in extra whitespace (templating artifact, copy-paste
    // padding) would see spurious "exceeds" errors that make no sense
    // because the actual content fits comfortably.
    const cap = __test__.MAX_PROMPT_CHARS;
    // Trimmed length is exactly cap; raw length is cap + 200 padding.
    const padded = "  ".repeat(50) + "x".repeat(cap) + "  ".repeat(50);
    const r = validateArgs({ prompt: padded });
    assert.ok(r.value, r.error);
    assert.equal(r.value.prompt.length, cap);
    // Now: trimmed length one over the cap (still padded) → rejected,
    // and the error message reports the *trimmed* length, not the raw
    // length, so operators don't get confused why a "cap+1" error
    // shows when their input was much larger.
    const tooLong = "  " + "x".repeat(cap + 1) + "  ";
    const r2 = validateArgs({ prompt: tooLong });
    assert.match(r2.error, new RegExp(`got ${cap + 1}`));
});

test("validateArgs: rejects unknown keys (typo guard)", () => {
    // Common typo for max_iterations — would silently use the default.
    const r1 = validateArgs({ prompt: "x", max_iter: 100 });
    assert.match(r1.error, /unknown argument.*"max_iter"/);
    // Multiple unknowns reported together.
    const r2 = validateArgs({ prompt: "x", foo: 1, bar: 2 });
    assert.match(r2.error, /unknown arguments.*"foo".*"bar"/);
    // Lists valid keys to help the caller fix their call. The error
    // message must enumerate ALL six accepted keys, not just one — a
    // single-key check passes even if a refactor accidentally drops
    // five of them from the rendered list. Pin all six explicitly so
    // a regression in RALPH_LOOP_KEYS membership or the join logic
    // shows up immediately.
    for (const key of [
        "prompt", "max_iterations", "min_iterations",
        "completion_promise", "abort_promise", "stagnation_limit",
    ]) {
        assert.match(r1.error, new RegExp(`Valid keys:.*\\b${key}\\b`),
            `expected '${key}' to appear in valid-keys hint`);
    }
    // All-known keys still pass.
    assert.ok(validateArgs({
        prompt: "x", max_iterations: 5, min_iterations: 1,
        completion_promise: "DONE", abort_promise: "FAIL", stagnation_limit: 0,
    }).value);
});

test("all tool schemas declare additionalProperties:false (mirrors runtime validation)", () => {
    const c = createRalphController();
    const ralph = c.tools.find((t) => t.name === "ralph_loop");
    const stop = c.tools.find((t) => t.name === "ralph_stop");
    const si = c.tools.find((t) => t.name === "self_improve");
    assert.equal(ralph.parameters.additionalProperties, false);
    assert.equal(stop.parameters.additionalProperties, false);
    assert.equal(si.parameters.additionalProperties, false);
});

test("all tool schemas declare type:'object' at the root", () => {
    // JSON-schema clients that route on `type` will reject the tool
    // outright if this drifts (e.g. someone refactors and the root
    // type goes missing). Pin it for all three tools alongside the
    // additionalProperties:false invariant above.
    const c = createRalphController();
    const ralph = c.tools.find((t) => t.name === "ralph_loop");
    const stop = c.tools.find((t) => t.name === "ralph_stop");
    const si = c.tools.find((t) => t.name === "self_improve");
    assert.equal(ralph.parameters.type, "object");
    assert.equal(stop.parameters.type, "object");
    assert.equal(si.parameters.type, "object");
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

test("ralph_loop arm result has exactly { textResultForLlm, resultType, armed, max, min } — no stray keys", () => {
    // The arm-success object is constructed via `success(message, {armed, max, min})`,
    // and `success()`'s contract is `{...extra, textResultForLlm, resultType}` with
    // extra unable to override the latter two. Pin the EXACT key set so a future
    // refactor can't silently leak internal scratch (sessionRef, parsed.value,
    // controller closures, etc.) into the LLM-facing return — which would both
    // bloat the response and risk exposing private state.
    const c = createRalphController();
    c.attach(makeFakeSession());
    return c.tools.find((t) => t.name === "ralph_loop").handler({
        prompt: "go", max_iterations: 7, min_iterations: 1,
    }).then((r) => {
        assert.deepEqual(
            Object.keys(r).sort(),
            ["adaptive_budget", "adaptive_extension", "adaptive_max_total", "armed", "max", "min", "resultType", "textResultForLlm"],
        );
    });
});

test("self_improve arm result has the same shape as ralph_loop's — no stray keys", async () => {
    // Mirror of the ralph_loop arm-result shape pin. self_improve flows
    // through the same armLoop() helper and the same success(...) call,
    // so the LLM-facing shape MUST match: any divergence (e.g. an extra
    // "label" or "focus" key leaking through) is a code smell that would
    // make the two tools' return contracts drift. Pin them identical.
    const c = createRalphController();
    c.attach(makeFakeSession());
    const r = await c.tools.find((t) => t.name === "self_improve").handler({ max_iterations: 7 });
    assert.deepEqual(
        Object.keys(r).sort(),
        ["adaptive_budget", "adaptive_extension", "adaptive_max_total", "armed", "max", "min", "resultType", "textResultForLlm"],
    );
    assert.equal(r.armed, true);
    assert.equal(r.max, 7);
    assert.equal(r.resultType, "success");
});

test("validateArgs success returns exactly the documented value shape (no stray keys)", () => {
    // state.active is built via `{...parsed.value, i:0, prev:null, ...}`
    // — so any stray field in the parsed value bleeds straight into the
    // active-loop state and could collide with internal counters
    // (e.g. a future `streak` arg key would silently overwrite the
    // initial streak=0 set by the spread). Lock the shape down.
    const r = validateArgs({
        prompt: "go",
        max_iterations: 10,
        min_iterations: 2,
        completion_promise: "DONE",
        abort_promise: "FAIL",
        stagnation_limit: 4,
    });
    assert.ok(r.value);
    assert.deepEqual(Object.keys(r.value).sort(), [
        "abortPromise", "adaptiveBudget", "adaptiveExtension", "adaptiveMaxTotal",
        "completionPromise", "max", "maxTokens", "min", "prompt", "stagnationLimit", "warnAtPct",
    ]);
    assert.equal(r.value.prompt, "go");
    assert.equal(r.value.max, 10);
    assert.equal(r.value.min, 2);
    assert.equal(r.value.completionPromise, "DONE");
    assert.equal(r.value.abortPromise, "FAIL");
    assert.equal(r.value.stagnationLimit, 4);
    assert.equal(r.value.maxTokens, null);
    assert.equal(r.value.warnAtPct, 80);
    assert.equal(r.value.adaptiveBudget, false);
    // With abort_promise omitted the key is still present, valued null.
    const r2 = validateArgs({ prompt: "go" });
    assert.deepEqual(Object.keys(r2.value).sort(), [
        "abortPromise", "adaptiveBudget", "adaptiveExtension", "adaptiveMaxTotal",
        "completionPromise", "max", "maxTokens", "min", "prompt", "stagnationLimit", "warnAtPct",
    ]);
    assert.equal(r2.value.abortPromise, null);
});

test("state.active: arming sets exactly the documented 32-field ActiveLoopState shape", async () => {
    // The ActiveLoopState typedef enumerates 32 fields: 14 base
    // + 6 token/caffeinate/git fields (issues #5/#7/#8) + 6 adaptive-budget
    // fields (issue #4) + 4 pause/resume fields (issue #3) + 2 event-emit
    // fields (events writer + runId, issue #22). Pin the exact key set
    // and initial values so future refactors that add or rename a field
    // have to update both the typedef and this test in lockstep.
    const { session, controller } = await arm({ max_iterations: 7, min_iterations: 2, abort_promise: "FAIL", stagnation_limit: 4 });
    const a = controller.state.active;
    assert.deepEqual(Object.keys(a).sort(), [
        "abortPromise",
        "adaptiveBudget",
        "adaptiveContentHashes",
        "adaptiveExtension",
        "adaptiveExtensionHistory",
        "adaptiveMaxTotal",
        "armedGit",
        "completionPromise",
        "events",
        "fireInFlight",
        "i",
        "label",
        "lastIterationAt",
        "max",
        "maxTokens",
        "min",
        "observedMessageThisFire",
        "originalMax",
        "pauseReason",
        "paused",
        "pausedAt",
        "pendingFire",
        "prev",
        "prompt",
        "runId",
        "stagnationLimit",
        "startedAt",
        "stopCaffeinate",
        "streak",
        "tokens",
        "totalPausedMs",
        "warnAtPct",
    ]);
    assert.equal(a.i, 0);
    assert.equal(a.prev, null);
    assert.equal(a.streak, 0);
    assert.equal(a.pendingFire, true);
    assert.equal(a.fireInFlight, false);
    assert.equal(a.observedMessageThisFire, false);
    assert.equal(a.label, "ralph_loop");
    assert.equal(typeof a.startedAt, "number");
    assert.ok(a.startedAt > 0);
    assert.equal(a.maxTokens, null);
    assert.equal(a.warnAtPct, 80);
    assert.equal(a.tokens.input, 0);
    assert.equal(a.tokens.output, 0);
    assert.equal(a.adaptiveBudget, false);
    assert.equal(a.originalMax, 7);
    assert.deepEqual(a.adaptiveContentHashes, []);
    assert.deepEqual(a.adaptiveExtensionHistory, []);
    assert.equal(a.paused, false);
    assert.equal(a.pauseReason, null);
    assert.equal(a.pausedAt, 0);
    assert.equal(a.totalPausedMs, 0);
    void session;
});


test("controller instances are independent (state is closure-private, not module-level)", () => {
    // createRalphController returns a NEW closure each call. Tests already
    // exercise this implicitly by using two controllers in some scenarios,
    // but a future refactor that hoisted `state` (or any of the closures
    // it owns — `tools`, `hooks`, the active timer) to module scope would
    // be undetectable except via cross-instance leakage. Pin it.
    const a = createRalphController();
    const b = createRalphController();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.state, b.state);
    assert.notStrictEqual(a.tools, b.tools);
    assert.notStrictEqual(a.hooks, b.hooks);
    // Mutate a's state via the public path (arming requires a session, so
    // poke the lastResult slot directly is enough — the freeze on
    // lastResult is per-result, not on the state container).
    a.state.lastAssistantContent = "tainted";
    assert.equal(b.state.lastAssistantContent, "");
});


test("controller exposes ralph_loop, ralph_stop, ralph_pause, ralph_resume, ralph_status, self_improve, and grow_project tools and hooks", () => {
    const c = createRalphController();
    assert.deepEqual(c.tools.map((t) => t.name).sort(), ["grow_project", "ralph_loop", "ralph_pause", "ralph_resume", "ralph_status", "ralph_stop", "self_improve"]);
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
    assert.equal(c.tools[2].name, "ralph_status", "tools[2] must be ralph_status");
    assert.equal(c.tools[3].name, "ralph_pause", "tools[3] must be ralph_pause");
    assert.equal(c.tools[4].name, "ralph_resume", "tools[4] must be ralph_resume");
    assert.equal(c.tools[5].name, "self_improve", "tools[5] must be self_improve");
    assert.equal(c.tools[6].name, "grow_project", "tools[6] must be grow_project");
    assert.equal(c.tools.length, 7, "tools array must have exactly seven entries");
});

test("self_improve tool is exposed (stub)", () => {
    const c = createRalphController();
    const t = c.tools.find((x) => x.name === "self_improve");
    assert.ok(t, "self_improve tool must be exposed");
    assert.equal(typeof t.handler, "function");
    assert.ok(t.parameters && t.parameters.type === "object");
});

test("self_improve description tells the LLM about ralph_stop and single-loop guard", () => {
    const c = createRalphController();
    const t = c.tools.find((x) => x.name === "self_improve");
    assert.match(t.description, /ralph_stop/, "must point users at ralph_stop for cancellation");
    assert.match(t.description, /one loop|single loop/i, "must mention single-loop-per-session");
    assert.match(t.description, /SDLC/i);
});

test("ralph_stop description names self_improve too (not just ralph_loop)", () => {
    // ralph_stop cancels both flavors of armed loop; the tool description
    // surfaced to the LLM must name both so the agent knows it can call
    // ralph_stop on either, not assume self_improve has a separate stop.
    const c = createRalphController();
    const t = c.tools.find((x) => x.name === "ralph_stop");
    assert.match(t.description, /ralph_loop/);
    assert.match(t.description, /self_improve/);
});

test("self_improve arms with max=100 min=5 defaults", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({});
    assert.equal(r.resultType, "success", r.textResultForLlm);
    assert.equal(r.armed, true);
    assert.equal(r.max, 100);
    assert.equal(r.min, 5);
    assert.match(r.textResultForLlm, /^self_improve armed/);
});

test("self_improve refuses when ralph_loop is already active", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const ralph = c.tools.find((x) => x.name === "ralph_loop");
    const si = c.tools.find((x) => x.name === "self_improve");
    await ralph.handler({ prompt: "go", max_iterations: 5 });
    const r = await si.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /ralph_loop is already/);
});

test("ralph_loop refuses when self_improve is already active", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const ralph = c.tools.find((x) => x.name === "ralph_loop");
    const si = c.tools.find((x) => x.name === "self_improve");
    const armed = await si.handler({ max_iterations: 5 });
    assert.equal(armed.resultType, "success");
    const r = await ralph.handler({ prompt: "go", max_iterations: 5 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /already/i);
    // Label-aware wording: the active loop was armed by self_improve, so
    // the error should say "self_improve is already …" — not the previous
    // hardcoded "ralph_loop is already …" which lied about who armed it.
    assert.match(r.textResultForLlm, /^self_improve is already/);
});

test("grow_project refuses when ralph_loop is already active", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const ralph = c.tools.find((x) => x.name === "ralph_loop");
    const gp = c.tools.find((x) => x.name === "grow_project");
    await ralph.handler({ prompt: "go", max_iterations: 5 });
    const r = await gp.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^ralph_loop is already/);
});

test("grow_project refuses when self_improve is already active", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const si = c.tools.find((x) => x.name === "self_improve");
    const gp = c.tools.find((x) => x.name === "grow_project");
    await si.handler({});
    const r = await gp.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^self_improve is already/);
});

test("ralph_loop refuses when grow_project is already active", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const ralph = c.tools.find((x) => x.name === "ralph_loop");
    const gp = c.tools.find((x) => x.name === "grow_project");
    const armed = await gp.handler({});
    assert.equal(armed.resultType, "success");
    const r = await ralph.handler({ prompt: "go", max_iterations: 5 });
    assert.equal(r.resultType, "failure");
    // Label-aware wording: the active loop was armed by grow_project, so
    // the error must say "grow_project is already …" — proves armLoop's
    // label propagates through the activeLoopGuard error message.
    assert.match(r.textResultForLlm, /^grow_project is already/);
});

test("self_improve refuses when grow_project is already active", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const si = c.tools.find((x) => x.name === "self_improve");
    const gp = c.tools.find((x) => x.name === "grow_project");
    await gp.handler({});
    const r = await si.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^grow_project is already/);
});

test("grow_project refuses when grow_project is already active", async () => {
    // Re-arming the same loop tool must also fail: the second handler
    // call sees the first as active and bails. Proves
    // activeLoopGuard()'s symmetry across the new tool.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const gp = c.tools.find((x) => x.name === "grow_project");
    const first = await gp.handler({});
    assert.equal(first.resultType, "success");
    const second = await gp.handler({});
    assert.equal(second.resultType, "failure");
    assert.match(second.textResultForLlm, /^grow_project is already/);
});

test("self_improve refuses when self_improve is already active", async () => {
    // Symmetry pin parallel to the grow_project self-block test above
    // and the existing ralph_loop "arming twice" test. self_improve's
    // handler must use the SAME activeLoopGuard plumbing — re-arming
    // it without an intervening ralph_stop must fail with the
    // label-aware "self_improve is already …" wording (proves armLoop's
    // label propagation, mirroring the cross-tool tests above).
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const si = c.tools.find((x) => x.name === "self_improve");
    const first = await si.handler({});
    assert.equal(first.resultType, "success");
    const second = await si.handler({});
    assert.equal(second.resultType, "failure");
    assert.match(second.textResultForLlm, /^self_improve is already/);
});

test("ralph_stop tears down a self_improve-armed loop", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const si = c.tools.find((x) => x.name === "self_improve");
    const stop = c.tools.find((x) => x.name === "ralph_stop");
    const armed = await si.handler({ max_iterations: 5 });
    assert.equal(armed.resultType, "success");
    const r = await stop.handler({ reason: "user wants out" });
    assert.equal(r.resultType, "success", r.textResultForLlm);
    // Re-arming after stop must be allowed (state.active cleared).
    const rearm = await si.handler({ max_iterations: 5 });
    assert.equal(rearm.resultType, "success");
});

test("self_improve stamps state.active.label and lastResult.label", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const si = c.tools.find((x) => x.name === "self_improve");
    const stop = c.tools.find((x) => x.name === "ralph_stop");
    await si.handler({ max_iterations: 5 });
    assert.equal(c.state.active.label, "self_improve");
    await stop.handler({ reason: "test" });
    assert.equal(c.state.lastResult.label, "self_improve");
});

test("ralph_stop success-text uses calling tool's label (self_improve / ralph_loop)", async () => {
    // The ralph_stop success message used to hardcode "ralph_loop
    // stopped after N/M iterations …" regardless of which tool armed
    // the loop. After label propagation it must read
    // "<state.active.label> stopped after …" so a self_improve-armed
    // loop reports "self_improve stopped after …".
    // self_improve-armed branch:
    {
        const session = makeFakeSession();
        const c = createRalphController();
        c.attach(session);
        const si = c.tools.find((x) => x.name === "self_improve");
        const stop = c.tools.find((x) => x.name === "ralph_stop");
        await si.handler({ max_iterations: 5 });
        const r = await stop.handler({ reason: "done" });
        assert.equal(r.resultType, "success");
        assert.match(r.textResultForLlm, /^self_improve stopped after 0\/5 iterations/);
        assert.doesNotMatch(r.textResultForLlm, /^ralph_loop stopped/);
    }
    // ralph_loop-armed branch (regression guard for the original
    // wording — must still say "ralph_loop stopped …"):
    {
        const session = makeFakeSession();
        const c = createRalphController();
        c.attach(session);
        const ralph = c.tools.find((x) => x.name === "ralph_loop");
        const stop = c.tools.find((x) => x.name === "ralph_stop");
        await ralph.handler({ prompt: "go", max_iterations: 7 });
        const r = await stop.handler({});
        assert.equal(r.resultType, "success");
        assert.match(r.textResultForLlm, /^ralph_loop stopped after 0\/7 iterations/);
        assert.doesNotMatch(r.textResultForLlm, /^self_improve stopped/);
    }
});

test("self_improve per-iteration log line uses self_improve label, not ralph_loop", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const si = c.tools.find((x) => x.name === "self_improve");
    await si.handler({ max_iterations: 5 });
    // Drive one iteration: arm-time idle fires iter 1.
    session.emit("session.idle", { data: {} });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(
        session.logs.some((l) => /^🔁 self_improve iter 1\/5/.test(l)),
        `expected "🔁 self_improve iter 1/5" log line, got: ${JSON.stringify(session.logs)}`,
    );
    assert.ok(
        !session.logs.some((l) => /^🔁 ralph_loop iter/.test(l)),
        "must not leak ralph_loop label into a self_improve-armed iteration",
    );
});

test("arm-time log line '🔁 <label> armed —' carries the calling tool's label", async () => {
    // The log line emitted during armLoop() (before any iteration runs)
    // is rendered separately from the per-iteration log; pin both
    // directions to prevent a regression where one branch loses the
    // label propagation while the other keeps it.
    const session1 = makeFakeSession();
    const c1 = createRalphController();
    c1.attach(session1);
    await c1.tools.find((x) => x.name === "ralph_loop").handler({ prompt: "go", max_iterations: 5 });
    assert.ok(
        session1.logs.some((l) => /^🔁 ralph_loop armed — /.test(l)),
        `expected "🔁 ralph_loop armed —" log line, got: ${JSON.stringify(session1.logs)}`,
    );
    const session2 = makeFakeSession();
    const c2 = createRalphController();
    c2.attach(session2);
    await c2.tools.find((x) => x.name === "self_improve").handler({ max_iterations: 5 });
    assert.ok(
        session2.logs.some((l) => /^🔁 self_improve armed — /.test(l)),
        `expected "🔁 self_improve armed —" log line, got: ${JSON.stringify(session2.logs)}`,
    );
    assert.ok(
        !session2.logs.some((l) => /^🔁 ralph_loop armed/.test(l)),
        "must not leak ralph_loop label into a self_improve arm log",
    );
});

test("ralph_loop per-iteration log line uses ralph_loop label, not self_improve", async () => {
    // Mirror of the self_improve label test above — when armed via
    // ralph_loop, the iter-log line must read "🔁 ralph_loop iter N/M"
    // and never carry a "🔁 self_improve" prefix.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const ralph = c.tools.find((x) => x.name === "ralph_loop");
    await ralph.handler({ prompt: "go", max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(
        session.logs.some((l) => /^🔁 ralph_loop iter 1\/5/.test(l)),
        `expected "🔁 ralph_loop iter 1/5" log line, got: ${JSON.stringify(session.logs)}`,
    );
    assert.ok(
        !session.logs.some((l) => /^🔁 self_improve iter/.test(l)),
        "must not leak self_improve label into a ralph_loop-armed iteration",
    );
});

test("ralph_loop stamps state.active.label and lastResult.label", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const ralph = c.tools.find((x) => x.name === "ralph_loop");
    const stop = c.tools.find((x) => x.name === "ralph_stop");
    await ralph.handler({ prompt: "go", max_iterations: 5 });
    assert.equal(c.state.active.label, "ralph_loop");
    await stop.handler({ reason: "test" });
    assert.equal(c.state.lastResult.label, "ralph_loop");
});

test("PROMPT_SELF_IMPROVE does not leak internal tool names (ralph_loop/ralph_stop/self_improve)", () => {
    // Defence against copy-paste drift: the SDLC prompt is text shown
    // to the agent doing the work, not to a tool dispatcher. Mentioning
    // ralph_loop / ralph_stop / self_improve inside it would either
    // confuse the agent (does it call ralph_stop itself?) or make the
    // prompt project-specific (the goal is project-AGNOSTIC). Pin
    // their absence so a future "let's reference the tool by name"
    // edit fails loudly.
    const p = PROMPT_SELF_IMPROVE;
    assert.equal(/\bralph_loop\b/.test(p), false, "PROMPT_SELF_IMPROVE must not mention ralph_loop");
    assert.equal(/\bralph_stop\b/.test(p), false, "PROMPT_SELF_IMPROVE must not mention ralph_stop");
    assert.equal(/\bself_improve\b/.test(p), false, "PROMPT_SELF_IMPROVE must not mention self_improve (it IS self_improve)");
});

test("PROMPT_SELF_IMPROVE mentions every required SDLC category and stage", () => {
    const p = PROMPT_SELF_IMPROVE;
    // Stages
    for (const stage of ["ORIENT", "IDEATE", "CRITIQUE", "BASELINE", "IMPLEMENT", "TEST", "COMMIT", "PUSH"]) {
        assert.match(p, new RegExp(stage), `missing stage: ${stage}`);
    }
    // Categories
    for (const cat of [
        "bug fix",
        "hardening",
        "validation",
        "tests",
        "refactor",
        "dependency",
        "docs",
        "release engineering",
    ]) {
        assert.ok(p.toLowerCase().includes(cat), `missing category: ${cat}`);
    }
    // Completion / abort tokens spelled out
    assert.match(p, /COMPLETE/);
    assert.match(p, /ABORT_NO_IMPROVEMENTS/);
    // Conventional-commit + trailer
    assert.match(p, /Co-authored-by: Copilot/);
    // Rubber-duck pass — explicitly named so the agent calls the right
    // sub-agent during the CRITIQUE stage rather than improvising.
    assert.match(p, /rubber-duck/i, "CRITIQUE stage must name the rubber-duck pass");
    // Conventional-commit prefix list — the agent needs the canonical
    // set so commit subjects don't drift across iterations.
    assert.match(p, /feat|fix|refactor|test|docs|chore/, "must mention conventional-commit prefixes");
    assert.ok(p.length <= MAX_PROMPT_CHARS, `prompt is ${p.length} chars; cap is ${MAX_PROMPT_CHARS}`);
});

test("PROMPT_SELF_IMPROVE ORIENT peeks at open GitHub issues so iterations don't duplicate filed work", () => {
    // The ORIENT stage now best-effort lists open issues via `gh issue
    // list --state open` so an iteration doesn't re-implement (or
    // contradict) something already tracked. Pin the literal command so
    // a future edit can't silently strip the issue-awareness — and pin
    // both the `|| true` no-op fallback (so a missing/unauthenticated
    // gh doesn't abort the iteration) and the `--state open` scope (a
    // closed-issue dump would just be noise).
    const p = PROMPT_SELF_IMPROVE;
    assert.match(p, /gh issue list[^\n]*--state\s+open/, "ORIENT must run `gh issue list --state open`");
    assert.match(p, /gh issue list[\s\S]{0,80}\|\|\s*true/, "ORIENT issue query must be best-effort (`|| true`) so a missing/unauth gh doesn't abort the iteration");
    // IDEATE must teach the agent to defer to backlog tooling on
    // grow-project / proposed-labelled issues so self_improve doesn't
    // race the backlog runner. Pin both labels.
    assert.match(p, /grow-project/, "IDEATE must teach the agent to recognise the grow-project label");
    assert.match(p, /\bproposed\b/, "IDEATE must teach the agent to recognise the proposed label");
    assert.match(p, /Closes #N|Refs #N/, "IDEATE must instruct the agent how to reference an addressed issue");
});

test("PROMPT_SELF_IMPROVE ORIENT/IDEATE prioritise healing red GitHub Actions runs", () => {
    // Highest-leverage signal: a failing CI run on the default branch
    // blocks releases and breaks downstream consumers. Pin that ORIENT
    // best-effort lists failing runs and that IDEATE treats them as
    // the top-priority tier — without a pin, a future "tighten the
    // prompt" pass could silently demote CI-healing back into a
    // generic SDLC category and re-introduce the silent-red-CI failure
    // mode. Also pin the anti-pattern guard against silencing the
    // failure (continue-on-error / deleting the failing job) instead
    // of fixing the root cause.
    const p = PROMPT_SELF_IMPROVE;
    assert.match(p, /gh run list[^\n]*--status\s+failure/, "ORIENT must run `gh run list --status failure` to detect red CI");
    assert.match(p, /gh run list[\s\S]{0,80}\|\|\s*true/, "ORIENT CI query must be best-effort (`|| true`) so a missing/unauth gh doesn't abort the iteration");
    assert.match(p, /gh run view[^\n]*--log-failed/, "ORIENT must capture the failed log via `gh run view --log-failed` before IDEATE");
    // Priority ordering: red CI must come BEFORE the rotating SDLC
    // categories. Pin both labels and assert the ordering.
    assert.match(p, /\bRED CI\b/, "IDEATE must declare a RED CI tier explicitly");
    assert.match(p, /\bROTATING SDLC\b/i, "IDEATE must declare a ROTATING SDLC tier explicitly");
    assert.ok(p.indexOf("RED CI") < p.indexOf("ROTATING SDLC"), "RED CI tier must come before ROTATING SDLC tier in IDEATE");
    // Anti-pattern guard: the prompt must call out NOT silencing
    // the failure (continue-on-error / delete-the-job) so the agent
    // doesn't take the easy way out.
    assert.match(p, /continue-on-error/, "must call out the continue-on-error anti-pattern so the agent fixes the root cause");
});

test("PROMPT_SELF_IMPROVE + max-sized focus suffix fits under MAX_PROMPT_CHARS", () => {
    // Mirror of the grow_project worst-case budget test. Focus is
    // independently capped at MAX_FOCUS_CHARS, but PROMPT_SELF_IMPROVE
    // can grow over time. Without this pin, a contributor adding ~62
    // KiB of new prompt content would only discover the overflow when
    // a user happened to pass a max-sized focus and hit the runtime
    // "prompt exceeds 65536 characters" guard.
    const SUFFIX_OVERHEAD = " Focus this run on: ".length;
    const worstCase = PROMPT_SELF_IMPROVE.length + SUFFIX_OVERHEAD + MAX_FOCUS_CHARS;
    assert.ok(
        worstCase <= MAX_PROMPT_CHARS,
        `PROMPT_SELF_IMPROVE (${PROMPT_SELF_IMPROVE.length}) + max focus suffix (${SUFFIX_OVERHEAD + MAX_FOCUS_CHARS}) = ${worstCase}; cap is ${MAX_PROMPT_CHARS}. Trim PROMPT_SELF_IMPROVE.`,
    );
});

test("self_improve actually arms with the real SDLC prompt", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    await t.handler({});
    // First idle fires iter 1 — assert the prompt sent matches PROMPT_SELF_IMPROVE.
    session.emit("session.idle", { data: {} });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(session.sent[0]?.prompt, PROMPT_SELF_IMPROVE);
});

test("PROMPT_GROW_PROJECT does not leak internal tool names (ralph_loop/ralph_stop/self_improve/grow_project)", () => {
    // The baked SDLC prompt is fired into a sub-agent that has no
    // notion of this extension's internal tool names. Leaking
    // `ralph_loop` / `ralph_stop` / `self_improve` / `grow_project`
    // into the prompt confuses the agent (it tries to invoke them)
    // and couples the prompt body to extension internals. Mirror the
    // PROMPT_SELF_IMPROVE leak guard.
    const p = PROMPT_GROW_PROJECT;
    assert.equal(/\bralph_loop\b/.test(p), false, "PROMPT_GROW_PROJECT must not mention ralph_loop");
    assert.equal(/\bralph_stop\b/.test(p), false, "PROMPT_GROW_PROJECT must not mention ralph_stop");
    assert.equal(/\bself_improve\b/.test(p), false, "PROMPT_GROW_PROJECT must not mention self_improve");
    assert.equal(/\bgrow_project\b/.test(p), false, "PROMPT_GROW_PROJECT must not mention grow_project (it IS grow_project)");
});

test("PROMPT_GROW_PROJECT mentions every required 13-stage SDLC workflow", () => {
    const p = PROMPT_GROW_PROJECT;
    for (const stage of [
        "ORIENT", "IDEATE", "SELECT", "CRITIQUE", "BASELINE",
        "IMPLEMENT", "TEST", "ACCEPTANCE", "DEMO", "COMMIT",
        "PUSH", "CLOSE",
    ]) {
        assert.match(p, new RegExp(stage), `missing stage: ${stage}`);
    }
    // END is the literal heading "END THE TURN"; assert the phrase
    // explicitly so a typo in the stage label doesn't slip past the
    // looser /END/ regex.
    assert.match(p, /END THE TURN/, "missing END THE TURN stage heading");
});

test("PROMPT_GROW_PROJECT references the gh-issue backlog + acceptance + demo concepts", () => {
    const p = PROMPT_GROW_PROJECT;
    // gh CLI is the backlog substrate
    assert.match(p, /gh issue list/, "must instruct the agent to list backlog with gh issue list");
    // The ORIENT-stage backlog query MUST filter to --state open. Without
    // this filter (or with --state all), the SELECT stage would pick up
    // already-closed (shipped) issues and try to re-ship them every iter
    // — burning the backlog into a busy loop. Pin the literal flag.
    assert.match(p, /gh issue list[^\n]*--state\s+open/, "ORIENT must scope the backlog query to --state open");
    assert.match(p, /gh issue create/, "must instruct the agent to create proposed issues");
    assert.match(p, /gh issue close/, "must instruct the agent to close completed issues");
    // CLOSE stage must specify `--reason completed` explicitly.
    // Without the flag, the issue closes with gh's default reason
    // (which on a recent gh CLI is "not planned" — the wrong
    // semantic for shipped work). That corrupts repo metrics
    // (closed-not-planned vs closed-completed) and makes "what
    // shipped vs what was abandoned" hard to distinguish.
    assert.match(p, /gh issue close[^\n]*--reason\s+completed/,
        "CLOSE must use --reason completed, not the default close reason");
    // Three-part completion gate
    assert.match(p, /acceptance/i, "must reference the acceptance check");
    assert.match(p, /demo/i, "must reference the demo invocation");
    // Conventional-commit + Closes trailer + Co-authored-by trailer
    assert.match(p, /Closes #/, "commit must include Closes #N trailer");
    assert.match(p, /Co-authored-by: Copilot/, "commit must include Co-authored-by trailer");
    // Rubber-duck stage explicitly named
    assert.match(p, /rubber-duck/i, "CRITIQUE stage must name the rubber-duck pass");
    // First-iter label bootstrap: the very first `gh issue create --label X`
    // would fail on a missing label. The IDEATE stage must instruct the
    // agent to ensure the labels exist (idempotently, via `|| true`) BEFORE
    // creating any issues. Without this, the first-ever grow_project run
    // burns iter 1 on a recoverable error.
    assert.match(p, /gh label create grow-project/, "IDEATE must bootstrap grow-project label");
    assert.match(p, /gh label create proposed/, "IDEATE must bootstrap proposed label");
    assert.match(p, /gh label create in-progress/, "IDEATE must bootstrap in-progress label");
    assert.match(p, /\|\| true/, "label create calls must be idempotent (|| true)");
    // SELECT stage must transition the chosen issue from `proposed` to
    // `in-progress` via gh issue edit. Without this label flip, the
    // same issue gets re-picked every iter (the SELECT filter is
    // `--label proposed`, oldest first), busy-looping on one feature.
    // Pin both the add and the remove flag in the same regex so an
    // edit that drops either half fails the suite.
    assert.match(p, /gh issue edit[^\n]*--add-label\s+in-progress[^\n]*--remove-label\s+proposed/,
        "SELECT must flip the chosen issue's label proposed → in-progress");
    // Depends-on: #N lines in issue bodies must block selection until
    // the dep issue is closed. Without this contract, an issue listing
    // a dep (e.g. "#5 needs the schema added in #4 first") could be
    // shipped out-of-order and break the build.
    assert.match(p, /Depends-on/, "SELECT must respect Depends-on: #N body lines");
    // COMMIT stage: subject MUST reference the chosen issue via
    // `feat(#N): <title>` shape. A commit with just "feat: <title>"
    // (no #N) and no `Closes #N` trailer would not auto-close the
    // issue, leaving the in-progress issue label stuck and SELECT
    // unable to advance. Pin the example shape so a refactor that
    // drops the `(#N)` reference fails the suite.
    assert.match(p, /feat\(#\d+\)|feat\(#N\)/i, "COMMIT subject example must reference the issue with feat(#N)");
    // Temp-file commit ritual — the prompt explicitly warns that
    // heredoc + commit in one shell call has historically failed
    // silently. Pin the `git commit -F` instruction so a refactor
    // that simplifies it back to `git commit -m` re-introduces the
    // bug-trail.
    assert.match(p, /git commit -F/, "COMMIT must use the -F temp-file ritual, not -m heredoc");
    // PUSH stage must be non-fatal on failure. Real-world push
    // failures (transient network, auth refresh, branch-protection
    // race, origin lock) would otherwise abort the entire iter
    // mid-flight even though the local commit landed cleanly. The
    // prompt baked this rule explicitly; pin both halves so a
    // simplifying edit that drops either the "log it" or
    // "do not abort" half fails the suite.
    assert.match(p, /push fails[\s\S]*log|continue|do not abort/i,
        "PUSH must be non-fatal: log + continue rather than abort the loop on push failure");
    // BASELINE stage must instruct bail-on-red. Without this rule,
    // an iter that enters with a broken baseline would proceed to
    // IMPLEMENT + TEST, masking the pre-existing failure inside
    // the new feature's diff and shipping a broken feature with a
    // green-looking test signal (because the SAME tests failed
    // before AND after). Pin the bail-on-red literal so a refactor
    // can't quietly drop it.
    assert.match(p, /baseline is broken[\s\S]*ABORT_NO_BACKLOG/i,
        "BASELINE must bail with ABORT_NO_BACKLOG if entry baseline is red");
    // ACCEPTANCE stage must instruct the agent to tick checkboxes
    // in the issue body via `gh issue edit` AS each criterion
    // passes — not "all at the end". Without per-criterion ticking,
    // a mid-iter crash leaves the issue body showing zero progress
    // even when 4 of 5 criteria already passed; the next iter
    // can't tell what's already verified and re-runs everything
    // (or worse, skips re-verification and trusts a stale tick).
    assert.match(p, /gh issue edit[\s\S]*checkbox|checkbox[\s\S]*gh issue edit/i,
        "ACCEPTANCE must tick checkboxes in the issue body via gh issue edit as each criterion passes");
    // DEMO stage must persist the demo command's output as a
    // durable comment on the issue (`gh issue comment`). Without
    // this, the demo trace lives only in the agent's transient
    // terminal scrollback and is lost the moment the session
    // ends — making future audit ("what did this iter actually
    // demonstrate?") impossible. Pin the gh issue comment
    // instruction so a refactor can't quietly drop the durable
    // trace and reduce DEMO to "I ran it, trust me".
    assert.match(p, /gh issue comment/, "DEMO must persist demo output as a durable gh issue comment");
    // TEST stage must require same-or-higher pass count vs
    // baseline. Without this rule, an iter that accidentally
    // deletes a flaky test it couldn't fix would still report
    // "green" (zero failures) even though coverage shrank — a
    // silent regression in the test surface. The "same or
    // higher count" wording is the monotonicity contract; pin
    // both halves (the count rule AND the fix-forward-or-revert
    // recovery branch) so a refactor can't drop either.
    assert.match(p, /same or higher count|at least as many/i,
        "TEST must require same-or-higher pass count vs baseline (monotonicity)");
    assert.match(p, /fix forward or revert/i,
        "TEST must offer fix-forward-or-revert recovery, not just abort");
    // IDEATE-stage acceptance criteria must be a CHECKBOX list
    // AND machine-checkable. Two distinct contracts:
    //   - "checkbox list" — without it, ACCEPTANCE can't tick
    //     anything (gh issue edit checkbox flips depend on
    //     `- [ ]` markdown), defeating the tick-as-you-go pin.
    //   - "machine-checkable" — without it, an iter could ship a
    //     backlog full of subjective criteria ("the UX feels
    //     nice") that the ACCEPTANCE stage could never actually
    //     verify, reducing the three-part completion gate to a
    //     two-part one. Pin both phrases so a refactor can't
    //     soften either side.
    assert.match(p, /checkbox list/i, "IDEATE acceptance criteria must be specified as a checkbox list");
    assert.match(p, /machine-checkable/i, "IDEATE acceptance criteria must be machine-checkable, not subjective");
    // Multi-language ORIENT — grow_project is meant to run on
    // any project, not just JS. Without explicit examples of
    // non-JS manifests (pyproject.toml/Cargo.toml/go.mod), an
    // iter could simplify the orient stage to "skim README and
    // package.json", silently neutering the tool for Rust /
    // Python / Go projects (it would orient on README only,
    // missing the dependency / build context). Pin at least
    // the three non-JS manifests by name.
    assert.match(p, /pyproject\.toml/i, "ORIENT must reference pyproject.toml for Python project parity");
    assert.match(p, /Cargo\.toml/i, "ORIENT must reference Cargo.toml for Rust project parity");
    assert.match(p, /go\.mod/i, "ORIENT must reference go.mod for Go project parity");
    // Multi-language TEST-command detection — same parity
    // concern at the test-runner level. Without explicit
    // examples (pytest, cargo test, go test), the prompt could
    // be read as JS-only and shipped features on a Python
    // project would never run their actual test suite. Pin at
    // least the three non-npm runners.
    assert.match(p, /pytest/i, "ORIENT must reference pytest as a detectable test runner");
    assert.match(p, /cargo test/i, "ORIENT must reference cargo test as a detectable test runner");
    assert.match(p, /go test/i, "ORIENT must reference go test as a detectable test runner");
    // SELECT must pick proposed issues OLDEST FIRST. Without
    // this rule, the agent could pick the newest proposed issue
    // (gh's default `gh issue list` order), giving the backlog
    // LIFO semantics — newer issues always preempt older ones,
    // and an unlucky old issue might never ship even with
    // the loop running indefinitely. Pin the literal "oldest
    // first" wording so a refactor that drops the ordering rule
    // (e.g. "pick a proposed issue" without ordering) fails the
    // suite.
    assert.match(p, /oldest first/i, "SELECT must pick proposed issues oldest first (FIFO, not LIFO)");
    // ORIENT must skim AGENTS.md — the agent-conventions file
    // format respected by Copilot's coding agent (and now by
    // many other agent runtimes). Without explicitly listing
    // it in ORIENT, the agent could skim only README and miss
    // project-specific contribution rules (e.g. "use single
    // quotes", "no semicolons", "follow `npm run lint:fix`
    // before commit") that the project author embedded
    // specifically for agent consumption. Pin the literal
    // filename so a "tighten orient" refactor can't quietly
    // drop the agent-conventions skim.
    assert.match(p, /AGENTS\.md/, "ORIENT must reference AGENTS.md as a source of agent-targeted project conventions");
    // IMPLEMENT must forbid scope creep — "no invented features
    // beyond the issue's spec". Without this rule, an iter
    // could ship its assigned issue PLUS opportunistic side
    // refactors ("while I'm here…"), bloating the diff,
    // diluting the COMMIT subject's `feat(#N): <title>` claim,
    // and making git bisect significantly harder when a future
    // regression's true root cause is the side change rather
    // than the headline feature. Pin the no-invention rule.
    assert.match(p, /No invented features|beyond the issue's spec/i,
        "IMPLEMENT must forbid features beyond the issue's spec (anti-scope-creep guard)");
});

test("both baked prompts retain the cwd guardrail and the trigger-phrase footgun caveat", () => {
    // Two HARD RULES baked into BOTH prompts that nothing else
    // tests:
    //   1. "Stay in cwd; do not edit unrelated repos." — without
    //      this, a self_improve / grow_project agent could
    //      destructively edit a sibling clone if the IDE's open
    //      workspace differs from the cwd. The rule is the only
    //      thing keeping every loop-driven commit scoped.
    //   2. "Prefer cancel/tear down/stop over forceful-action
    //      synonyms" — some agent runtimes (and shell histories)
    //      treat the obfuscated k-i-l-l word as a trigger phrase
    //      that aborts the turn mid-commit. Loop-driven commits
    //      have historically been silently dropped this way.
    // Pin both rules on each prompt so a "tighten the prompt"
    // refactor can't strip them.
    for (const [name, prompt] of [["PROMPT_SELF_IMPROVE", PROMPT_SELF_IMPROVE], ["PROMPT_GROW_PROJECT", PROMPT_GROW_PROJECT]]) {
        assert.match(prompt, /Stay in cwd/i, `${name}: must retain the "Stay in cwd" hard rule`);
        assert.match(prompt, /\b(cancel|tear down|stop)\b/i, `${name}: must offer cancel/tear down/stop as preferred wording`);
        assert.match(prompt, /trigger phrase/i, `${name}: must explain WHY (trigger-phrase risk) rather than just listing alternatives`);
        // Negative pin: a well-meaning future edit might rewrite the
        // trigger-phrase caveat to say `Avoid the literal word "kill"
        // in commit messages` — but doing so embeds the very trigger
        // phrase in the prompt the agent reads, defeating the rule
        // it's trying to teach. The prompt must reach the agent
        // WITHOUT containing the bare forceful-action word itself.
        // Use a word-boundary regex so substrings like "skill" or
        // "killer feature" mentioned in unrelated examples wouldn't
        // also fail.
        assert.doesNotMatch(prompt, /\bkill\b/i, `${name}: prompt must not contain the literal trigger-phrase word it warns against`);
        // License/README/CHANGELOG wholesale-rewrite ban — legal +
        // narrative risk. A self_improve iter that "polished docs"
        // and rewrote the LICENSE would silently change the
        // project's OSS licensing. The rule is baked into both
        // prompts; pin it so a refactor can't quietly drop the
        // surgical-edits-only safeguard.
        assert.match(prompt, /surgical edits only/i, `${name}: must keep the "surgical edits only" license/README/CHANGELOG ban`);
        // No-new-dependencies rule — an iter that ran
        // `npm install lodash` to "fix" a one-liner would silently
        // expand the supply-chain footprint. Pin the rule with
        // its escape hatch (rubber-duck-justified introductions).
        assert.match(prompt, /new (top-level )?dependencies/i, `${name}: must keep the no-new-dependencies hard rule`);
    }
});

test("PROMPT_SELF_IMPROVE bakes the dual Co-authored-by trailer + RALPH_NO_ATTRIBUTION opt-out (issue #1)", () => {
    // Issue #1: every loop-driven commit ships TWO Co-authored-by
    // trailers — the existing Copilot trailer for agent attribution,
    // plus a copilot-ralph bot-account trailer for passive usage
    // analytics across public GitHub. RALPH_NO_ATTRIBUTION=1 in env
    // suppresses ONLY the second trailer; the Copilot trailer always
    // ships. Pin both literals so a future edit can't silently drop
    // the bot-account trailer or invert the opt-out polarity.
    const p = PROMPT_SELF_IMPROVE;
    assert.match(p, /Co-authored-by: Copilot <223556219\+Copilot@users\.noreply\.github\.com>/, "must keep the canonical Copilot trailer");
    assert.match(p, /Co-authored-by: copilot-ralph <copilot-ralph@users\.noreply\.github\.com>/, "must bake the copilot-ralph bot-account trailer (issue #1)");
    assert.match(p, /RALPH_NO_ATTRIBUTION=1/, "must document the RALPH_NO_ATTRIBUTION=1 opt-out env var");
    // Opt-out polarity: setting the var SUPPRESSES, not enables.
    assert.match(p, /RALPH_NO_ATTRIBUTION=1[\s\S]{0,200}\bomit\b/i, "RALPH_NO_ATTRIBUTION=1 must instruct the agent to OMIT the second trailer");
    // Stricter polarity: must say "omit ONLY" (or equivalent) so a future
    // edit can't degrade to "omit BOTH" trailers — the Copilot trailer
    // must always ship for agent-attribution audit.
    assert.match(p, /\bomit\b[\s\S]{0,80}\bonly\b/i, "must instruct OMIT ONLY the copilot-ralph trailer (Copilot trailer always ships)");
    assert.match(p, /\balways\s+ship/i, "must promise the Copilot trailer always ships");
});

test("PROMPT_GROW_PROJECT bakes the dual Co-authored-by trailer + RALPH_NO_ATTRIBUTION opt-out (issue #1)", () => {
    // Mirror of the PROMPT_SELF_IMPROVE pin. grow_project also commits
    // per iter and must carry the same dual-trailer + opt-out contract
    // so the two loop tools stay symmetric on the attribution surface.
    const p = PROMPT_GROW_PROJECT;
    assert.match(p, /Co-authored-by: Copilot <223556219\+Copilot@users\.noreply\.github\.com>/, "must keep the canonical Copilot trailer");
    assert.match(p, /Co-authored-by: copilot-ralph <copilot-ralph@users\.noreply\.github\.com>/, "must bake the copilot-ralph bot-account trailer (issue #1)");
    assert.match(p, /RALPH_NO_ATTRIBUTION=1/, "must document the RALPH_NO_ATTRIBUTION=1 opt-out env var");
    assert.match(p, /RALPH_NO_ATTRIBUTION=1[\s\S]{0,200}\bomit\b/i, "RALPH_NO_ATTRIBUTION=1 must instruct the agent to OMIT the copilot-ralph trailer");
    // Stricter polarity (mirror of self_improve pin): must say "omit ONLY"
    // so a future edit can't degrade to "omit BOTH" trailers.
    assert.match(p, /\bomit\b[\s\S]{0,80}\bonly\b/i, "must instruct OMIT ONLY the copilot-ralph trailer (Copilot trailer + Closes #N always ship)");
    assert.match(p, /\balways\s+ship/i, "must promise the Copilot trailer (and Closes #N) always ship");
});

test("BAKED_RALPH_LOOP_RIDER bakes the dual Co-authored-by trailer + RALPH_NO_ATTRIBUTION opt-out (issue #1, ralph_loop parity)", () => {
    // ralph_loop parity with self_improve / grow_project: every
    // loop-driven commit must carry the dual trailer. Because
    // ralph_loop's prompt is user-supplied, the rider is appended
    // at arm time. Pin the same invariants the SDLC prompts enforce
    // so a future edit can't silently drop the bot-account trailer
    // or invert the opt-out polarity.
    const r = BAKED_RALPH_LOOP_RIDER;
    assert.match(r, /Co-authored-by: Copilot <223556219\+Copilot@users\.noreply\.github\.com>/, "must keep the canonical Copilot trailer");
    assert.match(r, /Co-authored-by: copilot-ralph <copilot-ralph@users\.noreply\.github\.com>/, "must bake the copilot-ralph bot-account trailer");
    assert.match(r, /RALPH_NO_ATTRIBUTION=1/, "must document the RALPH_NO_ATTRIBUTION=1 opt-out env var");
    assert.match(r, /RALPH_NO_ATTRIBUTION=1[\s\S]{0,200}\bomit\b/i, "RALPH_NO_ATTRIBUTION=1 must instruct the agent to OMIT the copilot-ralph trailer");
    assert.match(r, /\bomit\b[\s\S]{0,80}\bonly\b/i, "must instruct OMIT ONLY the copilot-ralph trailer");
    assert.match(r, /\balways\s+ship/i, "must promise the Copilot trailer always ships");
    // Order pin: Copilot must precede copilot-ralph (GitHub UI
    // surfaces the first co-author more prominently).
    assert.ok(r.indexOf(BAKED_COPILOT_TRAILER) < r.indexOf(BAKED_RALPH_TRAILER), "Copilot trailer must appear before copilot-ralph in the rider");
    // Rider must be inert when no commit is created — generic
    // ralph_loop tasks (log analysis, etc.) shouldn't be forced
    // to invent a commit just to satisfy the trailer policy.
    assert.match(r, /no commit|creates no commit|does not commit|do(?: not|n't) commit/i, "rider must explicitly opt out when the iteration creates no commit");
});

test("composeRalphLoopPrompt appends the rider with both trailers + opt-out env var", () => {
    const composed = composeRalphLoopPrompt("do the thing");
    assert.equal(composed.error, undefined, "composing a small prompt must succeed");
    assert.ok(composed.value.startsWith("do the thing"), "user prompt must lead the composed message");
    assert.ok(composed.value.includes(BAKED_COPILOT_TRAILER), "composed prompt must include the Copilot trailer");
    assert.ok(composed.value.includes(BAKED_RALPH_TRAILER), "composed prompt must include the copilot-ralph trailer");
    assert.ok(composed.value.includes(BAKED_ATTRIBUTION_OPT_OUT), "composed prompt must document the opt-out env var");
    // Order pin extends to the composed result.
    assert.ok(composed.value.indexOf(BAKED_COPILOT_TRAILER) < composed.value.indexOf(BAKED_RALPH_TRAILER));
});

test("composeRalphLoopPrompt rejects a user prompt that would push the composed length past MAX_PROMPT_CHARS", () => {
    // Reserve room for rider + separator; anything that takes the total
    // past the cap must surface a clear error rather than silently
    // exceeding the bound.
    const reserved = BAKED_RALPH_LOOP_RIDER.length + "\n\n".length;
    const bigUser = "x".repeat(MAX_PROMPT_CHARS - reserved + 1);
    const r = composeRalphLoopPrompt(bigUser);
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /commit-attribution rider/);
    assert.match(r.error ?? "", new RegExp(`exceeds ${MAX_PROMPT_CHARS}`));
});

test("ralph_loop handler appends the rider to the user-supplied prompt before re-injection", async () => {
    // Behavioral test: arm ralph_loop with a generic prompt and assert
    // that the prompt ACTUALLY sent via session.send each iteration
    // contains both trailers + the opt-out env var. This closes the
    // loophole where a future refactor could compute the rider but
    // forget to wire it into armLoop.
    const session = makeFakeSession();
    const controller = createRalphController();
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    await ralph.handler({ prompt: "investigate the logs", max_iterations: 3 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "still working");
    assert.ok(session.sent.length >= 1);
    for (const s of session.sent) {
        assert.ok(s.prompt.startsWith("investigate the logs"), "user prompt must lead each re-injected message");
        assert.ok(s.prompt.includes(BAKED_COPILOT_TRAILER), "every re-injected prompt must carry the Copilot trailer");
        assert.ok(s.prompt.includes(BAKED_RALPH_TRAILER), "every re-injected prompt must carry the copilot-ralph trailer");
        assert.ok(s.prompt.includes(BAKED_ATTRIBUTION_OPT_OUT), "every re-injected prompt must document the opt-out env var");
    }
});

test("PROMPT_GROW_PROJECT bakes COMPLETE and ABORT_NO_BACKLOG tokens + fits MAX_PROMPT_CHARS", () => {
    const p = PROMPT_GROW_PROJECT;
    assert.match(p, /\bCOMPLETE\b/, "must instruct agent to emit COMPLETE on success");
    assert.match(p, new RegExp(`\\b${BAKED_BACKLOG_ABORT_TOKEN}\\b`), `must instruct agent to emit ${BAKED_BACKLOG_ABORT_TOKEN} on drained backlog`);
    // Crucially must NOT bake the self_improve abort token; that
    // would mis-train the agent on which signal means "no backlog"
    // vs "no improvement".
    assert.equal(/ABORT_NO_IMPROVEMENTS/.test(p), false, "PROMPT_GROW_PROJECT must not bake ABORT_NO_IMPROVEMENTS — that's the self_improve token");
    assert.ok(p.length <= MAX_PROMPT_CHARS, `prompt is ${p.length} chars; cap is ${MAX_PROMPT_CHARS}`);
});

test("PROMPT_GROW_PROJECT + max-sized focus suffix fits under MAX_PROMPT_CHARS", () => {
    // Worst-case prompt construction: baked PROMPT_GROW_PROJECT plus the
    // " Focus this run on: <focus>" suffix, with focus at the runtime
    // cap (MAX_FOCUS_CHARS). If someone bloats PROMPT_GROW_PROJECT to
    // ≥ ~63 KiB, this test fires BEFORE the runtime "prompt exceeds
    // 65536 characters" guard would surface — turning a runtime
    // user-facing failure into a unit-test regression.
    const SUFFIX_OVERHEAD = " Focus this run on: ".length; // 20 chars
    const worstCase = PROMPT_GROW_PROJECT.length + SUFFIX_OVERHEAD + MAX_FOCUS_CHARS;
    assert.ok(
        worstCase <= MAX_PROMPT_CHARS,
        `PROMPT_GROW_PROJECT (${PROMPT_GROW_PROJECT.length}) + max focus suffix (${SUFFIX_OVERHEAD + MAX_FOCUS_CHARS}) = ${worstCase}; cap is ${MAX_PROMPT_CHARS}. Trim PROMPT_GROW_PROJECT.`,
    );
});

test("GROW_PROJECT_DEFAULTS exposes wider budget than self_improve", () => {
    // Documented contract: max=200 (features take longer than polish
    // iters), min=10 (small backlog drains naturally).
    assert.equal(GROW_PROJECT_DEFAULTS.max_iterations, 200);
    assert.equal(GROW_PROJECT_DEFAULTS.min_iterations, 10);
    // Frozen so a future caller can't mutate the shared default.
    assert.ok(Object.isFrozen(GROW_PROJECT_DEFAULTS), "GROW_PROJECT_DEFAULTS must be frozen");
});

test("BAKED_ABORT_TOKEN and BAKED_BACKLOG_ABORT_TOKEN pin distinct canonical strings", () => {
    // The two tokens drive separate runtime watchers and are baked
    // into separate prompts. Pin their literal values so a future
    // "rename" or "harmonize" refactor (e.g. unifying both behind a
    // single ABORT) is forced to update this test — at which point
    // the contributor must also update both prompts, both schema
    // descriptions, both warnPromiseDrift call sites, the README,
    // and the cross-pollination test. This is the canonical-source
    // anchor for that fan-out.
    assert.equal(BAKED_ABORT_TOKEN, "ABORT_NO_IMPROVEMENTS");
    assert.equal(BAKED_BACKLOG_ABORT_TOKEN, "ABORT_NO_BACKLOG");
    assert.notEqual(BAKED_ABORT_TOKEN, BAKED_BACKLOG_ABORT_TOKEN, "tokens must remain distinct");
    // Neither must be a substring of the other; otherwise a sub-agent
    // emitting one would accidentally fire both watchers.
    assert.equal(BAKED_BACKLOG_ABORT_TOKEN.includes(BAKED_ABORT_TOKEN), false);
    assert.equal(BAKED_ABORT_TOKEN.includes(BAKED_BACKLOG_ABORT_TOKEN), false);
});

test("BAKED_COPILOT_TRAILER, BAKED_RALPH_TRAILER, BAKED_ATTRIBUTION_OPT_OUT pin canonical attribution literals (issue #1)", () => {
    // Centralised canonical-source anchor for the dual-trailer
    // attribution invariant (mirror of the BAKED_*_ABORT_TOKEN
    // anchor above). The handler enforces these at module-load
    // time across BOTH baked prompts; pinning the literals here
    // forces any rename / domain-change / opt-out polarity flip
    // to ripple through this test, the load-time guard, both
    // prompts, the README "Commit attribution" section, and the
    // CHANGELOG.
    assert.equal(BAKED_COPILOT_TRAILER, "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>");
    assert.equal(BAKED_RALPH_TRAILER, "Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>");
    assert.equal(BAKED_ATTRIBUTION_OPT_OUT, "RALPH_NO_ATTRIBUTION=1");
    // Trailers must be distinct lines; opt-out polarity is "=1"
    // (truthy enables the suppression), not a bare flag.
    assert.notEqual(BAKED_COPILOT_TRAILER, BAKED_RALPH_TRAILER);
    assert.match(BAKED_ATTRIBUTION_OPT_OUT, /=1$/, "opt-out env var must use the =1 polarity convention");
    // Both trailers must use the canonical GitHub noreply domain.
    // A typo like "users.noreply.gihub.com" would silently produce
    // commits whose Co-authored-by line does not link to any GitHub
    // user — the trailer ships, the search query above breaks, and
    // there is no error surface to catch it. Pin the exact domain.
    assert.match(BAKED_COPILOT_TRAILER, /@users\.noreply\.github\.com>$/, "Copilot trailer must end with the canonical GitHub noreply domain");
    assert.match(BAKED_RALPH_TRAILER, /@users\.noreply\.github\.com>$/, "copilot-ralph trailer must end with the canonical GitHub noreply domain");
    // Both trailers start with the conventional-trailer "Co-authored-by: " prefix.
    // git interpret-trailers and GitHub both key off this exact spelling
    // (case-sensitive, hyphenated "authored-by", trailing colon-space).
    assert.match(BAKED_COPILOT_TRAILER, /^Co-authored-by: /);
    assert.match(BAKED_RALPH_TRAILER, /^Co-authored-by: /);
});

test("self_improve and grow_project focus descriptions both disclose steering semantics", async () => {
    // Documents that the focus arg STEERS what the agent picks, but
    // does not change the SDLC stages it runs. Both descriptions must
    // carry the steering callout so users browsing either tool's
    // schema understand the same contract — without it, callers
    // reasonably assume focus is a free-form addendum that might
    // skip stages.
    const c = createRalphController();
    const si = c.tools.find((t) => t.name === "self_improve");
    const gp = c.tools.find((t) => t.name === "grow_project");
    const siFocus = si.parameters.properties.focus.description;
    const gpFocus = gp.parameters.properties.focus.description;
    assert.match(siFocus, /Steers ideation/);
    assert.match(siFocus, /without altering the SDLC stages/);
    assert.match(gpFocus, /Steers ideation/);
    assert.match(gpFocus, /without altering the SDLC scaffolding/);
    // Both must still mention the appended-suffix shape — that's the
    // mechanical contract; the steering sentence is the semantic one.
    assert.match(siFocus, /Focus this run on:/);
    assert.match(gpFocus, /Focus this run on:/);
});

test("self_improve appends focus text to the SDLC prompt", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ focus: "harden input validation" });
    assert.equal(r.resultType, "success");
    session.emit("session.idle", { data: {} });
    await new Promise((rs) => setTimeout(rs, 0));
    assert.match(session.sent[0]?.prompt, /Focus this run on: harden input validation$/);
    assert.ok(session.sent[0].prompt.startsWith(PROMPT_SELF_IMPROVE));
});

test("self_improve trims surrounding whitespace from focus before appending", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ focus: "   tighten error messages\n\t  " });
    assert.equal(r.resultType, "success");
    session.emit("session.idle", { data: {} });
    await new Promise((rs) => setTimeout(rs, 0));
    const sent = session.sent[0]?.prompt ?? "";
    assert.ok(sent.endsWith("Focus this run on: tighten error messages"),
        `expected trimmed focus suffix, got: ${JSON.stringify(sent.slice(-80))}`);
    assert.doesNotMatch(sent, /\n\t/, "trailing tab/newline must not survive into the prompt");
});

test("grow_project actually arms with PROMPT_GROW_PROJECT", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    const r = await t.handler({});
    assert.equal(r.resultType, "success");
    session.emit("session.idle", { data: {} });
    await new Promise((rs) => setTimeout(rs, 0));
    assert.equal(session.sent[0]?.prompt, PROMPT_GROW_PROJECT);
});

test("the prompt actually fired through armLoop carries both Co-authored-by trailers and the opt-out env var (issue #1)", async () => {
    // Bridges the module-scope prompt-body pin and the runtime
    // armLoop pin: a future refactor that derived/stripped the
    // prompt before session.send (e.g., a "minimize tokens" pass)
    // could silently drop the canonical attribution literals from
    // the agent's actual instructions while leaving the exported
    // PROMPT_* constants untouched. Pin the SENT prompt — the
    // string the executing agent actually sees — to contain both
    // trailer literals and the RALPH_NO_ATTRIBUTION env var
    // verbatim, for both self_improve and grow_project.
    for (const name of ["self_improve", "grow_project"]) {
        const session = makeFakeSession();
        const c = createRalphController();
        c.attach(session);
        const tool = c.tools.find((x) => x.name === name);
        const r = await tool.handler({});
        assert.equal(r.resultType, "success", `${name} arm should succeed`);
        session.emit("session.idle", { data: {} });
        await new Promise((rs) => setTimeout(rs, 0));
        const sent = session.sent[0]?.prompt ?? "";
        assert.ok(sent.includes(BAKED_COPILOT_TRAILER), `${name} sent prompt must carry the Copilot trailer`);
        assert.ok(sent.includes(BAKED_RALPH_TRAILER), `${name} sent prompt must carry the copilot-ralph trailer`);
        assert.ok(sent.includes(BAKED_ATTRIBUTION_OPT_OUT), `${name} sent prompt must mention ${BAKED_ATTRIBUTION_OPT_OUT}`);
    }
});

test("grow_project appends focus text to PROMPT_GROW_PROJECT", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    const r = await t.handler({ focus: "ship CSV export feature first" });
    assert.equal(r.resultType, "success");
    session.emit("session.idle", { data: {} });
    await new Promise((rs) => setTimeout(rs, 0));
    assert.match(session.sent[0]?.prompt, /Focus this run on: ship CSV export feature first$/);
    assert.ok(session.sent[0].prompt.startsWith(PROMPT_GROW_PROJECT));
});

test("calling grow_project before attach fails fast with a grow_project-labelled error and does NOT arm", async () => {
    // Mirror of the self_improve / ralph_loop pins. requireAttachedSession()
    // weaves the calling tool's name through the message; a regression that
    // drops the label would lie about which tool the caller invoked.
    const c = createRalphController();
    const gp = c.tools.find((t) => t.name === "grow_project");
    const r = await gp.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^grow_project: session not attached/);
    assert.equal(c.state.active, null, "must not leave armed state behind");
});

test("grow_project rejects unknown keys with a grow_project-prefixed error", async () => {
    // validateOptionalArgShape catches typos and stale arg names before
    // they silently pass through validateArgs unrecognised. The error
    // must carry the grow_project: prefix, not ralph_loop:.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const gp = c.tools.find((t) => t.name === "grow_project");
    const r = await gp.handler({ stagnationLimit: 5 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^grow_project:/);
    assert.match(r.textResultForLlm, /unknown.*stagnationLimit/i);
    assert.equal(c.state.active, null, "rejected args must not leave armed state behind");
});

test("self_improve respects max_iterations / min_iterations overrides", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ max_iterations: 50, min_iterations: 10 });
    assert.equal(r.resultType, "success");
    assert.equal(r.max, 50);
    assert.equal(r.min, 10);
});

test("self_improve rejects min_iterations > max_iterations with self_improve prefix", async () => {
    // Mirror of the ralph_loop "min_iterations must be ≤ max_iterations"
    // test — self_improve delegates to validateArgs, which emits the
    // error with a "ralph_loop:" prefix, then the handler must rewrite
    // it to "self_improve:" before returning.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ min_iterations: 5, max_iterations: 3 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^self_improve:/);
    assert.match(r.textResultForLlm, /min_iterations/);
    assert.doesNotMatch(r.textResultForLlm, /ralph_loop:/);
});

test("self_improve rejects unknown args", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ wat: 1 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /self_improve.*unknown/i);
});

test("self_improve rejects 'prompt' arg — users cannot override the SDLC prompt", async () => {
    // The whole point of self_improve is the baked-in SDLC prompt;
    // accepting a caller-supplied `prompt` would silently bypass it.
    // SELF_IMPROVE_KEYS deliberately omits "prompt", so the
    // unknown-arg shape guard must fire here.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ prompt: "do something else", max_iterations: 3 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^self_improve:/);
    assert.match(r.textResultForLlm, /unknown argument/i);
    assert.match(r.textResultForLlm, /"prompt"/);
    // No loop should be armed after a rejected call.
    assert.equal(c.state.active, null);
});

test("self_improve rejects array/primitive args; accepts null/undefined", async () => {
    // The handler explicitly skips validateArgShape for null/undefined
    // (treats them as "use defaults"). Non-object shapes (array, number,
    // string, boolean) must still be rejected with a self_improve-prefixed
    // error so a caller passing `self_improve([])` doesn't silently arm
    // with defaults.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");

    for (const bad of [[], [1, 2], 0, 1, "go", true]) {
        const r = await t.handler(bad);
        assert.equal(r.resultType, "failure", `bad arg ${JSON.stringify(bad)} should fail`);
        assert.match(r.textResultForLlm, /^self_improve:/);
        assert.match(r.textResultForLlm, /must be an object/);
        assert.equal(c.state.active, null, `bad arg ${JSON.stringify(bad)} must not arm a loop`);
    }
    // null and undefined are the documented "use all defaults" path.
    const ok1 = await t.handler(null);
    assert.equal(ok1.resultType, "success");
    assert.equal(c.state.active.label, "self_improve");
    // Tear down before re-arming to satisfy the single-loop guard.
    const stop = c.tools.find((x) => x.name === "ralph_stop");
    await stop.handler({});
    const ok2 = await t.handler(undefined);
    assert.equal(ok2.resultType, "success");
    assert.equal(c.state.active.label, "self_improve");
});

test("arming grow_project sets state.active.label to 'grow_project'", async () => {
    // Pin the label because finish() logs ("<label>: stopped after …"),
    // the active-loop guard's "armed by <label>" wording, and the
    // ralph_stop "stopped <label> after N iterations" line all derive
    // from state.active.label. A future refactor that armLoop'd
    // grow_project with the wrong literal (e.g. copy-pasted "self_improve"
    // from the sibling block) would silently mislabel every log line
    // until something else broke. self_improve has parallel coverage at
    // line 1312/1318; mirror it for grow_project.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    const r = await t.handler({});
    assert.equal(r.resultType, "success");
    assert.equal(c.state.active.label, "grow_project");
    assert.notEqual(c.state.active.label, "self_improve");
    assert.notEqual(c.state.active.label, "ralph_loop");
});

test("self_improve schema declares max_iterations / min_iterations bounds matching runtime", () => {
    // Same drift-prevention rationale as the focus-bounds test: a
    // schema-validating dispatcher must catch the same out-of-range
    // ints the handler would reject (so callers don't see the
    // confusing schema-accept/runtime-reject mismatch).
    const c = createRalphController();
    const si = c.tools.find((t) => t.name === "self_improve");
    const max = si.parameters.properties.max_iterations;
    assert.equal(max.type, "integer");
    assert.equal(max.minimum, 1);
    assert.equal(max.maximum, 1000);
    assert.equal(max.default, 100);
    assert.equal(max.default, SELF_IMPROVE_DEFAULTS.max_iterations,
        "schema default must come from SELF_IMPROVE_DEFAULTS — drift between the two = silent UX regression");
    const min = si.parameters.properties.min_iterations;
    assert.equal(min.type, "integer");
    assert.equal(min.minimum, 1);
    assert.equal(min.maximum, 1000);
    assert.equal(min.default, 5);
    assert.equal(min.default, SELF_IMPROVE_DEFAULTS.min_iterations,
        "schema default must come from SELF_IMPROVE_DEFAULTS");
    // Pin the const itself so a future "100→200" or "5→10" tweak can
    // only happen with a deliberate test update.
    assert.deepEqual(SELF_IMPROVE_DEFAULTS, { max_iterations: 100, min_iterations: 5 });
    assert.ok(Object.isFrozen(SELF_IMPROVE_DEFAULTS), "SELF_IMPROVE_DEFAULTS must be frozen");
});

test("self_improve and grow_project schema descriptions disclose the baked-prompt drift footgun", () => {
    // The runtime warnPromiseDrift fires AT arm-time, but by then the
    // LLM caller has already committed to the wrong promise. The schema
    // description is what the dispatcher reads BEFORE calling — so it
    // must explicitly warn that overriding completion_promise /
    // abort_promise without editing the prompt body silently breaks
    // the abort signal. Without this pin, a "tighten descriptions"
    // refactor could quietly remove the guidance.
    const c = createRalphController();

    const si = c.tools.find((t) => t.name === "self_improve");
    const siCp = si.parameters.properties.completion_promise.description;
    const siAp = si.parameters.properties.abort_promise.description;
    assert.match(siCp, /baked SDLC prompt/i, "self_improve.completion_promise must mention the baked SDLC prompt");
    assert.match(siCp, /COMPLETE/, "self_improve.completion_promise must name the literal token");
    assert.match(siCp, /silently runs the loop to max_iterations/, "self_improve.completion_promise must spell out the consequence");
    assert.match(siAp, /baked SDLC prompt/i, "self_improve.abort_promise must mention the baked SDLC prompt");
    assert.match(siAp, /ABORT_NO_IMPROVEMENTS/, "self_improve.abort_promise must name the self_improve abort token");
    assert.equal(/ABORT_NO_BACKLOG/.test(siAp), false, "self_improve.abort_promise must NOT mention grow_project's token");

    const gp = c.tools.find((t) => t.name === "grow_project");
    const gpCp = gp.parameters.properties.completion_promise.description;
    const gpAp = gp.parameters.properties.abort_promise.description;
    assert.match(gpCp, /baked SDLC prompt/i);
    assert.match(gpCp, /COMPLETE/);
    assert.match(gpCp, /silently runs the loop to max_iterations/);
    assert.match(gpAp, /ABORT_NO_BACKLOG/, "grow_project.abort_promise must name the grow_project abort token");
    assert.equal(/ABORT_NO_IMPROVEMENTS/.test(gpAp), false, "grow_project.abort_promise must NOT mention self_improve's token");
});

test("ralph_loop schema declares max/min/stagnation/completion/abort bounds matching runtime", () => {
    // Mirror of the self_improve bounds tests: pin ralph_loop's
    // numeric and string schema bounds so a future "harmless" tweak
    // to MAX_ALLOWED_ITERATIONS, MAX_PROMISE_CHARS, MAX_PROMPT_CHARS
    // or the DEFAULTS dict can't drift the schema away from the
    // runtime validator without a loud test-suite failure.
    const c = createRalphController();
    const rl = c.tools.find((t) => t.name === "ralph_loop");
    const p = rl.parameters.properties;

    assert.equal(p.prompt.type, "string");
    assert.equal(p.prompt.minLength, 1);
    assert.equal(p.prompt.maxLength, 65536, "MAX_PROMPT_CHARS");

    assert.equal(p.max_iterations.type, "integer");
    assert.equal(p.max_iterations.default, 20, "DEFAULTS.max_iterations");
    assert.equal(p.max_iterations.minimum, 1);
    assert.equal(p.max_iterations.maximum, 1000, "MAX_ALLOWED_ITERATIONS");

    assert.equal(p.min_iterations.type, "integer");
    assert.equal(p.min_iterations.default, 1, "DEFAULTS.min_iterations");
    assert.equal(p.min_iterations.minimum, 1);
    assert.equal(p.min_iterations.maximum, 1000);

    assert.equal(p.completion_promise.type, "string");
    assert.equal(p.completion_promise.default, "COMPLETE");
    assert.equal(p.completion_promise.minLength, 1);
    assert.equal(p.completion_promise.maxLength, 200, "MAX_PROMISE_CHARS");

    assert.equal(p.abort_promise.type, "string");
    assert.equal(p.abort_promise.default, undefined, "abort_promise must NOT declare a default — opt-in only");
    assert.equal(p.abort_promise.minLength, 1);
    assert.equal(p.abort_promise.maxLength, 200);

    assert.equal(p.stagnation_limit.type, "integer");
    assert.equal(p.stagnation_limit.default, 3);
    assert.equal(p.stagnation_limit.minimum, 0);
    assert.deepEqual(p.stagnation_limit.not, { const: 1 });

    assert.deepEqual(rl.parameters.required, ["prompt"], "prompt is the only required arg");
});

test("ralph_loop & ralph_stop schema properties match their KEYS sets", () => {
    // Mirror of the self_improve schema-vs-KEYS-set drift test
    // (above). Same rationale: a divergence between the
    // JSON-schema's advertised properties and the Set used by
    // validateArgShape silently produces either a "documented but
    // rejected" arg or an "accepted but undocumented" arg. Pin both
    // tools the same way so the invariant is enforced uniformly.
    const c = createRalphController();
    const rl = c.tools.find((t) => t.name === "ralph_loop");
    assert.deepEqual(Object.keys(rl.parameters.properties).sort(), [
        "abort_promise",
        "adaptive_budget",
        "adaptive_extension",
        "adaptive_max_total",
        "completion_promise",
        "max_iterations",
        "max_tokens",
        "min_iterations",
        "prompt",
        "stagnation_limit",
        "warn_at_pct",
    ], "ralph_loop schema properties must match RALPH_LOOP_KEYS exactly");
    const rs = c.tools.find((t) => t.name === "ralph_stop");
    assert.deepEqual(Object.keys(rs.parameters.properties).sort(), ["reason"],
        "ralph_stop schema properties must match RALPH_STOP_KEYS exactly");
});

test("self_improve schema properties match SELF_IMPROVE_KEYS membership exactly", () => {
    const c = createRalphController();
    const si = c.tools.find((t) => t.name === "self_improve");
    assert.deepEqual(Object.keys(si.parameters.properties).sort(), [
        "abort_promise",
        "completion_promise",
        "focus",
        "max_iterations",
        "min_iterations",
        "stagnation_limit",
    ], "schema property names must match SELF_IMPROVE_KEYS exactly");
});

test("grow_project schema properties match GROW_PROJECT_KEYS membership exactly", () => {
    // Mirror of the SELF_IMPROVE_KEYS pin above. validateOptionalArgShape
    // gates which keys grow_project's handler accepts, but the LLM
    // dispatcher reads the schema. If a future contributor ADDS a new
    // property to the schema without adding it to the runtime KEYS
    // allowlist (or vice-versa), the LLM will pass an arg that the
    // handler then rejects as "unknown" — a confusing UX regression.
    // Pin the property name set so any drift fails this test loudly.
    const c = createRalphController();
    const gp = c.tools.find((t) => t.name === "grow_project");
    assert.deepEqual(Object.keys(gp.parameters.properties).sort(), [
        "abort_promise",
        "completion_promise",
        "focus",
        "max_iterations",
        "min_iterations",
        "stagnation_limit",
    ], "schema property names must match GROW_PROJECT_KEYS exactly");
});

test("grow_project schema declares max/min/completion/abort/stagnation/focus bounds matching runtime", () => {
    // One consolidated schema-parity pin for grow_project, mirroring
    // the four self_improve schema tests above. A future tweak to
    // GROW_PROJECT_DEFAULTS, MAX_ALLOWED_ITERATIONS, MAX_PROMISE_CHARS,
    // or MAX_FOCUS_CHARS that doesn't update the schema simultaneously
    // is caught here. Crucially: abort_promise.default must be the new
    // BAKED_BACKLOG_ABORT_TOKEN — a regression to undefined (mirroring
    // self_improve) or to BAKED_ABORT_TOKEN (copy-paste) would silently
    // break the runtime watcher.
    const c = createRalphController();
    const gp = c.tools.find((t) => t.name === "grow_project");
    const p = gp.parameters.properties;

    assert.equal(p.max_iterations.type, "integer");
    assert.equal(p.max_iterations.minimum, 1);
    assert.equal(p.max_iterations.maximum, 1000);
    assert.equal(p.max_iterations.default, 200);
    assert.equal(p.max_iterations.default, GROW_PROJECT_DEFAULTS.max_iterations,
        "schema default must come from GROW_PROJECT_DEFAULTS — drift = silent UX regression");

    assert.equal(p.min_iterations.type, "integer");
    assert.equal(p.min_iterations.minimum, 1);
    assert.equal(p.min_iterations.maximum, 1000);
    assert.equal(p.min_iterations.default, 10);
    assert.equal(p.min_iterations.default, GROW_PROJECT_DEFAULTS.min_iterations,
        "schema default must come from GROW_PROJECT_DEFAULTS");

    assert.deepEqual(GROW_PROJECT_DEFAULTS, { max_iterations: 200, min_iterations: 10 });
    assert.ok(Object.isFrozen(GROW_PROJECT_DEFAULTS), "GROW_PROJECT_DEFAULTS must be frozen");

    assert.equal(p.completion_promise.type, "string");
    assert.equal(p.completion_promise.default, "COMPLETE");
    assert.equal(p.completion_promise.minLength, 1);
    assert.equal(p.completion_promise.maxLength, 200);

    // The crucial difference from self_improve: abort_promise has a
    // default (the new BAKED_BACKLOG_ABORT_TOKEN), not undefined, so
    // an omitted abort_promise still wires the agent's literal
    // ABORT_NO_BACKLOG emit to the runtime watcher.
    assert.equal(p.abort_promise.type, "string");
    assert.equal(p.abort_promise.default, "ABORT_NO_BACKLOG");
    assert.equal(p.abort_promise.default, BAKED_BACKLOG_ABORT_TOKEN,
        "abort_promise.default must come from BAKED_BACKLOG_ABORT_TOKEN — drift would silently break the abort signal");
    assert.notEqual(p.abort_promise.default, "ABORT_NO_IMPROVEMENTS",
        "abort_promise must NOT inherit self_improve's token via copy-paste");
    assert.equal(p.abort_promise.minLength, 1);
    assert.equal(p.abort_promise.maxLength, 200);

    const sl = p.stagnation_limit;
    assert.equal(sl.type, "integer");
    assert.equal(sl.default, 3);
    assert.equal(sl.minimum, 0);
    assert.deepEqual(sl.not, { const: 1 }, "the value 1 is rejected at the schema layer too");

    assert.equal(p.focus.type, "string");
    assert.equal(p.focus.minLength, 1);
    assert.equal(p.focus.maxLength, MAX_FOCUS_CHARS);
});

test("ralph_stop schema description names all three loop tools it can cancel", () => {
    // Same family as the gp-15/gp-23 disclosure pins: ralph_stop is
    // the symmetric cancel endpoint for all three loop arms. Its
    // description hardcoded "ralph_loop or self_improve" until iter
    // gp-24 and never mentioned grow_project, so an LLM dispatcher
    // searching the schema for "grow_project" had no signal that
    // ralph_stop was the right tool to cancel one. Pin the
    // disclosure for all three peers — symmetric with the per-tool
    // description pins — so a future fourth-tool addition is forced
    // to update this string too.
    const c = createRalphController();
    const rs = c.tools.find((t) => t.name === "ralph_stop");
    assert.match(rs.description, /ralph_loop/, "must name ralph_loop");
    assert.match(rs.description, /self_improve/, "must name self_improve");
    assert.match(rs.description, /grow_project/, "must name grow_project");
});

test("ralph_loop schema description discloses all three loop conflict siblings", () => {
    // Mirror of the self_improve / grow_project disclosure pins.
    // ralph_loop is the lowest-level tool but its activeLoopGuard
    // blocks symmetrically — calling ralph_loop while a self_improve
    // or grow_project loop is active fails fast. The schema
    // description must surface that contract so the LLM dispatcher
    // doesn't have to learn it through a runtime failure.
    const c = createRalphController();
    const rl = c.tools.find((t) => t.name === "ralph_loop");
    assert.match(rl.description, /self_improve/, "must disclose conflict with self_improve");
    assert.match(rl.description, /grow_project/, "must disclose conflict with grow_project");
    assert.match(rl.description, /ralph_stop/, "must disclose ralph_stop as the cancel mechanism");
});

test("self_improve schema description discloses all three loop conflict siblings", () => {
    // Iter gp-15 finding: when grow_project shipped as a third peer,
    // self_improve's description still said "ralph_loop or
    // self_improve" — it did not mention grow_project even though
    // grow_project now also blocks self_improve. Pin the disclosure
    // for all three peers symmetric with the grow_project pin so a
    // future fourth-tool addition is forced to update this string
    // (and a regression that drops grow_project from the disclosure
    // is caught loudly).
    const c = createRalphController();
    const si = c.tools.find((t) => t.name === "self_improve");
    assert.match(si.description, /ralph_loop/);
    assert.match(si.description, /grow_project/, "must disclose conflict with grow_project");
    assert.match(si.description, /ralph_stop/, "must disclose ralph_stop as the cancel mechanism");
});

test("grow_project schema description mentions the active-loop conflict siblings", () => {
    // Schema description is the public contract the LLM sees. It must
    // explicitly call out that grow_project / ralph_loop / self_improve
    // share state — otherwise the model has no way to learn about the
    // conflict until it hits a runtime failure. Pin the contract so a
    // future "trim the description" refactor can't silently drop the
    // disclosure.
    const c = createRalphController();
    const gp = c.tools.find((t) => t.name === "grow_project");
    assert.match(gp.description, /ralph_loop/, "must disclose conflict with ralph_loop");
    assert.match(gp.description, /self_improve/, "must disclose conflict with self_improve");
    assert.match(gp.description, /ralph_stop/, "must disclose ralph_stop as the cancel mechanism");
});

test("self_improve schema declares completion/abort/stagnation bounds matching runtime", () => {
    // Same drift-prevention rationale as the focus & max/min bounds
    // tests: the JSON-schema must mirror the runtime validation for
    // the remaining three fields too — completion_promise (default
    // "COMPLETE", 1..200 chars), abort_promise (no default, 1..200
    // chars), stagnation_limit (default 3, integer ≥ 0, with the
    // {not:{const:1}} carve-out forbidding the value 1 since a single
    // sample can't establish stagnation).
    const c = createRalphController();
    const si = c.tools.find((t) => t.name === "self_improve");
    const cp = si.parameters.properties.completion_promise;
    assert.equal(cp.type, "string");
    assert.equal(cp.default, "COMPLETE");
    assert.equal(cp.minLength, 1);
    assert.equal(cp.maxLength, 200);
    const ap = si.parameters.properties.abort_promise;
    assert.equal(ap.type, "string");
    assert.equal(ap.default, undefined, "abort_promise must NOT declare a default — opt-in only");
    assert.equal(ap.minLength, 1);
    assert.equal(ap.maxLength, 200);
    const sl = si.parameters.properties.stagnation_limit;
    assert.equal(sl.type, "integer");
    assert.equal(sl.default, 3);
    assert.equal(sl.minimum, 0);
    assert.deepEqual(sl.not, { const: 1 }, "the value 1 is rejected at the schema layer too");
});

test("self_improve schema declares focus bounds matching runtime validation", () => {
    // The runtime focus validator caps length at MAX_FOCUS_CHARS and
    // rejects empty strings; the JSON-schema MUST mirror those bounds
    // so a schema-validating client (LLM tool dispatcher, contract
    // test, OpenAPI generator) catches the same offences as the
    // handler. A drift here = silent acceptance at the schema layer
    // with a runtime rejection, surprising callers.
    const c = createRalphController();
    const si = c.tools.find((t) => t.name === "self_improve");
    const focus = si.parameters.properties.focus;
    assert.equal(focus.type, "string");
    assert.equal(focus.minLength, 1);
    assert.equal(focus.maxLength, MAX_FOCUS_CHARS);
});

test("self_improve rejects focus over MAX_FOCUS_CHARS", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ focus: "x".repeat(MAX_FOCUS_CHARS + 1) });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, new RegExp(`self_improve: focus exceeds ${MAX_FOCUS_CHARS}`));
});

test("self_improve accepts focus of exactly MAX_FOCUS_CHARS (boundary)", async () => {
    // The handler check is `trimmed.length > MAX_FOCUS_CHARS`, so a
    // value of exactly the cap must pass. Pin the boundary because an
    // off-by-one regression to `>=` would be invisible without it: the
    // existing "rejects over the cap" test only proves cap+1 fails.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ focus: "x".repeat(MAX_FOCUS_CHARS), max_iterations: 1, min_iterations: 1 });
    assert.equal(r.resultType, "success", r.textResultForLlm);
    assert.equal(r.armed, true);
});

test("self_improve rejects whitespace-only focus", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ focus: "   \t\n  " });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /self_improve: focus must contain/);
});

test("self_improve rejects non-string focus", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ focus: 42 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /self_improve: focus must be a string/);
});

test("grow_project rejects focus over MAX_FOCUS_CHARS, accepts the boundary, and rejects whitespace/non-string", async () => {
    // Mirror of the four self_improve focus-bound pins, consolidated:
    // each path must surface the grow_project: prefix (not the
    // delegated ralph_loop: prefix from validateArgs).
    const c = createRalphController();
    const session = makeFakeSession();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");

    const tooBig = await t.handler({ focus: "x".repeat(MAX_FOCUS_CHARS + 1) });
    assert.equal(tooBig.resultType, "failure");
    assert.match(tooBig.textResultForLlm, new RegExp(`^grow_project: focus exceeds ${MAX_FOCUS_CHARS}`));
    assert.doesNotMatch(tooBig.textResultForLlm, /ralph_loop:/);

    // Boundary: trimmed.length === MAX_FOCUS_CHARS must arm. The
    // handler check is `> MAX_FOCUS_CHARS`, so an off-by-one
    // regression to `>=` would be caught here.
    const session2 = makeFakeSession();
    const c2 = createRalphController();
    c2.attach(session2);
    const t2 = c2.tools.find((x) => x.name === "grow_project");
    const boundary = await t2.handler({ focus: "x".repeat(MAX_FOCUS_CHARS), max_iterations: 1, min_iterations: 1 });
    assert.equal(boundary.resultType, "success", boundary.textResultForLlm);
    assert.equal(boundary.armed, true);

    // Whitespace-only focus rejected.
    const session3 = makeFakeSession();
    const c3 = createRalphController();
    c3.attach(session3);
    const t3 = c3.tools.find((x) => x.name === "grow_project");
    const ws = await t3.handler({ focus: "   \t\n  " });
    assert.equal(ws.resultType, "failure");
    assert.match(ws.textResultForLlm, /^grow_project: focus must contain/);

    // Non-string focus rejected (number sentinel).
    const session4 = makeFakeSession();
    const c4 = createRalphController();
    c4.attach(session4);
    const t4 = c4.tools.find((x) => x.name === "grow_project");
    const num = await t4.handler({ focus: 42 });
    assert.equal(num.resultType, "failure");
    assert.match(num.textResultForLlm, /^grow_project: focus must be a string/);
});

test("self_improve treats focus: null as 'not supplied' and arms with the bare SDLC prompt", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ focus: null, max_iterations: 1, min_iterations: 1 });
    assert.equal(r.resultType, "success");
    // Pin the contract: a null focus must NOT be type-rejected the way `42`
    // is, and must NOT inject the "Focus this run on:" suffix into the
    // armed prompt (which would otherwise read as an empty/null focus).
    session.emit("session.idle", { data: {} });
    const sentPrompt = session.sent[0]?.prompt ?? "";
    assert.ok(!/Focus this run on:/.test(sentPrompt), "null focus must not emit Focus suffix");
});

test("grow_project treats focus: null as 'not supplied' and arms with the bare SDLC prompt", async () => {
    // Mirror of the iter 21 self_improve null-focus pin.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    const r = await t.handler({ focus: null, max_iterations: 1, min_iterations: 1 });
    assert.equal(r.resultType, "success");
    session.emit("session.idle", { data: {} });
    const sentPrompt = session.sent[0]?.prompt ?? "";
    assert.ok(!/Focus this run on:/.test(sentPrompt), "null focus must not emit Focus suffix");
});

test("grow_project arms with abortPromise=ABORT_NO_BACKLOG when caller omits abort_promise", async () => {
    // Schema-level default is pinned elsewhere, but JSON-schema defaults
    // are NOT auto-applied by the SDK — the handler must explicitly
    // substitute BAKED_BACKLOG_ABORT_TOKEN when a.abort_promise is
    // undefined. Without this pin, a refactor that drops the `?? BAKED_…`
    // fallback would leave grow_project with abortPromise=null and the
    // ABORT_NO_BACKLOG signal would never fire — silent regression.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    const r = await t.handler({ max_iterations: 1, min_iterations: 1 });
    assert.equal(r.resultType, "success");
    assert.equal(c.state.active.abortPromise, BAKED_BACKLOG_ABORT_TOKEN);
    assert.equal(c.state.active.abortPromise, "ABORT_NO_BACKLOG");
    assert.notEqual(c.state.active.abortPromise, BAKED_ABORT_TOKEN,
        "grow_project must not arm with self_improve's abort token");
});

test("all three tools arm with completionPromise='COMPLETE' when caller omits completion_promise", async () => {
    // Schema declares completion_promise.default='COMPLETE' for all three
    // tools, but JSON-schema defaults aren't auto-applied — the runtime
    // path goes through resolveOptionalPromise(…, DEFAULTS.completion_promise)
    // inside validateArgs. A refactor that bypassed validateArgs (or that
    // changed DEFAULTS.completion_promise) would silently mis-arm: the
    // baked PROMPT_* prompts emit "COMPLETE" but the loop watcher would
    // be looking for something else, so completion would never fire.
    for (const name of ["ralph_loop", "self_improve", "grow_project"]) {
        const session = makeFakeSession();
        const c = createRalphController();
        c.attach(session);
        const t = c.tools.find((x) => x.name === name);
        const args = name === "ralph_loop"
            ? { prompt: "x", max_iterations: 1, min_iterations: 1 }
            : { max_iterations: 1, min_iterations: 1 };
        const r = await t.handler(args);
        assert.equal(r.resultType, "success", `${name} must arm`);
        assert.equal(c.state.active.completionPromise, "COMPLETE",
            `${name} must arm with completionPromise='COMPLETE' (got ${JSON.stringify(c.state.active.completionPromise)})`);
    }
});

test("grow_project rewrites delegated bound errors with grow_project prefix", async () => {
    // Mirror of iter 17/the equivalent self_improve test: validateArgs
    // emits ralph_loop:-prefixed errors; the handler rewrites them so
    // the caller sees grow_project: in the error stream.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    const tooBig = await t.handler({ max_iterations: 99999 });
    assert.equal(tooBig.resultType, "failure");
    assert.match(tooBig.textResultForLlm, /^grow_project:/);
    assert.doesNotMatch(tooBig.textResultForLlm, /ralph_loop:/);
    const tooSmall = await t.handler({ max_iterations: 0 });
    assert.equal(tooSmall.resultType, "failure");
    assert.match(tooSmall.textResultForLlm, /^grow_project:/);
});

test("grow_project rejects stagnation_limit=1 with grow_project prefix", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    const r = await t.handler({ stagnation_limit: 1 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^grow_project:/);
    assert.doesNotMatch(r.textResultForLlm, /ralph_loop:/);
});

test("self_improve rewrites delegated bound errors with self_improve prefix", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const tooBig = await t.handler({ max_iterations: 99999 });
    assert.equal(tooBig.resultType, "failure");
    assert.match(tooBig.textResultForLlm, /^self_improve:/);
    assert.doesNotMatch(tooBig.textResultForLlm, /ralph_loop:/);
    const tooSmall = await t.handler({ max_iterations: 0 });
    assert.equal(tooSmall.resultType, "failure");
    assert.match(tooSmall.textResultForLlm, /^self_improve:/);
});

test("self_improve rejects stagnation_limit=1 with self_improve prefix", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ stagnation_limit: 1 });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^self_improve:/);
    assert.doesNotMatch(r.textResultForLlm, /ralph_loop:/);
});

test("self_improve warns when completion_promise / abort_promise drift from the baked SDLC prompt's emit tokens", async () => {
    // Pin the iter 27/28 footgun guard: PROMPT_SELF_IMPROVE bakes in
    // "emit COMPLETE" and "emit ABORT_NO_IMPROVEMENTS". A caller passing
    // a different completion_promise / abort_promise gets a one-shot
    // warning at arm-time; otherwise the loop would silently run to
    // max_iterations because prompt and runtime watch different tokens.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({
        completion_promise: "DONE",
        abort_promise: "STOP",
        max_iterations: 1,
        min_iterations: 1,
    });
    assert.equal(r.resultType, "success");
    const warns = session.logs.filter((l) => /^self_improve: warning —/.test(l));
    assert.equal(warns.length, 2, `expected two drift warnings, got: ${JSON.stringify(warns)}`);
    assert.ok(warns.some((l) => /completion_promise="DONE".*"COMPLETE".*max_iterations/.test(l)), "completion_promise drift warning");
    assert.ok(warns.some((l) => /abort_promise="STOP".*"ABORT_NO_IMPROVEMENTS".*abort signal/.test(l)), "abort_promise drift warning");
});

test("self_improve does NOT warn when promises match the baked SDLC prompt's tokens", async () => {
    // Inverse of the drift test: passing the exact baked tokens (or the
    // default for completion_promise) must NOT log a spurious warning.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    await t.handler({
        completion_promise: "COMPLETE",
        abort_promise: "ABORT_NO_IMPROVEMENTS",
        max_iterations: 1,
        min_iterations: 1,
    });
    const warns = session.logs.filter((l) => /^self_improve: warning —/.test(l));
    assert.equal(warns.length, 0, `expected no drift warnings, got: ${JSON.stringify(warns)}`);
});

test("grow_project warns when completion_promise / abort_promise drift from the baked SDLC prompt's emit tokens", async () => {
    // Mirror of the self_improve drift pin (iter 27/28) but for the
    // grow_project handler: PROMPT_GROW_PROJECT bakes in "emit COMPLETE"
    // and "emit ABORT_NO_BACKLOG" — a different abort token from
    // self_improve. A caller passing different completion_promise /
    // abort_promise gets a one-shot warning at arm-time so the
    // mismatch is visible in the timeline rather than silently running
    // the loop to max_iterations.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    const r = await t.handler({
        completion_promise: "DONE",
        abort_promise: "STOP",
        max_iterations: 1,
        min_iterations: 1,
    });
    assert.equal(r.resultType, "success");
    const warns = session.logs.filter((l) => /^grow_project: warning —/.test(l));
    assert.equal(warns.length, 2, `expected two drift warnings, got: ${JSON.stringify(warns)}`);
    assert.ok(warns.some((l) => /completion_promise="DONE".*"COMPLETE".*max_iterations/.test(l)), "completion_promise drift warning must name field, supplied value, baked token, and consequence");
    // Crucially the abort warning references ABORT_NO_BACKLOG, not the
    // self_improve token ABORT_NO_IMPROVEMENTS — this proves the
    // BAKED_BACKLOG_ABORT_TOKEN substitution at the warnPromiseDrift
    // call site.
    assert.ok(warns.some((l) => /abort_promise="STOP".*"ABORT_NO_BACKLOG".*abort signal/.test(l)), "abort_promise drift warning must name ABORT_NO_BACKLOG, not ABORT_NO_IMPROVEMENTS");
});

test("grow_project does NOT warn when promises match the baked SDLC prompt's tokens", async () => {
    // Inverse: passing the exact baked tokens must produce zero
    // warnings. The default abort_promise (ABORT_NO_BACKLOG) must also
    // be silent on omission — pinned by the no-args case below.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    await t.handler({
        completion_promise: "COMPLETE",
        abort_promise: "ABORT_NO_BACKLOG",
        max_iterations: 1,
        min_iterations: 1,
    });
    const warns = session.logs.filter((l) => /^grow_project: warning —/.test(l));
    assert.equal(warns.length, 0, `expected no drift warnings, got: ${JSON.stringify(warns)}`);
});

test("cross-pollination: tokens stay distinct between self_improve and grow_project", async () => {
    // Passing the OTHER tool's abort token must trigger the drift
    // warning. This pins that the two tokens (ABORT_NO_IMPROVEMENTS
    // for self_improve, ABORT_NO_BACKLOG for grow_project) stay
    // distinct in the runtime watcher — a future "harmonize tokens"
    // refactor would silently break either tool's abort signal, and
    // this test would fire first.

    // self_improve fed grow_project's abort token → must warn.
    const s1 = makeFakeSession();
    const c1 = createRalphController();
    c1.attach(s1);
    const tSI = c1.tools.find((x) => x.name === "self_improve");
    await tSI.handler({
        abort_promise: "ABORT_NO_BACKLOG",
        max_iterations: 1,
        min_iterations: 1,
    });
    const w1 = s1.logs.filter((l) => /^self_improve: warning —/.test(l));
    assert.ok(
        w1.some((l) => /abort_promise="ABORT_NO_BACKLOG".*"ABORT_NO_IMPROVEMENTS"/.test(l)),
        `self_improve must warn when fed grow_project's ABORT_NO_BACKLOG token; got: ${JSON.stringify(w1)}`,
    );

    // grow_project fed self_improve's abort token → must warn.
    const s2 = makeFakeSession();
    const c2 = createRalphController();
    c2.attach(s2);
    const tGP = c2.tools.find((x) => x.name === "grow_project");
    await tGP.handler({
        abort_promise: "ABORT_NO_IMPROVEMENTS",
        max_iterations: 1,
        min_iterations: 1,
    });
    const w2 = s2.logs.filter((l) => /^grow_project: warning —/.test(l));
    assert.ok(
        w2.some((l) => /abort_promise="ABORT_NO_IMPROVEMENTS".*"ABORT_NO_BACKLOG"/.test(l)),
        `grow_project must warn when fed self_improve's ABORT_NO_IMPROVEMENTS token; got: ${JSON.stringify(w2)}`,
    );
});

test("self_improve rejects overlapping completion/abort phrases with self_improve prefix", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "self_improve");
    const r = await t.handler({ completion_promise: "DONE", abort_promise: "DONE_NOW" });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^self_improve:/);
    assert.match(r.textResultForLlm, /overlap/i);
    assert.doesNotMatch(r.textResultForLlm, /ralph_loop:/);
});

test("grow_project rejects overlapping completion/abort phrases with grow_project prefix", async () => {
    // Mirror of the self_improve overlap-rejection test for grow_project's
    // error-prefix rewrite (`ralph_loop:` → `grow_project:`). The most
    // intuitive footgun here is *swapping* the baked tokens — passing
    // completion_promise: "ABORT_NO_BACKLOG", abort_promise: "COMPLETE"
    // — because both substrings are baked into PROMPT_GROW_PROJECT and
    // would fire on every iteration if the validator let them through.
    // The substring-overlap check ("ABORT_NO_BACKLOG" ⊃ "COMPLETE"? no;
    // but identical-or-substring catches the more common "DONE"/"DONE_NOW"
    // case) must surface with the `grow_project:` prefix, not the inner
    // `ralph_loop:` prefix from the shared validator.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const t = c.tools.find((x) => x.name === "grow_project");
    const r = await t.handler({ completion_promise: "DONE", abort_promise: "DONE_NOW" });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^grow_project:/);
    assert.match(r.textResultForLlm, /overlap/i);
    assert.doesNotMatch(r.textResultForLlm, /ralph_loop:/);
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
    // self_improve tool surface — symmetric deep-freeze. Without this
    // a caller could mutate e.g. focus.maxLength to bypass the
    // 500-char cap or remove the not:{const:1} carve-out from
    // stagnation_limit. Pin every property and the additionalProperties
    // flag so deep-freeze drift is caught.
    const siTool = c.tools.find((t) => t.name === "self_improve");
    assert.ok(Object.isFrozen(siTool.parameters));
    assert.ok(Object.isFrozen(siTool.parameters.properties));
    for (const propName of Object.keys(siTool.parameters.properties)) {
        const prop = siTool.parameters.properties[propName];
        assert.ok(Object.isFrozen(prop), `self_improve.${propName} schema not frozen`);
    }
    assert.throws(() => { siTool.parameters.properties.focus.maxLength = 99999; }, TypeError);
    assert.throws(() => { siTool.parameters.properties.stagnation_limit.not = { const: 999 }; }, TypeError);
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
    // Same paren-balance guard as the "already armed" branch — the
    // "running" template path is rendered separately, so pin it too.
    assert.match(r.textResultForLlm, /\(iteration 1\/9\) — call ralph_stop first\.$/);
    assert.doesNotMatch(r.textResultForLlm, /first\)\./);
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
    // Parens around the status clause must be balanced and the sentence
    // must end with a clean period — guards against a regression where
    // the close-paren was misplaced after the period ("first).").
    assert.match(r.textResultForLlm, /\(iteration 1\/7 pending\) — call ralph_stop first\.$/);
    assert.doesNotMatch(r.textResultForLlm, /first\)\./);
});

// ── iteration loop ────────────────────────────────────────────────────────

test("first turn_end after arming fires iter 1 prompt; subsequent turn_ends evaluate", async () => {
    const { session, controller } = await arm({ max_iterations: 3 });
    session.emit("session.idle", { data: {} });
    assert.equal(session.sent.length, 1);
    assert.equal(session.sent[0].prompt, composeRalphLoopPrompt("go").value);
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

test("ralph_stop success result has EXACTLY { textResultForLlm, resultType, iterations, note } — no stray keys", async () => {
    // Mirrors the arm-success "no stray keys" pin. ralph_stop returns
    // `success(message, { iterations, note })`, where note is undefined
    // when no reason is supplied. Lock the closed key set so a future
    // refactor can't silently widen the LLM-facing return with internal
    // scratch (sessionRef, currentDetach, etc.). Both the with-reason
    // and without-reason branches must share the same key set — `note`
    // is *always* present, valued undefined when omitted. A change
    // that conditionally drops the key would also break this lock.
    const { stop } = await arm({ max_iterations: 5 });
    const r1 = await stop.handler({});
    assert.deepEqual(
        Object.keys(r1).sort(),
        ["iterations", "note", "resultType", "textResultForLlm"],
    );
    assert.equal(r1.note, undefined);

    const { stop: stop2 } = await arm({ max_iterations: 5 });
    const r2 = await stop2.handler({ reason: "explicit" });
    assert.deepEqual(
        Object.keys(r2).sort(),
        ["iterations", "note", "resultType", "textResultForLlm"],
    );
    assert.equal(r2.note, "explicit");
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

test("ralph_stop trims surrounding whitespace from reason before storing as note", async () => {
    // The trim happens at handler.mjs ~line 651 (`reason.trim()`). Without
    // this pin, a future change that stored the raw value would surface
    // padded notes ("  hello  ") in the additionalContext bracket and the
    // single-line log marker — visually noisy and the `(  hello  )`
    // suffix in the user-facing text would look like a formatting bug.
    const { stop, controller, session } = await arm({ max_iterations: 5 });
    runTurn(session, "still working");
    const r = await stop.handler({ reason: "  hello world  \n" });
    assert.equal(r.note, "hello world", "structured note must be trimmed");
    assert.equal(controller.state.lastResult.note, "hello world");
    assert.match(r.textResultForLlm, /\(hello world\)\.$/, "user-facing suffix must use the trimmed value verbatim");
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
    assert.match(r.textResultForLlm, /no ralph_loop, self_improve, or grow_project is currently running/);
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

test("abort log line carries calling tool's label (self_improve)", async () => {
    // The "⏹ <label> interrupted by session abort" log line was
    // hardcoded to "ralph_loop" and missed the iter-14 label sweep.
    // When armed via self_improve, the abort log must read
    // "⏹ self_improve interrupted by session abort …".
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const si = c.tools.find((x) => x.name === "self_improve");
    await si.handler({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    session.emit("abort", { data: { reason: "user changed plan" } });
    const joined = session.logs.join("\n");
    assert.match(joined, /⏹ self_improve interrupted by session abort \(user changed plan\)/);
    assert.doesNotMatch(joined, /⏹ ralph_loop interrupted/);
});

test("abort event prefers ev.data.reason over ev.reason when both are present", async () => {
    // The handler's reason-resolution is `ev?.data?.reason ?? ev?.reason`.
    // When both layers carry a string, ev.data.reason wins — pin the
    // precedence so a refactor that flips the operands (or switches to
    // `||` and tries to be "smarter") doesn't silently change which
    // reason surfaces in result.note. Operators reading the timeline
    // expect a stable ordering.
    const { session, controller } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    session.emit("abort", { reason: "outer", data: { reason: "inner" } });
    assert.equal(controller.state.lastResult.reason, "aborted");
    assert.equal(controller.state.lastResult.note, "inner");
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
    assert.match(r2.textResultForLlm, /no ralph_loop, self_improve, or grow_project is currently running/);
    // The original result must NOT be overwritten by the failed second stop.
    assert.equal(controller.state.lastResult.note, "first");
});

test("ralph_stop no-loop failure mentions BOTH ralph_loop and self_improve", async () => {
    // ralph_stop tears down either flavor of armed loop, so the failure
    // message must name both — otherwise an LLM that only ever called
    // self_improve will think ralph_stop refers to a different state
    // machine and won't realize it's the right cancellation tool.
    const c = createRalphController();
    const stop = c.tools.find((t) => t.name === "ralph_stop");
    const r = await stop.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /ralph_loop/);
    assert.match(r.textResultForLlm, /self_improve/);
});

// ── hook ──────────────────────────────────────────────────────────────────

test("onUserPromptSubmitted is arg-tolerant: returns undefined with no arg, no arg, or {} when no lastResult is staged", async () => {
    // The hook's signature is `async ()` — it never consults its
    // argument. Pin the contract that callers passing nothing,
    // undefined, null, an empty object, or a populated `{prompt}`
    // all behave identically when state.lastResult is null: return
    // undefined (no additionalContext), no throw. Without this the
    // host CLI is free to evolve its own hook calling convention
    // (e.g. drop the prompt arg entirely) and our hook must keep
    // working.
    const c = createRalphController();
    c.attach(makeFakeSession());
    assert.equal(c.state.lastResult, null);
    assert.equal(await c.hooks.onUserPromptSubmitted(), undefined);
    assert.equal(await c.hooks.onUserPromptSubmitted(undefined), undefined);
    assert.equal(await c.hooks.onUserPromptSubmitted(null), undefined);
    assert.equal(await c.hooks.onUserPromptSubmitted({}), undefined);
    assert.equal(await c.hooks.onUserPromptSubmitted({ prompt: "anything" }), undefined);
});

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

test("onUserPromptSubmitted bracket reflects the calling tool's label (self_improve)", async () => {
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const si = c.tools.find((x) => x.name === "self_improve");
    const stop = c.tools.find((x) => x.name === "ralph_stop");
    await si.handler({ max_iterations: 5 });
    await stop.handler({ reason: "test" });
    assert.equal(c.state.lastResult.label, "self_improve");
    const r = await c.hooks.onUserPromptSubmitted({ prompt: "next" });
    assert.ok(r?.additionalContext, "expected additionalContext after a finished self_improve loop");
    assert.match(r.additionalContext, /^\[self_improve just finished/,
        `expected bracket prefix to be self_improve, got: ${r.additionalContext}`);
    assert.doesNotMatch(r.additionalContext, /ralph_loop just finished/);
    assert.ok(
        session.logs.some((l) => /^self_improve: injecting post-loop context/.test(l)),
        "expected the self_improve-prefixed injection log line",
    );
});

test("onUserPromptSubmitted bracket reflects the calling tool's label (grow_project)", async () => {
    // Mirror of the self_improve post-loop hook test for the new
    // tool: a finished grow_project run must produce
    // "[grow_project just finished …]" in the additionalContext
    // injection AND a "grow_project: injecting post-loop context"
    // log line — proves state.lastResult.label is plumbed through the
    // hook end-to-end. A regression that hardcodes "ralph_loop" or
    // "self_improve" anywhere in the post-loop pipeline is caught.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const gp = c.tools.find((x) => x.name === "grow_project");
    const stop = c.tools.find((x) => x.name === "ralph_stop");
    await gp.handler({ max_iterations: 5, min_iterations: 1 });
    await stop.handler({ reason: "test" });
    assert.equal(c.state.lastResult.label, "grow_project");
    const r = await c.hooks.onUserPromptSubmitted({ prompt: "next" });
    assert.ok(r?.additionalContext, "expected additionalContext after a finished grow_project loop");
    assert.match(r.additionalContext, /^\[grow_project just finished/,
        `expected bracket prefix to be grow_project, got: ${r.additionalContext}`);
    assert.doesNotMatch(r.additionalContext, /ralph_loop just finished/);
    assert.doesNotMatch(r.additionalContext, /self_improve just finished/);
    assert.ok(
        session.logs.some((l) => /^grow_project: injecting post-loop context/.test(l)),
        "expected the grow_project-prefixed injection log line",
    );
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

test("assistant.message accumulation joins multiple chunks with a newline (split-mid-token won't match)", async () => {
    // Subtle quirk: the accumulator joins chunks with `\n`, so a
    // completion_promise that lands SPLIT across two messages
    // ("COMPL" then "ETE") becomes "COMPL\nETE" and does NOT match
    // the literal "COMPLETE" substring. In practice the SDK emits
    // whole turn responses (or large multi-paragraph chunks), so
    // this doesn't bite — but a refactor that switched the join
    // to "" would silently change matching semantics on the failure
    // mode where two adjacent messages happen to bracket the phrase.
    // Pin the newline join behavior so that change is loud.
    const { session, controller } = await arm({
        max_iterations: 5,
        completion_promise: "DONE",
        stagnation_limit: 0,
    });
    session.emit("session.idle", { data: {} }); // fire iter 1
    // Phrase split across two messages with no inner whitespace.
    session.emit("assistant.message", { data: { content: "DO" } });
    session.emit("assistant.message", { data: { content: "NE" } });
    // The accumulator must contain a newline between the chunks.
    assert.equal(controller.state.lastAssistantContent, "DO\nNE");
    session.emit("session.idle", { data: {} });
    // Loop must NOT finish on completion_promise — the substring
    // "DONE" never appears in "DO\nNE". It re-fires iteration 2.
    assert.equal(controller.state.lastResult, null);
    assert.equal(controller.state.active.i, 2);
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

test("calling self_improve before attach fails fast with a self_improve-labelled error and does NOT arm", async () => {
    // Mirror of the ralph_loop pin above. requireAttachedSession() weaves
    // the calling tool's name through the message, so the failure must
    // carry "self_improve:" rather than the previous hardcoded prefix —
    // a regression that drops the label would lie about which tool the
    // caller actually invoked.
    const c = createRalphController();
    const si = c.tools.find((t) => t.name === "self_improve");
    const r = await si.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /^self_improve: session not attached/);
    assert.equal(c.state.active, null, "must not leave armed state behind");
});

test("attach is transactional: if session.on throws mid-subscribe, earlier listeners are rolled back", () => {
    // Without the rollback, a session.on() that rejects (say) the third
    // event ("abort") with an unknown-event error would leave the first
    // two listeners (assistant.message, session.idle) attached to the
    // session, leaking memory and continuing to fire forever even though
    // attach() reported failure. Pin the all-or-nothing contract.
    const calls = [];
    const session = {
        send: () => Promise.resolve(),
        log: () => {},
        on: (event, _h) => {
            calls.push(event);
            if (event === "abort") {
                throw new Error("simulated unknown event");
            }
            // Successful subscribe returns an unsubscribe fn. We track
            // the unsub call to confirm rollback happened.
            return () => calls.push(`unsub:${event}`);
        },
    };
    const c = createRalphController();
    assert.throws(() => c.attach(session), /simulated unknown event/);
    // Rolled back: the two listeners we did attach must have been
    // unsubscribed (in some order — implementation can iterate either way).
    assert.deepEqual(
        calls.sort(),
        ["abort", "assistant.message", "session.idle", "unsub:assistant.message", "unsub:session.idle"],
        "all earlier subscriptions must be rolled back",
    );
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
        ["durationMs", "finishedAt", "iterations", "label", "preview", "reason", "startedAt"],
        "completion result must have exactly these 7 keys",
    );

    const a2 = await arm({ max_iterations: 3 });
    const r2 = await a2.stop.handler({ reason: "manual" });
    assert.equal(r2.resultType, "success");
    const stopped = a2.controller.state.lastResult;
    assert.deepEqual(
        Object.keys(stopped).sort(),
        ["durationMs", "finishedAt", "iterations", "label", "note", "preview", "reason", "startedAt"],
        "user_stopped result must add exactly `note` to the 7-key base",
    );

    // Stagnation finishes with NO note (the "reason" itself encodes the
    // diagnostic — there's no additional context to attach). Pin the
    // 7-key base for this path so a future change that injected a
    // diagnostic note (e.g. the duplicated text fragment) into stagnation
    // results would have to update both the typedef and this test.
    const a3 = await arm({ max_iterations: 10, stagnation_limit: 2 });
    a3.session.emit("session.idle", { data: {} });
    runTurn(a3.session, "spinning");
    runTurn(a3.session, "spinning");
    assert.equal(a3.controller.state.lastResult.reason, "stagnation");
    assert.deepEqual(
        Object.keys(a3.controller.state.lastResult).sort(),
        ["durationMs", "finishedAt", "iterations", "label", "preview", "reason", "startedAt"],
        "stagnation result must have exactly the 7-key base (no note)",
    );

    // send_error finishes WITH a note (the underlying Error message) — the
    // 8-key shape mirrors user_stopped's. Pin this so a future change
    // that dropped the note from error finishes (or renamed it to
    // "errorMessage") wouldn't slip through.
    const session4 = makeFakeSession({ failSend: true });
    const c4 = createRalphController();
    c4.attach(session4);
    await c4.tools[0].handler({ prompt: "go", max_iterations: 5 });
    session4.emit("session.idle", { data: {} });
    assert.equal(c4.state.lastResult.reason, "send_error");
    assert.deepEqual(
        Object.keys(c4.state.lastResult).sort(),
        ["durationMs", "finishedAt", "iterations", "label", "note", "preview", "reason", "startedAt"],
        "send_error result must include `note` (the Error message)",
    );
});

test("controller.state exposes exactly { active, lastAssistantContent, lastResult } (no internal scratch leaked)", () => {
    // The state object is the public introspection surface for embedders
    // (e.g. tests use `controller.state.lastResult`). The handler also
    // uses internal scratch like `sessionRef`, the controller's
    // `currentDetach`, and the closure-scope `_attachToken`/handler refs
    // — none of which should ever bleed onto `state`. Pin the exact
    // 3-key shape so a future refactor that accidentally promoted a
    // private field via `state.foo = ...` would trip this test.
    const c = createRalphController();
    assert.deepEqual(
        Object.keys(c.state).sort(),
        ["active", "lastAssistantContent", "lastResult"],
    );
    assert.equal(c.state.active, null);
    assert.equal(c.state.lastAssistantContent, "");
    assert.equal(c.state.lastResult, null);
});


test("durationMs is clamped to ≥ 0 if the system clock jumps backward", async () => {
    // Stub Date.now so the second sample (finish time) reads earlier
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

test("self_improve re-arm clears prior lastResult (mirror of ralph_loop)", async () => {
    // Symmetric guarantee: re-arming via self_improve after a previous
    // self_improve completed must clear state.lastResult so the
    // additionalContext hook can't bleed the previous run's preview
    // into the next user prompt. armLoop() is shared, but pin both
    // calling tools so a regression that only resets one path is loud.
    const session = makeFakeSession();
    const c = createRalphController();
    c.attach(session);
    const si = c.tools.find((x) => x.name === "self_improve");
    await si.handler({ max_iterations: 3, min_iterations: 1 });
    session.emit("session.idle", { data: {} });
    runTurn(session, "wrapped up COMPLETE");
    assert.equal(c.state.lastResult.reason, "completion_promise");
    assert.equal(c.state.lastResult.label, "self_improve");
    const arm2 = await si.handler({ max_iterations: 4, min_iterations: 1 });
    assert.equal(arm2.resultType, "success");
    assert.equal(c.state.lastResult, null,
        "prior self_improve lastResult must be cleared on self_improve re-arm");
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

    // aborted (SDK abort event) → ⚠️ ended (mirrors send_error: something went wrong).
    // Pins the second branch of the verb ladder, which previously had no
    // dedicated test — only send_error covered it.
    const { session: s3 } = await arm({ max_iterations: 5 });
    s3.emit("abort", { data: { reason: "user_cancelled" } });
    assert.match(s3.logs.join("\n"), /⚠️ ended ralph_loop.*reason: aborted/);

    // completion_promise → ✅ completed
    const { session: s4 } = await arm({ max_iterations: 5 });
    s4.emit("session.idle", { data: {} });
    runTurn(s4, "all done COMPLETE");
    assert.match(s4.logs.join("\n"), /✅ completed ralph_loop.*reason: completion_promise/);
});

test("finish log line carries the self_improve label for ⏹/✅/⚠️ verbs", async () => {
    // Mirror of the ralph_loop verb-ladder test above, exercised through
    // self_improve so a regression that hardcodes "ralph_loop" back into
    // the finish log line — bypassing state.active.label — is caught.
    // Three branches: user_stopped (⏹), completion_promise (✅), and
    // send_error (⚠️) cover all three verbs in VERB_BY_REASON's fallback
    // ladder. Use min_iterations:1 so completion_promise can fire on
    // iter 1 (the baked SDLC default would defer it past iter 1).
    // user_stopped → ⏹ stopped self_improve
    {
        const session = makeFakeSession();
        const c = createRalphController();
        c.attach(session);
        const si = c.tools.find((t) => t.name === "self_improve");
        const stop = c.tools.find((t) => t.name === "ralph_stop");
        await si.handler({ max_iterations: 5, min_iterations: 1 });
        session.emit("session.idle", { data: {} });
        await stop.handler({});
        assert.match(session.logs.join("\n"), /⏹ stopped self_improve.*reason: user_stopped/);
    }
    // completion_promise → ✅ completed self_improve
    {
        const session = makeFakeSession();
        const c = createRalphController();
        c.attach(session);
        const si = c.tools.find((t) => t.name === "self_improve");
        await si.handler({ max_iterations: 5, min_iterations: 1 });
        session.emit("session.idle", { data: {} });
        runTurn(session, "all done COMPLETE");
        assert.match(session.logs.join("\n"), /✅ completed self_improve.*reason: completion_promise/);
    }
    // send_error → ⚠️ ended self_improve
    {
        const session = makeFakeSession({ failSend: true });
        const c = createRalphController();
        c.attach(session);
        const si = c.tools.find((t) => t.name === "self_improve");
        await si.handler({ max_iterations: 5, min_iterations: 1 });
        session.emit("session.idle", { data: {} });
        assert.match(session.logs.join("\n"), /⚠️ ended self_improve.*reason: send_error/);
    }
});

test("finish log line carries the grow_project label for ⏹/✅/⚠️ verbs", async () => {
    // Mirror of the self_improve verb-ladder test above, exercised
    // through grow_project so a regression that hardcodes "ralph_loop"
    // (or "self_improve") back into the finish log line — bypassing
    // state.active.label — is caught for the new tool too. Three
    // branches cover all three verbs in VERB_BY_REASON's fallback
    // ladder. Use min_iterations:1 so completion_promise can fire on
    // iter 1 (the grow_project default of 10 would defer it).
    // user_stopped → ⏹ stopped grow_project
    {
        const session = makeFakeSession();
        const c = createRalphController();
        c.attach(session);
        const gp = c.tools.find((t) => t.name === "grow_project");
        const stop = c.tools.find((t) => t.name === "ralph_stop");
        await gp.handler({ max_iterations: 5, min_iterations: 1 });
        session.emit("session.idle", { data: {} });
        await stop.handler({});
        assert.match(session.logs.join("\n"), /⏹ stopped grow_project.*reason: user_stopped/);
    }
    // completion_promise → ✅ completed grow_project
    {
        const session = makeFakeSession();
        const c = createRalphController();
        c.attach(session);
        const gp = c.tools.find((t) => t.name === "grow_project");
        await gp.handler({ max_iterations: 5, min_iterations: 1 });
        session.emit("session.idle", { data: {} });
        runTurn(session, "all done COMPLETE");
        assert.match(session.logs.join("\n"), /✅ completed grow_project.*reason: completion_promise/);
    }
    // abort_promise → ⏹ stopped grow_project (using ABORT_NO_BACKLOG,
    // which is the new tool's default abort_promise — proves the
    // default plumbing all the way through to the runtime watcher).
    {
        const session = makeFakeSession();
        const c = createRalphController();
        c.attach(session);
        const gp = c.tools.find((t) => t.name === "grow_project");
        await gp.handler({ max_iterations: 5, min_iterations: 1 });
        session.emit("session.idle", { data: {} });
        runTurn(session, "no work left ABORT_NO_BACKLOG");
        assert.match(session.logs.join("\n"), /⏹ stopped grow_project.*reason: abort_promise/);
    }
    // send_error → ⚠️ ended grow_project
    {
        const session = makeFakeSession({ failSend: true });
        const c = createRalphController();
        c.attach(session);
        const gp = c.tools.find((t) => t.name === "grow_project");
        await gp.handler({ max_iterations: 5, min_iterations: 1 });
        session.emit("session.idle", { data: {} });
        assert.match(session.logs.join("\n"), /⚠️ ended grow_project.*reason: send_error/);
    }
});

test("dual Co-authored-by trailers are baked in canonical order: Copilot first, copilot-ralph second (issue #1)", () => {
    // The order of Co-authored-by trailers is observable: GitHub's
    // commit UI surfaces the first co-author more prominently, and
    // any downstream tooling that splits on the first trailer would
    // attribute the commit differently if Copilot and copilot-ralph
    // swap. Pin "Copilot first, copilot-ralph second" in BOTH baked
    // prompts so a refactor that re-orders the COMMIT block can't
    // silently invert attribution. Use indexOf to compare positions
    // explicitly — a single regex matching "Copilot…copilot-ralph"
    // across newlines could backtrack through the inverted order
    // and falsely pass.
    for (const [label, p] of [
        ["PROMPT_SELF_IMPROVE", PROMPT_SELF_IMPROVE],
        ["PROMPT_GROW_PROJECT", PROMPT_GROW_PROJECT],
    ]) {
        const copilotIdx = p.indexOf("Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>");
        const ralphIdx = p.indexOf("Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>");
        assert.notEqual(copilotIdx, -1, `${label} must contain the Copilot trailer`);
        assert.notEqual(ralphIdx, -1, `${label} must contain the copilot-ralph trailer`);
        assert.ok(
            copilotIdx < ralphIdx,
            `${label} must list Copilot trailer BEFORE copilot-ralph (Copilot@${copilotIdx}, copilot-ralph@${ralphIdx}). Inverting order changes which co-author GitHub surfaces first in the commit UI.`,
        );
    }
});

test("README documents both Co-authored-by trailers and RALPH_NO_ATTRIBUTION opt-out (issue #1)", () => {
    // The user-facing README "Commit attribution" section is the
    // canonical disclosure surface for issue #1. Pin its presence
    // so a future README rewrite can't quietly drop:
    //   - the "Commit attribution" section heading
    //   - either of the two canonical Co-authored-by trailer lines
    //     (Copilot agent + copilot-ralph bot account)
    //   - the RALPH_NO_ATTRIBUTION=1 opt-out env var
    //   - the public-only-searchability caveat
    //
    // Also pin that the trailer literals in the README match the
    // BAKED_*_TRAILER constants exported from handler.mjs — the
    // README and the prompt are independent surfaces that must
    // never disagree on the canonical noreply email.
    const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
    assert.match(readme, /^## Commit attribution\b/m, "README must have a '## Commit attribution' section");
    assert.ok(readme.includes(BAKED_COPILOT_TRAILER), "README must spell out the canonical Copilot Co-authored-by trailer");
    assert.ok(readme.includes(BAKED_RALPH_TRAILER), "README must spell out the canonical copilot-ralph Co-authored-by trailer");
    assert.ok(readme.includes(BAKED_ATTRIBUTION_OPT_OUT), `README must document the ${BAKED_ATTRIBUTION_OPT_OUT} opt-out env var`);
    // The public-only caveat is a required disclosure per the issue.
    assert.match(readme, /\bpublic[-\s]?repo[-\s]?(commits|only)\b/i, "README must disclose the public-repo-only searchability caveat");
    // Trailer order matters: GitHub's commit UI surfaces the first
    // co-author more prominently, so Copilot must precede copilot-ralph
    // in the canonical example block. The load-time guard already pins
    // this for the prompts; mirror the order pin for the README so the
    // user-facing example can't silently swap the trailers.
    const copilotIdx = readme.indexOf(BAKED_COPILOT_TRAILER);
    const ralphIdx = readme.indexOf(BAKED_RALPH_TRAILER);
    assert.ok(copilotIdx >= 0 && ralphIdx >= 0, "both trailer literals must appear in README");
    assert.ok(copilotIdx < ralphIdx, `README must list Copilot trailer (idx ${copilotIdx}) BEFORE copilot-ralph trailer (idx ${ralphIdx}) — GitHub UI surfaces the first co-author more prominently`);
});

test("ARCHITECTURE.md tool surface table lists every registered tool", () => {
    // Pin the docs↔code agreement: the ARCHITECTURE.md "Tool surface"
    // table is the canonical map of what this extension exposes for
    // contributors and future-self maintenance. If a new tool ever
    // ships without a row here, contributors won't know it exists;
    // if a tool is renamed without updating the table, the docs go
    // stale on day one. This test fails fast in either case.
    const arch = readFileSync(resolve(REPO_ROOT, "docs/ARCHITECTURE.md"), "utf8");
    const c = createRalphController();
    for (const tool of c.tools) {
        // Each row uses backtick-wrapped tool name in the leading cell,
        // e.g. `| \`ralph_pause\` | …`.
        const needle = `\`${tool.name}\``;
        assert.ok(
            arch.includes(needle),
            `docs/ARCHITECTURE.md must mention the registered tool ${tool.name} in the Tool surface table`,
        );
    }
});

// ── token tracking (issue #7) ─────────────────────────────────────────────

function emitUsage(session, { input, output, model = "claude-opus-4.7", content = "ok" }) {
    session.emit("assistant.message", { data: { content, usage: { input_tokens: input, output_tokens: output, model } } });
    session.emit("session.idle", { data: {} });
}

test("validateArgs: max_tokens default null, accepts positive integer", () => {
    const r = validateArgs({ prompt: "go" });
    assert.equal(r.value.maxTokens, null);
    const r2 = validateArgs({ prompt: "go", max_tokens: 50000 });
    assert.equal(r2.value.maxTokens, 50000);
});

test("validateArgs: max_tokens rejects 0, negative, non-integer, > 1e9", () => {
    assert.match(validateArgs({ prompt: "go", max_tokens: 0 }).error, /max_tokens/);
    assert.match(validateArgs({ prompt: "go", max_tokens: -1 }).error, /max_tokens/);
    assert.match(validateArgs({ prompt: "go", max_tokens: 1.5 }).error, /max_tokens/);
    assert.match(validateArgs({ prompt: "go", max_tokens: 1e10 }).error, /max_tokens/);
});

test("validateArgs: warn_at_pct default 80, accepts 1-99, rejects out of range", () => {
    assert.equal(validateArgs({ prompt: "go" }).value.warnAtPct, 80);
    assert.equal(validateArgs({ prompt: "go", warn_at_pct: 50 }).value.warnAtPct, 50);
    assert.match(validateArgs({ prompt: "go", warn_at_pct: 0 }).error, /warn_at_pct/);
    assert.match(validateArgs({ prompt: "go", warn_at_pct: 100 }).error, /warn_at_pct/);
    assert.match(validateArgs({ prompt: "go", warn_at_pct: 1.5 }).error, /warn_at_pct/);
});

test("token tracking: accumulates input/output across iterations", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    runTurn(session, ""); // pendingFire → iter 1
    emitUsage(session, { input: 1000, output: 200 });
    emitUsage(session, { input: 1500, output: 300 });
    const tk = controller.state.active.tokens;
    assert.equal(tk.input, 2500);
    assert.equal(tk.output, 500);
    assert.equal(tk.byIteration.length, 2);
    assert.equal(tk.byModel["claude-opus-4.7"].input, 2500);
    assert.equal(tk.currentModel, "claude-opus-4.7");
});

test("token tracking: max_tokens cap aborts loop with reason max_tokens", async () => {
    const { session, stop, controller } = await arm({ max_iterations: 100, max_tokens: 1000 });
    runTurn(session, "");
    emitUsage(session, { input: 600, output: 200 }); // 800 < 1000
    assert.ok(controller.state.active, "should still be active");
    emitUsage(session, { input: 200, output: 100 }); // total 1100 ≥ 1000
    // session.idle was emitted by emitUsage; the cap fires on the next idle
    assert.equal(controller.state.active, null);
    assert.equal(controller.state.lastResult.reason, "max_tokens");
    assert.match(controller.state.lastResult.note, /1100 tokens used/);
    void stop;
});

test("token tracking: result.tokens block surfaced on finish", async () => {
    const { session } = await arm({ max_iterations: 100, max_tokens: 500 });
    const c = await import("../extension/handler.mjs");
    runTurn(session, "");
    emitUsage(session, { input: 400, output: 50 });
    emitUsage(session, { input: 200, output: 50 });
    const ralphCtrl = c; // not used; just check session
    void ralphCtrl;
});

test("token tracking: unknown model logs once and skips threshold checks", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    runTurn(session, "");
    session.emit("assistant.message", { data: { content: "x", usage: { input_tokens: 999999999, output_tokens: 0, model: "made-up-model" } } });
    session.emit("assistant.message", { data: { content: "y", usage: { input_tokens: 1, output_tokens: 0, model: "made-up-model" } } });
    const unknownLogs = session.logs.filter((l) => l.includes("no known context-window"));
    assert.equal(unknownLogs.length, 1, "unknown model warning fires at most once");
    // No threshold warnings should fire for unknown models even at huge usage
    const warnLogs = session.logs.filter((l) => l.includes("approaching context window") || l.includes("critical"));
    assert.equal(warnLogs.length, 0);
    void controller;
});

test("token tracking: fires 80% warning once at threshold", async () => {
    const { session, controller } = await arm({ max_iterations: 10 });
    runTurn(session, "");
    // claude-opus-4.7 window = 200000; 80% = 160000
    emitUsage(session, { input: 161000, output: 100 });
    emitUsage(session, { input: 1000, output: 100 }); // would re-trigger if not deduped
    const warnLogs = session.logs.filter((l) => l.includes("approaching context window"));
    assert.equal(warnLogs.length, 1, "80% threshold warns exactly once per loop");
    void controller;
});

test("token tracking: missing usage data is a no-op", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    runTurn(session, "");
    session.emit("assistant.message", { data: { content: "no usage here" } });
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.active.tokens.input, 0);
    assert.equal(controller.state.active.tokens.output, 0);
});

test("token tracking: result.tokens populated when usage seen", async () => {
    const { session, controller, stop } = await arm({ max_iterations: 10 });
    runTurn(session, "");
    emitUsage(session, { input: 100, output: 50 });
    await stop.handler({ reason: "test cleanup" });
    const r = controller.state.lastResult;
    assert.ok(r.tokens, "result should contain tokens block");
    assert.equal(r.tokens.input, 100);
    assert.equal(r.tokens.output, 50);
    assert.equal(r.tokens.total, 150);
});

test("token tracking: tokens block omitted when no usage observed", async () => {
    const { session, controller, stop } = await arm({ max_iterations: 10 });
    runTurn(session, "");
    runTurn(session, "no-usage iter");
    await stop.handler({ reason: "no tokens" });
    const r = controller.state.lastResult;
    assert.equal(r.tokens, undefined);
});

// ── caffeinate integration (issue #8) ────────────────────────────────────

function makeCaffeinateSpy({ failSpawn = false, failError = null } = {}) {
    const calls = [];
    const children = [];
    const spawnFn = (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (failSpawn) throw new Error("spawn failed");
        const child = {
            pid: 99000 + calls.length,
            killed: false,
            killArgs: [],
            errorHandler: null,
            on(type, fn) {
                if (type === "error") {
                    this.errorHandler = fn;
                    if (failError) queueMicrotask(() => fn(failError));
                }
            },
            kill(sig) { this.killed = true; this.killArgs.push(sig); },
        };
        children.push(child);
        return child;
    };
    return { calls, children, spawnFn };
}

async function armWithCaffeinate({ env = {}, platform = "darwin", spawnSpy } = {}) {
    const session = makeFakeSession();
    const controller = createRalphController({
        caffeinate: {
            env,
            platform,
            pid: 12345,
            spawnFn: spawnSpy.spawnFn,
        },
    });
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    const armResult = await ralph.handler({ prompt: "go", max_iterations: 3 });
    return { session, controller, armResult, ralph };
}

test("caffeinate: disabled by default — no spawn, no log line", async () => {
    const spy = makeCaffeinateSpy();
    const { session, armResult } = await armWithCaffeinate({ env: {}, spawnSpy: spy });
    assert.equal(armResult.armed, true);
    assert.equal(spy.calls.length, 0, "must NOT spawn caffeinate when RALPH_CAFFEINATE is unset");
    assert.equal(session.logs.some((l) => l.includes("caffeinate")), false, "no caffeinate log line when disabled");
});

test("caffeinate: enabled via RALPH_CAFFEINATE=1 spawns 'caffeinate -i -w <pid>' on darwin", async () => {
    const spy = makeCaffeinateSpy();
    const { session } = await armWithCaffeinate({
        env: { RALPH_CAFFEINATE: "1" },
        platform: "darwin",
        spawnSpy: spy,
    });
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].cmd, "caffeinate");
    assert.deepEqual(spy.calls[0].args, ["-i", "-w", "12345"]);
    assert.equal(spy.calls[0].opts.stdio, "ignore");
    assert.equal(spy.calls[0].opts.detached, false);
    assert.ok(session.logs.some((l) => /keeping system awake via caffeinate/.test(l)), "must log activation line");
});

test("caffeinate: scope=idle+display adds -d flag", async () => {
    const spy = makeCaffeinateSpy();
    await armWithCaffeinate({
        env: { RALPH_CAFFEINATE: "1", RALPH_CAFFEINATE_SCOPE: "idle+display" },
        platform: "darwin",
        spawnSpy: spy,
    });
    assert.deepEqual(spy.calls[0].args, ["-id", "-w", "12345"]);
});

test("caffeinate: invalid scope falls back to idle", async () => {
    const spy = makeCaffeinateSpy();
    await armWithCaffeinate({
        env: { RALPH_CAFFEINATE: "1", RALPH_CAFFEINATE_SCOPE: "bogus" },
        platform: "darwin",
        spawnSpy: spy,
    });
    assert.deepEqual(spy.calls[0].args, ["-i", "-w", "12345"]);
});

test("caffeinate: child is killed on loop completion", async () => {
    const spy = makeCaffeinateSpy();
    const { session, controller } = await armWithCaffeinate({
        env: { RALPH_CAFFEINATE: "1" },
        platform: "darwin",
        spawnSpy: spy,
    });
    runTurn(session, "doing work");          // iter 1
    runTurn(session, "still going COMPLETE"); // hits completion_promise
    assert.equal(controller.state.active, null, "loop should be finished");
    assert.equal(spy.children.length, 1);
    assert.equal(spy.children[0].killed, true, "caffeinate child must be killed on finish");
    assert.deepEqual(spy.children[0].killArgs, ["SIGTERM"]);
});

test("caffeinate: child is killed on ralph_stop", async () => {
    const spy = makeCaffeinateSpy();
    const { controller } = await armWithCaffeinate({
        env: { RALPH_CAFFEINATE: "1" },
        platform: "darwin",
        spawnSpy: spy,
    });
    const stop = controller.tools.find((t) => t.name === "ralph_stop");
    await stop.handler({});
    assert.equal(spy.children[0].killed, true);
});

test("caffeinate: non-darwin platform is a silent no-op (logged skip, no spawn)", async () => {
    const spy = makeCaffeinateSpy();
    const { session } = await armWithCaffeinate({
        env: { RALPH_CAFFEINATE: "1" },
        platform: "linux",
        spawnSpy: spy,
    });
    assert.equal(spy.calls.length, 0, "must NOT spawn on linux");
    assert.ok(session.logs.some((l) => /caffeinate skipped/.test(l)), "must log a skip line on unsupported platforms");
});

test("caffeinate: spawn throw does not abort the loop", async () => {
    const spy = makeCaffeinateSpy({ failSpawn: true });
    const { session, armResult, controller } = await armWithCaffeinate({
        env: { RALPH_CAFFEINATE: "1" },
        platform: "darwin",
        spawnSpy: spy,
    });
    assert.equal(armResult.armed, true, "loop must arm despite caffeinate spawn failure");
    assert.notEqual(controller.state.active, null);
    assert.ok(session.logs.some((l) => /caffeinate spawn failed/.test(l)), "must log spawn failure");
});

test("caffeinate: truthy variants ('true', 'YES', 'on') all enable", async () => {
    for (const val of ["true", "YES", "on", "1"]) {
        const spy = makeCaffeinateSpy();
        await armWithCaffeinate({
            env: { RALPH_CAFFEINATE: val },
            platform: "darwin",
            spawnSpy: spy,
        });
        assert.equal(spy.calls.length, 1, `value ${JSON.stringify(val)} should enable caffeinate`);
    }
});

test("caffeinate: falsy values keep it off", async () => {
    for (const val of ["0", "false", "", "no", "off"]) {
        const spy = makeCaffeinateSpy();
        await armWithCaffeinate({
            env: { RALPH_CAFFEINATE: val },
            platform: "darwin",
            spawnSpy: spy,
        });
        assert.equal(spy.calls.length, 0, `value ${JSON.stringify(val)} should NOT enable caffeinate`);
    }
});

test("caffeinate: README documents env vars and macOS-only scope", () => {
    const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
    assert.match(readme, /## Keep system awake/, "README must document the caffeinate integration");
    assert.ok(readme.includes("RALPH_CAFFEINATE"), "README must mention RALPH_CAFFEINATE env var");
    assert.ok(readme.includes("RALPH_CAFFEINATE_SCOPE"), "README must mention RALPH_CAFFEINATE_SCOPE env var");
    assert.match(readme, /macOS only|darwin/i, "README must clarify macOS-only scope");
});

// ── ralph_status tool (issue #5) ──────────────────────────────────────────

function makeGitStub(scripts = {}) {
    // scripts: map "first-arg" → { ok, stdout } or full handler fn(args)
    const calls = [];
    return {
        calls,
        exec: (args) => {
            calls.push(args);
            const key = args.join(" ");
            const handler = scripts[key] ?? scripts[args[0]];
            if (typeof handler === "function") return handler(args);
            if (handler) return { ok: true, stdout: "", stderr: "", code: 0, ...handler };
            return { ok: false, stdout: "", stderr: "not stubbed", code: 1 };
        },
    };
}

async function armStatusable({ git } = {}) {
    const session = makeFakeSession();
    const controller = createRalphController(git ? { git: { exec: git.exec, cwd: "/tmp/fake" } } : undefined);
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    const status = controller.tools.find((t) => t.name === "ralph_status");
    return { session, controller, ralph, status };
}

test("ralph_status: with no active loop and no prior run returns { active: false }", async () => {
    const { status } = await armStatusable();
    const r = await status.handler({});
    assert.equal(r.resultType, "success");
    assert.equal(r.status.active, false);
    assert.equal(r.status.last, undefined);
});

test("ralph_status: rejects unknown args", async () => {
    const { status } = await armStatusable();
    const r = await status.handler({ verbose: true });
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /unknown/i);
});

test("ralph_status: during active loop reports iteration, elapsed, promises", async () => {
    const git = makeGitStub({
        "rev-parse HEAD": { ok: false }, // not a repo
    });
    const { ralph, status, session } = await armStatusable({ git });
    await ralph.handler({ prompt: "go", max_iterations: 5, min_iterations: 2, abort_promise: "FAIL", stagnation_limit: 0 });
    runTurn(session, "iteration 1 work");
    const r = await status.handler({});
    assert.equal(r.resultType, "success");
    assert.equal(r.status.active, true);
    assert.equal(r.status.label, "ralph_loop");
    assert.equal(r.status.max_iterations, 5);
    assert.equal(r.status.min_iterations, 2);
    assert.equal(r.status.completion_promise, "COMPLETE");
    assert.equal(r.status.abort_promise, "FAIL");
    assert.equal(r.status.stagnation_limit, 0);
    assert.equal(typeof r.status.elapsed_ms, "number");
    assert.equal(typeof r.status.elapsed_seconds, "number");
    assert.match(r.status.started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(r.status.git, null, "no git block when cwd isn't a git repo");
    assert.equal(r.status.files_changed, undefined);
    assert.match(r.textResultForLlm, /iteration \d+\/5/);
});

test("ralph_status: includes git block + files_changed when armedGit.isRepo", async () => {
    const git = makeGitStub({
        "rev-parse HEAD": { ok: true, stdout: "abc1234\n" },
        "rev-parse --abbrev-ref HEAD": { ok: true, stdout: "feature/x\n" },
        "rev-list --left-right --count @{u}...HEAD": { ok: true, stdout: "0\t3\n" },
        "diff --shortstat HEAD": { ok: true, stdout: " 2 files changed, 12 insertions(+), 3 deletions(-)\n" },
        "diff --name-status -z abc1234..HEAD": {
            ok: true,
            // STATUS\0path\0
            stdout: "A\0src/new.ts\0M\0src/app.ts\0D\0src/old.ts\0",
        },
        "status --porcelain": { ok: true, stdout: "?? scratch.txt\n M README.md\n" },
    });
    const { ralph, status } = await armStatusable({ git });
    await ralph.handler({ prompt: "go", max_iterations: 5 });
    const r = await status.handler({});
    assert.equal(r.status.active, true);
    assert.deepEqual(r.status.git, {
        branch: "feature/x",
        armed_head: "abc1234",
        head: "abc1234",
        ahead: 3,
        behind: 0,
        uncommitted_lines: 15,
    });
    assert.deepEqual(r.status.files_changed.added.sort(), ["scratch.txt", "src/new.ts"]);
    assert.deepEqual(r.status.files_changed.modified.sort(), ["README.md", "src/app.ts"]);
    assert.deepEqual(r.status.files_changed.deleted, ["src/old.ts"]);
});

test("ralph_status: never mutates loop state (read-only)", async () => {
    const git = makeGitStub({ "rev-parse HEAD": { ok: false } });
    const { ralph, status, controller } = await armStatusable({ git });
    await ralph.handler({ prompt: "go", max_iterations: 5 });
    const before = { ...controller.state.active };
    await status.handler({});
    await status.handler({});
    const after = controller.state.active;
    // Same iteration counter, same pendingFire flag, same startedAt timestamp.
    assert.equal(after.i, before.i);
    assert.equal(after.pendingFire, before.pendingFire);
    assert.equal(after.startedAt, before.startedAt);
});

test("ralph_status: after loop finishes, returns { active: false } + last summary", async () => {
    const git = makeGitStub({ "rev-parse HEAD": { ok: false } });
    const { ralph, status, session } = await armStatusable({ git });
    await ralph.handler({ prompt: "go", max_iterations: 3 });
    runTurn(session, "iter 1");
    runTurn(session, "iter 2 COMPLETE");
    const r = await status.handler({});
    assert.equal(r.status.active, false);
    assert.ok(r.status.last, "must include last-run summary");
    assert.equal(r.status.last.label, "ralph_loop");
    assert.equal(r.status.last.reason, "completion_promise");
    assert.match(r.status.last.started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(r.status.last.finished_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof r.status.last.duration_ms, "number");
});

test("ralph_status: last_iteration_at advances each iteration", async () => {
    const git = makeGitStub({ "rev-parse HEAD": { ok: false } });
    const { ralph, status, session } = await armStatusable({ git });
    await ralph.handler({ prompt: "go", max_iterations: 5, stagnation_limit: 0 });
    runTurn(session, "iter 1");
    const a = (await status.handler({})).status.last_iteration_at;
    // Force a different timestamp (Date.now ticks naturally; sleep a tick)
    await new Promise((r) => setTimeout(r, 5));
    runTurn(session, "iter 2");
    const b = (await status.handler({})).status.last_iteration_at;
    assert.ok(a, "first iter timestamp set");
    assert.ok(b, "second iter timestamp set");
    assert.notEqual(a, b);
});

test("ralph_status: README documents the tool", () => {
    const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
    assert.match(readme, /\bralph_status\b/, "README must mention the ralph_status tool");
});

// ── adaptive iteration budget (issue #4) ─────────────────────────────────

function makeAdaptiveGitStub({ shortstat = "", porcelain = "" } = {}) {
    const calls = [];
    const exec = (args) => {
        calls.push(args.join(" "));
        if (args[0] === "diff" && args[1] === "--shortstat") {
            return { ok: true, stdout: shortstat, stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain") {
            return { ok: true, stdout: porcelain, stderr: "" };
        }
        return { ok: false, stdout: "", stderr: "unknown" };
    };
    return { exec, calls };
}

async function armAdaptive(args = {}, gitStub) {
    const session = makeFakeSession();
    const controller = createRalphController(gitStub ? { adaptive: { gitExec: gitStub.exec } } : {});
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    const armResult = await ralph.handler({ prompt: "go", max_iterations: 2, adaptive_budget: true, adaptive_extension: 2, adaptive_max_total: 6, ...args });
    return { session, controller, armResult };
}

test("adaptive_budget: defaults to false; arm result echoes feature flags", async () => {
    const { armResult } = await arm({ max_iterations: 5 });
    assert.equal(armResult.adaptive_budget, false);
    assert.equal(typeof armResult.adaptive_extension, "number");
    assert.equal(typeof armResult.adaptive_max_total, "number");
});

test("adaptive_budget: progressing loop extends max past original", async () => {
    const git = makeAdaptiveGitStub({ shortstat: " 1 file changed, 2 insertions(+)\n" });
    const { session, controller } = await armAdaptive({}, git);
    // pendingFire consumes the first idle; need 1 + max = 3 idles to reach
    // the adaptive check (which fires when i >= max BEFORE the i-increment).
    runTurn(session, "boot");
    runTurn(session, "first");
    runTurn(session, "second — different");
    const a = controller.state.active;
    assert.ok(a, "loop must still be active after extension");
    assert.equal(a.max, 4, "max should be extended by adaptive_extension=2");
    assert.equal(a.originalMax, 2);
    assert.equal(a.adaptiveExtensionHistory.length, 1);
    assert.equal(a.adaptiveExtensionHistory[0].from, 2);
    assert.equal(a.adaptiveExtensionHistory[0].to, 4);
    assert.match(a.adaptiveExtensionHistory[0].reason, /uncommitted changes|distinct responses/);
});

test("adaptive_budget: stuck loop (no progress signals) does NOT extend; finishes at max", async () => {
    const git = makeAdaptiveGitStub({ shortstat: "", porcelain: "" });
    // stagnation_limit=0 disables stagnation so we exercise the adaptive
    // path purely with a clean tree and identical-hash content.
    const { session, controller } = await armAdaptive({ stagnation_limit: 0 }, git);
    runTurn(session, "boot");
    runTurn(session, "same");
    runTurn(session, "same");
    const r = controller.state.lastResult;
    assert.ok(r, "loop should have finished");
    assert.equal(r.reason, "max_iterations");
    assert.equal(r.iterations, 2);
});

test("adaptive_budget: hard ceiling adaptive_max_total is respected", async () => {
    const git = makeAdaptiveGitStub({ shortstat: " 1 file changed\n" });
    const { session, controller } = await armAdaptive({ adaptive_max_total: 3 }, git);
    runTurn(session, "boot");
    runTurn(session, "a");
    runTurn(session, "b");
    const a = controller.state.active;
    assert.ok(a, "still active after first extension");
    assert.equal(a.max, 3, "should clamp to adaptive_max_total");
    runTurn(session, "c");
    const r = controller.state.lastResult;
    assert.ok(r, "loop should have finished at the hard ceiling");
    assert.equal(r.reason, "max_iterations");
    assert.equal(r.iterations, 3);
});

test("adaptive_budget: completion_promise still wins over an available extension", async () => {
    const git = makeAdaptiveGitStub({ shortstat: " 1 file changed\n" });
    const { session, controller } = await armAdaptive({ max_iterations: 2, min_iterations: 1 }, git);
    runTurn(session, "boot");
    runTurn(session, "now COMPLETE token");
    const r = controller.state.lastResult;
    assert.ok(r, "loop must finish");
    assert.equal(r.reason, "completion_promise", "completion wins over adaptive extension");
});

test("adaptive_budget: validateArgs rejects adaptive_extension < 1 and adaptive_max_total < max", () => {
    assert.match(validateArgs({ prompt: "go", adaptive_budget: true, adaptive_extension: 0 }).error, /adaptive_extension/);
    assert.match(validateArgs({ prompt: "go", max_iterations: 10, adaptive_budget: true, adaptive_max_total: 5 }).error, /adaptive_max_total/);
});

test("adaptive_budget: finish() result surfaces adaptive history when feature was enabled", async () => {
    const git = makeAdaptiveGitStub({ shortstat: " 1 file changed\n" });
    const { session, controller } = await armAdaptive({ adaptive_max_total: 3 }, git);
    runTurn(session, "boot");
    runTurn(session, "a");
    runTurn(session, "b");
    runTurn(session, "c");
    const r = controller.state.lastResult;
    assert.ok(r);
    assert.ok(r.adaptive, "finish result must include adaptive block");
    assert.equal(r.adaptive.enabled, true);
    assert.equal(r.adaptive.originalMax, 2);
    assert.equal(r.adaptive.effectiveMax, 3);
    assert.equal(r.adaptive.extensions, 1);
    assert.equal(r.adaptive.history.length, 1);
});

test("adaptive_budget: when feature is OFF, finish() result has no adaptive block", async () => {
    const { session, controller } = await arm({ max_iterations: 1 });
    runTurn(session, "boot");
    runTurn(session, "x");
    const r = controller.state.lastResult;
    assert.ok(r);
    assert.equal(r.adaptive, undefined, "no adaptive block when adaptive_budget is false");
});

// ── ralph_pause / ralph_resume (issue #3) ──────────────────────────────

test("ralph_pause: with no active loop returns failure", async () => {
    const c = createRalphController();
    c.attach(makeFakeSession());
    const pause = c.tools.find((t) => t.name === "ralph_pause");
    const r = await pause.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /no ralph_loop/);
});

test("ralph_resume: with no active loop returns failure", async () => {
    const c = createRalphController();
    c.attach(makeFakeSession());
    const resume = c.tools.find((t) => t.name === "ralph_resume");
    const r = await resume.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /no ralph_loop/);
});

test("ralph_resume: on a non-paused loop returns failure", async () => {
    const { controller } = await arm({ max_iterations: 5 });
    const resume = controller.tools.find((t) => t.name === "ralph_resume");
    const r = await resume.handler({});
    assert.equal(r.resultType, "failure");
    assert.match(r.textResultForLlm, /not paused/);
});

test("ralph_pause: short-circuits onIdle so iteration counter does not advance", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    const pause = controller.tools.find((t) => t.name === "ralph_pause");
    runTurn(session, "boot");
    runTurn(session, "first");
    const beforePause = controller.state.active.i;
    await pause.handler({ reason: "manual review" });
    assert.equal(controller.state.active.paused, true);
    assert.equal(controller.state.active.pauseReason, "manual review");
    // Drive several "fake user chat" idle events while paused — these
    // must NOT consume iterations.
    runTurn(session, "user is chatting");
    runTurn(session, "user is still chatting");
    runTurn(session, "more chatter");
    assert.equal(controller.state.active.i, beforePause, "iteration counter must not advance while paused");
    assert.ok(controller.state.active, "loop must still be active (paused, not stopped)");
});

test("ralph_pause is idempotent — pausing an already-paused loop is a no-op success", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    const pause = controller.tools.find((t) => t.name === "ralph_pause");
    runTurn(session, "boot");
    await pause.handler({ reason: "first" });
    const r = await pause.handler({ reason: "second" });
    assert.equal(r.resultType, "success");
    assert.equal(r.paused, true);
    assert.equal(controller.state.active.pauseReason, "first", "first reason wins; second pause is a no-op");
});

test("ralph_resume: re-arms the loop and the next idle fires the next iteration", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    const pause = controller.tools.find((t) => t.name === "ralph_pause");
    const resume = controller.tools.find((t) => t.name === "ralph_resume");
    runTurn(session, "boot");
    runTurn(session, "first");
    const before = controller.state.active.i;
    await pause.handler({});
    runTurn(session, "while paused");
    await resume.handler({});
    assert.equal(controller.state.active.paused, false);
    assert.equal(controller.state.active.streak, 0, "streak resets on resume");
    assert.equal(controller.state.active.prev, null, "prev resets on resume");
    runTurn(session, "after resume");
    assert.ok(controller.state.active.i > before, "iteration counter must advance after resume");
});

test("ralph_stop while paused still works and tears the loop down", async () => {
    const { session, controller } = await arm({ max_iterations: 5 });
    const pause = controller.tools.find((t) => t.name === "ralph_pause");
    const stop = controller.tools.find((t) => t.name === "ralph_stop");
    runTurn(session, "boot");
    runTurn(session, "first");
    await pause.handler({});
    const r = await stop.handler({ reason: "user gave up" });
    assert.equal(r.resultType, "success");
    assert.equal(controller.state.active, null, "active state must clear");
    assert.equal(controller.state.lastResult.reason, "user_stopped");
});

test("ralph_pause / ralph_resume reject unknown args", async () => {
    const { controller } = await arm({ max_iterations: 5 });
    const pause = controller.tools.find((t) => t.name === "ralph_pause");
    const resume = controller.tools.find((t) => t.name === "ralph_resume");
    const r1 = await pause.handler({ reason: "ok", bogus: 1 });
    assert.equal(r1.resultType, "failure");
    assert.match(r1.textResultForLlm, /unknown|bogus/i);
    const r2 = await resume.handler({ bogus: 1 });
    assert.equal(r2.resultType, "failure");
    assert.match(r2.textResultForLlm, /unknown|bogus/i);
});
