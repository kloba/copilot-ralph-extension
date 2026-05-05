// Smoke / surface tests for `packages/tui/bin/tui.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgv } from "../bin/tui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "tui.mjs");

function runBin(args, env = {}) {
    return spawnSync(process.execPath, [BIN, ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env },
    });
}

function withTmp(fn) {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-tui-bin-"));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("parseArgv: --help short-circuits", () => {
    const out = parseArgv(["--help"]);
    assert.equal(out.flags.help, true);
});

test("parseArgv: subcommand and value flag", () => {
    const out = parseArgv(["watch", "--poll-ms", "250", "--plain"]);
    assert.equal(out.cmd, "watch");
    assert.equal(out.flags["poll-ms"], "250");
    assert.equal(out.flags.plain, true);
});

test("parseArgv: --flag=value form", () => {
    const out = parseArgv(["watch", "--state-file=/tmp/foo.json"]);
    assert.equal(out.flags["state-file"], "/tmp/foo.json");
});

test("bin --help: prints USAGE and exits 0", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /autopilot-tui/);
    assert.match(r.stdout, /watch/);
    assert.match(r.stdout, /show/);
    assert.match(r.stdout, /where/);
});

test("bin --version: prints a version line", () => {
    const r = runBin(["--version"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^autopilot-tui \S+\n$/);
});

test("bin where: prints a path ending with state.json", () => {
    withTmp((dir) => {
        const path = join(dir, "state.json");
        const r = runBin(["where", "--state-file", path]);
        assert.equal(r.status, 0);
        assert.equal(r.stdout.trim(), path);
    });
});

test("bin where: AUTOPILOT_STATE_FILE env override", () => {
    withTmp((dir) => {
        const path = join(dir, "envstate.json");
        const r = runBin(["where"], { AUTOPILOT_STATE_FILE: path });
        assert.equal(r.status, 0);
        assert.equal(r.stdout.trim(), path);
    });
});

test("bin show: missing state file → IDLE placeholder", () => {
    withTmp((dir) => {
        const path = join(dir, "missing.json");
        const r = runBin(["show", "--state-file", path]);
        assert.equal(r.status, 0);
        assert.match(r.stdout, /IDLE/);
    });
});

test("bin show: existing state file is rendered as a dashboard block", () => {
    withTmp((dir) => {
        const path = join(dir, "state.json");
        writeFileSync(path, JSON.stringify({
            armed: true, paused: false,
            iter: 2, max_iters: 100,
            started_at: Date.now() - 1000,
            version: "0.7.0",
            history: [
                { iter: 1, ts: Date.now() - 800, event: "outcome", outcome: "shipped", sha: "deadbeef" },
            ],
        }), "utf8");
        const r = runBin(["show", "--state-file", path]);
        assert.equal(r.status, 0);
        assert.match(r.stdout, /RUNNING/);
        assert.match(r.stdout, /iter 2\/100/);
        assert.match(r.stdout, /shipped deadbeef/);
    });
});

test("bin watch --poll-ms invalid → fails with code 2", () => {
    const r = runBin(["watch", "--poll-ms", "abc", "--plain"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /poll-ms/);
});

test("bin: unknown command fails with code 2 and prints USAGE", () => {
    const r = runBin(["nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command/);
});
