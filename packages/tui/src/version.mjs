// Single source of truth for the package version string used both by
// `ralph-tui --version` (in `bin/tui.mjs`) and the live TUI Header
// (issue #59 — "show active app version in top-right corner"). Reads
// `packages/tui/package.json` once per call from disk; the file is
// small and call sites are limited (CLI startup + Ink mount), so we
// don't bother caching.
//
// Returns the literal string `"unknown"` on any read/parse failure
// (e.g. the package.json was deleted, has bad JSON, or the resolved
// path escapes the package). Callers that surface this to the user
// MUST be prepared for `"unknown"` rather than throwing — the Header
// in particular still wants to render `vunknown` over a crash.

import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

export function readTuiVersion() {
    try {
        const pkgPath = nodePath.resolve(
            nodePath.dirname(fileURLToPath(import.meta.url)),
            "..",
            "package.json",
        );
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        return pkg.version || "unknown";
    } catch {
        return "unknown";
    }
}
