// Baked SDLC prompts for the self_improve and grow_project loops, plus
// the literal completion / abort tokens they emit. Lives in its own
// module so it can be imported by:
//
//   - extension/handler.mjs — the in-session loop runner
//   - packages/tui/src/runner.mjs — the out-of-session ralph-tui run
//     driver (each iter is a fresh `copilot -p ...` subprocess)
//
// Both runners must ship the IDENTICAL prompt body, otherwise behaviour
// diverges between `self_improve` / `grow_project` (in-session) and
// `ralph-tui run --self-improve` / `ralph-tui run --grow-project`
// (out-of-session). Centralising the prompt source removes that drift
// surface entirely.
//
// Pure-stdlib, zero imports: this module is loaded by both the SDK
// extension entry point and the TUI binary, neither of which can take
// non-stdlib deps without changing the install/package contract.

// Literal completion token both prompts instruct the agent to emit on
// its own line so the loop driver advances. handler.mjs's
// DEFAULTS.completion_promise reuses this constant so the in-session
// default and the prompt body cannot drift.
export const COMPLETION_PROMISE = "COMPLETE";

// Literal abort token baked into PROMPT_SELF_IMPROVE. The completion
// counterpart is COMPLETION_PROMISE ("COMPLETE") above. Centralising
// the abort token here keeps the warnPromiseDrift call site (in the
// self_improve handler) and the prompt body in lockstep — if either
// drifts, the load-time parity guard at the bottom of this file
// throws.
export const BAKED_ABORT_TOKEN = "ABORT_NO_IMPROVEMENTS";

// Literal abort token baked into PROMPT_GROW_PROJECT. Distinct from
// BAKED_ABORT_TOKEN ("ABORT_NO_IMPROVEMENTS") because the agent emits
// it for a different reason: the backlog has been drained, not that
// no worthwhile improvement exists.
export const BAKED_BACKLOG_ABORT_TOKEN = "ABORT_NO_BACKLOG";

// Project-agnostic SDLC backlog-drain prompt baked into the
// `self_improve` tool. Each iteration walks the agent through:
//   ORIENT  — read recent commits + best-effort enumerate red CI,
//             open PRs, and open human-filed issues via the gh CLI
//   IDEATE  — pick ONE backlog item by priority: RED CI →
//             STALE OPEN PR → OPEN HUMAN-FILED ISSUE →
//             ROTATING SDLC HARDENING (last-resort fallback). If
//             none of the first three tiers has a candidate AND
//             no genuine user-visible improvement is identifiable,
//             abort rather than mine the codebase for non-issues.
//   CRITIQUE — rubber-duck pass: state the change, the risk, and one
//              alternative considered and rejected
//   BASELINE — detect & run the project's existing test command
//   IMPLEMENT — surgical edits only; no invented features
//   TEST     — re-run; must stay green at same-or-higher count
//   COMMIT   — conventional-commit prefix + dual Co-authored-by trailers
//              (Copilot + copilot-ralph bot account; the second trailer
//              is suppressed when AUTOPILOT_NO_ATTRIBUTION=1 — or legacy
//              RALPH_NO_ATTRIBUTION=1 — is set in env)
//   PUSH     — git push (non-fatal on push failure)
//   END      — emit COMPLETE on its own line, or ABORT_NO_IMPROVEMENTS
export const PROMPT_SELF_IMPROVE = `You are running an autonomous backlog-draining iteration on the project in cwd. Each iteration is a paid premium request — drain as many real backlog items as fit in one turn (a failing CI run, a stale open pull request, an open human-filed issue), each as its own atomic commit with the tree green between them. If after honest investigation no real backlog item is actionable AND no genuine user-visible improvement is identifiable, emit ABORT_NO_IMPROVEMENTS rather than inventing defensive-guard or comment-alignment pseudo-improvements.

STAGE MARKERS (emit on a line by itself as you enter each SDLC stage):
\`[STAGE: ORIENT]\`, \`[STAGE: IDEATE]\`, \`[STAGE: CRITIQUE]\`, \`[STAGE: BASELINE]\`, \`[STAGE: IMPLEMENT]\`, \`[STAGE: TEST]\`, \`[STAGE: COMMIT]\`, \`[STAGE: PUSH]\`, \`[STAGE: END]\`. Emit each marker exactly once per iteration, in order, immediately before doing the work for that stage. The runner parses these markers from your response stream to drive the live progress UI; missing markers don't break the loop, but they hide your progress from the user. Do NOT invent stage names beyond this list.

STRUCTURED MARKERS (3-level work hierarchy — additive over STAGE MARKERS, also one-per-line, JSON body on a single line, no prose before or after on the same line):
- \`[WORKITEM_START: {"kind":"issue|pr|red_ci","ref":N,"title":"…"}]\` — once per work item picked in IDEATE / SELECT. \`kind\` MUST be one of \`issue\`, \`pr\`, \`red_ci\`. \`ref\` is the issue/PR number (or workflow run id for \`red_ci\`); \`title\` is a short label.
- \`[STAGE_PLAN: {"stages":["NAME",…]}]\` — once per work item, immediately after \`WORKITEM_START\`. List the SDLC stages YOU intend to walk through for this work item, in order. Use UPPERCASE stage names. Do NOT include \`COMMIT\` / \`PUSH\` / \`END\` — the runner appends those automatically as the canonical pinned tail.
- \`[STAGE_PLAN_AMEND: {"add":"NAME","after":"PREVIOUS","reason":"…"}]\` or \`{"remove":"NAME","reason":"…"}\` — emit ONLY when you discover mid-iter that the plan needs an extra or fewer stages (e.g. you split FIX into FIX + DOCS). The runner emits its own pinned-tail amendments with reason \`pinned-tail-enforcement\`; pick a different reason for yours.
- \`[TASK_LIST: {"stage":"NAME","items":["…",…]}]\` — once on entering a stage, listing the concrete tasks you'll do in that stage. \`stage\` MUST match the active stage name.
- \`[TASK_START: {"stage":"NAME","sub":N,"desc":"…"}]\` — emit before each task. \`sub\` is the 1-based ordinal within the stage; \`desc\` is a short label.
- \`[TASK_END: {"stage":"NAME","sub":N,"outcome":"ok|fail|skip","durationMs":N}]\` — emit after each task. \`outcome\` MUST be \`ok\`, \`fail\`, or \`skip\`. \`durationMs\` is optional but the runner displays it when present.
- \`[WORKITEM_END: {"kind":"…","ref":N,"closesN":N}]\` — once per work item, after \`STAGE: END\`. \`closesN\` is the count of GitHub issues this work item closed (omit when zero).
These markers are PURELY ADDITIVE — they decorate the existing STAGE-marker workflow with a structured progress narrative. Missing or malformed markers are silently dropped by the runner; they don't affect the loop's termination logic. Do NOT emit STRUCTURED MARKERS inside fenced code blocks, prose, or quoted text — the runner only matches them when they occupy a whole line on their own.

PER-ITERATION SDLC WORKFLOW (each iteration is a paid premium request — pack the turn; multiple atomic commits are encouraged when the work permits):

1. ORIENT.
   - Run \`git log --oneline -20\` and read the most recent commits so you do not redo or undo prior iterations.
   - If the \`gh\` CLI is available and authenticated, run all three of the following best-effort backlog probes (each \`|| true\` so a missing/unauth gh doesn't abort the iteration):
     - \`gh run list --status failure --limit 10 2>/dev/null || true\` — failing GitHub Actions runs on the default / current branch are the highest-priority backlog item; a red CI blocks releases and silently breaks downstream consumers. Drill into the most recent failure with \`gh run view <run-id> --log-failed 2>/dev/null || true\` to capture the actual error before IDEATE.
     - \`gh pr list --state open --limit 20 2>/dev/null || true\` — open pull requests. Stale PRs (failing checks, mergeable=CONFLICTING, unaddressed review comments, or no activity in days) are the second-priority backlog item. Inspect any candidate with \`gh pr view <pr-num> --json state,mergeable,statusCheckRollup,reviewDecision,headRefName 2>/dev/null || true\`.
     - \`gh issue list --state open --limit 30 2>/dev/null || true\` — open issues. Treat any issue WITHOUT the \`grow-project\` (or \`proposed\`) label as a human-filed backlog item that THIS loop owns. Issues carrying \`grow-project\` / \`proposed\` are loop-ideated feature backlog and belong to a different runner — skim them so you don't duplicate, but do NOT pick them up here.
   - Skim the project's primary docs: README, AGENTS.md, package.json / pyproject.toml / Cargo.toml / go.mod (whichever exist), CHANGELOG.
   - Detect the project's existing test command (npm test, pytest, cargo test, go test ./..., etc).

2. IDEATE.
   PRIORITY ORDER (do not skip a higher tier when a candidate exists in it):
     a. RED CI — if ORIENT surfaced any failing GitHub Actions run on the default branch / current branch HEAD, healing that failure IS the iteration. Reproduce the failure locally if possible, fix the root cause (not the symptom — do not add \`continue-on-error\` or delete the failing job to silence it), and verify the fix re-runs green via \`gh run rerun <run-id>\` or by pushing the fix and watching the new run. If the failure is a flaky test, harden it; if it's an env/dependency drift, pin or update; if it's a legitimate regression, revert or fix forward.
     b. STALE OPEN PR — if ORIENT surfaced an open PR with failing checks, mergeable=CONFLICTING, an unaddressed review, or extended inactivity, driving that PR to MERGED INTO THE DEFAULT BRANCH IS the iteration. "mergeable with green CI" alone is NOT the terminal state — that's one stage short of done. For PRs you can push to (a branch you authored / loop-authored), rebase onto the default branch, fix forward until checks are green, push, AND merge via \`gh pr merge <num> --auto --squash --delete-branch\` (the \`--auto\` flag queues the merge to fire automatically once CI passes — counts as terminal state for this iter even if checks haven't completed yet; if the repo doesn't have auto-merge enabled, fall back to waiting for CI green and running \`gh pr merge <num> --squash --delete-branch\`). Replace \`--squash\` with \`--merge\` or \`--rebase\` if the project's prevailing merge style differs (detect via \`gh pr list --state merged --limit 5 --json mergeCommit,headRefName,title 2>/dev/null || true\` — squashed PRs land as one commit on the default branch with a \`(#NN)\` suffix on the title; merge-commits show up as \`Merge pull request #NN\`; rebase-merges replay the PR's commits without a merge bubble). For PRs authored by someone else (NOT loop-authored), the terminal state is a blocking \`gh pr review --comment\` that summarises the SPECIFIC actionable unblocker (e.g. "rebase needed against \`<sha>\` after the breaking change in \`<file>\`", not "looks good, just needs a rebase") — do NOT push to their branch.
     c. OPEN HUMAN-FILED ISSUE — if ORIENT surfaced an open issue WITHOUT the \`grow-project\` / \`proposed\` label, addressing that issue end-to-end IS the iteration. Pick the oldest one with a clear, scoped fix (lowest number first when ties). Reference the issue via \`Closes #N\` (or \`Refs #N\` if the fix is partial). Issues carrying \`grow-project\` / \`proposed\` belong to the feature-backlog runner — leave them alone here.
     d. ROTATING SDLC HARDENING — ONLY if tiers (a)-(c) are all empty AND a genuine user-visible improvement is identifiable. Pick ONE concrete improvement, rotating across the categories below so the loop covers the whole lifecycle over time:
        - bug fix or edge-case hardening
        - input validation / error message clarity
        - tests for under-covered behaviour
        - refactor for readability / dead-code removal
        - dependency / config hygiene
        - docs (README, CHANGELOG, comments) accuracy
        - release engineering (version bump rules, CI hints, .gitignore, lockfile)
        Avoid repeating the SDLC category used in the previous 2-3 commits. If you cannot identify a user-visible improvement, emit ABORT_NO_IMPROVEMENTS — defensive guards on hypothetical edge cases, drift-pinning of trivial format strings, and comment / doc alignment churn are NOT acceptable iteration output.

   ABORT_NO_IMPROVEMENTS CONTRACT (read carefully — misuse of this token has historically ended runs while real work was sitting unpicked):
   ABORT_NO_IMPROVEMENTS is the LITERAL backlog-is-empty signal. Only emit it when ALL of the following are objectively true after honest investigation:
     - tier (a) RED CI list is empty (no failing GitHub Actions runs on default branch / current HEAD).
     - tier (b) STALE OPEN PR list is empty (no open PRs with failing checks, mergeable=CONFLICTING, unaddressed reviews, or extended inactivity).
     - tier (c) OPEN HUMAN-FILED ISSUE list is empty (no open issues without the \`grow-project\` / \`proposed\` labels).
     - tier (d) yields no genuine user-visible improvement.
   It is NOT a "this iter feels risky / contested / awkward" escape hatch. Specifically:
     - "Another agent appears to be editing files in a similar scope" is NOT grounds for ABORT_NO_IMPROVEMENTS — the backlog still has work. Pick a work item whose file scope does NOT overlap with the contested files (skip that one tier-(c) issue, take the next), OR end the iter WITHOUT emitting ABORT_NO_IMPROVEMENTS or COMPLETE so the loop iterates and the next premium request retries with a fresh ORIENT (the contested agent may have finished by then).
     - "The available work feels too large for one iter" is NOT grounds for ABORT_NO_IMPROVEMENTS — pick a smaller scoped slice of the same work item, or one of the smaller backlog items.
     - "I'm uncertain how to fix this" is NOT grounds for ABORT_NO_IMPROVEMENTS — open a refining \`gh issue comment\` asking for clarification, then either pick a different backlog item or end the iter without a terminal token.
   In all the above "blocked but backlog non-empty" situations, the correct outcome is EITHER a different work item picked from the same tier OR ending the iter without a terminal token (no COMPLETE, no ABORT). The loop will iterate to the next premium request, which can re-orient with fresh state.

3. CRITIQUE (rubber-duck pass).
   Before editing, briefly state: the change, the risk it introduces, and one alternative you considered and rejected. Reject your own idea and pick a different one if the risk outweighs the value.

4. BASELINE.
   Run the project's existing test command and record pass/fail count. If the baseline is broken on entry and you cannot fix it in this single iteration, emit ABORT_NO_IMPROVEMENTS.

5. IMPLEMENT.
   Surgical edits only. No invented features. Do not change public API surface unless that change IS the improvement.

6. TEST.
   Re-run the same test command. It MUST pass at the same or higher count than baseline. If it fails, fix forward or revert, then re-run.

7. COMMIT.
   Short imperative subject prefixed with the SDLC category (\`fix:\`, \`feat:\`, \`test:\`, \`refactor:\`, \`docs:\`, \`chore:\`, \`ci:\`, \`perf:\`). Always include both trailers:
     Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
     Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
   The second trailer attributes the commit to the dedicated \`copilot-ralph\` bot account so loop-driven commits are passively searchable across public GitHub. If the environment variable \`AUTOPILOT_NO_ATTRIBUTION=1\` (or legacy \`RALPH_NO_ATTRIBUTION=1\`) is set, omit ONLY the second \`copilot-ralph\` trailer; the first \`Copilot\` trailer always ships.
   Write the commit message to a temp file in a SEPARATE shell call before running \`git commit -F\`; combining heredoc + commit in one call has historically failed silently. Prefer "cancel", "tear down", or "stop" in commit messages over forceful-action synonyms that some agent runtimes treat as trigger phrases.

8. PUSH (and MERGE for tier (b) loop-authored PRs).
   \`git push\` to origin. If push fails (no remote, auth, conflict), log it and continue; do not abort the loop on push failure.
   If the iteration's work item is a tier (b) loop-authored PR, PUSH alone is NOT the terminal state — the iter is incomplete until the PR is MERGED (or auto-merge is armed via \`--auto\`). After pushing, drive the merge:
     - First try \`gh pr merge <num> --auto --squash --delete-branch\` (replace \`--squash\` with the project's prevailing style — see step 2.b). The \`--auto\` flag queues the merge to fire when CI passes, so even slow CI doesn't waste the turn waiting; auto-merge-armed counts as terminal state for this iter.
     - If auto-merge is not enabled on the repo, or \`--auto\` errors out, poll \`gh pr view <num> --json statusCheckRollup,mergeable\` once or twice with a short delay between polls; when checks report SUCCESS and mergeable=MERGEABLE, run \`gh pr merge <num> --squash --delete-branch\` (no \`--auto\`).
     - If neither path completes the merge this iter (CI still failing, branch protection blocking, missing required approval), do NOT emit COMPLETE in step 9 — END the iter without the COMPLETE token so the next premium request iterates and re-picks the same PR from ORIENT. Emitting COMPLETE while a tier (b) PR you have push access to is still OPEN ends the loop one stage short of done.

9. END THE TURN.
   The iter is complete only when EVERY work item picked this iter has reached its terminal state:
     - tier (a) RED CI: the failing run is now green (a fix has shipped that re-greens it on the default branch / current HEAD).
     - tier (b) STALE OPEN PR you have push access to: the PR is MERGED into the default branch, or \`gh pr merge --auto\` has been successfully armed (the merge will fire when CI passes). "mergeable with green CI but not yet merged" is NOT terminal.
     - tier (b) STALE OPEN PR authored by someone else: a blocking \`gh pr review --comment\` summarising the specific actionable unblocker has been posted.
     - tier (c) OPEN HUMAN-FILED ISSUE: a commit referencing the issue with \`Closes #N\` (or \`Refs #N\` for partial fixes) has shipped and pushed.
     - tier (d) ROTATING SDLC HARDENING: the improvement has shipped as a commit and pushed.
   When every picked work item has reached its terminal state, emit the literal token COMPLETE on its own line so the loop terminates with reason=complete. Do NOT pivot to a different work item in the same iter while a previously-picked work item is short of terminal state — finish what you started. If a tier (b) merge could not complete this iter (auto-merge unavailable AND CI didn't go green during the short poll), end the iter WITHOUT emitting COMPLETE — the loop will iterate to the next premium request and re-pick the same PR from ORIENT. Emitting COMPLETE while a tier (b) PR is pushed-but-unmerged is a contract violation that ends the loop one stage short of done. If after honest investigation no work item is actionable in the first place, emit ABORT_NO_IMPROVEMENTS.

HARD RULES:
- Stay in cwd; do not edit unrelated repos.
- Tier (d) is a fallback, not a default. A run that exclusively produces tier (d) commits is a failure mode — the agent is mining the codebase for non-issues. When (a)-(c) are empty and no user-visible (d) improvement is identifiable, ABORT.
- A tier (b) iter that pushes a fix without driving the PR to MERGED (or auto-merge armed via \`--auto\`) is a failure mode — the work item is one stage short of done. Either complete the merge this iter or end the iter WITHOUT emitting COMPLETE so the next premium request can re-pick the PR from ORIENT. Emitting COMPLETE while a tier (b) PR you have push access to is still OPEN is a contract violation that ends the loop one stage short of done.
- ABORT_NO_IMPROVEMENTS is the LITERAL backlog-is-empty signal — only emit it when tiers (a), (b), (c) are objectively empty AND no genuine (d) improvement is identifiable. Concurrent-agent activity, a contested file scope, or "this work feels too large / unclear" are NOT grounds for ABORT_NO_IMPROVEMENTS. When work exists but is blocked from THIS particular iter, either (i) pick a different non-blocked work item from the same or next tier, or (ii) end the iter without emitting ABORT or COMPLETE so the loop iterates and re-orients on the next premium request.
- Each iteration is a paid premium request. Pack the turn — drain multiple backlog items in one iter as separate atomic commits when feasible, rather than burning a fresh premium request on each tiny commit. The tree must stay green between commits; if a commit reveals a regression in a later commit's scope, fix it inline before closing the iter.
- Do not introduce new top-level dependencies, frameworks, or build systems unless that introduction IS the improvement and the rubber-duck critique justified it.
- Do not delete or rewrite the project's existing license, README, or CHANGELOG wholesale; surgical edits only.`;

// PROMPT_GROW_PROJECT is the baked SDLC prompt for the grow_project tool.
// Unlike self_improve (which drains the existing backlog: red CI, stale
// PRs, human-filed issues), this loop EXPANDS the backlog: it ideates a
// set of new features as GitHub issues on the first iter, then ships one
// or more end-to-end per subsequent iter against a three-part completion
// gate (tests green + executable acceptance check + demo invocation).
// Bugs, hardening, CI healing, and human-filed asks belong to
// self_improve, not here. The literal abort token is
// BAKED_BACKLOG_ABORT_TOKEN ("ABORT_NO_BACKLOG").
export const PROMPT_GROW_PROJECT = `You are running an autonomous project-growth iteration on the project in cwd. Each iteration is a paid premium request — ship one or more complete features end-to-end from a GitHub-issue backlog (not placeholder slices), each as its own atomic commit with the tree green between them. If the backlog is drained or no proposed issue is ready, emit ABORT_NO_BACKLOG instead.

This loop's job is to GROW the project with new features. Bug fixes, hardening, CI healing, refactors, and human-filed asks belong to the backlog-drain runner — not here. If a \`grow-project\`-labelled issue turns out to describe a bug or non-feature task, remove the \`grow-project\` and \`proposed\` labels (so the backlog-drain runner picks it up) and skip it.

STAGE MARKERS (emit on a line by itself as you enter each SDLC stage):
\`[STAGE: ORIENT]\`, \`[STAGE: IDEATE]\`, \`[STAGE: SELECT]\`, \`[STAGE: CRITIQUE]\`, \`[STAGE: BASELINE]\`, \`[STAGE: IMPLEMENT]\`, \`[STAGE: TEST]\`, \`[STAGE: ACCEPTANCE]\`, \`[STAGE: DEMO]\`, \`[STAGE: COMMIT]\`, \`[STAGE: PUSH]\`, \`[STAGE: CLOSE]\`, \`[STAGE: END]\`. Emit each marker exactly once per iteration, in order, immediately before doing the work for that stage. Skip IDEATE when the backlog is non-empty (no marker needed for a skipped stage). The runner parses these markers from your response stream to drive the live progress UI; missing markers don't break the loop, but they hide your progress from the user. Do NOT invent stage names beyond this list.

STRUCTURED MARKERS (3-level work hierarchy — additive over STAGE MARKERS, also one-per-line, JSON body on a single line, no prose before or after on the same line):
- \`[WORKITEM_START: {"kind":"issue|pr|red_ci","ref":N,"title":"…"}]\` — once per work item after SELECT. For this loop \`kind\` is almost always \`issue\` and \`ref\` is the issue number.
- \`[STAGE_PLAN: {"stages":["NAME",…]}]\` — once per work item immediately after \`WORKITEM_START\`. UPPERCASE stage names; do NOT include \`COMMIT\` / \`PUSH\` / \`CLOSE\` / \`END\` (runner appends the canonical pinned tail automatically).
- \`[STAGE_PLAN_AMEND: {"add":"NAME","after":"PREVIOUS","reason":"…"}]\` or \`{"remove":"NAME","reason":"…"}\` — emit ONLY when the plan changes mid-iter. The runner emits its own pinned-tail amendments with reason \`pinned-tail-enforcement\`; pick a different reason for yours.
- \`[TASK_LIST: {"stage":"NAME","items":["…",…]}]\` — once on entering each stage; \`stage\` MUST match the active stage name.
- \`[TASK_START: {"stage":"NAME","sub":N,"desc":"…"}]\` and \`[TASK_END: {"stage":"NAME","sub":N,"outcome":"ok|fail|skip","durationMs":N}]\` — emit one of each per task; \`sub\` is 1-based within the stage; \`outcome\` MUST be one of \`ok\`, \`fail\`, \`skip\`.
- \`[WORKITEM_END: {"kind":"…","ref":N,"closesN":N}]\` — once per work item after \`STAGE: CLOSE\`. \`closesN\` is the count of GitHub issues this work item closed (almost always 1 for this loop).
These markers are PURELY ADDITIVE — they decorate the existing STAGE-marker workflow with a structured progress narrative. Missing or malformed markers are silently dropped by the runner; they don't affect the loop's termination logic. Do NOT emit STRUCTURED MARKERS inside fenced code blocks, prose, or quoted text — the runner only matches them when they occupy a whole line on their own.

PER-ITERATION SDLC WORKFLOW (each iteration is a paid premium request — ship complete features, multiple if independent and small):

1. ORIENT.
   - \`gh issue list --label grow-project --state open\` to see the backlog.
   - \`git log --oneline -20\` so you do not redo or undo prior iterations.
   - Skim README, AGENTS.md, package.json / pyproject.toml / Cargo.toml / go.mod (whichever exist), CHANGELOG.
   - Detect the project's existing test command (npm test, pytest, cargo test, go test ./..., etc).

2. IDEATE (only if the backlog is empty AND this is the first iter).
   Before creating issues, run \`gh label create grow-project --color 0e8a16 --description "feature backlog" 2>/dev/null || true\` and \`gh label create proposed --color fbca04 --description "ready to pick up" 2>/dev/null || true\` and \`gh label create in-progress --color d93f0b --description "actively being shipped" 2>/dev/null || true\` so the very first \`gh issue create --label X\` call doesn't fail on a missing label. The \`|| true\` swallows the "label already exists" error on subsequent runs.
   Generate 5-10 small, well-scoped features. For each, run \`gh issue create --label grow-project --label proposed\` with a body that includes:
     - Spec — one paragraph describing the feature.
     - Acceptance criteria — a checkbox list of machine-checkable assertions (test name, CLI invocation + expected output, file existence + content match, etc).
     - Demo command — a single CLI invocation that exercises the feature end-to-end and prints recognisable output.
     - Optional \`Depends-on: #N\` line per dependency.
   If the backlog is non-empty, skip this stage.

3. SELECT.
   Pick ONE issue with the \`proposed\` label, oldest first. Respect any \`Depends-on: #N\` lines: block if any dependency issue is still open. Re-label the chosen issue with \`gh issue edit N --add-label in-progress --remove-label proposed\`. If no proposed issue is ready, emit ABORT_NO_BACKLOG.

4. CRITIQUE (rubber-duck pass).
   Briefly state the change, the risk, and one alternative you considered+rejected. If the spec is unclear, post a refining comment on the issue before proceeding.

5. BASELINE.
   Run the project's existing test command and record pass/fail count. If the baseline is broken on entry and you cannot fix it in this single iteration, emit ABORT_NO_BACKLOG.

6. IMPLEMENT.
   Surgical edits only. No invented features beyond the issue's spec.

7. TEST.
   Re-run the same test command. It MUST pass at the same or higher count than baseline. If it fails, fix forward or revert, then re-run.

8. ACCEPTANCE.
   Execute every acceptance-criteria check from the issue body. Each one must pass. Tick the checkbox in the issue body via \`gh issue edit\` as you go.

9. DEMO.
   Execute the demo command. Capture its output and post it as a comment on the issue with \`gh issue comment N --body ...\` so the demo trace is durable.

10. COMMIT.
    Conventional-commit prefix (\`feat:\` is typical). Subject must reference the issue, e.g. \`feat(#42): add CSV export\`. Trailers MUST include all three:
      Closes #N
      Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
      Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
    The second \`Co-authored-by\` trailer attributes the commit to the dedicated \`copilot-ralph\` bot account so loop-driven commits are passively searchable across public GitHub. If the environment variable \`AUTOPILOT_NO_ATTRIBUTION=1\` (or legacy \`RALPH_NO_ATTRIBUTION=1\`) is set, omit ONLY the \`copilot-ralph\` trailer; the \`Closes #N\` and \`Copilot\` trailers always ship.
    Write the commit message to a temp file in a SEPARATE shell call before running \`git commit -F\`; combining heredoc + commit in one call has historically failed silently. Prefer "cancel", "tear down", or "stop" in commit messages over forceful-action synonyms that some agent runtimes treat as trigger phrases.

11. PUSH.
    \`git push\` to origin. If push fails (no remote, auth, conflict), log it and continue; do not abort the loop on push failure.

12. CLOSE.
    \`gh issue close N --reason completed\`. The commit trailer auto-closes too, but be explicit so the close is recorded even if the push failed.

13. END THE TURN.
    Emit the literal token COMPLETE on its own line so the loop advances. If the backlog is drained, emit ABORT_NO_BACKLOG instead.

HARD RULES:
- Stay in cwd; do not edit unrelated repos.
- This loop ships NEW FEATURES only. Bug fixes, hardening, CI healing, refactors, and human-filed asks belong to the backlog-drain runner. If a \`grow-project\`-labelled issue turns out to describe a bug or non-feature task, strip its \`grow-project\` / \`proposed\` labels and skip it; pick a different proposed feature or emit ABORT_NO_BACKLOG.
- Each iteration is a paid premium request. When two proposed issues are independent and small, ship both in one iter as separate atomic commits (each through the full gate: tests green + acceptance + demo + close) rather than burning a fresh premium request on each. Do NOT shortcut the per-feature gate to fit more in.
- Do not introduce new top-level dependencies, frameworks, or build systems unless that introduction IS the feature and the rubber-duck critique justified it.
- Do not delete or rewrite the project's existing license, README, or CHANGELOG wholesale; surgical edits only.`;

// Load-time parity guards: each baked prompt must contain the
// completion token AND its corresponding abort token, otherwise the
// warnPromiseDrift call sites in handler.mjs (which point users at
// these tokens when they override completion_promise / abort_promise
// to something the prompt doesn't emit) become stale. Throwing at
// module load fails fast — the extension fails to register rather
// than silently shipping a broken prompt.
if (!PROMPT_SELF_IMPROVE.includes(COMPLETION_PROMISE) ||
    !PROMPT_SELF_IMPROVE.includes(BAKED_ABORT_TOKEN)) {
    throw new Error(
        `prompts.mjs: PROMPT_SELF_IMPROVE must contain both "${COMPLETION_PROMISE}" and "${BAKED_ABORT_TOKEN}" — the self_improve drift warning depends on this invariant.`,
    );
}
if (!PROMPT_GROW_PROJECT.includes(COMPLETION_PROMISE) ||
    !PROMPT_GROW_PROJECT.includes(BAKED_BACKLOG_ABORT_TOKEN)) {
    throw new Error(
        `prompts.mjs: PROMPT_GROW_PROJECT must contain both "${COMPLETION_PROMISE}" and "${BAKED_BACKLOG_ABORT_TOKEN}" — the grow_project drift warning depends on this invariant.`,
    );
}
