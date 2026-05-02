import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseArgv, cmdReplay } from "../bin/tui.mjs";

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

test("bin replay: path-traversal runId exits 2 with clean validation error (no stack trace)", () => {
    const r = runBin(["replay", "../etc/passwd"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /path separators or traversal segments/);
    // Stack frames should NOT leak — validation errors render as a
    // single tidy line, not a Node trace with `at file://...:line:col`.
    assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("bin: unknown subcommand fails", () => {
    const r = runBin(["nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command/);
});

import { chmodSync } from "node:fs";

test("bin doctor: healthy case exits 0 and prints all sections", () => {
    const dir = tmp();
    const r = runBin(["doctor"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /runs root:/);
    assert.match(r.stdout, /run index:/);
    assert.match(r.stdout, /runs found:/);
    assert.match(r.stdout, /node:/);
    assert.match(r.stdout, /tui version:/);
    rmSync(dir, { recursive: true, force: true });
});

test("bin doctor: unwritable runs root exits non-zero with path", () => {
    const dir = tmp();
    chmodSync(dir, 0o500);
    try {
        const r = runBin(["doctor"], { RALPH_EVENTS_DIR: dir });
        assert.notEqual(r.status, 0, "should exit non-zero on unwritable root");
        assert.match(r.stdout + r.stderr, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(r.stdout, /UNWRITABLE/);
    } finally {
        chmodSync(dir, 0o700);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("bin --help mentions doctor", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /doctor/);
});

import { mkdirSync as mkSync2 } from "node:fs";

function seedRun(root, runId, ts) {
    const runDir = join(root, runId);
    mkSync2(runDir, { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({ type: "armed", ts, runId }) + "\n");
    return JSON.stringify({ type: "armed", ts, runId, label: "ralph_loop", maxIterations: 5, minIterations: 1 });
}

test("bin prune --dry-run: lists would-remove without deleting", () => {
    const dir = tmp();
    const old = seedRun(dir, "ralph_loop-old", 1);  // ts=1ms epoch ⇒ very old
    const fresh = seedRun(dir, "ralph_loop-fresh", Date.now());
    writeFileSync(join(dir, "index.jsonl"), old + "\n" + fresh + "\n");
    const r = runBin(["prune", "--older-than", "365d", "--dry-run"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /dry-run.*would remove 1/);
    assert.match(r.stdout, /would remove ralph_loop-old/);
    // file still present
    const list = runBin(["list", "--json"], { RALPH_EVENTS_DIR: dir });
    assert.equal(JSON.parse(list.stdout).length, 2);
    rmSync(dir, { recursive: true, force: true });
});

test("bin prune --older-than 0m: removes every run", () => {
    const dir = tmp();
    const a = seedRun(dir, "ralph_loop-a", Date.now() - 1000);
    const b = seedRun(dir, "ralph_loop-b", Date.now() - 2000);
    writeFileSync(join(dir, "index.jsonl"), a + "\n" + b + "\n");
    const r = runBin(["prune", "--older-than", "0m"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pruned 2 runs/);
    const list = runBin(["list", "--json"], { RALPH_EVENTS_DIR: dir });
    assert.deepEqual(JSON.parse(list.stdout), []);
    rmSync(dir, { recursive: true, force: true });
});

test("bin prune: invalid --older-than exits non-zero", () => {
    const r = runBin(["prune", "--older-than", "nope"], { RALPH_EVENTS_DIR: tmp() });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid --older-than/);
});

test("parseDuration: accepts d/h/m, rejects garbage", async () => {
    const { parseDuration } = await import("../src/writer.mjs");
    assert.equal(parseDuration("30d"), 30 * 86_400_000);
    assert.equal(parseDuration("12h"), 12 * 3_600_000);
    assert.equal(parseDuration("5m"), 5 * 60_000);
    assert.equal(parseDuration("0m"), 0);
    assert.equal(parseDuration("nope"), null);
    assert.equal(parseDuration("1.5d"), null);
    assert.equal(parseDuration(""), null);
    assert.equal(parseDuration(undefined), null);
});

test("bin stats: empty index prints No runs found", () => {
    const dir = tmp();
    const r = runBin(["stats"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No runs found/);
    rmSync(dir, { recursive: true, force: true });
});

test("bin stats: aggregates by tool, reason and iterations", () => {
    const dir = tmp();
    // Two runs: one ralph_loop completing, one self_improve aborting.
    const r1 = "ralph_loop-100";
    const r2 = "self_improve-200";
    mkdirSync(join(dir, r1), { recursive: true });
    mkdirSync(join(dir, r2), { recursive: true });
    writeFileSync(join(dir, r1, "events.jsonl"),
        JSON.stringify({ type: "armed", ts: 100, runId: r1, label: "ralph_loop" }) + "\n"
        + JSON.stringify({ type: "iteration_start", ts: 101, runId: r1, iteration: 1 }) + "\n"
        + JSON.stringify({ type: "iteration_end", ts: 102, runId: r1, iteration: 1 }) + "\n"
        + JSON.stringify({ type: "complete", ts: 103, runId: r1, reason: "completion_promise", iteration: 3 }) + "\n",
    );
    writeFileSync(join(dir, r2, "events.jsonl"),
        JSON.stringify({ type: "armed", ts: 200, runId: r2, label: "self_improve" }) + "\n"
        + JSON.stringify({ type: "abort", ts: 201, runId: r2, reason: "max_tokens", iteration: 7 }) + "\n",
    );
    writeFileSync(join(dir, "index.jsonl"),
        JSON.stringify({ type: "armed", ts: 100, runId: r1, label: "ralph_loop", maxIterations: 5, minIterations: 1 }) + "\n"
        + JSON.stringify({ type: "armed", ts: 200, runId: r2, label: "self_improve", maxIterations: 100, minIterations: 5 }) + "\n",
    );
    const r = runBin(["stats"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Totals/);
    assert.match(r.stdout, /By tool/);
    assert.match(r.stdout, /By reason/);
    assert.match(r.stdout, /Iterations/);
    assert.match(r.stdout, /runs: 2/);
    assert.match(r.stdout, /ralph_loop: 1/);
    assert.match(r.stdout, /self_improve: 1/);
    assert.match(r.stdout, /complete:completion_promise: 1/);
    assert.match(r.stdout, /abort:max_tokens: 1/);
    assert.match(r.stdout, /max: 7/);
    rmSync(dir, { recursive: true, force: true });
});

import { readFileSync as readFileSync2 } from "node:fs";

test("parseArgv: --version and -V set flags.version", () => {
    assert.equal(parseArgv(["--version"]).flags.version, true);
    assert.equal(parseArgv(["-V"]).flags.version, true);
});

test("bin --version: prints version matching package.json", () => {
    const r = runBin(["--version"]);
    assert.equal(r.status, 0);
    const pkg = JSON.parse(readFileSync2(resolve(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(r.stdout.trim(), `ralph-tui ${pkg.version}`);
});

test("bin -V: same as --version", () => {
    const r = runBin(["-V"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ralph-tui \d/);
});

test("bin --help: mentions --version", () => {
    const r = runBin(["--help"]);
    assert.match(r.stdout, /--version/);
});

function seedThreeRuns(dir) {
    writeFileSync(join(dir, "index.jsonl"),
        JSON.stringify({ type: "armed", ts: 1000, runId: "ralph_loop-1000", label: "ralph_loop", maxIterations: 5, minIterations: 1 }) + "\n"
        + JSON.stringify({ type: "armed", ts: 2000, runId: "self_improve-2000", label: "self_improve", maxIterations: 100, minIterations: 5 }) + "\n"
        + JSON.stringify({ type: "armed", ts: 3000, runId: "grow_project-3000", label: "grow_project", maxIterations: 50, minIterations: 1 }) + "\n",
    );
}

test("bin list --limit N: prints at most N runs (newest first)", () => {
    const dir = tmp();
    seedThreeRuns(dir);
    const r = runBin(["list", "--limit", "2", "--json"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].runId, "grow_project-3000");
    rmSync(dir, { recursive: true, force: true });
});

test("bin list --limit 0: prints zero runs and exits 0", () => {
    const dir = tmp();
    seedThreeRuns(dir);
    const r = runBin(["list", "--limit", "0", "--json"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), []);
    rmSync(dir, { recursive: true, force: true });
});

test("bin list --limit nope: invalid value exits non-zero", () => {
    const dir = tmp();
    seedThreeRuns(dir);
    const r = runBin(["list", "--limit", "nope"], { RALPH_EVENTS_DIR: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid --limit/);
    rmSync(dir, { recursive: true, force: true });
});

test("bin list (no --limit): all runs preserved", () => {
    const dir = tmp();
    seedThreeRuns(dir);
    const r = runBin(["list", "--json"], { RALPH_EVENTS_DIR: dir });
    assert.equal(JSON.parse(r.stdout).length, 3);
    rmSync(dir, { recursive: true, force: true });
});

test("bin where: prints default runs root", () => {
    const r = runBin(["where"], { RALPH_EVENTS_DIR: "" });  // empty -> default
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\.copilot\/ralph\/runs\n$/);
});

test("bin where: honours RALPH_EVENTS_DIR override", () => {
    const dir = tmp();
    const r = runBin(["where"], { RALPH_EVENTS_DIR: dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, dir + "\n");
    rmSync(dir, { recursive: true, force: true });
});

test("bin where: works even when directory does not exist", () => {
    const r = runBin(["where"], { RALPH_EVENTS_DIR: "/tmp/ralph-tui-does-not-exist-zz" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "/tmp/ralph-tui-does-not-exist-zz\n");
});

test("bin --help: mentions where", () => {
    const r = runBin(["--help"]);
    assert.match(r.stdout, /ralph-tui where/);
});

test("tui.mjs header comment lists every USAGE subcommand (drift guard)", async () => {
    // Iter 138 fix: the file's header comment used to list only 3
    // subcommands (list/replay/watch) while the USAGE constant in the
    // same file had grown to 7 (list/replay/watch/doctor/prune/stats/
    // where). A contributor reading the header to understand the tool
    // scope would silently miss four commands. Pin the symmetry so the
    // next subcommand drop must update both surfaces.
    const fs = await import("node:fs");
    const src = fs.readFileSync(BIN, "utf8");

    // Header subcommands: lines starting with `//   <word>` between the
    // opening `// Subcommands` block and the first blank-comment line
    // closing it. We accept a leading `//`, two spaces, then the
    // subcommand identifier as the first non-space token before either
    // a space or `[` (positional/optional placeholder).
    const headerBlock = src.match(/\/\/ Subcommands[\s\S]+?\n\/\/\s*\n/);
    assert.ok(headerBlock, "could not locate the // Subcommands block in tui.mjs header");
    const headerCmds = new Set(
        [...headerBlock[0].matchAll(/^\/\/\s{3}([a-z]+)\b/gm)].map((m) => m[1])
    );

    // USAGE subcommands: lines beginning `  ralph-tui <cmd>` inside the
    // `const USAGE = \`…\`;` template literal. Skip the `--help` /
    // `--version` lines.
    const usageBlock = src.match(/const USAGE = `([\s\S]+?)`;/);
    assert.ok(usageBlock, "could not locate the USAGE constant in tui.mjs");
    const usageCmds = new Set(
        [...usageBlock[1].matchAll(/^\s{2}ralph-tui\s+([a-z]+)\b/gm)].map((m) => m[1])
    );

    // Pin: every USAGE subcommand must appear in the header. (We allow
    // the header to be more verbose; this guard catches the common
    // direction where USAGE grew but the header didn't.)
    const missing = [...usageCmds].filter((c) => !headerCmds.has(c));
    assert.deepEqual(missing, [],
        `tui.mjs header comment is missing subcommand(s) listed in USAGE: ${missing.join(", ")}. Add them to the // Subcommands block at the top of bin/tui.mjs.`);

    // Sanity: at least the four subcommands the iter 138 fix added
    // should be present so a future "let me clean up the header"
    // refactor can't silently drop them again.
    for (const cmd of ["list", "replay", "watch", "doctor", "prune", "stats", "where"]) {
        assert.ok(headerCmds.has(cmd),
            `tui.mjs header // Subcommands block is missing "${cmd}"; the iter 138 drift-guard floor is all 7 currently-shipped subcommands`);
    }
});

// Iter 142 — pin the symmetry contract that every `fail(...)` call site
// in bin/tui.mjs is followed by an explicit `return` so a stubbed
// process.exit (test harness, future programmatic caller, REPL) cannot
// fall through into the rest of the function. Pre-iter-142 cmdReplay
// and cmdWatch's empty-input branches did `fail("...")` without a
// trailing return; under a stubbed exit, control fell through into
// `resolveRunEventsPath(undefined)` which throws TypeError, so the
// caller saw a confusing stack trace instead of the clean "<runId> is
// required" diagnostic. Production was unaffected (process.exit ends
// the program), but the asymmetry was real code rot.
test("cmdReplay: stubbed process.exit + missing runId returns 2 cleanly (no TypeError fallthrough)", () => {
    const realExit = process.exit;
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    let exitCode = null;
    let captured = "";
    process.exit = (code) => { exitCode = code; };
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try {
        // With the iter 142 fix, cmdReplay returns 2 cleanly. Without
        // the fix, control fell through into resolveRunEventsPath(undefined)
        // which throws TypeError — that throw would surface here as an
        // assertion failure (assert.doesNotThrow).
        let result;
        assert.doesNotThrow(() => { result = cmdReplay(undefined); },
            "cmdReplay must return cleanly when fail()'s exit is stubbed (no TypeError fallthrough into resolveRunEventsPath)");
        assert.equal(result, 2, "cmdReplay must return exit code 2 for missing runId");
        assert.equal(exitCode, 2, "fail() must request exit code 2");
        assert.match(captured, /<runId> is required/, "stderr must contain the validation message");
    } finally {
        process.exit = realExit;
        process.stderr.write = realStderrWrite;
    }
});
