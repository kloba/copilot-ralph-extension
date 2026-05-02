import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEventsFile, splitAndParse, tailEventsFile } from "../src/tail.mjs";
import { serializeEvent } from "../src/events.mjs";

function tmp() {
    return mkdtempSync(join(tmpdir(), "ralph-tail-"));
}

function evLine(ev) {
    return serializeEvent(ev) + "\n";
}

test("readEventsFile: missing file returns []", () => {
    assert.deepEqual(readEventsFile(join(tmp(), "nope.jsonl")), []);
});

test("readEventsFile: parses well-formed JSONL and skips garbage", () => {
    const dir = tmp();
    const p = join(dir, "events.jsonl");
    writeFileSync(p, [
        evLine({ type: "armed", ts: 1, runId: "r-1", maxIterations: 5, minIterations: 1 }),
        "not json\n",
        "{\"partial\":true}\n",
        evLine({ type: "iteration_start", ts: 2, runId: "r-1", iteration: 1 }),
    ].join(""));
    const out = readEventsFile(p);
    assert.equal(out.length, 2);
    assert.equal(out[0].type, "armed");
    assert.equal(out[1].type, "iteration_start");
    rmSync(dir, { recursive: true, force: true });
});

test("splitAndParse: empty input returns []", () => {
    assert.deepEqual(splitAndParse(""), []);
    assert.deepEqual(splitAndParse("   \n   \n"), []);
});

test("splitAndParse: tolerates trailing partial line (no newline)", () => {
    const dir = tmp();
    const p = join(dir, "events.jsonl");
    writeFileSync(p,
        evLine({ type: "armed", ts: 1, runId: "r-1" }) + "{\"partial\":\"yep\"",
    );
    const out = readEventsFile(p);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "armed");
    rmSync(dir, { recursive: true, force: true });
});

test("tailEventsFile: yields events as they're appended and stops on complete", async () => {
    const dir = tmp();
    const p = join(dir, "events.jsonl");
    writeFileSync(p, evLine({ type: "armed", ts: 1, runId: "r-1", maxIterations: 3, minIterations: 1 }));

    const writerInterval = setInterval(() => {
        try {
            appendFileSync(p, evLine({ type: "iteration_start", ts: 2, runId: "r-1", iteration: 1 }));
            appendFileSync(p, evLine({ type: "iteration_end", ts: 3, runId: "r-1", iteration: 1, excerpt: "hi" }));
            appendFileSync(p, evLine({ type: "complete", ts: 4, runId: "r-1", reason: "completion_promise", iteration: 1 }));
            clearInterval(writerInterval);
        } catch { /* ignore */ }
    }, 30);

    const collected = [];
    for await (const ev of tailEventsFile(p, { pollMs: 20 })) {
        collected.push(ev.type);
        if (collected.length >= 4) break;
    }
    clearInterval(writerInterval);
    assert.deepEqual(collected, ["armed", "iteration_start", "iteration_end", "complete"]);
    rmSync(dir, { recursive: true, force: true });
});

test("tailEventsFile: detects file replacement (unlink + new file) and restarts offset", async () => {
    const dir = tmp();
    const p = join(dir, "events.jsonl");
    writeFileSync(p, evLine({ type: "armed", ts: 1, runId: "r-1" }));
    const seen = [];
    const it = tailEventsFile(p, { pollMs: 15 })[Symbol.asyncIterator]();
    const first = await it.next();
    seen.push(first.value.type);
    // Replace the file via unlink+create so the new inode triggers the
    // tail's restart-from-zero path. Plain truncate+rewrite shares an
    // inode and is intentionally not detected — events.jsonl is
    // append-only in production.
    rmSync(p);
    writeFileSync(p, evLine({ type: "armed", ts: 2, runId: "r-2" })
        + evLine({ type: "complete", ts: 3, runId: "r-2", reason: "completion_promise", iteration: 0 }));
    while (true) {
        const n = await it.next();
        if (n.done) break;
        seen.push(n.value.type);
        if (n.value.type === "complete") break;
    }
    assert.deepEqual(seen, ["armed", "armed", "complete"]);
    rmSync(dir, { recursive: true, force: true });
});

test("tailEventsFile: detects file replacement when inode is reused (same ino, fresh birthtime)", async () => {
    // Regression: on Linux ext4 the freed inode of a just-unlinked file
    // is often reused for the very next file in the directory. If the
    // new file's first line happens to match the old file's byte length
    // (~38 bytes for a minimal armed event), an ino-only check skips
    // every byte already past `offset` and we miss the new file's first
    // event. Tracking birthtimeMs alongside ino catches this case
    // because a reallocated inode gets a fresh btime even when the
    // number repeats.
    const fileA = "armed-a\n";   // 8 bytes
    const fileB = "armed-b\n" + "complete\n"; // 17 bytes; first 8 are different
    let stage = 0;
    const ino = 42;
    const fakeFs = {
        statSync(_p) {
            if (stage === 0) return { ino, size: fileA.length, birthtimeMs: 1000 };
            return { ino, size: fileB.length, birthtimeMs: 2000 };
        },
        openSync(_p, _flags) { return 1; },
        closeSync(_fd) {},
        readSync(_fd, buf, _bufOffset, length, fileOffset) {
            const src = stage === 0 ? fileA : fileB;
            const slice = Buffer.from(src.slice(fileOffset, fileOffset + length));
            slice.copy(buf);
            return slice.length;
        },
    };
    const parsed = [];
    let yieldsBeforeRotate = 1;
    // Inject a mock parser via a wrapper: reuse the real parseEventLine
    // by importing tail with our fakeFs. Since events have to satisfy
    // the strict schema for parseEventLine, build a minimal real JSONL
    // payload instead.
    const realA = JSON.stringify({ type: "armed", ts: 1, runId: "r-old" }) + "\n";
    const realB = JSON.stringify({ type: "armed", ts: 2, runId: "r-new" }) + "\n"
        + JSON.stringify({ type: "complete", ts: 3, runId: "r-new", reason: "completion_promise", iteration: 0 }) + "\n";
    // Sanity: first line of realA and realB must share length so this
    // test exercises the inode-reuse blind spot in the old code.
    const lenA = realA.length;
    const lenBfirst = realB.split("\n")[0].length + 1;
    assert.ok(lenA === lenBfirst, `lengths must match (${lenA} vs ${lenBfirst}) for regression to bite`);
    const fakeFs2 = {
        statSync(_p) {
            return stage === 0
                ? { ino, size: realA.length, birthtimeMs: 1000 }
                : { ino, size: realB.length, birthtimeMs: 2000 };
        },
        openSync(_p) { return 1; },
        closeSync(_fd) {},
        readSync(_fd, buf, _o, length, fileOffset) {
            const src = stage === 0 ? realA : realB;
            const slice = Buffer.from(src.slice(fileOffset, fileOffset + length));
            slice.copy(buf);
            return slice.length;
        },
    };
    const it = tailEventsFile("/fake", { fs: fakeFs2, pollMs: 1 })[Symbol.asyncIterator]();
    const first = await it.next();
    parsed.push(first.value.type);
    stage = 1; // simulate file replacement with reused inode
    while (parsed.length < 3) {
        const n = await it.next();
        if (n.done) break;
        parsed.push(n.value.type);
    }
    assert.deepEqual(parsed, ["armed", "armed", "complete"]);
    void yieldsBeforeRotate; // silence unused
});

test("tailEventsFile: ENOENT until file appears, then catches up", async () => {
    const dir = tmp();
    const p = join(dir, "events.jsonl");
    setTimeout(() => {
        writeFileSync(p, evLine({ type: "armed", ts: 1, runId: "r-1" })
            + evLine({ type: "complete", ts: 2, runId: "r-1", reason: "completion_promise" }));
    }, 50);
    const types = [];
    for await (const ev of tailEventsFile(p, { pollMs: 15 })) {
        types.push(ev.type);
        if (ev.type === "complete") break;
    }
    assert.deepEqual(types, ["armed", "complete"]);
    rmSync(dir, { recursive: true, force: true });
});

// Iter 141 — pin under-covered input-validation contracts so a future
// "simplify the tail surface" PR can't silently drop the typeof guards
// without tripping a test. The risk model: callers higher up (replay
// command, plain-mode renderer, watch loop) reach these helpers with
// values derived from CLI args and filesystem state, so the contracts
// are real defensive walls — not theoretical guards.

test("readEventsFile: non-string filePath throws TypeError (input-validation contract)", () => {
    assert.throws(() => readEventsFile(undefined), { name: "TypeError" });
    assert.throws(() => readEventsFile(null), { name: "TypeError" });
    assert.throws(() => readEventsFile(42), { name: "TypeError" });
    assert.throws(() => readEventsFile({}), { name: "TypeError" });
    assert.throws(() => readEventsFile([]), { name: "TypeError" });
});

test("readEventsFile: empty-string filePath throws TypeError (rejects falsy strings explicitly)", () => {
    // The literal regression to guard: a future refactor could replace
    // `typeof filePath !== "string" || !filePath` with just the typeof
    // check, which would let "" fall through to fs.readFileSync("", …)
    // and emit a confusing "ENOENT: '' is not a directory" error
    // depending on Node version. Pin the explicit empty-string reject.
    assert.throws(() => readEventsFile(""), { name: "TypeError" });
});

test("readEventsFile: non-ENOENT fs errors propagate unchanged (no swallowing)", () => {
    // Only ENOENT is treated as "run hasn't started yet" → []. Every
    // other fs error (EACCES, EISDIR, EMFILE, …) must propagate so
    // operators see the real failure instead of an empty event list
    // that silently looks like a fresh / never-started run.
    const fakeFs = {
        readFileSync() {
            const err = new Error("permission denied");
            err.code = "EACCES";
            throw err;
        },
    };
    assert.throws(
        () => readEventsFile("/some/path/events.jsonl", { fs: fakeFs }),
        (err) => err.code === "EACCES" && /permission denied/.test(err.message),
    );
});

test("readEventsFile: ENOENT specifically returns [] (not the same as the catch-all branch)", () => {
    // Counterpart to the EACCES test above — pin that ENOENT does NOT
    // propagate, so a swap of the `if (err.code === "ENOENT")` to
    // anything stricter (e.g. accidentally checking err.errno -2 on a
    // platform where errno differs) would surface as a regression
    // here.
    const fakeFs = {
        readFileSync() {
            const err = new Error("no such file");
            err.code = "ENOENT";
            throw err;
        },
    };
    assert.deepEqual(readEventsFile("/missing/events.jsonl", { fs: fakeFs }), []);
});

test("splitAndParse: non-string input returns [] (defensive contract)", () => {
    // splitAndParse is called from plain.mjs's stream renderer with
    // values pulled out of fs.readFileSync — but tests + replay code
    // also reach it directly. Pin the non-string fast-path so a future
    // refactor that "trusts the caller" would trip a test.
    assert.deepEqual(splitAndParse(undefined), []);
    assert.deepEqual(splitAndParse(null), []);
    assert.deepEqual(splitAndParse(42), []);
    assert.deepEqual(splitAndParse({}), []);
    assert.deepEqual(splitAndParse([]), []);
    assert.deepEqual(splitAndParse(true), []);
});

// ---------------------------------------------------------------------------
// Issue #57 — generic tailJsonlFile + tailSessionFile.
// The events tailer above is now a thin wrapper around tailJsonlFile;
// these tests pin the behaviour the new live-output panel relies on:
//   - permissive JSON.parse so an upstream schema change lands without
//     us silently dropping the line,
//   - no terminal predicate so the iterator runs forever (until signal),
//   - same rotation / truncation / ENOENT semantics as tailEventsFile.
// ---------------------------------------------------------------------------

import { tailJsonlFile, tailSessionFile } from "../src/tail.mjs";

test("tailJsonlFile: yields raw JSON objects without event-type validation", async () => {
    const dir = tmp();
    const p = join(dir, "session.jsonl");
    // Lines deliberately use a `kind`-style schema the events parser
    // would reject — proves we're not running them through parseEventLine.
    writeFileSync(p,
        JSON.stringify({ kind: "assistant.message", text: "hello" }) + "\n"
        + JSON.stringify({ kind: "tool.execution_start", toolName: "bash" }) + "\n",
    );
    const ac = new AbortController();
    const collected = [];
    for await (const ev of tailJsonlFile(p, { pollMs: 10, signal: ac.signal })) {
        collected.push(ev);
        if (collected.length >= 2) {
            ac.abort();
            break;
        }
    }
    assert.deepEqual(collected, [
        { kind: "assistant.message", text: "hello" },
        { kind: "tool.execution_start", toolName: "bash" },
    ]);
    rmSync(dir, { recursive: true, force: true });
});

test("tailJsonlFile: drops malformed JSON lines silently (tolerance contract)", async () => {
    const dir = tmp();
    const p = join(dir, "session.jsonl");
    writeFileSync(p,
        '{"kind":"ok"}\n'
        + 'this is not JSON\n'
        + '{"kind":"also-ok"}\n',
    );
    const ac = new AbortController();
    const collected = [];
    for await (const ev of tailJsonlFile(p, { pollMs: 10, signal: ac.signal })) {
        collected.push(ev.kind);
        if (collected.length >= 2) {
            ac.abort();
            break;
        }
    }
    assert.deepEqual(collected, ["ok", "also-ok"]);
    rmSync(dir, { recursive: true, force: true });
});

test("tailJsonlFile: caller-supplied isTerminal stops the iterator", async () => {
    const dir = tmp();
    const p = join(dir, "session.jsonl");
    writeFileSync(p,
        '{"kind":"a"}\n'
        + '{"kind":"end"}\n'
        + '{"kind":"never-reached"}\n',
    );
    const collected = [];
    for await (const ev of tailJsonlFile(p, {
        pollMs: 10,
        isTerminal: (ev) => ev.kind === "end",
    })) {
        collected.push(ev.kind);
    }
    // `end` is included (terminal predicate fires AFTER yield) but
    // `never-reached` is not.
    assert.deepEqual(collected, ["a", "end"]);
    rmSync(dir, { recursive: true, force: true });
});

test("tailJsonlFile: parseLine returning null drops the line", async () => {
    const dir = tmp();
    const p = join(dir, "any.jsonl");
    writeFileSync(p, "keep me\nDROP\nkeep me too\n");
    const ac = new AbortController();
    const collected = [];
    for await (const ev of tailJsonlFile(p, {
        pollMs: 10,
        signal: ac.signal,
        parseLine: (line) => (line === "DROP" ? null : { line }),
    })) {
        collected.push(ev.line);
        if (collected.length >= 2) {
            ac.abort();
            break;
        }
    }
    assert.deepEqual(collected, ["keep me", "keep me too"]);
    rmSync(dir, { recursive: true, force: true });
});

test("tailSessionFile: tails Copilot CLI session log without event-type filtering", async () => {
    const dir = tmp();
    const p = join(dir, "session.jsonl");
    // Realistic session log shape — the Copilot CLI uses dot.namespaced
    // `type` strings that our events parser doesn't recognise.
    writeFileSync(p,
        JSON.stringify({ type: "user.message", data: { content: "go" } }) + "\n"
        + JSON.stringify({ type: "assistant.message", data: { content: "ok" } }) + "\n"
        + JSON.stringify({ type: "tool.execution_start", data: { toolName: "view" } }) + "\n",
    );
    const ac = new AbortController();
    const collected = [];
    for await (const ev of tailSessionFile(p, { pollMs: 10, signal: ac.signal })) {
        collected.push(ev.type);
        if (collected.length >= 3) {
            ac.abort();
            break;
        }
    }
    assert.deepEqual(collected, [
        "user.message",
        "assistant.message",
        "tool.execution_start",
    ]);
    rmSync(dir, { recursive: true, force: true });
});

test("tailSessionFile: never auto-stops on `complete` / `abort` (no terminal predicate)", async () => {
    // The Copilot CLI session log has its own lifecycle — the words
    // `complete` and `abort` are not terminal markers there. The tail
    // must keep streaming until the consumer aborts.
    const dir = tmp();
    const p = join(dir, "session.jsonl");
    writeFileSync(p,
        JSON.stringify({ type: "complete", data: { stage: "draft" } }) + "\n"
        + JSON.stringify({ type: "assistant.message", data: { content: "post-complete still flows" } }) + "\n",
    );
    const ac = new AbortController();
    const collected = [];
    for await (const ev of tailSessionFile(p, { pollMs: 10, signal: ac.signal })) {
        collected.push(ev.type);
        if (collected.length >= 2) {
            ac.abort();
            break;
        }
    }
    assert.deepEqual(collected, ["complete", "assistant.message"]);
    rmSync(dir, { recursive: true, force: true });
});

test("tailSessionFile: ENOENT polls until the session log appears", async () => {
    const dir = tmp();
    const p = join(dir, "session.jsonl");
    // Create the file 50ms in the future to exercise the poll path.
    setTimeout(() => {
        try {
            writeFileSync(p,
                JSON.stringify({ type: "assistant.message", data: { content: "delayed" } }) + "\n",
            );
        } catch { /* ignore */ }
    }, 50);
    const ac = new AbortController();
    const collected = [];
    for await (const ev of tailSessionFile(p, { pollMs: 10, signal: ac.signal })) {
        collected.push(ev.type);
        ac.abort();
        break;
    }
    assert.deepEqual(collected, ["assistant.message"]);
    rmSync(dir, { recursive: true, force: true });
});

test("tailJsonlFile: rejects non-string filePath (input-validation contract)", () => {
    assert.throws(() => tailJsonlFile(null), TypeError);
    assert.throws(() => tailJsonlFile(""), TypeError);
    assert.throws(() => tailJsonlFile(42), TypeError);
});

test("tailSessionFile: rejects non-string filePath (input-validation contract)", () => {
    assert.throws(() => tailSessionFile(null), TypeError);
    assert.throws(() => tailSessionFile(""), TypeError);
    assert.throws(() => tailSessionFile(42), TypeError);
});
