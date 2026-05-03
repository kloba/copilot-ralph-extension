# autopilot

> Autonomous iterative loop for **GitHub Copilot CLI** and **Claude Code**, packaged as the `autopilot` standalone TUI app.

[![CI](https://github.com/kloba/autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/kloba/autopilot/actions/workflows/ci.yml)

![`autopilot watch` rendering a self-improve run mid-IMPLEMENT, with stages, tasks, activity, and timeline panes](docs/images/autopilot-watch.jpg)

> Above: `autopilot watch <runId>` tailing a `--self-improve` run on iter 1/10 — IDEATE/CRITIQUE/BASELINE stages green, IMPLEMENT in flight on open issue #105, with sub-task ticks, recent tool calls (`grep` / `view`), and the per-iter timeline rendered side-by-side.

## How it works

`autopilot` drives a coding agent through three levels of decomposition, then loops:

1. **Level 1 — find what to do.** Scan the repo (red CI, stale PRs, open issues, SDLC hardening rotation) and pick **one** concrete work item. If nothing is queued, ideate a new feature and file it as a GitHub issue first, then pick it up.
2. **Level 2 — split into stages.** Plan the SDLC stages this work item needs — generated **per work item**, not a fixed pipeline. Typical shape: orient → critique → baseline → implement → test → commit → push, but a doc fix may skip several and a feature may add more (acceptance, demo, close).
3. **Level 3 — split into tasks.** Break each stage into the smallest executable steps the agent can deliver in one turn.

Orchestrate the tasks until every stage is delivered, then loop back to **Level 1** for the next work item. The driver runs unattended until the agent emits `COMPLETE` / `ABORT_NO_IMPROVEMENTS` or hits the iteration cap.

## Install

```bash
git clone https://github.com/kloba/autopilot
cd autopilot/packages/tui && npm install && npm link
autopilot --help
```

## Usage

```bash
# Bare invocation — self-improve loop, fresh context per work item.
autopilot

# Drive each iter with Claude Code instead of Copilot.
autopilot claude

# Grow a backlog of GitHub issues with a focus area.
autopilot run --grow-project --focus "autopilot replay UX"

# Custom prompt — re-fed verbatim every iter until COMPLETE.
autopilot run --prompt "Refactor packages/tui/src/runner.mjs and add tests. Emit COMPLETE when green."
```

See [`docs/quickstart.md`](docs/quickstart.md) for the full first-run walkthrough.

## Documentation

The live site is at **<https://kloba.github.io/autopilot/>** and built from [`docs/`](docs/):

- [`quickstart.md`](docs/quickstart.md) — first run in under a minute.
- [`concepts.md`](docs/concepts.md) — run lifecycle, JSONL event model, pause/resume, adaptive budget.
- [`configuration.md`](docs/configuration.md) — subcommands, flags, env vars, commit attribution, caffeinate, requirements, limitations.
- [`recipes.md`](docs/recipes.md) — task-shaped how-tos (self-improve, grow-project, custom prompt).
- [`cli-stack.md`](docs/cli-stack.md) — how `autopilot` sits on top of Copilot / Claude Code.
- [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) — out-of-session driver, baked-prompt pattern, JSONL contract.
- [`faq.md`](docs/faq.md) — recurring questions.
- [`CONTRIBUTING.md`](docs/CONTRIBUTING.md) — local dev setup, style, PR expectations.

[`SECURITY.md`](SECURITY.md) covers vulnerability reporting. [`CHANGELOG.md`](CHANGELOG.md) is the per-release behavior log.

## License

MIT

## Long-haul cost example

![Long-haul `autopilot` session showing 2,640 premium requests over 9h 48m 20s](docs/images/9h-session-copilot-ralph.jpg)

> Long-haul autonomous loops can be **slow and costly**: this captured
> `copilot --resume` session ran for 9h 48m 20s, consumed 2,640
> premium requests, and streamed hundreds of millions of cached tokens.
> Start with small `--max` / `--min` caps and watch usage before
> leaving a run unattended.
