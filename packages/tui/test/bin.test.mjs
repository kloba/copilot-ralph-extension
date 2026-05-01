import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseArgv } from "../bin/tui.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = resolve(REPO_ROOT, "bin", "tui.mjs");

function tmp() {
    return mkdtempSync(join(tmpdir(), "ralph-bin-"));
}

function runBin(args, env) {
    return spawnSync(process.execPath, [BIN, ...args], {
        env: { ...process.env, ...env },
        encoding: "utf8",
    });
}

test("parseArgv: --help short-circuits", () => {
    assert.equal(parseArgv(["--help"]).flags.help, true);
    assert.equal(parseArgv(["-h"]).flags.help, true);
});

test("parseArgv: subcommand and positional", () => {
    const r = parseArgv(["replay", "ralph_loop-1"]);
    assert.equal(r.cmd, "replay");
    assert.deepEqual(r.positional, ["ralph_loop-1"]);
});

test("parseArgv: --plain flag", () => {
    const r = parseArgv(["watch", "rid", "--plain"]);
    assert.equal(r.cmd, "watch");
    assert.deepEqual(r.positional, ["rid"]);
    assert.equal(r.flags.plain, true);
});

test("bin --help: prints USAGE and exits 0", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /USAGE/);
    assert.match(r.stdout, /ralph-tui list/);
});

test("bin list: empty runs root prints helpful message", () => {
    const dir = tmp();
    const r = runBin(["list"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No runs found/);
    rmSync(dir, { recursive: true, force: true });
});

test("bin list: enumerates seeded runs newest-first", () => {
    const dir = tmp();
    const idx = join(dir, "index.jsonl");
    writeFileSync(idx,
        JSON.stringify({ type: "armed", ts: 1000, runId: "ralph_loop-1000", label: "ralph_loop", maxIterations: 5, minIterations: 1 }) + "\n"
        + JSON.stringify({ type: "armed", ts: 2000, runId: "self_improve-2000", label: "self_improve", maxIterations: 100, minIterations: 5 }) + "\n",
    );
    const r = runBin(["list"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split("\n");
    // Header + 2 runs.
    assert.equal(lines.length, 3);
    assert.match(lines[1], /self_improve-2000/, "newest first");
    assert.match(lines[2], /ralph_loop-1000/);
    rmSync(dir, { recursive: true, force: true });
});

test("bin list --json: empty runs root prints []", () => {
    const dir = tmp();
    const r = runBin(["list", "--json"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "[]\n");
    assert.deepEqual(JSON.parse(r.stdout), []);
    rmSync(dir, { recursive: true, force: true });
});

test("bin list --json: emits parseable run index newest-first", () => {
    const dir = tmp();
    const idx = join(dir, "index.jsonl");
    writeFileSync(idx,
        JSON.stringify({ type: "armed", ts: 1000, runId: "ralph_loop-1000", label: "ralph_loop", maxIterations: 5, minIterations: 1 }) + "\n"
        + JSON.stringify({ type: "armed", ts: 2000, runId: "self_improve-2000", label: "self_improve", maxIterations: 100, minIterations: 5 }) + "\n",
    );
    const r = runBin(["list", "--json"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].runId, "self_improve-2000", "newest first");
    assert.equal(parsed[1].runId, "ralph_loop-1000");
    for (const e of parsed) {
        assert.ok(typeof e.runId === "string");
        assert.ok(typeof e.ts === "number");
    }
    rmSync(dir, { recursive: true, force: true });
});

test("bin replay: prints all events for a run", () => {
    const dir = tmp();
    const runDir = join(dir, "ralph_loop-1");
    mkdirSync(runDir);
    const ev = join(runDir, "events.jsonl");
    writeFileSync(ev,
        JSON.stringify({ type: "armed", ts: 1, runId: "ralph_loop-1", maxIterations: 3, minIterations: 1 }) + "\n"
        + JSON.stringify({ type: "iteration_start", ts: 2, runId: "ralph_loop-1", iteration: 1 }) + "\n"
        + JSON.stringify({ type: "complete", ts: 3, runId: "ralph_loop-1", reason: "completion_promise", iteration: 1 }) + "\n",
    );
    const r = runBin(["replay", "ralph_loop-1"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /armed\s+ralph_loop-1/);
    assert.match(r.stdout, /iter\+/);
    assert.match(r.stdout, /done\s+ralph_loop-1.*reason=completion_promise/);
    rmSync(dir, { recursive: true, force: true });
});

test("bin replay: missing runId fails with code 2", () => {
    const r = runBin(["replay"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /<runId> is required/);
});

test("bin: unknown subcommand fails", () => {
    const r = runBin(["nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command/);
});
