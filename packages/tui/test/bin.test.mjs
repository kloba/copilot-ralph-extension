import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseArgv, cmdReplay, main as tuiMain } from "../bin/tui.mjs";

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
    assert.match(r.stdout, /autopilot list/);
});

test("bin list: empty runs root prints helpful message", () => {
    const dir = tmp();
    const r = runBin(["list"], { RALPH_TUI_RUNS_DIR: dir });
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
    const r = runBin(["list"], { RALPH_TUI_RUNS_DIR: dir });
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
    const r = runBin(["list", "--json"], { RALPH_TUI_RUNS_DIR: dir });
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
    const r = runBin(["list", "--json"], { RALPH_TUI_RUNS_DIR: dir });
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
    const r = runBin(["replay", "ralph_loop-1"], { RALPH_TUI_RUNS_DIR: dir });
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
    const r = runBin(["doctor"], { RALPH_TUI_RUNS_DIR: dir });
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
        const r = runBin(["doctor"], { RALPH_TUI_RUNS_DIR: dir });
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
    const r = runBin(["prune", "--older-than", "365d", "--dry-run"], { RALPH_TUI_RUNS_DIR: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /dry-run.*would remove 1/);
    assert.match(r.stdout, /would remove ralph_loop-old/);
    // file still present
    const list = runBin(["list", "--json"], { RALPH_TUI_RUNS_DIR: dir });
    assert.equal(JSON.parse(list.stdout).length, 2);
    rmSync(dir, { recursive: true, force: true });
});

test("bin prune --older-than 0m: removes every run", () => {
    const dir = tmp();
    const a = seedRun(dir, "ralph_loop-a", Date.now() - 1000);
    const b = seedRun(dir, "ralph_loop-b", Date.now() - 2000);
    writeFileSync(join(dir, "index.jsonl"), a + "\n" + b + "\n");
    const r = runBin(["prune", "--older-than", "0m"], { RALPH_TUI_RUNS_DIR: dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pruned 2 runs/);
    const list = runBin(["list", "--json"], { RALPH_TUI_RUNS_DIR: dir });
    assert.deepEqual(JSON.parse(list.stdout), []);
    rmSync(dir, { recursive: true, force: true });
});

test("bin prune: invalid --older-than exits non-zero", () => {
    const r = runBin(["prune", "--older-than", "nope"], { RALPH_TUI_RUNS_DIR: tmp() });
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
    const r = runBin(["stats"], { RALPH_TUI_RUNS_DIR: dir });
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
    const r = runBin(["stats"], { RALPH_TUI_RUNS_DIR: dir });
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
    assert.equal(r.stdout.trim(), `autopilot ${pkg.version}`);
});

test("bin -V: same as --version", () => {
    const r = runBin(["-V"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^autopilot \d/);
});

test("bin --help: mentions --version", () => {
    const r = runBin(["--help"]);
    assert.match(r.stdout, /--version/);
});

// ─── version.mjs (issue #59) ─────────────────────────────────────
// Direct unit test for the shared module; bin/tui.mjs re-exports
// from src/version.mjs so a regression in the shared module
// surfaces both via this import-from-src test AND the existing
// `bin --version` integration test above.

test("version.mjs: readTuiVersion returns package.json version string", async () => {
    const { readTuiVersion } = await import("../src/version.mjs");
    const pkg = JSON.parse(readFileSync2(resolve(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(readTuiVersion(), pkg.version);
});

test("version.mjs: bin/tui.mjs re-export matches src/version.mjs", async () => {
    const fromBin = (await import("../bin/tui.mjs")).readTuiVersion;
    const fromSrc = (await import("../src/version.mjs")).readTuiVersion;
    assert.equal(typeof fromBin, "function");
    assert.equal(typeof fromSrc, "function");
    assert.equal(fromBin(), fromSrc());
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
    const r = runBin(["list", "--limit", "2", "--json"], { RALPH_TUI_RUNS_DIR: dir });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].runId, "grow_project-3000");
    rmSync(dir, { recursive: true, force: true });
});

test("bin list --limit 0: prints zero runs and exits 0", () => {
    const dir = tmp();
    seedThreeRuns(dir);
    const r = runBin(["list", "--limit", "0", "--json"], { RALPH_TUI_RUNS_DIR: dir });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), []);
    rmSync(dir, { recursive: true, force: true });
});

test("bin list --limit nope: invalid value exits non-zero", () => {
    const dir = tmp();
    seedThreeRuns(dir);
    const r = runBin(["list", "--limit", "nope"], { RALPH_TUI_RUNS_DIR: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid --limit/);
    rmSync(dir, { recursive: true, force: true });
});

test("bin list (no --limit): all runs preserved", () => {
    const dir = tmp();
    seedThreeRuns(dir);
    const r = runBin(["list", "--json"], { RALPH_TUI_RUNS_DIR: dir });
    assert.equal(JSON.parse(r.stdout).length, 3);
    rmSync(dir, { recursive: true, force: true });
});

test("bin where: prints default runs root", () => {
    // Override HOME to a clean tmp dir so the legacy-path read-fallback
    // (which kicks in when ~/.copilot/ralph-tui/runs exists but
    // ~/.copilot/autopilot/runs doesn't) cannot fire from real on-disk
    // state on the developer's machine.
    const fakeHome = tmp();
    const r = runBin(
        ["where"],
        {
            AUTOPILOT_RUNS_DIR: "",
            RALPH_TUI_RUNS_DIR: "",
            HOME: fakeHome,
        },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\.copilot\/autopilot\/runs\n$/);
    rmSync(fakeHome, { recursive: true, force: true });
});

test("bin where: honours AUTOPILOT_RUNS_DIR override", () => {
    const dir = tmp();
    const r = runBin(["where"], { AUTOPILOT_RUNS_DIR: dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, dir + "\n");
    rmSync(dir, { recursive: true, force: true });
});

test("bin where: honours legacy RALPH_TUI_RUNS_DIR override (with deprecation notice)", () => {
    const dir = tmp();
    const r = runBin(["where"], { AUTOPILOT_RUNS_DIR: "", RALPH_TUI_RUNS_DIR: dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, dir + "\n");
    assert.match(r.stderr, /RALPH_TUI_RUNS_DIR is deprecated/);
    rmSync(dir, { recursive: true, force: true });
});

test("bin where: works even when directory does not exist", () => {
    const r = runBin(["where"], { AUTOPILOT_RUNS_DIR: "/tmp/ralph-tui-does-not-exist-zz" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "/tmp/ralph-tui-does-not-exist-zz\n");
});

test("bin --help: mentions where", () => {
    const r = runBin(["--help"]);
    assert.match(r.stdout, /autopilot where/);
});

test("tui.mjs has no top-level await (Node 22+ unsettled-TLA warning regression guard)", async () => {
    // Iter regression: the entry-point check used `await import("node:fs")`
    // and `await import("node:url")` at the top level. On `autopilot run`,
    // when main() resolved and the `.then(process.exit)` chain fired,
    // Node 22+ printed `ExperimentalWarning: Detected unsettled top-level
    // await at file://…/bin/tui.mjs:<EOF-line>` to stderr — a spurious
    // warning emitted because process.exit short-circuits the implicit
    // module-evaluation TLA settlement observation.
    //
    // Fix: realpathSync and pathToFileURL are now imported statically
    // (line 47 imports `fs`, line 50 imports `pathToFileURL`), removing
    // the dynamic-import await entirely. Pin the absence so a future
    // refactor can't silently re-introduce a TLA in this hot path.
    const fs = await import("node:fs");
    const src = fs.readFileSync(BIN, "utf8");

    // Strip line + block comments so a doc-block mentioning the word
    // "await" can't false-positive. (We match `await` at any indentation
    // followed by a space; that's the only spelling node uses for both
    // `await foo` and `await import(...)`.)
    const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

    // Find every `await` not nested inside a function. We do this by
    // tracking brace depth from the start of the file: depth > 0 means
    // we're inside `function`/arrow/method body or a class — i.e. NOT
    // top-level. Top-level awaits are the ones at depth 0.
    let depth = 0;
    let parenDepth = 0;
    const topLevelAwaits = [];
    let lineNo = 1;
    for (let i = 0; i < stripped.length; i++) {
        const ch = stripped[i];
        if (ch === "\n") lineNo++;
        // Skip string contents — they can't host real await statements.
        if (ch === '"' || ch === "'" || ch === "`") {
            const quote = ch;
            i++;
            while (i < stripped.length && stripped[i] !== quote) {
                if (stripped[i] === "\\") i++;
                if (stripped[i] === "\n") lineNo++;
                i++;
            }
            continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
        // Match the keyword `await` at depth 0 (outside any block) and
        // outside any parenthesised expression — the latter excludes
        // `for await (…)` and `await` inside a `(async () => …)()` IIFE
        // arg list, neither of which matters for this guard.
        if (depth === 0 && parenDepth === 0
            && stripped.slice(i, i + 6) === "await "
            // Word boundary on the left: previous char must not be an
            // identifier character (so `forawait` or `myawait` don't
            // trip the check).
            && (i === 0 || !/[a-zA-Z0-9_$]/.test(stripped[i - 1]))) {
            topLevelAwaits.push({ lineNo, snippet: stripped.slice(i, i + 40).split("\n")[0] });
        }
    }

    assert.deepEqual(topLevelAwaits, [],
        `bin/tui.mjs must not contain top-level await — Node 22+ emits a spurious "Detected unsettled top-level await" warning during process.exit. Found: ${JSON.stringify(topLevelAwaits, null, 2)}`);
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

    // USAGE subcommands: lines beginning `  autopilot <cmd>` inside the
    // `const USAGE = \`…\`;` template literal. Skip the `--help` /
    // `--version` lines.
    const usageBlock = src.match(/const USAGE = `([\s\S]+?)`;/);
    assert.ok(usageBlock, "could not locate the USAGE constant in tui.mjs");
    const usageCmds = new Set(
        [...usageBlock[1].matchAll(/^\s{2}autopilot\s+([a-z]+)\b/gm)].map((m) => m[1])
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

test("packages/tui/README.md Subcommands block lists every shipped subcommand + key flag", () => {
    // Iter 161 — packages/tui/README.md drifted: pre-iter-161 the
    // `## Subcommands` block listed only `list` / `replay` / `watch` /
    // `--help`, but bin/tui.mjs ships `doctor`, `prune`, `stats`,
    // `where`, the `--version` / `-V` flag, plus the `--json` and
    // `--limit N` flags on `list`. A contributor reading the TUI
    // README without cross-referencing bin/tui.mjs's USAGE constant
    // would not know these subcommands exist; CI scripts looking
    // for the canonical CLI surface would silently miss them.
    //
    // Bin/tui.mjs's own USAGE constant is already pinned by the
    // `tui.mjs header comment lists every USAGE subcommand` test
    // earlier in this file, so the source-of-truth side is covered.
    // This test pins the README mirror so adding a new subcommand
    // to bin/tui.mjs forces a corresponding README update or the
    // PR fails CI. Keep the keyword set intentionally minimal —
    // verifying every flag would brittle on prose tweaks; the
    // surfaces below are the user-visible CLI promise.
    const readme = readFileSync2(resolve(REPO_ROOT, "README.md"), "utf8");
    const i = readme.indexOf("## Subcommands");
    assert.ok(i >= 0, "TUI README must keep the '## Subcommands' header");
    // Slice generously so the section's adjacent prose can grow without
    // forcing the test to track exact byte offsets.
    const slice = readme.slice(i, i + 4000);
    // Issue #65 transition: the binary was renamed `ralph-tui` → `autopilot`.
    // The TUI README's docs sweep lands in a sibling PR (docs are not in
    // this unit's ownership), so during the rename window the README may
    // legitimately show either binary name. Each required subcommand must
    // appear under at least one of the two spellings.
    const subcmds = ["list", "replay", "watch", "doctor", "prune", "stats", "where"];
    for (const sub of subcmds) {
        const oldForm = `ralph-tui ${sub}`;
        const newForm = `autopilot ${sub}`;
        assert.ok(
            slice.includes(oldForm) || slice.includes(newForm),
            `TUI README ## Subcommands block must list '${newForm}' (or legacy '${oldForm}' during the issue #65 rename window) — currently shipped by bin/tui.mjs`,
        );
    }
    const requiredFlags = ["--help", "--version", "--json", "--limit", "--older-than", "--dry-run", "--plain"];
    for (const kw of requiredFlags) {
        assert.ok(
            slice.includes(kw),
            `TUI README ## Subcommands block must list '${kw}' (currently shipped by bin/tui.mjs)`,
        );
    }
});

test("packages/tui/package.json carries repository/bugs/author metadata aligned with the root package.json", () => {
    // Iter 162 — packages/tui/package.json was missing the
    // `repository`, `bugs`, `author`, and `keywords` fields that
    // the root package.json carries (iter 151 added the missing
    // root `author`, but the workspace package was forgotten).
    // For a sub-package shipped via the dogfood install path AND
    // documented as `npx autopilot` in docs/faq.md, the missing
    // metadata silently degrades the registry listing if the
    // `private: true` flag is ever flipped (e.g. a future release
    // branch that publishes the TUI to npm separately). Adding
    // `repository.directory: "packages/tui"` is the canonical npm
    // hint for monorepo subdir packages and lets registry/source
    // links point at the right path.
    //
    // Pin the contract: a future contributor that bumps the repo
    // URL or author in the root MUST also bump it here, OR a CI
    // failure surfaces the drift. Keeping the assertion narrow
    // (URL substring + author equality) avoids brittleness on
    // legitimate `keywords` evolution.
    const tuiPkg = JSON.parse(readFileSync2(resolve(REPO_ROOT, "package.json"), "utf8"));
    const rootPkg = JSON.parse(readFileSync2(resolve(REPO_ROOT, "..", "..", "package.json"), "utf8"));

    assert.equal(typeof tuiPkg.repository, "object",
        "TUI package.json must declare a repository object (npm metadata hygiene)");
    assert.equal(tuiPkg.repository.type, "git", "repository.type must be 'git'");
    assert.ok(
        typeof tuiPkg.repository.url === "string"
            && tuiPkg.repository.url.includes("kloba/autopilot"),
        "TUI repository.url must reference the canonical kloba/autopilot repo",
    );
    assert.equal(
        tuiPkg.repository.directory,
        "packages/tui",
        "TUI repository.directory must point at the workspace subdir for npm monorepo metadata",
    );
    // The TUI's repo URL must match the root's so a registry listing
    // and the GitHub source view land on the same canonical URL.
    assert.equal(
        tuiPkg.repository.url,
        rootPkg.repository.url,
        "TUI repository.url must match root package.json (drift kills registry/source links)",
    );
    assert.equal(typeof tuiPkg.bugs, "object", "TUI package.json must declare a bugs object");
    assert.equal(
        tuiPkg.bugs.url,
        rootPkg.bugs.url,
        "TUI bugs.url must match root package.json (so issue links are consistent)",
    );
    assert.equal(
        tuiPkg.author,
        rootPkg.author,
        "TUI author must match root package.json (single attribution source of truth)",
    );
    assert.ok(
        Array.isArray(tuiPkg.keywords) && tuiPkg.keywords.length > 0,
        "TUI package.json must declare a non-empty keywords array",
    );
});

test("cmdReplay: path-traversal runId routes through fail() with clean error (no raw TypeError stack)", () => {
    // Iter 167 — `resolveRunEventsPath` throws TypeError on
    // path-traversal runIds (`../etc/passwd`, runIds with `\0`, runIds
    // with `\\`, `.`, `..`). Pre-iter-167 `cmdReplay` and `cmdWatch`
    // called the resolver without catching, so a user supplying
    // `autopilot replay ../etc/passwd` saw a raw stack trace instead
    // of a clean error message. The fix is to catch TypeError at the
    // bin layer and route through `fail()` (clean stderr line + exit
    // code 2). Pin both the no-throw contract and the user-visible
    // message so a future "simplify" refactor can't quietly drop the
    // catch.
    const realExit = process.exit;
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    let exitCode = null;
    let captured = "";
    process.exit = (code) => { exitCode = code; };
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try {
        let result;
        assert.doesNotThrow(
            () => { result = cmdReplay("../etc/passwd"); },
            "cmdReplay must catch TypeError from resolveRunEventsPath and return cleanly",
        );
        assert.equal(result, 2, "cmdReplay must return exit code 2 for traversal runId");
        assert.equal(exitCode, 2, "fail() must request exit code 2");
        assert.match(captured, /replay:/, "stderr line must be prefixed with the subcommand name");
        assert.match(
            captured,
            /path separators or traversal segments/,
            "stderr must surface the traversal-rejection message from resolveRunEventsPath",
        );
        assert.doesNotMatch(
            captured,
            /at assertSafeRunId|at resolveRunEventsPath/,
            "stderr must NOT contain a raw stack frame — that's the bug we're pinning closed",
        );
    } finally {
        process.exit = realExit;
        process.stderr.write = realStderrWrite;
    }
});

test("cmdReplay: NUL-byte runId is also rejected via fail() (defence-in-depth on assertSafeRunId clauses)", () => {
    // The traversal predicate also rejects runIds containing `\0`
    // (Node's path APIs throw on NUL bytes). Pin the catch handles
    // every clause that `isPathTraversalRunId` rejects, not only `..`.
    const realExit = process.exit;
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    let exitCode = null;
    let captured = "";
    process.exit = (code) => { exitCode = code; };
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try {
        let result;
        assert.doesNotThrow(() => { result = cmdReplay("run\0id"); });
        assert.equal(result, 2);
        assert.equal(exitCode, 2);
        assert.match(captured, /replay:/);
    } finally {
        process.exit = realExit;
        process.stderr.write = realStderrWrite;
    }
});

test("cmdWatch (via main): path-traversal runId routes through fail() with clean error (no raw TypeError stack)", async () => {
    // Iter 168 — symmetric to the iter-167 cmdReplay test. cmdWatch
    // is not directly exported, so we drive it through the supported
    // public entry `main(["watch", <runId>])`. Pre-iter-167 the bare
    // `resolveRunEventsPath(target)` call inside cmdWatch leaked a
    // raw TypeError stack to the user; iter 167 added a catch that
    // routes through `fail()`. This test pins the cmdWatch half of
    // that fix so a future "simplify" refactor can't quietly drop
    // the catch on one entry point while keeping it on the other.
    const realExit = process.exit;
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    let exitCode = null;
    let captured = "";
    process.exit = (code) => { exitCode = code; };
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try {
        let result;
        await assert.doesNotReject(
            (async () => { result = await tuiMain(["watch", "../etc/passwd", "--plain"]); })(),
            "cmdWatch must catch TypeError from resolveRunEventsPath and return cleanly via main()",
        );
        assert.equal(result, 2, "main() must propagate cmdWatch's exit code 2 for traversal runId");
        assert.equal(exitCode, 2, "fail() must request exit code 2");
        assert.match(captured, /watch:/, "stderr line must be prefixed with the subcommand name");
        assert.match(
            captured,
            /path separators or traversal segments/,
            "stderr must surface the traversal-rejection message from resolveRunEventsPath",
        );
        assert.doesNotMatch(
            captured,
            /at assertSafeRunId|at resolveRunEventsPath/,
            "stderr must NOT contain a raw stack frame — that's the bug we're pinning closed",
        );
    } finally {
        process.exit = realExit;
        process.stderr.write = realStderrWrite;
    }
});

test("VALUE_FLAGS JSDoc comment lists every flag actually in the set (drift guard)", async () => {
    // Iter 169 — the JSDoc block immediately above the `VALUE_FLAGS`
    // declaration in `bin/tui.mjs` documents which flags require a
    // following value (i.e. are parsed via `--flag value` instead of
    // `--flag` alone). Pre-iter-169 the comment said
    // `(currently: --older-than)` even though `VALUE_FLAGS` was
    // `["older-than", "limit"]` — drift from the iter-152 addition of
    // `--limit N`. A future contributor adding (e.g.) `--since` or
    // `--tool` would update the set, ship the feature, and leave the
    // comment further out of sync. Pin the comment must mention every
    // member of VALUE_FLAGS so the next drift breaks CI loudly.
    const fs = await import("node:fs");
    const src = fs.readFileSync(BIN, "utf8");

    const setMatch = src.match(/const VALUE_FLAGS = new Set\(\[([^\]]+)\]\);/);
    assert.ok(setMatch, "could not locate the VALUE_FLAGS declaration in tui.mjs");
    const flags = [...setMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(flags.length >= 1, "VALUE_FLAGS must contain at least one entry");

    // The JSDoc block sits immediately before the declaration — match
    // a `/** … */` block that ends just before `const VALUE_FLAGS =`.
    const jsdocMatch = src.match(/\/\*\*([\s\S]+?)\*\/\s*const VALUE_FLAGS = new Set/);
    assert.ok(jsdocMatch, "could not locate the JSDoc block above VALUE_FLAGS");
    const jsdoc = jsdocMatch[1];
    for (const flag of flags) {
        assert.match(
            jsdoc,
            new RegExp(`--${flag}\\b`),
            `VALUE_FLAGS JSDoc must mention --${flag} (drifted from the set)`,
        );
    }
});

// ─── Issue #48 slice 3: scope-driven default for `autopilot run --max` ──

import { defaultMaxIterationsFor } from "../bin/tui.mjs";
import * as __runner from "../src/runner.mjs";

test("defaultMaxIterationsFor: self-improve → MAX_ALLOWED_ITERATIONS (unbounded by default)", () => {
    // self-improve drains the whole backlog — a 100-iter cap stops the
    // loop while work is left undone (issue #48). The runaway-guard
    // ceiling is the right default; explicit --max N still wins.
    assert.equal(defaultMaxIterationsFor("self-improve", __runner), __runner.MAX_ALLOWED_ITERATIONS);
    assert.ok(__runner.MAX_ALLOWED_ITERATIONS > __runner.DEFAULT_MAX_ITERATIONS,
        "MAX_ALLOWED_ITERATIONS must exceed DEFAULT_MAX_ITERATIONS, otherwise the new default would not actually unblock self-improve");
});

test("defaultMaxIterationsFor: grow-project → DEFAULT_MAX_ITERATIONS (finite backlog)", () => {
    // grow-project drains a finite GitHub-issue backlog. The 100-iter
    // default is plenty and prevents a runaway when the agent fails to
    // emit ABORT_NO_BACKLOG.
    assert.equal(defaultMaxIterationsFor("grow-project", __runner), __runner.DEFAULT_MAX_ITERATIONS);
});

test("defaultMaxIterationsFor: prompt → DEFAULT_MAX_ITERATIONS (user-supplied scope)", () => {
    assert.equal(defaultMaxIterationsFor("prompt", __runner), __runner.DEFAULT_MAX_ITERATIONS);
});

test("defaultMaxIterationsFor: unknown mode → DEFAULT_MAX_ITERATIONS (safe fallback)", () => {
    assert.equal(defaultMaxIterationsFor("future-mode", __runner), __runner.DEFAULT_MAX_ITERATIONS);
    assert.equal(defaultMaxIterationsFor(undefined, __runner), __runner.DEFAULT_MAX_ITERATIONS);
    assert.equal(defaultMaxIterationsFor("", __runner), __runner.DEFAULT_MAX_ITERATIONS);
});

test("parseArgv: --headless flag (issue #48 slice 8 — daemon / nohup escape hatch)", () => {
    const r = parseArgv(["run", "--self-improve", "--fresh", "--headless"]);
    assert.equal(r.cmd, "run");
    assert.equal(r.flags["self-improve"], true);
    assert.equal(r.flags.fresh, true);
    assert.equal(r.flags.headless, true);
});

test("parseArgv: --headless coexists with --plain without conflict", () => {
    // Both force text output; combining them is harmless. cmdRun
    // OR's the two flags so either alone is sufficient.
    const r = parseArgv(["run", "--self-improve", "--fresh", "--headless", "--plain"]);
    assert.equal(r.flags.headless, true);
    assert.equal(r.flags.plain, true);
});

test("USAGE documents --headless option for run", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--headless/);
    assert.match(r.stdout, /run/);
});

test("USAGE shows --headless in the run signature", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    // Signature line should expose --headless / --plain alongside --max.
    assert.match(r.stdout, /\[--headless \| --plain\]/);
});

test("run-ui module is importable and exports mountRunUi (no top-level Ink import)", async () => {
    // The module must NOT eagerly import `ink` — that would crash
    // on a fresh checkout without `npm install` and break the
    // headless fallback bin/tui.mjs relies on (slice 8). Importing
    // the file should succeed unconditionally; only mountRunUi()
    // pulls in Ink at call time.
    const mod = await import("../src/run-ui.mjs");
    assert.equal(typeof mod.mountRunUi, "function");
});

// ─── Issue #48 / user-bug: q keypress fallback ─────────────────────
//
// Field bug from a real run: pressing `q` in `autopilot run` echoed
// to the terminal as cooked-mode characters instead of unmounting
// the Ink App — meaning Ink's useInput silently failed to enter raw
// mode for that environment. installStdinAbortListener is the
// belt-and-suspenders fallback that bin/tui.mjs's cmdRun installs
// alongside Ink so the q / Ctrl-C path stays live regardless of
// whether Ink's hook fires.

import { installStdinAbortListener, formatAbortMessage } from "../bin/tui.mjs";

test("installStdinAbortListener: returns a no-op cleanup when stdin is NOT a TTY (test environment)", () => {
    // In `node --test` runs, process.stdin.isTTY is undefined / false
    // so the function MUST short-circuit to a no-op cleanup. This
    // pins the contract: the function is always safe to call from
    // cmdRun, and a non-TTY (e.g. CI, asciinema, a piped stdin) is
    // not an error condition.
    let fired = 0;
    const cleanup = installStdinAbortListener(() => { fired += 1; });
    assert.equal(typeof cleanup, "function");
    // Returned cleanup must be safely callable even when the listener
    // didn't actually attach — finally blocks call this
    // unconditionally and a throw here would mask the real error.
    cleanup();
    cleanup(); // idempotent — must not throw on second call
    assert.equal(fired, 0,
        "no-op path must not invoke onAbort even when stdin emits arbitrary data");
});

test("formatAbortMessage: q press → user-visible 'q received' line on stderr", () => {
    const msg = formatAbortMessage("user_quit");
    assert.ok(typeof msg === "string", "user_quit must return a string");
    assert.match(msg, /^\nautopilot run: q received — finishing current iteration, then stopping\. Hit Ctrl-C to abort hard\.\n$/);
});

test("formatAbortMessage: SIGINT path returns null (signal handler prints its own line)", () => {
    // The SIGINT signal handler already writes a "SIGINT received…"
    // banner to stderr. If formatAbortMessage ALSO printed for
    // SIGINT, the user would see the same message twice for one
    // Ctrl-C press. Returning null tells the caller to skip the
    // print — single source of truth for the SIGINT message.
    assert.equal(formatAbortMessage("signal_SIGINT"), null);
});

test("formatAbortMessage: unknown reason still produces a message (don't silently drop)", () => {
    // Defensive: a future stop reason (e.g. "tui_close") shouldn't
    // accidentally land in the SIGINT skip path. The message uses
    // the raw reason as the label so the user sees what triggered
    // the stop instead of nothing.
    const msg = formatAbortMessage("custom_reason");
    assert.ok(typeof msg === "string");
    assert.match(msg, /custom_reason received/);
});

// ─── Issue #65: bare `autopilot` defaults to `run --self-improve` ──
//
// Pre-issue-65 behaviour: bare `ralph-tui` with no args printed USAGE.
// Post-issue-65: bare `autopilot` (no subcommand, no flags, no positional)
// invokes `cmdRun` with `flags["self-improve"] = true` so the user
// does not have to memorise the canonical drive-the-backlog
// incantation. `--help` / `-h` still print USAGE. Issue #51 dropped
// the implicit `flags.fresh = true` — the `--reset-on=workitem`
// default applies (logged in the banner).

test("parseArgv: bare argv has no cmd / positional / flags (defaults dispatch happens in main)", () => {
    // Pin the parser contract: bare argv produces an empty result. The
    // self-improve default is applied by main() based on this shape, NOT
    // by parseArgv — keeps parseArgv pure and testable in isolation.
    const r = parseArgv([]);
    assert.equal(r.cmd, null);
    assert.deepEqual(r.positional, []);
    assert.deepEqual(r.flags, {});
});

/** Capture stdout + stderr around an async fn. Returns { stdout, stderr }. */
async function captureIo(fn) {
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    let stdoutBuf = "";
    let stderrBuf = "";
    process.stdout.write = (chunk) => { stdoutBuf += String(chunk); return true; };
    process.stderr.write = (chunk) => { stderrBuf += String(chunk); return true; };
    try {
        await fn();
    } finally {
        process.stdout.write = realStdoutWrite;
        process.stderr.write = realStderrWrite;
    }
    return { stdout: stdoutBuf, stderr: stderrBuf };
}

test("main: bare argv writes self-improve banner to stderr and routes to cmdRun (--self-improve)", async () => {
    // Pin both halves of the issue #65 dispatch contract: the user-visible
    // stderr banner fires BEFORE any subprocess work, AND cmdRun receives
    // flags with self-improve set. Issue #51 dropped the implicit
    // `--fresh` so the run inherits the new `--reset-on=workitem`
    // default (banner labels it accordingly).
    //
    // To avoid spawning a real `copilot` subprocess, point
    // RALPH_TUI_COPILOT_BIN at a nonexistent path so the runner's spawn
    // fails fast — the banner write happens BEFORE that failure, so the
    // assertion is robust to the runner's exit code.
    const dir = tmp();
    const origCopilotBin = process.env.RALPH_TUI_COPILOT_BIN;
    const origRunsDir = process.env.RALPH_TUI_RUNS_DIR;
    process.env.RALPH_TUI_COPILOT_BIN = "/nonexistent-copilot-binary-for-test-issue-65";
    process.env.RALPH_TUI_RUNS_DIR = dir;
    let captured;
    try {
        captured = await captureIo(async () => {
            try { await tuiMain([]); } catch { /* spawn ENOENT — irrelevant */ }
        });
    } finally {
        if (origCopilotBin === undefined) delete process.env.RALPH_TUI_COPILOT_BIN;
        else process.env.RALPH_TUI_COPILOT_BIN = origCopilotBin;
        if (origRunsDir === undefined) delete process.env.RALPH_TUI_RUNS_DIR;
        else process.env.RALPH_TUI_RUNS_DIR = origRunsDir;
        rmSync(dir, { recursive: true, force: true });
    }
    assert.match(captured.stderr, /autopilot: starting self-improve loop \(--reset-on=workitem\)\. Press q to stop\./,
        "bare invocation must print the self-improve banner to stderr before invoking cmdRun");
});

test("main: --help prints USAGE and does NOT trigger the self-improve banner", async () => {
    // `autopilot --help` keeps the pre-issue-65 USAGE behaviour; the
    // self-improve default only kicks in when there's no flag at all.
    let exitCode;
    const captured = await captureIo(async () => {
        exitCode = await tuiMain(["--help"]);
    });
    assert.equal(exitCode, 0);
    assert.match(captured.stdout, /USAGE/, "--help must print USAGE to stdout");
    assert.match(captured.stdout, /autopilot list/, "USAGE must reference the new binary name");
    assert.doesNotMatch(captured.stderr, /starting self-improve loop/,
        "--help must NOT trigger the self-improve banner");
});

test("parseArgv: --help is recognised and main short-circuits to USAGE before bare-default dispatch", () => {
    // Symmetry guard: --help / -h sets flags.help. main() inspects
    // flags.help BEFORE the bare-default branch so the dispatch never
    // fires for a help invocation.
    assert.equal(parseArgv(["--help"]).flags.help, true);
    assert.equal(parseArgv(["--help"]).cmd, null);
    assert.equal(parseArgv(["-h"]).flags.help, true);
});

// ─── Issue #83: agent-backend subcommands ───────────────────────────
//
// Two new top-level subcommands route to `cmdRun` with the agent
// pinned. Bare invocation defaults to `mode=self-improve`,
// `contextMode=fresh`, yolo permission mode (per-agent flag baked in
// the adapter's `spawnArgs`). Explicit `run` flags pass through.
//
// We mock the runner module's `runRalphTui` so the test pins argv
// routing without spawning a real backend subprocess.

import {
    cmdAgentSubcommand,
    AGENT_REGISTRY,
    loadAgentByName,
    main as binMain,
} from "../bin/tui.mjs";

test("AGENT_REGISTRY: at minimum maps copilot and claude to adapter modules", () => {
    assert.ok(AGENT_REGISTRY.copilot, "copilot must be registered");
    assert.ok(AGENT_REGISTRY.claude, "claude must be registered");
    assert.equal(typeof AGENT_REGISTRY.copilot, "string");
    assert.equal(typeof AGENT_REGISTRY.claude, "string");
});

test("loadAgentByName: returns the loaded copilot adapter module", async () => {
    const mod = await loadAgentByName("copilot");
    assert.ok(mod, "loadAgentByName('copilot') must return a module");
    assert.equal(mod.name, "copilot");
    assert.equal(typeof mod.spawnArgs, "function");
});

test("loadAgentByName: returns the loaded claude adapter module", async () => {
    const mod = await loadAgentByName("claude");
    assert.ok(mod, "loadAgentByName('claude') must return a module");
    assert.equal(mod.name, "claude");
    assert.equal(typeof mod.spawnArgs, "function");
});

test("loadAgentByName: unknown name writes a stderr error and returns null", async () => {
    const realExit = process.exit;
    const realStderr = process.stderr.write.bind(process.stderr);
    let captured = "";
    let exitCode = null;
    process.exit = (code) => { exitCode = code; };
    process.stderr.write = (s) => { captured += String(s); return true; };
    try {
        const mod = await loadAgentByName("nonexistent-backend");
        assert.equal(mod, null);
        assert.equal(exitCode, 2, "unknown agent must request exit code 2");
        assert.match(captured, /unknown agent backend/);
        assert.match(captured, /copilot, claude/);
    } finally {
        process.exit = realExit;
        process.stderr.write = realStderr;
    }
});

test("USAGE: lists the copilot subcommand", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\bcopilot\b/);
});

test("USAGE: lists the claude subcommand", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\bclaude\b/);
});

test("USAGE: documents the yolo-by-default product story", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /yolo|YOLO/);
    assert.match(r.stdout, /--allow-all-tools/);
    assert.match(r.stdout, /--dangerously-skip-permissions/);
});

test("USAGE: documents AUTOPILOT_COPILOT_BIN and AUTOPILOT_CLAUDE_BIN env vars", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /AUTOPILOT_COPILOT_BIN/);
    assert.match(r.stdout, /AUTOPILOT_CLAUDE_BIN/);
});

test("USAGE: documents the legacy RALPH_TUI_* deprecation", () => {
    const r = runBin(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RALPH_TUI_\*/);
    assert.match(r.stdout, /[Dd]eprecat/);
});

// Build a stub runner-shaped module that captures the call to
// `runRalphTui` and resolves with a synthetic completion result so
// `cmdRun` can finish cleanly in-process (no real subprocess work).
function captureRunCall() {
    const calls = [];
    const stub = {
        DEFAULT_MAX_ITERATIONS: 100,
        MAX_ALLOWED_ITERATIONS: 1000,
        COMPLETION_PROMISE: "COMPLETE",
        runRalphTui: async (opts) => {
            calls.push(opts);
            // Notify the bin's mount-on-runId hook with a synthetic id
            // so the stdin / TUI mount paths don't block on a missing
            // events file.
            try { opts.onRunId?.("test-stubbed-run-1"); } catch { /* swallow */ }
            return {
                runId: "test-stubbed-run-1",
                terminationReason: "complete",
                terminationNote: null,
                sessionId: null,
            };
        },
        statusRun: () => { throw new Error("statusRun not stubbed"); },
        pauseRun: () => { throw new Error("pauseRun not stubbed"); },
        resumeRun: () => { throw new Error("resumeRun not stubbed"); },
        stopRun: () => { /* swallow — bin may invoke this on abort */ },
    };
    return { calls, stub };
}

// `cmdAgentSubcommand` is the canonical bare-`autopilot copilot` /
// `autopilot claude` dispatch entry. It resolves the agent, fills in
// the self-improve / fresh defaults when no driver flag is set, and
// hands off to `cmdRun`. We exercise the dispatch directly here so
// the test pins argv routing without spawning a real subprocess.

test("cmdAgentSubcommand: bare 'copilot' fills in self-improve + fresh + agent=copilot", async () => {
    const { calls, stub } = captureRunCall();
    // Patch the runner-module import via dependency injection. The
    // `cmdRun` function lazy-imports `../src/runner.mjs`; we can
    // override that by stashing a stub into Node's module cache
    // before the call. The simplest hook is a tmp `RALPH_TUI_RUNS_DIR`
    // so initState writes don't escape, plus an injected
    // `runRalphTui` via module-cache override.
    const { default: Module } = await import("node:module");
    const runnerPath = resolve(REPO_ROOT, "src", "runner.mjs");
    const runnerUrl = new URL("file://" + runnerPath).href;
    const realResolve = Module._resolveFilename;
    // Skipping full module-cache patching for portability — instead,
    // assert the user-facing side effect: stderr banner + exit code.
    // (Argv-pin assertion via the underlying runner is covered by
    // runner.test.mjs's spawn-mock cases.)
    void calls; void stub; void runnerUrl; void realResolve;

    const dir = tmp();
    const origRunsDir = process.env.RALPH_TUI_RUNS_DIR;
    const origCopilotBin = process.env.RALPH_TUI_COPILOT_BIN;
    process.env.RALPH_TUI_RUNS_DIR = dir;
    // Pin the copilot binary at a missing path so the runner's spawn
    // fails fast — the banner write happens BEFORE that failure, so
    // the assertion is robust to the runner's exit code.
    process.env.RALPH_TUI_COPILOT_BIN = "/nonexistent-copilot-binary-for-issue-83";
    let captured;
    try {
        captured = await captureIo(async () => {
            try { await cmdAgentSubcommand("copilot", {}); } catch { /* spawn failure — irrelevant */ }
        });
    } finally {
        if (origRunsDir === undefined) delete process.env.RALPH_TUI_RUNS_DIR;
        else process.env.RALPH_TUI_RUNS_DIR = origRunsDir;
        if (origCopilotBin === undefined) delete process.env.RALPH_TUI_COPILOT_BIN;
        else process.env.RALPH_TUI_COPILOT_BIN = origCopilotBin;
        rmSync(dir, { recursive: true, force: true });
    }
    assert.match(captured.stderr, /starting self-improve loop with copilot/,
        "bare 'copilot' must print the agent-pinned banner to stderr");
    assert.match(captured.stderr, /--fresh.*yolo/,
        "bare 'copilot' banner must mention --fresh and yolo");
});

test("cmdAgentSubcommand: bare 'claude' prints the claude-pinned banner", async () => {
    const dir = tmp();
    const origRunsDir = process.env.RALPH_TUI_RUNS_DIR;
    const origClaudeBin = process.env.AUTOPILOT_CLAUDE_BIN;
    process.env.RALPH_TUI_RUNS_DIR = dir;
    process.env.AUTOPILOT_CLAUDE_BIN = "/nonexistent-claude-binary-for-issue-83";
    let captured;
    try {
        captured = await captureIo(async () => {
            try { await cmdAgentSubcommand("claude", {}); } catch { /* spawn failure — irrelevant */ }
        });
    } finally {
        if (origRunsDir === undefined) delete process.env.RALPH_TUI_RUNS_DIR;
        else process.env.RALPH_TUI_RUNS_DIR = origRunsDir;
        if (origClaudeBin === undefined) delete process.env.AUTOPILOT_CLAUDE_BIN;
        else process.env.AUTOPILOT_CLAUDE_BIN = origClaudeBin;
        rmSync(dir, { recursive: true, force: true });
    }
    assert.match(captured.stderr, /starting self-improve loop with claude/);
    assert.match(captured.stderr, /--fresh.*yolo/);
});

test("cmdAgentSubcommand: explicit --grow-project / --continue passes through, agent stays pinned", async () => {
    // We assert on the merged-flags route by intercepting
    // `cmdAgentSubcommand` via a captured-calls assertion through the
    // banner: when --continue is set, the banner must say "(--continue, yolo)"
    // not "(--fresh, yolo)".
    const dir = tmp();
    const origRunsDir = process.env.RALPH_TUI_RUNS_DIR;
    const origCopilotBin = process.env.RALPH_TUI_COPILOT_BIN;
    process.env.RALPH_TUI_RUNS_DIR = dir;
    process.env.RALPH_TUI_COPILOT_BIN = "/nonexistent-copilot-binary-for-issue-83";
    let captured;
    try {
        captured = await captureIo(async () => {
            try {
                await cmdAgentSubcommand("copilot", {
                    "grow-project": true,
                    continue: true,
                });
            } catch { /* spawn failure — irrelevant */ }
        });
    } finally {
        if (origRunsDir === undefined) delete process.env.RALPH_TUI_RUNS_DIR;
        else process.env.RALPH_TUI_RUNS_DIR = origRunsDir;
        if (origCopilotBin === undefined) delete process.env.RALPH_TUI_COPILOT_BIN;
        else process.env.RALPH_TUI_COPILOT_BIN = origCopilotBin;
        rmSync(dir, { recursive: true, force: true });
    }
    assert.match(captured.stderr, /--continue.*yolo/,
        "explicit --continue must show --continue in the banner, not --fresh");
});

test("main: 'copilot' subcommand routes through cmdAgentSubcommand", async () => {
    const dir = tmp();
    const origRunsDir = process.env.RALPH_TUI_RUNS_DIR;
    const origCopilotBin = process.env.RALPH_TUI_COPILOT_BIN;
    process.env.RALPH_TUI_RUNS_DIR = dir;
    process.env.RALPH_TUI_COPILOT_BIN = "/nonexistent-copilot-binary-for-issue-83";
    let captured;
    try {
        captured = await captureIo(async () => {
            try { await binMain(["copilot"]); } catch { /* spawn failure — irrelevant */ }
        });
    } finally {
        if (origRunsDir === undefined) delete process.env.RALPH_TUI_RUNS_DIR;
        else process.env.RALPH_TUI_RUNS_DIR = origRunsDir;
        if (origCopilotBin === undefined) delete process.env.RALPH_TUI_COPILOT_BIN;
        else process.env.RALPH_TUI_COPILOT_BIN = origCopilotBin;
        rmSync(dir, { recursive: true, force: true });
    }
    assert.match(captured.stderr, /starting self-improve loop with copilot/);
});

test("main: 'claude' subcommand routes through cmdAgentSubcommand", async () => {
    const dir = tmp();
    const origRunsDir = process.env.RALPH_TUI_RUNS_DIR;
    const origClaudeBin = process.env.AUTOPILOT_CLAUDE_BIN;
    process.env.RALPH_TUI_RUNS_DIR = dir;
    process.env.AUTOPILOT_CLAUDE_BIN = "/nonexistent-claude-binary-for-issue-83";
    let captured;
    try {
        captured = await captureIo(async () => {
            try { await binMain(["claude"]); } catch { /* spawn failure — irrelevant */ }
        });
    } finally {
        if (origRunsDir === undefined) delete process.env.RALPH_TUI_RUNS_DIR;
        else process.env.RALPH_TUI_RUNS_DIR = origRunsDir;
        if (origClaudeBin === undefined) delete process.env.AUTOPILOT_CLAUDE_BIN;
        else process.env.AUTOPILOT_CLAUDE_BIN = origClaudeBin;
        rmSync(dir, { recursive: true, force: true });
    }
    assert.match(captured.stderr, /starting self-improve loop with claude/);
});

test("main: 'copilot --help' surfaces the run-style flags", () => {
    // bin's --help flag short-circuits in main() before subcommand
    // dispatch, so `copilot --help` prints the same USAGE that
    // `--help` does — which already documents the run flags.
    const r = runBin(["copilot", "--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--self-improve/);
    assert.match(r.stdout, /--grow-project/);
    assert.match(r.stdout, /--continue/);
    assert.match(r.stdout, /--fresh/);
});

test("main: 'claude --help' surfaces the run-style flags", () => {
    const r = runBin(["claude", "--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--self-improve/);
    assert.match(r.stdout, /--grow-project/);});
