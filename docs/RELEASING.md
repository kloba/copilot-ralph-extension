# Releasing

`copilot-ralph-extension` ships as a small set of `.mjs` files copied into `~/.copilot/extensions/ralph` (or `.github/extensions/ralph` for project-scoped installs). There is **no npm publish**; releases are tagged commits on `main` plus an annotated GitHub Release page.

A formal tag-driven release-automation workflow now ships at [`.github/workflows/release.yml`](../.github/workflows/release.yml) (see issue [#10](https://github.com/kloba/copilot-ralph-extension/issues/10) for the rationale). Pushing a `vX.Y.Z` tag verifies `package.json` matches the tag, asserts a matching `CHANGELOG.md` section exists, runs `npm test`, and creates the GitHub Release with every `extension/*.mjs` attached as an asset. The manual checklist below is the fallback when the workflow is unavailable or you need to cut a release out-of-band.

## Manual release checklist

1. **Verify `main` is green**: `npm test` and the GitHub Actions CI workflow on the latest commit.
2. **Update `CHANGELOG.md`**:
   - Move entries from `## Unreleased` to a new `## X.Y.Z` heading
     (no `v` prefix, no date — matches the format used by every
     existing release section; the release workflow's
     CHANGELOG-extraction awk also accepts the equivalents
     `## [vX.Y.Z]` / `## vX.Y.Z` / `## [X.Y.Z]`, but pick the
     bare form for consistency).
   - Re-create an empty `## Unreleased` heading immediately above it for the next cycle.
   - Commit with message `Release vX.Y.Z` and the standard `Co-authored-by` trailer.
3. **Tag the release**: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push --tags`.
4. **Create a GitHub Release**:
   - Title: `vX.Y.Z`.
   - Body: paste the new `## X.Y.Z` section from `CHANGELOG.md` verbatim.
   - Attach every `.mjs` module under `extension/` as a release asset so users can pin a specific revision without cloning the repo. The full set is the same one `install.sh` copies — currently `extension.mjs`, `handler.mjs`, and `events-emit.mjs`. A drift guard in `test/extension.test.mjs` keeps `release.yml`'s asset list in sync with the directory; mirror that list here when invoking `gh release create` manually:
     ```bash
     # Extract the matching CHANGELOG block (heading-line + body up to,
     # but not including, the next "## " heading). Escapes the dots in
     # the version pattern so awk doesn't treat them as regex
     # wildcards. Replace `0.6.0` below with your actual version.
     gh release create vX.Y.Z \
       extension/extension.mjs \
       extension/handler.mjs \
       extension/events-emit.mjs \
       --title "vX.Y.Z" --notes-file <(awk '/^## X\.Y\.Z[[:space:]]*$/{p=1;next} p&&/^## /{exit} p' CHANGELOG.md)
     ```

## Versioning

We follow **Semantic Versioning**:

- **MAJOR** — breaking change to the tool surface (renamed/removed tool, removed parameter, changed default that flips loop behavior).
- **MINOR** — new tool, new optional parameter, new opt-in feature flag.
- **PATCH** — bug fix, doc-only change, internal refactor with no user-visible behavior change.

The package has zero runtime dependencies, so dependency-driven version bumps don't apply.

## Pinning a specific version (for end users)

Once a release exists with assets attached, end users can pin a specific revision. Mirror `install.sh`'s FILES list — every `.mjs` under `extension/` must be downloaded; the extension imports its modules by relative path, so a partial download will crash at module-load time:

```bash
# Project-scoped pin
mkdir -p .github/extensions/ralph
# Order matters: leaf modules first, entry point (extension.mjs) LAST —
# mirrors install.sh's FILES array and README Option A/B/D. If
# `/extensions reload` fires mid-download, this guarantees the SDK
# never sees a new `extension.mjs` importing missing/old siblings.
for f in events-emit.mjs prompts.mjs handler.mjs extension.mjs; do
  curl -L -o ".github/extensions/ralph/$f" \
    "https://github.com/kloba/copilot-ralph-extension/releases/download/vX.Y.Z/$f"
done
```

For the user-scoped equivalent, swap `.github/extensions/ralph` for `~/.copilot/extensions/ralph`.

## Hotfix branches

For an out-of-band patch when `main` has unshippable in-progress work:

1. `git checkout -b hotfix/vX.Y.Z+1 vX.Y.Z`
2. Cherry-pick the fix commit, update CHANGELOG, tag `vX.Y.Z+1`, release.
3. Merge `hotfix/vX.Y.Z+1` into `main` so the fix isn't lost.
