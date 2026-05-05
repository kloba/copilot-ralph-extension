// <App> — top-level Ink component for the autopilot state-watcher.
//
// Polls `~/.copilot/autopilot/state.json` (via tryReadState) every
// `pollMs` and renders Header / Timeline / Footer panes against the
// resulting snapshot. The only user input is `q` (and Ctrl-C) which
// exits the TUI without ever touching the loop — the loop lives in
// another process / session and is unaware that the TUI exists.

import React, { useEffect, useState } from "react";
import { Box, useApp, useInput } from "ink";

import { tryReadState } from "../state.mjs";
import Header from "./Header.mjs";
import Timeline from "./Timeline.mjs";
import Footer from "./Footer.mjs";

const h = React.createElement;

const DEFAULT_POLL_MS = 500;

export default function App({
    statePath,
    pollMs = DEFAULT_POLL_MS,
    initialSnapshot = null,
    // injectable for tests — defaults swap in the real disk reader.
    readState = (path) => tryReadState({ path }),
    nowFn = () => Date.now(),
}) {
    const [snapshot, setSnapshot] = useState(initialSnapshot);
    const [now, setNow] = useState(() => nowFn());
    const { exit } = useApp();

    useInput((input, key) => {
        if (key && key.ctrl && input === "c") { exit(); return; }
        if (input === "q" || input === "Q") { exit(); return; }
    });

    useEffect(() => {
        let cancelled = false;
        const tick = () => {
            if (cancelled) return;
            try {
                const next = readState(statePath);
                setSnapshot(next);
            } catch {
                // Disk read errors are non-fatal — the placeholder
                // header copy ("no state file yet") covers this.
            }
            setNow(nowFn());
        };
        tick();
        const id = setInterval(tick, pollMs);
        return () => { cancelled = true; clearInterval(id); };
    }, [statePath, pollMs, readState, nowFn]);

    return h(Box, { flexDirection: "column" },
        h(Header, { snapshot, now }),
        h(Timeline, { snapshot }),
        h(Footer, { armed: Boolean(snapshot?.armed) }),
    );
}
