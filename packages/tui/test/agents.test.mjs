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

test("claude.spawnArgs: bare prompt produces canonical --dangerously-skip-permissions / --output-format stream-json argv", () => {
    const { args, env } = claude.spawnArgs("Do the thing", {});
    assert.deepEqual(
        args,
        ["-p", "Do the thing", "--dangerously-skip-permissions", "--output-format", "stream-json"],
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
