#!/usr/bin/env node
// Stdlib-only CLI entry for the ralph TUI (issue #22).
//
// Subcommands (keep in sync with the USAGE constant below — pinned by
// `tui.mjs header comment lists every USAGE subcommand` in
// packages/tui/test/bin-tui.test.mjs so a drift here surfaces in CI):
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
//                                grow_project loop OUT-OF-SESSION by
//                                spawning each iter as a fresh
//                                `copilot -p ...` subprocess. Choose
//                                exactly one prompt mode
//                                (`--self-improve` / `--grow-project`
//                                / `--prompt`) AND one context mode
//                                (`--continue` / `--fresh`). Sibling
//                                `--pause <runId>` / `--resume <runId>`
//                                / `--stop <runId>` / `--status
//                                <runId>` operate on the run state file
//                                of an in-flight loop.
//
// `--plain` is implied when stdout is not a TTY so CI logs and asciinema
// recordings produce stable, ANSI-free output.
//
// Commander is listed as a dep in this package's package.json for the
// (forthcoming) Ink-rendered watch UI; this stub deliberately uses a
// hand-rolled parser so `node bin/tui.mjs` works straight from a fresh
// checkout with no `npm install`. Once the Ink renderer lands the watch
// command will dynamically import that module.

import process from "node:process";
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { readRunIndex, resolveRunsRoot, resolveRunEventsPath, parseDuration, pruneRuns, aggregateRuns } from "../src/writer.mjs";
import { readEventsFile, tailEventsFile } from "../src/tail.mjs";
import { formatEventLine } from "../src/plain.mjs";

const USAGE = `\
ralph-tui — terminal visualizer for ralph_loop runs (issue #22).

USAGE
  ralph-tui list [--json] [--limit N]
  ralph-tui replay <runId>
  ralph-tui watch [runId] [--plain]
  ralph-tui doctor
  ralph-tui prune [--older-than 30d] [--dry-run]
  ralph-tui stats
  ralph-tui where
  ralph-tui run (--self-improve | --grow-project | --prompt TEXT)
                (--continue | --fresh)
                [--max N] [--focus TEXT] [--headless | --plain]
                [--completion-promise TOKEN] [--abort-promise TOKEN]
  ralph-tui run --pause <runId>
  ralph-tui run --resume <runId>
  ralph-tui run --stop <runId>
  ralph-tui run --status <runId>
  ralph-tui --help | -h

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
  --continue  For \`run\`: every iter resumes the same Copilot session
              (in-extension parity; context grows monotonically).
  --fresh     For \`run\`: every iter starts a brand-new Copilot session
              (clean context per iter).
  --max N     For \`run\`: iteration cap (default 100; default 1000 —
              effectively unbounded — for --self-improve since the
              loop is scope-driven, not iter-driven; max 1000).
  --focus TEXT  For \`run\`: focus suffix appended to the SDLC prompt
              (max 2000 chars). Ignored when --prompt is set.
  --completion-promise TOKEN  For \`run\`: substring whose presence in
              an iter's response signals completion. Default
              \`COMPLETE\`.
  --abort-promise TOKEN  For \`run\`: substring whose presence signals
              an early abort. Defaults to the baked abort token of the
              chosen prompt mode (or none for --prompt).
  --help, -h  Show this help.
  --version, -V  Print the ralph-tui package version and exit.

ENV
  RALPH_EVENTS_DIR  Override the runs root (default ~/.copilot/ralph/runs).
  RALPH_TUI_RUNS_DIR  Override the run-state root used by
                    \`ralph-tui run\` (default ~/.copilot/ralph-tui/runs).
  RALPH_TUI_COPILOT_BIN  Override the \`copilot\` executable used by
                    \`ralph-tui run\` (default \`copilot\` on $PATH).
`;

/** Minimal argv parser. Returns { cmd, positional[], flags{} }.
 *  Supports `--flag`, `--flag=value`, and `--flag value` for the
 *  known value-taking flags listed in `VALUE_FLAGS` below
 *  (currently: --older-than for `prune`, --limit for `list`, plus
 *  the `run` subcommand's --max, --focus, --prompt,
 *  --completion-promise, --abort-promise, --pause, --resume, --stop,
 *  --status). When adding a new value flag, append it to
 *  `VALUE_FLAGS` AND update the USAGE block above so
 *  `ralph-tui --help` keeps matching the parser. */
const VALUE_FLAGS = new Set(["older-than", "limit", "max", "focus", "prompt", "completion-promise", "abort-promise", "pause", "resume", "stop", "status"]);

/** Default `--max` iterations per loop mode for `ralph-tui run`.
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

function fail(msg, code = 2) {
    process.stderr.write(`ralph-tui: ${msg}\n`);
    process.exit(code);
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
            + `Arm a ralph_loop / self_improve / grow_project run, then re-run \`ralph-tui list\`.\n`,
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
        fail("replay: <runId> is required (try `ralph-tui list` first)");
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
            `ralph-tui doctor: critical problem detected (root=${root}). `
            + `Check filesystem permissions and RALPH_EVENTS_DIR.\n`,
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

export function readTuiVersion() {
    try {
        const pkgPath = nodePath.resolve(
            nodePath.dirname(fileURLToPath(import.meta.url)),
            "..",
            "package.json",
        );
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        return pkg.version || "unknown";
    } catch {
        return "unknown";
    }
}

export function cmdWhere() {
    process.stdout.write(resolveRunsRoot() + "\n");
    return 0;
}

// `ralph-tui run` dispatcher. Splits into:
//   sibling sub-commands: --pause / --resume / --stop / --status <runId>
//                         (mutate or read state.json of an existing run)
//   driver:               --self-improve / --grow-project / --prompt
//                         (start a new loop; runs to completion in this
//                          process, with SIGINT/SIGTERM mapped to a
//                          graceful stop request)
export async function cmdRun(flags) {
    // Lazy-imported so a `ralph-tui list` invocation doesn't pay the
    // child_process / runner-module init cost.
    const runner = await import("../src/runner.mjs");

    // Sibling commands first — they require a runId argument and are
    // mutually exclusive with the driver flags.
    const siblingFlags = ["pause", "resume", "stop", "status"];
    const sibling = siblingFlags.find((k) => flags[k] !== undefined);
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

    let contextMode = null;
    if (flags.continue) contextMode = "continue";
    if (flags.fresh) {
        if (contextMode) { fail(`run: choose exactly one of --continue / --fresh`); return 2; }
        contextMode = "fresh";
    }
    if (!contextMode) {
        fail(`run: choose one of --continue / --fresh (no default — context behaviour is too consequential to guess)`);
        return 2;
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

    const focus = flags.focus !== undefined && flags.focus !== true ? String(flags.focus) : undefined;
    const promptText = mode === "prompt" ? flags.prompt : undefined;
    const completionPromise = (typeof flags["completion-promise"] === "string" && flags["completion-promise"].trim())
        ? flags["completion-promise"] : runner.COMPLETION_PROMISE;
    const abortPromise = (typeof flags["abort-promise"] === "string" && flags["abort-promise"].trim())
        ? flags["abort-promise"] : undefined; // undefined → runner picks per-mode default

    let stopOnce = false;
    const installSignal = (sig) => {
        const handler = () => {
            if (stopOnce) {
                process.stderr.write(`\nralph-tui run: second ${sig} — aborting hard.\n`);
                process.exit(130);
            }
            stopOnce = true;
            process.stderr.write(`\nralph-tui run: ${sig} received — finishing current iteration, then stopping. Hit ${sig} again to abort hard.\n`);
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
    try {
        const result = await runner.runRalphTui({
            mode,
            contextMode,
            prompt: promptText,
            focus,
            max,
            completionPromise,
            abortPromise: abortPromise ?? undefined,
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
                            },
                        })
                            .then((inst) => { runUiInstance = inst; })
                            .catch((err) => {
                                process.stderr.write(`ralph-tui run: TUI mount failed (${err?.message ?? err}); continuing in headless mode.\n`);
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
        if (runUiInstance) {
            try { runUiInstance.unmount(); } catch { /* swallow */ }
        }
    }
}

export async function main(argv = process.argv.slice(2)) {
    const { cmd, positional, flags } = parseArgv(argv);
    if (flags.version) {
        process.stdout.write(`ralph-tui ${readTuiVersion()}\n`);
        return 0;
    }
    if (flags.help || cmd === "help" || (!cmd && !positional.length)) {
        process.stdout.write(USAGE);
        return 0;
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
        default:
            fail(`unknown command: ${cmd}\n${USAGE}`);
            return 2;
    }
}

// Only run main() when invoked as a script (not when imported by tests).
// `npm link` installs the bin as a symlink (e.g. /opt/homebrew/bin/ralph-tui
// → …/packages/tui/bin/tui.mjs); resolve it through realpath so the
// "is this the entry point?" check survives the indirection.
let isDirectRun = false;
try {
    const { realpathSync } = await import("node:fs");
    const { pathToFileURL } = await import("node:url");
    if (process.argv[1]) {
        const real = realpathSync(process.argv[1]);
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
            process.stderr.write(`ralph-tui: ${err.message}\n`);
            process.exit(2);
        }
        process.stderr.write(`ralph-tui: ${err?.stack ?? err}\n`);
        process.exit(1);
    });
}
