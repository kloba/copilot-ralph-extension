// Tests for state-file reader (packages/tui/src/state.mjs).
//
// Pinned drift guard: RESULT_TOKEN_RE in this module MUST stay
// byte-identical to RESULT_TOKEN_RE in extension/handler.mjs. The
// loop driver only emits one token shape and the TUI must never
// drift away from that shape — duplicated text beats a cross-
// package import that drags handler.mjs into the TUI's runtime.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { tryReadState, defaultStatePath, RESULT_TOKEN_RE } from "../src/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const HANDLER_PATH = join(REPO_ROOT, "extension", "handler.mjs");

function withTmp(fn) {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-tui-state-"));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("tryReadState: returns null when file is missing", () => {
    withTmp((dir) => {
        const path = join(dir, "missing.json");
        assert.equal(tryReadState({ path }), null);
    });
});

test("tryReadState: returns null when file is corrupt JSON", () => {
    withTmp((dir) => {
        const path = join(dir, "state.json");
        writeFileSync(path, "{not json", "utf8");
        assert.equal(tryReadState({ path }), null);
    });
});

test("tryReadState: returns null for non-object JSON (array)", () => {
    withTmp((dir) => {
        const path = join(dir, "state.json");
        writeFileSync(path, "[1, 2, 3]", "utf8");
        assert.equal(tryReadState({ path }), null);
    });
});

test("tryReadState: returns null for non-object JSON (string)", () => {
    withTmp((dir) => {
        const path = join(dir, "state.json");
        writeFileSync(path, "\"hello\"", "utf8");
        assert.equal(tryReadState({ path }), null);
    });
});

test("tryReadState: returns parsed snapshot for a typical mid-run file", () => {
    withTmp((dir) => {
        const path = join(dir, "state.json");
        const snap = {
            armed: true,
            iter: 3,
            max_iters: 200,
            scout_streak_no_work: 0,
            shipper_streak_blocked: 1,
            last_iter_outcome: { outcome: "shipped", sha: "abc1234" },
            started_at: 1700000000000,
            version: "0.7.0",
            history: [],
        };
        writeFileSync(path, JSON.stringify(snap), "utf8");
        assert.deepEqual(tryReadState({ path }), snap);
    });
});

test("defaultStatePath: ends with the documented suffix under HOME", () => {
    const p = defaultStatePath();
    assert.ok(typeof p === "string" && p.length > 0);
    assert.ok(p.endsWith(join(".copilot", "autopilot", "state.json")),
        `expected default path to end with .copilot/autopilot/state.json, got ${p}`);
});

test("RESULT_TOKEN_RE: matches the canonical token shapes the extension emits", () => {
    const cases = [
        '[AUTOPILOT_RESULT: {"outcome":"complete"}]',
        '[AUTOPILOT_RESULT: {"outcome":"shipped","sha":"abc1234"}]',
        '[AUTOPILOT_RESULT: {"outcome":"blocked","reason":"gh_unauth: foo"}]',
    ];
    for (const c of cases) {
        const m = RESULT_TOKEN_RE.exec(c);
        assert.ok(m, `expected ${c} to match`);
        const parsed = JSON.parse(m[1]);
        assert.equal(typeof parsed.outcome, "string");
    }
});

test("RESULT_TOKEN_RE matches the extension's literal (drift guard)", () => {
    // The TUI duplicates the regex literal rather than importing it
    // from handler.mjs (cross-package import drags handler.mjs into
    // the TUI runtime). This drift guard keeps the two literals in
    // lockstep — if either side edits the pattern without touching
    // the other, this test fails loudly.
    const handler = readFileSync(HANDLER_PATH, "utf8");
    // Find the literal in handler.mjs by anchoring on the export.
    const m = /export const RESULT_TOKEN_RE\s*=\s*([\s\S]+?);/.exec(handler);
    assert.ok(m, "expected `export const RESULT_TOKEN_RE = …;` in extension/handler.mjs");
    const handlerLiteral = m[1].trim();
    // The TUI's literal — read via a small reflection: regex objects
    // serialise as `/<source>/<flags>` so we can compare bodies
    // exactly. The extension's literal is unflagged so we strip the
    // trailing `/` markers identically.
    const tuiLiteral = `/${RESULT_TOKEN_RE.source}/${RESULT_TOKEN_RE.flags}`;
    // Normalise: handler literal might have surrounding whitespace
    // or a trailing `/` with no flags. Compare on `source` only,
    // which is the bit that determines what matches.
    const handlerSourceMatch = /^\/(.*)\/([gimsuy]*)$/.exec(handlerLiteral);
    assert.ok(handlerSourceMatch, `failed to parse regex literal: ${handlerLiteral}`);
    assert.equal(handlerSourceMatch[1], RESULT_TOKEN_RE.source,
        `RESULT_TOKEN_RE source drift: handler=${handlerSourceMatch[1]} tui=${RESULT_TOKEN_RE.source}`);
    assert.equal(handlerSourceMatch[2], RESULT_TOKEN_RE.flags,
        `RESULT_TOKEN_RE flags drift: handler=${handlerSourceMatch[2]} tui=${RESULT_TOKEN_RE.flags}`);
    // Also assert the TUI literal equality for sanity.
    void tuiLiteral;
});
