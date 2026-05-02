// Tests for the JSONL event emit wiring (issue #22 slice 3).
//
// Uses opts.events.factory to capture every event in memory — no disk
// I/O, no temp dirs. Pairs with packages/tui/src/{events,writer}.mjs's
// own unit tests (the contract is shared but the surfaces tested are
// disjoint).

import test from "node:test";
import assert from "node:assert/strict";

import { createRalphController } from "../extension/handler.mjs";

function makeFakeSession() {
    const sent = [];
    const handlers = new Map();
    return {
        sent,
        log: () => {},
        send: (opts) => { sent.push(opts); return Promise.resolve("ok"); },
        on: (type, h) => {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type).add(h);
            return () => handlers.get(type).delete(h);
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

function makeRecordingFactory() {
    const calls = [];
    const closes = [];
    const factory = ({ label, startedAt }) => {
        const events = [];
        calls.push({ label, startedAt, events });
        return {
            runId: `${label}-${startedAt}`,
            eventsPath: `/tmp/${label}-${startedAt}.jsonl`,
            write: (ev) => events.push(ev),
            close: () => closes.push(`${label}-${startedAt}`),
        };
    };
    return { calls, closes, factory };
}

async function arm(extra = {}, eventsOpt = true) {
    const { calls, closes, factory } = makeRecordingFactory();
    const events = eventsOpt === true
        ? { factory }
        : eventsOpt;
    const session = makeFakeSession();
    const controller = createRalphController({ events });
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    const stop = controller.tools.find((t) => t.name === "ralph_stop");
    await ralph.handler({ prompt: "go", max_iterations: 5, ...extra });
    return { session, controller, ralph, stop, calls, closes };
}

test("events: emits armed → iteration_start → iteration_end → complete sequence", async () => {
    const { session, calls, closes } = await arm({
        max_iterations: 2,
        completion_promise: "DONE",
    });
    // Bootstrap: session.idle fires iter 1.
    session.emit("session.idle", { data: {} });
    runTurn(session, "still going");          // iter 1 ends, iter 2 fires
    runTurn(session, "all DONE here");        // iter 2 ends, completes
    assert.equal(calls.length, 1, "one writer per arm");
    const types = calls[0].events.map((e) => e.type);
    assert.deepEqual(types, [
        "armed",
        "iteration_start",
        "iteration_end",
        "iteration_start",
        "iteration_end",
        "complete",
    ]);
    const armed = calls[0].events[0];
    assert.equal(armed.label, "ralph_loop");
    assert.equal(armed.maxIterations, 2);
    assert.match(armed.runId, /^ralph_loop-\d+$/);
    const done = calls[0].events.at(-1);
    assert.equal(done.reason, "completion_promise");
    assert.equal(done.iterations, 2);
    assert.equal(closes.length, 1);
});

test("events: emits stagnation event before the stagnation finish", async () => {
    const { session, calls } = await arm({
        max_iterations: 5,
        stagnation_limit: 2,
    });
    session.emit("session.idle", { data: {} });
    runTurn(session, "same");
    runTurn(session, "same");                  // streak hits 2 → stagnation
    const types = calls[0].events.map((e) => e.type);
    assert.ok(types.includes("stagnation"), `types: ${types.join(",")}`);
    const stagIdx = types.indexOf("stagnation");
    assert.equal(types[stagIdx + 1], "abort", "stagnation precedes abort terminal");
    const terminal = calls[0].events.at(-1);
    assert.equal(terminal.type, "abort");
    assert.equal(terminal.reason, "stagnation");
});

test("events: aborted reason maps to type=abort, not type=complete", async () => {
    const { session, controller, calls } = await arm({
        max_iterations: 5,
        abort_promise: "FAIL",
        min_iterations: 1,
    });
    session.emit("session.idle", { data: {} });
    runTurn(session, "FAIL — give up");
    const terminal = calls[0].events.at(-1);
    assert.equal(terminal.type, "abort");
    assert.equal(terminal.reason, "abort_promise");
});

test("events: pause/resume emit dedicated events keyed to the active runId", async () => {
    const { session, controller, calls } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });   // iter 1 fires
    const pause = controller.tools.find((t) => t.name === "ralph_pause");
    const resume = controller.tools.find((t) => t.name === "ralph_resume");
    await pause.handler({ reason: "lunch" });
    await resume.handler({});
    runTurn(session, "back");
    const types = calls[0].events.map((e) => e.type);
    assert.ok(types.includes("pause"), `types: ${types.join(",")}`);
    assert.ok(types.includes("resume"));
    const pauseEv = calls[0].events.find((e) => e.type === "pause");
    assert.equal(pauseEv.reason, "lunch");
    assert.match(pauseEv.runId, /^ralph_loop-\d+$/);
});

test("events: opts.events undefined ⇒ no writer attached, no emit", async () => {
    const session = makeFakeSession();
    const controller = createRalphController(); // no events at all
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    await ralph.handler({ prompt: "go", max_iterations: 1, completion_promise: "X" });
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.active.events, null);
    assert.equal(controller.state.active.runId, null);
});

test("events: factory returning null is treated as 'off' for that arm only", async () => {
    const { session, controller } = await arm({}, { factory: () => null });
    assert.equal(controller.state.active.events, null);
    assert.equal(controller.state.active.runId, null);
    // Loop still runs normally — factory failure must not crash the arm.
    session.emit("session.idle", { data: {} });
    assert.equal(controller.state.active.i, 1);
});

test("events: factory throwing is swallowed; loop runs without events", async () => {
    const session = makeFakeSession();
    const controller = createRalphController({
        events: { factory: () => { throw new Error("boom"); } },
    });
    controller.attach(session);
    const ralph = controller.tools.find((t) => t.name === "ralph_loop");
    const r = await ralph.handler({ prompt: "go", max_iterations: 1, completion_promise: "X" });
    assert.equal(r.resultType, "success");
    assert.equal(controller.state.active.events, null);
});

test("events: iteration_end carries excerpt and per-iter token totals", async () => {
    const { session, calls } = await arm({ max_iterations: 1, completion_promise: "X" });
    session.emit("session.idle", { data: {} });
    // Inject usage on iter 1 then complete.
    session.emit("session.idle", { data: { usage: { input_tokens: 10, output_tokens: 5, model: "gpt-4" } } });
    runTurn(session, "shipped X");
    const ends = calls[0].events.filter((e) => e.type === "iteration_end");
    assert.ok(ends.length >= 1);
    const last = ends.at(-1);
    assert.equal(last.excerpt, "shipped X");
    assert.equal(typeof last.tokens.input, "number");
    assert.equal(typeof last.tokens.output, "number");
});

// Iter 116 — pin the emitted `pause` event's `reason` field to NULL
// when the user supplies no reason (`{}`) OR a whitespace-only reason
// (`"   \t\n   "`). The existing test on line 127+ pins the explicit-
// reason form (reason === "lunch"); the no-reason / whitespace-only
// branches were drift-prone — `parseUserReason` collapses them to
// null at the boundary, but nothing was asserting that null actually
// rides the JSONL event field that downstream TUI consumers parse.
//
// Without this guard, a regression that "preserved" whitespace-only
// reasons (e.g. `reason: a.pauseReason ?? args?.reason ?? null`)
// would silently leak literal "   \t\n   " into events.jsonl,
// where a TUI rendering `(PAUSED — <reason>)` would print a blank
// reason after the em-dash and nothing else would catch it. Pin the
// contract here so that regression is impossible.
test("events: pause event reason is null when reason is absent", async () => {
    const { session, controller, calls } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });   // iter 1 fires
    const pause = controller.tools.find((t) => t.name === "ralph_pause");
    await pause.handler({});
    const pauseEv = calls[0].events.find((e) => e.type === "pause");
    assert.ok(pauseEv, "pause event must be emitted");
    assert.equal(pauseEv.reason, null, "absent reason must serialize as null, not undefined / '' / missing key");
    // The `reason` key MUST exist on the event (downstream consumers
    // do `if ("reason" in ev)` not `if (ev.reason)`); a missing key
    // would silently change the JSON shape.
    assert.ok("reason" in pauseEv, "reason key must be present even when null");
});

test("events: pause event reason is null when reason is whitespace-only", async () => {
    const { session, controller, calls } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });   // iter 1 fires
    const pause = controller.tools.find((t) => t.name === "ralph_pause");
    // Mix every common whitespace shape: spaces, tabs, newlines, CRLF.
    await pause.handler({ reason: "   \t\r\n   " });
    const pauseEv = calls[0].events.find((e) => e.type === "pause");
    assert.ok(pauseEv);
    assert.equal(
        pauseEv.reason,
        null,
        "whitespace-only reason must collapse to null end-to-end (matching parseUserReason's contract)",
    );
});

// Iter 124 — pin that the JSONL `pause` event is emitted exactly ONCE
// per logical pause. `ralph_pause` is idempotent at the handler level
// (test/extension.test.mjs:"ralph_pause is idempotent — pausing an
// already-paused loop is a no-op success") — the second call returns
// success with the FIRST pause's reason and does not mutate state. But
// the JSONL emitter side has no equivalent runtime guard: if a future
// refactor accidentally moved `safeEmit({ type: "pause", ... })` above
// the `if (a.paused) return` short-circuit, every redundant `pause`
// call would write a fresh JSONL line. That breaks the pause-state
// fold any TUI consumer (or downstream tooling) does over the event
// stream — `foldEvents` would see two pause transitions for the same
// run and the iter timeline would render two pause markers where the
// user only paused once. The handler.mjs structure is correct today
// (the early-return precedes safeEmit), but pinning the emitter-side
// invariant directly catches a copy-paste regression that test
// 5959-5968 would not — that test only inspects in-memory state, not
// the durable JSONL trace.
test("events: ralph_pause is idempotent on the JSONL emit side too — exactly one pause event per logical pause", async () => {
    const { session, controller, calls } = await arm({ max_iterations: 5 });
    session.emit("session.idle", { data: {} });
    const pause = controller.tools.find((t) => t.name === "ralph_pause");
    await pause.handler({ reason: "first" });
    await pause.handler({ reason: "second" });
    await pause.handler({ reason: "third" });
    const pauseEvents = calls[0].events.filter((e) => e.type === "pause");
    assert.equal(
        pauseEvents.length,
        1,
        `idempotent ralph_pause must emit exactly ONE pause event in the JSONL stream; got ${pauseEvents.length}: ${JSON.stringify(pauseEvents)}`,
    );
    // First pause's reason wins (first-write-wins matches the in-memory
    // pauseReason semantics asserted in test 5959-5968).
    assert.equal(pauseEvents[0].reason, "first");
});
