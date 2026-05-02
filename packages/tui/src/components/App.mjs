// <App> — top-level Ink component for `ralph-tui watch`.
//
// Owns the events array (fed from tailEventsFile) and runs foldEvents()
// to compute the snapshot every render. Uses React.createElement (no
// JSX) so it runs in plain Node ESM.

import React, { useEffect, useState } from "react";
import { Box, useApp, useInput } from "ink";
import { homedir } from "node:os";
import { join } from "node:path";

import { foldEvents } from "../events.mjs";
import { tailSessionFile } from "../tail.mjs";
import { formatSessionEvent } from "../stream-format.mjs";
import Header from "./Header.mjs";
import StagesRow from "./StagesRow.mjs";
import TasksPane from "./TasksPane.mjs";
import SubstagesPane from "./SubstagesPane.mjs";
import Timeline from "./Timeline.mjs";
import LiveOutputPane from "./LiveOutputPane.mjs";
import LastCommit from "./LastCommit.mjs";
import Controls from "./Controls.mjs";

const h = React.createElement;

// Issue #57 / live-output panel — ring-buffer cap. 200 lines is large
// enough that any reasonable scroll-back use-case has room to breathe
// (the user can `ralph-tui replay` for the full transcript). Small
// enough that we never burn tens of MB on a long-running self_improve
// session.
const LIVE_BUFFER_MAX = 200;

/**
 * Compute the path to the Copilot CLI's session log for a given
 * sessionId. The CLI itself writes here; this path is owned by the
 * Copilot CLI and is independent of our own events.jsonl path
 * (which lives under `RALPH_TUI_RUNS_DIR` per issue #50).
 *
 * @param {string} sessionId
 * @returns {string}
 */
function sessionStateLogPath(sessionId) {
    return join(homedir(), ".copilot", "session-state", `${sessionId}.jsonl`);
}

/**
 * Derive a stable identity key for the active L3 task. Returns null
 * when no task is in flight (between task_end and the next task_start).
 * Including `startedAt` ensures a re-run of the same `(stage, sub)`
 * pair gets a fresh key — useful for stages that retry a task without
 * ending the parent stage.
 */
function deriveTaskKey(snapshot) {
    const t = snapshot?.taskInFlight;
    if (!t) return null;
    return `${t.stage}:${t.sub}:${t.startedAt ?? 0}`;
}

/**
 * @param {Object} props
 * @param {AsyncIterable<object>} [props.eventStream]  Event iterable
 *        (produced by tailEventsFile). When omitted, the App renders
 *        in static mode using `props.events` directly — handy for
 *        snapshot tests.
 * @param {object[]} [props.events]   Initial / static event list.
 * @param {string} [props.runId]      Display label for the header.
 * @param {string} [props.appVersion] Optional package version string
 *        (e.g. `"0.1.0"`). When supplied, forwarded to <Header> so it
 *        renders a dim `v<value>` pip in the top-right of the heading
 *        row (issue #59). Snapshot tests + pre-issue-59 callers omit
 *        the prop, in which case the pip is hidden and the heading
 *        row stays single-text (existing layout).
 * @param {boolean} [props.caffeinateActive] Optional flag set by the
 *        caller (run-ui.mjs / watch.mjs) when `detectCaffeinate()`
 *        returns true at mount time. Forwarded to <Header> so it
 *        renders a dim `☕ awake` pip in the heading row (issue #75).
 *        Snapshot tests + non-darwin callers omit / pass false; the
 *        pip then stays hidden and the heading row layout is
 *        unchanged.
 * @param {(reason: string) => void} [props.onUserAbort] Optional
 *        callback fired when the user requests to abort via Ctrl-C
 *        or `q`. When provided (issue #48 slice 8 — `ralph-tui run`
 *        TUI mount), the caller can hook this to call
 *        `runner.stopRun(runId, …)` so the driver gets a graceful
 *        stop request instead of being orphaned mid-iter when the
 *        TUI tears down. Read-only callers (`ralph-tui watch`)
 *        omit it; the App still exits but no driver action occurs.
 */
export default function App({ eventStream, events: initial = [], runId, appVersion, caffeinateActive, onUserAbort }) {
    const [events, setEvents] = useState(initial);
    // `now` is read by <Header> to render the live elapsed clock. We
    // only tick it in live mode (eventStream present) so static-mode
    // renders (existing tests + snapshot fixtures) stay deterministic
    // and don't leak intervals across test runs. The tick stops once
    // the loop reaches a terminal status — at that point <Header>
    // freezes elapsed at `snapshot.terminalAt` anyway.
    const [now, setNow] = useState(() => Date.now());
    // Issue #57 — live-output ring buffer fed by the tailSessionFile()
    // effect below and rendered by <LiveOutputPane>. `taskKey` tracks
    // the active L3 task so we know when to clear `lines` (each
    // task_start gets a fresh buffer); between tasks the buffer keeps
    // appending so inter-task agent commentary still surfaces.
    const [liveOutput, setLiveOutput] = useState({ taskKey: null, lines: [] });
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

    // 1 Hz tick to keep the Header's elapsed counter live. Live mode
    // only — static renders (tests, fixtures) don't tick. Stops at
    // terminal status so a finished run doesn't keep re-rendering.
    const isLive = !!eventStream;
    const tickActive = isLive
        && snapshot.status !== "complete"
        && snapshot.status !== "aborted";
    useEffect(() => {
        if (!tickActive) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        if (typeof id?.unref === "function") id.unref();
        return () => clearInterval(id);
    }, [tickActive]);

    // Issue #57 — reset the live buffer on each task_start. We compute
    // the task key from `snapshot.taskInFlight` (set by task_start,
    // cleared by task_end). Going from null → non-null OR transitioning
    // to a different task identity resets the buffer; null → null and
    // task_end → null deliberately leave the buffer intact so the
    // previous task's tail is still visible while the agent decides
    // what to do next.
    const taskKey = deriveTaskKey(snapshot);
    useEffect(() => {
        if (taskKey === null) return;
        setLiveOutput((prev) =>
            prev.taskKey === taskKey ? prev : { taskKey, lines: [] },
        );
    }, [taskKey]);

    // Issue #57 — mount the Copilot CLI session-log tail when (a)
    // we're in live mode (eventStream present — replay/static mode
    // skips this whole path so the panel renders the
    // "session log unavailable for replay" placeholder) and (b) the
    // runner has surfaced a sessionId via session_attached. A
    // re-armed loop produces a new sessionId, so the dep array's
    // value comparison naturally tears down the old reader and
    // mounts a new one.
    const sessionId = isLive ? snapshot.sessionId : null;
    useEffect(() => {
        if (!sessionId) return undefined;
        const ac = new AbortController();
        const logPath = sessionStateLogPath(sessionId);
        (async () => {
            try {
                for await (const sessionEv of tailSessionFile(logPath, { signal: ac.signal })) {
                    if (ac.signal.aborted) break;
                    const formatted = formatSessionEvent(sessionEv);
                    if (!formatted.length) continue;
                    setLiveOutput((prev) => {
                        const next = prev.lines.concat(formatted);
                        const trimmed = next.length > LIVE_BUFFER_MAX
                            ? next.slice(-LIVE_BUFFER_MAX)
                            : next;
                        return { taskKey: prev.taskKey, lines: trimmed };
                    });
                }
            } catch (err) {
                if (ac.signal.aborted) return;
                // A tail error is not fatal — the rest of the TUI is
                // still useful (header / stages / tasks). Surface a
                // single in-band line so the user knows the live
                // panel is degraded rather than silently empty.
                setLiveOutput((prev) => ({
                    taskKey: prev.taskKey,
                    lines: prev.lines.concat([{
                        kind: "tool_fail",
                        line: `← TAIL ERROR: ${err?.message ?? err}`,
                    }]),
                }));
            }
        })();
        return () => { ac.abort(); };
    }, [sessionId]);

    return h(Box, { flexDirection: "column" },
        h(Header, { snapshot, now: isLive ? now : undefined, appVersion, caffeinateActive }),
        h(StagesRow, { snapshot }),
        h(TasksPane, { snapshot }),
        h(SubstagesPane, { snapshot }),
        h(Timeline, { snapshot }),
        h(LiveOutputPane, {
            snapshot,
            lines: liveOutput.lines,
            isLive,
        }),
        h(LastCommit, { snapshot }),
        h(Controls, { status: snapshot.status }),
    );
}
