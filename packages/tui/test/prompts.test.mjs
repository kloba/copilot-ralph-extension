// Drift-pin tests for the baked prompts in `packages/tui/src/prompts.mjs`.
//
// These assertions are intentionally narrow — they exist to catch a future
// edit that silently regresses one of the prompt's load-bearing
// invariants (terminal tokens, priority-tier ordering, IDEATE_NEXT_FEATURE
// auto-grow contract). They do NOT try to validate prose quality; that's
// what code review is for.
//
// Pinned invariants:
//   - BAKED_ABORT_TOKEN ("ABORT_NO_IMPROVEMENTS"), COMPLETION_PROMISE
//     ("COMPLETE"), BAKED_BACKLOG_ABORT_TOKEN ("ABORT_NO_BACKLOG") values
//     stay constant. The runner reads these from prompts.mjs and the
//     load-time guard at the bottom of that file enforces presence in
//     the prompt body — if these literals drift, tons of downstream
//     wiring (fake-copilot scripts, runner reduceCopilotEvents, plain
//     formatter) silently breaks.
//   - PROMPT_SELF_IMPROVE priority-tier ordering: RED CI (a) → STALE
//     OPEN PR (b) → OPEN ISSUE (c) → IDEATE_NEXT_FEATURE (d). A future
//     edit that re-introduces the dropped `grow-project` / `proposed`
//     carve-out at tier (c) ("skip these labels — they belong to
//     grow_project") would silently grind the unified loop to a halt
//     at the bottom of the priority order; this test fails when that
//     happens.
//   - IDEATE_NEXT_FEATURE step appears AFTER tier (c) and BEFORE the
//     ABORT_NO_IMPROVEMENTS contract (i.e. it's the tier (d) auto-grow
//     fallback, not a misplaced tier (a) / (b) escape hatch).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    PROMPT_SELF_IMPROVE,
    PROMPT_GROW_PROJECT,
    PROMPT_FLEET,
    COMPLETION_PROMISE,
    BAKED_ABORT_TOKEN,
    BAKED_BACKLOG_ABORT_TOKEN,
} from "../src/prompts.mjs";

// ───────────── Token literals ─────────────

test("token literals: COMPLETION_PROMISE is exactly 'COMPLETE'", () => {
    assert.equal(COMPLETION_PROMISE, "COMPLETE");
});

test("token literals: BAKED_ABORT_TOKEN is exactly 'ABORT_NO_IMPROVEMENTS'", () => {
    assert.equal(BAKED_ABORT_TOKEN, "ABORT_NO_IMPROVEMENTS");
});

test("token literals: BAKED_BACKLOG_ABORT_TOKEN is exactly 'ABORT_NO_BACKLOG'", () => {
    assert.equal(BAKED_BACKLOG_ABORT_TOKEN, "ABORT_NO_BACKLOG");
});

// ───────────── PROMPT_SELF_IMPROVE: token presence ─────────────
//
// The load-time guard at the bottom of prompts.mjs already throws on
// import if either literal is missing — these tests duplicate that
// check at the unit level so a regression surfaces as a named test
// failure rather than an opaque module-load throw.

test("PROMPT_SELF_IMPROVE contains COMPLETION_PROMISE token", () => {
    assert.ok(
        PROMPT_SELF_IMPROVE.includes(COMPLETION_PROMISE),
        "PROMPT_SELF_IMPROVE must contain 'COMPLETE' — runner watches for this token",
    );
});

test("PROMPT_SELF_IMPROVE contains BAKED_ABORT_TOKEN", () => {
    assert.ok(
        PROMPT_SELF_IMPROVE.includes(BAKED_ABORT_TOKEN),
        "PROMPT_SELF_IMPROVE must contain 'ABORT_NO_IMPROVEMENTS' — runner watches for this token",
    );
});

// ───────────── PROMPT_SELF_IMPROVE: priority-tier ordering ─────────────
//
// The four tiers MUST appear in PROMPT_SELF_IMPROVE in this order:
//   a. RED CI
//   b. STALE OPEN PR
//   c. OPEN ISSUE
//   d. IDEATE_NEXT_FEATURE
// A future edit that swaps two tiers, deletes one, or adds a fifth
// silently re-aligns the loop's behaviour without breaking the
// load-time token guard. This regex pins the four-tier sequence.

test("PROMPT_SELF_IMPROVE pins priority-tier order: RED CI → STALE OPEN PR → OPEN ISSUE → IDEATE_NEXT_FEATURE", () => {
    const aIdx = PROMPT_SELF_IMPROVE.indexOf("a. RED CI");
    const bIdx = PROMPT_SELF_IMPROVE.indexOf("b. STALE OPEN PR");
    const cIdx = PROMPT_SELF_IMPROVE.indexOf("c. OPEN ISSUE");
    const dIdx = PROMPT_SELF_IMPROVE.indexOf("d. IDEATE_NEXT_FEATURE");

    assert.ok(aIdx > 0, "tier (a) RED CI label not found");
    assert.ok(bIdx > 0, "tier (b) STALE OPEN PR label not found");
    assert.ok(cIdx > 0, "tier (c) OPEN ISSUE label not found");
    assert.ok(dIdx > 0, "tier (d) IDEATE_NEXT_FEATURE label not found");

    assert.ok(aIdx < bIdx, "tier (a) RED CI must appear before tier (b) STALE OPEN PR");
    assert.ok(bIdx < cIdx, "tier (b) STALE OPEN PR must appear before tier (c) OPEN ISSUE");
    assert.ok(cIdx < dIdx, "tier (c) OPEN ISSUE must appear before tier (d) IDEATE_NEXT_FEATURE");
});

// ───────────── PROMPT_SELF_IMPROVE: tier (c) carve-out is gone ─────────────
//
// Until issue #52 landed, tier (c) deliberately skipped issues carrying
// `grow-project` / `proposed` labels because the now-removed
// `grow_project` loop owned them. Once unified, those ARE this loop's
// own backlog; skipping them silently grinds the loop to a halt at the
// bottom of the priority order. These assertions catch a regression
// that re-introduces the carve-out.

test("PROMPT_SELF_IMPROVE tier (c) does NOT instruct skipping grow-project / proposed labels (the dropped carve-out)", () => {
    // The old carve-out language said things like:
    //   "issue WITHOUT the `grow-project` / `proposed` label"
    //   "Issues carrying `grow-project` / `proposed` belong to the
    //    feature-backlog runner — leave them alone here."
    //   "skim them so you don't duplicate, but do NOT pick them up here"
    // Each of these regexes catches one of those phrasings.

    assert.doesNotMatch(
        PROMPT_SELF_IMPROVE,
        /issue WITHOUT the `grow-project`/i,
        "tier (c) carve-out 'issue WITHOUT the `grow-project`' must NOT be re-introduced (issue #52)",
    );
    assert.doesNotMatch(
        PROMPT_SELF_IMPROVE,
        /belong to the feature-backlog runner/i,
        "tier (c) carve-out 'belong to the feature-backlog runner' must NOT be re-introduced (issue #52)",
    );
    assert.doesNotMatch(
        PROMPT_SELF_IMPROVE,
        /do NOT pick them up here/i,
        "tier (c) carve-out 'do NOT pick them up here' must NOT be re-introduced (issue #52)",
    );
});

// ───────────── PROMPT_SELF_IMPROVE: IDEATE_NEXT_FEATURE placement ─────────────
//
// IDEATE_NEXT_FEATURE is the tier (d) auto-grow fallback. It MUST appear
// AFTER tier (c) (so reliability work always wins over new functionality)
// and BEFORE the ABORT_NO_IMPROVEMENTS contract (so the agent only
// reaches the abort path when even tier (d) yields nothing).

test("PROMPT_SELF_IMPROVE: IDEATE_NEXT_FEATURE appears between tier-(c) miss and ABORT_NO_IMPROVEMENTS contract", () => {
    const cIdx = PROMPT_SELF_IMPROVE.indexOf("c. OPEN ISSUE");
    const dIdx = PROMPT_SELF_IMPROVE.indexOf("d. IDEATE_NEXT_FEATURE");
    const abortContractIdx = PROMPT_SELF_IMPROVE.indexOf("ABORT_NO_IMPROVEMENTS CONTRACT");

    assert.ok(cIdx > 0, "tier (c) marker not found");
    assert.ok(dIdx > 0, "tier (d) IDEATE_NEXT_FEATURE marker not found");
    assert.ok(abortContractIdx > 0, "ABORT_NO_IMPROVEMENTS CONTRACT block not found");

    assert.ok(
        cIdx < dIdx,
        "IDEATE_NEXT_FEATURE must appear AFTER tier (c) so reliability wins over auto-grow",
    );
    assert.ok(
        dIdx < abortContractIdx,
        "IDEATE_NEXT_FEATURE must appear BEFORE the ABORT_NO_IMPROVEMENTS contract so the agent only aborts when tier (d) is also dry",
    );
});

test("PROMPT_SELF_IMPROVE: IDEATE_NEXT_FEATURE step instructs `gh issue create --label grow-project --label proposed`", () => {
    // The exact gh invocation is part of the contract — the next iter's
    // tier-(c) ORIENT recognises the issue by these two labels. A future
    // edit that drops a label or renames it silently breaks the auto-grow
    // handoff between iters.
    assert.match(
        PROMPT_SELF_IMPROVE,
        /gh issue create --label grow-project --label proposed/,
        "tier (d) MUST file with `gh issue create --label grow-project --label proposed` so the next iter's tier-(c) ORIENT picks it up",
    );
});

test("PROMPT_SELF_IMPROVE: IDEATE_NEXT_FEATURE step pins the traceability footer shape", () => {
    // The "Auto-ideated by self_improve iter N on <ISO-date>" footer is
    // the discoverable signal that an issue is loop-authored. A future
    // contributor greps for it; a regression that drops it makes
    // loop-filed issues indistinguishable from human-filed ones.
    assert.match(
        PROMPT_SELF_IMPROVE,
        /Auto-ideated by self_improve iter N on <ISO-date>\./,
        "tier (d) MUST instruct the literal traceability footer 'Auto-ideated by self_improve iter N on <ISO-date>.'",
    );
});

test("PROMPT_SELF_IMPROVE: IDEATE_NEXT_FEATURE step pins the one-issue-per-iter idempotency rule", () => {
    // JIT one-at-a-time is the design: keeps each iter cheap, avoids
    // stale ideation, lets the next iter re-orient against fresh state.
    // A regression that removes this guard would let the agent batch
    // 5-10 ideations in one iter (the old grow_project behaviour).
    assert.match(
        PROMPT_SELF_IMPROVE,
        /AT MOST ONE issue per iter/,
        "tier (d) MUST pin the one-issue-per-iter idempotency rule",
    );
});

// ───────────── PROMPT_GROW_PROJECT: unchanged surface ─────────────
//
// Issue #52 explicitly defers any change to PROMPT_GROW_PROJECT to a
// follow-up issue — for now the unification happens entirely via
// PROMPT_SELF_IMPROVE learning the new tier (d). These assertions
// pin the tokens grow_project still emits so a future cleanup can't
// silently retire grow_project's terminal contract.

test("PROMPT_GROW_PROJECT contains COMPLETION_PROMISE token", () => {
    assert.ok(PROMPT_GROW_PROJECT.includes(COMPLETION_PROMISE));
});

test("PROMPT_GROW_PROJECT contains BAKED_BACKLOG_ABORT_TOKEN", () => {
    assert.ok(PROMPT_GROW_PROJECT.includes(BAKED_BACKLOG_ABORT_TOKEN));
});

// ───────────── PROMPT_FLEET: token presence + framing ─────────────
//
// Fleet is the new "find one work item, ship it, repeat" loop. The
// runner reads COMPLETION_PROMISE / BAKED_BACKLOG_ABORT_TOKEN from
// prompts.mjs to decide when to advance the iter / terminate the
// loop, so a regression that drops either literal silently breaks
// the whole loop. The load-time guard at the bottom of prompts.mjs
// already throws on import; these tests duplicate the check at the
// unit level for a named-failure signal.

test("PROMPT_FLEET contains COMPLETION_PROMISE token", () => {
    assert.ok(
        PROMPT_FLEET.includes(COMPLETION_PROMISE),
        "PROMPT_FLEET must contain 'COMPLETE' — runner watches for this token",
    );
});

test("PROMPT_FLEET contains BAKED_BACKLOG_ABORT_TOKEN", () => {
    assert.ok(
        PROMPT_FLEET.includes(BAKED_BACKLOG_ABORT_TOKEN),
        "PROMPT_FLEET must contain 'ABORT_NO_BACKLOG' — runner watches for this token",
    );
});

test("PROMPT_FLEET frames the prompt as 'AUTOPILOT MODE'", () => {
    // The framing token doubles as a UX promise: 'no questions to the
    // user'. A regression that drops it would silently re-introduce
    // approval prompts mid-loop.
    assert.match(
        PROMPT_FLEET,
        /AUTOPILOT MODE/,
        "PROMPT_FLEET must frame the loop as AUTOPILOT MODE — the no-questions contract depends on this",
    );
});

test("PROMPT_FLEET pins the five-stage walk in order: ORIENT → IMPLEMENT → COMMIT → PUSH → END", () => {
    // Match the numbered walk anchors (`1.` / `2.` / …) so the test
    // pins the per-iter stage list, not the prose mentions of the same
    // stage names elsewhere in the prompt body. The runner's worktree
    // teardown depends on `[STAGE: END]` at the tail; reordering or
    // dropping any stage breaks teardown. This mirrors
    // `SDLC_STAGES_FLEET` in events.mjs (pinned separately in
    // events.test.mjs).
    const orientIdx = PROMPT_FLEET.indexOf("1. [STAGE: ORIENT]");
    const implementIdx = PROMPT_FLEET.indexOf("2. [STAGE: IMPLEMENT]");
    const commitIdx = PROMPT_FLEET.indexOf("3. [STAGE: COMMIT]");
    const pushIdx = PROMPT_FLEET.indexOf("4. [STAGE: PUSH]");
    const endIdx = PROMPT_FLEET.indexOf("5. [STAGE: END]");
    assert.ok(orientIdx >= 0, "PROMPT_FLEET must mention 1. [STAGE: ORIENT]");
    assert.ok(implementIdx > orientIdx, "2. [STAGE: IMPLEMENT] must come after 1. [STAGE: ORIENT]");
    assert.ok(commitIdx > implementIdx, "3. [STAGE: COMMIT] must come after 2. [STAGE: IMPLEMENT]");
    assert.ok(pushIdx > commitIdx, "4. [STAGE: PUSH] must come after 3. [STAGE: COMMIT]");
    assert.ok(endIdx > pushIdx, "5. [STAGE: END] must come after 4. [STAGE: PUSH] (worktree teardown depends on it)");
});

test("PROMPT_FLEET pins priority-tier order: RED CI → STALE OPEN PR → OPEN ISSUE", () => {
    // Same priority tiers as PROMPT_SELF_IMPROVE EXCEPT no tier (d)
    // ideation backstop — fleet drains, it doesn't grow.
    const aIdx = PROMPT_FLEET.indexOf("a. RED CI");
    const bIdx = PROMPT_FLEET.indexOf("b. STALE OPEN PR");
    const cIdx = PROMPT_FLEET.indexOf("c. OPEN ISSUE");
    assert.ok(aIdx >= 0, "tier (a) RED CI must be present");
    assert.ok(bIdx > aIdx, "tier (b) STALE OPEN PR must come after tier (a)");
    assert.ok(cIdx > bIdx, "tier (c) OPEN ISSUE must come after tier (b)");
});

test("PROMPT_FLEET does NOT contain IDEATE_NEXT_FEATURE — fleet drains, it doesn't grow", () => {
    // The fundamental difference vs PROMPT_SELF_IMPROVE: fleet aborts
    // when the backlog is empty; it does NOT auto-grow new features.
    // A future edit that re-adds an ideation step here would silently
    // turn fleet into self_improve.
    assert.ok(
        !PROMPT_FLEET.includes("IDEATE_NEXT_FEATURE"),
        "PROMPT_FLEET must NOT contain IDEATE_NEXT_FEATURE — fleet aborts on empty backlog instead",
    );
});

test("PROMPT_FLEET pins the no-questions-to-user hard rule", () => {
    // The headline UX promise of fleet mode. Regressing this silently
    // re-introduces approval prompts, which defeats the point of
    // putting the loop on autopilot.
    assert.match(
        PROMPT_FLEET,
        /No questions to the user|never ask the user a question/i,
        "PROMPT_FLEET must pin the no-questions-to-user contract",
    );
});
