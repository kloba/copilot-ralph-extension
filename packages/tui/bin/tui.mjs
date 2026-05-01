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

import { readRunIndex, resolveRunsRoot, resolveRunEventsPath } from "../src/writer.mjs";
import { readEventsFile, tailEventsFile } from "../src/tail.mjs";
import { formatEventLine } from "../src/plain.mjs";

const USAGE = `\
ralph-tui — terminal visualizer for ralph_loop runs (issue #22).

USAGE
  ralph-tui list
  ralph-tui replay <runId>
  ralph-tui watch [runId] [--plain]
  ralph-tui --help | -h

OPTIONS
  --plain     Emit log lines instead of an interactive UI (auto-enabled
              when stdout is not a TTY, e.g. piped to a file or in CI).
  --help, -h  Show this help.

ENV
  RALPH_EVENTS_DIR  Override the runs root (default ~/.copilot/ralph/runs).
`;

/** Minimal argv parser. Returns { cmd, positional[], flags{} }. */
export function parseArgv(argv) {
    const out = { cmd: null, positional: [], flags: {} };
    const args = [...argv];
    while (args.length) {
        const a = args.shift();
        if (a === "--help" || a === "-h") { out.flags.help = true; continue; }
        if (a === "--plain") { out.flags.plain = true; continue; }
        if (a === "--no-plain") { out.flags.plain = false; continue; }
        if (a.startsWith("--")) { out.flags[a.slice(2)] = true; continue; }
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

function cmdList() {
    const entries = readRunIndex();
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

export async function main(argv = process.argv.slice(2)) {
    const { cmd, positional, flags } = parseArgv(argv);
    if (flags.help || cmd === "help" || (!cmd && !positional.length)) {
        process.stdout.write(USAGE);
        return 0;
    }
    switch (cmd) {
        case "list": return cmdList();
        case "replay": return cmdReplay(positional[0]);
        case "watch": return await cmdWatch(positional[0], { plain: flags.plain });
        default:
            fail(`unknown command: ${cmd}\n${USAGE}`);
            return 2;
    }
}

// Only run main() when invoked as a script (not when imported by tests).
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
    || process.argv[1]?.endsWith("/bin/tui.mjs");
if (isDirectRun) {
    main().then((code) => process.exit(code ?? 0)).catch((err) => {
        process.stderr.write(`ralph-tui: ${err?.stack ?? err}\n`);
        process.exit(1);
    });
}
