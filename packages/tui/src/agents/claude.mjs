// Backend adapter for the Claude Code CLI driving an iter of the
// `autopilot run` loop (issue #83). Sibling to `agents/copilot.mjs`;
// shares the same adapter shape so the runner can swap backends
// without branching.
//
// Claude Code's `--output-format stream-json` mode emits NDJSON: one
// JSON event per line, terminated by a final `result` event whose
// `usage` field aggregates the iter's input/output token totals.
// `--dangerously-skip-permissions` is the "yolo" permission flag —
// the equivalent of Copilot's `--allow-all-tools`. Both subcommand
// paths default to yolo per the issue's product story (an
// "autopilot" loop that can't run unattended is not really an
// autopilot).
//
// Differences from the Copilot adapter (see `claude` invocation
// notes below):
//
//   * Claude Code does NOT expose a "premium request" counter; the
//     `extractUsage` field collapses to `null`. The TUI Header
//     already hides the pip when `premiumRequests` is null
//     (Header.mjs:163), so the Claude path renders a clean header
//     row without it rather than a confusing `premium 0`.
//
//   * Session-resume semantics are different from Copilot: Claude
//     uses `--resume <session-uuid>` (or `--continue` for "the most
//     recent session"), and the session id surfaces under
//     `session_id` on Claude's `system.init` event rather than
//     `result.sessionId`. v1 of this adapter wires the resume path
//     for `--continue` mode, but the issue notes we may gate it
//     behind `--fresh-only` if it turns out fiddly in practice;
//     `--fresh` mode has no resume semantics on either backend.
//
// Stdlib-only. Pure ESM, `node:` prefix on stdlib imports.

import process from "node:process";

import { parseNdjsonLines } from "./_shared.mjs";

export const name = "claude";

export const defaultBin = "claude";

export const binEnvVar = "AUTOPILOT_CLAUDE_BIN";

/** Resolve the binary path the runner should spawn for a Claude iter.
 *  No legacy env-var fallback — Claude is a new backend in v1, so the
 *  rename-deprecation story only applies to Copilot. */
export function resolveBin({ override, env = process.env } = {}) {
    if (override) return override;
    if (env[binEnvVar]) return env[binEnvVar];
    return defaultBin;
}

/** Build the Claude Code CLI argv (after the bin) for a single iter.
 *
 *  `--dangerously-skip-permissions` is the yolo flag (equivalent to
 *  Copilot's `--allow-all-tools`).
 *  `--output-format stream-json` switches Claude into NDJSON event
 *  emission so the runner can parse the stream the same way it
 *  parses Copilot's JSONL.
 *
 *  `resumeSessionId` maps to Claude's `--resume <uuid>`; the
 *  Copilot adapter uses `--resume=<id>` instead — the difference
 *  is purely surface and the runner doesn't care, it just forwards
 *  whatever argv the adapter returns. `sessionName` has no Claude
 *  equivalent (sessions are auto-named from the working dir + first
 *  prompt) so it's intentionally unused here.
 */
export function spawnArgs(prompt, { resumeSessionId, sessionName: _sessionName, extraArgs = [] } = {}) {
    // Claude Code requires `--verbose` whenever `-p` (--print) is paired
    // with `--output-format stream-json`; without it the CLI exits with
    // "Error: When using --print, --output-format=stream-json requires
    // --verbose". The flag is silent at runtime and only affects the
    // event stream's verbosity envelope.
    const args = ["-p", prompt, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    for (const a of extraArgs) args.push(a);
    return { args, env: undefined };
}

/** Parse Claude Code's NDJSON stdout. Re-export of the shared NDJSON
 *  parser — Claude's `--output-format stream-json` mode and Copilot's
 *  `--output-format json` mode both emit one JSON object per line, so
 *  the parsing path is identical. */
export const parseStream = parseNdjsonLines;

/** Extract the per-iter usage rollup from a Claude event stream.
 *
 *  Claude Code's stream-json format emits a terminal `result` event
 *  whose `usage` object carries `input_tokens` / `output_tokens`
 *  aggregates for the iter. Some intermediate `assistant` events also
 *  carry per-message `usage` deltas; we sum the per-message deltas
 *  but PREFER the terminal `result.usage` totals when present, since
 *  they are the canonical source per Claude Code's docs.
 *
 *  `premiumRequests` collapses to `null` — Claude Code does not
 *  expose this counter, and the Header already hides the pip when
 *  the value is null.
 */
export function extractUsage(events) {
    let inputFromDeltas = 0;
    let outputFromDeltas = 0;
    let inputFromResult = null;
    let outputFromResult = null;
    let sawDeltas = false;

    for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        // Per-message usage deltas on intermediate events. Claude
        // Code's stream-json emits these on `assistant` events with
        // a `message.usage` shape mirroring the Anthropic API.
        if (ev.type === "assistant" && ev.message && ev.message.usage && typeof ev.message.usage === "object") {
            const u = ev.message.usage;
            const inTok = u.input_tokens;
            const outTok = u.output_tokens;
            if (typeof inTok === "number" && Number.isFinite(inTok) && inTok >= 0) {
                inputFromDeltas += inTok;
                sawDeltas = true;
            }
            if (typeof outTok === "number" && Number.isFinite(outTok) && outTok >= 0) {
                outputFromDeltas += outTok;
                sawDeltas = true;
            }
        }
        // Terminal `result` event — canonical totals per the
        // Claude Code docs. When both totals AND deltas are present
        // we prefer the terminal totals (they are post-aggregation
        // by the CLI and account for cache reads etc.).
        if (ev.type === "result" && ev.usage && typeof ev.usage === "object") {
            const inTok = ev.usage.input_tokens;
            const outTok = ev.usage.output_tokens;
            if (typeof inTok === "number" && Number.isFinite(inTok) && inTok >= 0) {
                inputFromResult = inTok;
            }
            if (typeof outTok === "number" && Number.isFinite(outTok) && outTok >= 0) {
                outputFromResult = outTok;
            }
        }
    }

    const input = inputFromResult !== null
        ? inputFromResult
        : (sawDeltas ? inputFromDeltas : null);
    const output = outputFromResult !== null
        ? outputFromResult
        : (sawDeltas ? outputFromDeltas : 0);

    return { input, output, premiumRequests: null };
}
