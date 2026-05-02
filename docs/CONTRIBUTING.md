# Contributing

Thanks for your interest in `autopilot`! This page is the entry point for contributors. End-user docs live in the [README](../README.md).

## Local development setup

```bash
git clone https://github.com/kloba/autopilot.git
cd autopilot
npm test    # runs the node:test suite under test/ (no install needed — zero runtime deps)
```

The repository has **zero npm runtime dependencies** and only Node ≥ 20's built-ins (`node:test`, `node:assert`, `node:child_process`). `npm install` is not required to run the test suite.

## Running the extension locally against Copilot CLI

For day-to-day iteration, prefer a **project-scoped** install so your `git checkout` is the live source the CLI loads:

```bash
./install.sh --project   # installs into .github/extensions/autopilot in this repo
```

After editing `extension/handler.mjs`, run `extensions_reload` from inside Copilot CLI (or restart the CLI) — new tool definitions are picked up immediately.

For a user-scoped install (loads the same extension across all your repos):

```bash
./install.sh             # default: ~/.copilot/extensions/autopilot
./install.sh --dry-run   # show what would be copied without writing
```

## Style conventions

- **Source files**: `extension/extension.mjs` (SDK glue, ~30 lines) and `extension/handler.mjs` (controller, ~2.5kLOC). Keep the SDK layer thin — all logic that needs unit-testing belongs in `handler.mjs` so it can be exercised against a fake session.
- **No third-party deps.** New runtime dependencies require a strong justification (security review, zero-fork ecosystem cost, etc.). Prefer Node built-ins.
- **Comments**: only where context is non-obvious. The codebase already uses comments to explain *why* (rationale, edge cases, prompt-injection guards) rather than *what*.
- **Formatting**: 4-space indentation, trailing commas in multi-line literals, double-quoted strings.
- **Tests**: every behavior change adds or updates a test in `test/extension.test.mjs`. Use the existing `makeFakeSession` / `runTurn` / `arm` helpers — they exercise the controller through the same event surface the SDK uses.

## Commit trailer rules

Every commit MUST include both `Co-authored-by` trailers in this order:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Co-authored-by: copilot-ralph <noreply+copilot-ralph@github.com>
```

The first attributes the underlying Copilot model; the second attributes the loop that executed the iteration. Order matters — GitHub surfaces the first co-author more prominently. See the [README "Commit attribution" section](../README.md#commit-attribution) and [CHANGELOG](../CHANGELOG.md) for full rationale and opt-out (`AUTOPILOT_NO_ATTRIBUTION=1`).

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
