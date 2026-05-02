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
