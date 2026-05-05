#!/usr/bin/env node
// Stdlib-only CLI entry for the autopilot TUI watcher (issue #121).
//
// Post-pivot the TUI is a thin READ-ONLY dashboard of the extension's
// persisted state file (`~/.copilot/autopilot/state.json`, written
// atomically by extension/handler.mjs). It does NOT spawn anything,
// does NOT feed prompts, does NOT drive a loop. The legacy mode-2
// out-of-session SDLC driver (~510 LOC of dead code) was removed in
// the same commit that introduced this binary's current shape.
//
// Subcommands:
//   watch [--plain]   Default. Mount the Ink dashboard (or print
//                     a plain block on every poll cycle) until the
//                     user presses `q` / Ctrl-C.
//   show              Print one plain dashboard block for the
//                     current state and exit (handy for scripts).
//   where             Print the resolved state file path.
//
// Flags:
//   --plain           Force plain output (auto when stdout is not
//                     a TTY).
//   --poll-ms <N>     Override the poll interval (default 500).
//   --state-file <P>  Override the state.json path (mostly for tests
//                     and dev-time overrides; production users should
//                     accept the default `~/.copilot/autopilot/state.json`).
//   --help, -h
//   --version, -V

import process from "node:process";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import nodePath from "node:path";

import { defaultStatePath, tryReadState } from "../src/state.mjs";
import { renderPlain } from "../src/render-plain.mjs";

const USAGE = `\
autopilot-tui — read-only watcher for the autopilot loop state.

USAGE
  autopilot-tui watch [--plain] [--poll-ms 500] [--state-file PATH]
  autopilot-tui show  [--state-file PATH]
  autopilot-tui where
  autopilot-tui --help | -h
  autopilot-tui --version | -V

The loop is driven by the autopilot extension running inside a
Copilot CLI session — start it with \`/autopilot run\`. This TUI
polls the extension's persisted state file and renders a dashboard.
Pressing \`q\` here only quits the TUI; it never affects the loop.

ENV
  AUTOPILOT_STATE_FILE  Override the state-file path (same effect
                        as --state-file).
`;

const VALUE_FLAGS = new Set(["poll-ms", "state-file"]);

export function parseArgv(argv) {
    const out = { cmd: null, positional: [], flags: {} };
    const args = [...argv];
    while (args.length) {
        const a = args.shift();
        if (a === "--help" || a === "-h") { out.flags.help = true; continue; }
        if (a === "--version" || a === "-V") { out.flags.version = true; continue; }
        if (a === "--plain") { out.flags.plain = true; continue; }
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            if (eq !== -1) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
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

function fail(msg, code = 2) {
    process.stderr.write(`autopilot-tui: ${msg}\n`);
    process.exit(code);
}

function isTTY() {
    return Boolean(process.stdout && process.stdout.isTTY);
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

function resolveStatePath(flags, env = process.env) {
    if (typeof flags["state-file"] === "string" && flags["state-file"].length > 0) {
        return flags["state-file"];
    }
    if (typeof env.AUTOPILOT_STATE_FILE === "string" && env.AUTOPILOT_STATE_FILE.length > 0) {
        return env.AUTOPILOT_STATE_FILE;
    }
    return defaultStatePath();
}

function parsePollMs(raw) {
    if (raw === undefined) return 500;
    if (raw === true) return null;
    const n = Number(String(raw).trim());
    if (!Number.isInteger(n) || n < 50 || n > 60_000) return null;
    return n;
}

export function cmdWhere(flags) {
    process.stdout.write(resolveStatePath(flags) + "\n");
    return 0;
}

export function cmdShow(flags) {
    const statePath = resolveStatePath(flags);
    const snapshot = tryReadState({ path: statePath });
    process.stdout.write(renderPlain(snapshot) + "\n");
    return 0;
}

export async function cmdWatch(flags) {
    const statePath = resolveStatePath(flags);
    const pollMs = parsePollMs(flags["poll-ms"]);
    if (pollMs === null) {
        fail(`watch --poll-ms: expected integer in [50, 60000], got '${flags["poll-ms"]}'`);
        return 2;
    }
    const plain = Boolean(flags.plain) || !isTTY();

    if (!plain) {
        try {
            const mod = await import("../src/mount.mjs");
            const inst = await mod.mountWatcherUi({ statePath, pollMs });
            await inst.waitUntilExit();
            return 0;
        } catch (err) {
            if (err && err.code !== "ERR_MODULE_NOT_FOUND") throw err;
            // Fall through to plain mode when Ink/React aren't installed.
            process.stderr.write(
                "autopilot-tui: ink/react not installed, falling back to --plain. "
                + "Run `npm install` in packages/tui/ for the interactive renderer.\n",
            );
        }
    }

    return await runPlainLoop({ statePath, pollMs });
}

async function runPlainLoop({ statePath, pollMs }) {
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        process.stdout.write("\n# autopilot-tui: stopping (loop continues in its session)\n");
    };
    process.on("SIGINT", () => { stop(); process.exit(130); });
    process.on("SIGTERM", () => { stop(); process.exit(143); });

    while (!stopped) {
        const snapshot = tryReadState({ path: statePath });
        process.stdout.write(renderPlain(snapshot) + "\n\n");
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return 0;
}

export async function main(argv = process.argv.slice(2)) {
    const { cmd, flags } = parseArgv(argv);
    if (flags.version) {
        process.stdout.write(`autopilot-tui ${readTuiVersion()}\n`);
        return 0;
    }
    if (flags.help || cmd === "help") {
        process.stdout.write(USAGE);
        return 0;
    }
    const effectiveCmd = cmd ?? "watch";
    switch (effectiveCmd) {
        case "watch": return await cmdWatch(flags);
        case "show":  return cmdShow(flags);
        case "where": return cmdWhere(flags);
        default:
            fail(`unknown command: ${cmd}\n${USAGE}`);
            return 2;
    }
}

let isDirectRun = false;
try {
    if (process.argv[1]) {
        const real = fs.realpathSync(process.argv[1]);
        isDirectRun = pathToFileURL(real).href === import.meta.url;
    }
} catch {
    isDirectRun = import.meta.url === `file://${process.argv[1]}`
        || Boolean(process.argv[1]?.endsWith("/bin/tui.mjs"));
}
if (isDirectRun) {
    main().then((code) => process.exit(code ?? 0)).catch((err) => {
        process.stderr.write(`autopilot-tui: ${err?.stack ?? err}\n`);
        process.exit(1);
    });
}
