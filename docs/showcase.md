# Showcase

A landing pad for autopilot in the wild — recorded loops, live screenshots of `autopilot watch`, and projects that have been built or maintained end-to-end by a `--self-improve` / `--grow-project` run. The page is deliberately seeded short while the corpus grows; community submissions are very welcome.

## What lands here

We curate three formats, each with a short preface naming the repo, the run length, and the outcome:

- **Asciinema casts** of long autonomous runs, recorded with `asciinema rec --command 'autopilot run --self-improve --fresh'`. `--plain` auto-engages off-TTY so the cast stays grep-friendly.
- **Screenshots** of `autopilot watch` mid-iteration — the **Header** (runId, iter / max, elapsed, finish-reason banner), **Timeline** (per-iter status dots + finish reasons), and the **DetailPane** (selected iter's stages, sub-stages, tail-of-tail Copilot stream, last commit hash).
- **Real-world projects** that autopilot built or maintained, with a one-line outcome — e.g. *"32-iter `--grow-project` run shipped the v0 issue tracker; 11 PRs merged, 0 reverts"*.

## Sample run

*Illustrative excerpt — see `autopilot replay <runId>` for live transcripts.*

```text
$ autopilot run --self-improve --fresh --max 50
[armed] runId=self-improve-2026-04-30T12-04-11Z mode=self-improve max=50

[iter 1/50] ORIENT
  read recent commits (12), AGENTS.md, README.md
  detected test command: npm test
[iter 1/50] IDEATE
  candidates: red CI on packages/tui (1) · stale PR #87 · 4 open issues
  picked: fix flaky watch.test.mjs (issue #91)
[iter 1/50] CRITIQUE → BASELINE → IMPLEMENT … (no commit yet)

[iter 2/50] IMPLEMENT → TEST
  npm test … 412 pass, 0 fail (7.4s)

[iter 3/50] COMMIT
  abc1234 fix(watch): drop racy stdout assertion in tail-resume test
    Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
    Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>
[iter 3/50] PUSH ok (origin/main)

[iter 4/50] ORIENT
  no red CI · no stale PR · 3 open issues
  picked: rotate SDLC hardening — docs/showcase.md is a stub

[iter 5/50] END
  emitted: COMPLETE
  reason: completion_promise
  iters=5 elapsed=4m11s commits=1 pushes=1
```

The runner records every line above (and far more — sub-agent fan-out, token totals, premium-request counts) into `~/.copilot/ralph-tui/runs/<runId>/events.jsonl`. Re-render any past run with `autopilot replay <runId>` or tail a live one with `autopilot watch`.

## Want to share your run?

Got a long `autopilot` loop that did something interesting? [File an issue](https://github.com/kloba/autopilot/issues/new) with:

- The `runId` (visible in `autopilot list`).
- Repo + branch the loop drove (link if public).
- Iter count, elapsed time, finish reason (`completion_promise` / `abort_promise` / `user_stopped` / `stagnation` / adaptive-extension landed).
- One-line outcome — what the loop actually shipped.
- Optional asciinema link or watch-screenshot for the cast / image gallery.

Anything from a 3-iter typo fix to a multi-hour `--grow-project` backlog drain is fair game — the goal is a corpus of real loops people can point at when explaining what "Ralph Wiggum-style autonomy" looks like in practice.
