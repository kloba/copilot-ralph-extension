// `autopilot run` interactive entry point (issue #48 slice 8).
//
// Mounts the Ink-rendered <App /> against the events.jsonl file that
// runAutopilot is concurrently writing to. Imported dynamically by
// bin/tui.mjs so a fresh checkout without `npm install` falls back to
// plain (headless) mode rather than crashing on the `ink` import.
//
// Mirrors `watch.mjs` (read-only tail) but is wired to be mounted
// while the driver is still running in the same process. A few
// targeted differences vs. watch.mjs:
//   * `exitOnCtrlC: false` so Ctrl-C routes through App's useInput
//     handler (which calls onUserAbort + exit()) rather than Ink's
//     default `process.exit(0)` — that lets bin/tui.mjs perform a
//     graceful `stopRun(...)` before the process tears down.
//   * `patchConsole: false` so the Ink runtime doesn't re-route
//     stdio in run mode — bin/tui.mjs writes a final `# done — …`
//     summary line after unmount and we don't want that captured.
//   * Initial events seed is empty. `tailEventsFile` polls from
//     offset 0, so any events already written before the App
//     mounts would otherwise appear twice (once via the seed,
//     once as the tail's first chunk). By seeding empty we let
//     the tail be the single source of truth and avoid the
//     duplicate-event distortion that would otherwise inflate
//     iter counters in the foldEvents snapshot.

import process from "node:process";

import { tailEventsFile } from "./tail.mjs";

/**
 * @param {Object} args
 * @param {string} args.runId        Run id being driven (display only).
 * @param {string} args.eventsPath   Absolute path to the events.jsonl
 *                                   the runner is writing to.
 * @param {(reason: string) => void} [args.onUserAbort]
 *                                   Forwarded to <App> as the
 *                                   ctrl-c / q handler. cmdRun wires
 *                                   this to `runner.stopRun(runId, …)`.
 * @returns {Promise<{ unmount: () => void, waitUntilExit: () => Promise<void> }>}
 */
export async function mountRunUi({ runId, eventsPath, onUserAbort }) {
    // Lazy imports so this module fails with ERR_MODULE_NOT_FOUND when
    // Ink isn't installed — bin/tui.mjs catches that and falls back to
    // plain mode.
    const [{ render }, React, AppMod] = await Promise.all([
        import("ink"),
        import("react"),
        import("./components/App.mjs"),
    ]);
    const App = AppMod.default ?? AppMod;

    const eventStream = tailEventsFile(eventsPath);

    const instance = render(
        React.default.createElement(App, {
            runId,
            events: [],
            eventStream,
            onUserAbort,
        }),
        { exitOnCtrlC: false, patchConsole: false },
    );

    return {
        unmount: () => { try { instance.unmount(); } catch { /* swallow */ } },
        waitUntilExit: () => instance.waitUntilExit(),
    };
}

