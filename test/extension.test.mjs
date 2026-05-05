// Tests for the autopilot loop driver (issues #120 + #122).
//
// The 0.7.0 rewrite replaced the legacy 1.2 KLOC ap_loop /
// self_improve / grow_project controller with a thin re-injection
// driver around the autopilot_scout (#118) probe and the
// autopilot-shipper (#119) custom agent. The driver parses one
// `[AUTOPILOT_RESULT: { ... }]` root token per iter and updates state.
//
// This file pins:
//   1. the [AUTOPILOT_RESULT: …] token parser,
//   2. the state-machine transitions (shipped → reset streaks;
//      blocked × 3 → repeated_blocked stop; complete → stop;
//      parse_failure × 2 → parser_lost_lock stop),
//   3. atomic state-file persistence (corrupt file is recoverable),
//   4. deprecation shims forward to the new tools and include the
//      "deprecated in 0.8.0" warning string,
//   5. /autopilot status returns a snapshot without mutation,
//   6. drift guards inherited from earlier eras (install.sh FILES
//      list, README install loops, SECURITY.md scope, AGENTS.md
//      section ordering, VERSION matches package.json, etc.).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    readFileSync,
    readdirSync,
    mkdtempSync,
    existsSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

import {
    createAutopilotController,
    parseAutopilotResult,
    loadPersistedState,
    VERSION,
    PER_ITER_PROMPT,
    RESULT_TOKEN_RE,
    __test__,
} from "../extension/handler.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─────────────────────────────────────────────────────────────────────
// Fake session — minimal stand-in for CopilotSession used by every
// loop-driver test. Mirrors the legacy `makeFakeSession` shape so
// tests reading the parent doc still recognise it.
// ─────────────────────────────────────────────────────────────────────
function makeFakeSession() {
    const sent = [];
    const logs = [];
    const handlers = new Map();
    return {
        sent,
        logs,
        log: (m) => { logs.push(m); },
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

// Drive one full iter against the fake session: an assistant.message
// carrying `content` then a session.idle.
function runTurn(session, content) {
    session.emit("assistant.message", { data: { content } });
    session.emit("session.idle", { data: {} });
}

// ── ad-hoc temp dir helpers ──────────────────────────────────────────
function makeTempStateFile() {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-state-"));
    return { stateFile: join(dir, "state.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Override scout/shipper factories so tests don't shell out gh and
// don't import the real shipper config from each test.
const stubScoutFactory = (impl) => () => ({
    definition: {
        name: "autopilot_scout",
        description: "stub",
        parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => impl(),
});
const stubShipperFactory = () => ({
    name: "autopilot-shipper",
    prompt: "stub",
    tools: [],
    infer: true,
});

function makeController(overrides = {}) {
    const { stateFile, cleanup } = makeTempStateFile();
    const controller = createAutopilotController({
        stateFile,
        scoutFactory: overrides.scoutFactory ?? stubScoutFactory(() => ({ kind: "no_work" })),
        shipperFactory: overrides.shipperFactory ?? stubShipperFactory,
    });
    return { controller, stateFile, cleanup };
}

// ─────────────────────────────────────────────────────────────────────
// 1. Token parser.
// ─────────────────────────────────────────────────────────────────────

test("parser: complete outcome", () => {
    const r = parseAutopilotResult(`[AUTOPILOT_RESULT: {"outcome":"complete"}]`);
    assert.deepEqual(r, { ok: true, outcome: "complete" });
});

test("parser: shipped outcome with sha", () => {
    const r = parseAutopilotResult(`[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"abc123"}]`);
    assert.deepEqual(r, { ok: true, outcome: "shipped", sha: "abc123" });
});

test("parser: shipped outcome without sha → null sha", () => {
    const r = parseAutopilotResult(`[AUTOPILOT_RESULT: {"outcome":"shipped"}]`);
    assert.deepEqual(r, { ok: true, outcome: "shipped", sha: null });
});

test("parser: blocked outcome with reason", () => {
    const r = parseAutopilotResult(`[AUTOPILOT_RESULT: {"outcome":"blocked","reason":"gh_unauth: not logged in"}]`);
    assert.deepEqual(r, { ok: true, outcome: "blocked", reason: "gh_unauth: not logged in" });
});

test("parser: blocked outcome without reason → unspecified", () => {
    const r = parseAutopilotResult(`[AUTOPILOT_RESULT: {"outcome":"blocked"}]`);
    assert.deepEqual(r, { ok: true, outcome: "blocked", reason: "unspecified" });
});

test("parser: missing token → ok:false / missing_token", () => {
    const r = parseAutopilotResult("nothing to see here");
    assert.deepEqual(r, { ok: false, error: "missing_token" });
});

test("parser: malformed JSON → ok:false / malformed_json", () => {
    const r = parseAutopilotResult(`[AUTOPILOT_RESULT: {outcome:complete}]`);
    assert.equal(r.ok, false);
    assert.match(r.error, /malformed_json/);
});

test("parser: non-string input → ok:false / missing_token", () => {
    assert.deepEqual(parseAutopilotResult(null), { ok: false, error: "missing_token" });
    assert.deepEqual(parseAutopilotResult(undefined), { ok: false, error: "missing_token" });
    assert.deepEqual(parseAutopilotResult(""), { ok: false, error: "missing_token" });
});

test("parser: unknown outcome → ok:false", () => {
    const r = parseAutopilotResult(`[AUTOPILOT_RESULT: {"outcome":"sneaky"}]`);
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown_outcome/);
});

test("parser: token surrounded by other text", () => {
    const r = parseAutopilotResult(
        "Some preamble.\n\n[AUTOPILOT_RESULT: {\"outcome\":\"complete\"}]\n\nSome trailer.",
    );
    assert.deepEqual(r, { ok: true, outcome: "complete" });
});

test("parser regex: only matches up to closing bracket on same logical group", () => {
    // The regex is non-greedy on the JSON body and forbids `[]` inside,
    // so a stray `[` later in the line cannot extend the match.
    const r = parseAutopilotResult(
        `[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"abc"}] [stale]`,
    );
    assert.deepEqual(r, { ok: true, outcome: "shipped", sha: "abc" });
});

// ─────────────────────────────────────────────────────────────────────
// 2. State-machine transitions.
// ─────────────────────────────────────────────────────────────────────

test("state: arming kicks off iter 1 immediately and persists", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        assert.ok(run);
        return run.handler({ max_iters: 5 }).then((res) => {
            assert.equal(res.resultType, "success");
            assert.equal(controller.state.armed, true);
            assert.equal(controller.state.iter, 1);
            assert.equal(session.sent.length, 1);
            assert.match(session.sent[0].prompt, /AUTOPILOT loop driver/);
        });
    } finally {
        cleanup();
    }
});

test("state: complete outcome stops the loop with reason=complete", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 5 }).then(() => {
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"complete"}]`);
            assert.equal(controller.state.armed, false);
            assert.equal(controller.state.stop_reason, "complete");
        });
    } finally {
        cleanup();
    }
});

test("state: shipped outcome resets streaks and re-injects next iter", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 5 }).then(() => {
            // Two prior blocked outcomes (streak=2) — a shipped reset
            // pulls them back to 0.
            controller.state.shipper_streak_blocked = 2;
            controller.state.scout_streak_no_work = 1;
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"abc123"}]`);
            assert.equal(controller.state.armed, true, "shipped should not stop the loop");
            assert.equal(controller.state.shipper_streak_blocked, 0);
            assert.equal(controller.state.scout_streak_no_work, 0);
            assert.equal(controller.state.last_iter_outcome.outcome, "shipped");
            assert.equal(controller.state.last_iter_outcome.sha, "abc123");
            // Re-injection happens on session.idle inside runTurn.
            assert.equal(session.sent.length, 2);
        });
    } finally {
        cleanup();
    }
});

test("state: 3 consecutive blocked outcomes stop with repeated_blocked", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 10 }).then(() => {
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"blocked","reason":"first"}]`);
            assert.equal(controller.state.armed, true);
            assert.equal(controller.state.shipper_streak_blocked, 1);
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"blocked","reason":"second"}]`);
            assert.equal(controller.state.armed, true);
            assert.equal(controller.state.shipper_streak_blocked, 2);
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"blocked","reason":"third"}]`);
            assert.equal(controller.state.armed, false);
            assert.equal(controller.state.stop_reason, "repeated_blocked");
            assert.equal(controller.state.shipper_streak_blocked, 3);
        });
    } finally {
        cleanup();
    }
});

test("state: shipped between blocks resets the blocked streak", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 10 }).then(() => {
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"blocked","reason":"first"}]`);
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"blocked","reason":"second"}]`);
            assert.equal(controller.state.shipper_streak_blocked, 2);
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"deadbeef"}]`);
            assert.equal(controller.state.shipper_streak_blocked, 0);
            // Two more blocks no longer trigger repeated_blocked.
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"blocked","reason":"x"}]`);
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"blocked","reason":"y"}]`);
            assert.equal(controller.state.armed, true);
            assert.equal(controller.state.shipper_streak_blocked, 2);
        });
    } finally {
        cleanup();
    }
});

test("state: parse failure × 2 stops with parser_lost_lock", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 10 }).then(() => {
            // Bad JSON twice in a row.
            runTurn(session, `[AUTOPILOT_RESULT: {bad json}]`);
            assert.equal(controller.state.armed, true);
            assert.equal(controller.state.parse_failure_streak, 1);
            runTurn(session, `[AUTOPILOT_RESULT: still bad]`);
            assert.equal(controller.state.armed, false);
            assert.equal(controller.state.stop_reason, "parser_lost_lock");
        });
    } finally {
        cleanup();
    }
});

test("state: a clean message between two parse failures resets the streak", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 10 }).then(() => {
            runTurn(session, `[AUTOPILOT_RESULT: {bad}]`);
            assert.equal(controller.state.parse_failure_streak, 1);
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"x"}]`);
            assert.equal(controller.state.parse_failure_streak, 0);
            runTurn(session, `[AUTOPILOT_RESULT: {bad}]`);
            assert.equal(controller.state.armed, true,
                "single parse failure after a successful message should not stop");
        });
    } finally {
        cleanup();
    }
});

test("state: non-token assistant message does NOT increment parse_failure_streak", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 10 }).then(() => {
            // Plain prose — no [AUTOPILOT_RESULT:` substring at all.
            runTurn(session, "Calling autopilot_scout to look for work…");
            assert.equal(controller.state.parse_failure_streak, 0);
            runTurn(session, "still no token yet, just narration");
            assert.equal(controller.state.parse_failure_streak, 0);
            assert.equal(controller.state.armed, true);
        });
    } finally {
        cleanup();
    }
});

test("state: max_iters cap stops the loop", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 2 }).then(() => {
            // First iter fired by arm. Send a shipped → next iter
            // fires. Send another shipped → cap hit on the next idle.
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"a"}]`);
            assert.equal(controller.state.armed, true);
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"b"}]`);
            assert.equal(controller.state.armed, false);
            assert.equal(controller.state.stop_reason, "max_iters");
        });
    } finally {
        cleanup();
    }
});

test("state: max_tokens cap stops the loop when exceeded", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 100, max_tokens: 100 }).then(() => {
            // Crash through cap on the first iter via a usage event.
            session.emit("assistant.message", {
                data: {
                    content: `[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"a"}]`,
                    usage: { input_tokens: 80, output_tokens: 40 },
                },
            });
            session.emit("session.idle", { data: {} });
            assert.equal(controller.state.armed, false);
            assert.equal(controller.state.stop_reason, "max_tokens");
            assert.ok(controller.state.total_tokens >= 100);
        });
    } finally {
        cleanup();
    }
});

// Drift guard: every `state.history` row must carry a numeric `ts`
// (Date.now() at push time). The TUI Timeline pane (#121) renders
// `formatClock(row.ts)` and falls back to `--:--:--` when missing,
// so dropping `ts` would silently degrade the dashboard. Three
// push sites in handler.mjs: outcome, parse_failure, stop.
test("state: every history row includes a numeric `ts` field", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 5 }).then(() => {
            const before = Date.now();
            // 1) outcome push (shipped).
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"deadbee"}]`);
            // 2) parse_failure push.
            session.emit("assistant.message", {
                data: { content: "[AUTOPILOT_RESULT: not-json}]" },
            });
            session.emit("session.idle", { data: {} });
            // 3) stop push (with detail) via complete outcome.
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"complete"}]`);
            const after = Date.now();
            const rows = controller.state.history;
            assert.ok(rows.length >= 2, `expected ≥2 history rows, got ${rows.length}`);
            for (const row of rows) {
                assert.equal(typeof row.ts, "number",
                    `history row ${JSON.stringify(row)} missing numeric ts`);
                assert.ok(row.ts >= before && row.ts <= after,
                    `history row ts ${row.ts} outside test window [${before}, ${after}]`);
            }
        });
    } finally {
        cleanup();
    }
});

test("state: sub-agent assistant.message events do not advance the parent loop", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 10 }).then(() => {
            // Sub-agent emits the SHIPPED line but with agentId set —
            // parent driver MUST ignore it (it's the shipper sub-agent's
            // own terminal token, not the root contract token).
            session.emit("assistant.message", {
                agentId: "shipper-1",
                data: { content: `[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"abc"}]` },
            });
            assert.equal(controller.state.last_iter_outcome, null,
                "sub-agent token must not become the parent loop's outcome");
        });
    } finally {
        cleanup();
    }
});

test("state: detach stops the loop with reason=detached", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        const detach = controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 5 }).then(() => {
            assert.equal(controller.state.armed, true);
            detach();
            assert.equal(controller.state.armed, false);
            assert.equal(controller.state.stop_reason, "detached");
        });
    } finally {
        cleanup();
    }
});

// ─────────────────────────────────────────────────────────────────────
// 3. State-file persistence (atomic + corrupt-recoverable).
// ─────────────────────────────────────────────────────────────────────

test("persistence: state is written to disk on arm and updated on stop", async () => {
    const { stateFile, cleanup } = makeTempStateFile();
    try {
        const session = makeFakeSession();
        const controller = createAutopilotController({
            stateFile,
            scoutFactory: stubScoutFactory(() => ({ kind: "no_work" })),
            shipperFactory: stubShipperFactory,
        });
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        await run.handler({ max_iters: 3 });
        assert.ok(existsSync(stateFile), "state.json should exist after arm");
        const armed = JSON.parse(readFileSync(stateFile, "utf8"));
        assert.equal(armed.armed, true);
        assert.equal(armed.max_iters, 3);
        runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"complete"}]`);
        const stopped = JSON.parse(readFileSync(stateFile, "utf8"));
        assert.equal(stopped.armed, false);
        assert.equal(stopped.stop_reason, "complete");
        assert.ok(stopped.last_run, "last_run should be set after stop");
        assert.equal(stopped.last_run.stop_reason, "complete");
    } finally {
        cleanup();
    }
});

test("persistence: corrupt state file loads as null (does not crash)", () => {
    const { stateFile, cleanup } = makeTempStateFile();
    try {
        // Write garbage that JSON.parse cannot handle.
        writeFileSync(stateFile, "{not json at all", "utf8");
        const loaded = loadPersistedState({ stateFile });
        assert.equal(loaded, null);
        // Controller still constructs cleanly with corrupt file.
        const controller = createAutopilotController({
            stateFile,
            scoutFactory: stubScoutFactory(() => ({ kind: "no_work" })),
            shipperFactory: stubShipperFactory,
        });
        assert.equal(controller.state.armed, false);
        assert.equal(controller.state.iter, 0);
    } finally {
        cleanup();
    }
});

test("persistence: missing state file loads as null", () => {
    const { stateFile, cleanup } = makeTempStateFile();
    try {
        // No write — file doesn't exist.
        assert.equal(loadPersistedState({ stateFile }), null);
    } finally {
        cleanup();
    }
});

test("persistence: persistState helper writes valid JSON atomically", () => {
    const { stateFile, cleanup } = makeTempStateFile();
    try {
        const ok = __test__.persistState({ armed: false, iter: 5 }, { stateFile });
        assert.equal(ok, true);
        const content = readFileSync(stateFile, "utf8");
        const parsed = JSON.parse(content);
        assert.equal(parsed.iter, 5);
    } finally {
        cleanup();
    }
});

test("persistence: persistState swallows failures (read-only path)", () => {
    // Aim at an unwritable path. Tools error path: write under /dev/null/
    // which is not a directory.
    const ok = __test__.persistState({}, { stateFile: "/dev/null/cant-write/state.json" });
    assert.equal(ok, false);
});

// ─────────────────────────────────────────────────────────────────────
// 4. Deprecation shims.
// ─────────────────────────────────────────────────────────────────────

test("deprecation: ap_loop tool exists, forwards to autopilot_run, includes warning", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const apLoop = controller.tools.find((t) => t.name === "ap_loop");
        assert.ok(apLoop, "ap_loop deprecation shim must exist in 0.7.0");
        assert.match(apLoop.description, /deprecated/i);
        assert.match(apLoop.description, /0\.8\.0/);
        return apLoop.handler({ max_iterations: 7 }).then((res) => {
            assert.equal(res.resultType, "success");
            assert.match(res.textResultForLlm, /deprecated/i);
            assert.match(res.textResultForLlm, /autopilot_run/);
            assert.equal(controller.state.armed, true);
            assert.equal(controller.state.max_iters, 7);
        });
    } finally {
        cleanup();
    }
});

test("deprecation: ap_status forwards to autopilot_status with warning", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const apStatus = controller.tools.find((t) => t.name === "ap_status");
        assert.ok(apStatus);
        assert.match(apStatus.description, /deprecated/i);
        return apStatus.handler({}).then((res) => {
            assert.equal(res.resultType, "success");
            assert.match(res.textResultForLlm, /deprecated/i);
            assert.ok(res.snapshot, "ap_status shim must surface the snapshot");
            // Read-only — should not flip armed.
            assert.equal(controller.state.armed, false);
        });
    } finally {
        cleanup();
    }
});

test("deprecation: ap_stop forwards to autopilot_stop with warning", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        const apStop = controller.tools.find((t) => t.name === "ap_stop");
        return run.handler({ max_iters: 5 }).then(() => apStop.handler({})).then((res) => {
            assert.equal(res.resultType, "success");
            assert.match(res.textResultForLlm, /deprecated/i);
            assert.equal(controller.state.armed, false);
            assert.equal(controller.state.stop_reason, "user_stopped");
        });
    } finally {
        cleanup();
    }
});

test("deprecation: ap_pause / ap_resume return failure with v2-deferred message", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const apPause = controller.tools.find((t) => t.name === "ap_pause");
        const apResume = controller.tools.find((t) => t.name === "ap_resume");
        return Promise.all([apPause.handler({}), apResume.handler({})]).then(([p, r]) => {
            assert.equal(p.resultType, "failure");
            assert.match(p.textResultForLlm, /deferred to v2/i);
            assert.equal(r.resultType, "failure");
            assert.match(r.textResultForLlm, /deferred to v2/i);
        });
    } finally {
        cleanup();
    }
});

test("deprecation: self_improve and grow_project tools are HARD removed", () => {
    const { controller, cleanup } = makeController();
    try {
        const names = controller.tools.map((t) => t.name);
        assert.ok(!names.includes("self_improve"),
            "self_improve must be removed in 0.7.0 (issue #122)");
        assert.ok(!names.includes("grow_project"),
            "grow_project must be removed in 0.7.0 (issue #122)");
    } finally {
        cleanup();
    }
});

// ─────────────────────────────────────────────────────────────────────
// 5. Tool surface + slash command + status invariants.
// ─────────────────────────────────────────────────────────────────────

test("tool surface: 4 first-class autopilot_* + autopilot_scout + 5 deprecation shims", () => {
    const { controller, cleanup } = makeController();
    try {
        const names = controller.tools.map((t) => t.name).sort();
        // 4 new + 1 scout + 5 deprecation shims = 9 total. Pin so a
        // future `delete` quietly dropping a tool fails the guard.
        assert.deepEqual(names, [
            "ap_loop",
            "ap_pause",
            "ap_resume",
            "ap_status",
            "ap_stop",
            "autopilot_run",
            "autopilot_scout",
            "autopilot_status",
            "autopilot_stop",
        ].sort());
    } finally {
        cleanup();
    }
});

test("custom agents: autopilot-shipper is registered", () => {
    const { controller, cleanup } = makeController();
    try {
        assert.equal(controller.customAgents.length, 1);
        assert.equal(controller.customAgents[0].name, "autopilot-shipper");
    } finally {
        cleanup();
    }
});

test("commands: /autopilot is registered with a handler", () => {
    const { controller, cleanup } = makeController();
    try {
        assert.equal(controller.commands.length, 1);
        const cmd = controller.commands[0];
        assert.equal(cmd.name, "autopilot");
        assert.equal(typeof cmd.handler, "function");
    } finally {
        cleanup();
    }
});

test("commands: /autopilot status logs a summary without mutating state", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const cmd = controller.commands[0];
        return cmd.handler({ args: "status", commandName: "autopilot", command: "/autopilot status", sessionId: "x" }).then(() => {
            assert.equal(controller.state.armed, false,
                "/autopilot status must not arm the loop");
            assert.ok(session.logs.some((l) => /no active loop/.test(l)),
                "/autopilot status must log a summary");
        });
    } finally {
        cleanup();
    }
});

test("commands: /autopilot run arms the loop", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const cmd = controller.commands[0];
        return cmd.handler({ args: "run", commandName: "autopilot", command: "/autopilot run", sessionId: "x" }).then(() => {
            assert.equal(controller.state.armed, true);
        });
    } finally {
        cleanup();
    }
});

test("commands: /autopilot with no args defaults to run", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const cmd = controller.commands[0];
        return cmd.handler({ args: "", commandName: "autopilot", command: "/autopilot", sessionId: "x" }).then(() => {
            assert.equal(controller.state.armed, true);
        });
    } finally {
        cleanup();
    }
});

test("commands: /autopilot stop stops a running loop", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 5 }).then(() => {
            const cmd = controller.commands[0];
            return cmd.handler({ args: "stop", commandName: "autopilot", command: "/autopilot stop", sessionId: "x" });
        }).then(() => {
            assert.equal(controller.state.armed, false);
            assert.equal(controller.state.stop_reason, "user_stopped");
        });
    } finally {
        cleanup();
    }
});

test("autopilot_status: read-only, never mutates state", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const status = controller.tools.find((t) => t.name === "autopilot_status");
        return status.handler({}).then((res) => {
            assert.equal(res.resultType, "success");
            assert.equal(res.snapshot.armed, false);
            // version surfaces in the snapshot so a TUI / status reader
            // can detect a stale extension without parsing handler.mjs.
            assert.equal(res.snapshot.version, VERSION);
        });
    } finally {
        cleanup();
    }
});

test("autopilot_run: rejects unknown args", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ bogus: 1 }).then((res) => {
            assert.equal(res.resultType, "failure");
            assert.match(res.textResultForLlm, /unknown argument/i);
        });
    } finally {
        cleanup();
    }
});

test("autopilot_run: rejects out-of-range max_iters", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 0 }).then((res) => {
            assert.equal(res.resultType, "failure");
            assert.match(res.textResultForLlm, /max_iters/);
        });
    } finally {
        cleanup();
    }
});

test("autopilot_run: same-loop double-arm fails cleanly", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 5 }).then(() => run.handler({})).then((res) => {
            assert.equal(res.resultType, "failure");
            assert.match(res.textResultForLlm, /already running/i);
        });
    } finally {
        cleanup();
    }
});

// ─────────────────────────────────────────────────────────────────────
// 6. Drift guards (preserved from earlier eras).
// ─────────────────────────────────────────────────────────────────────

test("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(VERSION, pkg.version,
        "extension/handler.mjs's VERSION constant must match package.json#version. " +
        "Both bumps live in the same release PR — see AGENTS.md §3 release flow.");
});

test("install.sh: FILES array matches actual extension/*.mjs on disk (drift guard)", () => {
    const installSh = readFileSync(resolve(REPO_ROOT, "install.sh"), "utf8");
    const m = /^FILES=\(([^)]+)\)/m.exec(installSh);
    assert.ok(m, "install.sh must declare FILES=(...) on its own line");
    const installFiles = m[1].trim().split(/\s+/).filter(Boolean).sort();
    const sourceFiles = readdirSync(resolve(REPO_ROOT, "extension"))
        .filter((f) => f.endsWith(".mjs"))
        .sort();
    assert.deepEqual(installFiles, sourceFiles,
        `install.sh FILES (${installFiles.join(", ")}) must match extension/*.mjs (${sourceFiles.join(", ")}). ` +
        "Add to FILES whenever you add a sibling .mjs in extension/, remove when you remove one.");
});

test("install.sh: entry-point extension.mjs is LAST for atomic-reload safety", () => {
    const installSh = readFileSync(resolve(REPO_ROOT, "install.sh"), "utf8");
    const m = /^FILES=\(([^)]+)\)/m.exec(installSh);
    assert.ok(m);
    const list = m[1].trim().split(/\s+/).filter(Boolean);
    assert.equal(list[list.length - 1], "extension.mjs",
        `FILES order must end with extension.mjs (the entry point). Got: [${list.join(", ")}]`);
});

test("README curl install loops match install.sh's FILES (entry point LAST)", () => {
    const installSh = readFileSync(resolve(REPO_ROOT, "install.sh"), "utf8");
    const m = /^FILES=\(([^)]+)\)/m.exec(installSh);
    assert.ok(m);
    const expectedOrder = m[1].trim();
    const docsDir = resolve(REPO_ROOT, "docs");
    const mdFiles = [
        resolve(REPO_ROOT, "README.md"),
        ...readdirSync(docsDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => join(docsDir, f)),
    ];
    let totalLoops = 0;
    for (const md of mdFiles) {
        const text = readFileSync(md, "utf8");
        const forLoops = [...text.matchAll(/for f in ([^;]+); do/g)].map((mm) => mm[1].trim());
        for (const list of forLoops) {
            if (!/handler\.mjs/.test(list)) continue;
            totalLoops += 1;
            assert.equal(list, expectedOrder,
                `${md.replace(REPO_ROOT, "")}: curl install loop has wrong file order: ${JSON.stringify(list)}. ` +
                `Must match install.sh's FILES (${expectedOrder}).`);
        }
    }
    assert.ok(totalLoops >= 3, `expected ≥3 install curl loops across docs, found ${totalLoops}`);
});

test("SECURITY.md in-scope list covers every shipped extension/*.mjs", () => {
    const security = readFileSync(resolve(REPO_ROOT, "SECURITY.md"), "utf8");
    const modules = readdirSync(resolve(REPO_ROOT, "extension"))
        .filter((f) => f.endsWith(".mjs"));
    for (const mod of modules) {
        const re = new RegExp(`\\b${mod.replace(/\./g, "\\.")}\\b`);
        assert.match(security, re,
            `SECURITY.md must mention ${mod} by basename so reporters can confirm it's in scope`);
    }
    assert.match(security, /install\.sh.*FILES/i,
        "SECURITY.md must point at install.sh's FILES array as the source-of-truth for in-scope modules");
});

test("AGENTS.md section-name order matches the order used in CHANGELOG.md's `## Unreleased` block", () => {
    const canonical = ["Breaking", "Features", "Fixes", "Performance", "Refactor", "Internal", "Tests", "CI", "Documentation"];
    const cl = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const startMatch = /^## Unreleased\s*$/m.exec(cl);
    assert.ok(startMatch, "CHANGELOG.md must start with `## Unreleased`");
    const after = cl.slice(startMatch.index + startMatch[0].length);
    const nextRelease = /^## \S/m.exec(after);
    const block = nextRelease ? after.slice(0, nextRelease.index) : after;
    const headings = [...block.matchAll(/^### (\w[\w ]*)\s*$/gm)].map((mm) => mm[1]);
    // We only enforce the relative order of FIRST occurrences.
    const firstSeen = [];
    for (const h of headings) {
        if (canonical.includes(h) && !firstSeen.includes(h)) firstSeen.push(h);
    }
    let prev = -1;
    for (const h of firstSeen) {
        const idx = canonical.indexOf(h);
        assert.ok(idx > prev,
            `CHANGELOG.md ## Unreleased section "${h}" appears out of canonical order. ` +
            `Canonical order: ${canonical.join(" → ")}. Got first-occurrence sequence: ${firstSeen.join(" → ")}.`);
        prev = idx;
    }
});

test("install.sh: --version prints `copilot-ralph-extension vX.Y.Z` and exits 0", () => {
    const r = spawnSync("bash", [resolve(REPO_ROOT, "install.sh"), "--version"], { encoding: "utf8" });
    assert.equal(r.status, 0, `--version exited ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stdout, /^copilot-ralph-extension v\d+\.\d+\.\d+/);
    const handler = readFileSync(resolve(REPO_ROOT, "extension/handler.mjs"), "utf8");
    const m = handler.match(/^export const VERSION = "([^"]+)";/m);
    assert.ok(m, "handler.mjs must declare `export const VERSION = \"X.Y.Z\";`");
    assert.match(r.stdout, new RegExp(`v${m[1].replace(/\./g, "\\.")}`));
});

test("PER_ITER_PROMPT mentions the contract surface", () => {
    // The per-iter prompt is what every iter pays in input tokens, so
    // it must stay terse — but the four anchors (scout name, shipper
    // name, root token format, "never ask the user") are the protocol
    // contract and cannot drift silently.
    assert.match(PER_ITER_PROMPT, /autopilot_scout/);
    assert.match(PER_ITER_PROMPT, /autopilot-shipper/);
    assert.match(PER_ITER_PROMPT, /\[AUTOPILOT_RESULT:/);
    assert.match(PER_ITER_PROMPT, /Never ask the user/i);
    // Soft cap (not a hard contract): keep this prompt < 1.5 KB so a
    // future bloat surfaces here, not in production token costs.
    assert.ok(PER_ITER_PROMPT.length < 1500,
        `PER_ITER_PROMPT is ${PER_ITER_PROMPT.length} chars; tighten before exceeding 1.5 KB.`);
});

test("RESULT_TOKEN_RE is exported and well-formed", () => {
    assert.ok(RESULT_TOKEN_RE instanceof RegExp);
    assert.equal(RESULT_TOKEN_RE.test(`[AUTOPILOT_RESULT: {"outcome":"complete"}]`), true);
    assert.equal(RESULT_TOKEN_RE.test("nothing"), false);
});

test("loadPersistedState surfaces the previous run's outcome to a fresh controller", () => {
    const { stateFile, cleanup } = makeTempStateFile();
    try {
        // Write a "previous run completed" snapshot.
        writeFileSync(stateFile, JSON.stringify({
            armed: false,
            iter: 7,
            stop_reason: "complete",
            started_at: 1000,
            finished_at: 2000,
            history: [{ iter: 7, event: "outcome", outcome: "complete" }],
        }), "utf8");
        const controller = createAutopilotController({
            stateFile,
            scoutFactory: stubScoutFactory(() => ({ kind: "no_work" })),
            shipperFactory: stubShipperFactory,
        });
        // Fresh controller should not be armed but should expose
        // last_run for /autopilot status.
        assert.equal(controller.state.armed, false);
        assert.ok(controller.state.last_run);
        assert.equal(controller.state.last_run.iter, 7);
        assert.equal(controller.state.last_run.stop_reason, "complete");
    } finally {
        cleanup();
    }
});

test("hooks: onUserPromptSubmitted injects post-loop context exactly once after a stop", () => {
    const { controller, cleanup } = makeController();
    try {
        const session = makeFakeSession();
        controller.attach(session);
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 5 }).then(() => {
            runTurn(session, `[AUTOPILOT_RESULT: {"outcome":"complete"}]`);
            return controller.hooks.onUserPromptSubmitted();
        }).then((firstHook) => {
            assert.ok(firstHook && firstHook.additionalContext);
            assert.match(firstHook.additionalContext, /autopilot just finished/);
            // Second call should NOT re-emit the same context.
            return controller.hooks.onUserPromptSubmitted();
        }).then((secondHook) => {
            assert.equal(secondHook, undefined,
                "hook should fire only once per stop event");
        });
    } finally {
        cleanup();
    }
});

test("attach: rejects an invalid session", () => {
    const { controller, cleanup } = makeController();
    try {
        assert.throws(() => controller.attach(null), /requires a session/);
        assert.throws(() => controller.attach({}), /send\(\) and on\(\)/);
    } finally {
        cleanup();
    }
});

test("attach: re-attach detaches the previous session cleanly", () => {
    const { controller, cleanup } = makeController();
    try {
        const s1 = makeFakeSession();
        const s2 = makeFakeSession();
        controller.attach(s1);
        controller.attach(s2);
        // s1's listeners should be torn down; emitting on s1 should
        // NOT touch state any more.
        const run = controller.tools.find((t) => t.name === "autopilot_run");
        return run.handler({ max_iters: 3 }).then(() => {
            // Send the result token on the OLD session — driver no longer
            // listens, so state should remain armed.
            runTurn(s1, `[AUTOPILOT_RESULT: {"outcome":"complete"}]`);
            assert.equal(controller.state.armed, true,
                "stale session events must not mutate the loop state");
        });
    } finally {
        cleanup();
    }
});

test("backwards-compat: createRalphController alias forwards to createAutopilotController", async () => {
    const { stateFile, cleanup } = makeTempStateFile();
    try {
        // Tests / installed copies that still reach for the legacy alias
        // should keep working through 0.7.0; planned for removal in 0.8.0.
        const handlerPath = resolve(REPO_ROOT, "extension/handler.mjs");
        const mod = await import(handlerPath);
        assert.strictEqual(mod.createRalphController, mod.createAutopilotController);
        const controller = mod.createRalphController({
            stateFile,
            scoutFactory: stubScoutFactory(() => ({ kind: "no_work" })),
            shipperFactory: stubShipperFactory,
        });
        const session = makeFakeSession();
        controller.attach(session);
        assert.ok(controller.tools.find((t) => t.name === "autopilot_run"));
    } finally {
        cleanup();
    }
});
