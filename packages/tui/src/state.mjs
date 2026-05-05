// State-file reader for the autopilot TUI watcher (issue #121).
//
// The extension/handler.mjs autopilot loop atomically writes a JSON
// snapshot to ~/.copilot/autopilot/state.json on every mutation
// (atomic temp+rename — see persistState() over there). The TUI is a
// read-only consumer of that file: it polls, parses, and renders. No
// reverse channel; `q` only quits the TUI, never the loop.
//
// This module is the single boundary between disk and the rendered
// snapshot. Tolerant of every plausible disk failure (missing file,
// torn write caught mid-rename, hand-edited garbage, permission
// denied) — any failure surfaces as `null` so the renderer can show a
// "(no state file yet)" placeholder instead of crashing.
//
// The result-token regex is duplicated verbatim from
// `extension/handler.mjs#RESULT_TOKEN_RE` so the TUI does not need to
// import the extension package (cross-package imports drag the
// extension into the TUI's runtime). Drift between the two literals
// is pinned by the test in test/state.test.mjs.

import fsDefault from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// MUST stay in lockstep with `RESULT_TOKEN_RE` in
// extension/handler.mjs (drift-guarded by
// `RESULT_TOKEN_RE matches the extension's literal` in
// packages/tui/test/state.test.mjs which reads handler.mjs and
// asserts byte-equality).
export const RESULT_TOKEN_RE =
    /\[AUTOPILOT_RESULT:\s*(\{[^\[\]]*?\})\s*\]/;

/**
 * Default location of the extension's state file. Resolved lazily so
 * a test using `HOME=/tmp/foo` can pick up the override at call time.
 */
export function defaultStatePath() {
    return join(homedir(), ".copilot", "autopilot", "state.json");
}

/**
 * Read and parse the state file.
 *
 * @param {Object} [opts]
 * @param {string} [opts.path]  Override the state file location.
 * @param {object} [opts.fs]    Override Node fs (for tests).
 * @returns {object|null}       Parsed snapshot, or null when the file
 *   is missing / unreadable / corrupt / not an object.
 */
export function tryReadState({ path = defaultStatePath(), fs = fsDefault } = {}) {
    let raw;
    try {
        raw = fs.readFileSync(path, "utf8");
    } catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
}
