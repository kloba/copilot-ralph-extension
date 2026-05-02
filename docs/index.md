# Ralph

A Ralph Wiggum-style autonomous loop for the GitHub Copilot CLI, packaged as the `ralph-tui` standalone TUI app.

!!! warning "Stub documentation site"
    This site is the v0 scaffold for [issue #2](https://github.com/kloba/autopilot/issues/2). The pages below mirror the planned navigation but are intentionally short — they will be filled in by follow-up PRs.

## What is this?

Ralph turns the Copilot CLI into a self-driving iteration engine. You arm it with a prompt (or pick one of the baked SDLC modes — `--self-improve`, `--grow-project`), and the driver re-spawns `copilot -p ...` every iteration until either the agent emits a "done" phrase, you call `ralph-tui run --stop`, or a hard cap is reached.

See the [Quickstart](quickstart.md) to get going in under a minute.

## Why "Ralph"?

The loop is the simplest possible form of agentic autonomy: one prompt, repeated, until done. Like Ralph Wiggum eating glue — single-minded, persistent, surprisingly effective.

## Repository

- [Source on GitHub](https://github.com/kloba/autopilot)
- [Issue tracker](https://github.com/kloba/autopilot/issues)
- [Releases](https://github.com/kloba/autopilot/releases)
