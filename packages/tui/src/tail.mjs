// Stdlib-only JSONL file reader / tailer for the ralph TUI (issue #22).
//
// readEventsFile() reads a complete events.jsonl synchronously — used by
// `replay` for fixed historical runs and by tests.
//
// tailJsonlFile() is the generic tailer: it watches a JSONL file, parses
// each line via a caller-supplied `parseLine` predicate, and stops when
// the caller-supplied `isTerminal` predicate returns truthy (or runs
// forever if `isTerminal` is omitted). Inode + birthtime + size tracking
// already covers rotation, truncation, replacement, and ENOENT polling.
//
// tailEventsFile() is the events-flavoured wrapper used by the rest of
// the TUI: it parses lines via `parseEventLine` (so unknown-type lines
// are dropped) and stops on `complete` / `abort` markers.
//
// tailSessionFile() (issue #57) is the session-log wrapper used by the
// live-output panel: it parses lines via permissive JSON.parse so the
// Copilot CLI's evolving event schema can land lines we don't yet
// recognise without us silently dropping them. The session log has no
// terminal marker — the consumer aborts via signal when its loop ends.
//
// Zero deps (Node stdlib only) — same constraint as the rest of the
// TUI's non-render layer. Only the Ink renderer gets to depend on
// user-space packages.

import fsDefault from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { parseEventLine } from "./events.mjs";

const TERMINAL_TYPES = new Set(["complete", "abort"]);

/**
 * JSON.parse the line, returning null on any error so a malformed line
 * silently disappears — matches parseEventLine's tolerance contract.
 *
 * @param {string} line
 * @returns {object|null}
 */
function safeJsonParse(line) {
    try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Read and parse every JSONL line in `filePath`. Skips malformed lines
 * silently (matches parseEventLine's tolerance contract). Missing file →
 * empty array so callers can `replay` a run that hasn't started yet.
 *
 * @param {string} filePath
 * @param {{ fs?: object }} [deps]
 * @returns {object[]}
 */
export function readEventsFile(filePath, { fs = fsDefault } = {}) {
    if (typeof filePath !== "string" || !filePath) {
        throw new TypeError("readEventsFile: filePath must be a non-empty string");
    }
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
        if (err && err.code === "ENOENT") return [];
        throw err;
    }
    return splitAndParse(raw);
}

/**
 * Split a buffer of newline-separated JSONL into parsed events, dropping
 * malformed lines. Exported for tests + plain.mjs's stream renderer.
 */
export function splitAndParse(buf) {
    if (typeof buf !== "string" || buf.length === 0) return [];
    const out = [];
    for (const line of buf.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const ev = parseEventLine(trimmed);
        if (ev) out.push(ev);
    }
    return out;
}

/**
 * Tail a JSONL file and yield parsed objects as they arrive. Generic
 * version: caller supplies `parseLine` and (optionally) `isTerminal`.
 *
 * Implementation notes:
 *   - We track the byte offset of the last fully-consumed line so a
 *     partial trailing line (writer mid-flush) gets re-read on the next
 *     tick instead of being parsed twice.
 *   - Polling interval defaults to 200ms — small enough that human-paced
 *     iteration boundaries feel live; large enough that idle CI tails
 *     don't burn cpu. fs.watch is layered on top so we wake up
 *     immediately when the file actually grows.
 *   - When the file doesn't yet exist we poll for it. The watch path
 *     deliberately does not throw on ENOENT.
 *   - `parseLine` returning `null` drops the line silently; this is the
 *     mechanism by which both events.jsonl (unknown type) and session
 *     log (malformed JSON) tolerate noise.
 *   - `isTerminal` is consulted on each yielded value; truthy means
 *     "no further events will be of interest, stop the iterator".
 *     Omit to tail forever (until signal aborts).
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {object} [options.fs]                    Override fs (tests).
 * @param {AbortSignal} [options.signal]           Cancel the iterator.
 * @param {number} [options.pollMs]                Polling interval. Default 200.
 * @param {(line: string) => object|null} [options.parseLine] Line parser; null → drop.
 * @param {(ev: object) => boolean} [options.isTerminal]      Stop predicate.
 * @param {() => Promise<void>} [options.sleep]    Test-only sleep injector.
 * @returns {AsyncIterable<object>}
 */
export function tailJsonlFile(filePath, options = {}) {
    if (typeof filePath !== "string" || !filePath) {
        throw new TypeError("tailJsonlFile: filePath must be a non-empty string");
    }
    const fs = options.fs ?? fsDefault;
    const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : 200;
    const parseLine = typeof options.parseLine === "function" ? options.parseLine : safeJsonParse;
    const isTerminal = typeof options.isTerminal === "function" ? options.isTerminal : null;
    const signal = options.signal;
    const sleep = options.sleep ?? ((ms) => delay(ms, undefined, { signal }));

    return {
        async *[Symbol.asyncIterator]() {
            let offset = 0;
            let pending = "";
            let done = false;
            // Last-known size + inode; lets us detect "is there new content?"
            // without re-reading on every tick AND notice when the file was
            // replaced (replay overwrote it / log rotated). Inode beats
            // size-comparison alone because a rewrite that happens to land
            // at the same total size would otherwise be invisible.
            let lastSize = -1;
            let lastIno = null;
            // Linux frequently reallocates a freed inode number for the
            // very next file in the same directory, so `ino` alone can
            // miss an unlink+create replacement when the new file's
            // first line happens to match the old file's byte length.
            // birthtimeMs is bound to the underlying inode allocation:
            // a reallocated inode gets a fresh btime even when its
            // number repeats. Tracking both gives us a reliable
            // "this is a different file" signal across rotation.
            let lastBirthtimeMs = null;

            while (!done) {
                if (signal?.aborted) return;

                let stat;
                try {
                    stat = fs.statSync(filePath);
                } catch (err) {
                    if (!err || err.code !== "ENOENT") throw err;
                    // File hasn't appeared yet — wait and retry.
                    try { await sleep(pollMs); } catch { return; }
                    continue;
                }
                // File replaced → restart from offset 0 even when
                // stat.size grew. Without this a writeFileSync overwrite
                // that produces a larger payload would be read starting
                // mid-body. We treat *either* a different inode *or* a
                // different birthtime as a replacement signal so
                // inode-reuse-after-unlink (common on ext4) still
                // triggers the reset.
                const birthtimeMs = Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : null;
                const inoChanged = lastIno !== null && stat.ino !== lastIno;
                const btimeChanged =
                    lastBirthtimeMs !== null
                    && birthtimeMs !== null
                    && birthtimeMs !== lastBirthtimeMs;
                if (inoChanged || btimeChanged) {
                    offset = 0;
                    pending = "";
                    lastSize = -1;
                }
                lastIno = stat.ino;
                lastBirthtimeMs = birthtimeMs;
                if (stat.size === lastSize) {
                    try { await sleep(pollMs); } catch { return; }
                    continue;
                }
                if (stat.size < offset) {
                    // File was truncated in place (writer reset). Restart.
                    offset = 0;
                    pending = "";
                }

                let chunk;
                try {
                    const fd = fs.openSync(filePath, "r");
                    try {
                        const remaining = stat.size - offset;
                        if (remaining <= 0) {
                            lastSize = stat.size;
                            try { await sleep(pollMs); } catch { return; }
                            continue;
                        }
                        const buf = Buffer.alloc(remaining);
                        fs.readSync(fd, buf, 0, remaining, offset);
                        chunk = buf.toString("utf8");
                    } finally {
                        fs.closeSync(fd);
                    }
                } catch (err) {
                    if (err && err.code === "ENOENT") {
                        // Race: file vanished between stat and open.
                        try { await sleep(pollMs); } catch { return; }
                        continue;
                    }
                    throw err;
                }

                offset = stat.size;
                lastSize = stat.size;
                const data = pending + chunk;
                const newlineAt = data.lastIndexOf("\n");
                if (newlineAt === -1) {
                    // No complete line yet — buffer everything.
                    pending = data;
                    try { await sleep(pollMs); } catch { return; }
                    continue;
                }
                const ready = data.slice(0, newlineAt);
                pending = data.slice(newlineAt + 1);
                for (const line of ready.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    const ev = parseLine(trimmed);
                    if (!ev) continue;
                    yield ev;
                    if (isTerminal && isTerminal(ev)) {
                        done = true;
                        break;
                    }
                }
                if (done) return;
                // Brief yield even on a busy file so the consumer can
                // advance between batches and so signal aborts are
                // checked promptly.
                try { await sleep(pollMs); } catch { return; }
            }
        },
    };
}

/**
 * Tail an events.jsonl produced by extension/events-emit.mjs. Validates
 * each line via parseEventLine (drops unknown event types) and stops on
 * `complete` / `abort` markers (unless `stopOnTerminal: false`).
 *
 * Thin wrapper around `tailJsonlFile` — see that function's options for
 * everything except the events-specific knobs documented below.
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {boolean} [options.stopOnTerminal] Auto-stop on complete/abort. Default true.
 * @returns {AsyncIterable<object>}
 */
export function tailEventsFile(filePath, options = {}) {
    if (typeof filePath !== "string" || !filePath) {
        throw new TypeError("tailEventsFile: filePath must be a non-empty string");
    }
    const stopOnTerminal = options.stopOnTerminal !== false;
    return tailJsonlFile(filePath, {
        fs: options.fs,
        signal: options.signal,
        pollMs: options.pollMs,
        sleep: options.sleep,
        parseLine: parseEventLine,
        isTerminal: stopOnTerminal ? (ev) => TERMINAL_TYPES.has(ev.type) : null,
    });
}

/**
 * Tail a Copilot CLI session log at
 * `~/.copilot/session-state/<sessionId>.jsonl` (issue #57). Permissive
 * JSON.parse so a schema evolution upstream lands without us dropping
 * lines. No terminal predicate — the session log outlives any single
 * arm; the consumer aborts via `signal` when its loop unmounts.
 *
 * @param {string} filePath
 * @param {Object} [options]  Same shape as `tailJsonlFile` minus `parseLine`/`isTerminal`.
 * @returns {AsyncIterable<object>}
 */
export function tailSessionFile(filePath, options = {}) {
    if (typeof filePath !== "string" || !filePath) {
        throw new TypeError("tailSessionFile: filePath must be a non-empty string");
    }
    return tailJsonlFile(filePath, {
        fs: options.fs,
        signal: options.signal,
        pollMs: options.pollMs,
        sleep: options.sleep,
        parseLine: safeJsonParse,
        isTerminal: null,
    });
}
