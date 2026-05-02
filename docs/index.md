# Ralph

An autonomous iterative loop for the GitHub Copilot CLI.

!!! warning "Stub documentation site"
    This site is the v0 scaffold for [issue #2](https://github.com/kloba/autopilot/issues/2). The pages below mirror the planned navigation but are intentionally short — they will be filled in by follow-up PRs.

## What is this?

Ralph turns the Copilot CLI into a self-driving iteration engine. You arm it with a prompt, and it re-fires that prompt every time the agent goes idle until either the agent emits a "done" phrase, you call `ap_stop`, or a hard cap is reached.

See the [Quickstart](quickstart.md) to get going in under a minute.

## Why a loop?

The loop is the simplest possible form of agentic autonomy: one prompt, repeated, until done — single-minded, persistent, surprisingly effective. The technique is sometimes called "Ralph" after Anthropic's original [Claude Code plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum).

## Repository

- [Source on GitHub](https://github.com/kloba/autopilot)
- [Issue tracker](https://github.com/kloba/autopilot/issues)
- [Releases](https://github.com/kloba/autopilot/releases)
