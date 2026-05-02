// `ralph-tui watch` interactive entry point (issue #22).
//
// Mounts the Ink-rendered <App /> against a live tailed events.jsonl.
// Imported dynamically by bin/tui.mjs so a fresh checkout without
// `npm install` falls back to plain mode rather than crashing on the
// `ink` import.

import process from "node:process";

import { tailEventsFile, readEventsFile } from "./tail.mjs";
import { readTuiVersion } from "./version.mjs";
import { detectCaffeinate } from "./caffeinate.mjs";

/**
 * @param {Object} args
 * @param {string} args.runId        Run id being watched (display only).
 * @param {string} args.eventsPath   Absolute path to the events.jsonl.
 * @returns {Promise<number>}        Process exit code.
 */
export async function runInteractive({ runId, eventsPath }) {
    // Lazy imports so this module fails with ERR_MODULE_NOT_FOUND when
    // Ink isn't installed — the bin entry catches that and falls back
    // to --plain.
    const [{ render }, React, AppMod] = await Promise.all([
        import("ink"),
        import("react"),
        import("./components/App.mjs"),
    ]);
    const App = AppMod.default ?? AppMod;

    // Seed the App with whatever's already on disk so users who attach
    // mid-run see history immediately. The live tail picks up where the
    // file ends.
    const initial = readEventsFile(eventsPath);
    const eventStream = tailEventsFile(eventsPath);

    const { waitUntilExit } = render(
        React.default.createElement(App, {
            runId,
            events: initial,
            eventStream,
            appVersion: readTuiVersion(),
            // Issue #75 — one-shot caffeinate detection at mount.
            // Returns false on non-darwin without spawning a
            // subprocess; on darwin walks the ppid ancestry once
            // and caches for the process lifetime.
            caffeinateActive: detectCaffeinate(),
        }),
    );
    await waitUntilExit();
    return 0;
}
