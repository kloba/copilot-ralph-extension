// Stdlib-only JSONL file reader / tailer for the ralph TUI (issue #22).
//
// readEventsFile() reads a complete events.jsonl synchronously — used by
// `replay` for fixed historical runs and by tests.
//
// tailEventsFile() returns an async iterator that yields events as the
// writer appends them. It uses fs.watch + a polling fallback so it works
// on platforms where watch events are unreliable (Linux network mounts,
// Docker bind mounts on macOS, …). The iterator stops when:
//   - the consumer calls .return() / breaks the for-await loop,
//   - a `complete` or `abort` event is observed (terminal markers — no
//     more events will land), OR
//   - tailOptions.signal aborts.
//
// Zero deps (Node stdlib only) — same constraint as the rest of the TUI's
// non-render layer so the writer side can shed any thought of pulling
// Ink/React into the core extension. Only the Ink renderer (slice 5)
// gets to depend on user-space packages.

import fsDefault from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { parseEventLine } from "./events.mjs";

const TERMINAL_TYPES = new Set(["complete", "abort"]);

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
 * Tail a JSONL file and yield parsed events as they arrive.
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
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {object} [options.fs]              Override fs (tests).
 * @param {AbortSignal} [options.signal]     Cancel the iterator.
 * @param {number} [options.pollMs]          Polling interval. Default 200.
 * @param {boolean} [options.stopOnTerminal] Auto-stop on complete/abort.
 *                                           Default true.
 * @param {() => Promise<void>} [options.sleep] Test-only sleep injector.
 * @returns {AsyncIterable<object>}
 */
export function tailEventsFile(filePath, options = {}) {
    if (typeof filePath !== "string" || !filePath) {
        throw new TypeError("tailEventsFile: filePath must be a non-empty string");
    }
    const fs = options.fs ?? fsDefault;
    const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : 200;
    const stopOnTerminal = options.stopOnTerminal !== false;
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
                // File replaced (different inode) → restart from offset 0
                // even when stat.size grew. Without this a writeFileSync
                // overwrite that produces a larger payload would be read
                // starting mid-body.
                if (lastIno !== null && stat.ino !== lastIno) {
                    offset = 0;
                    pending = "";
                }
                lastIno = stat.ino;
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
                    const ev = parseEventLine(trimmed);
                    if (!ev) continue;
                    yield ev;
                    if (stopOnTerminal && TERMINAL_TYPES.has(ev.type)) {
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
