# Releasing

`copilot-ralph-extension` ships as the `ralph-tui` standalone TUI app. There is **no npm publish** today; releases are tagged commits on `main` plus an annotated GitHub Release page. The auto-attached source zipball / tarball is the canonical download.

A tag-driven release-automation workflow ships at [`.github/workflows/release.yml`](../.github/workflows/release.yml) (see issue [#10](https://github.com/kloba/autopilot/issues/10) for the rationale). Pushing a `vX.Y.Z` tag verifies `package.json` matches the tag, asserts a matching `CHANGELOG.md` section exists, runs `npm test` + `npm run check`, and creates the GitHub Release with the matching changelog section as the body. The manual checklist below is the fallback when the workflow is unavailable or you need to cut a release out-of-band.

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
4. **Create a GitHub Release** if the workflow is unavailable:
   ```bash
   # Extract the matching CHANGELOG block (heading-line + body up to,
   # but not including, the next "## " heading). Replace `X.Y.Z` below
   # with your actual version.
   gh release create vX.Y.Z \
     --title "vX.Y.Z" \
     --notes-file <(awk '/^## X\.Y\.Z[[:space:]]*$/{p=1;next} p&&/^## /{exit} p' CHANGELOG.md)
   ```
   The auto-attached source zipball is the canonical download; no per-file `.mjs` asset upload is needed.

## Versioning

We follow **Semantic Versioning**:

- **MAJOR** — breaking change to the `ralph-tui` CLI surface (renamed/removed subcommand or flag, removed env var, changed JSONL event shape).
- **MINOR** — new subcommand, new flag, new opt-in feature.
- **PATCH** — bug fix, doc-only change, internal refactor with no user-visible behavior change.

The non-render layer has zero runtime dependencies, so dependency-driven version bumps don't apply there. The Ink renderer's package-lock churn falls under PATCH unless a major Ink/React/Yoga upgrade changes user-visible rendering.

## Pinning a specific version (for end users)

Once a release exists, end users can pin a specific revision by checking out the matching tag:

```bash
git clone https://github.com/kloba/autopilot
cd copilot-ralph-extension
git checkout vX.Y.Z
node packages/tui/bin/tui.mjs --help
```

A future release will publish `ralph-tui` to npm so `npm i -g ralph-tui@X.Y.Z` works; until then the source checkout above is the supported install path.

## Hotfix branches

For an out-of-band patch when `main` has unshippable in-progress work:

1. `git checkout -b hotfix/vX.Y.Z+1 vX.Y.Z`
2. Cherry-pick the fix commit, update CHANGELOG, tag `vX.Y.Z+1`, release.
3. Merge `hotfix/vX.Y.Z+1` into `main` so the fix isn't lost.
