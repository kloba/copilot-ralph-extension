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
