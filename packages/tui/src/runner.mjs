// `ralph-tui run` driver — runs each iteration as a fresh
// `copilot -p ...` subprocess. Two session modes:
//
//   --continue   resume the same Copilot session every iter; context
//                grows monotonically across iterations.
//   --fresh      brand-new Copilot session every iter (clean context;
//                the iter sees only the prompt + tool results).
//
// Both modes use the same baked SDLC prompts (PROMPT_SELF_IMPROVE /
// PROMPT_GROW_PROJECT) from `./prompts.mjs`.
//
// The driver subprocess runs `copilot -p "..." --allow-all-tools
// --output-format json` and parses JSONL stdout for:
//   - root assistant.message.data.content (no agentId field) — the
//     iter's user-visible response, scanned for the
//     completion_promise / abort_promise tokens.
//   - terminal `result` event with `result.sessionId` — captured at
//     iter 1 and reused via `--resume=<sessionId>` for iter 2+ when
//     the driver is in --continue mode.
//
// Pause/resume/stop are out-of-band: a sibling `ralph-tui run --pause
// <runId>` flips a flag in the run's state.json (CAS-protected via
// lockfile so concurrent pause+stop don't lose updates), and the
// driver re-reads state at each iter boundary. The current child
// copilot subprocess is never killed mid-iter — the driver waits for
// it to finish naturally before honoring pause/stop.

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
    PROMPT_SELF_IMPROVE,
    PROMPT_GROW_PROJECT,
    COMPLETION_PROMISE,
    BAKED_ABORT_TOKEN,
    BAKED_BACKLOG_ABORT_TOKEN,
} from "./prompts.mjs";

import { createEventEmitter } from "./events-emit.mjs";
import {
    SDLC_STAGES_SELF_IMPROVE,
    SDLC_STAGES_GROW_PROJECT,
    PINNED_TAIL_STAGES,
    WORKITEM_KINDS,
    TASK_OUTCOMES,
} from "./events.mjs";

const WORKITEM_KIND_SET = new Set(WORKITEM_KINDS);
const TASK_OUTCOME_SET = new Set(TASK_OUTCOMES);

// Public re-export so the CLI can build the prompt text without
// re-importing ./prompts.mjs (single import surface for the
// TUI package; downstream tooling that wants the prompt string for
// audit/dump only depends on this module).
export { PROMPT_SELF_IMPROVE, PROMPT_GROW_PROJECT, COMPLETION_PROMISE, BAKED_ABORT_TOKEN, BAKED_BACKLOG_ABORT_TOKEN };

// Cap on the optional --grow-project focus arg.
export const MAX_FOCUS_CHARS = 2000;

// Cap on the user-supplied --prompt string for ralph_loop-style runs.
export const MAX_PROMPT_CHARS = 65536;

// Default iteration cap when --max is omitted.
export const DEFAULT_MAX_ITERATIONS = 100;
// Hard ceiling on --max iterations.
export const MAX_ALLOWED_ITERATIONS = 1000;

// Stop polling state.json this many ms between checks while waiting
// for resume after a pause. Long enough to avoid burning CPU in a
// tight loop, short enough that --resume feels responsive.
const PAUSE_POLL_INTERVAL_MS = 500;

// Lockfile retry tuning for state-file CAS. Each write tries
// `mkdir <state>.lock`; if EEXIST, sleep + retry up to MAX_LOCK_RETRIES.
// Total worst-case wait is MAX_LOCK_RETRIES * LOCK_RETRY_INTERVAL_MS.
const LOCK_RETRY_INTERVAL_MS = 25;
const MAX_LOCK_RETRIES = 200; // 5s worst-case

// ─── State-file CAS ────────────────────────────────────────────────

/** Resolve the state-files root, honoring $RALPH_TUI_RUNS_DIR. */
export function resolveStateRoot(env = process.env) {
    const override = env?.RALPH_TUI_RUNS_DIR;
    if (override && typeof override === "string" && override.trim()) {
        return override.trim();
    }
    return join(homedir(), ".copilot", "ralph-tui", "runs");
}

/** Path to a run's state.json. */
export function resolveStatePath(runId, env = process.env) {
    return join(resolveStateRoot(env), runId, "state.json");
}

/** Acquire a directory-based lock for the state file, retrying on EEXIST.
 *  Returns the lock path so the caller can release with releaseLock(). */
function acquireLock(statePath) {
    const lockPath = `${statePath}.lock`;
    for (let i = 0; i < MAX_LOCK_RETRIES; i++) {
        try {
            mkdirSync(lockPath); // EEXIST if held
            return lockPath;
        } catch (err) {
            if (err && err.code !== "EEXIST") throw err;
            // busy-wait synchronously — this is a per-write lock, the
            // critical section is microseconds, contention is rare.
            const start = Date.now();
            while (Date.now() - start < LOCK_RETRY_INTERVAL_MS) { /* spin */ }
        }
    }
    throw new Error(`acquireLock: could not lock ${statePath} after ${MAX_LOCK_RETRIES} retries`);
}

function releaseLock(lockPath) {
    try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* swallow */ }
}

/** Read state.json. Returns null if it doesn't exist. */
export function readState(runId, env = process.env) {
    const statePath = resolveStatePath(runId, env);
    if (!existsSync(statePath)) return null;
    try {
        return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
        return null;
    }
}

/** Read-modify-write state.json under a lock with version CAS.
 *  `mutator(state)` may return a new object (merged) or modify in
 *  place. Returns the new state. Throws TypeError when the run does
 *  not exist (state.json missing). */
export function updateState(runId, mutator, env = process.env) {
    const statePath = resolveStatePath(runId, env);
    if (!existsSync(statePath)) {
        throw new TypeError(`run "${runId}" not found at ${statePath}`);
    }
    const lockPath = acquireLock(statePath);
    try {
        // Re-check under the lock — another writer may have just
        // terminated and rmSync'd the run directory between our
        // existsSync above and acquireLock.
        if (!existsSync(statePath)) {
            throw new TypeError(`run "${runId}" not found at ${statePath}`);
        }
        const current = JSON.parse(readFileSync(statePath, "utf8"));
        const mutated = mutator({ ...current }) ?? current;
        const next = { ...mutated, version: (current.version ?? 0) + 1 };
        const tmp = `${statePath}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
        renameSync(tmp, statePath);
        return next;
    } finally {
        releaseLock(lockPath);
    }
}

/** Initial state-file write; creates the run directory.  */
function initState(runId, initial, env = process.env) {
    const statePath = resolveStatePath(runId, env);
    const dir = join(resolveStateRoot(env), runId);
    mkdirSync(dir, { recursive: true });
    const lockPath = acquireLock(statePath);
    try {
        const seed = { version: 1, ...initial };
        writeFileSync(statePath, JSON.stringify(seed, null, 2) + "\n");
        return seed;
    } finally {
        releaseLock(lockPath);
    }
}

// ─── Sibling commands (operate on state file) ──────────────────────

export function pauseRun(runId, opts = {}) {
    const env = opts.env ?? process.env;
    const next = updateState(runId, (s) => {
        if (s.terminated) return s; // no-op on a finished run
        if (s.paused) return s;     // idempotent
        s.paused = true;
        s.pausedAt = (opts.now ?? Date.now)();
        return s;
    }, env);
    return next;
}

export function resumeRun(runId, opts = {}) {
    const env = opts.env ?? process.env;
    const next = updateState(runId, (s) => {
        if (s.terminated || !s.paused) return s; // no-op
        s.paused = false;
        const pausedFor = Math.max(0, ((opts.now ?? Date.now)()) - (s.pausedAt ?? 0));
        s.totalPausedMs = (s.totalPausedMs ?? 0) + pausedFor;
        delete s.pausedAt;
        return s;
    }, env);
    return next;
}

export function stopRun(runId, opts = {}) {
    const env = opts.env ?? process.env;
    const next = updateState(runId, (s) => {
        if (s.terminated) return s;
        s.stopRequested = true;
        s.stopReason = opts.reason ?? "user_stop";
        return s;
    }, env);
    return next;
}

export function statusRun(runId, opts = {}) {
    const s = readState(runId, opts.env ?? process.env);
    if (!s) {
        const e = new TypeError(`run "${runId}" not found`);
        throw e;
    }
    return s;
}

// ─── Argument validation ────────────────────────────────────────────

/** Validate + normalise a focus string. Returns {value} or {error}. */
export function validateFocus(focus) {
    if (focus === undefined || focus === null) return { value: undefined };
    if (typeof focus !== "string") return { error: "--focus must be a string" };
    const trimmed = focus.trim();
    if (!trimmed) return { error: "--focus must not be empty" };
    if (trimmed.length > MAX_FOCUS_CHARS) {
        return { error: `--focus exceeds ${MAX_FOCUS_CHARS} characters (got ${trimmed.length})` };
    }
    return { value: trimmed };
}

/** Compose the per-iter prompt body. For --self-improve /
 *  --grow-project, this is the baked SDLC prompt with optional
 *  `Focus this run on: <focus>` suffix. For --prompt mode, it's the
 *  user's prompt verbatim. */
export function composePrompt({ mode, prompt, focus }) {
    let base;
    if (mode === "self-improve") base = PROMPT_SELF_IMPROVE;
    else if (mode === "grow-project") base = PROMPT_GROW_PROJECT;
    else if (mode === "prompt") base = prompt;
    else throw new TypeError(`composePrompt: unknown mode "${mode}"`);
    if (focus) return `${base}\n\nFocus this run on: ${focus}`;
    return base;
}

/** Mode → label used by the event emitter and the run directory name. */
function labelForMode(mode) {
    if (mode === "self-improve") return "ralph-tui-self-improve";
    if (mode === "grow-project") return "ralph-tui-grow-project";
    if (mode === "prompt") return "ralph-tui-prompt";
    throw new TypeError(`labelForMode: unknown mode "${mode}"`);
}

/** Mode → canonical SDLC stage list, or null for `prompt` mode (no
 *  fixed stage list — the user's custom prompt drives the loop and
 *  the runner has no way to know which stages it defines). The
 *  per-mode stage lists are imported from `events.mjs` so a drift
 *  between the prompt body, the runner parser, and the renderer is
 *  impossible (parity guards in
 *  `packages/tui/test/events.test.mjs`). */
export function stagesForMode(mode) {
    if (mode === "self-improve") return SDLC_STAGES_SELF_IMPROVE;
    if (mode === "grow-project") return SDLC_STAGES_GROW_PROJECT;
    return null;
}

/** Scan an assistant-response string for `[STAGE: NAME]` markers
 *  emitted on their own line by the agent (per the STAGE MARKERS
 *  preamble baked into PROMPT_SELF_IMPROVE / PROMPT_GROW_PROJECT).
 *
 *  Returns an ordered array of `{ name, stage, indexInText }`, where
 *  `stage` is the 1-based ordinal in the canonical stage list. Markers
 *  whose name is NOT in `allowedStages` are silently dropped — this
 *  is the safety net for a hallucinated marker (e.g.
 *  `[STAGE: REVIEW]`) so a typo never poisons the event stream.
 *
 *  The match is anchored to a line start (with optional leading
 *  whitespace) and the line end (with optional trailing whitespace)
 *  so an inline mention of `[STAGE: ORIENT]` in prose doesn't fire.
 *  This mirrors the prompt instruction: "emit on a line by itself".
 *
 *  Pure / no I/O — exported so the test suite can exercise it
 *  independently of subprocess plumbing. */
export function extractStageMarkers(text, allowedStages) {
    if (typeof text !== "string" || !text) return [];
    if (!Array.isArray(allowedStages) || allowedStages.length === 0) return [];
    const allowSet = new Set(allowedStages);
    const out = [];
    const re = /^[ \t]*\[STAGE:[ \t]*([A-Z_][A-Z0-9_]*)[ \t]*\][ \t]*$/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (!allowSet.has(name)) continue;
        out.push({ name, stage: allowedStages.indexOf(name) + 1, indexInText: m.index });
    }
    return out;
}

/** Recognised structured marker keys (issue #48 slice 9). The agent
 *  emits one of these per line as it walks through its work, with a
 *  one-line JSON payload between the colon and the closing bracket.
 *  The runner extracts them, validates the shape, and turns them into
 *  `stage_plan` / `task_*` / `workitem_*` events.
 *
 *  Pinned at module scope so the test suite can introspect the
 *  supported keys without parsing the prompt body. The set is closed:
 *  an unrecognised key (typo, hallucinated marker) is silently
 *  dropped — a typo cannot poison the event stream. */
export const STRUCTURED_MARKER_KEYS = Object.freeze([
    "WORKITEM_START",
    "WORKITEM_END",
    "STAGE_PLAN",
    "STAGE_PLAN_AMEND",
    "TASK_LIST",
    "TASK_START",
    "TASK_END",
]);

const STRUCTURED_MARKER_KEY_SET = new Set(STRUCTURED_MARKER_KEYS);

// Per-line marker shape: `^\s*[KEY: {…}]\s*$`. We split content on
// `\n` and match line-by-line so a stray `]` inside prose on the
// same line as a marker can't terminate the regex early — the line
// boundary is the unambiguous end. Whole-line-only matching is the
// hard contract: a marker mentioned inline ("the agent emits
// `[STAGE_PLAN: {…}]` like so") never fires.
const STRUCTURED_MARKER_LINE_RE = /^[ \t]*\[([A-Z_][A-Z0-9_]*):[ \t]*(\{.*\})[ \t]*\][ \t]*$/;

/** Parse an `assistant.message` content string for the slice-9
 *  structured markers (`[WORKITEM_START: {…}]`, `[STAGE_PLAN: {…}]`,
 *  etc). Returns an ordered array of
 *  `{ key, payload, lineIndex }` items. Items are silently
 *  dropped when the key is unrecognised, the JSON body fails to
 *  parse, or the parsed payload is not an object — the runner must
 *  tolerate marker fumbles without crashing the event stream
 *  (a malformed marker is the agent's bug, not the runner's).
 *
 *  Markers MUST occupy their own line (no prose before/after on the
 *  same line). Implementation splits on `\n` and matches each line
 *  separately, which makes the "whole-line-only" contract a hard
 *  property of the parser instead of a soft hint to the regex.
 *
 *  Pure / no I/O — exported so the test suite can pin the parser
 *  independent of the runner's emit path. */
export function extractStructuredMarkers(text) {
    if (typeof text !== "string" || !text) return [];
    const out = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = STRUCTURED_MARKER_LINE_RE.exec(line);
        if (!m) continue;
        const key = m[1];
        if (!STRUCTURED_MARKER_KEY_SET.has(key)) continue;
        let payload;
        try { payload = JSON.parse(m[2]); }
        catch { continue; } // malformed JSON — skip silently
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
        out.push({ key, payload, lineIndex: i });
    }
    return out;
}

/** Compute the sequence of `stage_plan_amend` ops needed to transform
 *  the agent's raw stage plan into the pinned-tail-enforced plan.
 *  Returns one amendment per discrete change, in the order the
 *  runner should emit them — applying them in order via foldEvents'
 *  eager-apply path produces the enforced plan exactly.
 *
 *  Why not just emit a "corrected" stage_plan? Because foldEvents
 *  records the raw plan first and then applies amendments
 *  incrementally; a renderer that surfaces the amendment history
 *  (`+ added` badges, "moved to tail" reasons) needs the discrete
 *  ops, not a final-state diff.
 *
 *  Why not just `add: "COMMIT"` etc.? Because the agent may have
 *  emitted a misplaced pinned stage (e.g. raw =
 *  `["REPRO","COMMIT","TEST"]`); merely appending COMMIT at the end
 *  would yield two COMMIT entries. We emit a paired
 *  `{remove: "COMMIT"}` then `{add: "COMMIT", after: "TEST"}` so
 *  the resulting plan has each pinned stage exactly once at the tail.
 *
 *  Each amendment carries the canonical reason string
 *  `"pinned-tail-enforcement"` so replay tooling can group them as
 *  runner-side repairs (vs agent-emitted amendments which carry the
 *  agent's own reason).
 *
 *  Pure / no I/O — exported for testing. */
export function computePinnedTailAmendments(rawStages, pinnedTail) {
    if (!Array.isArray(rawStages)) return [];
    if (!Array.isArray(pinnedTail) || pinnedTail.length === 0) return [];
    const pinnedSet = new Set(pinnedTail);
    const out = [];
    // Step 1: any pinned stage that appears in raw at a non-tail
    // position needs to be removed first so we don't end up with
    // duplicates. We treat "appears anywhere except in canonical
    // tail position" as misplaced; this matches enforcePinnedTail's
    // strip-and-re-append semantics.
    const head = rawStages.filter((s) => typeof s === "string" && s && !pinnedSet.has(s));
    for (const stage of rawStages) {
        if (typeof stage !== "string" || !stage) continue;
        if (pinnedSet.has(stage)) {
            out.push({
                remove: stage,
                add: null,
                after: null,
                reason: "pinned-tail-enforcement",
            });
        }
    }
    // Step 2: append each pinned stage in canonical order, anchored
    // after the previous tail entry (or after the last head entry
    // for the first pinned stage). The `after:` field gives
    // foldEvents a stable insertion point so the renderer can show
    // a clean before/after.
    let after = head.length > 0 ? head[head.length - 1] : null;
    for (const pinned of pinnedTail) {
        out.push({
            remove: null,
            add: pinned,
            after,
            reason: "pinned-tail-enforcement",
        });
        after = pinned;
    }
    return out;
}

/** Parse an ISO-8601 timestamp string to ms since epoch. Returns NaN
 *  on missing / unparseable input so callers can fall back to wall
 *  clock when a synthetic test fixture omits timestamps. */
function parseAgentTsMs(timestamp) {
    if (typeof timestamp !== "string") return NaN;
    const t = Date.parse(timestamp);
    return Number.isFinite(t) ? t : NaN;
}

/** Distill a tool-call arguments object into a one-line summary
 *  (≤ 80 chars) suitable for the substage row. Per-verb shaping
 *  pulls the most useful field for the most common tools (bash →
 *  command, view/edit/create → path, grep/glob → pattern, task →
 *  description); generic fallback picks the first string-valued
 *  field. Returning empty string is fine — the renderer just shows
 *  the verb. Pure / no I/O. */
export function summarizeToolArgs(verb, args) {
    if (!args || typeof args !== "object") return "";
    const cap = 80;
    const truncate = (s) => {
        const str = String(s ?? "");
        if (str.length <= cap) return str;
        return str.slice(0, cap - 1) + "…";
    };
    if (verb === "bash") {
        const cmd = String(args.command ?? "").trim().split("\n")[0];
        return truncate(cmd);
    }
    if (verb === "view" || verb === "edit" || verb === "create" || verb === "show_file") {
        return truncate(args.path);
    }
    if (verb === "grep" || verb === "glob") {
        return truncate(args.pattern);
    }
    if (verb === "task") {
        return truncate(args.description ?? args.name);
    }
    if (verb === "report_intent") {
        return truncate(args.intent);
    }
    for (const k of Object.keys(args)) {
        if (typeof args[k] === "string") return truncate(args[k]);
    }
    return "";
}

/** Heuristic: does this raw bash command run `git commit` (or
 *  `gh pr create`, etc — but for now just `git commit`)? Used by the
 *  runner-side commit_observed detector to decide whether to shell
 *  out to `git rev-parse + git log` after the substage completes.
 *
 *  We accept several common shapes:
 *    - `git commit -m "msg"`
 *    - `git commit -F /tmp/x` (subject in file)
 *    - `git -c user.name=foo commit …` (configured prefix)
 *    - `cd subdir && git commit …` (chained)
 *    - leading whitespace, multiline (only the first line that looks
 *      like a `git commit` invocation matters)
 *
 *  We REJECT shapes that aren't actually committing:
 *    - `git --help commit`
 *    - `git commit --dry-run` (still produces a commit? technically
 *      no — `--dry-run` only shows what would happen). We accept
 *      `--dry-run` as a commit-ish anyway, then the runner-side
 *      `git rev-parse` will simply re-emit the prior HEAD which we
 *      dedup against. Conservative is fine.
 *    - `echo git commit` (a literal string in another command's args)
 *
 *  Pure / exported for testing. */
export function looksLikeGitCommit(command) {
    if (typeof command !== "string" || !command) return false;
    // Strip a leading `cd <dir> && ` chain, then strip any
    // `git -c key=val ` config flags so the bare verb is the first
    // token we test.
    for (const line of command.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Walk through chain operators. The first token that starts
        // with `git ` (or `git\t`) and has `commit` as the first
        // arg-position word counts.
        for (const segment of trimmed.split(/&&|;|\|\|/)) {
            const seg = segment.trim();
            if (!seg) continue;
            // Skip leading subshell prefixes that don't change the
            // verb shape: `(`, `cd somewhere`, `env VAR=val`.
            const m = /^\(?\s*(?:env(?:\s+\S+=\S+)*\s+)?(?:cd\s+\S+\s+&&\s+)?git\b(.*)$/.exec(seg);
            if (!m) continue;
            const rest = m[1].trim();
            // Strip `-c key=val` config flags (one or more).
            const withoutConfig = rest.replace(/^(?:-c\s+\S+\s+)+/, "").trim();
            // First word must be `commit` (not `--help`, not
            // `commit-tree`).
            if (/^commit(\s|$)/.test(withoutConfig)) return true;
        }
    }
    return false;
}

/** Default `gitExec` implementation — runs a git subcommand
 *  synchronously via `child_process.spawnSync` and returns the
 *  stdout (UTF-8) on success, or `null` on any error / non-zero
 *  exit. Synchronous because the surrounding live emit loop is
 *  already synchronous; the cost is bounded (50-100ms per
 *  invocation) and runs at most once per observed `git commit`.
 *
 *  Tests inject their own `gitExec` to stub repo state without
 *  shelling out — see `runRalphTui({ gitExec, … })`. */
function defaultGitExec({ args, cwd, env }) {
    try {
        const r = nodeSpawnSync("git", args, {
            cwd,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            // Issue #54 slice 2c — arm-time replay shells out to git
            // before the first iter renders. A 200 ms ceiling protects
            // against a wedged git repo (lock file, hung credential
            // helper) silently delaying the run.start path; the
            // emitCommitObservedFromHead caller already swallows null,
            // so a timeout just means "skip the LastCommit pane on
            // mount" rather than crash.
            timeout: 200,
        });
        if (r.status !== 0) return null;
        return typeof r.stdout === "string" ? r.stdout : null;
    } catch {
        return null;
    }
}

/** Run `git rev-parse --short HEAD` + `git log -1
 *  --pretty=…` against `cwd` and return a
 *  `{ sha, subject, trailers }` triple. Returns `null` when git
 *  isn't available, the cwd isn't a repo, or HEAD is detached on a
 *  pre-commit state.
 *
 *  Trailers are extracted from the trailers footer (one trailer per
 *  line, format `Key: value`). Capped at 8 entries (matches the
 *  events.mjs serializer's per-event trailer cap).
 *
 *  Pure-ish: invokes `gitExec` (injectable) to actually shell out;
 *  exported for testing.
 *
 *  @param {object} opts
 *  @param {(req: {args: string[], cwd: string, env: object}) => string|null} opts.gitExec
 *  @param {string} opts.cwd
 *  @param {object} [opts.env]
 *  @returns {{sha: string, subject: string, trailers: string[]}|null}
 */
export function readHeadCommit({ gitExec, cwd, env }) {
    if (typeof gitExec !== "function") return null;
    const sha = (gitExec({ args: ["rev-parse", "--short", "HEAD"], cwd, env }) ?? "").trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    // %s = subject, then a literal NUL separator we control,
    // then %(trailers:only=true,unfold=true) = each trailer on
    // its own line.
    const NUL = "\u0000";
    const fmt = `%s${NUL}%(trailers:only=true,unfold=true)`;
    const raw = gitExec({ args: ["log", "-1", `--pretty=format:${fmt}`], cwd, env });
    if (typeof raw !== "string") return null;
    const sepIdx = raw.indexOf(NUL);
    if (sepIdx < 0) return { sha, subject: raw.trim(), trailers: [] };
    const subject = raw.slice(0, sepIdx).trim();
    const trailerBlock = raw.slice(sepIdx + 1);
    const trailers = [];
    for (const rawLine of trailerBlock.split("\n")) {
        const line = rawLine.replace(/\r$/, "").trim();
        if (!line) continue;
        if (!/.+:.+/.test(line)) continue; // trailers always have a `: ` separator
        trailers.push(line);
        if (trailers.length >= 8) break;
    }
    return { sha, subject, trailers };
}

/** Parse the line count from `gh ... list` text output. The agent's
 *  ORIENT-stage backlog probes (`gh run list --status failure`,
 *  `gh pr list --state open`, `gh issue list --state open`) all use
 *  the default human-readable, tab-delimited format. Each list row
 *  has at least one tab; "no rows" outputs (empty stdout, or a
 *  banner like "no open issues matching your search") have none.
 *  Returns the integer count, or null when the input is not a
 *  string. Pure / no I/O. */
export function parseGhListCount(stdout) {
    if (typeof stdout !== "string") return null;
    let count = 0;
    for (const rawLine of stdout.split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        if (!line) continue;
        if (line.includes("\t")) count++;
    }
    return count;
}

/** Walk a copilot JSONL event array for `gh` backlog probes and
 *  return `{ redCi, openPrs, openIssues }` with each field set when
 *  the matching `tool.execution_complete` (with `success === true`)
 *  carries the probe's stdout in `result.content`. Each probe is
 *  matched by the leading `gh <subcommand> list ...` of the
 *  recorded `tool.execution_start.arguments.command`. Fields stay
 *  null when the agent did not run the corresponding probe (e.g.
 *  `grow_project` only runs the labelled issue probe), and the
 *  function returns null when no probe matched at all — in which
 *  case the loop skips the `backlog_snapshot` emit. Pure / no I/O. */
export function extractBacklogFromEvents(events) {
    if (!Array.isArray(events)) return null;
    const startsByCallId = new Map();
    let redCi = null;
    let openPrs = null;
    let openIssues = null;
    for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "tool.execution_start" && ev.data && typeof ev.data.toolCallId === "string") {
            const cmd = ev.data.arguments && typeof ev.data.arguments.command === "string"
                ? ev.data.arguments.command : "";
            startsByCallId.set(ev.data.toolCallId, { command: cmd });
        }
        if (ev.type === "tool.execution_complete"
            && ev.data && typeof ev.data.toolCallId === "string"
            && ev.data.success === true) {
            const start = startsByCallId.get(ev.data.toolCallId);
            const cmd = start?.command ?? "";
            const stdout = (ev.data.result && typeof ev.data.result.content === "string")
                ? ev.data.result.content : "";
            if (/^\s*gh\s+run\s+list\b/.test(cmd) && /--status\s+failure\b/.test(cmd)) {
                const n = parseGhListCount(stdout);
                if (Number.isInteger(n)) redCi = n;
            } else if (/^\s*gh\s+pr\s+list\b/.test(cmd) && /--state\s+open\b/.test(cmd)) {
                const n = parseGhListCount(stdout);
                if (Number.isInteger(n)) openPrs = n;
            } else if (/^\s*gh\s+issue\s+list\b/.test(cmd) && /--state\s+open\b/.test(cmd)) {
                const n = parseGhListCount(stdout);
                if (Number.isInteger(n)) openIssues = n;
            }
        }
    }
    if (redCi === null && openPrs === null && openIssues === null) return null;
    return { redCi, openPrs, openIssues };
}

/** Walk a copilot JSONL event array and produce an ordered timeline of
 *  stage markers and tool-completion records, preserving the natural
 *  interleaving from the agent's response stream. Used by the runner
 *  loop to emit stage_start/stage_end/substage events in the right
 *  order so foldEvents attributes each substage to its containing
 *  stage (substages reset on each stage_start).
 *
 *  Each timeline item is tagged with a `kind`:
 *    - `{kind: "stage_marker", name, stage, ts}` — one per
 *      `[STAGE: NAME]` line found in a (root-agent) `assistant.message`
 *      event's content; only canonical-list names are emitted.
 *    - `{kind: "tool_complete", verb, argsSummary, outcome,
 *      durationMs, ts}` — one per `tool.execution_complete` event,
 *      paired with the matching `tool.execution_start` (by
 *      `toolCallId`) for verb / args / startTs.
 *
 *  `ts` is parsed from the JSONL `timestamp` field; if missing or
 *  unparseable (e.g. synthetic test fixtures), `ts` is NaN and the
 *  loop falls back to wall clock at emit time. `durationMs` is
 *  null when either timestamp is missing. Sub-agent
 *  `assistant.message` events (those carrying an `agentId`) are
 *  ignored — only the root agent's stage markers count.
 *
 *  Pure / no I/O — exported for testing. */
/** Walk a copilot JSONL event array and produce an ordered timeline of
 *  stage markers, structured slice-9 markers, and tool-completion
 *  records, preserving the natural interleaving from the agent's
 *  response stream. Used by the runner loop to emit stage_start /
 *  stage_end / substage / stage_plan / task_* / workitem_* events in
 *  the right order so foldEvents attributes each item to its
 *  containing context (substages reset on each stage_start;
 *  task_start lookup needs the active stage already known).
 *
 *  Each timeline item is tagged with a `kind`:
 *    - `{kind: "stage_marker", name, stage, ts}` — one per
 *      `[STAGE: NAME]` line found in a (root-agent) `assistant.message`
 *      event's content; only canonical-list names are emitted.
 *    - `{kind: "tool_complete", verb, argsSummary, outcome,
 *      durationMs, ts, args}` — one per `tool.execution_complete` event,
 *      paired with the matching `tool.execution_start` (by
 *      `toolCallId`) for verb / args / startTs. `args` is the raw
 *      arguments object so the runner-side commit_observed detector
 *      can re-inspect bash command shapes without re-implementing
 *      argument distillation.
 *    - `{kind, payload, ts}` for each slice-9 structured marker — one
 *      per `[WORKITEM_START: {…}]` / `[WORKITEM_END: {…}]` /
 *      `[STAGE_PLAN: {…}]` / `[STAGE_PLAN_AMEND: {…}]` /
 *      `[TASK_LIST: {…}]` / `[TASK_START: {…}]` / `[TASK_END: {…}]`
 *      line found in a (root-agent) `assistant.message` content. The
 *      `kind` mirrors the marker key in lower-snake_case
 *      (`workitem_start`, `stage_plan`, `task_end`, …) so it lines up
 *      with the corresponding event type. Sub-agent `assistant.message`
 *      events (those carrying an `agentId`) are ignored for both
 *      stage and structured markers — only the root agent drives
 *      the loop's narration.
 *
 *  `ts` is parsed from the JSONL `timestamp` field; if missing or
 *  unparseable (e.g. synthetic test fixtures), `ts` is NaN and the
 *  loop falls back to wall clock at emit time. `durationMs` is
 *  null when either timestamp is missing.
 *
 *  Pure / no I/O — exported for testing. */
export function extractAgentTimeline(events, allowedStages) {
    const out = [];
    if (!Array.isArray(events)) return out;
    const allowSet = (Array.isArray(allowedStages) && allowedStages.length)
        ? new Set(allowedStages) : null;
    const startsByCallId = new Map();
    const stageMarkerRe = /^[ \t]*\[STAGE:[ \t]*([A-Z_][A-Z0-9_]*)[ \t]*\][ \t]*$/gm;

    for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        const tsMs = parseAgentTsMs(ev.timestamp);

        if (ev.type === "assistant.message" && !ev.agentId
            && ev.data && typeof ev.data.content === "string") {
            // Stage-marker pass: same per-event regex sweep we always
            // had — only canonical-list names fire. Skipped entirely
            // when `allowedStages` is empty (custom-prompt mode).
            if (allowSet) {
                stageMarkerRe.lastIndex = 0;
                let m;
                while ((m = stageMarkerRe.exec(ev.data.content)) !== null) {
                    const name = m[1];
                    if (!allowSet.has(name)) continue;
                    out.push({
                        kind: "stage_marker",
                        name,
                        stage: allowedStages.indexOf(name) + 1,
                        ts: tsMs,
                    });
                }
            }
            // Structured-marker pass (issue #48 slice 9). Each marker
            // key maps to a lower-snake-case kind that matches the
            // corresponding event type, so the runner's emit closure
            // can switch on `kind` without a key→type translation
            // table.
            for (const marker of extractStructuredMarkers(ev.data.content)) {
                out.push({
                    kind: marker.key.toLowerCase(),
                    payload: marker.payload,
                    ts: tsMs,
                });
            }
        }

        if (ev.type === "tool.execution_start" && ev.data && typeof ev.data.toolCallId === "string") {
            startsByCallId.set(ev.data.toolCallId, {
                tsMs,
                toolName: typeof ev.data.toolName === "string" ? ev.data.toolName : "unknown",
                arguments: ev.data.arguments,
            });
        }

        if (ev.type === "tool.execution_complete" && ev.data && typeof ev.data.toolCallId === "string") {
            const start = startsByCallId.get(ev.data.toolCallId);
            const verb = start?.toolName ?? "unknown";
            const argsSummary = summarizeToolArgs(verb, start?.arguments);
            const outcome = ev.data.success === false
                ? (ev.data.error && typeof ev.data.error.code === "string" ? ev.data.error.code : "error")
                : "ok";
            const startTs = start?.tsMs;
            const durationMs = Number.isFinite(startTs) && Number.isFinite(tsMs)
                ? Math.max(0, tsMs - startTs)
                : null;
            out.push({
                kind: "tool_complete",
                verb,
                argsSummary,
                outcome,
                durationMs,
                ts: tsMs,
                args: start?.arguments,
                toolCallId: ev.data.toolCallId,
            });
        }
    }
    return out;
}

/** Default abort token per mode. */
function defaultAbortPromise(mode) {
    if (mode === "self-improve") return BAKED_ABORT_TOKEN;
    if (mode === "grow-project") return BAKED_BACKLOG_ABORT_TOKEN;
    return undefined; // --prompt mode has no default abort
}

// ─── JSONL stream parser ───────────────────────────────────────────

/** Parse a single JSONL line. Returns null on parse error. */
function parseJsonLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch { return null; }
}

/** From the stream of parsed events emitted by `copilot -p
 *  --output-format json`, extract:
 *    - `assistantContent`: concatenation of root-agent
 *      `assistant.message.data.content` chunks (skipping events that
 *      carry an `agentId`, which are sub-agent turns).
 *    - `sessionId`: from the terminal `result` event's
 *      `result.sessionId`. May be null if the run did not produce one.
 *    - `exitOk`: whether the terminal `result` event indicated success.
 *    - `outputTokens`: sum of `data.outputTokens` across all root-agent
 *      `assistant.message` events. The Copilot CLI JSONL stream emits
 *      `outputTokens` as a per-message DELTA (not cumulative-so-far),
 *      so summing is correct. Sub-agent (`agentId`) events are
 *      excluded — their token cost is folded into the parent's
 *      premium-request tally already, and counting them here would
 *      double-count tool work the user didn't initiate. Malformed
 *      values (non-finite, negative, non-numeric) are skipped rather
 *      than coerced to 0 so a partial / corrupted stream returns the
 *      best-available total instead of mass-zeroing.
 *    - `premiumRequests`: cost-weighted Copilot premium-request count
 *      from the terminal `result.usage.premiumRequests`. `null` when
 *      the field is absent or malformed (distinguishes "no data" from
 *      a credible 0). The runner sums per-iter values into a run
 *      total in its main loop.
 *  This module is a pure data extractor — the runner glues it to
 *  child stdout. Exported so the test suite can exercise it
 *  independently of subprocess plumbing. */
export function reduceCopilotEvents(events) {
    let assistantContent = "";
    let sessionId = null;
    let exitOk = null;
    let outputTokens = 0;
    let premiumRequests = null;
    for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.type === "assistant.message" && ev.data && typeof ev.data.content === "string") {
            // Root-agent turns have no `agentId` field. Sub-agent turns
            // (e.g. an explore agent) carry one. Only the root content
            // is what the user sees and what the prompt instructs the
            // agent to emit COMPLETE / ABORT_* in.
            if (!ev.agentId) assistantContent += ev.data.content;
        }
        if (ev.type === "assistant.message" && ev.data && !ev.agentId) {
            // outputTokens is intentionally read independently of
            // content presence — a model-only / no-content message
            // (rare but legal in the JSONL stream) still bills tokens
            // and must count toward the cumulative total.
            const tok = ev.data.outputTokens;
            if (typeof tok === "number" && Number.isFinite(tok) && tok >= 0) {
                outputTokens += tok;
            }
        }
        if (ev.type === "result") {
            if (ev.result && typeof ev.result.sessionId === "string") sessionId = ev.result.sessionId;
            if (typeof ev.success === "boolean") exitOk = ev.success;
            if (ev.usage && typeof ev.usage === "object") {
                const pr = ev.usage.premiumRequests;
                if (typeof pr === "number" && Number.isFinite(pr) && pr >= 0) {
                    premiumRequests = pr;
                }
            }
        }
    }
    return { assistantContent, sessionId, exitOk, outputTokens, premiumRequests };
}

// ─── Single-iter subprocess driver ─────────────────────────────────

/** Spawn `copilot -p ...` and collect the JSONL stream. Resolves with
 *  { events, stderr, exitCode } once the child exits.
 *
 *  Tests inject `spawn` (a child_process.spawn-shaped function) +
 *  `copilotBin` to substitute a shim binary that emits scripted
 *  JSONL.
 */
export function runOneIteration({
    prompt,
    resumeSessionId,
    sessionName,
    spawn = nodeSpawn,
    copilotBin,
    cwd,
    env = process.env,
    extraArgs = [],
    onLine, // optional callback per parsed event (for live feedback)
}) {
    const bin = copilotBin ?? env.RALPH_TUI_COPILOT_BIN ?? "copilot";
    const args = ["-p", prompt, "--allow-all-tools", "--output-format", "json"];
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    else if (sessionName) args.push("-n", sessionName);
    for (const a of extraArgs) args.push(a);

    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(bin, args, {
                stdio: ["ignore", "pipe", "pipe"],
                cwd,
                env,
            });
        } catch (err) {
            reject(err);
            return;
        }

        const events = [];
        let stdoutBuf = "";
        let stderrBuf = "";
        let killed = false;

        const onStdout = (chunk) => {
            stdoutBuf += chunk.toString("utf8");
            let nl;
            while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
                const line = stdoutBuf.slice(0, nl);
                stdoutBuf = stdoutBuf.slice(nl + 1);
                const ev = parseJsonLine(line);
                if (ev) {
                    events.push(ev);
                    if (onLine) { try { onLine(ev); } catch { /* swallow */ } }
                }
            }
        };
        const onStderr = (chunk) => { stderrBuf += chunk.toString("utf8"); };

        child.stdout?.on("data", onStdout);
        child.stderr?.on("data", onStderr);

        child.on("error", (err) => { reject(err); });
        child.on("close", (code) => {
            // Drain trailing partial line. We also fire `onLine` here
            // so every event that lands in `events` has been
            // observable through the live stream — issue #48 streaming
            // emission relies on the invariant that the post-iter
            // `events` array equals everything `onLine` saw, plus
            // nothing. Without this `onLine` call, a non-newline-
            // terminated final JSONL row (which the close-handler
            // recovers) would be silently absent from the live feed
            // and would force callers into a final replay pass to
            // fill the gap.
            if (stdoutBuf.trim()) {
                const ev = parseJsonLine(stdoutBuf);
                if (ev) {
                    events.push(ev);
                    if (onLine) { try { onLine(ev); } catch { /* swallow */ } }
                }
            }
            resolve({ events, stderr: stderrBuf, exitCode: code, killed });
        });

        // Expose the child handle to the caller for SIGINT plumbing
        // via the resolve hook; runRalphTui registers a stop-watcher
        // before awaiting.
        if (typeof onLine === "function" && onLine.__captureChild) {
            onLine.__captureChild(child, () => { killed = true; });
        }
    });
}

// ─── Multi-iter loop ────────────────────────────────────────────────

/**
 * Run the full multi-iter loop. Returns when the loop terminates via
 * completion_promise, abort_promise, max_iterations, stopRequested,
 * or unrecoverable subprocess error.
 *
 * Required:
 *   mode           "self-improve" | "grow-project" | "prompt"
 *   contextMode    "continue" | "fresh"
 *
 * Optional:
 *   prompt              Required when mode === "prompt".
 *   focus               Optional suffix; capped at MAX_FOCUS_CHARS.
 *   max                 Default DEFAULT_MAX_ITERATIONS.
 *   completionPromise   Default COMPLETION_PROMISE ("COMPLETE").
 *   abortPromise        Default = abort token of the chosen mode.
 *   spawn               Inject for tests.
 *   copilotBin          Inject for tests. Falls back to
 *                       $RALPH_TUI_COPILOT_BIN, then "copilot".
 *   env, fs, now        Inject for tests.
 *   eventEmitter        Inject for tests; otherwise createEventEmitter
 *                       is invoked.
 *   onRunId             Callback invoked once with the runId, fired
 *                       BEFORE iter 1 starts. The signal-handler
 *                       plumbing in the CLI uses this to resolve the
 *                       run before the loop body starts so a SIGINT
 *                       in iter 1 still finds the state file.
 *   onIteration         Callback fired between iters with state.
 *   stdout, stderr      Stream sinks for human-readable output.
 */
export async function runRalphTui(opts) {
    const {
        mode,
        contextMode,
        prompt,
        focus,
        max = DEFAULT_MAX_ITERATIONS,
        completionPromise = COMPLETION_PROMISE,
        abortPromise = defaultAbortPromise(mode),
        spawn = nodeSpawn,
        copilotBin,
        env = process.env,
        now = () => Date.now(),
        cwd = process.cwd(),
        eventEmitter,
        onRunId,
        onIteration,
        stdout = process.stdout,
        stderr = process.stderr,
        // Issue #48 slice 9: injectable git shell-out for the
        // commit_observed path. Tests pass a stub that returns
        // canned stdout per command shape; production uses
        // `defaultGitExec` (synchronous spawnSync against the run's
        // cwd). When omitted, commit_observed is silently disabled —
        // a runtime without git installed (or a non-repo cwd) falls
        // back to no commit narration.
        gitExec = defaultGitExec,
    } = opts;

    if (mode !== "self-improve" && mode !== "grow-project" && mode !== "prompt") {
        throw new TypeError(`runRalphTui: invalid mode "${mode}"`);
    }
    if (contextMode !== "continue" && contextMode !== "fresh") {
        throw new TypeError(`runRalphTui: contextMode must be "continue" or "fresh"`);
    }
    if (mode === "prompt" && (!prompt || typeof prompt !== "string")) {
        throw new TypeError(`runRalphTui: --prompt requires a non-empty string when mode === "prompt"`);
    }
    if (mode === "prompt" && prompt.length > MAX_PROMPT_CHARS) {
        throw new TypeError(`runRalphTui: prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    if (!Number.isInteger(max) || max < 1 || max > MAX_ALLOWED_ITERATIONS) {
        throw new TypeError(`runRalphTui: max must be an integer in [1, ${MAX_ALLOWED_ITERATIONS}], got ${max}`);
    }
    const focusCheck = validateFocus(focus);
    if (focusCheck.error) throw new TypeError(`runRalphTui: ${focusCheck.error}`);

    const startedAt = now();
    const label = labelForMode(mode);
    const emitter = eventEmitter ?? createEventEmitter({ label, startedAt, env });
    const runId = emitter.runId;
    const sessionName = `${runId}`;
    const composedPrompt = composePrompt({ mode, prompt, focus: focusCheck.value });

    // Initial state-file. terminationReason starts as null; the loop
    // sets it on exit. sessionId is captured after iter 1 in
    // --continue mode.
    initState(runId, {
        runId,
        mode,
        contextMode,
        startedAt,
        max,
        iter: 0,
        paused: false,
        stopRequested: false,
        terminated: false,
        terminationReason: null,
        sessionId: null,
        totalPausedMs: 0,
    }, env);

    // Emit the canonical `armed` event so `ralph-tui list/stats`
    // pick up this run.
    emitter.write({
        type: "armed",
        ts: now(),
        runId,
        label,
        startedAt,
        maxIterations: max,
        minIterations: 1,
        contextMode,
        mode,
    });

    // Issue #54 slice 2c — replay HEAD on mount so the LastCommit
    // pane is never empty when commits exist on disk. Without this
    // emit, a fresh run that hasn't yet made a commit (e.g. iter 0,
    // or the first few iters of a `--prompt` run that doesn't touch
    // git) shows an empty pane even though `git log -1` has plenty
    // to surface. Carries `iteration: 0` so foldEvents lays the
    // arm-time HEAD into `snap.lastCommit` before any iter has run;
    // a later `commit_observed` from the iter loop simply
    // overwrites it (which is the desired behaviour — newest commit
    // wins). When `gitExec` is null (test runner without a stub) or
    // the cwd isn't a repo, `readHeadCommit` returns null and we
    // silently skip — the pane stays empty exactly like before.
    try {
        const armHead = readHeadCommit({ gitExec, cwd, env });
        if (armHead) {
            emitter.write({
                type: "commit_observed",
                ts: now(),
                runId,
                label,
                iteration: 0,
                sha: armHead.sha,
                subject: armHead.subject,
                trailers: armHead.trailers,
            });
        }
    } catch { /* serialization rejection — skip */ }

    if (onRunId) {
        try { onRunId(runId); } catch { /* swallow */ }
    }

    let terminationReason = null;
    let terminationNote = null;
    let lastAssistantContent = "";
    let stopRequested = false;
    let capturedSessionId = null;
    // Issue #57 — track the most recently-emitted `session_attached`
    // sessionId so we don't re-emit the same value across multiple
    // iters in continue-mode (where the Copilot CLI keeps the same
    // sessionId for the whole run). Each iter's `result.sessionId`
    // is compared against this; an emit fires only on a change.
    let lastEmittedSessionId = null;
    // Cumulative-for-the-run usage rolled up across iters so each
    // iteration_end carries run-total values for tokens (output) and
    // Copilot premium-request count. The post-iter reconciler folds
    // `reduceCopilotEvents(result.events)` into these (authoritative);
    // the live `onLine` path uses iter-scoped local counters
    // (iterLiveOutputTokens, iterLivePremiumRequests) ONLY to drive
    // the mid-iter `usage_update` events for live-UI visibility.
    // premiumRequests stays `null` until a credible value lands so
    // the TUI Header can hide the counter rather than confidently
    // rendering `premium 0` pre-iter-1.
    let runOutputTokens = 0;
    let runPremiumRequests = null;

    for (let iter = 1; iter <= max; iter++) {
        // Honor pause/stop via state file.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const s = readState(runId, env);
            if (!s) break;
            if (s.stopRequested) {
                stopRequested = true;
                terminationReason = "stopped";
                terminationNote = s.stopReason ?? "user_stop";
                break;
            }
            if (!s.paused) break;
            await delay(PAUSE_POLL_INTERVAL_MS);
        }
        if (stopRequested) break;

        emitter.write({
            type: "iteration_start",
            ts: now(),
            runId,
            label,
            iteration: iter,
        });
        stdout.write?.(`# iter ${iter}/${max}\n`);

        // Decide whether to resume an existing session or start a
        // fresh one. --continue captures sessionId at iter 1 then
        // resumes it; --fresh always starts fresh.
        const resumeSessionId = (contextMode === "continue" && iter > 1) ? capturedSessionId : null;
        const sessionNameForIter = (contextMode === "continue" && iter === 1) ? sessionName : null;

        let result;
        // Issue #48 / streaming emission: extract `stage_start` /
        // `stage_end` / `substage` events LIVE as the agent's JSONL
        // events arrive, instead of in a single batch after the child
        // exits. Without this, `events.jsonl` shows nothing between
        // `iteration_start` and `iteration_end` for the entire
        // duration of an iter — and the TUI tails events.jsonl, so
        // it renders empty panes ("(no active stage)" / "(no
        // activity yet)") for the whole iter. With this, stages and
        // tool completions surface in the TUI as they happen.
        //
        // `extractAgentTimeline` is monotonic: feeding it a longer
        // prefix of events only EXTENDS its output array — earlier
        // items stay at their positions. So we re-run it on each new
        // event and emit only the new tail (indices >=
        // `emittedItemsCount`). Tracked closure state — the
        // `liveActiveMarker` carry-over and `liveSubstageIdx` reset
        // semantics — must mirror what the post-iter loop did.
        //
        // A final suffix-replay pass after `await runOneIteration`
        // (below the await) defends against any drift between the
        // streamed events and the post-iter `result.events` array
        // (e.g. a future onLine bug that silently drops an event).
        // It's a no-op in the happy path.
        const allowedStages = stagesForMode(mode);
        const liveEvents = [];
        let emittedItemsCount = 0;
        let liveActiveMarker = null;
        let liveSubstageIdx = 0;
        // Issue #48 slice 9 — track which `tool.execution_complete`
        // toolCallIds we've already turned into a `commit_observed`
        // event so the post-iter suffix replay (the safety net for
        // dropped onLine deliveries) doesn't double-emit. Critique
        // explicitly called this out: per-call idempotence beats
        // post-hoc range scans for happy-path simplicity.
        const commitObservedToolCallIds = new Set();
        // Active workitem reference carried across iters so a
        // `[WORKITEM_END: {…}]` without an explicit ref/title can
        // backfill from the in-flight item rather than fail
        // serialization.
        let activeWorkItemRef = null;
        const emitCommitObservedFromHead = (itemTs) => {
            // Best-effort: shell out to git for the SHA + subject +
            // trailers of HEAD. If the runner has no gitExec (or
            // the repo isn't there), silently skip — the LastCommit
            // pane just doesn't update for this iter.
            const head = readHeadCommit({ gitExec, cwd, env });
            if (!head) return;
            try {
                emitter.write({
                    type: "commit_observed",
                    ts: itemTs,
                    runId,
                    label,
                    iteration: iter,
                    sha: head.sha,
                    subject: head.subject,
                    trailers: head.trailers,
                });
            } catch { /* serialization rejection — skip */ }
        };
        const emitTimelineSuffix = (sourceEvents, fallbackTs) => {
            const timeline = extractAgentTimeline(sourceEvents, allowedStages);
            for (let i = emittedItemsCount; i < timeline.length; i++) {
                const item = timeline[i];
                const itemTs = Number.isFinite(item.ts) ? item.ts : (fallbackTs ?? now());
                if (item.kind === "stage_marker") {
                    if (liveActiveMarker) {
                        emitter.write({
                            type: "stage_end",
                            ts: itemTs,
                            runId,
                            label,
                            iteration: iter,
                            stage: liveActiveMarker.stage,
                            stageName: liveActiveMarker.name,
                        });
                    }
                    emitter.write({
                        type: "stage_start",
                        ts: itemTs,
                        runId,
                        label,
                        iteration: iter,
                        stage: item.stage,
                        stageName: item.name,
                    });
                    liveActiveMarker = item;
                    liveSubstageIdx = 0;
                } else if (item.kind === "tool_complete") {
                    liveSubstageIdx += 1;
                    emitter.write({
                        type: "substage",
                        ts: itemTs,
                        runId,
                        label,
                        iteration: iter,
                        sub: liveSubstageIdx,
                        verb: item.verb,
                        argsSummary: item.argsSummary,
                        outcome: item.outcome,
                        durationMs: item.durationMs,
                    });
                    // Issue #48 slice 9 — runner-side commit_observed.
                    // Trigger when a `bash` tool just succeeded with
                    // a `git commit` invocation. We inspect the RAW
                    // arguments object (item.args.command), not the
                    // truncated argsSummary, so a multi-line bash
                    // script with the commit on a non-first line
                    // still fires. Idempotent per toolCallId so the
                    // post-iter replay path can't double-emit.
                    if (
                        item.outcome === "ok"
                        && item.verb === "bash"
                        && item.args
                        && typeof item.args.command === "string"
                        && looksLikeGitCommit(item.args.command)
                        && typeof item.toolCallId === "string"
                        && !commitObservedToolCallIds.has(item.toolCallId)
                    ) {
                        commitObservedToolCallIds.add(item.toolCallId);
                        emitCommitObservedFromHead(itemTs);
                    }
                } else if (item.kind === "workitem_start") {
                    const p = item.payload || {};
                    const kind = typeof p.kind === "string" ? p.kind : null;
                    if (!WORKITEM_KIND_SET.has(kind)) continue;
                    activeWorkItemRef = Number.isFinite(p.ref) ? p.ref : null;
                    try {
                        emitter.write({
                            type: "workitem_start",
                            ts: itemTs,
                            runId,
                            label,
                            iteration: iter,
                            kind,
                            ref: activeWorkItemRef ?? undefined,
                            title: typeof p.title === "string" ? p.title : undefined,
                        });
                    } catch { /* serializer rejection — skip */ }
                } else if (item.kind === "workitem_end") {
                    const p = item.payload || {};
                    const kind = typeof p.kind === "string" ? p.kind : null;
                    if (!WORKITEM_KIND_SET.has(kind)) continue;
                    try {
                        emitter.write({
                            type: "workitem_end",
                            ts: itemTs,
                            runId,
                            label,
                            iteration: iter,
                            kind,
                            ref: Number.isFinite(p.ref) ? p.ref : (activeWorkItemRef ?? undefined),
                            closesN: Number.isFinite(p.closesN) ? p.closesN : undefined,
                        });
                    } catch { /* serializer rejection — skip */ }
                    activeWorkItemRef = null;
                } else if (item.kind === "stage_plan") {
                    const p = item.payload || {};
                    if (!Array.isArray(p.stages) || p.stages.length === 0) continue;
                    const rawStages = p.stages
                        .filter((s) => typeof s === "string" && s)
                        .slice(0, 64);
                    if (rawStages.length === 0) continue;
                    // Emit the agent's RAW stages first so replay shows
                    // exactly what the agent said. The runner-side
                    // pinned-tail repair (next step) is surfaced as a
                    // sequence of `stage_plan_amend` events with the
                    // canonical reason string, NOT as a "corrected"
                    // stage_plan that erases the agent's intent.
                    try {
                        emitter.write({
                            type: "stage_plan",
                            ts: itemTs,
                            runId,
                            label,
                            iteration: iter,
                            stages: rawStages,
                        });
                    } catch { continue; }
                    const amends = computePinnedTailAmendments(rawStages, PINNED_TAIL_STAGES);
                    for (const a of amends) {
                        const ev = {
                            type: "stage_plan_amend",
                            ts: itemTs,
                            runId,
                            label,
                            iteration: iter,
                            reason: a.reason,
                        };
                        if (a.add) ev.add = a.add;
                        if (a.remove) ev.remove = a.remove;
                        if (a.after) ev.after = a.after;
                        try { emitter.write(ev); } catch { /* skip */ }
                    }
                } else if (item.kind === "stage_plan_amend") {
                    const p = item.payload || {};
                    const hasAdd = typeof p.add === "string" && p.add;
                    const hasRemove = typeof p.remove === "string" && p.remove;
                    if (!hasAdd && !hasRemove) continue;
                    const reason = typeof p.reason === "string" && p.reason
                        ? p.reason : "agent-amendment";
                    const ev = {
                        type: "stage_plan_amend",
                        ts: itemTs,
                        runId,
                        label,
                        iteration: iter,
                        reason,
                    };
                    if (hasAdd) ev.add = p.add;
                    if (hasRemove) ev.remove = p.remove;
                    if (typeof p.after === "string" && p.after) ev.after = p.after;
                    try { emitter.write(ev); } catch { /* skip */ }
                } else if (item.kind === "task_list") {
                    const p = item.payload || {};
                    if (typeof p.stage !== "string" || !p.stage) continue;
                    if (!Array.isArray(p.items)) continue;
                    try {
                        emitter.write({
                            type: "task_list",
                            ts: itemTs,
                            runId,
                            label,
                            iteration: iter,
                            stage: p.stage,
                            items: p.items.filter((s) => typeof s === "string" && s),
                        });
                    } catch { /* skip */ }
                } else if (item.kind === "task_start") {
                    const p = item.payload || {};
                    if (typeof p.stage !== "string" || !p.stage) continue;
                    if (!Number.isFinite(p.sub) || p.sub < 1) continue;
                    if (typeof p.desc !== "string" || !p.desc) continue;
                    try {
                        emitter.write({
                            type: "task_start",
                            ts: itemTs,
                            runId,
                            label,
                            iteration: iter,
                            stage: p.stage,
                            sub: p.sub,
                            desc: p.desc,
                        });
                    } catch { /* skip */ }
                } else if (item.kind === "task_end") {
                    const p = item.payload || {};
                    if (typeof p.stage !== "string" || !p.stage) continue;
                    if (!Number.isFinite(p.sub) || p.sub < 1) continue;
                    if (!TASK_OUTCOME_SET.has(p.outcome)) continue;
                    const ev = {
                        type: "task_end",
                        ts: itemTs,
                        runId,
                        label,
                        iteration: iter,
                        stage: p.stage,
                        sub: p.sub,
                        outcome: p.outcome,
                    };
                    if (Number.isFinite(p.durationMs)) ev.durationMs = p.durationMs;
                    try { emitter.write(ev); } catch { /* skip */ }
                }
            }
            emittedItemsCount = timeline.length;
        };
        // Per-iter live counters that the `onLine` callback accrues
        // from streamed `assistant.message` and `result` events. They
        // exist solely so the live `usage_update` emits show
        // monotonically-increasing totals as the iter unfolds; they
        // are NOT the source of truth for the cumulative-run totals.
        // After the iter completes, `reduceCopilotEvents` re-aggregates
        // the iter's full event list (canonical post-iter), and that
        // is what flows into `runOutputTokens` / `runPremiumRequests`.
        // This way an `onLine` throw that silently dropped a delta
        // can drift the live UI temporarily, but the iter-close
        // reconciliation pulls everything back into agreement.
        let iterLiveOutputTokens = 0;
        let iterLivePremiumRequests = null;
        // Issue #54 slice 2a — per-iter accumulator of root-agent
        // assistant content used for live Timeline excerpt updates.
        // Concatenates each `assistant.message.data.content` chunk
        // (root agent only — sub-agent excerpts would clobber the
        // user-visible iter narration). Capped at LIVE_EXCERPT_BYTES
        // chars at emit time (events.mjs serializer also caps at 500
        // surrogate-safely as defence in depth). Reset implicitly
        // because the whole `onLine` closure is rebuilt per-iter.
        let iterLiveExcerpt = "";
        let iterLiveExcerptLastEmittedLen = 0;
        // 80 chars ≈ one Timeline row's worth of new content. Below
        // this we don't bother emitting — Timeline truncates to 80
        // anyway, so a smaller delta would be invisible to the user.
        const LIVE_EXCERPT_THRESHOLD = 80;
        const onLine = (rawEvent) => {
            // `runOneIteration` already wraps this in try/catch so a
            // throw here is silently swallowed — but a swallowed
            // throw would re-introduce the empty-panes symptom. Do
            // the work defensively; the suffix-replay pass after
            // `await` is the safety net if this path drops events.
            liveEvents.push(rawEvent);
            try { emitTimelineSuffix(liveEvents); }
            catch { /* swallow — suffix replay below recovers */ }
            // Live usage emission. `iteration_end` (the canonical
            // post-iter event) only fires ONCE at iter close, so
            // without this path the TUI Header was stuck at
            // `tokens 0` for the whole iter. Stream a lightweight
            // `usage_update` event whenever a root-agent
            // `assistant.message` (per-message outputTokens delta)
            // or terminal `result` (per-iter premiumRequests) lands,
            // carrying the cumulative-for-the-run totals so
            // foldEvents updates `snap.tokens` /
            // `snap.premiumRequests` immediately.
            try {
                if (rawEvent && rawEvent.type === "assistant.message" && rawEvent.data && !rawEvent.agentId) {
                    const tok = Number(rawEvent.data.outputTokens);
                    // Issue #54 slice 2a — accumulate root-agent
                    // content for live Timeline excerpt streaming.
                    // Done independently of the tokens path so a
                    // root-agent message with no outputTokens (e.g.
                    // a streamed-in-parts assistant message where
                    // only the final chunk carries the cumulative
                    // delta) still feeds the excerpt accumulator.
                    if (typeof rawEvent.data.content === "string" && rawEvent.data.content.length > 0) {
                        iterLiveExcerpt += rawEvent.data.content;
                    }
                    if (Number.isFinite(tok) && tok > 0) {
                        iterLiveOutputTokens += tok;
                        const ev = {
                            type: "usage_update",
                            ts: now(),
                            runId,
                            label,
                            iteration: iter,
                            tokens: { input: 0, output: runOutputTokens + iterLiveOutputTokens },
                        };
                        if (runPremiumRequests !== null || iterLivePremiumRequests !== null) {
                            ev.premiumRequests = (runPremiumRequests ?? 0) + (iterLivePremiumRequests ?? 0);
                        }
                        // Piggyback live excerpt onto this same
                        // event whenever we have new content. The
                        // FIRST excerpt fires as soon as ANY content
                        // accumulates so a terse iter (1-79 chars)
                        // doesn't show `(working…)` for the whole
                        // duration. Subsequent updates apply the
                        // 80-char delta threshold so we don't churn
                        // the event stream. Reusing the existing
                        // usage_update keeps the event stream lean
                        // (no separate excerpt-only event type) and
                        // decouples emit cadence from token cadence.
                        const newChars = iterLiveExcerpt.length - iterLiveExcerptLastEmittedLen;
                        const isFirstExcerpt = iterLiveExcerptLastEmittedLen === 0 && iterLiveExcerpt.length > 0;
                        if (isFirstExcerpt || newChars >= LIVE_EXCERPT_THRESHOLD) {
                            ev.excerpt = iterLiveExcerpt.slice(0, 500);
                            iterLiveExcerptLastEmittedLen = iterLiveExcerpt.length;
                        }
                        emitter.write(ev);
                    } else {
                        const newChars = iterLiveExcerpt.length - iterLiveExcerptLastEmittedLen;
                        const isFirstExcerpt = iterLiveExcerptLastEmittedLen === 0 && iterLiveExcerpt.length > 0;
                        if (isFirstExcerpt || newChars >= LIVE_EXCERPT_THRESHOLD) {
                            // No tokens, but new content worth
                            // surfacing. Emit an excerpt-bearing
                            // usage_update so the Timeline row
                            // updates even when the agent is between
                            // token-bearing message boundaries.
                            const ev = {
                                type: "usage_update",
                                ts: now(),
                                runId,
                                label,
                                iteration: iter,
                                tokens: { input: 0, output: runOutputTokens + iterLiveOutputTokens },
                                excerpt: iterLiveExcerpt.slice(0, 500),
                            };
                            if (runPremiumRequests !== null || iterLivePremiumRequests !== null) {
                                ev.premiumRequests = (runPremiumRequests ?? 0) + (iterLivePremiumRequests ?? 0);
                            }
                            iterLiveExcerptLastEmittedLen = iterLiveExcerpt.length;
                            emitter.write(ev);
                        }
                    }
                } else if (rawEvent && rawEvent.type === "result") {
                    const pr = Number(rawEvent.usage?.premiumRequests);
                    if (Number.isFinite(pr) && pr >= 0) {
                        iterLivePremiumRequests = (iterLivePremiumRequests ?? 0) + pr;
                        emitter.write({
                            type: "usage_update",
                            ts: now(),
                            runId,
                            label,
                            iteration: iter,
                            tokens: { input: 0, output: runOutputTokens + iterLiveOutputTokens },
                            premiumRequests: (runPremiumRequests ?? 0) + iterLivePremiumRequests,
                        });
                    }
                }
            } catch { /* swallow — defensive against a future
                         emitter / serializer change that throws on a
                         malformed payload; the iteration_end backfill
                         below is the safety net */ }
        };

        try {
            result = await runOneIteration({
                prompt: composedPrompt,
                resumeSessionId,
                sessionName: sessionNameForIter,
                spawn,
                copilotBin,
                cwd,
                env,
                onLine,
            });
        } catch (err) {
            terminationReason = "error";
            terminationNote = err?.message ?? String(err);
            stderr.write?.(`ralph-tui run: subprocess error: ${terminationNote}\n`);
            // Even on subprocess error, fold in any iter-live usage
            // counters (the child may have emitted some
            // assistant.message events before crashing) so the final
            // iteration_end carries the partial totals rather than
            // resetting to whatever the previous iter had.
            runOutputTokens += iterLiveOutputTokens;
            if (iterLivePremiumRequests !== null) {
                runPremiumRequests = (runPremiumRequests ?? 0) + iterLivePremiumRequests;
            }
            const errEv = {
                type: "iteration_end",
                ts: now(),
                runId,
                label,
                iteration: iter,
                excerpt: "",
                note: terminationNote,
                tokens: { input: 0, output: runOutputTokens },
            };
            if (runPremiumRequests !== null) errEv.premiumRequests = runPremiumRequests;
            emitter.write(errEv);
            break;
        }

        const reduced = reduceCopilotEvents(result.events);
        lastAssistantContent = reduced.assistantContent;
        if (contextMode === "continue" && iter === 1 && reduced.sessionId) {
            capturedSessionId = reduced.sessionId;
            updateState(runId, (s) => { s.sessionId = capturedSessionId; return s; }, env);
        }
        // Issue #57 / live-output panel — surface the active iter's
        // sessionId on the events stream so the TUI can mount a tail
        // against `~/.copilot/session-state/<sessionId>.jsonl`.
        // Independent of `--continue`'s capture above (which only
        // fires for iter 1 in continue-mode runs); this fires on
        // every iter regardless of contextMode whenever the
        // sessionId changes, so the panel works for fresh-context
        // runs too. Suppressed when sessionId is null (the reducer
        // didn't surface one — old Copilot CLI without session
        // ids, or a run that bailed before the terminal `result`
        // event arrived) and when the value is the same as the
        // previous iter (no-op event spam avoided).
        if (reduced.sessionId && reduced.sessionId !== lastEmittedSessionId) {
            emitter.write({
                type: "session_attached",
                ts: now(),
                runId,
                iteration: iter,
                sessionId: reduced.sessionId,
            });
            lastEmittedSessionId = reduced.sessionId;
        }
        // Iter-close reconciliation: the canonical reducer ran over
        // `result.events` (the iter's full event list) — use it as
        // the source of truth for the iter contribution rather than
        // the iterLive* counters that the streaming `onLine` path
        // accrued. They normally match (both look at the same
        // events); when they diverge it's because an `onLine`
        // invocation threw and silently swallowed an event. Discard
        // iterLive* and fold the reducer's totals so the
        // iteration_end emit ALWAYS carries the right
        // cumulative-for-the-run values.
        runOutputTokens += reduced.outputTokens;
        if (reduced.premiumRequests !== null) {
            runPremiumRequests = (runPremiumRequests ?? 0) + reduced.premiumRequests;
        }

        // Issue #48 / streaming emission: the live `onLine` path
        // (above the await) already emitted stage_start / stage_end /
        // substage events as the child JSONL streamed in. Two
        // safety-net steps remain:
        //
        // 1. Suffix-replay against `result.events` in case the live
        //    path missed any items (e.g. a swallowed throw inside
        //    `emitTimelineSuffix`, or — historically — the close-
        //    handler's trailing-partial-line drain that bypassed
        //    `onLine` before runOneIteration was tightened to call
        //    it). This is a no-op in the happy path because
        //    `emittedItemsCount` already equals the timeline length;
        //    it only emits the unlikely tail. Uses the iter's wall
        //    clock as fallback timestamp for items whose underlying
        //    agent event has no parseable `timestamp`.
        // 2. Emit a final `stage_end` for the still-active marker so
        //    every stage_start has a matching stage_end. Uses
        //    `now()` since the stage's true end is "child exit".
        //
        // Markers outside the canonical stage list (a typo or
        // hallucination) are silently dropped by extractAgentTimeline.
        // `tool.execution_complete` events produce substage records
        // with a verb (toolName), a one-line arguments summary, an
        // outcome (`ok` / error code), and a computed durationMs.
        // Per-event timestamps come from the agent's own `timestamp`
        // when finite; the wall-clock fallback is only for synthetic
        // test fixtures that omit it.
        emitTimelineSuffix(result.events, now());
        if (liveActiveMarker) {
            emitter.write({
                type: "stage_end",
                ts: now(),
                runId,
                label,
                iteration: iter,
                stage: liveActiveMarker.stage,
                stageName: liveActiveMarker.name,
            });
        }

        // Issue #48 slice 6: capture backlog state from the agent's
        // own `gh` probes during ORIENT and emit a `backlog_snapshot`
        // event so the renderer's header (`X open issues / Y open PRs
        // / Z red CI runs`) updates after every iter. We piggy-back
        // on the agent's stdout — no extra `gh` calls from the runner
        // — so the snapshot is free when the agent runs the probes
        // (per the baked SDLC prompt) and silently absent otherwise.
        // Fields the agent did not probe stay null; the renderer
        // shows "?" for null fields.
        const backlog = extractBacklogFromEvents(result.events);
        if (backlog) {
            emitter.write({
                type: "backlog_snapshot",
                ts: now(),
                runId,
                label,
                iteration: iter,
                redCi: backlog.redCi,
                openPrs: backlog.openPrs,
                openIssues: backlog.openIssues,
            });
        }

        const excerpt = lastAssistantContent.slice(0, 500);
        const iterEndEv = {
            type: "iteration_end",
            ts: now(),
            runId,
            label,
            iteration: iter,
            excerpt,
            tokens: { input: 0, output: runOutputTokens },
        };
        if (runPremiumRequests !== null) iterEndEv.premiumRequests = runPremiumRequests;
        emitter.write(iterEndEv);
        updateState(runId, (s) => { s.iter = iter; return s; }, env);
        if (onIteration) {
            try { onIteration({ iter, excerpt, sessionId: capturedSessionId, exitCode: result.exitCode }); }
            catch { /* swallow */ }
        }

        if (result.exitCode !== 0) {
            terminationReason = "subprocess_failed";
            terminationNote = `copilot exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`;
            stderr.write?.(`ralph-tui run: ${terminationNote}\n`);
            break;
        }

        // Promise detection runs AFTER iteration_end so the run
        // history shows the iter that emitted COMPLETE / ABORT_*.
        if (completionPromise && lastAssistantContent.includes(completionPromise)) {
            terminationReason = "complete";
            break;
        }
        if (abortPromise && lastAssistantContent.includes(abortPromise)) {
            terminationReason = "abort";
            terminationNote = `agent emitted ${abortPromise}`;
            break;
        }
    }

    if (!terminationReason) {
        terminationReason = "max_iterations";
        terminationNote = `reached max=${max}`;
    }

    updateState(runId, (s) => {
        s.terminated = true;
        s.terminationReason = terminationReason;
        if (terminationNote) s.terminationNote = terminationNote;
        return s;
    }, env);

    const terminalType = terminationReason === "complete" ? "complete" : "abort";
    emitter.write({
        type: terminalType,
        ts: now(),
        runId,
        label,
        reason: terminationReason,
        note: terminationNote ?? undefined,
    });

    return { runId, terminationReason, terminationNote, iterations: lastAssistantContent ? undefined : 0, sessionId: capturedSessionId };
}
