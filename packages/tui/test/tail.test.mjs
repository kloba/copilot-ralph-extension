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
