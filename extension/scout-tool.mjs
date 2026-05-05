// autopilot_scout — pure-function deterministic probe of `gh` + repo state.
//
// Wave 2a of the fleet pivot (issue #118, child of epic #116). Replaces the
// ORIENT/IDEATE/SELECT stages of the legacy 30 KB PROMPT_SELF_IMPROVE prompt
// with a deterministic JS function so the LLM can focus on shipping
// (autopilot-shipper, #119) instead of fuzzy backlog inference.
//
// Tri-state output:
//   - candidate  — work item to ship (CI failure > stale PR > human issue).
//   - no_work    — every probe succeeded AND every probe returned empty.
//   - blocked    — ANY probe failed (gh missing, unauth, rate-limited, error).
//                  NEVER collapse a probe failure to no_work — a transient
//                  gh outage cannot end the loop.
//
// No LLM call here. No mutation. The handler shells `gh`, parses JSON, picks
// a candidate, returns. Wave 2b (issue #120) wires this into extension.mjs.

import { createRequire } from "node:module";

const moduleRequire = createRequire(import.meta.url);

export const SCOUT_TOOL_NAME = "autopilot_scout";

// Issue/PR labels produced by the legacy `grow_project` ideation loop. Items
// carrying these labels belong to the loop-ideated feature backlog runner,
// not the human-filed work scout is meant to surface. Excluded at pickCandidate.
const GROW_PROJECT_LABELS = new Set(["grow-project", "proposed"]);

// Stale-PR threshold: an open PR untouched for > 7 days is a candidate even
// without a merge conflict or failing check. Mirrors GitHub's own "stale" UX.
const STALE_PR_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Per-call timeout for `gh` invocations. gh can hang on a wedged network or
// a credential helper waiting on a TTY; cap each call so the scout can't
// stall the loop. 15s is generous for the listings (gh issue/pr/run list
// typically respond < 2s) but avoids breaking on a slow API day.
const GH_TIMEOUT_MS = 15_000;

// Acceptance-line cap: keep the one-line pass criterion readable in a
// terminal. Issues with multi-paragraph titles get clipped here.
const MAX_ACCEPTANCE_CHARS = 100;

// scope_files extraction caps — bounded so a runaway log or PR doesn't
// dump a thousand paths into the candidate payload.
const MAX_SCOPE_FILES_FROM_LOG = 10;
const MAX_SCOPE_FILES_FROM_PR = 20;
const MAX_SCOPE_FILES_FROM_BODY = 10;

// Whitelist of file extensions surfaced in scope_files. The shipper widens
// scope when this is empty, so erring narrow is fine.
const SCOPE_FILE_RE = /[A-Za-z0-9_./-]+\.(?:mjs|js|ts|json|md)/g;

// Default child_process.execFileSync wrapper. Returns
//   { ok, stdout, stderr, code }
// where ok = (exit 0). Never throws — every error path is normalized to
// the same shape so the caller's classifier can run uniformly. Production
// uses this; tests inject `runGh` directly via createScoutTool({ runGh }).
function defaultRunGh(args, { cwd, timeoutMs = GH_TIMEOUT_MS } = {}) {
    let spawnSync;
    try {
        ({ spawnSync } = moduleRequire("node:child_process"));
    } catch {
        return { ok: false, stdout: "", stderr: "child_process unavailable", code: null };
    }
    let res;
    try {
        res = spawnSync("gh", args, {
            cwd,
            timeout: timeoutMs,
            encoding: "utf8",
            // Disable any prompt that would deadlock spawnSync on a CI/host
            // missing a TTY-backed credential helper.
            env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
        });
    } catch (err) {
        return { ok: false, stdout: "", stderr: err?.message ?? String(err), code: null };
    }
    if (res?.error) {
        // ENOENT lands here when `gh` isn't on PATH. The classifier picks it
        // up via the stderr substring check.
        const msg = res.error.code === "ENOENT"
            ? "gh: command not found"
            : (res.error.message ?? String(res.error));
        return { ok: false, stdout: "", stderr: msg, code: res.status ?? null };
    }
    if (!res) {
        return { ok: false, stdout: "", stderr: "spawnSync returned no result", code: null };
    }
    return {
        ok: res.status === 0,
        stdout: typeof res.stdout === "string" ? res.stdout : "",
        stderr: typeof res.stderr === "string" ? res.stderr : "",
        code: res.status ?? null,
    };
}

// Classify a `runGh` result into the blocked-reason taxonomy. Returns null
// when the result is not a probe failure (caller continues with stdout).
//
// `kind` distinguishes pre-flight checks ("which" / "auth") from listing
// calls so that an ENOENT during `gh run list` still classifies as
// gh_missing rather than gh_error — defensive against environments that
// only fail late.
export function _classifyError(res, kind = "list") {
    if (!res || res.ok) return null;
    const stderr = (res.stderr || "").toString();
    const firstLine = stderr.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (kind === "which" || /command not found|ENOENT|spawn .*ENOENT/i.test(stderr)) {
        return { kind: "blocked", reason: "gh_missing", detail: firstLine || "gh not on PATH" };
    }
    if (kind === "auth" || /not logged|authentication required|gh auth login|You are not logged into any GitHub hosts/i.test(stderr)) {
        return { kind: "blocked", reason: "gh_unauth", detail: firstLine || "gh not authenticated" };
    }
    if (/\b403\b|\b429\b|rate ?limit|API rate limit exceeded|secondary rate limit|abuse detection/i.test(stderr)) {
        return { kind: "blocked", reason: "gh_rate_limited", detail: firstLine || "gh rate limited" };
    }
    return { kind: "blocked", reason: "gh_error", detail: firstLine || `gh exited ${res.code ?? "?"}` };
}

// Best-effort JSON.parse: returns the parsed value on success, otherwise
// `{ __parseError: <message> }`. The caller treats a parse failure as a
// blocked/gh_error — corrupt JSON from `gh` is indistinguishable from a
// silently-failed call as far as the loop is concerned.
function tryParseJson(text) {
    try {
        const v = JSON.parse(text);
        return { ok: true, value: v };
    } catch (err) {
        return { ok: false, error: err?.message ?? "JSON parse failed" };
    }
}

// Probe the three gh listings + the pre-flight checks. Returns either:
//   { ok: true, runs, prs, issues }
// or
//   { ok: false, blocked: <blocked-result> }
//
// Pre-flight `gh auth status` runs through the same `runGh`; tests can mock
// it. We deliberately call `--version` instead of `which gh` because `which`
// is a separate binary and `gh --version` is what `gh` itself supports — if
// it ENOENTs, runGh's classifier flags gh_missing the same way.
export async function _probe({ runGh, cwd } = {}) {
    if (typeof runGh !== "function") {
        return { ok: false, blocked: { kind: "blocked", reason: "gh_error", detail: "runGh dependency missing" } };
    }
    // 1. gh present?
    const versionRes = await runGh(["--version"], { cwd });
    const versionErr = _classifyError(versionRes, "which");
    if (versionErr) return { ok: false, blocked: versionErr };
    // 2. gh authenticated?
    const authRes = await runGh(["auth", "status"], { cwd });
    const authErr = _classifyError(authRes, "auth");
    if (authErr) return { ok: false, blocked: authErr };
    // 3. The three listings. Order matters — bail at the first failure so a
    // rate-limit on the first probe doesn't bury subsequent ones.
    const probes = [
        {
            key: "runs",
            args: [
                "run", "list", "--status", "failure", "--limit", "5",
                "--json", "databaseId,headBranch,event,conclusion,createdAt,name,url",
            ],
        },
        {
            key: "prs",
            args: [
                "pr", "list", "--state", "open", "--limit", "10",
                "--json", "number,title,headRefName,mergeable,statusCheckRollup,reviewDecision,updatedAt,url",
            ],
        },
        {
            key: "issues",
            args: [
                "issue", "list", "--state", "open", "--limit", "30",
                "--json", "number,title,labels,createdAt,updatedAt,url",
            ],
        },
    ];
    const out = {};
    for (const p of probes) {
        const res = await runGh(p.args, { cwd });
        const err = _classifyError(res, "list");
        if (err) return { ok: false, blocked: err };
        const parsed = tryParseJson(res.stdout || "[]");
        if (!parsed.ok) {
            return { ok: false, blocked: { kind: "blocked", reason: "gh_error", detail: `gh ${p.key} JSON: ${parsed.error}` } };
        }
        if (!Array.isArray(parsed.value)) {
            return { ok: false, blocked: { kind: "blocked", reason: "gh_error", detail: `gh ${p.key} did not return an array` } };
        }
        out[p.key] = parsed.value;
    }
    return { ok: true, runs: out.runs, prs: out.prs, issues: out.issues };
}

// True if a label-array (gh's `labels` field is `[{name,...}, ...]`)
// contains any of the GROW_PROJECT_LABELS.
function hasGrowProjectLabel(labels) {
    if (!Array.isArray(labels)) return false;
    for (const l of labels) {
        const name = typeof l === "string" ? l : (l && typeof l.name === "string" ? l.name : "");
        if (GROW_PROJECT_LABELS.has(name)) return true;
    }
    return false;
}

// Summarize a `statusCheckRollup` array: gh returns it as an array of
// per-check objects with a `conclusion` ("SUCCESS" / "FAILURE" / etc.) or a
// `state` ("FAILURE" / "ERROR" / ...). We treat any non-empty failure-like
// signal as "checks failing". Conservative: missing conclusion ≠ failure.
function rollupHasFailure(rollup) {
    if (!Array.isArray(rollup)) return false;
    for (const c of rollup) {
        const concl = (c && (c.conclusion || c.state || "")).toString().toUpperCase();
        if (concl === "FAILURE" || concl === "ERROR" || concl === "TIMED_OUT" || concl === "CANCELLED") return true;
    }
    return false;
}

// Normalize an updatedAt ISO string to "days since now". Returns Infinity on
// parse failure so a malformed date never falsely qualifies as stale (errs
// toward leaving the PR alone).
function daysSince(iso, now = Date.now()) {
    if (typeof iso !== "string" || iso.length === 0) return Infinity;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return Infinity;
    return (now - t) / MS_PER_DAY;
}

// Given the three probe arrays, return the PR object that's stale (or null).
// "Stale" = mergeable === "CONFLICTING" OR statusCheckRollup has failures
// OR updatedAt > STALE_PR_DAYS days ago. First match wins; PRs are
// already returned newest-first by gh, so the order is deterministic.
function pickStalePr(prs, now) {
    if (!Array.isArray(prs)) return null;
    for (const pr of prs) {
        if (!pr || typeof pr !== "object") continue;
        const conflict = pr.mergeable === "CONFLICTING";
        const failing = rollupHasFailure(pr.statusCheckRollup);
        const olderThan = daysSince(pr.updatedAt, now) > STALE_PR_DAYS;
        if (conflict || failing || olderThan) return pr;
    }
    return null;
}

// Pick the lowest-numbered open issue not labelled grow-project / proposed.
function pickHumanIssue(issues) {
    if (!Array.isArray(issues)) return null;
    const eligible = issues.filter((i) => i && typeof i === "object" && !hasGrowProjectLabel(i.labels));
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
    return eligible[0];
}

// Pure prioritization: given probe results, return the candidate descriptor
// (without `evidence` or `scope_files` — those are filled by the handler
// after the optional follow-up gh call). Returns null when nothing matches,
// signalling no_work to the caller. Pure function for unit testing — no I/O.
export function _prioritize({ runs, prs, issues }, now = Date.now()) {
    if (Array.isArray(runs) && runs.length > 0) {
        const r = runs[0];
        return {
            ref_kind: "ci_failure",
            ref: String(r.databaseId ?? ""),
            title: typeof r.name === "string" && r.name.length > 0
                ? `CI failure: ${r.name}` + (r.headBranch ? ` on ${r.headBranch}` : "")
                : `CI failure on ${r.headBranch ?? "unknown branch"}`,
            acceptance: `Run ${r.databaseId ?? "?"} on branch ${r.headBranch ?? "?"} passes`,
            evidence: r,
        };
    }
    const stale = pickStalePr(prs, now);
    if (stale) {
        return {
            ref_kind: "pr",
            ref: String(stale.number ?? ""),
            title: typeof stale.title === "string" ? stale.title : `PR #${stale.number ?? "?"}`,
            acceptance: `PR #${stale.number ?? "?"} mergeable + checks green`,
            evidence: stale,
        };
    }
    const issue = pickHumanIssue(issues);
    if (issue) {
        const titleRaw = typeof issue.title === "string" ? issue.title : `Issue #${issue.number ?? "?"}`;
        const acceptance = titleRaw.length > MAX_ACCEPTANCE_CHARS
            ? titleRaw.slice(0, MAX_ACCEPTANCE_CHARS - 1).trimEnd() + "…"
            : titleRaw;
        return {
            ref_kind: "issue",
            ref: String(issue.number ?? ""),
            title: titleRaw,
            acceptance,
            evidence: issue,
        };
    }
    return null;
}

// Extract up to `cap` distinct file paths from a free-text blob (CI log or
// issue body). Best-effort. Pure: no I/O.
function extractScopeFromText(text, cap) {
    if (typeof text !== "string" || text.length === 0) return [];
    const seen = new Set();
    const out = [];
    SCOPE_FILE_RE.lastIndex = 0;
    let m;
    while ((m = SCOPE_FILE_RE.exec(text)) !== null) {
        const path = m[0];
        if (seen.has(path)) continue;
        seen.add(path);
        out.push(path);
        if (out.length >= cap) break;
    }
    return out;
}

// Compose the final tri-state result given probe output. `runGh` is passed
// in so the scope-files follow-up call (gh run view / gh pr view) can be
// mocked in tests; if scope-files extraction fails, we just return the
// candidate with an empty scope_files array — the shipper widens scope.
export async function _pickCandidate({ probe, runGh, cwd } = {}) {
    if (!probe || probe.ok !== true) {
        return probe?.blocked ?? { kind: "blocked", reason: "gh_error", detail: "probe missing" };
    }
    const { runs, prs, issues } = probe;
    const picked = _prioritize({ runs, prs, issues });
    if (!picked) {
        return { kind: "no_work" };
    }
    let scope_files = [];
    if (picked.ref_kind === "ci_failure" && typeof runGh === "function" && picked.ref) {
        const logRes = await runGh(["run", "view", picked.ref, "--log-failed"], { cwd });
        if (logRes && logRes.ok) {
            scope_files = extractScopeFromText(logRes.stdout, MAX_SCOPE_FILES_FROM_LOG);
        }
    } else if (picked.ref_kind === "pr" && typeof runGh === "function" && picked.ref) {
        const filesRes = await runGh(["pr", "view", picked.ref, "--json", "files"], { cwd });
        if (filesRes && filesRes.ok) {
            const parsed = tryParseJson(filesRes.stdout || "{}");
            if (parsed.ok && parsed.value && Array.isArray(parsed.value.files)) {
                const seen = new Set();
                for (const f of parsed.value.files) {
                    const p = typeof f === "string" ? f : (f && typeof f.path === "string" ? f.path : null);
                    if (!p || seen.has(p)) continue;
                    seen.add(p);
                    scope_files.push(p);
                    if (scope_files.length >= MAX_SCOPE_FILES_FROM_PR) break;
                }
            }
        }
    } else if (picked.ref_kind === "issue") {
        // Rubber-duck fix #6: the probe's `gh issue list` deliberately
        // omits `body` to keep the listing lightweight, so reading
        // `picked.evidence.body` here always saw an empty string in
        // production. Fetch the body on-demand for the picked issue
        // only — same pattern as the PR `gh pr view` call above.
        let body = (picked.evidence && typeof picked.evidence.body === "string")
            ? picked.evidence.body
            : "";
        if (!body && typeof runGh === "function" && picked.ref) {
            const bodyRes = await runGh(["issue", "view", picked.ref, "--json", "body"], { cwd });
            if (bodyRes && bodyRes.ok) {
                const parsed = tryParseJson(bodyRes.stdout || "{}");
                if (parsed.ok && parsed.value && typeof parsed.value.body === "string") {
                    body = parsed.value.body;
                }
            }
        }
        scope_files = extractScopeFromText(body, MAX_SCOPE_FILES_FROM_BODY);
    }
    return {
        kind: "candidate",
        ref: picked.ref,
        ref_kind: picked.ref_kind,
        title: picked.title,
        scope_files,
        acceptance: picked.acceptance,
        evidence: picked.evidence,
    };
}

// Public factory. Mirrors the shape of the tools in extension/handler.mjs so
// extension/extension.mjs (wired in wave 2b, issue #120) can register it via
// `joinSession({ tools: [...controller.tools, scout.definition] })` or
// equivalent. Tests construct the tool with a mock `runGh` and call
// `tool.handler({})` directly.
export function createScoutTool({ runGh, gitCwd } = {}) {
    const exec = typeof runGh === "function" ? runGh : defaultRunGh;
    const cwd = typeof gitCwd === "string" && gitCwd.length > 0 ? gitCwd : undefined;
    const definition = {
        name: SCOUT_TOOL_NAME,
        description:
            "Pick the next work item for autopilot. Pure-function probe of `gh` + repo state. Returns one of: candidate (work item to ship), no_work (backlog truly empty), blocked (probe failed — e.g. gh missing/unauth/rate-limited).",
        parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    };
    const handler = async (args) => {
        // Reject any args; the tool takes none. Mirrors the existing tools'
        // additionalProperties:false enforcement so a bad call surfaces
        // loudly instead of being silently ignored.
        if (args && typeof args === "object" && !Array.isArray(args)) {
            const keys = Object.keys(args);
            if (keys.length > 0) {
                return failure(
                    `${SCOUT_TOOL_NAME}: takes no arguments (got: ${keys.join(", ")}).`,
                );
            }
        }
        const probe = await _probe({ runGh: exec, cwd });
        const result = await _pickCandidate({ probe, runGh: exec, cwd });
        return success(JSON.stringify(result), { scout: result });
    };
    return { definition, handler, _runGh: exec };
}

// Local copies of success/failure to keep this module self-contained — the
// helpers in extension/handler.mjs aren't exported (they live inside the
// closure). The shape (textResultForLlm + resultType) matches exactly so
// the SDK's tool-result protocol treats both modules uniformly.
function failure(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "failure" };
}
function success(message, extra = {}) {
    return { ...extra, textResultForLlm: message, resultType: "success" };
}
