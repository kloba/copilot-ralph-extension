// Tests for autopilot_scout (issue #118). Pure-function — every test injects
// a mock `runGh` so no `gh` binary is needed and no network I/O occurs.

import test from "node:test";
import assert from "node:assert/strict";

import {
    SCOUT_TOOL_NAME,
    createScoutTool,
    _classifyError,
    _prioritize,
    _pickCandidate,
    _probe,
} from "../extension/scout-tool.mjs";

// Helper: a runGh mock that returns canned responses keyed by the joined
// argv. Falls back to ok-empty-array for any unexpected call so the test
// fails on the *assertion* rather than an unrelated NPE.
function makeRunGh(map) {
    return async (args) => {
        const key = args.join(" ");
        if (key in map) return map[key];
        // Unknown call: behave as if it succeeded but returned an empty
        // array so the probe pipeline keeps running. Tests assert on the
        // outer result so a stray probe gets surfaced via "kind: no_work"
        // rather than a synthetic blocked.
        return { ok: true, stdout: "[]", stderr: "", code: 0 };
    };
}

const PROBE_VERSION_OK = { ok: true, stdout: "gh version 2.x", stderr: "", code: 0 };
const PROBE_AUTH_OK = { ok: true, stdout: "Logged in to github.com", stderr: "", code: 0 };

const PROBE_KEYS = {
    version: "--version",
    auth: "auth status",
    runs: "run list --status failure --limit 5 --json databaseId,headBranch,event,conclusion,createdAt,name,url",
    prs: "pr list --state open --limit 10 --json number,title,headRefName,mergeable,statusCheckRollup,reviewDecision,updatedAt,url",
    issues: "issue list --state open --limit 30 --json number,title,labels,createdAt,updatedAt,url",
};

function jsonOk(value) {
    return { ok: true, stdout: JSON.stringify(value), stderr: "", code: 0 };
}

function ghOkEmptyMap() {
    return {
        [PROBE_KEYS.version]: PROBE_VERSION_OK,
        [PROBE_KEYS.auth]: PROBE_AUTH_OK,
        [PROBE_KEYS.runs]: jsonOk([]),
        [PROBE_KEYS.prs]: jsonOk([]),
        [PROBE_KEYS.issues]: jsonOk([]),
    };
}

// -------------------- _classifyError --------------------

test("_classifyError: gh_missing on ENOENT-style stderr", () => {
    const r = _classifyError({ ok: false, stdout: "", stderr: "gh: command not found", code: 127 });
    assert.equal(r.kind, "blocked");
    assert.equal(r.reason, "gh_missing");
    assert.match(r.detail, /command not found/);
});

test("_classifyError: gh_missing when classifier called with kind='which' regardless of stderr", () => {
    const r = _classifyError({ ok: false, stdout: "", stderr: "weird", code: 1 }, "which");
    assert.equal(r.reason, "gh_missing");
});

test("_classifyError: gh_unauth on 'You are not logged into any GitHub hosts'", () => {
    const r = _classifyError({
        ok: false,
        stdout: "",
        stderr: "You are not logged into any GitHub hosts. Run 'gh auth login' to authenticate.",
        code: 1,
    });
    assert.equal(r.reason, "gh_unauth");
});

test("_classifyError: gh_unauth when kind='auth' regardless of stderr", () => {
    const r = _classifyError({ ok: false, stdout: "", stderr: "x", code: 1 }, "auth");
    assert.equal(r.reason, "gh_unauth");
});

test("_classifyError: gh_rate_limited on 403 / 429 / 'API rate limit exceeded'", () => {
    const cases = [
        "HTTP 403: API rate limit exceeded for user ID 123",
        "HTTP 429: Too Many Requests",
        "You have exceeded a secondary rate limit",
    ];
    for (const stderr of cases) {
        const r = _classifyError({ ok: false, stdout: "", stderr, code: 1 });
        assert.equal(r.reason, "gh_rate_limited", `stderr=${stderr}`);
    }
});

test("_classifyError: gh_error fallback for any other non-zero exit", () => {
    const r = _classifyError({ ok: false, stdout: "", stderr: "something broke\nstack trace...", code: 2 });
    assert.equal(r.reason, "gh_error");
    // Detail must be the FIRST LINE of stderr — not the multi-line dump.
    assert.equal(r.detail, "something broke");
});

test("_classifyError: returns null on ok result (caller continues)", () => {
    assert.equal(_classifyError({ ok: true, stdout: "ok", stderr: "", code: 0 }), null);
});

// -------------------- _prioritize ----------------------

test("_prioritize: CI failure beats stale PR beats human issue", () => {
    const runs = [{
        databaseId: 99, headBranch: "main", event: "push", conclusion: "failure",
        createdAt: "2026-01-01T00:00:00Z", name: "ci", url: "https://x",
    }];
    const prs = [{
        number: 42, title: "Stale", headRefName: "f", mergeable: "CONFLICTING",
        statusCheckRollup: [], updatedAt: "2026-01-01T00:00:00Z", url: "https://x",
    }];
    const issues = [{ number: 7, title: "I", labels: [], createdAt: "x", updatedAt: "x", url: "https://x" }];
    const picked = _prioritize({ runs, prs, issues });
    assert.equal(picked.ref_kind, "ci_failure");
    assert.equal(picked.ref, "99");
    assert.match(picked.acceptance, /Run 99 on branch main passes/);
});

test("_prioritize: stale PR beats human issue when no CI failure", () => {
    const prs = [{
        number: 42, title: "Stale", headRefName: "f", mergeable: "CONFLICTING",
        statusCheckRollup: [], updatedAt: "2026-01-01T00:00:00Z", url: "https://x",
    }];
    const issues = [{ number: 7, title: "Pick me", labels: [], createdAt: "x", updatedAt: "x", url: "https://x" }];
    const picked = _prioritize({ runs: [], prs, issues });
    assert.equal(picked.ref_kind, "pr");
    assert.equal(picked.ref, "42");
});

test("_prioritize: PR with failing statusCheckRollup is stale even if recently updated", () => {
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    const prs = [{
        number: 11, title: "Failing checks", headRefName: "f", mergeable: "MERGEABLE",
        statusCheckRollup: [{ conclusion: "FAILURE" }],
        updatedAt: recent, url: "https://x",
    }];
    const picked = _prioritize({ runs: [], prs, issues: [] });
    assert.equal(picked.ref_kind, "pr");
    assert.equal(picked.ref, "11");
});

test("_prioritize: PR with old updatedAt (> 7 days) is stale even with passing checks", () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const prs = [{
        number: 12, title: "Old PR", headRefName: "f", mergeable: "MERGEABLE",
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
        updatedAt: old, url: "https://x",
    }];
    const picked = _prioritize({ runs: [], prs, issues: [] });
    assert.equal(picked.ref_kind, "pr");
    assert.equal(picked.ref, "12");
});

test("_prioritize: skips issues labelled 'grow-project' or 'proposed'", () => {
    const issues = [
        { number: 5, title: "loop-ideated A", labels: [{ name: "grow-project" }], updatedAt: "x", url: "https://x" },
        { number: 6, title: "loop-ideated B", labels: [{ name: "proposed" }], updatedAt: "x", url: "https://x" },
        { number: 9, title: "Real human issue", labels: [{ name: "bug" }], updatedAt: "x", url: "https://x" },
    ];
    const picked = _prioritize({ runs: [], prs: [], issues });
    assert.equal(picked.ref_kind, "issue");
    assert.equal(picked.ref, "9");
});

test("_prioritize: picks LOWEST-numbered eligible issue", () => {
    const issues = [
        { number: 99, title: "high", labels: [], updatedAt: "x", url: "https://x" },
        { number: 4, title: "low", labels: [], updatedAt: "x", url: "https://x" },
        { number: 50, title: "mid", labels: [], updatedAt: "x", url: "https://x" },
    ];
    const picked = _prioritize({ runs: [], prs: [], issues });
    assert.equal(picked.ref, "4");
});

test("_prioritize: returns null when nothing eligible (all probe arrays empty)", () => {
    assert.equal(_prioritize({ runs: [], prs: [], issues: [] }), null);
});

test("_prioritize: returns null when only ineligible labelled issues remain", () => {
    const issues = [
        { number: 1, title: "x", labels: [{ name: "grow-project" }], updatedAt: "x", url: "https://x" },
        { number: 2, title: "y", labels: [{ name: "proposed" }], updatedAt: "x", url: "https://x" },
    ];
    assert.equal(_prioritize({ runs: [], prs: [], issues }), null);
});

test("_prioritize: clips long acceptance for human issue at 100 chars", () => {
    const longTitle = "a".repeat(200);
    const issues = [{ number: 1, title: longTitle, labels: [], updatedAt: "x", url: "https://x" }];
    const picked = _prioritize({ runs: [], prs: [], issues });
    assert.ok(picked.acceptance.length <= 100, `len=${picked.acceptance.length}`);
    assert.ok(picked.acceptance.endsWith("…"), "expected ellipsis truncation");
});

// -------------------- _pickCandidate (no_work) -----------

test("_pickCandidate: returns no_work when all probe arrays empty AND probe ok", async () => {
    const probe = { ok: true, runs: [], prs: [], issues: [] };
    const result = await _pickCandidate({ probe });
    assert.deepEqual(result, { kind: "no_work" });
});

test("_pickCandidate: passes through probe.blocked unchanged", async () => {
    const probe = { ok: false, blocked: { kind: "blocked", reason: "gh_unauth", detail: "x" } };
    const result = await _pickCandidate({ probe });
    assert.deepEqual(result, { kind: "blocked", reason: "gh_unauth", detail: "x" });
});

test("_pickCandidate: synthesizes blocked/gh_error when probe is missing entirely", async () => {
    const result = await _pickCandidate({});
    assert.equal(result.kind, "blocked");
    assert.equal(result.reason, "gh_error");
});

// -------------------- _probe (failure-not-no_work) -------

test("_probe: blocked when ANY listing call fails, even if earlier probes returned data", async () => {
    // Runs probe succeeds with one item, but PR probe rate-limits.
    const runs = [{ databaseId: 1, headBranch: "main", name: "ci", url: "x" }];
    const runGh = makeRunGh({
        [PROBE_KEYS.version]: PROBE_VERSION_OK,
        [PROBE_KEYS.auth]: PROBE_AUTH_OK,
        [PROBE_KEYS.runs]: jsonOk(runs),
        [PROBE_KEYS.prs]: { ok: false, stdout: "", stderr: "HTTP 429: API rate limit exceeded", code: 1 },
    });
    const probe = await _probe({ runGh });
    assert.equal(probe.ok, false);
    assert.equal(probe.blocked.reason, "gh_rate_limited");
});

test("_probe: blocked/gh_missing when version probe ENOENTs", async () => {
    const runGh = makeRunGh({
        [PROBE_KEYS.version]: { ok: false, stdout: "", stderr: "spawn gh ENOENT", code: null },
    });
    const probe = await _probe({ runGh });
    assert.equal(probe.ok, false);
    assert.equal(probe.blocked.reason, "gh_missing");
});

test("_probe: blocked/gh_unauth when auth status fails", async () => {
    const runGh = makeRunGh({
        [PROBE_KEYS.version]: PROBE_VERSION_OK,
        [PROBE_KEYS.auth]: { ok: false, stdout: "", stderr: "You are not logged into any GitHub hosts.", code: 1 },
    });
    const probe = await _probe({ runGh });
    assert.equal(probe.ok, false);
    assert.equal(probe.blocked.reason, "gh_unauth");
});

test("_probe: blocked/gh_error when one listing returns malformed JSON", async () => {
    const runGh = makeRunGh({
        [PROBE_KEYS.version]: PROBE_VERSION_OK,
        [PROBE_KEYS.auth]: PROBE_AUTH_OK,
        [PROBE_KEYS.runs]: { ok: true, stdout: "{not json", stderr: "", code: 0 },
    });
    const probe = await _probe({ runGh });
    assert.equal(probe.ok, false);
    assert.equal(probe.blocked.reason, "gh_error");
    assert.match(probe.blocked.detail, /JSON/);
});

test("_probe: success when all probes return clean empty arrays", async () => {
    const runGh = makeRunGh(ghOkEmptyMap());
    const probe = await _probe({ runGh });
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.runs, []);
    assert.deepEqual(probe.prs, []);
    assert.deepEqual(probe.issues, []);
});

// -------------------- handler (end-to-end) ---------------

test("handler: happy path — returns candidate JSON with exact schema fields, no extras", async () => {
    const issues = [{ number: 42, title: "Add foo", labels: [{ name: "bug" }], updatedAt: "x", url: "https://x", body: "" }];
    const map = ghOkEmptyMap();
    map[PROBE_KEYS.issues] = jsonOk(issues);
    const tool = createScoutTool({ runGh: makeRunGh(map) });
    const out = await tool.handler({});
    assert.equal(out.resultType, "success");
    assert.ok(typeof out.textResultForLlm === "string");
    const parsed = JSON.parse(out.textResultForLlm);
    // Schema invariant: candidate must have EXACTLY these keys, no extras.
    assert.deepEqual(
        Object.keys(parsed).sort(),
        ["acceptance", "evidence", "kind", "ref", "ref_kind", "scope_files", "title"],
    );
    assert.equal(parsed.kind, "candidate");
    assert.equal(parsed.ref_kind, "issue");
    assert.equal(parsed.ref, "42");
    assert.equal(parsed.title, "Add foo");
    assert.equal(parsed.acceptance, "Add foo");
    assert.ok(Array.isArray(parsed.scope_files));
});

test("handler: scope_files extraction from issue body picks file paths only", async () => {
    const issues = [{
        number: 1,
        title: "Bug in extension/handler.mjs",
        labels: [],
        updatedAt: "x",
        url: "https://x",
        body: "Look at extension/handler.mjs and packages/tui/src/runner.mjs near line 100. Also see README.md.",
    }];
    const map = ghOkEmptyMap();
    map[PROBE_KEYS.issues] = jsonOk(issues);
    const tool = createScoutTool({ runGh: makeRunGh(map) });
    const out = await tool.handler({});
    const parsed = JSON.parse(out.textResultForLlm);
    assert.equal(parsed.kind, "candidate");
    // Order is first-seen-in-body; deduped.
    assert.deepEqual(
        parsed.scope_files,
        ["extension/handler.mjs", "packages/tui/src/runner.mjs", "README.md"],
    );
});

test("handler: when issue list omits body, scout fetches it via `gh issue view <num> --json body`", async () => {
    // Rubber-duck fix #6: the production probe deliberately omits
    // `body` from `gh issue list` to keep the listing lightweight.
    // The picker must fetch the body for the chosen issue on-demand
    // so `scope_files` extraction actually finds the paths the issue
    // mentions.
    const issues = [{
        number: 17,
        title: "Wire telemetry",
        labels: [],
        updatedAt: "x",
        url: "https://x",
        // No body field — mirrors what the production list returns.
    }];
    const map = ghOkEmptyMap();
    map[PROBE_KEYS.issues] = jsonOk(issues);
    // Fallback `gh issue view` call returning the body. The map key
    // must match exactly — runGh.join(" ") on the args.
    map["issue view 17 --json body"] = jsonOk({
        body: "Touches extension/handler.mjs and packages/tui/src/state.mjs.",
    });
    const tool = createScoutTool({ runGh: makeRunGh(map) });
    const out = await tool.handler({});
    const parsed = JSON.parse(out.textResultForLlm);
    assert.equal(parsed.kind, "candidate");
    assert.equal(parsed.ref, "17");
    assert.deepEqual(
        parsed.scope_files,
        ["extension/handler.mjs", "packages/tui/src/state.mjs"],
    );
});

test("handler: issue body fetch failure → scope_files empty (not blocked)", async () => {
    // A failed body fetch is a soft failure: the candidate is still
    // returned, just without scope_files. The shipper can find the
    // files itself via grep / repo inspection.
    const issues = [{
        number: 99,
        title: "Something",
        labels: [],
        updatedAt: "x",
        url: "https://x",
    }];
    const map = ghOkEmptyMap();
    map[PROBE_KEYS.issues] = jsonOk(issues);
    map["issue view 99 --json body"] = { ok: false, stdout: "", stderr: "404", code: 1 };
    const tool = createScoutTool({ runGh: makeRunGh(map) });
    const out = await tool.handler({});
    const parsed = JSON.parse(out.textResultForLlm);
    assert.equal(parsed.kind, "candidate");
    assert.deepEqual(parsed.scope_files, []);
});

test("handler: no_work when every probe returns clean empty array", async () => {
    const tool = createScoutTool({ runGh: makeRunGh(ghOkEmptyMap()) });
    const out = await tool.handler({});
    const parsed = JSON.parse(out.textResultForLlm);
    assert.deepEqual(parsed, { kind: "no_work" });
    assert.equal(out.resultType, "success");
});

test("handler: blocked propagated to outer result, not collapsed to no_work", async () => {
    // PR probe rate-limits. Runs probe returned []; PRs probe failed; issues
    // never get called. The CRITICAL invariant: we must NOT silently drop
    // the failure and report `no_work`. A transient gh outage cannot end
    // the loop.
    const map = ghOkEmptyMap();
    map[PROBE_KEYS.prs] = { ok: false, stdout: "", stderr: "HTTP 429: rate limit exceeded", code: 1 };
    const tool = createScoutTool({ runGh: makeRunGh(map) });
    const out = await tool.handler({});
    const parsed = JSON.parse(out.textResultForLlm);
    assert.equal(parsed.kind, "blocked");
    assert.equal(parsed.reason, "gh_rate_limited");
    assert.notEqual(parsed.kind, "no_work");
});

test("handler: blocked schema invariant — exactly { kind, reason, detail }, no extras", async () => {
    const map = ghOkEmptyMap();
    map[PROBE_KEYS.runs] = { ok: false, stdout: "", stderr: "boom", code: 5 };
    const tool = createScoutTool({ runGh: makeRunGh(map) });
    const out = await tool.handler({});
    const parsed = JSON.parse(out.textResultForLlm);
    assert.deepEqual(
        Object.keys(parsed).sort(),
        ["detail", "kind", "reason"],
    );
    assert.equal(parsed.kind, "blocked");
});

test("handler: rejects unexpected arguments (additionalProperties:false enforcement)", async () => {
    const tool = createScoutTool({ runGh: makeRunGh(ghOkEmptyMap()) });
    const out = await tool.handler({ unexpected: 1 });
    assert.equal(out.resultType, "failure");
    assert.match(out.textResultForLlm, /takes no arguments/);
});

test("handler: empty args object is fine", async () => {
    const tool = createScoutTool({ runGh: makeRunGh(ghOkEmptyMap()) });
    const out = await tool.handler({});
    assert.equal(out.resultType, "success");
});

test("createScoutTool: exposes definition matching SDK Tool shape (name, description, parameters)", () => {
    const tool = createScoutTool({ runGh: async () => ({ ok: true, stdout: "[]", stderr: "", code: 0 }) });
    assert.equal(tool.definition.name, SCOUT_TOOL_NAME);
    assert.equal(tool.definition.name, "autopilot_scout");
    assert.equal(typeof tool.definition.description, "string");
    assert.ok(tool.definition.description.length > 20);
    assert.equal(tool.definition.parameters.type, "object");
    assert.deepEqual(tool.definition.parameters.properties, {});
    assert.equal(tool.definition.parameters.additionalProperties, false);
    assert.equal(typeof tool.handler, "function");
});

test("handler: CI failure candidate includes evidence (raw gh JSON)", async () => {
    const run = {
        databaseId: 12345, headBranch: "feat/x", event: "push", conclusion: "failure",
        createdAt: "2026-01-01T00:00:00Z", name: "Test suite", url: "https://example/run/12345",
    };
    const map = ghOkEmptyMap();
    map[PROBE_KEYS.runs] = jsonOk([run]);
    // run view --log-failed returns text — extract paths from it.
    map["run view 12345 --log-failed"] = {
        ok: true,
        stdout: "FAIL test/foo.test.mjs > some test\n  at extension/handler.mjs:42:1\n",
        stderr: "",
        code: 0,
    };
    const tool = createScoutTool({ runGh: makeRunGh(map) });
    const out = await tool.handler({});
    const parsed = JSON.parse(out.textResultForLlm);
    assert.equal(parsed.kind, "candidate");
    assert.equal(parsed.ref_kind, "ci_failure");
    assert.equal(parsed.ref, "12345");
    assert.deepEqual(parsed.evidence, run);
    assert.deepEqual(parsed.scope_files, ["test/foo.test.mjs", "extension/handler.mjs"]);
});

test("handler: PR candidate scope_files comes from `gh pr view --json files`", async () => {
    const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const pr = {
        number: 77, title: "Old PR", headRefName: "f", mergeable: "MERGEABLE",
        statusCheckRollup: [], updatedAt: oldIso, url: "https://x",
    };
    const map = ghOkEmptyMap();
    map[PROBE_KEYS.prs] = jsonOk([pr]);
    map["pr view 77 --json files"] = jsonOk({
        files: [{ path: "extension/handler.mjs" }, { path: "test/foo.test.mjs" }],
    });
    const tool = createScoutTool({ runGh: makeRunGh(map) });
    const out = await tool.handler({});
    const parsed = JSON.parse(out.textResultForLlm);
    assert.equal(parsed.kind, "candidate");
    assert.equal(parsed.ref_kind, "pr");
    assert.equal(parsed.ref, "77");
    assert.deepEqual(parsed.scope_files, ["extension/handler.mjs", "test/foo.test.mjs"]);
});
