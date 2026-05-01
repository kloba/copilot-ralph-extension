// <App> — top-level Ink component for `ralph-tui watch`.
//
// Owns the events array (fed from tailEventsFile) and runs foldEvents()
// to compute the snapshot every render. Uses React.createElement (no
// JSX) so it runs in plain Node ESM.

import React, { useEffect, useState } from "react";
import { Box, useApp, useInput } from "ink";

import { foldEvents } from "../events.mjs";
import Header from "./Header.mjs";
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
 */
export default function App({ eventStream, events: initial = [], runId }) {
    const [events, setEvents] = useState(initial);
    const { exit } = useApp();

    useInput((input) => {
        if (input === "q" || input === "Q") exit();
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
        h(Timeline, { snapshot }),
        h(DetailPane, { snapshot }),
        h(Controls, { status: snapshot.status }),
    );
}
