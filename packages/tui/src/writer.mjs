// JSONL event writer for the ralph TUI (issue #22).
//
// The loop handler in extension/handler.mjs imports createEventWriter() and
// calls writer.emit(ev) at iteration boundaries. The writer keeps a single
// append-mode file descriptor open per run and maintains a sibling
// `runs/index.jsonl` so `ralph-tui list` can enumerate past runs without
// scanning every per-run directory.
//
// Design constraints:
//   - Zero runtime deps (Node stdlib only) — the core extension's bundle
//     stays clean per issue #22's hard constraint.
//   - All filesystem and clock dependencies are injected so tests can
//     pin behaviour against a tmp dir / fake clock without monkey-patching.
//   - Synchronous writes — we emit at most a handful of events per
//     iteration (~seconds apart). Sync keeps ordering trivial and avoids
//     leaking pending-promise state across iterations.
//   - Failures are swallowed by the writer's `onError` callback (defaults
//     to no-op). The TUI is a debugging aid; a fs hiccup must NEVER bring
//     down the loop it observes.

import fsDefault from "node:fs";
import pathDefault from "node:path";
import osDefault from "node:os";

import { MAX_EVENT_LINE_BYTES, makeRunId, serializeEvent } from "./events.mjs";

/**
 * Resolve the on-disk root for ralph TUI run metadata.
 *
 *   $RALPH_EVENTS_DIR if set (absolute path expected; surfaced verbatim
 *   so users can pin a tmp dir in CI).
 *   else `${HOME}/.copilot/ralph/runs`.
 */
export function resolveRunsRoot({ env = process.env, os = osDefault, path = pathDefault } = {}) {
    const override = env.RALPH_EVENTS_DIR;
    if (typeof override === "string" && override.length > 0) return override;
    return path.join(os.homedir(), ".copilot", "ralph", "runs");
}

/**
 * Resolve the events.jsonl path for a given runId. Tests pin both halves.
 */
export function resolveRunEventsPath(runId, deps = {}) {
    if (typeof runId !== "string" || !runId) {
        throw new TypeError("resolveRunEventsPath: runId must be a non-empty string");
    }
    const path = deps.path ?? pathDefault;
    return path.join(resolveRunsRoot(deps), runId, "events.jsonl");
}

/**
 * Build an event writer for a single run.
 *
 * @param {Object} args
 * @param {string} args.runId
 * @param {string} [args.label]            Stamped onto every emitted event.
 * @param {object} [args.fs]               Override Node fs (for tests).
 * @param {object} [args.path]             Override Node path (for tests).
 * @param {object} [args.os]               Override Node os (for tests).
 * @param {NodeJS.ProcessEnv} [args.env]   Override process.env (for tests).
 * @param {() => number} [args.now]        Clock injector; defaults to Date.now.
 * @param {(err: Error) => void} [args.onError]
 *        Invoked when a write fails. Defaults to swallow — see the design
 *        note above for rationale.
 *
 * @returns {{
 *   runId: string,
 *   path: string,
 *   emit: (ev: object) => void,
 *   close: () => void,
 * }}
 */
export function createEventWriter({
    runId,
    label,
    fs = fsDefault,
    path = pathDefault,
    os = osDefault,
    env = process.env,
    now = Date.now,
    onError = () => {},
} = {}) {
    if (typeof runId !== "string" || !runId) {
        throw new TypeError("createEventWriter: runId must be a non-empty string");
    }

    const root = resolveRunsRoot({ env, os, path });
    const runDir = path.join(root, runId);
    const eventsPath = path.join(runDir, "events.jsonl");
    const indexPath = path.join(root, "index.jsonl");

    let closed = false;
    let armed = false;

    // Eager mkdir so the first emit() call is just an append. Failures here
    // surface via onError because a missing dir means *every* subsequent
    // emit will fail — better to know now.
    try {
        fs.mkdirSync(runDir, { recursive: true });
    } catch (err) {
        onError(err);
    }

    const writeLine = (line) => {
        if (closed) return;
        try {
            fs.appendFileSync(eventsPath, line + "\n", { encoding: "utf8" });
        } catch (err) {
            onError(err);
        }
    };

    const recordIndex = (ev) => {
        // index.jsonl carries one line per `armed` event so `ralph-tui list`
        // can enumerate runs in reverse-chronological order without
        // recursing into every run dir. Replays do NOT add a row — only the
        // initial arm marks a run's existence.
        if (ev.type !== "armed") return;
        const indexEntry = serializeEvent({
            type: "armed",
            ts: ev.ts,
            runId: ev.runId,
            label: ev.label,
            maxIterations: ev.maxIterations,
            minIterations: ev.minIterations,
        });
        try {
            fs.appendFileSync(indexPath, indexEntry + "\n", { encoding: "utf8" });
        } catch (err) {
            onError(err);
        }
    };

    const emit = (event) => {
        if (closed) return;
        if (!event || typeof event !== "object") {
            onError(new TypeError("createEventWriter.emit: event must be an object"));
            return;
        }
        // Fill in ts / runId / label so callers can pass minimal payloads.
        const enriched = {
            ts: Number.isFinite(event.ts) ? event.ts : now(),
            runId,
            ...(label ? { label } : {}),
            ...event,
        };
        // The user-supplied `runId` always wins so a forwarder can
        // re-stamp events. But make sure the resulting line conforms to
        // serializeEvent's schema; it will throw on garbage.
        let line;
        try {
            line = serializeEvent(enriched);
        } catch (err) {
            onError(err);
            return;
        }
        if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
            onError(new RangeError(`event line exceeds ${MAX_EVENT_LINE_BYTES} bytes`));
            return;
        }
        if (enriched.type === "armed") {
            armed = true;
            recordIndex(enriched);
        }
        writeLine(line);
    };

    const close = () => {
        closed = true;
    };

    return {
        runId,
        path: eventsPath,
        get armed() { return armed; },
        emit,
        close,
    };
}

/**
 * Read the run index (created lazily by createEventWriter on first
 * `armed` event) and return the parsed entries newest-first. Used by
 * `ralph-tui list` and tests.
 *
 * Missing index file → empty list (a fresh machine with no past runs).
 */
export function readRunIndex({ fs = fsDefault, path = pathDefault, os = osDefault, env = process.env } = {}) {
    const indexPath = path.join(resolveRunsRoot({ env, os, path }), "index.jsonl");
    let raw;
    try {
        raw = fs.readFileSync(indexPath, "utf8");
    } catch (err) {
        if (err && err.code === "ENOENT") return [];
        throw err;
    }
    const lines = raw.split("\n");
    const out = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try {
            obj = JSON.parse(trimmed);
        } catch {
            continue;
        }
        if (obj && obj.type === "armed" && typeof obj.runId === "string") out.push(obj);
    }
    return out.reverse();
}

export { makeRunId };
