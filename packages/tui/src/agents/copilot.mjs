// Backend adapter for the GitHub Copilot CLI driving an iter of the
// `autopilot run` loop. This module is the canonical extraction of
// the historical hardcoded `copilot -p ... --allow-all-tools
// --output-format json` invocation that lived inline in
// `runner.mjs:runOneIteration` (issue #83).
//
// The adapter shape (`spawnArgs` / `parseStream` / `extractUsage`) is
// intentionally tiny so a future agent (Claude Code today, then Cursor
// / Aider / gemini-cli on demand) can be added by writing one new file
// and registering it in `bin/tui.mjs`'s subcommand dispatch — no
// branching inside the runner.
//
// The runner is the only call site for `spawnArgs`. The other two
// helpers (`parseStream`, `extractUsage`) wrap the existing pure-data
// reducer (`reduceCopilotEvents` in `runner.mjs`); they're exported
// from the adapter module so the test suite can exercise the adapter
// surface without re-importing the runner.
//
// Stdlib-only. Pure ESM, `node:` prefix on stdlib imports.

import process from "node:process";
import { spawnSync as nodeSpawnSync } from "node:child_process";

import { parseNdjsonLines } from "./_shared.mjs";

export const name = "copilot";

/** Default executable name on $PATH. Override via `binEnvVar`. */
export const defaultBin = "copilot";

/** Per-agent env-var override that wins over `defaultBin`. */
export const binEnvVar = "AUTOPILOT_COPILOT_BIN";

/** One-shot guard for the legacy-env-var deprecation notice — we
 *  warn on the first read and stay silent thereafter so a long-running
 *  loop with multiple iters doesn't paint the same line every iter. */
let warnedLegacyEnv = false;

/** Resolve the binary path the runner should spawn for a Copilot iter.
 *  Precedence:
 *    1. Caller-supplied override (`copilotBin` arg in the runner —
 *       used by the test suite to inject a Node-shim that emits
 *       scripted JSONL).
 *    2. New `AUTOPILOT_COPILOT_BIN` env var.
 *    3. Legacy `RALPH_TUI_COPILOT_BIN` env var (deprecated; emits a
 *       one-shot stderr notice the first time it's read).
 *    4. The literal string `"copilot"` — resolved against $PATH by
 *       child_process.spawn.
 *
 *  Exported for the test suite (the deprecation-notice path is
 *  side-effecting via stderr, so the test asserts on a captured
 *  stderr string).
 */
export function resolveBin({ override, env = process.env, stderr = process.stderr } = {}) {
    if (override) return override;
    if (env[binEnvVar]) return env[binEnvVar];
    if (env.RALPH_TUI_COPILOT_BIN) {
        if (!warnedLegacyEnv) {
            warnedLegacyEnv = true;
            try {
                stderr.write?.(
                    `autopilot: RALPH_TUI_COPILOT_BIN is deprecated; use AUTOPILOT_COPILOT_BIN instead. `
                    + `The legacy name will be removed in a future release.\n`,
                );
            } catch { /* swallow — a write failure here must not crash the loop */ }
        }
        return env.RALPH_TUI_COPILOT_BIN;
    }
    return defaultBin;
}

/** Test seam — reset the deprecation-warn one-shot guard. The runner
 *  itself never calls this; the test suite uses it to keep adjacent
 *  test cases independent of each other's side-effect history. */
export function __resetDeprecationGuard() { warnedLegacyEnv = false; }

/** Build the Copilot CLI argv (after the bin) for a single iter.
 *
 *  The Copilot CLI emits a stream of JSON objects (one per agent
 *  event) on stdout when invoked with `--output-format json`; the
 *  iter-terminal `result` event carries `result.sessionId`, which the
 *  driver captures on iter 1 of `--continue` mode and re-uses via
 *  `--resume=<sessionId>` from iter 2 onward.
 *
 *  `--allow-all-tools` is the "yolo" permission flag — the Copilot
 *  CLI's "trust everything the agent wants to do" mode. The
 *  subcommand path (`autopilot copilot ...`) defaults to it
 *  unconditionally; a future `--no-yolo` escape hatch is out of
 *  scope per the issue.
 */
export function spawnArgs(prompt, { resumeSessionId, sessionName, extraArgs = [] } = {}) {
    const args = ["-p", prompt, "--allow-all-tools", "--output-format", "json"];
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    else if (sessionName) args.push("-n", sessionName);
    for (const a of extraArgs) args.push(a);
    return { args, env: undefined };
}

/** Parse the Copilot CLI stdout stream. The CLI emits one JSON object
 *  per line. Re-export of the shared NDJSON parser so the adapter
 *  surface stays uniform across backends. */
export const parseStream = parseNdjsonLines;

/** Extract the per-iter usage rollup from a parsed Copilot event
 *  array. Mirrors the existing `reduceCopilotEvents` shape so the
 *  runner can keep the rest of its accounting unchanged.
 *
 *    - `input`  — Copilot CLI does not surface input tokens in the
 *                 JSONL stream; field collapses to `null`.
 *    - `output` — sum of root-agent `assistant.message.data.outputTokens`
 *                 (sub-agent / `agentId` events are excluded; their
 *                 cost is folded into the parent's premiumRequests).
 *                 Malformed values (NaN, Infinity, negative,
 *                 non-numeric) are skipped so a partial stream returns
 *                 the best-available total instead of mass-zeroing.
 *    - `premiumRequests` — from terminal `result.usage.premiumRequests`;
 *                 `null` when the field is absent or malformed.
 */
export function extractUsage(events) {
    let output = 0;
    let premiumRequests = null;
    for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "assistant.message" && ev.data && !ev.agentId) {
            const tok = ev.data.outputTokens;
            if (typeof tok === "number" && Number.isFinite(tok) && tok >= 0) {
                output += tok;
            }
        }
        if (ev.type === "result" && ev.usage && typeof ev.usage === "object") {
            const pr = ev.usage.premiumRequests;
            if (typeof pr === "number" && Number.isFinite(pr) && pr >= 0) {
                premiumRequests = pr;
            }
        }
    }
    return { input: null, output, premiumRequests };
}

// ─── CLI version compatibility (issue #105) ────────────────────────
//
// The Copilot CLI removed `--output-format json` somewhere in its
// `0.0.x` line and re-added it in `1.0.0`. A user with an older build
// running `autopilot copilot` sees an opaque
//   error: unknown option '--output-format'
// from the failed iter-1 spawn. The helpers below let `cmdRun` and
// `cmdDoctor` probe `copilot --version` once at startup, compare
// against `MIN_KNOWN_GOOD_CLI_VERSION`, and surface a friendlier
// "please upgrade your Copilot CLI" message before the user has to
// reverse-engineer the failure mode.
//
// The minimum version is phrased as "known supported" rather than a
// hard semver floor — older 0.0.x builds may also work, but we have
// not verified them, so the `too-old` warning is informational
// rather than blocking. The runtime path warns and proceeds; doctor
// reports the status without affecting its exit code (so a user
// running doctor before installing Copilot CLI doesn't get a
// scripting-unfriendly non-zero exit).

/** First Copilot CLI release verified to support
 *  `--output-format json`. Older 0.0.x builds may also work; this is
 *  the floor we surface in user-facing warnings. */
export const MIN_KNOWN_GOOD_CLI_VERSION = "1.0.0";

/** Parse a Copilot CLI `--version` line such as
 *    "GitHub Copilot CLI 1.0.40."
 *  or a bare
 *    "1.0.40"
 *  into a `[major, minor, patch]` numeric tuple, or `null` if no
 *  triple can be located. Pure / no I/O — exported for tests. */
export function parseCliVersion(raw) {
    if (typeof raw !== "string") return null;
    const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    const triple = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (triple.some((n) => !Number.isFinite(n) || n < 0)) return null;
    return triple;
}

/** Compare two `[major, minor, patch]` triples. Returns -1 / 0 / 1.
 *  Throws on non-array inputs so a caller can't pass a parse-failure
 *  through unnoticed. Pure / no I/O — exported for tests. */
export function compareCliVersion(a, b) {
    if (!Array.isArray(a) || a.length !== 3 || !Array.isArray(b) || b.length !== 3) {
        throw new TypeError("compareCliVersion: both args must be [major, minor, patch] triples");
    }
    for (let i = 0; i < 3; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }
    return 0;
}

/** Default exec-fn for `checkCliVersion`. Wraps `spawnSync(bin,
 *  ['--version'])` with a 2 s timeout and ENOENT/permission/timeout
 *  detection so the caller can render a precise reason without
 *  parsing error messages. Tests inject a stub directly. */
function defaultVersionExec(bin) {
    let r;
    try {
        r = nodeSpawnSync(bin, ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 2000,
        });
    } catch (err) {
        return { ok: false, reason: "exec-failed", error: err };
    }
    if (r.error) {
        const code = r.error.code;
        if (code === "ENOENT") return { ok: false, reason: "missing", error: r.error };
        return { ok: false, reason: "exec-failed", error: r.error };
    }
    if (r.status !== 0) {
        return { ok: false, reason: "exec-failed", stderr: typeof r.stderr === "string" ? r.stderr : "", status: r.status };
    }
    return { ok: true, stdout: typeof r.stdout === "string" ? r.stdout : "" };
}

/** Probe the Copilot CLI's `--version` output and compare against
 *  `MIN_KNOWN_GOOD_CLI_VERSION`. Returns one of (all values, never
 *  thrown — caller decides how loudly to react):
 *
 *    `{ ok: true,  version: [M,m,p], raw, bin }`
 *      Version >= min.
 *
 *    `{ ok: false, reason: "missing",      bin, error }`
 *      Binary not found on $PATH (ENOENT).
 *
 *    `{ ok: false, reason: "exec-failed",  bin, error?, stderr?, status? }`
 *      Spawn raised, timed out, or returned non-zero. The user might
 *      have a working binary that just refuses `--version` for some
 *      reason — render this differently from "missing" so the user
 *      knows to look at their PATH vs their binary.
 *
 *    `{ ok: false, reason: "unparseable",  bin, raw }`
 *      Got output but no `M.m.p` triple — could be a fork or pre-1.0
 *      build with a non-standard version string. Treat as
 *      informational; we can't tell if it supports `--output-format`.
 *
 *    `{ ok: false, reason: "too-old",      bin, version, raw, min }`
 *      Parsed a version triple < `MIN_KNOWN_GOOD_CLI_VERSION`. The
 *      caller should warn the user to upgrade.
 *
 *  Resolves `bin` via `resolveBin({ env })` when not passed
 *  explicitly so the legacy-env fallback path is honoured.
 */
export function checkCliVersion({ bin, exec = defaultVersionExec, env = process.env, stderr = process.stderr } = {}) {
    const resolvedBin = bin || resolveBin({ env, stderr });
    const r = exec(resolvedBin);
    if (!r || r.ok === false) {
        return { ok: false, reason: r?.reason ?? "exec-failed", bin: resolvedBin, error: r?.error ?? null, stderr: r?.stderr ?? "", status: r?.status };
    }
    const raw = (r.stdout || "").trim();
    const parsed = parseCliVersion(raw);
    if (!parsed) return { ok: false, reason: "unparseable", bin: resolvedBin, raw };
    const min = parseCliVersion(MIN_KNOWN_GOOD_CLI_VERSION);
    if (compareCliVersion(parsed, min) < 0) {
        return { ok: false, reason: "too-old", bin: resolvedBin, version: parsed, raw, min };
    }
    return { ok: true, version: parsed, bin: resolvedBin, raw };
}

/** Compose a one-line, user-facing summary of a `checkCliVersion`
 *  result. Pure / no I/O — `cmdRun` writes the result to stderr,
 *  `cmdDoctor` writes it to stdout next to the other status lines. */
export function describeCliVersionResult(result) {
    if (!result || typeof result !== "object") return "copilot CLI: unknown";
    if (result.ok) {
        return `copilot CLI: ${result.version.join(".")} (>= ${MIN_KNOWN_GOOD_CLI_VERSION}, ok)`;
    }
    if (result.reason === "missing") {
        return `copilot CLI: not found at ${result.bin} — install with \`npm i -g @github/copilot\` (>= ${MIN_KNOWN_GOOD_CLI_VERSION})`;
    }
    if (result.reason === "exec-failed") {
        const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
        return `copilot CLI: \`${result.bin} --version\` failed (${detail})`;
    }
    if (result.reason === "unparseable") {
        return `copilot CLI: at ${result.bin} but \`--version\` output is unrecognised (got: ${JSON.stringify(result.raw).slice(0, 80)})`;
    }
    if (result.reason === "too-old") {
        return `copilot CLI: ${result.version.join(".")} is older than ${MIN_KNOWN_GOOD_CLI_VERSION} — upgrade with \`npm i -g @github/copilot\` to avoid \`unknown option '--output-format'\` (issue #105)`;
    }
    return `copilot CLI: unknown status (${result.reason ?? "?"})`;
}
