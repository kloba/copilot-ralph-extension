# Contributing

Thanks for your interest in `copilot-ralph-extension`! This page is the entry point for contributors. End-user docs live in the [README](../README.md).

## Local development setup

```bash
git clone https://github.com/kloba/autopilot.git
cd copilot-ralph-extension
npm test    # runs the node:test suite under packages/*/test (no install needed for the non-render layer)
```

The repository has **zero npm runtime dependencies** for the non-render layer (`prompts.mjs`, `runner.mjs`, `events*.mjs`, `writer.mjs`, `tail.mjs`, `plain.mjs`, `bin/tui.mjs`). `npm install` is only required when developing the Ink-rendered watch / run UI:

```bash
cd packages/tui && npm install   # pulls Ink + React + Yoga + Commander
```

## Running autopilot locally

For day-to-day iteration:

```bash
# From the repo root, no install needed for plain mode:
node packages/tui/bin/tui.mjs run --self-improve --fresh --max 5

# Watch the live timeline in another terminal:
node packages/tui/bin/tui.mjs watch
```

## Style conventions

- **Source files**: pure ESM under `packages/tui/src/` and `packages/tui/bin/`. Keep the non-render modules dependency-free; only the Ink renderer depends on user-space packages.
- **No third-party deps in the non-render layer.** New runtime dependencies require a strong justification (security review, zero-fork ecosystem cost, etc.).
- **Comments**: only where context is non-obvious. The codebase already uses comments to explain *why* (rationale, edge cases, prompt-injection guards) rather than *what*.
- **Formatting**: 4-space indentation, trailing commas in multi-line literals, double-quoted strings.
- **Tests**: every behavior change adds or updates a test in `packages/tui/test/*.test.mjs`. The runner suite uses a Node-script "fake copilot" shim parameterised by a `SCRIPT` env var.

## Commit trailer rules

Every commit MUST include both `Co-authored-by` trailers in this order:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Co-authored-by: copilot-ralph <noreply+copilot-ralph@github.com>
```

The first attributes the underlying Copilot model; the second attributes the loop that executed the iteration. Order matters — GitHub surfaces the first co-author more prominently. See the [README "Commit attribution" section](../README.md#commit-attribution) and [CHANGELOG](../CHANGELOG.md) for full rationale and opt-out (`RALPH_NO_ATTRIBUTION=1`).

## Pull request expectations

- `npm test` is green locally and in CI.
- The PR description references the issue (`Fixes #N`) so it auto-closes on merge.
- For user-visible changes, append a one-line entry to the **Unreleased** section of [`CHANGELOG.md`](../CHANGELOG.md).
- README and `docs/ARCHITECTURE.md` are updated when the change affects user-facing behavior or the architectural shape.
- Surgical commits are preferred over rebases-of-rebases; do not force-push `main`.

## Releasing

See [`docs/RELEASING.md`](RELEASING.md) for the tag-driven release checklist.

## Reporting security issues

See [`SECURITY.md`](../SECURITY.md) for the private disclosure process.
