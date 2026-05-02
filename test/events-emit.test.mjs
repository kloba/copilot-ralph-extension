// Unit tests for extension/events-emit.mjs — the zero-dep JSONL emitter
// shipped next to handler.mjs. Until now coverage came only via the
// handler-events integration tests, which leaves the helpers
// (resolveRunsRoot / makeRunId / createEventEmitter's truncation +
// error-swallowing paths) untested in isolation. These tests pin the
// exported contract so a future refactor can't drift silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    resolveRunsRoot,
    makeRunId,
    createEventEmitter,
} from "../extension/events-emit.mjs";

// Stage 3 (issue #49): resolveRunsRoot now performs sentinel-gated
// stderr deprecation notices when legacy $RALPH_EVENTS_DIR or the
// legacy ~/.copilot/ralph/runs default path is used. Tests that don't
// care about the notice path inject a fake fs (which has no sentinel
// and accepts mkdir/append silently) and a fake stderr (capturing
// writes into an array we can inspect). The sentinelPath is pointed
// at a fake location too so a deprecation write never touches the
// real ~/.copilot dir.
function makeFakeFs({ sentinel = "", existingPaths = new Set() } = {}) {
    let written = "";
    const fs = {
        readFileSync: (p) => {
            if (p === fs._sentinelPath) return sentinel + written;
            const e = new Error("ENOENT");
            e.code = "ENOENT";
            throw e;
        },
        appendFileSync: (p, data) => {
            if (p === fs._sentinelPath) written += data;
        },
        mkdirSync: () => {},
        existsSync: (p) => existingPaths.has(p),
    };
    fs._sentinelPath = "/fake/sentinel";
    fs.writtenSentinel = () => written;
    return fs;
}

function makeFakeStderr() {
    const messages = [];
    return {
        write: (m) => { messages.push(String(m)); },
        messages,
    };
}

test("resolveRunsRoot: defaults to $HOME/.copilot/autopilot/events", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    assert.equal(
        resolveRunsRoot({ env: {}, fs, stderr, sentinelPath: "/fake/sentinel" }),
        join(homedir(), ".copilot", "autopilot", "events"),
    );
    assert.equal(stderr.messages.length, 0, "no notice when env is empty + neither default exists");
});

test("resolveRunsRoot: honours RALPH_EVENTS_DIR override (legacy, with notice)", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    assert.equal(
        resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "/tmp/ralph" }, fs, stderr, sentinelPath: "/fake/sentinel" }),
        "/tmp/ralph",
    );
    assert.equal(stderr.messages.length, 1, "legacy env override emits one notice");
    assert.match(stderr.messages[0], /RALPH_EVENTS_DIR is deprecated/);
});

test("resolveRunsRoot: ignores empty / whitespace override and falls back to default", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    const def = join(homedir(), ".copilot", "autopilot", "events");
    assert.equal(
        resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "" }, fs, stderr, sentinelPath: "/fake/sentinel" }),
        def,
    );
    assert.equal(
        resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "   " }, fs, stderr, sentinelPath: "/fake/sentinel" }),
        def,
    );
});

test("resolveRunsRoot: tolerates missing arg bag (env defaults to process.env)", () => {
    // Should not throw even when called with no args; falls back to
    // homedir-based default. Real fs/stderr are used; we only assert
    // the path shape since real env state is not under our control.
    assert.match(resolveRunsRoot(), /\.copilot[/\\](autopilot[/\\]events|ralph[/\\]runs)$/);
});

test("resolveRunsRoot: AUTOPILOT_EVENTS_DIR is preferred over RALPH_EVENTS_DIR", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    assert.equal(
        resolveRunsRoot({
            env: { AUTOPILOT_EVENTS_DIR: "/tmp/ap", RALPH_EVENTS_DIR: "/tmp/legacy" },
            fs, stderr, sentinelPath: "/fake/sentinel",
        }),
        "/tmp/ap",
    );
    assert.equal(stderr.messages.length, 0, "primary env wins, no notice");
});

test("resolveRunsRoot: AUTOPILOT_EVENTS_DIR alone emits no notice", () => {
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    assert.equal(
        resolveRunsRoot({
            env: { AUTOPILOT_EVENTS_DIR: "/tmp/ap" },
            fs, stderr, sentinelPath: "/fake/sentinel",
        }),
        "/tmp/ap",
    );
    assert.equal(stderr.messages.length, 0);
});

test("resolveRunsRoot: legacy default path is honoured with deprecation notice", () => {
    // When AUTOPILOT_EVENTS_DIR is unset and the legacy default
    // ~/.copilot/ralph/runs already exists on disk, fall back to it
    // (preserves user data) while emitting a one-shot deprecation
    // notice.
    const legacyDefault = join(homedir(), ".copilot", "ralph", "runs");
    const fs = makeFakeFs({ existingPaths: new Set([legacyDefault]) });
    const stderr = makeFakeStderr();
    assert.equal(
        resolveRunsRoot({ env: {}, fs, stderr, sentinelPath: "/fake/sentinel" }),
        legacyDefault,
    );
    assert.equal(stderr.messages.length, 1);
    assert.match(stderr.messages[0], /reading from legacy ~\/\.copilot\/ralph\/runs/);
});

test("resolveRunsRoot: when both default paths exist, primary wins (no notice)", () => {
    const apDefault = join(homedir(), ".copilot", "autopilot", "events");
    const legacyDefault = join(homedir(), ".copilot", "ralph", "runs");
    const fs = makeFakeFs({ existingPaths: new Set([apDefault, legacyDefault]) });
    const stderr = makeFakeStderr();
    assert.equal(
        resolveRunsRoot({ env: {}, fs, stderr, sentinelPath: "/fake/sentinel" }),
        apDefault,
    );
    assert.equal(stderr.messages.length, 0);
});

test("resolveRunsRoot: deprecation notice is one-shot per process (sentinel-gated)", () => {
    // After the first notice, the sentinel file records which key was
    // emitted; subsequent calls with the same trigger stay quiet.
    const fs = makeFakeFs();
    const stderr = makeFakeStderr();
    const sentinelPath = "/fake/sentinel";
    resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "/x" }, fs, stderr, sentinelPath });
    resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "/x" }, fs, stderr, sentinelPath });
    resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "/x" }, fs, stderr, sentinelPath });
    assert.equal(stderr.messages.length, 1, "only the first call writes a notice");
    assert.match(fs.writtenSentinel(), /RALPH_EVENTS_DIR/);
});

test("resolveRunsRoot: pre-existing sentinel suppresses the notice", () => {
    const fs = makeFakeFs({ sentinel: "env:RALPH_EVENTS_DIR\n" });
    const stderr = makeFakeStderr();
    assert.equal(
        resolveRunsRoot({
            env: { RALPH_EVENTS_DIR: "/tmp/x" },
            fs, stderr, sentinelPath: "/fake/sentinel",
        }),
        "/tmp/x",
    );
    assert.equal(stderr.messages.length, 0, "sentinel already records this key");
});

test("makeRunId: composes ${label}-${startedAt}", () => {
    assert.equal(makeRunId("ap_loop", 1700000000000), "ap_loop-1700000000000");
});

test("makeRunId: sanitises label by replacing every non-[A-Za-z0-9_-] with _", () => {
    assert.equal(makeRunId("self/improve!", 42), "self_improve_-42");
    assert.equal(makeRunId("a b c", 1), "a_b_c-1");
});

test("makeRunId: falls back to 'ap_loop' when label is empty / null / undefined", () => {
    assert.equal(makeRunId("", 1), "ap_loop-1");
    assert.equal(makeRunId(null, 1), "ap_loop-1");
    assert.equal(makeRunId(undefined, 1), "ap_loop-1");
});

test("makeRunId: substitutes Date.now() when startedAt is non-finite", () => {
    // Lenient by design: the file-level contract is "swallow every
    // error so the loop keeps running". A literal `${label}-undefined`
    // would collide on every subsequent call with a missing startedAt,
    // silently overwriting the per-run directory. Substituting
    // Date.now() preserves the unique, sortable id property even
    // under degraded input.
    const before = Date.now();
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, "1700000000000", {}]) {
        const id = makeRunId("ap_loop", bad);
        const m = /^ap_loop-(\d+)$/.exec(id);
        assert.ok(m, `expected fallback runId, got ${id} (input: ${String(bad)})`);
        const ts = Number(m[1]);
        assert.ok(ts >= before, `fallback ts must be >= now() snapshot (got ${ts}, before ${before})`);
    }
    // Finite numeric startedAt is preserved verbatim.
    assert.equal(makeRunId("ap_loop", 0), "ap_loop-0");
    assert.equal(makeRunId("ap_loop", 1700000000000), "ap_loop-1700000000000");
});

test("createEventEmitter: write appends one JSONL line per call", () => {
    const lines = [];
    const fakeFs = {
        mkdirSync: () => {},
        appendFileSync: (path, line) => lines.push({ path, line }),
    };
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1234,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: fakeFs,
    });
    e.write({ type: "iteration_start", runId: e.runId, ts: 1, iteration: 1 });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].path, "/tmp/r/ap_loop-1234/events.jsonl");
    assert.equal(JSON.parse(lines[0].line.trimEnd()).type, "iteration_start");
});

test("createEventEmitter: armed event also writes a line to the run index", () => {
    const lines = [];
    const fakeFs = {
        mkdirSync: () => {},
        appendFileSync: (path, line) => lines.push({ path, line }),
    };
    const e = createEventEmitter({
        label: "self_improve",
        startedAt: 99,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: fakeFs,
    });
    e.write({ type: "armed", runId: e.runId, ts: 0, maxIterations: 100, minIterations: 5 });
    assert.equal(lines.length, 2, "armed must produce one events.jsonl line + one index.jsonl line");
    const eventsLine = lines.find((l) => l.path.endsWith("events.jsonl"));
    const indexLine = lines.find((l) => l.path === "/tmp/r/index.jsonl");
    assert.ok(eventsLine, "events.jsonl write is missing");
    assert.ok(indexLine, "index.jsonl write is missing");
    const idx = JSON.parse(indexLine.line.trimEnd());
    // The TUI's readRunIndex filters for `type === "armed"`. If this
    // line ever stops being emitted, `ralph-tui list` and
    // `ralph-tui stats` silently skip every extension-recorded run.
    assert.equal(idx.type, "armed", "index entry must carry type=armed so the TUI consumer accepts it");
    assert.equal(idx.runId, "self_improve-99");
    assert.equal(idx.label, "self_improve");
    assert.equal(idx.startedAt, 99);
    assert.equal(idx.maxIterations, 100);
    assert.equal(idx.minIterations, 5);
});

test("createEventEmitter: index entry round-trips through TUI's readRunIndex", async () => {
    // Cross-component reliability: the extension's emitter writes
    // index.jsonl entries that the TUI's `readRunIndex` consumer must
    // accept. Historically the emitter omitted `type: "armed"` from
    // the index entry, but readRunIndex filters for that exact field —
    // so `ralph-tui list` and `ralph-tui stats` silently skipped every
    // run recorded by the extension. Pin the contract here by writing
    // a real run dir to a tmp $RALPH_EVENTS_DIR via the emitter, then
    // round-tripping it through the TUI's reader.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { readRunIndex } = await import("../packages/tui/src/writer.mjs");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-emit-rt-"));
    try {
        const e = createEventEmitter({
            label: "ap_loop",
            startedAt: 12345,
            env: { RALPH_EVENTS_DIR: root },
        });
        e.write({ type: "armed", runId: e.runId, ts: 0, maxIterations: 7, minIterations: 1 });
        const entries = readRunIndex({ env: { RALPH_EVENTS_DIR: root } });
        assert.equal(entries.length, 1, "TUI's readRunIndex must surface the extension-emitted run");
        assert.equal(entries[0].runId, "ap_loop-12345");
        assert.equal(entries[0].label, "ap_loop");
        assert.equal(entries[0].type, "armed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("createEventEmitter: non-armed events do NOT touch the index", () => {
    const lines = [];
    const fakeFs = {
        mkdirSync: () => {},
        appendFileSync: (path, line) => lines.push({ path, line }),
    };
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: fakeFs,
    });
    e.write({ type: "iteration_end", runId: e.runId, ts: 1, iteration: 1 });
    e.write({ type: "complete", runId: e.runId, ts: 2, reason: "completion_promise", iteration: 1 });
    assert.ok(lines.every((l) => !l.path.endsWith("index.jsonl")));
});

test("createEventEmitter: ignores non-object / falsy events instead of writing junk", () => {
    const lines = [];
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: { mkdirSync: () => {}, appendFileSync: (p, l) => lines.push({ p, l }) },
    });
    e.write(null);
    e.write(undefined);
    e.write("string");
    e.write(42);
    assert.equal(lines.length, 0);
});

test("createEventEmitter: long excerpt is clipped to <= 500 chars + trailing ellipsis", () => {
    const captured = [];
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: {
            mkdirSync: () => {},
            appendFileSync: (_, line) => captured.push(line),
        },
    });
    const longExcerpt = "x".repeat(2000);
    e.write({ type: "iteration_end", runId: "r", ts: 1, iteration: 1, excerpt: longExcerpt });
    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0].trimEnd());
    assert.ok(parsed.excerpt.length <= 500);
    assert.ok(parsed.excerpt.endsWith("…"));
});

test("createEventEmitter: write swallows mkdir + append errors so the loop never crashes", () => {
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: {
            mkdirSync: () => { throw new Error("EROFS"); },
            appendFileSync: () => { throw new Error("ENOSPC"); },
        },
    });
    // Must not throw.
    e.write({ type: "armed", runId: "r", ts: 0, maxIterations: 1, minIterations: 1 });
    e.write({ type: "iteration_start", runId: "r", ts: 1, iteration: 1 });
});

test("createEventEmitter: mkdir is called once across many writes (memoised)", () => {
    let mkdirCalls = 0;
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: {
            mkdirSync: () => { mkdirCalls += 1; },
            appendFileSync: () => {},
        },
    });
    for (let i = 0; i < 5; i += 1) {
        e.write({ type: "iteration_start", runId: "r", ts: i, iteration: i });
    }
    assert.equal(mkdirCalls, 1);
});

test("createEventEmitter: close() is a no-op safe to call repeatedly", () => {
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: { mkdirSync: () => {}, appendFileSync: () => {} },
    });
    assert.doesNotThrow(() => { e.close(); e.close(); });
});

test("createEventEmitter: oversize event line is dropped after stripping excerpt+note (best-effort)", () => {
    const captured = [];
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: {
            mkdirSync: () => {},
            appendFileSync: (_, line) => captured.push(line),
        },
    });
    // 32KB junk in a non-clipped field — exceeds the 16KB hard cap and
    // can't be salvaged by stripping excerpt/note. Must not throw and
    // must not write a partial line.
    const huge = "y".repeat(32 * 1024);
    e.write({ type: "iteration_end", runId: "r", ts: 1, iteration: 1, payload: huge });
    assert.equal(captured.length, 0);
});

test("createEventEmitter: BigInt / circular ref events are dropped, not thrown", () => {
    // The file-level contract is "swallow every error so the loop keeps
    // running" (see extension/events-emit.mjs lines 6-8). Before this
    // guard, a single event containing a BigInt or a circular ref would
    // throw out of `JSON.stringify` inside `serialize()`, propagate
    // through `write()`, and crash the entire loop. Now both cases
    // drop the bad event silently and leave the disk untouched.
    const captured = [];
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: {
            mkdirSync: () => {},
            appendFileSync: (_, line) => captured.push(line),
        },
    });
    // BigInt is not JSON-serialisable.
    assert.doesNotThrow(() => {
        e.write({ type: "iteration_end", runId: "r", ts: 1, badField: 1n });
    });
    // Circular reference in note-like payload.
    const cyc = { type: "iteration_end", runId: "r", ts: 1 };
    cyc.self = cyc;
    assert.doesNotThrow(() => { e.write(cyc); });
    assert.equal(captured.length, 0, "no malformed event should reach the disk");

    // Sanity: a well-formed event still writes after a poisoned one.
    e.write({ type: "iteration_end", runId: "r", ts: 2, iteration: 1 });
    assert.equal(captured.length, 1);
});

// Iter 105 — RALPH_EVENTS_DIR routinely picks up stray surrounding
// whitespace from shell heredocs, Makefile interpolation, copy-paste,
// etc. Without trimming, the override path was returned verbatim, so
// `RALPH_EVENTS_DIR=" /tmp/runs "` created `runs` directories whose
// name literally contained leading + trailing spaces and broke the
// matching `ralph-tui list` glob. Pin that the override is trimmed at
// resolve time so a future regression cannot reintroduce that
// papercut.
test("resolveRunsRoot: trims surrounding whitespace from RALPH_EVENTS_DIR override", () => {
    const sentinelPath = "/fake/sentinel";
    const mk = () => ({ fs: makeFakeFs(), stderr: makeFakeStderr() });
    let { fs, stderr } = mk();
    assert.equal(resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "  /tmp/ralph-runs  " }, fs, stderr, sentinelPath }), "/tmp/ralph-runs");
    ({ fs, stderr } = mk());
    assert.equal(resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "/tmp/ralph-runs\n" }, fs, stderr, sentinelPath }), "/tmp/ralph-runs");
    ({ fs, stderr } = mk());
    assert.equal(resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "\t/tmp/ralph-runs" }, fs, stderr, sentinelPath }), "/tmp/ralph-runs");
    // Internal whitespace (paths with literal spaces, like macOS volumes)
    // is preserved — only the SURROUNDING whitespace is stripped.
    ({ fs, stderr } = mk());
    assert.equal(resolveRunsRoot({ env: { RALPH_EVENTS_DIR: "  /Volumes/My Drive/runs  " }, fs, stderr, sentinelPath }), "/Volumes/My Drive/runs");
});

// Iter 115 — clipExcerpt's slice boundary must not split a UTF-16
// surrogate pair. A naïve `s.slice(0, MAX_EXCERPT_CHARS - 1)` lands
// inside a 4-byte char (emoji / astral plane symbol) when the
// boundary falls between the high+low surrogate halves and emits a
// lone high surrogate — technically valid UTF-16 but renders as a
// replacement character in most terminals AND breaks any consumer
// doing strict UTF-8 validation downstream (e.g. a Python tail of
// events.jsonl with errors='strict'). The fix backs off one code
// unit when the last kept char is a high surrogate, dropping the
// single astral char rather than emitting a lone half. Pin the
// behaviour so a future "simplify clipExcerpt" PR can't regress it.
test("createEventEmitter: clipExcerpt does not produce lone high surrogates at the truncation boundary", () => {
    const captured = [];
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: {
            mkdirSync: () => {},
            appendFileSync: (_, line) => captured.push(line),
        },
    });
    // Build an excerpt where the surrogate-pair half lands EXACTLY at
    // the truncation boundary. clipExcerpt cuts at MAX_EXCERPT_CHARS-1
    // (=499) when length > 500. Place "💀" (U+1F480, two code units —
    // 0xD83D + 0xDC80) at indices 498..499 so a naïve slice keeps the
    // high surrogate at 498 and drops the low surrogate at 499.
    const skull = String.fromCharCode(0xD83D, 0xDC80);
    const excerpt = "x".repeat(498) + skull + skull.repeat(20);
    assert.ok(excerpt.length > 500, "test setup: excerpt must trip clipExcerpt's truncation");
    assert.equal(excerpt.charCodeAt(498), 0xD83D, "test setup: index 498 must be the high surrogate");
    assert.equal(excerpt.charCodeAt(499), 0xDC80, "test setup: index 499 must be the low surrogate");
    e.write({ type: "iteration_end", runId: "r", ts: 1, iteration: 1, excerpt });
    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0].trimEnd());
    // The clipped excerpt must NOT end on a lone high surrogate. Walk
    // every code unit of `parsed.excerpt`: every high surrogate must
    // be immediately followed by a low surrogate. The trailing "…" is
    // a BMP char so the check naturally terminates without false
    // positives at the end.
    for (let i = 0; i < parsed.excerpt.length; i++) {
        const c = parsed.excerpt.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            const next = parsed.excerpt.charCodeAt(i + 1);
            assert.ok(
                next >= 0xDC00 && next <= 0xDFFF,
                `lone high surrogate at index ${i} (next code unit: 0x${(next || 0).toString(16)}) — clipExcerpt split a surrogate pair. Excerpt tail: ${JSON.stringify(parsed.excerpt.slice(-10))}`,
            );
            i += 1; // skip the matched low surrogate
        } else {
            assert.ok(
                !(c >= 0xDC00 && c <= 0xDFFF),
                `unmatched low surrogate at index ${i} — clipExcerpt produced an invalid UTF-16 string`,
            );
        }
    }
    // Length stays ≤ MAX_EXCERPT_CHARS (500); the existing length test
    // is reinforced — backing off one code unit cannot grow the result.
    assert.ok(parsed.excerpt.length <= 500, `clipped excerpt length must stay ≤ 500 (got ${parsed.excerpt.length})`);
    assert.ok(parsed.excerpt.endsWith("…"), "clipped excerpt must still end with the ellipsis sentinel");
});

// Iter 122 — drift guard: events-emit.mjs's MAX_EXCERPT_CHARS (500)
// MUST equal the literal cap the TUI side passes to its surrogate-
// safe slicer in `packages/tui/src/events.mjs`'s `serializeEvent`.
// Both sides describe the same JSONL line consumed by both — a
// drift would break the contract: emitter writes longer than reader
// expects -> reader re-clips data the emitter believed was final
// (and the surrogate-safe behavior on the emitter side is silently
// undone), or oversize-line guards fire on one side but not the
// other. The two values are intentionally inlined (zero-dep policy
// keeps `events-emit.mjs` from importing TUI internals; TUI doesn't
// import from `extension/`), so the only protection is this test.
test("events-emit MAX_EXCERPT_CHARS lockstep: TUI serializeEvent caps excerpt+note at the same value", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..");
    const emit = readFileSync(join(repoRoot, "extension/events-emit.mjs"), "utf8");
    const tui = readFileSync(join(repoRoot, "packages/tui/src/events.mjs"), "utf8");

    // Emitter side: pin the named constant.
    const emitMatch = emit.match(/const MAX_EXCERPT_CHARS = (\d+);/);
    assert.ok(emitMatch, "events-emit.mjs must declare `const MAX_EXCERPT_CHARS = <N>;`");
    const emitCap = Number(emitMatch[1]);
    assert.equal(emitCap, 500, "MAX_EXCERPT_CHARS is the contract value; bump on BOTH sides if you change it");

    // TUI side: pin the excerpt + note caps specifically. The
    // contract this guard protects is "user-supplied prose fields
    // (excerpt, note, reason) cap at the same value as the emitter
    // ceiling so a 500-char excerpt makes it through the writer
    // intact". Other size-bounded fields (stageName, verb, outcome,
    // argsSummary) have their own legitimately smaller caps because
    // they're machine-generated identifiers / one-line summaries —
    // they don't need 500 chars and capping them tighter keeps the
    // event-line shape clean. Iter 48-issue: scope the guard so a
    // future field's tighter cap doesn't trip the lockstep check.
    const matchCap = (field) => {
        const m = tui.match(new RegExp(String.raw`safeSliceChars\(\s*ev\.${field}\b[^,]*,\s*(\d+)\s*\)`));
        assert.ok(m, `serializeEvent must call safeSliceChars(ev.${field}, <N>)`);
        return Number(m[1]);
    };
    const excerptCap = matchCap("excerpt");
    const noteCap = matchCap("note");
    const reasonCap = matchCap("reason");
    for (const [name, cap] of [["excerpt", excerptCap], ["note", noteCap], ["reason", reasonCap]]) {
        assert.equal(
            cap,
            emitCap,
            `TUI safeSliceChars(ev.${name}, ${cap}) differs from events-emit MAX_EXCERPT_CHARS ${emitCap}; ` +
            "bump BOTH sides in lockstep — see the comment block above MAX_EXCERPT_CHARS in events-emit.mjs.",
        );
    }
});

test("createEventEmitter: serialize salvages an oversize event by stripping excerpt+note (second-pass under 16KB cap)", () => {
    // Iter 164 — `serialize()` in extension/events-emit.mjs implements
    // a two-pass strategy when the JSON line exceeds the 16KB hard cap:
    //   1. First try with all fields — if under cap, write as-is.
    //   2. If over cap, delete excerpt + note (the only fields the
    //      module clips upstream) and re-serialize. If now under cap,
    //      ship the slimmed-down event. Otherwise drop.
    // Pre-iter-164 this salvage branch was tested only in the
    // unsalvageable direction (32KB junk in a non-clip field — drops).
    // The salvageable direction was unguarded: a future "simplify"
    // refactor that collapsed the two passes into a single drop-on-
    // overflow would silently start losing every legitimate event
    // whose excerpt + payload combined to exceed 16KB. This pins
    // the contract: at-cap → ship, over-cap-but-salvageable →
    // re-emit without excerpt/note, over-cap-anyway → drop.
    //
    // To trigger the salvage branch we need (a) clip-eligible fields
    // (excerpt + note) populated near their 500-char post-clip cap so
    // the JSON has visible weight from them, AND (b) a non-clipped
    // field large enough that its presence + excerpt + note exceeds
    // 16KB but its presence alone fits. excerpt+note clip to ~500
    // chars each, so they together are at most ~1KB. Pad a non-clip
    // field to ~15.7KB so first pass is ~16.7KB (over), second pass
    // (after stripping excerpt+note) is ~15.7KB (under).
    const captured = [];
    const e = createEventEmitter({
        label: "ap_loop",
        startedAt: 1,
        env: { RALPH_EVENTS_DIR: "/tmp/r" },
        fs: {
            mkdirSync: () => {},
            appendFileSync: (_, line) => captured.push(line),
        },
    });
    const excerpt = "E".repeat(500);
    const note = "N".repeat(500);
    const payload = "P".repeat(15700); // not clipped by this module
    e.write({
        type: "iteration_end",
        runId: "r",
        ts: 1,
        iteration: 1,
        excerpt,
        note,
        payload,
    });
    assert.equal(captured.length, 1, "salvage path should ship exactly one line");
    const line = captured[0];
    assert.ok(
        Buffer.byteLength(line, "utf8") <= 16 * 1024 + 1, // +1 for trailing newline added by write()
        "salvaged line must respect the 16KB byte cap",
    );
    const parsed = JSON.parse(line.trim());
    assert.equal(parsed.type, "iteration_end", "type field is preserved through salvage");
    assert.equal(parsed.runId, "r", "runId is preserved through salvage");
    assert.equal(parsed.iteration, 1, "iteration counter is preserved through salvage");
    assert.equal(typeof parsed.payload, "string", "non-clip-eligible fields survive salvage");
    assert.equal(parsed.payload.length, 15700, "payload field is shipped intact");
    assert.equal(parsed.excerpt, undefined, "excerpt is stripped during salvage");
    assert.equal(parsed.note, undefined, "note is stripped during salvage");
});
