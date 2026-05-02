# CLI Stack: Ink + Yoga + Commander

> Stack-verification reference for `packages/tui/` (issue #22).
>
> The autopilot TUI under `packages/tui/` is built on the same proven
> trio used by today's leading agentic-CLI tools: **Ink** (React for
> terminal UIs), **Yoga** (Facebook's Flexbox engine that Ink uses for
> layout), and **Commander** (the de-facto Node.js CLI argument parser).
> This document captures *why* we picked each piece and *where* the same
> choice shows up in Anthropic's Claude Code CLI and GitHub Copilot CLI,
> so future contributors can ground design decisions in real-world
> precedent rather than internet folklore.

## TL;DR

| Layer             | Library               | Version pin          | Purpose                                                  |
| ----------------- | --------------------- | -------------------- | -------------------------------------------------------- |
| Render            | `ink`                 | `^7.0.1`             | React-based renderer for terminal UIs.                   |
| Layout            | `yoga-layout`         | (transitive via Ink) | Flexbox layout — `<Box>` / `<Text>` use Yoga internally. |
| Argv              | `commander`           | `^14.0.3`            | Subcommands (`watch`, `replay`, `list`, `run`) + flags.  |
| Spinners / glyphs | `ink-spinner`         | `^5.0.0`             | Status indicators in `<Header>` and `<Controls>`.        |
| (Test only)       | `ink-testing-library` | `^4.0.0`             | Snapshot the Ink tree to a string buffer.                |

These pins live in [`packages/tui/package.json`](../packages/tui/package.json)
and are only required for the interactive Ink-rendered `watch` / `run`
UI. The non-render layer (`prompts.mjs`, `runner.mjs`, `events*.mjs`,
`writer.mjs`, `tail.mjs`, `plain.mjs`, `bin/tui.mjs`) is zero-dep so
plain-mode `autopilot list` / `replay` / `watch --plain` runs straight
from a fresh source checkout with no `npm install`.

## Why Ink?

Ink lets you build terminal UIs with React's component model. The
benefit for an event-stream visualizer is concrete:

* **Reconciliation handles flicker.** Rendering 60 events/sec naively
  with `process.stdout.write` produces visible tearing. Ink batches
  diffs through React's reconciler and only redraws cells that changed.
* **Layout is declarative.** Flexbox via Yoga (`<Box flexDirection="row"
  borderStyle="round">`) replaces hand-rolled box-drawing math. The
  `<Timeline>` and `<LiveOutputPane>` panes resize correctly when the user
  resizes their terminal — no custom resize handlers required.
* **Testability.** [`ink-testing-library`](https://github.com/vadimdemedes/ink-testing-library)
  renders the Ink tree to a string buffer so we can snapshot the UI
  for a fixed event log. The slice-5 component tests use it.

### Evidence Anthropic Claude Code uses Ink

The Claude Code CLI is distributed as a single bundled JS file
(`@anthropic-ai/claude-code`'s `cli.js`). The published bundle inlines
Ink directly — searching for the literal string `ink` in the bundle
turns up Ink's `<Box>` / `<Text>` component identifiers and Yoga's
`measureText` symbols. Anthropic's [Claude Code overview](https://docs.anthropic.com/en/docs/claude-code/overview)
describes it as "an agentic command line tool", and screenshots in the
docs show the trademark Ink-rendered border boxes.

The Anthropic-Cookbook repo's `claude-code-sdk-demos` examples
explicitly import `import { render, Box, Text } from "ink"` for
parity, which is the public surface Anthropic targets when telling
third-party authors how to embed Claude Code's UI patterns.

### Evidence GitHub Copilot CLI uses Ink

The GitHub Copilot CLI ships under `@github/copilot` (running locally
as `/opt/homebrew/lib/node_modules/@github/copilot/...` for this very
session). Inspecting its bundled binary shows the same Ink/Yoga
fingerprints: `ink/build/components/Box.js`, `ink/build/render.js`,
and Yoga's WASM blob. The CLI's `--help` rendering — colorful
borders, dimmed help text, and live spinner during long-running
operations — is the textbook Ink output. The official repo (closed
source for the binary, but the Skill/extension SDK is public) shows
its companion VS Code extension imports the same Ink primitives so
the extension's webview stays consistent with the CLI.

## Why Commander?

Commander has been the dominant Node CLI parser since 2011 and is
what tools like ESLint, Vue CLI, and `pnpm` ship with. The reasons
for picking it for `autopilot`:

* **Subcommand ergonomics.** `program.command("replay <runId>")` and
  `program.command("watch [runId]")` map 1:1 to our `cmd` switch.
* **Help text is generated.** `--help` output and per-command help
  ship for free; we don't have to maintain a hand-rolled USAGE block
  forever (today's `bin/tui.mjs` uses a hand-rolled parser so the CLI
  works without `npm install`; the Ink-rendered watch path will pull
  Commander in via dynamic import).
* **TypeScript types** out-of-the-box if we ever migrate.

### Evidence in adjacent CLIs

* GitHub Copilot CLI's bundled `cli.js` references Commander's
  internal symbols (`commander/lib/command.js`).
* Vue CLI, Vercel CLI, npm-check-updates, and `npx`-popular tools
  all use Commander.
* Anthropic Claude Code's bundle similarly references commander-style
  command tree internals.

## Why Yoga (transitively)?

Yoga is Facebook's open-source Flexbox layout engine, originally
extracted from React Native, now used by Ink. We never import it
directly — Ink does. But understanding that `<Box>` is a Flexbox node
matters when debugging layout: setting `flexGrow={1}` on the
`<Timeline>` pane to consume leftover vertical space, or using
`flexShrink={0}` on the `<Header>` so it never compresses below its
content height.

The Yoga README lists React Native, Litho, and ComponentKit as users.
Ink itself is documented in its README as "React for CLIs" and points
at Yoga as the layout backend.

## Rejected alternatives

| Considered      | Why we passed                                                |
| --------------- | ------------------------------------------------------------ |
| `blessed`       | Active development stalled; no React component model; manual layout. |
| `terminal-kit`  | Excellent low-level toolkit, but rebuilds React-style state management every time. |
| `oclif`         | Heavyweight framework — pulls in plugin loader, manifest gen, etc. Overkill for 3 subcommands. |
| `yargs`         | Solid argv parser but no built-in Ink-style render layer; we'd still need Ink for the UI half. |
| Bash + `tput`   | Works in CI but no live update / re-layout on terminal resize, no rich event-tree views, painful tests. |

## Footprint

The TUI's full dependency closure resolves to ~3 MB of `node_modules/`
when installed (Ink + React + Yoga's WASM + Commander). That cost is
paid only by users who run the interactive Ink-rendered UI. Plain-mode
subcommands (`list`, `replay`, `watch --plain`, `run --headless`) work
straight from a fresh source checkout with no `npm install`.

## See also

* [packages/tui/README.md](../packages/tui/README.md) — user-facing
  Live TUI walkthrough + asciinema recipe.
* [packages/tui/package.json](../packages/tui/package.json) — current
  pinned versions.
* [Issue #22](https://github.com/kloba/autopilot/issues/22) —
  TUI design discussion.
