// JSONL event writer for the autopilot TUI (issue #22).
//
// The loop handler in extension/handler.mjs imports createEventWriter() and
// calls writer.emit(ev) at iteration boundaries. The writer keeps a single
// append-mode file descriptor open per run and maintains a sibling
// `runs/index.jsonl` so `autopilot list` can enumerate past runs without
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

// Print a one-line stderr deprecation notice the FIRST time a given
// migration trigger fires, then drop a sentinel line under
// ~/.copilot/autopilot/ so subsequent runs (in this or any later
// process) stay silent. Mirror of the helper in
// extension/events-emit.mjs — the two surfaces resolve from the same
// sentinel so a single legacy default-path read silences both.
function emitDeprecationOnce({ key, message, sentinelPath, fs, stderr }) {
    try {
        const content = fs.readFileSync(sentinelPath, "utf8");
        if (content.split("\n").some((l) => l === key)) return;
    } catch { /* sentinel missing or unreadable */ }
    try {
        stderr.write(message);
        fs.mkdirSync(pathDefault.dirname(sentinelPath), { recursive: true });
        fs.appendFileSync(sentinelPath, key + "\n");
    } catch { /* best-effort */ }
}

/**
 * Resolve the on-disk root for autopilot TUI run metadata.
 *
 *   $AUTOPILOT_EVENTS_DIR if set (absolute path expected; surfaced verbatim
 *   so users can pin a tmp dir in CI).
 *   else $RALPH_EVENTS_DIR if set (deprecated; one-time stderr notice).
 *   else `${HOME}/.copilot/autopilot/events` (new default).
 *   If new default doesn't exist but `${HOME}/.copilot/ralph/runs` does,
 *   falls back to the old path with a deprecation notice.
 */
export function resolveRunsRoot({
    env = process.env,
    os = osDefault,
    path = pathDefault,
    fs = fsDefault,
    stderr = process.stderr,
    sentinelPath: sentinelPathArg,
} = {}) {
    const home = os.homedir();
    const sentinelPath = sentinelPathArg ?? path.join(home, ".copilot", "autopilot", ".migration-notice-shown");

    // Primary: $AUTOPILOT_EVENTS_DIR
    const newOverride = env.AUTOPILOT_EVENTS_DIR;
    if (typeof newOverride === "string" && newOverride.length > 0) return newOverride;

    // Legacy fallback: $RALPH_EVENTS_DIR (deprecated)
    const legacyOverride = env.RALPH_EVENTS_DIR;
    if (typeof legacyOverride === "string" && legacyOverride.length > 0) {
        emitDeprecationOnce({
            key: "env:RALPH_EVENTS_DIR",
            message: "[autopilot] note: env $RALPH_EVENTS_DIR is deprecated, please use $AUTOPILOT_EVENTS_DIR (still honored)\n",
            sentinelPath,
            fs,
            stderr,
        });
        return legacyOverride;
    }

    // Default paths
    const newDefault = path.join(home, ".copilot", "autopilot", "events");
    const oldDefault = path.join(home, ".copilot", "ralph", "runs");

    let newExists = false;
    let oldExists = false;
    try { newExists = fs.existsSync(newDefault); } catch { /* swallow */ }
    try { oldExists = fs.existsSync(oldDefault); } catch { /* swallow */ }

    if (!newExists && oldExists) {
        emitDeprecationOnce({
            key: `path:${oldDefault}`,
            message: `[autopilot] note: reading from legacy ~/.copilot/ralph/runs (default is now ~/.copilot/autopilot/events)\n`,
            sentinelPath,
            fs,
            stderr,
        });
        return oldDefault;
    }

    return newDefault;
}

/**
 * Resolve the events.jsonl path for a given runId. Tests pin both halves.
 */
export function resolveRunEventsPath(runId, deps = {}) {
    if (typeof runId !== "string" || !runId) {
        throw new TypeError("resolveRunEventsPath: runId must be a non-empty string");
    }
    assertSafeRunId("resolveRunEventsPath", runId);
    const path = deps.path ?? pathDefault;
    return path.join(resolveRunsRoot(deps), runId, "events.jsonl");
}

// Reject path-traversal payloads so a stray `replay ../../etc/passwd`
// (or a hostile/corrupted index.jsonl row whose `runId` was hand-edited
// to escape the runs root) cannot reach the filesystem outside the
// resolved runs directory. Legitimately emitted runIds are produced by
// `makeRunId` and only contain `[A-Za-z0-9_-]`, so this is purely a
// safety net for caller-supplied input. Shared between
// `resolveRunEventsPath` (read path), `createEventWriter` (write
// path) via `assertSafeRunId`, and `pruneRuns` (delete path, which
// silently skips traversal rows rather than throwing).
function isPathTraversalRunId(runId) {
    return runId.includes("/")
        || runId.includes("\\")
        || runId.includes("\0")
        || runId === "."
        || runId === ".."
        || runId.includes("..");
}

// Throwing twin of `isPathTraversalRunId`. Two write/read surfaces
// (`resolveRunEventsPath`, `createEventWriter`) need the SAME guard
// with the SAME TypeError message format — extracting this helper
// prevents the two sites from drifting apart on future edits (e.g.
// one of them gets a more helpful message; the other keeps the old
// one). `pruneRuns` does NOT use this helper because its policy is
// "silently skip traversal rows so the index keeps the survivor"
// rather than "throw".
function assertSafeRunId(fnName, runId) {
    if (isPathTraversalRunId(runId)) {
        throw new TypeError(
            `${fnName}: runId ${JSON.stringify(runId)} contains path separators or traversal segments`,
        );
    }
}

// Iter 159 — `readRunIndex` and `pruneRuns` both filter rows from
// `index.jsonl` with the same "is this a usable armed-row?" predicate
// (must be a non-null object whose `type === "armed"` and whose `runId`
// is a non-empty-ish string). Centralising the check eliminates a
// drift vector identical to the iter-154/155 lesson: when a future
// hardening pass adds another precondition (e.g. `Number.isFinite(
// obj.ts)`), it can land here once instead of being added to one
// site and forgotten on the other. `pruneRuns` keeps its inline
// `isPathTraversalRunId` guard separately because that gate has a
// different policy (survivor, not skip) and a different error mode
// (defence in depth against destructive `rmSync`).
function isValidArmedIndexRow(obj) {
    return Boolean(obj)
        && typeof obj === "object"
        && obj.type === "armed"
        && typeof obj.runId === "string"
        && obj.runId.length > 0;
}

// Iter 166 — three sites in this file (`readRunIndex`,
// `aggregateRuns`'s events.jsonl inner loop, and `pruneRuns`)
// previously duplicated the same line-iteration pattern: split
// the raw file on `\n`, trim each line, skip empties, JSON.parse
// inside a try/catch and skip malformed rows. Centralising the
// pattern in this generator means a future bug found in one
// site (e.g. handling `\r\n` on Windows-edited files, or
// rejecting a specific obj shape early) lands in one place
// instead of being added to two of three sites and forgotten on
// the third. The generator yields `{ obj, trimmed }` so callers
// that need the original line bytes (`pruneRuns` rewrites
// surviving entries verbatim) can opt-in without re-stringifying.
// Tolerant of non-string input (returns nothing) so a future
// caller passing `undefined` from a missing-file path doesn't
// crash — mirrors the existing best-effort error policy.
function* iterJsonlRows(raw) {
    if (typeof raw !== "string" || raw.length === 0) return;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }
        yield { obj, trimmed };
    }
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
    // Defensive symmetry with `resolveRunEventsPath` (line 47) and
    // `pruneRuns` (line 361): production runIds come from `makeRunId`
    // and only contain `[A-Za-z0-9_-]`, but createEventWriter is the
    // primary write surface — letting a runId with `..` or `/` through
    // here would let a future caller (or hostile test fixture) escape
    // the runs sandbox via `path.join(root, runId, …)`. Guarding here
    // keeps the read + write + delete paths in lockstep.
    assertSafeRunId("createEventWriter", runId);

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
        // index.jsonl carries one line per `armed` event so `autopilot list`
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
 * `autopilot list` and tests.
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
    const out = [];
    for (const { obj } of iterJsonlRows(raw)) {
        if (isValidArmedIndexRow(obj)) out.push(obj);
    }
    return out.reverse();
}

export { makeRunId };

// Iter 166 — exposed for direct testing of the shared JSONL row
// iterator. Not part of the public surface (no `export` on the
// declaration above) so consumers cannot couple to it; the
// `__test__` bag is the project-wide convention for "tests can
// reach in but library users should not".
export const __test__ = { iterJsonlRows };

/**
 * Aggregate stats across all recorded runs. Returns:
 *   { total, byTool: {...}, byReason: {...}, iters: { mean, max } }
 *
 * Reads the run index for tool labels, then per-run events.jsonl to find
 * each run's terminal event (complete | abort) for reason + iteration.
 * Best-effort: unreadable run dirs are skipped silently.
 */
export function aggregateRuns({
    fs = fsDefault,
    path = pathDefault,
    os = osDefault,
    env = process.env,
} = {}) {
    const entries = readRunIndex({ fs, path, os, env });
    const root = resolveRunsRoot({ env, os, path });
    const byTool = {};
    const byReason = {};
    const iterCounts = [];
    for (const e of entries) {
        const tool = typeof e.label === "string" ? e.label : "unknown";
        byTool[tool] = (byTool[tool] || 0) + 1;
        const evPath = path.join(root, e.runId, "events.jsonl");
        let raw;
        try { raw = fs.readFileSync(evPath, "utf8"); } catch { continue; }
        let terminal = null;
        let lastIter = 0;
        for (const { obj } of iterJsonlRows(raw)) {
            if (!obj || typeof obj.type !== "string") continue;
            // Reliability: a hand-edited or corrupted events.jsonl row with
            // a huge numeric literal (e.g. `1e500`) parses as Infinity in
            // JS — without `Number.isFinite` it would propagate to
            // `iters.max = Infinity` and `iters.mean = NaN`/Infinity,
            // silently breaking `autopilot stats`. The writer never emits
            // Infinity (JSON.stringify(Infinity) = "null"), so this only
            // bites for hand-edited rows; treat them like the other
            // malformed cases above and skip the iteration value.
            if (typeof obj.iteration === "number" && Number.isFinite(obj.iteration) && obj.iteration > lastIter) lastIter = obj.iteration;
            if (obj.type === "complete" || obj.type === "abort") terminal = obj;
        }
        if (terminal) {
            const key = typeof terminal.reason === "string" && terminal.reason
                ? `${terminal.type}:${terminal.reason}`
                : terminal.type;
            byReason[key] = (byReason[key] || 0) + 1;
        }
        if (lastIter > 0) iterCounts.push(lastIter);
    }
    // Use reduce instead of `Math.max(...iterCounts)`: the spread form
    // throws "Maximum call stack size exceeded" once iterCounts grows
    // past ~150k entries (Node's argument-count limit). A long-lived
    // user with daily self_improve runs would eventually hit that
    // ceiling and `autopilot stats` would silently crash. Reduce
    // handles arbitrary array sizes in O(n) without the spread.
    const max = iterCounts.length
        ? iterCounts.reduce((a, b) => (a > b ? a : b), 0)
        : 0;
    const mean = iterCounts.length
        ? iterCounts.reduce((a, b) => a + b, 0) / iterCounts.length
        : 0;
    return {
        total: entries.length,
        byTool,
        byReason,
        iters: { mean, max },
    };
}

/**
 * Parse a duration string like "30d", "12h", "5m" into milliseconds.
 * Strict: returns null for invalid input. No fractional values.
 */
export function parseDuration(input) {
    if (typeof input !== "string") return null;
    const m = /^(\d+)([dhm])$/.exec(input.trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = m[2];
    const ms = unit === "d" ? 86_400_000
        : unit === "h" ? 3_600_000
            : 60_000;
    return n * ms;
}

/**
 * Prune runs whose `armed` ts is older than `olderThanMs` from now.
 * Returns `{ removed: [{runId, ts}], kept: number }`. When `dryRun` is
 * true no filesystem changes are made.
 *
 * Blast-radius constraint: only deletes per-run directories under the
 * resolved runs root and rewrites index.jsonl in place.
 */
export function pruneRuns({
    olderThanMs,
    dryRun = false,
    now = Date.now,
    fs = fsDefault,
    path = pathDefault,
    os = osDefault,
    env = process.env,
} = {}) {
    if (typeof olderThanMs !== "number" || !Number.isFinite(olderThanMs) || olderThanMs < 0) {
        throw new TypeError("pruneRuns: olderThanMs must be a non-negative number");
    }
    const root = resolveRunsRoot({ env, os, path });
    const indexPath = path.join(root, "index.jsonl");
    const cutoff = now() - olderThanMs;
    const removed = [];
    const survivors = [];
    let raw;
    try {
        raw = fs.readFileSync(indexPath, "utf8");
    } catch (err) {
        if (err && err.code === "ENOENT") return { removed, kept: 0 };
        throw err;
    }
    for (const { obj, trimmed } of iterJsonlRows(raw)) {
        if (!isValidArmedIndexRow(obj)) continue;
        // Defence in depth: an index.jsonl row whose `runId` contains a
        // path separator or traversal segment must NEVER reach rmSync —
        // `path.join(root, "../etc")` resolves outside the runs root and
        // `rmSync(..., { force: true, recursive: true })` would happily
        // wipe out a sibling directory. The writer never produces such
        // ids (makeRunId emits `[A-Za-z0-9_-]+`), but a hand-edited or
        // corrupted index.jsonl could. Treat the row as a survivor so
        // the index keeps it but no destructive action runs.
        if (isPathTraversalRunId(obj.runId)) {
            survivors.push(trimmed);
            continue;
        }
        if (Number.isFinite(obj.ts) && obj.ts < cutoff) {
            removed.push({ runId: obj.runId, ts: obj.ts });
        } else {
            survivors.push(trimmed);
        }
    }
    if (!dryRun && removed.length > 0) {
        for (const { runId } of removed) {
            const runDir = path.join(root, runId);
            try {
                fs.rmSync(runDir, { recursive: true, force: true });
            } catch {
                // best-effort; surviving index entry would be misleading,
                // but we still rewrite the index to drop the reference
            }
        }
        const next = survivors.length ? survivors.join("\n") + "\n" : "";
        fs.writeFileSync(indexPath, next, { encoding: "utf8" });
    }
    return { removed, kept: survivors.length };
}
