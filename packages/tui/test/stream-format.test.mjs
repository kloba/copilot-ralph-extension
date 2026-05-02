import { test } from "node:test";
import assert from "node:assert/strict";

import { formatSessionEvent, argsSummaryFor } from "../src/stream-format.mjs";

// ---------------------------------------------------------------------------
// formatSessionEvent — defensive contract first, then per-type rendering.
// ---------------------------------------------------------------------------

test("formatSessionEvent: returns [] for null / undefined / non-object", () => {
    assert.deepEqual(formatSessionEvent(null), []);
    assert.deepEqual(formatSessionEvent(undefined), []);
    assert.deepEqual(formatSessionEvent("not an event"), []);
    assert.deepEqual(formatSessionEvent(42), []);
});

test("formatSessionEvent: returns [] for missing type", () => {
    assert.deepEqual(formatSessionEvent({ data: { content: "x" } }), []);
});

test("formatSessionEvent: returns [] for missing data", () => {
    assert.deepEqual(formatSessionEvent({ type: "assistant.message" }), []);
});

test("formatSessionEvent: suppresses turn boundaries / user prompts / session housekeeping", () => {
    for (const t of [
        "assistant.turn_start",
        "assistant.turn_end",
        "user.message",
        "session.start",
        "session.info",
        "session.truncation",
        "session.end",
        "session.checkpoint",
    ]) {
        assert.deepEqual(
            formatSessionEvent({ type: t, data: { content: "anything" } }),
            [],
            `${t} should be suppressed`,
        );
    }
});

test("formatSessionEvent: unknown event types are dropped (forward-compat)", () => {
    // The Copilot CLI may emit new event types in future releases; the
    // formatter must NOT throw and must NOT surface them as raw lines.
    assert.deepEqual(
        formatSessionEvent({ type: "future.event.type", data: { foo: "bar" } }),
        [],
    );
});

// ---------------------------------------------------------------------------
// assistant.message — text rendering.
// ---------------------------------------------------------------------------

test("formatSessionEvent: assistant.message yields one line per non-empty content line", () => {
    const out = formatSessionEvent({
        type: "assistant.message",
        data: { content: "first line\nsecond line\nthird" },
    });
    assert.deepEqual(out, [
        { kind: "text", line: "first line" },
        { kind: "text", line: "second line" },
        { kind: "text", line: "third" },
    ]);
});

test("formatSessionEvent: assistant.message drops blank / whitespace-only lines", () => {
    const out = formatSessionEvent({
        type: "assistant.message",
        data: { content: "first\n\n   \nsecond\n" },
    });
    assert.deepEqual(out.map((e) => e.line), ["first", "second"]);
});

test("formatSessionEvent: assistant.message with empty content returns []", () => {
    assert.deepEqual(formatSessionEvent({ type: "assistant.message", data: { content: "" } }), []);
    assert.deepEqual(formatSessionEvent({ type: "assistant.message", data: { content: "   \n  " } }), []);
});

test("formatSessionEvent: assistant.message clips long lines (240 chars)", () => {
    const long = "x".repeat(500);
    const out = formatSessionEvent({
        type: "assistant.message",
        data: { content: long },
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].line.length, 240);
});

test("formatSessionEvent: assistant.message tolerates non-string content", () => {
    assert.deepEqual(
        formatSessionEvent({ type: "assistant.message", data: { content: 42 } }),
        [],
    );
    assert.deepEqual(
        formatSessionEvent({ type: "assistant.message", data: { content: null } }),
        [],
    );
});

// ---------------------------------------------------------------------------
// tool.execution_start — `→ tool(args)` rendering.
// ---------------------------------------------------------------------------

test("formatSessionEvent: tool.execution_start with no args renders `→ name()`", () => {
    const out = formatSessionEvent({
        type: "tool.execution_start",
        data: { toolName: "report_intent", arguments: {} },
    });
    assert.deepEqual(out, [{ kind: "tool_start", line: "→ report_intent()" }]);
});

test("formatSessionEvent: tool.execution_start uses per-tool argument hint", () => {
    const cases = [
        { toolName: "bash", arguments: { command: "npm test" }, expect: "bash(npm test)" },
        { toolName: "view", arguments: { path: "/x.mjs" }, expect: "view(/x.mjs)" },
        { toolName: "grep", arguments: { pattern: "FOO" }, expect: "grep(FOO)" },
        { toolName: "edit", arguments: { path: "src/a.mjs" }, expect: "edit(src/a.mjs)" },
        { toolName: "report_intent", arguments: { intent: "Doing thing" }, expect: "report_intent(Doing thing)" },
        { toolName: "web_fetch", arguments: { url: "https://x.com" }, expect: "web_fetch(https://x.com)" },
        { toolName: "web_search", arguments: { query: "claude opus 4.6" }, expect: "web_search(claude opus 4.6)" },
    ];
    for (const c of cases) {
        const out = formatSessionEvent({
            type: "tool.execution_start",
            data: { toolName: c.toolName, arguments: c.arguments },
        });
        assert.deepEqual(out, [{ kind: "tool_start", line: `→ ${c.expect}` }], `tool=${c.toolName}`);
    }
});

test("formatSessionEvent: tool.execution_start unknown tool falls back to first string arg", () => {
    const out = formatSessionEvent({
        type: "tool.execution_start",
        data: {
            toolName: "some-unknown-tool",
            arguments: { irrelevant_int: 42, useful_text: "Hello world", _other: "x" },
        },
    });
    assert.deepEqual(out, [
        { kind: "tool_start", line: "→ some-unknown-tool(Hello world)" },
    ]);
});

test("formatSessionEvent: tool.execution_start collapses whitespace in args", () => {
    const out = formatSessionEvent({
        type: "tool.execution_start",
        data: { toolName: "bash", arguments: { command: "npm test\n  --verbose\n" } },
    });
    assert.deepEqual(out, [{ kind: "tool_start", line: "→ bash(npm test --verbose)" }]);
});

test("formatSessionEvent: tool.execution_start clips long args to 60 chars", () => {
    const out = formatSessionEvent({
        type: "tool.execution_start",
        data: { toolName: "bash", arguments: { command: "x".repeat(500) } },
    });
    // 60 chars of args + 8 chars of "→ bash(" + 1 char of ")" = 69 visible chars
    assert.equal(out.length, 1);
    assert.match(out[0].line, /^→ bash\(x{60}\)$/);
});

test("formatSessionEvent: tool.execution_start handles missing toolName", () => {
    const out = formatSessionEvent({
        type: "tool.execution_start",
        data: { arguments: { command: "x" } },
    });
    assert.deepEqual(out, [{ kind: "tool_start", line: "→ (unknown)(x)" }]);
});

test("formatSessionEvent: tool.execution_start with no args field renders `→ name()`", () => {
    const out = formatSessionEvent({
        type: "tool.execution_start",
        data: { toolName: "bash" },
    });
    assert.deepEqual(out, [{ kind: "tool_start", line: "→ bash()" }]);
});

// ---------------------------------------------------------------------------
// tool.execution_complete — `← ok` / `← FAIL` rendering.
// ---------------------------------------------------------------------------

test("formatSessionEvent: tool.execution_complete success with content yields `← ok: <preview>`", () => {
    const out = formatSessionEvent({
        type: "tool.execution_complete",
        data: { success: true, result: { content: "Searching web for Opus 4.6" } },
    });
    assert.deepEqual(out, [
        { kind: "tool_ok", line: "← ok: Searching web for Opus 4.6" },
    ]);
});

test("formatSessionEvent: tool.execution_complete success with no content yields bare `← ok`", () => {
    const out = formatSessionEvent({
        type: "tool.execution_complete",
        data: { success: true, result: {} },
    });
    assert.deepEqual(out, [{ kind: "tool_ok", line: "← ok" }]);
});

test("formatSessionEvent: tool.execution_complete success collapses + clips multi-line output", () => {
    const out = formatSessionEvent({
        type: "tool.execution_complete",
        data: { success: true, result: { content: "x".repeat(200) + "\nmore" } },
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "tool_ok");
    // 80-char preview cap.
    assert.equal(out[0].line.length, "← ok: ".length + 80);
});

test("formatSessionEvent: tool.execution_complete failure renders `← FAIL:` with error message", () => {
    const out = formatSessionEvent({
        type: "tool.execution_complete",
        data: { success: false, error: { message: "command not found: foo" } },
    });
    assert.deepEqual(out, [
        { kind: "tool_fail", line: "← FAIL: command not found: foo" },
    ]);
});

test("formatSessionEvent: tool.execution_complete failure with string error", () => {
    const out = formatSessionEvent({
        type: "tool.execution_complete",
        data: { success: false, error: "boom" },
    });
    assert.deepEqual(out, [{ kind: "tool_fail", line: "← FAIL: boom" }]);
});

test("formatSessionEvent: tool.execution_complete failure falls back to result.content when no error", () => {
    const out = formatSessionEvent({
        type: "tool.execution_complete",
        data: { success: false, result: { content: "stderr-as-result" } },
    });
    assert.deepEqual(out, [{ kind: "tool_fail", line: "← FAIL: stderr-as-result" }]);
});

test("formatSessionEvent: tool.execution_complete failure with no error info shows placeholder", () => {
    const out = formatSessionEvent({
        type: "tool.execution_complete",
        data: { success: false },
    });
    assert.deepEqual(out, [{ kind: "tool_fail", line: "← FAIL: (no error message)" }]);
});

// ---------------------------------------------------------------------------
// argsSummaryFor — direct tests for the heuristic.
// ---------------------------------------------------------------------------

test("argsSummaryFor: returns '' for null / non-object args", () => {
    assert.equal(argsSummaryFor("bash", null), "");
    assert.equal(argsSummaryFor("bash", undefined), "");
    assert.equal(argsSummaryFor("bash", "string-args"), "");
    assert.equal(argsSummaryFor("bash", 42), "");
});

test("argsSummaryFor: returns '' when no string fields", () => {
    assert.equal(argsSummaryFor("unknown", { a: true, b: null, c: {} }), "");
});

test("argsSummaryFor: numbers usable in fallback path", () => {
    // Some tools take a single numeric arg (e.g. issue_number). The
    // fallback should surface it rather than render an empty paren-pair.
    assert.equal(
        argsSummaryFor("github_get_issue", { issue_number: 57 }),
        "57",
    );
});

test("argsSummaryFor: surrogate-safe truncation (uses safeSliceChars)", () => {
    // 100 emoji = 200 UTF-16 code units; capping at 60 chars must not
    // split a surrogate pair. safeSliceChars handles this — we just
    // confirm length stays bounded and the string is still valid utf16.
    const summary = argsSummaryFor("bash", { command: "🚀".repeat(100) });
    assert.ok(summary.length <= 60);
    // No lone surrogates: every code unit must be inside a pair.
    for (let i = 0; i < summary.length; i++) {
        const c = summary.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            // Hi surrogate must be followed by a lo surrogate.
            const next = summary.charCodeAt(i + 1);
            assert.ok(next >= 0xDC00 && next <= 0xDFFF, `lone hi surrogate at ${i}`);
            i++;
        } else if (c >= 0xDC00 && c <= 0xDFFF) {
            assert.fail(`lone lo surrogate at ${i}`);
        }
    }
});

test("argsSummaryFor: hint that throws falls back to generic", () => {
    // If a per-tool hint accessor crashes (e.g. unexpected nesting),
    // the function must not throw — it falls back to the generic
    // first-string scan. We verify by registering a synthetic case
    // through the arguments shape: pretend the hint blew up by
    // passing args with a `command` getter that throws, then check
    // the fallback finds `other_field`.
    const args = {
        get command() { throw new Error("nope"); },
        other_field: "fallback worked",
    };
    assert.equal(argsSummaryFor("bash", args), "fallback worked");
});
