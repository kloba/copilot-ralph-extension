// Zero-dep JSONL event emitter for ralph_loop / self_improve / grow_project
// (issue #22). Mirrors the contract in packages/tui/src/{events,writer}.mjs
// but lives here next to handler.mjs so install.sh can copy it next to
// extension.mjs without dragging in the whole packages/tui workspace.
//
// All errors are swallowed: the loop must keep running even if the disk
// is full, the path is unwritable, or the user nuked ~/.copilot mid-run.
// The TUI only consumes whatever lines do land on disk.

import { homedir } from "node:os";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// Hard cap on a single serialized event line. Excerpts/tokens are
// truncated to fit so a runaway prompt can't blow up the JSONL file.
const MAX_EVENT_LINE_BYTES = 16 * 1024;
// Excerpts are capped at this many characters before serialization;
// belt-and-braces with the byte cap above. Keep in lockstep with
// packages/tui/src/events.mjs MAX_EXCERPT_CHARS.
const MAX_EXCERPT_CHARS = 500;

/** Resolve the runs root, honoring $RALPH_EVENTS_DIR. */
export function resolveRunsRoot(env = process.env) {
    const override = env?.RALPH_EVENTS_DIR;
    if (override && typeof override === "string" && override.trim()) {
        return override;
    }
    return join(homedir(), ".copilot", "ralph", "runs");
}

/** `${label}-${startedAt}` — stable, sortable, file-system safe.
 *
 * Lenient by design: this module's contract is "swallow every error
 * so the loop keeps running". A non-finite `startedAt` (undefined /
 * NaN / Infinity / string) would otherwise stringify to e.g.
 * `"ralph_loop-undefined"` and every subsequent invocation with the
 * same defect would collide on the same per-run directory, silently
 * overwriting events. Substitute `Date.now()` instead so each call
 * still gets a unique, sortable id even under degraded input.
 */
export function makeRunId(label, startedAt) {
    const safeLabel = String(label || "ralph_loop").replace(/[^A-Za-z0-9_-]/g, "_");
    const safeTs = Number.isFinite(startedAt) ? startedAt : Date.now();
    return `${safeLabel}-${safeTs}`;
}

function clipExcerpt(s) {
    if (typeof s !== "string") return s;
    if (s.length <= MAX_EXCERPT_CHARS) return s;
    return s.slice(0, MAX_EXCERPT_CHARS - 1) + "…";
}

function serialize(ev) {
    const cleaned = { ...ev };
    if (typeof cleaned.excerpt === "string") cleaned.excerpt = clipExcerpt(cleaned.excerpt);
    if (typeof cleaned.note === "string") cleaned.note = clipExcerpt(cleaned.note);
    // `JSON.stringify` throws on circular refs and BigInt. The
    // file-level contract is "swallow every error so the loop keeps
    // running" — so we must catch here too. A single malformed event
    // is dropped silently; the loop continues.
    let line;
    try { line = JSON.stringify(cleaned); }
    catch { return null; }
    if (Buffer.byteLength(line, "utf8") <= MAX_EVENT_LINE_BYTES) return line;
    // Last-resort: drop the excerpt/note entirely so at least the type +
    // ids land on disk.
    delete cleaned.excerpt;
    delete cleaned.note;
    try { line = JSON.stringify(cleaned); }
    catch { return null; }
    if (Buffer.byteLength(line, "utf8") <= MAX_EVENT_LINE_BYTES) return line;
    return null; // unrecoverable; caller swallows.
}

/**
 * Build a per-run event writer. Returned object has:
 *   - runId, eventsPath: disk locations.
 *   - write(ev): append `ev` (object) as one JSONL line. Best-effort.
 *   - close(): no-op today; reserved for future buffered backends.
 *
 * @param {Object} args
 * @param {string} args.label       Loop kind: ralph_loop | self_improve | grow_project.
 * @param {number} args.startedAt   armLoop's Date.now() snapshot.
 * @param {Object} [args.env]       Override process.env (tests).
 * @param {Object} [args.fs]        { mkdirSync, appendFileSync } overrides (tests).
 * @returns {{runId:string, eventsPath:string, write:(ev:object)=>void, close:()=>void}}
 */
export function createEventEmitter({ label, startedAt, env, fs } = {}) {
    const _mkdir = fs?.mkdirSync ?? mkdirSync;
    const _append = fs?.appendFileSync ?? appendFileSync;
    const root = resolveRunsRoot(env ?? process.env);
    const runId = makeRunId(label, startedAt);
    const dir = join(root, runId);
    const eventsPath = join(dir, "events.jsonl");
    const indexPath = join(root, "index.jsonl");

    let dirReady = false;
    const ensureDir = () => {
        if (dirReady) return;
        try { _mkdir(dir, { recursive: true }); dirReady = true; } catch { /* swallow */ }
    };

    const write = (ev) => {
        if (!ev || typeof ev !== "object") return;
        ensureDir();
        const line = serialize(ev);
        if (!line) return;
        try { _append(eventsPath, line + "\n"); } catch { /* swallow */ }
        if (ev.type === "armed") {
            // Maintain the run index so `ralph-tui list` can find this run
            // without scanning the whole runs root. The index entry MUST
            // include `type: "armed"` because the TUI's `readRunIndex`
            // (packages/tui/src/writer.mjs) filters for that exact field —
            // without it `ralph-tui list` and `ralph-tui stats` would skip
            // every run this emitter recorded. Mirrors writer.mjs's
            // `recordIndex` shape.
            const idx = serialize({
                type: "armed",
                runId,
                label,
                startedAt,
                maxIterations: ev.maxIterations ?? null,
                minIterations: ev.minIterations ?? null,
            });
            if (idx) {
                try { _append(indexPath, idx + "\n"); } catch { /* swallow */ }
            }
        }
    };

    return { runId, eventsPath, write, close: () => {} };
}
