# autopilot

Autonomous iterative loop for the GitHub Copilot CLI — a standalone TUI that re-feeds the same prompt to `copilot -p ...` until the agent declares completion or a hard cap fires.

## What it is

`autopilot` is a standalone TUI app that drives the GitHub Copilot CLI through autonomous iteration loops. You arm it with a prompt — or pick one of three baked SDLC modes (`--self-improve`, `--grow-project`, `--prompt`) — and the driver re-spawns `copilot -p ...` every iteration until either the agent emits a configurable completion phrase, you call `autopilot run --stop <runId>`, or `--max` is hit.

Out-of-band control is first-class: `--pause`, `--resume`, `--stop`, and `--status` can all be invoked from a second terminal, write to the run's `state.json` under a CAS-protected lockfile, and never kill an in-flight `copilot -p` subprocess mid-iteration. Plain mode is zero-dep — only Node ≥ 20 is required to drive a loop, tail events, list runs, or replay history. The Ink-rendered watch UI for `autopilot watch` and `autopilot run` adds Ink + React + Yoga + Commander; install it via `cd packages/tui && npm install` when you want the live TTY view.

!!! tip "Bare `autopilot` runs `--self-improve --fresh`"
    Running the binary with no arguments is the same as `autopilot run --self-improve --fresh`. It starts a fresh self-improvement loop on the current repo against the baked prompt — no flags to remember on the happy path.

## Why a loop?

`autopilot` drives a coding agent through three levels of decomposition, then loops:

1. **Level 1 — find what to do.** Scan the repo (red CI, stale PRs, open issues, SDLC hardening rotation) and pick one concrete work item. If nothing is queued, ideate a new feature and file it as a GitHub issue first, then pick it up.
2. **Level 2 — split into stages.** Plan the SDLC stages this work item needs — generated per work item, not a fixed pipeline. Typical shape: orient → critique → baseline → implement → test → commit → push, but a doc fix may skip several and a feature may add more (acceptance, demo, close).
3. **Level 3 — split into tasks.** Break each stage into the smallest executable steps the agent can deliver in one turn.

Orchestrate the tasks until every stage is delivered, then loop back to **Level 1** for the next work item. Each iteration is a brand-new `copilot -p` subprocess, so context never poisons the next pass. The driver owns the spawn / capture / decide-to-stop trichotomy plus out-of-band control, structured event logs (`events.jsonl`), CAS-protected run state, completion / abort / stagnation triggers, and an adaptive iteration budget for `--self-improve`.

## Read next

- **[Quickstart](quickstart.md)** — clone, install, drive your first loop in under a minute.
- **[Concepts](concepts.md)** — completion / abort / stagnation triggers, pause-resume semantics, adaptive budget.
- **[Recipes](recipes.md)** — refactor-a-module, drain-a-backlog, long-running grow-project patterns.
- **[FAQ](faq.md)** — the questions that come up most often when running loops in anger.

## Repository

- [Source on GitHub](https://github.com/kloba/autopilot)
- [Issue tracker](https://github.com/kloba/autopilot/issues)
- [Releases](https://github.com/kloba/autopilot/releases)
