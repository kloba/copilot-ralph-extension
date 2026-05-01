# Releasing

`copilot-ralph-extension` ships as a small set of `.mjs` files copied into `~/.copilot/extensions/ralph` (or `.github/extensions/ralph` for project-scoped installs). There is **no npm publish**; releases are tagged commits on `main` plus an annotated GitHub Release page.

A formal tag-driven release-automation workflow is tracked in issue [#10](https://github.com/kloba/copilot-ralph-extension/issues/10). Until that ships, the steps below are the manual checklist.

## Manual release checklist

1. **Verify `main` is green**: `npm test` and the GitHub Actions CI workflow on the latest commit.
2. **Update `CHANGELOG.md`**:
   - Move entries from `## Unreleased` to a new `## [vX.Y.Z] - YYYY-MM-DD` heading.
   - Re-create an empty `## Unreleased` heading immediately above it for the next cycle.
   - Commit with message `Release vX.Y.Z` and the standard `Co-authored-by` trailer.
3. **Tag the release**: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push --tags`.
4. **Create a GitHub Release**:
   - Title: `vX.Y.Z`.
   - Body: paste the new `## [vX.Y.Z]` section from `CHANGELOG.md` verbatim.
   - Attach `extension/extension.mjs` and `extension/handler.mjs` as release assets so users can pin a specific revision without cloning the repo:
     ```bash
     gh release create vX.Y.Z extension/extension.mjs extension/handler.mjs \
       --title "vX.Y.Z" --notes-file <(awk '/^## \[vX.Y.Z\]/,/^## \[/' CHANGELOG.md | sed '$d')
     ```

## Versioning

We follow **Semantic Versioning**:

- **MAJOR** — breaking change to the tool surface (renamed/removed tool, removed parameter, changed default that flips loop behavior).
- **MINOR** — new tool, new optional parameter, new opt-in feature flag.
- **PATCH** — bug fix, doc-only change, internal refactor with no user-visible behavior change.

The package has zero runtime dependencies, so dependency-driven version bumps don't apply.

## Pinning a specific version (for end users)

Once a release exists with assets attached, end users can pin a specific revision:

```bash
# Project-scoped pin
mkdir -p .github/extensions/ralph
curl -L -o .github/extensions/ralph/extension.mjs \
  https://github.com/kloba/copilot-ralph-extension/releases/download/vX.Y.Z/extension.mjs
curl -L -o .github/extensions/ralph/handler.mjs \
  https://github.com/kloba/copilot-ralph-extension/releases/download/vX.Y.Z/handler.mjs
```

For the user-scoped equivalent, swap `.github/extensions/ralph` for `~/.copilot/extensions/ralph`.

## Hotfix branches

For an out-of-band patch when `main` has unshippable in-progress work:

1. `git checkout -b hotfix/vX.Y.Z+1 vX.Y.Z`
2. Cherry-pick the fix commit, update CHANGELOG, tag `vX.Y.Z+1`, release.
3. Merge `hotfix/vX.Y.Z+1` into `main` so the fix isn't lost.
