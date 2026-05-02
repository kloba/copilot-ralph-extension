// Zero-dep JSONL event emitter for ap_loop / self_improve / grow_project
// (issue #22). Mirrors the contract in packages/tui/src/{events,writer}.mjs
// but lives here next to handler.mjs so install.sh can copy it next to
// extension.mjs without dragging in the whole packages/tui workspace.
//
// All errors are swallowed: the loop must keep running even if the disk
// is full, the path is unwritable, or the user nuked ~/.copilot mid-run.
// The TUI only consumes whatever lines do land on disk.

import { homedir } from "node:os";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// Hard cap on a single serialized event line. Excerpts/tokens are
// truncated to fit so a runaway prompt can't blow up the JSONL file.
const MAX_EVENT_LINE_BYTES = 16 * 1024;
// Excerpts are capped at this many characters before serialization;
// belt-and-braces with the byte cap above. The TUI side carries the
// matching cap inline as the literal `500` argument to two
// `safeSliceChars(..., 500)` call sites in
// `packages/tui/src/events.mjs`'s `serializeEvent` (one for `excerpt`,
// one for `note`). A drift between the two sides would break the
// JSONL contract — emitter writes longer than reader's expected cap
// can mean the reader silently re-clips data the emitter believed
// was already final, or oversize-line guards on either side mis-fire.
// A drift-guard test in `test/events-emit.test.mjs` reads both sides
// and asserts they agree.
const MAX_EXCERPT_CHARS = 500;

// Print a one-line stderr deprecation notice the FIRST time a given
// migration trigger fires, then drop a sentinel line under
// ~/.copilot/autopilot/ so subsequent runs (in this or any later
// process) stay silent. The sentinel file accumulates one line per
// distinct `key`, so an environment that hits both the legacy env
// var and the legacy default path eventually quiets both. Best-
// effort: every fs/stderr call is try/caught so a read-only home
// (CI cache, sandbox, etc.) cannot crash the loop.
function emitDeprecationOnce({ key, message, sentinelPath, fs, stderr }) {
    try {
        const content = fs.readFileSync(sentinelPath, "utf8");
        if (content.split("\n").some((l) => l === key)) return;
    } catch { /* sentinel missing or unreadable */ }
    try {
        stderr.write(message);
        fs.mkdirSync(dirname(sentinelPath), { recursive: true });
        fs.appendFileSync(sentinelPath, key + "\n");
    } catch { /* best-effort */ }
}

/** Resolve the runs root, preferring $AUTOPILOT_EVENTS_DIR, falling back to
 *  $RALPH_EVENTS_DIR (deprecated), then to the new default
 *  ~/.copilot/autopilot/events. If the new default doesn't exist but the old
 *  ~/.copilot/ralph/runs does, returns the old path with a one-time stderr
 *  deprecation notice (sentinel-gated under ~/.copilot/autopilot/).
 *
 * The env-var path is `.trim()`-ed before being returned (same reasoning
 * as before: trailing whitespace from shell heredocs, Makefile vars, etc.).
 */
export function resolveRunsRoot({
    env = process.env,
    os: osArg = { homedir },
    path: pathArg = { join, dirname },
    fs: fsArg = { readFileSync, appendFileSync, mkdirSync, existsSync },
    stderr: stderrArg = process.stderr,
    sentinelPath: sentinelPathArg,
} = {}) {
    const home = osArg.homedir();
    const pJoin = pathArg.join ?? join;
    const sentinelPath = sentinelPathArg ?? pJoin(home, ".copilot", "autopilot", ".migration-notice-shown");

    // Primary: $AUTOPILOT_EVENTS_DIR
    const newOverride = env?.AUTOPILOT_EVENTS_DIR;
    if (typeof newOverride === "string" && newOverride.trim()) return newOverride.trim();

    // Legacy fallback: $RALPH_EVENTS_DIR (deprecated)
    const legacyOverride = env?.RALPH_EVENTS_DIR;
    if (typeof legacyOverride === "string" && legacyOverride.trim()) {
        emitDeprecationOnce({
            key: "env:RALPH_EVENTS_DIR",
            message: "[autopilot] note: env $RALPH_EVENTS_DIR is deprecated, please use $AUTOPILOT_EVENTS_DIR (still honored)\n",
            sentinelPath,
            fs: fsArg,
            stderr: stderrArg,
        });
        return legacyOverride.trim();
    }

    // Default paths
    const newDefault = pJoin(home, ".copilot", "autopilot", "events");
    const oldDefault = pJoin(home, ".copilot", "ralph", "runs");

    // If new default doesn't exist but old does, fall back with a notice
    let newExists = false;
    let oldExists = false;
    try { newExists = fsArg.existsSync(newDefault); } catch { /* swallow */ }
    try { oldExists = fsArg.existsSync(oldDefault); } catch { /* swallow */ }

    if (!newExists && oldExists) {
        emitDeprecationOnce({
            key: `path:${oldDefault}`,
            message: `[autopilot] note: reading from legacy ~/.copilot/ralph/runs (default is now ~/.copilot/autopilot/events)\n`,
            sentinelPath,
            fs: fsArg,
            stderr: stderrArg,
        });
        return oldDefault;
    }

    return newDefault;
}

/** `${label}-${startedAt}` — stable, sortable, file-system safe.
 *
 * Lenient by design: this module's contract is "swallow every error
 * so the loop keeps running". A non-finite `startedAt` (undefined /
 * NaN / Infinity / string) would otherwise stringify to e.g.
 * `"ap_loop-undefined"` and every subsequent invocation with the
 * same defect would collide on the same per-run directory, silently
 * overwriting events. Substitute `Date.now()` instead so each call
 * still gets a unique, sortable id even under degraded input.
 */
export function makeRunId(label, startedAt) {
    const safeLabel = String(label || "ap_loop").replace(/[^A-Za-z0-9_-]/g, "_");
    const safeTs = Number.isFinite(startedAt) ? startedAt : Date.now();
    return `${safeLabel}-${safeTs}`;
}

function clipExcerpt(s) {
    if (typeof s !== "string") return s;
    if (s.length <= MAX_EXCERPT_CHARS) return s;
    // Surrogate-pair safety: a naïve `s.slice(0, MAX_EXCERPT_CHARS - 1)`
    // can land inside a 4-byte char (emoji, astral plane symbol) and
    // emit a lone high surrogate — which is technically valid UTF-16
    // but renders as a replacement character in most terminals and
    // breaks any consumer doing strict UTF-8 validation downstream
    // (e.g. a Python tail of events.jsonl with `errors='strict'`).
    // Mirror the `safeSliceEnd` helper in `handler.mjs`: if the last
    // kept code unit is a high surrogate, back off by one so the pair
    // stays intact (we drop a single astral char rather than emit a
    // lone surrogate). Keeping events-emit.mjs zero-dep means we
    // inline the four-line check rather than import from handler.mjs.
    let cut = MAX_EXCERPT_CHARS - 1;
    const code = s.charCodeAt(cut - 1);
    if (code >= 0xD800 && code <= 0xDBFF) cut -= 1;
    return s.slice(0, cut) + "…";
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
 * @param {string} args.label       Loop kind: ap_loop | self_improve | grow_project.
 * @param {number} args.startedAt   armLoop's Date.now() snapshot.
 * @param {Object} [args.env]       Override process.env (tests).
 * @param {Object} [args.fs]        { mkdirSync, appendFileSync } overrides (tests).
 * @returns {{runId:string, eventsPath:string, write:(ev:object)=>void, close:()=>void}}
 */
export function createEventEmitter({ label, startedAt, env, fs } = {}) {
    const _mkdir = fs?.mkdirSync ?? mkdirSync;
    const _append = fs?.appendFileSync ?? appendFileSync;
    const root = resolveRunsRoot({ env: env ?? process.env });
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
        // Arrays are typeof "object" in JS but `{ ...ev }` on an array
        // produces `{"0": v0, "1": v1, …}` — a meaningless event with
        // numeric-string keys and no `type` field. The TUI would then
        // log a "skipped: missing type" warning per array. Reject up
        // front so a buggy caller cannot pollute the JSONL stream.
        if (!ev || typeof ev !== "object" || Array.isArray(ev)) return;
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
