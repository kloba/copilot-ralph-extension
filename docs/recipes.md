# Recipes

Four worked scenarios that map common autopilot use-cases to exact invocations and the timeline you should expect. Each recipe is independent — pick the one that matches your situation and copy the `Command:` block verbatim.

The recipes assume `autopilot` is on `$PATH`. If you're running from a source checkout, swap `autopilot` for `node packages/tui/bin/tui.mjs` — the flags are identical. See the [Quickstart](quickstart.md) for install paths. Open a second terminal alongside any of these and run `autopilot watch` to tail the live event stream — every recipe assumes you're checking the renderer (or the JSONL log under `~/.copilot/autopilot/runs/<runId>/events.jsonl`) for surprises.

## Recipe 1: Refactor a module until tests pass

**Use when:** you know the file you want changed and you want autopilot to keep
editing-and-testing until the suite is green. Best for targeted refactors with
a clear success signal — one file, one outcome, hard cap on the budget so you
don't burn iterations on scope creep.

**Command:**

```bash
autopilot run --prompt "Refactor packages/tui/src/runner.mjs to extract the iter-loop body into a separate function. Keep behavior identical. Run \`npm test\` between edits and emit COMPLETE when 100% green." --fresh --max 20
```

**Timeline:**

- **Iter 1** — agent reads the target file, runs the existing test suite to
  baseline, drafts an extraction plan. Usually no source edits yet — just a
  recon pass. Tail with `autopilot watch` to confirm it didn't quote
  `COMPLETE` mid-thought (substring matching is permissive — see
  [FAQ → Why did my loop stop after exactly one iteration?](faq.md#why-did-my-loop-stop-after-exactly-one-iteration)).
- **Iter 2–5** — agent makes the extraction in small batches: pull out one
  helper, re-run `npm test`, fix a regression, commit, repeat. Expect 1–2
  commits per iter with dual `Co-authored-by:` trailers and a
  conventional-commit prefix the agent picks from `git log` history.
- **Iter 6** — once the helper is fully extracted and the test suite is back
  to green, the agent emits `COMPLETE` on its own line. The driver matches
  the literal token, writes a terminal `result` event with
  `terminationReason: "completion_promise"`, and exits.
- **Done** — confirm with `autopilot replay <runId> | tail -20`. The working
  tree should have a single coherent set of commits ahead of origin; push
  when satisfied.

**Variations:**

- Swap `--fresh` for `--continue` if the refactor needs the agent to remember
  earlier exploration (e.g. a tour of upstream callers it ran in iter 1).
  Caveat: `--continue` accumulates Copilot session context, so token costs
  grow per iter and a long-running session can drift.
- Lower `--max` to `5` for a single-pass attempt — the driver aborts with
  `reason: "max_iterations"` and you can inspect the partial diff before
  retrying with a sharper prompt.
- Pick a less-quotable completion token to avoid premature self-triggering:
  `--completion-promise REFACTOR_DONE_42` is much harder for the agent to
  mention casually than the default `COMPLETE`.

## Recipe 2: Walk a backlog issue-by-issue

**Use when:** you've already populated a project backlog (open GitHub issues
with the `proposed` or `grow-project` label) and want autopilot to drain it
one feature at a time. Best for medium-scope projects where you've sketched
the work in advance and want a steady, reviewable cadence of one shipped
feature per iteration.

**Command:**

```bash
autopilot run --grow-project --continue --max 30
```

**Timeline:**

- **Iter 1** — agent runs ORIENT (read recent commits, detect the test
  command, scan the working tree), then SELECT (pick the highest-priority
  unfinished `proposed` issue from the backlog). If the backlog is empty on a
  fresh project, iter 1 instead runs IDEATE and seeds it via
  `gh issue create --label grow-project --label proposed` with
  `acceptance_criteria` checklists and `demo_command` blocks. Make sure
  `gh auth status` succeeds before arming the loop — without auth, the very
  first `gh issue list` call fails and the agent burns iterations recovering.
- **Iter 2–N** — each iter walks the thirteen-stage grow-project flow:
  SELECT one issue → CRITIQUE → BASELINE → IMPLEMENT → TEST →
  ACCEPTANCE (every checkbox in the issue's `acceptance_criteria` block
  must pass) → DEMO (run the issue's `demo_command` and paste the output
  back as a comment) → COMMIT (with `Closes #N`) → PUSH → CLOSE. One
  commit per iter, one issue closed per iter, dual `Co-authored-by:`
  trailers on every commit.
- **Done** — when no `proposed` issues remain, the agent emits
  `ABORT_NO_BACKLOG`; the driver writes a terminal `abort` event with
  `reason: "abort_promise"`. To verify the backlog actually drained (and the
  agent didn't just give up early), run
  `gh issue list --label grow-project --state open --label proposed` — the
  list should be empty. If anything is still open, the agent skipped it;
  reopen the run with `--continue` and a tighter `--focus`.

**Variations:**

- Scope a single area with `--focus "specific area"` — e.g.
  `--focus "live-output panel"` causes IDEATE to bias the backlog toward UI
  work and SELECT to prefer matching issues. The focus suffix is appended to
  the baked SDLC prompt (max 2000 chars) and is ignored when `--prompt` is set.
- Swap `--continue` for `--fresh` if the agent's accumulated context starts
  to drift onto closed issues. Each iter's selection re-reads `gh issue list`
  from scratch in `--fresh`, so the only state across iters is the issues
  themselves.
- Pause mid-run with `autopilot run --pause <runId>` to review the diff
  before more issues land; the iter counter survives the pause and
  `--resume` continues at the next iter boundary.

## Recipe 3: Self-improve a project across SDLC categories

**Use when:** you want to harden a mature project by sweeping across the full
SDLC — failing CI runs, stale PRs, open human-filed issues, and latent
improvements (missing tests, docs/code drift, refactor candidates, dead
code) — without writing a per-issue prompt. Best for projects that have a
healthy issue tracker and CI but accumulated drift over time.

**Command:**

```bash
autopilot run --self-improve --fresh --max 50
```

**Timeline:**

- **Iter 1** — ORIENT reads recent commits and project docs, detects the
  test command (`npm test`, `pytest`, `go test`, etc.). IDEATE picks ONE
  concrete change with strict tier ordering:
    - **Tier (a) — red CI:** the most recent failing run on the default
      branch is the unconditional first pick.
    - **Tier (b) — stale PRs:** open, not authored by you, no recent activity.
    - **Tier (c) — human-filed issues:** open issues without the
      `grow-project` / `proposed` label (i.e. raised by humans, not by a
      previous grow-project IDEATE).
    - **Tier (d) — SDLC-hardening drift:** missing tests, doc/code
      mismatch, dead code, accumulated lint debt. Only chosen when
      (a)–(c) are empty.
- **Iter 2–N** — each iter rotates through the same four-tier ladder but
  **avoids repeating the SDLC category used in the previous 2–3 commits**
  (baked into `PROMPT_SELF_IMPROVE`), so a long run touches several areas
  instead of grinding the same one. Expect 1 commit + 1 push per iter,
  conventional-commit prefix matching the tier.
- **Done** — when honest investigation shows no actionable backlog item AND
  no genuine user-visible improvement, the agent emits
  `ABORT_NO_IMPROVEMENTS`; the driver writes a terminal `abort` event with
  `reason: "abort_promise"`. The token deliberately rejects defensive-guard
  / comment-alignment / format-string churn as acceptable iter output — see
  the `ABORT_NO_IMPROVEMENTS CONTRACT` block in
  [`packages/tui/src/prompts.mjs`](https://github.com/kloba/autopilot/blob/main/packages/tui/src/prompts.mjs)
  for the full ruleset.

**Variations:**

- Cap the budget low (`--max 10`) for a single sweep — useful before a
  release to clear obvious drift without committing to a long autonomous
  session.
- Raise it for an overnight run (`--max 100`+) and wrap with
  `caffeinate -i autopilot run --self-improve --fresh --max 100` on macOS so
  idle-sleep doesn't stall the loop, or set `AUTOPILOT_CAFFEINATE=1` so the
  runner spawns it for you. See README →
  [Keep system awake](https://github.com/kloba/autopilot#keep-system-awake-caffeinate-macos).
- Swap `--fresh` for `--continue` if you want the agent to remember which
  SDLC categories it already touched (the rotation rule then has cross-iter
  context). Most projects work better with `--fresh` because each iter's
  investigation is independent.
- Opt out of the second `Co-authored-by:` trailer with
  `RALPH_NO_ATTRIBUTION=1 autopilot run --self-improve --fresh` — the prompt
  reads the env var during COMMIT and omits the `copilot-ralph` line.

## Recipe 4: Long-running grow-project with adaptive budget

**Use when:** you're planning + draining a large feature and want a base
iteration cap that **automatically extends** if progress signals stay
positive — the working tree shows uncommitted changes, or recent iter
responses are not byte-identical. Best for week-long projects where you
don't know up front how many iters the work will take.

**Command:**

```bash
autopilot run --grow-project --focus "live-output panel for autopilot watch" \
  --continue --max 30 --adaptive-extension 20 --adaptive-max-total 100
```

**Timeline:**

- **Iter 1–30 (base budget)** — iter 1 IDEATE seeds a focused backlog
  (`gh issue create --label grow-project --label proposed` with titles
  biased by `--focus`); iters 2–30 each SELECT one issue, ship it, close it.
  Watch progress with `autopilot watch` — non-stagnant responses + a dirty
  working tree are the two signals the runner samples at the iter boundary.
  State (iter counter, captured Copilot session id, pause/stop flags) is
  persisted to `state.json` under the runs root and CAS-protected by a
  per-run lockfile so concurrent `--pause` + `--stop` don't lose updates.
- **Hits `--max 30`** — instead of aborting, the runner evaluates progress
  signals. If the last few iters are not byte-identical AND/OR the working
  tree has uncommitted changes, it grants `--adaptive-extension 20` more
  iterations and continues. The extension is logged in the event stream so
  `autopilot replay <runId>` shows exactly where the boundary was crossed
  and which signals fired.
- **Compounds to a hard ceiling** — successive extensions compound up to
  `--adaptive-max-total 100`. After that, no further extensions are granted
  regardless of signals; the loop terminates with `reason: "max_iterations"`
  if the agent hasn't already emitted a completion or abort token. See
  [`packages/tui/src/runner.mjs`](https://github.com/kloba/autopilot/blob/main/packages/tui/src/runner.mjs)
  for the signal-evaluation and ceiling rules.
- **Done** — terminates on whichever comes first:
    - `ABORT_NO_BACKLOG` — clean ending, no `proposed` issues remain
      (`reason: "abort_promise"`).
    - The 100-iter ceiling — adaptive cap reached
      (`reason: "max_iterations"`).
    - Stagnation — three byte-identical iter responses in a row
      (`reason: "stagnation"`; see
      [Concepts → Stagnation detection](concepts.md#stagnation-detection)).
      Stagnation overrides `min_iterations` as a safety floor.
    - User stop — you ran `autopilot run --stop <runId>` from another
      terminal (`reason: "user_stopped"`).

**Variations:**

- Swap `--continue` for `--fresh` if the working tree starts to drift
  across loosely-related issues — each iter re-reads `gh issue list`
  instead of relying on accumulated session context. The pause/resume
  state survives the swap, but the captured Copilot session id is dropped.
- Raise the adaptive ceiling (`--adaptive-max-total 200`) for week-long
  projects, and pair with `AUTOPILOT_CAFFEINATE=1` so idle-sleep doesn't
  stall the loop overnight on macOS. The legacy `RALPH_TUI_*` aliases are
  still honored if you're migrating from an older install.
- Pause-and-checkpoint mid-run with `autopilot run --pause <runId>`,
  inspect the diff, run extra tests by hand, then
  `autopilot run --resume <runId>` when ready. The iter counter,
  adaptive-extension state, and Copilot session id all persist across
  the pause boundary. `autopilot run --status <runId>` prints a
  structured snapshot at any time.
- Override the runs root with
  `AUTOPILOT_RUNS_DIR=/path/to/runs autopilot run --grow-project ...` for
  CI or for a project-scoped state dir. Legacy `RALPH_TUI_RUNS_DIR` still
  works as a fallback.

## Where next?

- **[Quickstart](quickstart.md)** — install paths, the binary entrypoint,
  and a one-minute first run.
- **[Concepts](concepts.md)** — the subprocess-per-iter model, completion
  / abort triggers, pause/resume semantics, stagnation detection, and the
  adaptive-budget signal rules.
- **[FAQ](faq.md)** — short answers to the gotchas these recipes
  implicitly avoid (early `COMPLETE` self-trigger, attribution opt-out,
  where the event log lives, how to stop a runaway loop).
