// Shared resolver for the on-disk runs root. Three call sites
// (`writer.mjs::resolveRunsRoot`, `events-emit.mjs::resolveRunsRoot`,
// `runner.mjs::resolveStateRoot`) all need the same precedence +
// legacy-fallback contract; centralising the logic here means a future
// hardening pass (a fourth env-var name, a different sentinel path,
// etc.) lands in one place instead of three.
//
// Stdlib-only. All filesystem / clock dependencies are injected so
// tests can pin behaviour against tmp dirs and fake stderrs.

import { homedir as defaultHomedir } from "node:os";
import {
    existsSync as defaultExistsSync,
    mkdirSync as defaultMkdirSync,
    writeFileSync as defaultWriteFileSync,
} from "node:fs";
import { join } from "node:path";

const LEGACY_ENV_NOTICE =
    "[autopilot] note: $RALPH_TUI_RUNS_DIR is deprecated; "
    + "prefer $AUTOPILOT_RUNS_DIR (still honored)\n";

const LEGACY_PATH_NOTICE =
    "[autopilot] note: reading runs from legacy "
    + "~/.copilot/ralph-tui/runs (default is now "
    + "~/.copilot/autopilot/runs)\n";

const SENTINEL_NAME = ".migrated-from-ralph-tui";

// Module-level dedup flags (one-shot per process). Resets via
// `__resetLegacyWarnGuards` for tests that exercise the side-effecting
// branches and need a clean baseline.
let warnedLegacyEnvVar = false;
let warnedLegacyPath = false;

export function __resetLegacyWarnGuards() {
    warnedLegacyEnvVar = false;
    warnedLegacyPath = false;
}

function safeWrite(stderr, msg) {
    try { stderr.write?.(msg); } catch { /* swallow — never crash the loop */ }
}

/** Resolve the runs root.
 *
 * Precedence:
 *   1. $AUTOPILOT_RUNS_DIR (preferred).
 *   2. $RALPH_TUI_RUNS_DIR (legacy; one-shot stderr deprecation notice).
 *   3. `${HOME}/.copilot/autopilot/runs`, with a one-shot stderr
 *      migration notice + read-fallback to `${HOME}/.copilot/ralph-tui/runs`
 *      when the new default doesn't yet exist but the legacy one does.
 *
 * Env-var values are `.trim()`-ed: shells routinely leak surrounding
 * whitespace into env vars (heredocs, Makefile interpolation,
 * copy-paste) and a path with stray spaces creates a runs root with
 * literal spaces in its name, breaking the matching `autopilot list`
 * glob.
 */
export function resolveRunsRoot(env = process.env, deps = {}) {
    const existsSync = deps.fs?.existsSync ?? defaultExistsSync;
    const stderr = deps.stderr ?? process.stderr;
    const homedir = deps.os?.homedir ?? defaultHomedir;

    const primary = env?.AUTOPILOT_RUNS_DIR;
    if (typeof primary === "string" && primary.trim()) return primary.trim();

    const legacy = env?.RALPH_TUI_RUNS_DIR;
    if (typeof legacy === "string" && legacy.trim()) {
        if (!warnedLegacyEnvVar) {
            warnedLegacyEnvVar = true;
            safeWrite(stderr, LEGACY_ENV_NOTICE);
        }
        return legacy.trim();
    }

    const home = homedir();
    const newDefault = join(home, ".copilot", "autopilot", "runs");
    const legacyDefault = join(home, ".copilot", "ralph-tui", "runs");

    let newExists = false;
    try { newExists = existsSync(newDefault); } catch { /* swallow */ }
    if (newExists) return newDefault;

    let legacyExists = false;
    try { legacyExists = existsSync(legacyDefault); } catch { /* swallow */ }
    if (legacyExists) {
        if (!warnedLegacyPath) {
            warnedLegacyPath = true;
            safeWrite(stderr, LEGACY_PATH_NOTICE);
        }
        return legacyDefault;
    }
    return newDefault;
}

/** Best-effort touch of `<NEW_DEFAULT_ROOT>/.migrated-from-ralph-tui`
 *  after a successful new-root mkdir, so subsequent process invocations
 *  no longer print the legacy-path migration notice. Skipped when the
 *  user has overridden the runs root via either env var: the migration
 *  story only applies to the unconfigured default. Failures are
 *  swallowed; the worst case is one re-printed notice on the next
 *  invocation.
 */
export function touchMigrationSentinel(env = process.env, deps = {}) {
    if (!env) return;
    if ((typeof env.AUTOPILOT_RUNS_DIR === "string" && env.AUTOPILOT_RUNS_DIR.length > 0)
        || (typeof env.RALPH_TUI_RUNS_DIR === "string" && env.RALPH_TUI_RUNS_DIR.length > 0)) {
        return;
    }
    const mkdir = deps.fs?.mkdirSync ?? defaultMkdirSync;
    const writeFile = deps.fs?.writeFileSync ?? defaultWriteFileSync;
    const homedir = deps.os?.homedir ?? defaultHomedir;
    const newDefault = join(homedir(), ".copilot", "autopilot", "runs");
    const sentinel = join(newDefault, SENTINEL_NAME);
    try {
        mkdir(newDefault, { recursive: true });
        writeFile(sentinel, "");
    } catch { /* swallow */ }
}
