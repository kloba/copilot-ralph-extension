// `autopilot-shipper` custom agent (issue #119, epic #116).
//
// Plugs into `SessionConfig.customAgents` (see
// ~/.copilot/pkg/universal/1.0.40-3/copilot-sdk/types.d.ts:847 for
// `CustomAgentConfig` and :1044 for `SessionConfig.customAgents`).
//
// Receives a JSON handoff from the autopilot_scout tool (#118) via the
// model's built-in delegation (`task` / `delegate` — see below) and
// ships it end-to-end as ONE atomic commit. Emits `SHIPPED:<sha>` or
// `BLOCKED:<reason>` as the terminal token of its assistant output, on
// its own line. The parent agent relays that token to the loop driver
// (#120) via the existing [AUTOPILOT_RESULT: …] root-token contract.
//
// Tool allowlist intentionally excludes:
//   - the loop-driving `ap_*` and future `autopilot_*` tools (no
//     recursion / re-entry into the outer loop),
//   - the model's own delegation tools (`task`, `delegate`) so a
//     shipper sub-agent cannot itself spawn sub-agents,
//   - `ask_user` so the shipper cannot block waiting for human input.
//
// The list of built-in tool names is verified against the SDK runtime
// (`app.js` exposes "bash", "view", "edit", "create", "grep", "glob",
// "str_replace_editor", "web_fetch", "web_search", "fetch", "task",
// "delegate", "ask_user").

export const SHIPPER_AGENT_NAME = "autopilot-shipper";

// Co-author trailer constants — kept in lockstep with the canonical
// values in extension/handler.mjs so a future trailer-format change
// only needs editing in one place per file.
const COPILOT_TRAILER =
    "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";
const RALPH_TRAILER =
    "Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>";

// Tool allowlist. Any name matching /^ap_/ or /^autopilot_/ is rejected
// at module load (see assertion below) so a future edit that smuggles
// a loop-driving tool name in here fails fast at `import` time.
//
// We also reject `task` / `delegate` / `ask_user` because:
//   - delegation re-entry → unbounded recursion across iters,
//   - `ask_user` → would let the shipper stall waiting for input,
//     which violates the "never ask the user" contract.
export const SHIPPER_TOOLS = Object.freeze([
    // Shell access for git, gh, npm.
    "bash",
    // File I/O.
    "view",
    "edit",
    "create",
    "str_replace_editor",
    // Search.
    "grep",
    "glob",
]);

// Hard ceiling for the prompt body. Kept under 6 KB so the shipper
// can be delegated without dominating the model's context window.
const MAX_PROMPT_BYTES = 6144;

// Prompt body. WHY this stays terse:
//   - the loop driver parses ONE terminal token per iter, so the
//     prompt's #1 job is to make the agent emit SHIPPED:<sha> or
//     BLOCKED:<reason> on its own line as the very last output;
//   - any prose beyond that contract is wasted tokens.
export const SHIPPER_PROMPT = `You are the AUTOPILOT SHIPPER.

INPUT: a JSON handoff from autopilot_scout, shaped:
  { kind: "candidate",
    ref: "<gh-issue-num | gh-pr-num | gh-run-id>",
    ref_kind: "issue" | "pr" | "ci_failure",
    title: "<short summary>",
    scope_files: ["<relative-path>", ...],
    acceptance: "<one-sentence pass criterion>",
    evidence: { ... } }

JOB: ship this work item end-to-end as ONE atomic commit, then EMIT a
terminal token and STOP. NEVER ask the user. NEVER wait for input. If
a question would normally arise, decide using scope_files + acceptance
and proceed.

STAGES (do them in order; emit no per-stage markers — the loop driver
does not parse stages from your output):

1. BASELINE. Run the test command from package.json#scripts.test (or
   "npm test" if the repo defines one). If RED before you start, that
   pre-existing failure IS the work item — fix the regression first
   and only then return to the handoff. NEVER overwrite a red baseline
   with new work.

2. IMPLEMENT. Make the minimum change that satisfies acceptance. Stay
   inside scope_files unless spillover is provably required (record
   why in the commit body if so). By ref_kind:
   - "ci_failure": read the failing run log via gh, identify the root
     cause, fix it.
   - "pr": rebase or fix conflicts / failing checks; do not overwrite
     the original author's work without recording why.
   - "issue": implement what the issue describes. If the issue is too
     vague to action without guessing, EMIT \`BLOCKED: needs_clarification\`
     and stop.

3. TEST. Run \`npm test\` AND \`npm run check\`. Both must be GREEN
   before you commit. Pre-existing baseline-red tests stay red only
   if step 1 confirmed they were red BEFORE you started.

4. COMMIT. Conventional Commits subject (per AGENTS.md). Body explains
   WHY. If ref_kind == "issue", footer reads \`Closes #<ref>\`.
   ALWAYS include BOTH co-author trailers as the last two lines:
     ${COPILOT_TRAILER}
     ${RALPH_TRAILER}
   Use \`git -c user.email=… -c user.name=… commit -m … -m …\` so the
   trailers are structured. Make exactly ONE commit per shipper run.

5. PUSH. \`git push\` to the current branch's origin. If push fails
   (network, permissions, non-fast-forward), EMIT
   \`BLOCKED: push_failed: <first line of stderr>\` and stop — do NOT
   leave the commit hidden locally.

6. CLOSE. Only if ref_kind == "issue":
     gh issue close <ref> --comment "Shipped in <sha>"
   If the close call fails, the commit still ships — emit
   \`SHIPPED: <sha>\` (the loop will reconcile the open issue later).

7. EMIT one of these on its OWN LINE as your VERY LAST output:
     SHIPPED: <commit-sha-from-step-4>
     BLOCKED: <one-sentence reason>
   Then stop. Do not add explanatory text after the token. The loop
   driver parses this token from your final assistant message.

CONSTRAINTS:
- NEVER ask the user a question. NEVER wait for input.
- NEVER make more than ONE commit per run. If the change requires
  multiple commits, the work is too large for one iter — emit
  \`BLOCKED: scope_too_large\` and stop.
- NEVER push to a protected branch unless the handoff explicitly says
  to.
- NEVER alter package-lock.json (project is pure-stdlib).
- If the test runner is unavailable (no \`npm\` / \`node\` in PATH),
  emit \`BLOCKED: test_runner_unavailable\` and stop.
`;

// Fail-fast guard: a future edit that bloats the prompt past the
// 6 KB ceiling fails at module import (i.e. at session-load time)
// so the regression surfaces before the shipper is ever delegated.
{
    const bytes = Buffer.byteLength(SHIPPER_PROMPT, "utf8");
    if (bytes > MAX_PROMPT_BYTES) {
        throw new Error(
            `shipper-agent: SHIPPER_PROMPT is ${bytes} bytes, exceeds the ${MAX_PROMPT_BYTES}-byte ceiling. Tighten the prompt before re-importing.`,
        );
    }
}

// Recursion guard: catches any future edit that adds a loop-driving
// tool name to SHIPPER_TOOLS. Runs at module import so the failure
// surfaces at session-load, not on the first delegation.
{
    const forbidden = SHIPPER_TOOLS.filter((t) => /^(?:ap_|autopilot_)/.test(t));
    if (forbidden.length > 0) {
        throw new Error(
            `shipper-agent: SHIPPER_TOOLS must not include loop-driving tool names (got: ${forbidden.join(", ")}). The shipper sub-agent must not be able to recurse into the outer ap_loop / autopilot_* surface.`,
        );
    }
}

// Build a `CustomAgentConfig` shaped object suitable for inclusion in
// `SessionConfig.customAgents`. Returns a fresh object each call so
// callers cannot mutate shared state.
export function createShipperAgentConfig() {
    return {
        name: SHIPPER_AGENT_NAME,
        displayName: "Autopilot Shipper",
        description:
            "Ships ONE scout-handed work item end-to-end as a single atomic commit. Receives a JSON handoff, emits SHIPPED:<sha> or BLOCKED:<reason>. Never asks the user.",
        prompt: SHIPPER_PROMPT,
        tools: [...SHIPPER_TOOLS],
        infer: true,
    };
}

// Internal-only export for tests — keeps the public surface tight
// while letting test files cite specific constants without importing
// the runtime by name.
export const __test__ = Object.freeze({
    MAX_PROMPT_BYTES,
    COPILOT_TRAILER,
    RALPH_TRAILER,
});
