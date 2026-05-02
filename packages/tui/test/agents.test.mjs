// Tests for the per-agent backend adapters under
// `packages/tui/src/agents/` (issue #83).
//
// Each adapter exports a tiny three-function surface:
//   - `spawnArgs(prompt, opts) → { args, env }`
//   - `parseStream(stdoutLines) → events[]`
//   - `extractUsage(events) → { input, output, premiumRequests }`
//
// Plus metadata: `name`, `defaultBin`, `binEnvVar`, and a
// `resolveBin({ override, env, stderr })` helper for the binary
// precedence chain (test-injectable env / stderr).
//
// All tests are stdlib `node:test` — no extra deps.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as copilot from "../src/agents/copilot.mjs";
import * as claude from "../src/agents/claude.mjs";

// ─── Adapter-shape symmetry guard ──────────────────────────────────
//
// Pin the "all adapters share the same exported names" contract so a
// future adapter can be wired into the runner with confidence — and
// so a typo (e.g. exporting `parseStreamLines` instead of
// `parseStream`) surfaces in CI rather than silently breaking the
// dispatch. Each adapter MUST export the four metadata fields plus
// the three function helpers, all with the documented types.
test("agents: every adapter exports the documented surface (name / defaultBin / binEnvVar / spawnArgs / parseStream / extractUsage)", () => {
    for (const adapter of [copilot, claude]) {
        assert.equal(typeof adapter.name, "string", "name must be a string");
        assert.ok(adapter.name.length > 0, "name must be non-empty");
        assert.equal(typeof adapter.defaultBin, "string", "defaultBin must be a string");
        assert.ok(adapter.defaultBin.length > 0, "defaultBin must be non-empty");
        assert.equal(typeof adapter.binEnvVar, "string", "binEnvVar must be a string");
        assert.ok(adapter.binEnvVar.startsWith("AUTOPILOT_"), `binEnvVar must follow the AUTOPILOT_* convention; got ${adapter.binEnvVar}`);
        assert.equal(typeof adapter.spawnArgs, "function", "spawnArgs must be a function");
        assert.equal(typeof adapter.parseStream, "function", "parseStream must be a function");
        assert.equal(typeof adapter.extractUsage, "function", "extractUsage must be a function");
        assert.equal(typeof adapter.resolveBin, "function", "resolveBin must be a function");
    }
});

// ─── Copilot adapter ───────────────────────────────────────────────

test("copilot.spawnArgs: bare prompt produces canonical --allow-all-tools / --output-format json argv", () => {
    const { args, env } = copilot.spawnArgs("Do the thing", {});
    assert.deepEqual(args, ["-p", "Do the thing", "--allow-all-tools", "--output-format", "json"]);
    // No env override expected — Copilot reads its config from $HOME/.copilot.
    assert.equal(env, undefined);
});

test("copilot.spawnArgs: sessionName produces -n <name> for iter 1 of --continue mode", () => {
    const { args } = copilot.spawnArgs("X", { sessionName: "my-run-1" });
    // Order is: ... -n my-run-1 (after the canonical preamble)
    assert.ok(args.includes("-n"), "expected -n flag");
    const i = args.indexOf("-n");
    assert.equal(args[i + 1], "my-run-1");
});

test("copilot.spawnArgs: resumeSessionId produces --resume=<id> and skips -n", () => {
    const { args } = copilot.spawnArgs("X", { sessionName: "ignored", resumeSessionId: "sess-123" });
    assert.ok(args.includes("--resume=sess-123"), "expected --resume=sess-123");
    assert.ok(!args.includes("-n"), "must not emit -n when resuming an existing session");
});

test("copilot.spawnArgs: extraArgs are appended verbatim after the canonical args", () => {
    const { args } = copilot.spawnArgs("X", { extraArgs: ["--debug", "--foo=bar"] });
    assert.equal(args[args.length - 2], "--debug");
    assert.equal(args[args.length - 1], "--foo=bar");
});

test("copilot.parseStream: parses one JSON object per line, drops blanks and malformed lines", () => {
    const lines = [
        JSON.stringify({ type: "assistant.message", data: { content: "hi", outputTokens: 10 } }),
        "",
        "this is not json",
        JSON.stringify({ type: "result", success: true, result: { sessionId: "s-1" }, usage: { premiumRequests: 2 } }),
    ];
    const events = copilot.parseStream(lines);
    assert.equal(events.length, 2, "two parseable lines");
    assert.equal(events[0].type, "assistant.message");
    assert.equal(events[1].type, "result");
});

test("copilot.parseStream: accepts a single concatenated string (split on \\n)", () => {
    const raw = `{"type":"assistant.message","data":{"content":"a"}}
{"type":"result","success":true}
`;
    const events = copilot.parseStream(raw);
    assert.equal(events.length, 2);
});

test("copilot.extractUsage: sums root-agent outputTokens and reads premiumRequests from terminal result", () => {
    const events = [
        { type: "assistant.message", data: { content: "a", outputTokens: 100 } },
        { type: "assistant.message", agentId: "explore", data: { content: "sub", outputTokens: 9999 } },
        { type: "assistant.message", data: { content: "b", outputTokens: 50 } },
        { type: "result", success: true, usage: { premiumRequests: 3 } },
    ];
    const u = copilot.extractUsage(events);
    assert.equal(u.input, null, "Copilot CLI does not surface input tokens — input must be null");
    assert.equal(u.output, 150, "sub-agent outputTokens excluded; root sums 100 + 50");
    assert.equal(u.premiumRequests, 3);
});

test("copilot.extractUsage: empty stream returns the zero rollup with null premiumRequests", () => {
    assert.deepEqual(copilot.extractUsage([]), { input: null, output: 0, premiumRequests: null });
});

test("copilot.extractUsage: skips malformed outputTokens (NaN, negative, non-numeric)", () => {
    const events = [
        { type: "assistant.message", data: { content: "a", outputTokens: 100 } },
        { type: "assistant.message", data: { content: "b", outputTokens: Number.NaN } },
        { type: "assistant.message", data: { content: "c", outputTokens: -50 } },
        { type: "assistant.message", data: { content: "d", outputTokens: "200" } },
        { type: "assistant.message", data: { content: "e", outputTokens: 30 } },
    ];
    assert.equal(copilot.extractUsage(events).output, 130);
});

test("copilot.resolveBin: precedence is override > AUTOPILOT_COPILOT_BIN > legacy > defaultBin", () => {
    copilot.__resetDeprecationGuard();
    const sink = { written: "", write(s) { this.written += String(s); } };

    // 1. Default — no env, no override.
    assert.equal(copilot.resolveBin({ env: {}, stderr: sink }), "copilot");

    // 2. Legacy env wins over default and emits a one-shot deprecation notice.
    copilot.__resetDeprecationGuard();
    sink.written = "";
    assert.equal(
        copilot.resolveBin({ env: { RALPH_TUI_COPILOT_BIN: "/legacy/bin" }, stderr: sink }),
        "/legacy/bin",
    );
    assert.match(sink.written, /RALPH_TUI_COPILOT_BIN is deprecated/);

    // 3. New env wins over legacy.
    copilot.__resetDeprecationGuard();
    assert.equal(
        copilot.resolveBin({
            env: { RALPH_TUI_COPILOT_BIN: "/legacy/bin", AUTOPILOT_COPILOT_BIN: "/new/bin" },
            stderr: { write() {} },
        }),
        "/new/bin",
    );

    // 4. Caller-supplied override wins over everything.
    copilot.__resetDeprecationGuard();
    assert.equal(
        copilot.resolveBin({
            override: "/explicit/bin",
            env: { RALPH_TUI_COPILOT_BIN: "/legacy/bin", AUTOPILOT_COPILOT_BIN: "/new/bin" },
            stderr: { write() {} },
        }),
        "/explicit/bin",
    );
});

test("copilot.resolveBin: legacy deprecation notice fires only once across multiple calls", () => {
    copilot.__resetDeprecationGuard();
    const sink = { written: "", write(s) { this.written += String(s); } };
    const env = { RALPH_TUI_COPILOT_BIN: "/legacy/bin" };
    copilot.resolveBin({ env, stderr: sink });
    copilot.resolveBin({ env, stderr: sink });
    copilot.resolveBin({ env, stderr: sink });
    const matches = sink.written.match(/RALPH_TUI_COPILOT_BIN is deprecated/g) ?? [];
    assert.equal(matches.length, 1, "deprecation notice must be one-shot, not per-call");
});

// ─── Claude adapter ────────────────────────────────────────────────

test("claude.spawnArgs: bare prompt produces canonical --dangerously-skip-permissions / --output-format stream-json / --verbose argv", () => {
    const { args, env } = claude.spawnArgs("Do the thing", {});
    assert.deepEqual(
        args,
        ["-p", "Do the thing", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"],
    );
    assert.equal(env, undefined);
});

test("claude.spawnArgs: resumeSessionId produces --resume <uuid> (space-separated, not =)", () => {
    const { args } = claude.spawnArgs("X", { resumeSessionId: "uuid-abc-123" });
    const i = args.indexOf("--resume");
    assert.ok(i >= 0, "must include --resume");
    assert.equal(args[i + 1], "uuid-abc-123");
});

test("claude.spawnArgs: sessionName is intentionally ignored (Claude has no -n equivalent)", () => {
    const { args } = claude.spawnArgs("X", { sessionName: "should-be-dropped" });
    assert.ok(!args.includes("-n"), "Claude has no session-name flag — sessionName must be ignored");
    assert.ok(!args.includes("should-be-dropped"));
});

test("claude.spawnArgs: extraArgs are appended after the canonical preamble", () => {
    const { args } = claude.spawnArgs("X", { extraArgs: ["--mcp-config", "./mcp.json"] });
    const i = args.indexOf("--mcp-config");
    assert.ok(i >= 0, "extraArgs must be present");
    assert.equal(args[i + 1], "./mcp.json");
});

test("claude.parseStream: handles NDJSON input as either an array of lines or a single string", () => {
    const lines = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "uuid-1" }),
        JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
        "",
        "garbage",
        JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 50 } }),
    ];
    const events = claude.parseStream(lines);
    assert.equal(events.length, 3);
    assert.equal(events[0].type, "system");
    assert.equal(events[1].type, "assistant");
    assert.equal(events[2].type, "result");

    const raw = lines.join("\n");
    const events2 = claude.parseStream(raw);
    assert.deepEqual(events.map(e => e.type), events2.map(e => e.type));
});

test("claude.extractUsage: prefers terminal result.usage totals when present", () => {
    const events = [
        { type: "assistant", message: { usage: { input_tokens: 50, output_tokens: 25 } } },
        { type: "assistant", message: { usage: { input_tokens: 50, output_tokens: 25 } } },
        // Terminal totals supersede the per-message deltas.
        { type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 60 } },
    ];
    const u = claude.extractUsage(events);
    assert.equal(u.input, 100);
    assert.equal(u.output, 60);
    assert.equal(u.premiumRequests, null, "Claude does not expose premiumRequests — must collapse to null");
});

test("claude.extractUsage: falls back to per-message deltas when no terminal result is present", () => {
    const events = [
        { type: "assistant", message: { usage: { input_tokens: 30, output_tokens: 15 } } },
        { type: "assistant", message: { usage: { input_tokens: 20, output_tokens: 10 } } },
    ];
    const u = claude.extractUsage(events);
    assert.equal(u.input, 50, "should sum per-message input deltas");
    assert.equal(u.output, 25, "should sum per-message output deltas");
    assert.equal(u.premiumRequests, null);
});

test("claude.extractUsage: empty stream returns null input + zero output (no falsy data)", () => {
    const u = claude.extractUsage([]);
    assert.equal(u.input, null, "empty stream → input null (no data, not zero)");
    assert.equal(u.output, 0);
    assert.equal(u.premiumRequests, null);
});

test("claude.extractUsage: skips malformed usage values (NaN, negative, non-numeric)", () => {
    const events = [
        { type: "assistant", message: { usage: { input_tokens: 50, output_tokens: 25 } } },
        { type: "assistant", message: { usage: { input_tokens: Number.NaN, output_tokens: -10 } } },
        { type: "assistant", message: { usage: { input_tokens: "100", output_tokens: 30 } } },
        { type: "assistant", message: { usage: { input_tokens: 20, output_tokens: 5 } } },
    ];
    const u = claude.extractUsage(events);
    // input: 50 + 20 = 70 ("100" is a string and rejected; NaN is rejected)
    // output: 25 + 30 + 5 = 60 (-10 is rejected; 30 stays because the input pair was rejected
    //                            but each token field is checked independently)
    assert.equal(u.input, 70);
    assert.equal(u.output, 60);
});

test("claude.resolveBin: precedence is override > AUTOPILOT_CLAUDE_BIN > defaultBin (no legacy fallback)", () => {
    assert.equal(claude.resolveBin({ env: {} }), "claude");
    assert.equal(claude.resolveBin({ env: { AUTOPILOT_CLAUDE_BIN: "/usr/local/bin/claude-2.5" } }), "/usr/local/bin/claude-2.5");
    assert.equal(claude.resolveBin({
        override: "/explicit/path",
        env: { AUTOPILOT_CLAUDE_BIN: "/usr/local/bin/claude-2.5" },
    }), "/explicit/path");
    // Critically: the Copilot legacy env-var must NOT leak into the Claude adapter.
    assert.equal(
        claude.resolveBin({ env: { RALPH_TUI_COPILOT_BIN: "/should/not/appear" } }),
        "claude",
        "Claude adapter must ignore Copilot's legacy env var",
    );
});

// ─── Adapter metadata ──────────────────────────────────────────────

test("agent metadata: copilot adapter has the documented name + binEnvVar", () => {
    assert.equal(copilot.name, "copilot");
    assert.equal(copilot.defaultBin, "copilot");
    assert.equal(copilot.binEnvVar, "AUTOPILOT_COPILOT_BIN");
});

test("agent metadata: claude adapter has the documented name + binEnvVar", () => {
    assert.equal(claude.name, "claude");
    assert.equal(claude.defaultBin, "claude");
    assert.equal(claude.binEnvVar, "AUTOPILOT_CLAUDE_BIN");
});

// ─── Copilot CLI version probe (issue #105) ────────────────────────
//
// The runner spawns `copilot -p ... --output-format json`; older
// 0.0.x builds reject the `--output-format` flag with a confusing
// "unknown option" error. The adapter exports a small probe (parse,
// compare, check, describe) so `cmdRun` and `cmdDoctor` can surface
// a clear upgrade hint up-front. Helpers are pure where possible
// and the I/O-bearing `checkCliVersion` accepts an injected
// `exec`/`env`/`stderr` for the test seam.

test("copilot.parseCliVersion: extracts the M.m.p triple from the documented Copilot CLI banner", () => {
    assert.deepEqual(copilot.parseCliVersion("GitHub Copilot CLI 1.0.40."), [1, 0, 40]);
    assert.deepEqual(copilot.parseCliVersion("GitHub Copilot CLI 1.0.40\n"), [1, 0, 40]);
    assert.deepEqual(copilot.parseCliVersion("0.0.354"), [0, 0, 354]);
    assert.deepEqual(copilot.parseCliVersion("v2.13.7-beta.1"), [2, 13, 7]);
});

test("copilot.parseCliVersion: returns null for non-string / un-parseable input", () => {
    assert.equal(copilot.parseCliVersion(null), null);
    assert.equal(copilot.parseCliVersion(undefined), null);
    assert.equal(copilot.parseCliVersion(42), null);
    assert.equal(copilot.parseCliVersion(""), null);
    assert.equal(copilot.parseCliVersion("no version here"), null);
    assert.equal(copilot.parseCliVersion("1.2"), null); // need three components
});

test("copilot.compareCliVersion: orders triples lexicographically and throws on bad input", () => {
    assert.equal(copilot.compareCliVersion([1, 0, 0], [0, 9, 99]), 1);
    assert.equal(copilot.compareCliVersion([0, 9, 99], [1, 0, 0]), -1);
    assert.equal(copilot.compareCliVersion([1, 2, 3], [1, 2, 3]), 0);
    assert.equal(copilot.compareCliVersion([1, 0, 40], [1, 0, 0]), 1);
    assert.equal(copilot.compareCliVersion([0, 0, 354], [1, 0, 0]), -1);
    assert.throws(() => copilot.compareCliVersion(null, [1, 0, 0]), TypeError);
    assert.throws(() => copilot.compareCliVersion([1, 0, 0], "1.0.0"), TypeError);
    assert.throws(() => copilot.compareCliVersion([1, 0], [1, 0, 0]), TypeError);
});

test("copilot.checkCliVersion: ok path returns the parsed triple + raw banner", () => {
    const r = copilot.checkCliVersion({
        bin: "/fake/copilot",
        exec: () => ({ ok: true, stdout: "GitHub Copilot CLI 1.0.40.\n" }),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.version, [1, 0, 40]);
    assert.equal(r.bin, "/fake/copilot");
    assert.equal(r.raw, "GitHub Copilot CLI 1.0.40.");
});

test("copilot.checkCliVersion: too-old version reports the floor and the actual triple", () => {
    const r = copilot.checkCliVersion({
        bin: "/fake/copilot",
        exec: () => ({ ok: true, stdout: "GitHub Copilot CLI 0.0.354.\n" }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "too-old");
    assert.deepEqual(r.version, [0, 0, 354]);
    assert.deepEqual(r.min, [1, 0, 0]);
});

test("copilot.checkCliVersion: missing binary surfaces reason='missing' (ENOENT)", () => {
    const err = Object.assign(new Error("spawn /no/such ENOENT"), { code: "ENOENT" });
    const r = copilot.checkCliVersion({
        bin: "/no/such/copilot",
        exec: () => ({ ok: false, reason: "missing", error: err }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing");
    assert.equal(r.bin, "/no/such/copilot");
});

test("copilot.checkCliVersion: spawn failure (non-ENOENT) surfaces reason='exec-failed'", () => {
    const r = copilot.checkCliVersion({
        bin: "/fake/copilot",
        exec: () => ({ ok: false, reason: "exec-failed", stderr: "permission denied", status: 126 }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "exec-failed");
    assert.equal(r.stderr, "permission denied");
    assert.equal(r.status, 126);
});

test("copilot.checkCliVersion: unparseable output surfaces reason='unparseable' with the raw text", () => {
    const r = copilot.checkCliVersion({
        bin: "/fake/copilot",
        exec: () => ({ ok: true, stdout: "Copilot CLI nightly-build\n" }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unparseable");
    assert.equal(r.raw, "Copilot CLI nightly-build");
});

test("copilot.checkCliVersion: resolves bin via resolveBin when not passed explicitly", () => {
    let observedBin = null;
    const r = copilot.checkCliVersion({
        env: { AUTOPILOT_COPILOT_BIN: "/from/env/copilot" },
        exec: (bin) => { observedBin = bin; return { ok: true, stdout: "1.0.0\n" }; },
        stderr: { write: () => true },
    });
    assert.equal(observedBin, "/from/env/copilot");
    assert.equal(r.ok, true);
    assert.equal(r.bin, "/from/env/copilot");
});

test("copilot.describeCliVersionResult: composes a one-line summary for each branch", () => {
    assert.match(
        copilot.describeCliVersionResult({ ok: true, version: [1, 0, 40], bin: "/fake/copilot", raw: "1.0.40" }),
        /copilot CLI: 1\.0\.40 \(>= 1\.0\.0, ok\)/,
    );
    assert.match(
        copilot.describeCliVersionResult({ ok: false, reason: "too-old", version: [0, 0, 354], min: [1, 0, 0], bin: "/fake/copilot", raw: "0.0.354" }),
        /copilot CLI: 0\.0\.354 is older than 1\.0\.0.*issue #105/,
    );
    assert.match(
        copilot.describeCliVersionResult({ ok: false, reason: "missing", bin: "/no/such/copilot" }),
        /copilot CLI: not found at \/no\/such\/copilot.*npm i -g @github\/copilot/,
    );
    assert.match(
        copilot.describeCliVersionResult({ ok: false, reason: "exec-failed", bin: "/fake/copilot", error: new Error("boom"), status: 1 }),
        /copilot CLI: `\/fake\/copilot --version` failed \(boom\)/,
    );
    assert.match(
        copilot.describeCliVersionResult({ ok: false, reason: "unparseable", bin: "/fake/copilot", raw: "weird build string" }),
        /copilot CLI: at \/fake\/copilot but `--version` output is unrecognised/,
    );
    assert.match(
        copilot.describeCliVersionResult(null),
        /copilot CLI: unknown/,
    );
});

test("copilot.MIN_KNOWN_GOOD_CLI_VERSION: pinned at 1.0.0 (issue #105)", () => {
    assert.equal(copilot.MIN_KNOWN_GOOD_CLI_VERSION, "1.0.0");
});
