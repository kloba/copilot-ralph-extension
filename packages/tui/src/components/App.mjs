// <App> — top-level Ink component for `ralph-tui watch`.
//
// Owns the events array (fed from tailEventsFile) and runs foldEvents()
// to compute the snapshot every render. Uses React.createElement (no
// JSX) so it runs in plain Node ESM.

import React, { useEffect, useState } from "react";
import { Box, useApp, useInput } from "ink";

import { foldEvents } from "../events.mjs";
import Header from "./Header.mjs";
import StagesRow from "./StagesRow.mjs";
import SubstagesPane from "./SubstagesPane.mjs";
import Timeline from "./Timeline.mjs";
import DetailPane from "./DetailPane.mjs";
import Controls from "./Controls.mjs";

const h = React.createElement;

/**
 * @param {Object} props
 * @param {AsyncIterable<object>} [props.eventStream]  Event iterable
 *        (produced by tailEventsFile). When omitted, the App renders
 *        in static mode using `props.events` directly — handy for
 *        snapshot tests.
 * @param {object[]} [props.events]   Initial / static event list.
 * @param {string} [props.runId]      Display label for the header.
 * @param {(reason: string) => void} [props.onUserAbort] Optional
 *        callback fired when the user requests to abort via Ctrl-C
 *        or `q`. When provided (issue #48 slice 8 — `ralph-tui run`
 *        TUI mount), the caller can hook this to call
 *        `runner.stopRun(runId, …)` so the driver gets a graceful
 *        stop request instead of being orphaned mid-iter when the
 *        TUI tears down. Read-only callers (`ralph-tui watch`)
 *        omit it; the App still exits but no driver action occurs.
 */
export default function App({ eventStream, events: initial = [], runId, onUserAbort }) {
    const [events, setEvents] = useState(initial);
    const { exit } = useApp();

    useInput((input, key) => {
        // Ctrl-C: in Ink raw mode the tty does NOT auto-generate
        // SIGINT, and `exitOnCtrlC: false` (set by run-ui.mjs)
        // disables Ink's own ctrl-c handling. So bin/tui.mjs's
        // `process.on("SIGINT", ...)` handler never fires while
        // the TUI owns the terminal — we must catch ctrl-c
        // explicitly and tell the runner to stop. Reason strings
        // mirror the conventional `signal_*` naming used by
        // bin/tui.mjs's signal handler so log scrubbers don't
        // need a special case.
        if (key && key.ctrl && input === "c") {
            if (onUserAbort) {
                try { onUserAbort("signal_SIGINT"); } catch { /* swallow */ }
            }
            exit();
            return;
        }
        if (input === "q" || input === "Q") {
            // `q` in run mode means "abort the run AND tear down
            // the UI" — the user pressing q while a long-running
            // self-improve loop chews up tokens almost certainly
            // wants the loop to stop, not to detach silently.
            if (onUserAbort) {
                try { onUserAbort("user_quit"); } catch { /* swallow */ }
            }
            exit();
        }
    });

    useEffect(() => {
        if (!eventStream) return undefined;
        let cancelled = false;
        (async () => {
            try {
                for await (const ev of eventStream) {
                    if (cancelled) break;
                    setEvents((prev) => prev.concat([ev]));
                    if (ev.type === "complete" || ev.type === "abort") {
                        // Exit a few frames later so the user sees the
                        // final status before the UI tears down.
                        setTimeout(() => { if (!cancelled) exit(); }, 1500);
                    }
                }
            } catch (err) {
                process.stderr.write(`ralph-tui: tail error: ${err?.message ?? err}\n`);
                exit(err);
            }
        })();
        return () => { cancelled = true; };
    }, [eventStream, exit]);

    const snapshot = foldEvents(events);
    if (runId && !snapshot.runId) snapshot.runId = runId;

    return h(Box, { flexDirection: "column" },
        h(Header, { snapshot }),
        h(StagesRow, { snapshot }),
        h(SubstagesPane, { snapshot }),
        h(Timeline, { snapshot }),
        h(DetailPane, { snapshot }),
        h(Controls, { status: snapshot.status }),
    );
}
