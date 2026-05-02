// Unit tests for the caffeinate-ancestry detection helper (issue #75).
//
// Pure stdlib — exercises the helper through its injectable seams
// (`platform`, `ppid`, `exec`) so the tests don't actually spawn any
// subprocesses or touch the real /bin/ps. Each test passes the seams
// explicitly; that bypasses the per-process cache so tests don't
// leak into each other.

import test from "node:test";
import assert from "node:assert/strict";

import { detectCaffeinate, _resetCacheForTest } from "../src/caffeinate.mjs";

// Helper — build an `exec` mock that resolves a deterministic
// pid → { comm, ppid } table. Returns `null` for unknown pids so
// the walk terminates cleanly.
function makeExec(table) {
    return (pid) => table[pid] ?? null;
}

test("detectCaffeinate: returns false on linux without invoking exec", () => {
    let invoked = false;
    const exec = () => { invoked = true; return null; };
    const result = detectCaffeinate({ platform: "linux", ppid: 1234, exec });
    assert.equal(result, false);
    assert.equal(invoked, false, "linux short-circuit must not query ps");
});

test("detectCaffeinate: returns false on win32 without invoking exec", () => {
    let invoked = false;
    const exec = () => { invoked = true; return null; };
    const result = detectCaffeinate({ platform: "win32", ppid: 1234, exec });
    assert.equal(result, false);
    assert.equal(invoked, false);
});

test("detectCaffeinate: returns true when direct parent is caffeinate", () => {
    const exec = makeExec({
        500: { comm: "caffeinate", ppid: 1 },
    });
    const result = detectCaffeinate({ platform: "darwin", ppid: 500, exec });
    assert.equal(result, true);
});

test("detectCaffeinate: returns true when grandparent is caffeinate", () => {
    // node ← bash ← caffeinate ← launchd
    const exec = makeExec({
        500: { comm: "bash", ppid: 400 },
        400: { comm: "caffeinate", ppid: 1 },
    });
    const result = detectCaffeinate({ platform: "darwin", ppid: 500, exec });
    assert.equal(result, true);
});

test("detectCaffeinate: returns true when caffeinate appears with absolute path", () => {
    // ps -o comm= can return either bare basename or absolute path
    // depending on how the process was invoked. The helper strips
    // the path prefix so /usr/bin/caffeinate matches caffeinate.
    const exec = makeExec({
        500: { comm: "/usr/bin/caffeinate", ppid: 1 },
    });
    const result = detectCaffeinate({ platform: "darwin", ppid: 500, exec });
    assert.equal(result, true);
});

test("detectCaffeinate: returns false when no ancestor is caffeinate", () => {
    // node ← zsh ← terminal ← launchd
    const exec = makeExec({
        500: { comm: "zsh", ppid: 400 },
        400: { comm: "terminal", ppid: 1 },
    });
    const result = detectCaffeinate({ platform: "darwin", ppid: 500, exec });
    assert.equal(result, false);
});

test("detectCaffeinate: stops walking at pid 1 (launchd) without false positive", () => {
    const exec = makeExec({
        500: { comm: "node", ppid: 1 },
    });
    const result = detectCaffeinate({ platform: "darwin", ppid: 500, exec });
    assert.equal(result, false);
});

test("detectCaffeinate: stops cleanly when exec returns null mid-walk", () => {
    // Process exits during walk → ps returns null. Helper should
    // return false rather than throwing or looping.
    const exec = makeExec({
        500: { comm: "bash", ppid: 400 },
        // 400 deliberately absent — exec returns null for it.
    });
    const result = detectCaffeinate({ platform: "darwin", ppid: 500, exec });
    assert.equal(result, false);
});

test("detectCaffeinate: bounded ancestry walk does not run forever on a cycle", () => {
    // Pathological table where pid lookups loop back to themselves.
    // The MAX_ANCESTORS cap should kick in and the helper should
    // return false rather than spinning.
    let lookups = 0;
    const exec = (pid) => {
        lookups += 1;
        return { comm: "node", ppid: pid }; // self-loop
    };
    const result = detectCaffeinate({ platform: "darwin", ppid: 500, exec });
    assert.equal(result, false);
    // One lookup per ancestor, capped at MAX_ANCESTORS = 8.
    assert.ok(lookups <= 8, `expected <= 8 lookups, got ${lookups}`);
});

test("detectCaffeinate: handles ps trailing colon for defunct processes", () => {
    // ps occasionally appends a `:` to comm for zombie / defunct
    // processes (e.g. "node:"). The basename normaliser should
    // strip it so we still match "caffeinate:" as caffeinate.
    const exec = makeExec({
        500: { comm: "caffeinate:", ppid: 1 },
    });
    const result = detectCaffeinate({ platform: "darwin", ppid: 500, exec });
    assert.equal(result, true);
});

test("detectCaffeinate: ignores caffeinate-substring (e.g. 'caffeinated-app') matches", () => {
    // Basename equality, not substring contains — a process named
    // `caffeinated-app` should NOT trigger the pip.
    const exec = makeExec({
        500: { comm: "caffeinated-app", ppid: 400 },
        400: { comm: "node", ppid: 1 },
    });
    const result = detectCaffeinate({ platform: "darwin", ppid: 500, exec });
    assert.equal(result, false);
});

test("detectCaffeinate: returns false when ppid is not finite (orphaned)", () => {
    // ppid 0 means no parent (kernel sentinel). Helper should bail
    // immediately rather than try to ps pid 0.
    const result = detectCaffeinate({
        platform: "darwin",
        ppid: 0,
        exec: () => { throw new Error("should not be called"); },
    });
    assert.equal(result, false);
});

test("detectCaffeinate: result is cached across calls without overrides", () => {
    // First call with overrides primes a known result, but does NOT
    // populate the cache (overrides bypass the cache). Subsequent
    // calls without overrides hit the real platform / ppid path —
    // we just assert the function returns a boolean (true or false
    // depending on the test runner's actual ancestry).
    _resetCacheForTest();
    const r1 = detectCaffeinate();
    const r2 = detectCaffeinate();
    assert.equal(typeof r1, "boolean");
    assert.equal(r1, r2, "cached call must return identical value");
});

test("detectCaffeinate: passing overrides bypasses the cache", () => {
    _resetCacheForTest();
    // Prime with one result …
    const a = detectCaffeinate({
        platform: "darwin",
        ppid: 500,
        exec: makeExec({ 500: { comm: "caffeinate", ppid: 1 } }),
    });
    assert.equal(a, true);
    // … then a separate override-bearing call returns its own
    // independent result. Cache is not contaminated either way.
    const b = detectCaffeinate({
        platform: "darwin",
        ppid: 500,
        exec: makeExec({ 500: { comm: "node", ppid: 1 } }),
    });
    assert.equal(b, false);
});
