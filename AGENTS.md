# AGENTS.md — Development Guide for Humans and AI Agents

This file is the authoritative process guide for anyone (human or AI) making
changes to **copilot-ralph-extension**. It pins the three conventions that
keep the project releasable without drama: **Semantic Versioning** for the
public surface, **Keep a Changelog** for `CHANGELOG.md`, and **Conventional
Commits** for git history. Together they let us cut a release by tagging
`vX.Y.Z` and let tooling generate the changelog body from commits alone.

> Scope: applies to all code under `extension/`, `packages/`, `test/`, and the
> repo's CI/release workflows. Docs-only edits under `docs/` and README still
> follow the commit convention but are exempt from version bumps.

---

## 1. Semantic Versioning (SemVer 2.0.0)

The version in `package.json` is the **single source of truth**. Tags MUST
match (`v` + version) — the release workflow at
`.github/workflows/release.yml` enforces this.

Given a version `MAJOR.MINOR.PATCH`:

| Bump  | Trigger                                                                                  |
| ----- | ---------------------------------------------------------------------------------------- |
| MAJOR | Breaking change in a tool's signature, the Copilot CLI SDK contract, or a removed tool. |
| MINOR | New tool, new capability, or any backwards-compatible feature.                           |
| PATCH | Bug fix, prompt tweak, doc-only change to runtime behavior, internal refactor.           |

**Pre-1.0 caveat**: while we're at `0.x`, MINOR may include breaking changes —
but only if explicitly called out in `CHANGELOG.md` under a `### Breaking`
section.

When in doubt, bump the higher one. Users pin via tagged GitHub Releases
(see issue #10), so a too-conservative bump silently breaks pinned installs.

---

## 2. Conventional Commits

Every commit on `main` MUST follow [Conventional Commits 1.0.0][cc]. This is
what makes automated changelog generation possible.

```
<type>(<scope>): <short imperative summary>

<optional body — wrap at 72 chars, explain WHY, not WHAT>

<optional footer(s)>
```

### Allowed types

| Type       | Use for                                            | Bumps  |
| ---------- | -------------------------------------------------- | ------ |
| `feat`     | New tool, new capability, new prompt section.      | MINOR  |
| `fix`      | Bug fix in runtime / prompt / install path.        | PATCH  |
| `docs`     | README, AGENTS.md, ARCHITECTURE, code comments.    | none   |
| `test`     | Adding/refactoring tests only.                     | none   |
| `refactor` | Internal restructuring, no behavior change.        | PATCH  |
| `perf`     | Performance improvement, no behavior change.       | PATCH  |
| `chore`    | Build, deps, repo housekeeping.                    | none   |
| `ci`       | CI workflow changes only.                          | none   |
| `build`    | `install.sh`, packaging, asset shape.              | PATCH  |
| `revert`   | Reverts a prior commit (reference its SHA).        | varies |

### Scopes

Use the package or directory name when it narrows the change:
`extension`, `tui`, `install`, `release`, `docs`, `prompt`, or a tool name
(`grow_project`, `ralph_loop`, `ralph_status`, …). Scope is optional but
encouraged — it lands in changelog grouping.

### Breaking changes

Either append `!` after the type/scope **or** add a `BREAKING CHANGE:` footer:

```
feat(grow_project)!: rename `focus` arg to `theme`

BREAKING CHANGE: callers passing `focus` must migrate to `theme`.
```

A `!` or `BREAKING CHANGE:` footer forces a MAJOR bump (or, pre-1.0, a MINOR
bump with a `### Breaking` changelog section).

### Footers we use

- `Closes #N` — close the issue when the commit lands on `main`. The
  `grow_project` loop emits this automatically.
- `Co-authored-by: …` — required for AI-authored commits (see
  `.github/copilot-instructions.md` and the dual `Copilot` /
  `copilot-ralph` trailers documented in the changelog).
- `Refs #N` — reference an issue without closing it.

### Examples (good)

```
feat(ralph_status): include adaptive extension history in snapshot
fix(install): atomic per-file copy via temp + rename to avoid torn reads
docs(agents): add Conventional Commits guide
chore(deps): bump node engine floor to 20
refactor(handler): extract gitExec helper for ralph_status reuse
feat(grow_project)!: drop pre-flight ideation when backlog non-empty
```

### Examples (bad — DO NOT)

```
update stuff                         # no type, no detail
feat: things                          # vacuous summary
Fix Bug                               # capitalised, no scope, vague
WIP                                   # never on main
```

[cc]: https://www.conventionalcommits.org/en/v1.0.0/

---

## 3. CHANGELOG.md (Keep a Changelog)

`CHANGELOG.md` follows [Keep a Changelog 1.1.0][kac]. Every release MUST
have a section; the release workflow refuses to publish a tag whose version
has no matching section.

### Structure

```markdown
# Changelog

## Unreleased

### Features
- …

### Fixes
- …

### Breaking
- …

## 0.7.0 — 2026-05-15

### Features
- …
```

### Section names (in order)

`Breaking` → `Features` → `Fixes` → `Performance` → `Refactor` →
`Documentation` → `Internal`. Skip empty sections.

### Per-entry rules

- Reference the issue or PR (`(issue #25)` or `(#42)`).
- Write what the user observes, not the diff. ("Adds opt-out env var
  `RALPH_NO_UPDATE_CHECK`" — not "added new branch in handler.mjs").
- Wrap prose at ~72 chars for readable git diffs.

### Release flow

1. Open a release PR that:
   - Renames `## Unreleased` → `## X.Y.Z` (no `v` prefix, no
     date — matches the format used by every existing
     release section in `CHANGELOG.md`; pinned by a drift
     guard so the release workflow's CHANGELOG-extraction
     awk continues to work). The release workflow also
     accepts `## [vX.Y.Z]` / `## vX.Y.Z` / `## [X.Y.Z]`
     equivalents, but pick the bare form for consistency.
   - Adds a fresh empty `## Unreleased` block at the top.
   - Bumps `version` in `package.json` **and** the matching
     `VERSION` constant in `extension/handler.mjs` (kept in sync
     by the `VERSION matches package.json` test — bumping only one
     fails CI).
2. Merge.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Release workflow validates and publishes (see issue #10).

[kac]: https://keepachangelog.com/en/1.1.0/

---

## 4. Automated changelog from commits (future)

Because every commit on `main` is a Conventional Commit, we can generate the
release body mechanically from the commit range `vX.Y.(Z-1)..vX.Y.Z`:

- `feat:` → **Features**
- `fix:` → **Fixes**
- `perf:` → **Performance**
- `refactor:` → **Refactor**
- `docs:` → **Documentation**
- `!` / `BREAKING CHANGE:` → **Breaking** (always listed first)
- `chore:`, `ci:`, `test:`, `build:` → omitted (or under **Internal** for
  visibility)

Tools that consume this convention out of the box:

- [`git-cliff`][cliff] — pure-Rust, single binary, customisable templates.
  Lowest-friction option for our setup.
- [`conventional-changelog-cli`][ccc] — Node-native, larger ecosystem.
- GitHub's built-in **"Generate release notes"** (works without
  Conventional Commits but groups poorly without them).

The release workflow MAY be extended later to invoke `git-cliff` and use its
output as the GitHub Release body, with `CHANGELOG.md` regenerated as a
build artifact rather than hand-edited. Until that lands, **hand-curate
`CHANGELOG.md` per the Keep a Changelog rules above** — the commit history
is the safety net that lets us automate this without losing data.

[cliff]: https://git-cliff.org/
[ccc]: https://github.com/conventional-changelog/conventional-changelog

---

## 5. Quick checklist before pushing

- [ ] Commit subject line is a valid Conventional Commit and ≤72 chars.
- [ ] If the change is user-visible, an entry exists under
      `## Unreleased` in `CHANGELOG.md` with the right section.
- [ ] If the change is breaking, the commit has `!` or `BREAKING CHANGE:`
      AND `CHANGELOG.md` has a `### Breaking` entry.
- [ ] `npm test` passes locally.
- [ ] `npm run check` passes locally (per-file `node --check`
      across `extension/` + `packages/tui/{src,bin}` — mirrors
      the CI "Syntax check" job; catches a syntax error before
      it hits the matrix runners).
- [ ] No version bump in `package.json` outside a release PR.
- [ ] AI-authored commits include the required `Co-authored-by:` trailers.

When in doubt, prefer over-documenting: an extra changelog line costs
nothing; a missing one costs a re-tag.
