# Copilot Instructions for copilot-ralph-extension

This is the canonical filename GitHub Copilot (and other AI coding
assistants that load `.github/copilot-instructions.md` automatically)
read on session start. Rather than duplicate the project's conventions
across two files that would inevitably drift, this file delegates to
the single source of truth:

> **Read [`AGENTS.md`](../AGENTS.md) first.** It pins this project's
> commit, changelog, and versioning conventions in detail.

## Quick summary (the rules `AGENTS.md` expands on)

- **Commits** follow [Conventional Commits 1.0.0][cc]:
  `<type>(<scope>): <imperative summary>`. Allowed types: `feat`,
  `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`,
  `revert`. Append `!` for breaking changes.
- **Changelog** follows [Keep a Changelog 1.1.0][kac]. Every
  user-visible change adds an entry under `## Unreleased` in
  `CHANGELOG.md` (sections: Breaking → Features → Fixes → Performance
  → Refactor → Documentation → Internal, skip empties).
- **Version** in `package.json` is the single source of truth. Tags
  match `v<version>`; the release workflow at
  `.github/workflows/release.yml` enforces the match.
- **AI-authored commits** must include both
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
  and (unless `RALPH_NO_ATTRIBUTION=1` is set in the environment)
  `Co-authored-by: copilot-ralph <copilot-ralph@users.noreply.github.com>`
  trailers so loop-driven commits are passively searchable across
  public GitHub.
- **Tests**: the project is pure-stdlib Node; run them with `npm test`.
  No build, no lint, no transpiler — `node --test test/*.test.mjs
  packages/*/test/*.test.mjs` covers everything.
- **Style**: only comment when context is non-obvious. Don't introduce
  new top-level dependencies, frameworks, or build systems unless that
  introduction is itself the change.

For anything not covered here, defer to `AGENTS.md`.

[cc]: https://www.conventionalcommits.org/en/v1.0.0/
[kac]: https://keepachangelog.com/en/1.1.0/
