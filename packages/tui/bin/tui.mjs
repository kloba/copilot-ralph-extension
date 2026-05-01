#!/usr/bin/env node
// Stdlib-only CLI entry for the ralph TUI (issue #22).
//
// Subcommands:
//   list                       — show recorded runs (newest first).
//   replay <runId>             — print every event in a past run.
//   watch [runId] [--plain]    — tail the given run (or the most recent
//                                one if omitted) in real time.
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
  ralph-tui --help | -h

OPTIONS
  --plain     Emit log lines instead of an interactive UI (auto-enabled
              when stdout is not a TTY, e.g. piped to a file or in CI).
  --json      For \`list\`: emit the run index as a JSON array (one
              object per run, newest first) for scripting/dashboards.
  --older-than DURATION  For \`prune\`: only remove runs older than
              DURATION (e.g. 30d, 12h, 5m). Default 30d.
  --dry-run   For \`prune\`: list what would be removed; delete nothing.
  --help, -h  Show this help.
  --version, -V  Print the ralph-tui package version and exit.

ENV
  RALPH_EVENTS_DIR  Override the runs root (default ~/.copilot/ralph/runs).
`;

/** Minimal argv parser. Returns { cmd, positional[], flags{} }.
 *  Supports `--flag`, `--flag=value`, and `--flag value` for a known
 *  set of value-taking flags (currently: --older-than). */
const VALUE_FLAGS = new Set(["older-than", "limit"]);
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

function cmdReplay(runId) {
    if (!runId) fail("replay: <runId> is required (try `ralph-tui list` first)");
    const path = resolveRunEventsPath(runId);
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
        if (!entries.length) fail("watch: no runs to watch — arm a loop first.");
        target = entries[0].runId;
    }
    const path = resolveRunEventsPath(target);
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
    let tuiVersion = "unknown";
    try {
        const pkgPath = nodePath.resolve(
            nodePath.dirname(fileURLToPath(import.meta.url)),
            "..",
            "package.json",
        );
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        tuiVersion = pkg.version || "unknown";
    } catch {
        // best-effort; leave as "unknown"
    }
    lines.push(`tui version: ${tuiVersion}`);

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
        process.stderr.write(`ralph-tui: ${err?.stack ?? err}\n`);
        process.exit(1);
    });
}
