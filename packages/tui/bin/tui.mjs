#!/usr/bin/env node
// Stdlib-only CLI entry for autopilot — the standalone TUI app that
// drives autonomous Copilot CLI loops (issue #22).
//
// Subcommands (keep in sync with the USAGE constant below — pinned by
// `tui.mjs header comment lists every USAGE subcommand` in
// packages/tui/test/bin-tui.test.mjs so a drift here surfaces in CI):
//   copilot                    — drive an iter loop with the GitHub
//                                Copilot CLI backend (issue #83).
//                                Bare invocation = self-improve /
//                                fresh / yolo (`--allow-all-tools`).
//                                Accepts the same flags as `run` for
//                                explicit overrides.
//   claude                     — same shape as `copilot`, but drives
//                                iters with Claude Code's CLI
//                                (`claude -p ... --dangerously-skip-permissions
//                                --output-format stream-json`).
//   list                       — show recorded runs (newest first;
//                                 `--json` for scripting/dashboards;
//                                 `--limit N` to cap the table).
//   replay <runId>             — print every event in a past run.
//   watch [runId] [--plain]    — tail the given run (or the most recent
//                                one if omitted) in real time.
//   doctor                     — diagnose the runs directory + writer
//                                wiring (permissions, malformed JSONL,
//                                stale lockfiles, broken symlinks).
//   prune [--older-than D]     — remove runs older than DURATION
//        [--dry-run]             (e.g. 30d / 12h / 5m; default 30d).
//                                `--dry-run` lists what would go.
//   stats                      — aggregate stats across the run index
//                                (run count, total iterations, p50/p95
//                                durations, top SDLC tools).
//   where                      — print the resolved runs root path so
//                                a contributor can `cd` into it.
//   run                        — drive a ralph_loop / self_improve /
//                                grow_project loop by spawning each
//                                iter as a fresh `copilot -p ...`
//                                subprocess. Choose exactly one prompt
//                                mode (`--self-improve` /
//                                `--grow-project` / `--prompt`) AND
//                                optionally a context-reset boundary
//                                (`--reset-on={workitem|iter|never}`,
//                                default `workitem`). Legacy
//                                `--continue` / `--fresh` flags map
//                                onto `--reset-on=never` /
//                                `--reset-on=iter` with a one-shot
//                                stderr deprecation notice.
//                                Sibling `--pause <runId>` /
//                                `--resume <runId>` / `--stop
//                                <runId>` / `--status <runId>` operate
//                                on the run state file of an in-flight
//                                loop.
//
// `--plain` is implied when stdout is not a TTY so CI logs and asciinema
// recordings produce stable, ANSI-free output.
//
// Commander is listed as a dep in this package's package.json for the
// Ink-rendered watch UI; this stub deliberately uses a hand-rolled
// parser so `node bin/tui.mjs` works straight from a fresh checkout
// with no `npm install`. Once the Ink renderer is loaded the watch
// command dynamically imports that module.

import process from "node:process";
import fs from "node:fs";
import nodePath from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import { readRunIndex, resolveRunsRoot, resolveRunEventsPath, parseDuration, pruneRuns, aggregateRuns } from "../src/writer.mjs";
import { readEventsFile, tailEventsFile } from "../src/tail.mjs";
import { formatEventLine } from "../src/plain.mjs";

const USAGE = `\
autopilot — terminal visualizer for ralph_loop runs (issue #22).

USAGE
  autopilot                                        (bare — defaults to
                                                    \`run --self-improve --fresh\`)
  autopilot copilot [run flags]                    (drive iters with
                                                    GitHub Copilot CLI;
                                                    bare = self-improve / fresh /
                                                    yolo, see ENV below)
  autopilot claude  [run flags]                    (drive iters with
                                                    Claude Code CLI;
                                                    bare = self-improve / fresh /
                                                    yolo, see ENV below)
  autopilot list [--json] [--limit N]
  autopilot replay <runId>
  autopilot watch [runId] [--plain]
  autopilot doctor
  autopilot prune [--older-than 30d] [--dry-run]
  autopilot stats
  autopilot where
  autopilot run (--self-improve | --grow-project | --prompt TEXT)
                [--reset-on={workitem|iter|never}]
                [--max N] [--min N] [--focus TEXT] [--headless | --plain]
                [--completion-promise TOKEN] [--abort-promise TOKEN]
  autopilot run --pause <runId>
  autopilot run --resume <runId>
  autopilot run --stop <runId>
  autopilot run --status <runId>
  autopilot --help | -h

OPTIONS
  --plain     Emit log lines instead of an interactive UI (auto-enabled
              when stdout is not a TTY, e.g. piped to a file or in CI).
  --headless  For \`run\`: same as --plain — force text output even on a
              TTY (handy for daemon / nohup / asciinema).
  --json      For \`list\`: emit the run index as a JSON array (one
              object per run, newest first) for scripting/dashboards.
  --older-than DURATION  For \`prune\`: only remove runs older than
              DURATION (e.g. 30d, 12h, 5m). Default 30d.
  --dry-run   For \`prune\`: list what would be removed; delete nothing.
  --self-improve  For \`run\`: drive the baked self_improve SDLC prompt.
  --grow-project  For \`run\`: drive the baked grow_project SDLC prompt.
  --prompt TEXT   For \`run\`: drive a ralph_loop-style custom prompt.
  --reset-on={workitem|iter|never}
              For \`run\`: when to start a fresh agent session.
              Default \`workitem\` — new session at each
              \`[WORKITEM_END]\` (or iter exit). \`iter\` resets every
              iter; \`never\` keeps one session for the whole run.
  --continue  Deprecated alias for \`--reset-on=never\` (one-shot
              stderr notice on first use).
  --fresh     Deprecated alias for \`--reset-on=iter\` (one-shot
              stderr notice on first use).
  --max N     For \`run\`: iteration cap (default 100; default 1000 —
              effectively unbounded — for --self-improve since the
              loop is scope-driven, not iter-driven; max 1000).
  --min N     For \`run\`: floor on iteration count BEFORE the runner
              honors the completion / abort tokens (default 1 — match
              the historical behavior). Tokens emitted on \`iter < N\`
              are logged and ignored, the loop keeps running. Pass
              \`--min 0\` as the "disable early-stop" sentinel: the
              loop runs all the way to --max, ignoring both tokens
              entirely. Useful for self-improve runs where the agent
              fat-iters through the whole SDLC and emits COMPLETE in
              iter 1 even though more passes were wanted. Must be 0
              or in [1, max]. NOTE: under the default --reset-on=workitem,
              extra iters start a fresh Copilot session each time —
              use --reset-on=never if you want N continuations of the
              SAME conversation rather than N independent retries.
  --focus TEXT  For \`run\`: focus suffix appended to the SDLC prompt
              (max 2000 chars). Ignored when --prompt is set.
  --completion-promise TOKEN  For \`run\`: substring whose presence in
              an iter's response signals completion. Default
              \`COMPLETE\`.
  --abort-promise TOKEN  For \`run\`: substring whose presence signals
              an early abort. Defaults to the baked abort token of the
              chosen prompt mode (or none for --prompt).
  --worktree  For \`run --prompt\`: opt in to per-iter git worktree
              isolation (default-on for --self-improve and
              --grow-project; merged iters tear down on END,
              unmerged ones are preserved on disk).
  --no-worktree  For \`run\`: disable per-iter worktree even for the
              modes where it is on by default.
  --help, -h  Show this help.
  --version, -V  Print the autopilot package version and exit.

YOLO BY DEFAULT (issue #83)
  The \`copilot\` and \`claude\` subcommands BOTH default to fully
  permissive ("yolo") mode so the loop can run unattended:
    copilot → \`copilot ... --allow-all-tools\`
    claude  → \`claude ... --dangerously-skip-permissions\`
  An autopilot loop that prompts for permissions every tool call is
  not really an autopilot.

ENV
  AUTOPILOT_RUNS_DIR  Override the runs root (default
                    ~/.copilot/autopilot/runs). Holds events.jsonl,
                    index.jsonl, and per-run state.json. On first run,
                    if the new default does not exist but
                    ~/.copilot/ralph-tui/runs does, autopilot reads
                    from the legacy path (with a one-shot stderr
                    migration notice).
  AUTOPILOT_COPILOT_BIN  Override the \`copilot\` executable used by
                    \`autopilot copilot\` / \`autopilot run\` (default
                    \`copilot\` on $PATH).
  AUTOPILOT_CLAUDE_BIN   Override the \`claude\` executable used by
                    \`autopilot claude\` (default \`claude\` on $PATH).
  Legacy RALPH_TUI_* names are still read for one release with a one-line stderr deprecation notice.
`;

/** Minimal argv parser. Returns { cmd, positional[], flags{} }.
 *  Supports `--flag`, `--flag=value`, and `--flag value` for the
 *  known value-taking flags listed in `VALUE_FLAGS` below
 *  (currently: --older-than for `prune`, --limit for `list`, plus
 *  the `run` subcommand's --max, --min, --focus, --prompt,
 *  --completion-promise, --abort-promise, --reset-on, --pause,
 *  --resume, --stop, --status). When adding a new value flag, append
 *  it to `VALUE_FLAGS` AND update the USAGE block above so
 *  `autopilot --help` keeps matching the parser. */
const VALUE_FLAGS = new Set(["older-than", "limit", "max", "min", "focus", "prompt", "completion-promise", "abort-promise", "pause", "resume", "stop", "status", "reset-on"]);

/** Default `--max` iterations per loop mode for `autopilot run`.
 *
 *  `self-improve` has no fixed scope: the agent's job is to drain the
 *  entire backlog (failing CI runs, stale PRs, open issues, latent
 *  improvements) and then assert ABORT_NO_IMPROVEMENTS. A 100-iter cap
 *  makes the loop quit before the work is done, which is exactly the
 *  failure mode issue #48 is fixing. So the default is the
 *  runaway-guard ceiling (MAX_ALLOWED_ITERATIONS = 1000) — explicit
 *  `--max N` still wins, and the renderer shows "iter X of ∞" when
 *  the effective max is the ceiling.
 *
 *  `grow-project` drains a finite GitHub-issue backlog and `prompt`
 *  takes a user-supplied scope (often a one-shot task); both keep
 *  the conservative DEFAULT_MAX_ITERATIONS = 100 default. */
export function defaultMaxIterationsFor(mode, runner) {
    if (mode === "self-improve") return runner.MAX_ALLOWED_ITERATIONS;
    return runner.DEFAULT_MAX_ITERATIONS;
}

export function parseArgv(argv) {
    const out = { cmd: null, positional: [], flags: {} };
    const args = [...argv];
    while (args.length) {
        const a = args.shift();
        if (a === "--help" || a === "-h") { out.flags.help = true; continue; }
        if (a === "--version" || a === "-V") { out.flags.version = true; continue; }
        if (a === "--plain") { out.flags.plain = true; continue; }
        if (a === "--no-plain") { out.flags.plain = false; continue; }
        if (a === "--worktree") { out.flags.worktree = true; continue; }
        if (a === "--no-worktree") { out.flags.worktree = false; continue; }
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            if (eq !== -1) {
                out.flags[a.slice(2, eq)] = a.slice(eq + 1);
                continue;
            }
            const key = a.slice(2);
            if (VALUE_FLAGS.has(key) && args.length && !args[0].startsWith("--")) {
                out.flags[key] = args.shift();
                continue;
            }
            out.flags[key] = true;
            continue;
        }
        if (!out.cmd) { out.cmd = a; continue; }
        out.positional.push(a);
    }
    return out;
}

function isTTY() {
    return Boolean(process.stdout && process.stdout.isTTY);
}

function isStdinTTY() {
    return Boolean(process.stdin && process.stdin.isTTY);
}

/** Install a stdlib keypress listener on process.stdin that fires
 *  `onAbort(reason)` exactly once when the user hits `q` / `Q` /
 *  Ctrl-C. Belt-and-suspenders for `cmdRun`'s Ink mount: if Ink's
 *  `useInput` ever silently fails to enter raw mode (we have field
 *  reports of `q` echoing to the terminal as cooked-mode input
 *  instead of unmounting the App, leaving the loop orphaned and
 *  forcing the user into a double-Ctrl-C — which then triggered
 *  cooked-mode SIGINT-on-stdin), this parallel listener still
 *  catches the keystroke. Both Ink's `useInput` AND this listener
 *  receive the byte (Node's stream emitter delivers `data` events
 *  to every subscriber); whichever fires first wins, and the
 *  shared `onAbort` is idempotent at the runner.stopRun level.
 *
 *  We deliberately enable raw mode ourselves here BEFORE Ink mounts
 *  so the keystroke path is guaranteed live — Ink's own
 *  setRawMode(true) call on useInput-effect-mount is then a no-op
 *  (idempotent), but the inversion (Ink fails, we succeed) is the
 *  failure mode this guards against.
 *
 *  Returned `cleanup()` is idempotent — safe to call from finally
 *  blocks even if the keystroke already fired and stdin is paused.
 *
 *  Exported for testing.
 *
 *  @param {(reason: string) => void} onAbort
 *  @returns {() => void} cleanup
 */
export function installStdinAbortListener(onAbort) {
    if (!isStdinTTY()) return () => {};
    let fired = false;
    let cleaned = false;

    // emitKeypressEvents is a no-op if already wired; it is the
    // documented stdlib path to receive `keypress` events on stdin.
    try { readline.emitKeypressEvents(process.stdin); } catch { /* swallow */ }
    // Raw mode lets us receive single keystrokes (q without Enter,
    // \x03 for Ctrl-C). Ink's useInput will also call setRawMode(true)
    // on mount; idempotent. If Ink's effect never runs (the bug),
    // this call alone keeps stdin in raw mode.
    try { process.stdin.setRawMode(true); } catch { /* swallow */ }
    process.stdin.resume();

    const handler = (str, key) => {
        if (fired) return;
        const isQuit = (typeof str === "string" && (str === "q" || str === "Q"))
            || (key && (key.name === "q"));
        const isCtrlC = (key && key.ctrl && key.name === "c")
            || str === "\x03";
        if (!isQuit && !isCtrlC) return;
        fired = true;
        try { onAbort(isCtrlC ? "signal_SIGINT" : "user_quit"); }
        catch { /* swallow */ }
        // For Ctrl-C in raw mode, the byte \x03 is consumed by stdin
        // and the kernel does NOT generate SIGINT (that's cooked-mode
        // behaviour). We synthesise SIGINT to the parent process so
        // the existing installSignal() handler also runs — that
        // handler prints the user-visible "SIGINT received — finishing
        // current iteration, then stopping" message and gates a
        // double-Ctrl-C into a hard process.exit(130). Without this
        // re-raise, a stuck iter would leave the user with no way to
        // hard-abort short of sending SIGTERM from another shell.
        if (isCtrlC) {
            try { process.kill(process.pid, "SIGINT"); } catch { /* swallow */ }
        }
    };
    process.stdin.on("keypress", handler);

    return () => {
        if (cleaned) return;
        cleaned = true;
        try { process.stdin.off("keypress", handler); } catch { /* swallow */ }
        try { if (process.stdin.isTTY) process.stdin.setRawMode(false); }
        catch { /* swallow */ }
        try { process.stdin.pause(); } catch { /* swallow */ }
    };
}

function fail(msg, code = 2) {
    process.stderr.write(`autopilot: ${msg}\n`);
    process.exit(code);
}

// Issue #51 — one-shot stderr deprecation notice for the legacy
// `--continue` / `--fresh` flags. The flag itself keeps working
// (mapped to `--reset-on=never` / `--reset-on=iter`) for one
// release; the notice prints exactly once per process even if a
// caller passes the flag twice (no-op by argv parser, but defensive).
// Module-level guard so the same process can't print the same
// message twice across multiple `cmdRun` invocations either.
const _deprecationWarned = new Set();
export function warnDeprecatedFlagOnce(flag, mapping, sink = process.stderr) {
    if (_deprecationWarned.has(flag)) return;
    _deprecationWarned.add(flag);
    sink.write?.(`autopilot run: --${flag} is deprecated; use --reset-on=${mapping} instead. ` +
        `--${flag} will be removed in a future release.\n`);
}

// One-shot stderr nudge when the user pairs --reset-on=iter (or its
// deprecated --fresh alias) with one of the SDLC modes. Each iter
// starts a fresh Copilot session and the SDLC prompts are
// one-step-per-iter — without help, the agent can't tell what state
// the cursor is in. The runner now injects a [CURSOR_STATE]
// preamble to compensate, so this is no longer a bug; we still
// warn because the default --reset-on=workitem is cheaper (the
// preamble is best-effort and a continuous session is the
// belt-and-suspenders choice for these multi-stage workflows).
const _iterResetSelfImproveWarned = new Set();
export function warnIterResetSelfImproveOnce(mode, sink = process.stderr) {
    if (_iterResetSelfImproveWarned.has(mode)) return;
    _iterResetSelfImproveWarned.add(mode);
    sink.write?.(
        `autopilot run: --reset-on=iter with --${mode} starts a fresh Copilot session every iter, `
        + `which loses cursor memory between one-step-per-iter SDLC stages. The runner injects a `
        + `[CURSOR_STATE] preamble to compensate, but the default --reset-on=workitem is recommended.\n`,
    );
}

// Test-only hook so the bin.test.mjs cases for the deprecation
// notice can run independently. The `__test__` bag is the
// project-wide convention for "tests can reach in but library
// users should not" — see also writer.mjs.
export const __test__ = {
    resetDeprecationWarnings: () => {
        _deprecationWarned.clear();
        _iterResetSelfImproveWarned.clear();
    },
};

/** Format the user-visible message printed when the user requests
 *  abort via `q` (or, in the future, any other voluntary stop
 *  reason). Returns `null` for `signal_SIGINT` because the SIGINT
 *  handler already prints its own line — printing twice would just
 *  be noise.
 *
 *  Field bug from a real run: pressing `q` in `autopilot run` left
 *  the static last Ink frame on screen with no further output, since
 *  the runner only checks `stopRequested` between iters and won't
 *  kill the in-flight copilot subprocess. Users perceived this as
 *  "q is broken" and fell back to Ctrl-C. Printing an immediate
 *  message to stderr (below the now-static Ink frame) makes the
 *  effect visible: the keystroke WAS captured, the run will stop
 *  at the next iter boundary, and the user knows to hit Ctrl-C if
 *  they need a hard abort.
 *
 *  Pure / no I/O so the formatting contract can be unit-tested
 *  without exercising the full TTY + Ink + runner pipeline.
 *
 *  @param {string} reason - "user_quit" | "signal_SIGINT" | other
 *  @returns {string|null} Newline-delimited message ready for
 *      stderr.write, or null if the caller should skip the print.
 */
export function formatAbortMessage(reason) {
    // SIGINT already prints its own line via the signal handler
    // installed in cmdRun — don't double up.
    if (reason === "signal_SIGINT") return null;
    const label = reason === "user_quit" ? "q" : reason;
    return `\nautopilot run: ${label} received — finishing current iteration, then stopping. Hit Ctrl-C to abort hard.\n`;
}

function cmdList(opts = {}) {
    let entries = readRunIndex();
    if (opts.limit !== undefined) {
        if (opts.limit === true) {
            fail(`list: --limit requires a value (e.g. --limit 5)`);
            return 2;
        }
        const s = String(opts.limit).trim();
        const n = Number(s);
        if (s === "" || !Number.isInteger(n) || n < 0) {
            fail(`list: invalid --limit '${opts.limit}' (expected non-negative integer)`);
            return 2;
        }
        entries = entries.slice(0, n);
    }
    if (opts.json) {
        // Emit a stable JSON array (newest first) for scripts/dashboards.
        // Empty index → "[]\n" so consumers can JSON.parse unconditionally.
        process.stdout.write(JSON.stringify(entries) + "\n");
        return 0;
    }
    if (!entries.length) {
        process.stdout.write(
            `No runs found.\nRoot: ${resolveRunsRoot()}\n`
            + `Arm a ralph_loop / self_improve / grow_project run, then re-run \`autopilot list\`.\n`,
        );
        return 0;
    }
    process.stdout.write(`# ${entries.length} run${entries.length === 1 ? "" : "s"} (newest first)\n`);
    for (const e of entries) {
        process.stdout.write(formatEventLine({ ...e, type: "armed" }) + "\n");
    }
    return 0;
}

// Iter 171 — `resolveRunEventsPath` throws TypeError for path-traversal
// runIds (`../etc/passwd`, NUL bytes, etc; see writer.mjs's
// `assertSafeRunId`). Both `cmdReplay` (iter 167) and `cmdWatch`
// (iter 168) duplicated a near-identical try/catch wrapper that
// emitted a clean one-line error via `fail()` and returned exit
// code 2. Centralising the wrapper here keeps the two call sites a
// single line apiece and means a future tweak (a new traversal
// clause raising a different error type, or a third command needing
// the same guard) lands in one place rather than drifting between
// two. Returns the resolved events path on success, or `null` if
// the caller should bail with exit code 2 (the helper already
// invoked `fail()` for the user-facing error).
function safeResolveEventsPath(label, runId) {
    try {
        return resolveRunEventsPath(runId);
    } catch (err) {
        if (err instanceof TypeError) {
            fail(`${label}: ${err.message}`);
            return null;
        }
        throw err;
    }
}

export function cmdReplay(runId) {
    if (!runId) {
        fail("replay: <runId> is required (try `autopilot list` first)");
        return 2;
    }
    const path = safeResolveEventsPath("replay", runId);
    if (path === null) return 2;
    const events = readEventsFile(path);
    if (!events.length) {
        process.stdout.write(`No events for run ${runId} (looked at ${path}).\n`);
        return 0;
    }
    for (const ev of events) {
        process.stdout.write(formatEventLine(ev) + "\n");
    }
    return 0;
}

async function cmdWatch(runId, opts) {
    let target = runId;
    if (!target) {
        const entries = readRunIndex();
        if (!entries.length) {
            fail("watch: no runs to watch — arm a loop first.");
            return 2;
        }
        target = entries[0].runId;
    }
    const path = safeResolveEventsPath("watch", target);
    if (path === null) return 2;
    const plain = opts.plain || !isTTY();
    if (!plain) {
        // The Ink renderer (slice 5) lives behind a dynamic import so a
        // missing user-space dep falls back to plain mode rather than
        // crashing the CLI on a fresh checkout.
        try {
            const mod = await import("../src/watch.mjs");
            return await mod.runInteractive({ runId: target, eventsPath: path });
        } catch (err) {
            if (err && err.code !== "ERR_MODULE_NOT_FOUND") throw err;
            // Fall through to plain mode.
        }
    }
    process.stdout.write(`# watching ${target}\n# ${path}\n`);
    for await (const ev of tailEventsFile(path)) {
        process.stdout.write(formatEventLine(ev) + "\n");
    }
    return 0;
}

export function cmdDoctor() {
    const root = resolveRunsRoot();
    const indexPath = nodePath.join(root, "index.jsonl");
    let healthy = true;
    const lines = [];

    // runs root
    let rootStatus;
    let rootWritable = false;
    if (!fs.existsSync(root)) {
        rootStatus = "missing (will be created on first run)";
    } else {
        try {
            fs.accessSync(root, fs.constants.W_OK);
            rootStatus = "ok (writable)";
            rootWritable = true;
        } catch {
            rootStatus = "UNWRITABLE";
            healthy = false;
        }
    }
    lines.push(`runs root: ${root}`);
    lines.push(`           ${rootStatus}`);

    // run index
    let indexStatus;
    let runCount = 0;
    if (!fs.existsSync(indexPath)) {
        indexStatus = "missing (no runs recorded yet)";
    } else {
        try {
            fs.accessSync(indexPath, fs.constants.R_OK);
            indexStatus = "ok (readable)";
        } catch {
            indexStatus = "UNREADABLE";
            healthy = false;
        }
    }
    lines.push(`run index: ${indexPath}`);
    lines.push(`           ${indexStatus}`);

    // runs found
    if (rootWritable || (fs.existsSync(indexPath) && healthy)) {
        try {
            runCount = readRunIndex().length;
        } catch {
            runCount = 0;
        }
    }
    lines.push(`runs found: ${runCount}`);

    // node + tui version
    lines.push(`node: ${process.version}`);
    lines.push(`tui version: ${readTuiVersion()}`);

    process.stdout.write(lines.join("\n") + "\n");
    if (!healthy) {
        process.stderr.write(
            `autopilot doctor: critical problem detected (root=${root}). `
            + `Check filesystem permissions and AUTOPILOT_RUNS_DIR.\n`,
        );
        return 1;
    }
    return 0;
}

export function cmdPrune(opts = {}) {
    const raw = typeof opts["older-than"] === "string" ? opts["older-than"] : "30d";
    const olderThanMs = parseDuration(raw);
    if (olderThanMs === null) {
        fail(`prune: invalid --older-than '${raw}' (expected e.g. 30d, 12h, 5m)`);
        return 2;
    }
    const dryRun = Boolean(opts["dry-run"]);
    const { removed, kept } = pruneRuns({ olderThanMs, dryRun });
    if (dryRun) {
        process.stdout.write(`# dry-run (older-than=${raw}); would remove ${removed.length}, keep ${kept}\n`);
    } else {
        process.stdout.write(`# pruned ${removed.length} run${removed.length === 1 ? "" : "s"} (older-than=${raw}); ${kept} kept\n`);
    }
    for (const r of removed) {
        process.stdout.write(`${dryRun ? "would remove" : "removed"} ${r.runId}\n`);
    }
    return 0;
}

export function cmdStats() {
    const stats = aggregateRuns();
    if (stats.total === 0) {
        process.stdout.write("No runs found.\n");
        return 0;
    }
    const lines = [];
    lines.push(`# Totals`);
    lines.push(`runs: ${stats.total}`);
    lines.push(`# By tool`);
    for (const [k, v] of Object.entries(stats.byTool).sort()) lines.push(`${k}: ${v}`);
    lines.push(`# By reason`);
    const reasons = Object.entries(stats.byReason).sort();
    if (reasons.length === 0) lines.push(`(no terminal events recorded)`);
    else for (const [k, v] of reasons) lines.push(`${k}: ${v}`);
    lines.push(`# Iterations`);
    lines.push(`mean: ${stats.iters.mean.toFixed(2)}`);
    lines.push(`max: ${stats.iters.max}`);
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
}

// Re-exported from the canonical `src/version.mjs` so the existing
// `--version` flag and `doctor` lines keep working unchanged. The
// shared module also feeds the live TUI Header (issue #59). We
// import the symbol AND re-export it so internal call sites in
// this module (the `--version` flag handler + `doctor` line) keep
// the bare-identifier reference they had pre-extraction.
import { readTuiVersion } from "../src/version.mjs";
export { readTuiVersion };

export function cmdWhere() {
    process.stdout.write(resolveRunsRoot() + "\n");
    return 0;
}

// Issue #83 — registry mapping subcommand-name → adapter-module-path
// so `cmdAgentSubcommand` (and `cmdRun`'s `agent:` flag handling) can
// resolve a CLI-string into the matching adapter. Stays a tiny string
// table so adding the next backend (Cursor / Aider / gemini-cli) is
// one line plus a new file under `src/agents/`.
export const AGENT_REGISTRY = {
    copilot: "../src/agents/copilot.mjs",
    claude: "../src/agents/claude.mjs",
};

/** Resolve an agent-name string to its loaded adapter module, or `null`
 *  if the name is unknown (after writing a stderr error so the caller
 *  can just propagate the `null` and bail). Lazy-imports the adapter
 *  on first use so non-`run` paths (e.g. `autopilot list`) pay no
 *  agent-init cost. */
export async function loadAgentByName(name) {
    const path = AGENT_REGISTRY[name];
    if (!path) {
        fail(`unknown agent backend: ${name} (expected one of: ${Object.keys(AGENT_REGISTRY).join(", ")})`);
        return null;
    }
    return await import(path);
}

// Sibling-command flags from `autopilot run`. Operating on an
// existing run's state.json (read or write) — distinct from the
// driver flags that launch a new loop. Centralised here so
// `cmdAgentSubcommand` and `cmdRun` share the same set.
const SIBLING_FLAGS = ["pause", "resume", "stop", "status"];

/** Pretty mode-label for the driver flag the user picked, falling
 *  back to "self-improve" (the default `cmdAgentSubcommand` fills
 *  in for bare invocations). Pure / no I/O so it's banner-friendly
 *  without needing the runner module loaded. */
function modeLabelFromFlags(flags) {
    if (flags["self-improve"]) return "self-improve";
    if (flags["grow-project"]) return "grow-project";
    if (flags.prompt !== undefined) return "prompt";
    return "self-improve";
}

/** Issue #83 — bare `autopilot copilot` / `autopilot claude` defaults
 *  to `run --self-improve --fresh` with the agent pinned. Explicit
 *  `run` flags (`--self-improve` / `--grow-project` / `--prompt`,
 *  `--continue` / `--fresh`, `--max`, etc.) are forwarded as-is so
 *  the subcommand is a drop-in replacement for `autopilot run` with
 *  the agent locked.
 *
 *  Pre-mount stderr banner mirrors the bare-`autopilot` startup line
 *  (see `main()` below) so the user has a one-line confirmation of
 *  which backend is about to drive the loop. The yolo callout is
 *  load-bearing: a user who didn't realise `--allow-all-tools` /
 *  `--dangerously-skip-permissions` is the default would have been
 *  surprised by tool calls landing without a confirm prompt.
 */
export async function cmdAgentSubcommand(agentName, flags) {
    const merged = { ...flags, agent: agentName };
    const hasSiblingFlag = SIBLING_FLAGS.some((k) => merged[k] !== undefined);
    const hasDriverFlag = merged["self-improve"]
        || merged["grow-project"]
        || merged.prompt !== undefined;
    // Bare invocation (no driver flag, no sibling flag) → default to
    // self-improve / fresh.
    if (!hasDriverFlag && !hasSiblingFlag) {
        merged["self-improve"] = true;
        // Don't override an explicit --continue.
        if (!merged.continue && !merged.fresh) merged.fresh = true;
    }
    // Banner only fires for loop-launch invocations — sibling
    // commands skip it because they're read/write operations on
    // existing run state, not loop launches.
    if (!hasSiblingFlag) {
        const ctxLabel = merged.continue ? "--continue" : "--fresh";
        const modeLabel = modeLabelFromFlags(merged);
        process.stderr.write(
            `autopilot: starting ${modeLabel} loop with ${agentName} (${ctxLabel}, yolo). Press q to stop.\n`,
        );
    }
    return await cmdRun(merged);
}

// `autopilot run` dispatcher. Splits into:
//   sibling sub-commands: --pause / --resume / --stop / --status <runId>
//                         (mutate or read state.json of an existing run)
//   driver:               --self-improve / --grow-project / --prompt
//                         (start a new loop; runs to completion in this
//                          process, with SIGINT/SIGTERM mapped to a
//                          graceful stop request)
//
// Issue #83 — `flags.agent` (when set) selects the backend adapter
// the runner should drive each iter with. Accepted values:
//   `"copilot"` (default — preserves pre-issue-83 behaviour) /
//   `"claude"` (Claude Code backend). The value is mapped to the
//   adapter module via `loadAgentByName`; an unknown value bails
//   with exit code 2 before any subprocess work fires.
export async function cmdRun(flags) {
    // Lazy-imported so a `autopilot list` invocation doesn't pay the
    // child_process / runner-module init cost.
    const runner = await import("../src/runner.mjs");
    const agent = flags.agent ? await loadAgentByName(flags.agent) : null;
    if (flags.agent && !agent) {
        // loadAgentByName already wrote the error to stderr.
        return 2;
    }

    // Sibling commands first — they require a runId argument and are
    // mutually exclusive with the driver flags.
    const sibling = SIBLING_FLAGS.find((k) => flags[k] !== undefined);
    if (sibling) {
        const runId = flags[sibling];
        if (!runId || runId === true) {
            fail(`run --${sibling}: <runId> is required (e.g. --${sibling} ralph-tui-self-improve-1700000000000)`);
            return 2;
        }
        try {
            const before = runner.statusRun(runId);
            let after;
            if (sibling === "status") after = before;
            else if (sibling === "pause") after = runner.pauseRun(runId);
            else if (sibling === "resume") after = runner.resumeRun(runId);
            else if (sibling === "stop") after = runner.stopRun(runId);
            const summary = `runId=${after.runId} mode=${after.mode} ctx=${after.contextMode} iter=${after.iter}/${after.max}`
                + (Number.isFinite(after.min) ? ` min=${after.min}` : "")
                + ` paused=${after.paused ? "yes" : "no"}`
                + ` stopRequested=${after.stopRequested ? "yes" : "no"}`
                + (after.terminated ? ` terminated=${after.terminationReason}` : "")
                + (after.sessionId ? ` sessionId=${after.sessionId}` : "");
            process.stdout.write(summary + "\n");
            return 0;
        } catch (err) {
            if (err instanceof TypeError) {
                fail(`run --${sibling}: ${err.message}`);
                return 2;
            }
            throw err;
        }
    }

    // Driver path — exactly one of --self-improve / --grow-project /
    // --prompt and exactly one of --continue / --fresh.
    let mode = null;
    if (flags["self-improve"]) mode = "self-improve";
    if (flags["grow-project"]) {
        if (mode) { fail(`run: choose exactly one of --self-improve / --grow-project / --prompt`); return 2; }
        mode = "grow-project";
    }
    if (flags.prompt !== undefined) {
        if (mode) { fail(`run: choose exactly one of --self-improve / --grow-project / --prompt`); return 2; }
        mode = "prompt";
    }
    if (!mode) {
        fail(`run: choose one of --self-improve / --grow-project / --prompt TEXT`);
        return 2;
    }
    if (mode === "prompt" && (flags.prompt === true || typeof flags.prompt !== "string" || !flags.prompt.trim())) {
        fail(`run --prompt: requires a non-empty string`);
        return 2;
    }

    // Issue #51 — `--reset-on={workitem|iter|never}` (default
    // `workitem`) replaces the binary `--continue` / `--fresh` flag.
    // Legacy flags continue to work as aliases with a one-shot
    // stderr deprecation notice; mixing the new flag with either
    // alias is a usage error so a stale script can't accidentally
    // half-migrate.
    const acceptedResetOn = runner.RESET_ON_VALUES;
    let resetOn = null;
    if (flags["reset-on"] !== undefined) {
        const v = flags["reset-on"];
        if (v === true || typeof v !== "string") {
            fail(`run --reset-on: requires a value of ${acceptedResetOn.join(", ")}`);
            return 2;
        }
        if (!acceptedResetOn.includes(v)) {
            fail(`run --reset-on: expected one of ${acceptedResetOn.join(", ")} (got '${v}')`);
            return 2;
        }
        resetOn = v;
    }
    if (flags.continue) {
        if (resetOn !== null) {
            fail(`run: --continue is a deprecated alias for --reset-on=never; pass only one`);
            return 2;
        }
        warnDeprecatedFlagOnce("continue", "never");
        resetOn = "never";
    }
    if (flags.fresh) {
        if (resetOn !== null) {
            fail(`run: --fresh is a deprecated alias for --reset-on=iter; pass only one of --reset-on / --continue / --fresh`);
            return 2;
        }
        warnDeprecatedFlagOnce("fresh", "iter");
        resetOn = "iter";
    }
    // Default: per-work-item resets. See the issue #51 design
    // discussion in the runner's header comment for why this is
    // the right default.
    if (resetOn === null) resetOn = "workitem";

    // Nudge users who paired --reset-on=iter with an SDLC mode.
    // The runner now injects a [CURSOR_STATE] preamble derived from
    // the run's events.jsonl to keep one-step-per-iter prompts
    // resumable across fresh sessions, but the default
    // --reset-on=workitem is still the recommended setup.
    if (resetOn === "iter" && (mode === "self-improve" || mode === "grow-project")) {
        warnIterResetSelfImproveOnce(mode);
    }

    let max;
    if (flags.max !== undefined) {
        if (flags.max === true) { fail(`run --max: requires an integer value`); return 2; }
        const n = Number(String(flags.max).trim());
        if (!Number.isInteger(n) || n < 1 || n > runner.MAX_ALLOWED_ITERATIONS) {
            fail(`run --max: expected integer in [1, ${runner.MAX_ALLOWED_ITERATIONS}], got '${flags.max}'`);
            return 2;
        }
        max = n;
    } else {
        max = defaultMaxIterationsFor(mode, runner);
    }

    // `--min N` floor on iteration count BEFORE the runner honors
    // the completion / abort tokens. Default 1 = byte-identical to
    // pre-flag behavior. `0` is the "disable early-stop" sentinel
    // (mirrors stagnation_limit=0 in ralph_loop). Anything else
    // must satisfy `1 <= N <= max` — `N > max` would silently turn
    // the flag into a no-op which is worse than rejecting up-front.
    let min = 1;
    if (flags.min !== undefined) {
        if (flags.min === true) { fail(`run --min: requires an integer value (use 0 to disable early-stop)`); return 2; }
        const n = Number(String(flags.min).trim());
        if (!Number.isInteger(n) || n < 0 || (n > 0 && n > max)) {
            fail(`run --min: expected 0 (disable early-stop) or integer in [1, max=${max}], got '${flags.min}'`);
            return 2;
        }
        min = n;
    }

    const focus = flags.focus !== undefined && flags.focus !== true ? String(flags.focus) : undefined;
    const promptText = mode === "prompt" ? flags.prompt : undefined;
    const completionPromise = (typeof flags["completion-promise"] === "string" && flags["completion-promise"].trim())
        ? flags["completion-promise"] : runner.COMPLETION_PROMISE;
    const abortPromise = (typeof flags["abort-promise"] === "string" && flags["abort-promise"].trim())
        ? flags["abort-promise"] : undefined; // undefined → runner picks per-mode default

    // Issue #66 D5 — per-iter git worktree mode. Default-on for
    // `self-improve` / `grow-project` (both end with the COMMIT →
    // PUSH → END pinned tail), opt-in for `--prompt`. Explicit
    // `--worktree` / `--no-worktree` overrides the default.
    const worktree = typeof flags.worktree === "boolean"
        ? flags.worktree
        : (mode === "self-improve" || mode === "grow-project");

    let stopOnce = false;
    const installSignal = (sig) => {
        const handler = () => {
            if (stopOnce) {
                process.stderr.write(`\nautopilot run: second ${sig} — aborting hard.\n`);
                process.exit(130);
            }
            stopOnce = true;
            process.stderr.write(`\nautopilot run: ${sig} received — finishing current iteration, then stopping. Hit ${sig} again to abort hard.\n`);
            // We don't yet know the runId until runRalphTui has emitted
            // it; the runner reads state.json each iter so flipping the
            // file is sufficient. We resolve the runId via the running
            // promise's bookkeeping below.
            if (currentRunId) {
                try { runner.stopRun(currentRunId, { reason: `signal_${sig}` }); }
                catch { /* swallow */ }
            }
        };
        process.on(sig, handler);
        return () => process.off(sig, handler);
    };

    // Issue #48 slice 8: when stdout is a TTY and the user didn't ask
    // for headless output, mount the Ink renderer alongside the
    // running driver so they see live iter -> stage -> substage
    // progress + backlog pressure. Falls back to plain text mode when
    // (a) flags.headless or flags.plain is set, (b) stdout isn't a
    // TTY (CI / pipe / asciinema), or (c) Ink isn't installed
    // (ERR_MODULE_NOT_FOUND).
    const runUiEnabled = isTTY() && !flags.headless && !flags.plain;
    let runUiMod = null;
    if (runUiEnabled) {
        try {
            runUiMod = await import("../src/run-ui.mjs");
        } catch (err) {
            if (err && err.code !== "ERR_MODULE_NOT_FOUND") throw err;
            // Fall through to plain mode.
        }
    }

    let currentRunId = null;
    let runUiInstance = null;
    let runUiMountPromise = null;
    const offInt = installSignal("SIGINT");
    const offTerm = installSignal("SIGTERM");
    // Belt-and-suspenders keypress handler — see installStdinAbortListener
    // doc for why we install our own listener even though Ink's useInput
    // already wires q / Ctrl-C inside <App />. Only meaningful when the
    // TUI is mounted (runUiMod truthy); in plain mode there's no Ink
    // and the parent process's default cooked-mode SIGINT handling is
    // sufficient. The handler routes to runner.stopRun (same path Ink's
    // useInput uses) so a double-fire (Ink first, then us) is harmless.
    let abortMessagePrinted = false;
    const printAbortMessage = (reason) => {
        // Idempotent — fired by both Ink's useInput AND the keypress
        // fallback for the same press, plus by the SIGINT signal
        // handler when the user falls back to Ctrl-C. Printing the
        // message twice is just noise.
        if (abortMessagePrinted) return;
        const msg = formatAbortMessage(reason);
        if (msg === null) return;
        abortMessagePrinted = true;
        process.stderr.write(msg);
    };
    const offStdinAbort = runUiMod
        ? installStdinAbortListener((reason) => {
            if (currentRunId) {
                try { runner.stopRun(currentRunId, { reason }); }
                catch { /* swallow */ }
            }
            // Tear down the Ink instance (if any) so the user sees an
            // immediate visual response. The runner's main `await`
            // will return on its own once stopRun's state.json flag
            // is observed at the next iter boundary.
            if (runUiInstance) {
                try { runUiInstance.unmount(); } catch { /* swallow */ }
            }
            // Print AFTER unmount so the message lands below the
            // (now-static) Ink frame instead of being painted over
            // by the next render. Without this, the user sees no
            // change after pressing q because Ink leaves its last
            // frame on screen and the runner doesn't kill the
            // in-flight copilot subprocess — it just sets the stop
            // flag, which the runner only checks between iters.
            printAbortMessage(reason);
        })
        : () => {};
    try {
        const result = await runner.runRalphTui({
            mode,
            resetOn,
            prompt: promptText,
            focus,
            max,
            min,
            completionPromise,
            abortPromise: abortPromise ?? undefined,
            worktree,
            // Issue #83 — when set, route each iter's spawn through
            // the chosen agent adapter. Omitted = the runner falls
            // back to the Copilot adapter (back-compat default).
            agent: agent ?? undefined,
            // When the TUI is mounted, Ink owns the terminal — any
            // `runRalphTui` writes to stdout (e.g. the `# iter N/M`
            // banner) interleave with Ink's frames and corrupt the
            // render. Pipe runner stdout to a no-op sink in TUI
            // mode; stderr stays attached so unrecoverable errors
            // still surface above the TUI on tear-down.
            stdout: runUiMod ? { write: () => {} } : undefined,
            onRunId: (id) => {
                currentRunId = id;
                if (runUiMod) {
                    // Mount the TUI as soon as we know the runId so
                    // the user sees `armed` + iter 1 land in real
                    // time. Async — kick it off and capture the
                    // promise so the finally block can wait for
                    // unmount cleanup. mountRunUi failures (rare:
                    // events.jsonl unreadable, terminal too small,
                    // etc.) degrade silently — the runner keeps
                    // running and the user gets a final summary
                    // line on exit.
                    const eventsPath = safeResolveEventsPath("run", id);
                    if (eventsPath) {
                        runUiMountPromise = runUiMod.mountRunUi({
                            runId: id,
                            eventsPath,
                            // ctrl-c / q from within the TUI
                            // routes here so the driver gets a
                            // graceful stop request instead of
                            // being orphaned mid-iter when Ink
                            // tears down. Match the reason
                            // strings bin/tui.mjs's signal
                            // handler uses so log scrubbers
                            // don't need a special case.
                            onUserAbort: (reason) => {
                                try { runner.stopRun(id, { reason }); }
                                catch { /* swallow */ }
                                // Idempotent with the keypress fallback
                                // — printAbortMessage uses an internal
                                // flag so the same press doesn't log
                                // twice, regardless of which subscriber
                                // (Ink's useInput vs the stdin fallback)
                                // wins the byte.
                                printAbortMessage(reason);
                            },
                        })
                            .then((inst) => { runUiInstance = inst; })
                            .catch((err) => {
                                process.stderr.write(`autopilot run: TUI mount failed (${err?.message ?? err}); continuing in headless mode.\n`);
                            });
                    }
                }
            },
            onIteration: ({ iter }) => {
                // eslint-disable-next-line no-unused-vars
                void iter;
            },
        });
        // Wait for the mount promise to settle (so we don't tear down
        // a half-mounted TUI in the finally block). Then actively
        // unmount the App rather than relying on its auto-exit-on-
        // complete logic — the auto-exit only fires when the
        // `complete` / `abort` event is seen via the live stream,
        // and on a fast run the TUI may not mount until AFTER the
        // runner has already written `complete` to disk (in which
        // case the event lands in the initial `readEventsFile` seed,
        // not the stream, and the App would hang forever waiting for
        // a terminal stream event that never arrives). Active
        // unmount sidesteps that race entirely.
        if (runUiMountPromise) {
            try { await runUiMountPromise; } catch { /* already logged */ }
        }
        if (runUiInstance) {
            try { runUiInstance.unmount(); } catch { /* swallow */ }
            try { await runUiInstance.waitUntilExit(); } catch { /* swallow */ }
        }
        process.stdout.write(`# done — runId=${result.runId} reason=${result.terminationReason}`
            + (result.terminationNote ? ` note=${result.terminationNote}` : "")
            + (result.sessionId ? ` sessionId=${result.sessionId}` : "")
            + "\n");
        return result.terminationReason === "complete" || result.terminationReason === "stopped"
            || result.terminationReason === "abort" || result.terminationReason === "max_iterations"
            ? 0 : 1;
    } finally {
        offInt(); offTerm();
        // Order matters: unmount Ink first (it restores its own raw-mode
        // state on unmount), then drop our stdin keypress listener and
        // restore cooked mode. Reversing the order would leave stdin in
        // raw mode briefly after Ink released it — minor cosmetic issue
        // (next shell prompt loses local echo for ~1 frame).
        if (runUiInstance) {
            try { runUiInstance.unmount(); } catch { /* swallow */ }
        }
        try { offStdinAbort(); } catch { /* swallow */ }
    }
}

export async function main(argv = process.argv.slice(2)) {
    const { cmd, positional, flags } = parseArgv(argv);
    if (flags.version) {
        process.stdout.write(`autopilot ${readTuiVersion()}\n`);
        return 0;
    }
    if (flags.help || cmd === "help") {
        process.stdout.write(USAGE);
        return 0;
    }
    // Bare invocation (no subcommand, no positional) defaults to
    // `run --self-improve` (which inherits `--reset-on=workitem`,
    // the post-issue-#51 default). The user does not have to
    // memorise the canonical drive-the-backlog incantation.
    // `--help` / `--version` already short-circuited above; explicit
    // subcommands keep their existing behaviour via the switch
    // below.
    if (!cmd && !positional.length) {
        process.stderr.write("autopilot: starting self-improve loop (--reset-on=workitem). Press q to stop.\n");
        flags["self-improve"] = true;
        return await cmdRun(flags);
    }
    switch (cmd) {
        case "list": return cmdList({ json: Boolean(flags.json), limit: flags.limit });
        case "replay": return cmdReplay(positional[0]);
        case "watch": return await cmdWatch(positional[0], { plain: flags.plain });
        case "doctor": return cmdDoctor();
        case "prune": return cmdPrune(flags);
        case "stats": return cmdStats();
        case "where": return cmdWhere();
        case "run": return await cmdRun(flags);
        // Issue #83 — agent-backend subcommands. Bare invocation
        // mirrors the bare-`autopilot` self-improve / fresh / yolo
        // default with the agent pinned; explicit run flags pass
        // through to `cmdRun` unchanged.
        case "copilot": return await cmdAgentSubcommand("copilot", flags);
        case "claude": return await cmdAgentSubcommand("claude", flags);
        default:
            fail(`unknown command: ${cmd}\n${USAGE}`);
            return 2;
    }
}

// Only run main() when invoked as a script (not when imported by tests).
// `npm link` installs the bin as a symlink (e.g. /opt/homebrew/bin/autopilot
// → …/packages/tui/bin/tui.mjs); resolve it through realpath so the
// "is this the entry point?" check survives the indirection. Kept fully
// synchronous so this module body has no top-level await — Node 22+ emits
// "Detected unsettled top-level await" when `process.exit()` fires from
// the main() promise chain before the implicit module-evaluation TLA is
// observed as settled (issue: spurious warning in `autopilot run` exit).
let isDirectRun = false;
try {
    if (process.argv[1]) {
        const real = fs.realpathSync(process.argv[1]);
        isDirectRun = pathToFileURL(real).href === import.meta.url;
    }
} catch {
    // Fall back to the simpler heuristics if realpath fails (e.g.
    // running from stdin or a non-existent path during tests).
    isDirectRun = import.meta.url === `file://${process.argv[1]}`
        || Boolean(process.argv[1]?.endsWith("/bin/tui.mjs"));
}
if (isDirectRun) {
    main().then((code) => process.exit(code ?? 0)).catch((err) => {
        // Validation failures throw TypeError by convention in this
        // codebase (e.g. resolveRunEventsPath rejecting path-traversal
        // runIds). Render those as clean one-line messages so the user
        // sees the actionable error, not a stack trace. Genuinely
        // unexpected failures keep the full stack for debuggability.
        if (err instanceof TypeError) {
            process.stderr.write(`autopilot: ${err.message}\n`);
            process.exit(2);
        }
        process.stderr.write(`autopilot: ${err?.stack ?? err}\n`);
        process.exit(1);
    });
}
