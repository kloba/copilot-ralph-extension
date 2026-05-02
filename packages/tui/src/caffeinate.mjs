// Caffeinate-ancestry detection (issue #75).
//
// macOS-only helper that walks `process.ppid` ancestry once at TUI
// mount time and returns `true` when any ancestor process is named
// `caffeinate`. Powers the `<Header>` `☕ awake` pip so users running
// long self-improve loops under `caffeinate -i …` (per the README's
// recommendation) get an in-TUI confirmation that the wrapper took
// effect, rather than having to `ps`-grep from another terminal.
//
// Design choices:
//   * Stdlib-only — uses `node:child_process.spawnSync` to invoke
//     `ps -o comm=,ppid= -p <pid>` per ancestor (single call gets
//     both fields). No periodic polling, no subprocess at render-
//     time; the result is computed once, cached for the process
//     lifetime, and passed down through props.
//   * Short-circuits on non-darwin platforms — `process.platform !==
//     "darwin"` returns `false` immediately, so Linux / Windows users
//     pay zero detection cost and never see the pip.
//   * Defensive against ps failures — any spawn error, non-zero exit,
//     missing stdout, or unparseable line returns `null` rather than
//     throwing, and the walk terminates. The pip is purely
//     informational; a bogus render is worse than no render.
//   * Walks at most a small number of ancestors (cap below) to bound
//     the worst-case cost on a deeply-nested process tree (shells
//     inside shells inside terminal multiplexers). The `caffeinate`
//     wrapper is typically the immediate parent or grandparent, so
//     the cap is generous.
//   * Injectable seams (`ppid`, `platform`, `exec`) so the unit test
//     can mock the ancestry chain without spawning real processes.
//     Production callers pass no args and get the platform defaults.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import process from "node:process";

// Maximum ancestors to walk before giving up. Caffeinate is almost
// always the direct parent (`caffeinate -i node …`) or grandparent
// (`caffeinate -i bash -c '…'`). Eight is generous enough for the
// pathological tmux-inside-screen-inside-iterm case while still
// bounded — eight `spawnSync("ps")` calls is < 10ms on macOS.
const MAX_ANCESTORS = 8;

// Per-process cache. Caffeinate ancestry doesn't change over a TUI
// mount's lifetime (the parent process can't suddenly become
// `caffeinate`), so we compute once and reuse. `undefined` ⇒ not yet
// computed; `true` / `false` ⇒ cached result. Cleared by tests via
// the injectable seams (each call with explicit overrides recomputes).
let cached;

/** Default exec — single `ps -o comm=,ppid= -p <pid>` call returns
 *  both the command basename and the parent pid for `pid`. Returns
 *  `{ comm, ppid }` on success or `null` on any failure (process gone,
 *  ps unavailable, parse error). One subprocess per ancestor instead
 *  of two halves the worst-case mount-time cost. */
function defaultExec(pid) {
    try {
        const r = nodeSpawnSync("ps", ["-o", "comm=,ppid=", "-p", String(pid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            // Bounded ceiling so a wedged ps can't hang TUI startup.
            // 200ms mirrors the defaultGitExec ceiling in runner.mjs.
            timeout: 200,
        });
        if (r.status !== 0) return null;
        if (typeof r.stdout !== "string") return null;
        // Output is one line: "<comm> <ppid>" with the comm field
        // potentially containing spaces or being an absolute path.
        // Split on the LAST whitespace run so the trailing ppid
        // separates cleanly from a path-style comm.
        const trimmed = r.stdout.trim();
        if (!trimmed) return null;
        const lastSpace = trimmed.search(/\s+\d+$/);
        if (lastSpace < 0) return null;
        const comm = trimmed.slice(0, lastSpace);
        const ppidStr = trimmed.slice(lastSpace).trim();
        const ppid = Number.parseInt(ppidStr, 10);
        if (!Number.isFinite(ppid) || ppid < 0) return null;
        return { comm, ppid };
    } catch {
        return null;
    }
}

/** Extract the basename of a command path. `ps -o comm=` may print
 *  either a bare basename (`caffeinate`) or a full path
 *  (`/usr/bin/caffeinate`) depending on how the process was invoked.
 *  Strip everything before the last `/` so the comparison is
 *  consistent. Also handles a trailing `:` that ps occasionally
 *  appends for zombie / defunct processes. */
function basename(comm) {
    if (typeof comm !== "string") return "";
    const stripped = comm.replace(/:$/, "").trim();
    const slash = stripped.lastIndexOf("/");
    return slash >= 0 ? stripped.slice(slash + 1) : stripped;
}

/**
 * Detect whether the current process tree is wrapped by caffeinate.
 *
 * On macOS, walks the parent-process chain starting at `process.ppid`
 * and returns `true` if any ancestor's executable basename is
 * `caffeinate`. On any other platform, returns `false` without
 * spawning a subprocess.
 *
 * Cached for the process lifetime — re-invocation with no overrides
 * returns the cached value immediately. Tests pass explicit `ppid`,
 * `platform`, and `exec` overrides to bypass the cache and exercise
 * specific code paths.
 *
 * @param {object} [opts]
 * @param {number} [opts.ppid]              Override for `process.ppid`.
 * @param {string} [opts.platform]          Override for `process.platform`.
 * @param {(pid: number) => {comm: string, ppid: number}|null}
 *        [opts.exec]                       Override for the per-pid query.
 *                                          Returns `{ comm, ppid }` for
 *                                          `pid`, or `null` to terminate
 *                                          the walk (process gone /
 *                                          ps failure).
 * @returns {boolean}
 */
export function detectCaffeinate(opts = {}) {
    const hasOverrides = "ppid" in opts || "platform" in opts || "exec" in opts;
    if (!hasOverrides && cached !== undefined) return cached;

    const platform = opts.platform ?? process.platform;
    if (platform !== "darwin") {
        if (!hasOverrides) cached = false;
        return false;
    }

    const exec = typeof opts.exec === "function" ? opts.exec : defaultExec;
    let pid = opts.ppid ?? process.ppid;

    let result = false;
    for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
        if (!Number.isFinite(pid) || pid <= 1) break;
        const row = exec(pid);
        if (!row) break;
        if (basename(row.comm) === "caffeinate") {
            result = true;
            break;
        }
        pid = row.ppid;
    }

    if (!hasOverrides) cached = result;
    return result;
}

/** Reset the per-process cache. Test-only seam — exported so unit
 *  tests can pin a specific result, then clear so production callers
 *  start fresh. Production code never calls this. */
export function _resetCacheForTest() {
    cached = undefined;
}
