# Security Policy

## Reporting a Vulnerability

If you believe you've found a security issue in `copilot-ralph-extension` — such as a prompt-injection vector, a path-traversal in `install.sh`, an unsafe shell construction in a baked prompt, or any other credential / data-exposure risk — please report it **privately** rather than opening a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/kloba/copilot-ralph-extension/security/advisories/new) form to file a confidential security advisory. We'll triage and respond as soon as we can. Public-issue reports for credible vulnerabilities will be redacted on request.

When reporting, please include:

- A clear description of the vulnerability and its impact (what an attacker can do, what privileges/access they need to start with).
- Reproduction steps or a proof-of-concept that demonstrates the issue.
- The version / commit SHA you observed it on.
- Any suggested mitigations or patches you've prototyped.

## Supported Versions

This is a small, single-maintainer extension with a low release cadence. Only the **latest tagged release** receives security updates. If a fix is applied, it ships in the next patch release on top of `main`; older tags are not back-patched.

| Version | Supported |
| ------- | --------- |
| latest tagged release | ✅ |
| older tags / pre-release commits | ❌ |

If you need to keep using an older version, please cherry-pick the fix yourself or pin to the next tagged release that includes it.

## Scope

In-scope:

- Every runtime module shipped under `extension/` (currently `extension.mjs`, `handler.mjs`, `scout-tool.mjs`, `shipper-agent.mjs`; the set is pinned to `install.sh`'s `FILES` array by a drift-guard test, so any future addition lands here automatically).
- `install.sh`
- Anything baked into prompt templates that could be exploited by a malicious external input (e.g. a poisoned issue body fed into `grow_project`).

Out-of-scope:

- Vulnerabilities in upstream `@github/copilot-sdk`, the Copilot CLI itself, Node.js, or `gh`. Please report those to the respective projects.
- Issues that require an attacker to already have local code-execution on the user's machine (we assume the local environment is trusted).
