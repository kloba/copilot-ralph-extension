#!/usr/bin/env node
// Portable equivalent of the CI "Syntax check" job (.github/workflows/ci.yml).
// Walks every shipped .mjs under packages/tui/src + packages/tui/bin + scripts/
// and runs `node --check <file>` on each; any non-zero exit propagates as
// the script's exit code. A minimum-file-count guard catches accidental
// refactors that empty the search roots (mirrors the CI "Syntax-checked
// N .mjs files" guard so a green local check matches what CI would do).
//
// Why a Node script instead of a one-liner in package.json:
//   - Cross-platform (no bash / find dependency for Windows contributors).
//   - Fail-fast: first syntax error stops the run, so the contributor sees
//     the real error message instead of a wall of "OK" + a single FAIL
//     buried at the end.
//   - Identical behaviour to CI: same roots, same per-file invocation, same
//     min-file guard, same "Syntax-checked N .mjs files." success line.

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["packages/tui/src", "packages/tui/bin", "scripts"];
const MIN_FILES = 10;

function walk(dir, out) {
    let entries;
    try { entries = readdirSync(dir); }
    catch { return; } // missing root is tolerated; final count guard catches it.
    for (const name of entries) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); }
        catch { continue; }
        if (st.isDirectory()) walk(full, out);
        else if (st.isFile() && name.endsWith(".mjs")) out.push(full);
    }
}

const files = [];
for (const root of ROOTS) walk(root, files);

if (files.length < MIN_FILES) {
    console.error(
        `Syntax check scanned only ${files.length} files; expected >= ${MIN_FILES}. ` +
        `Did the source layout move?`,
    );
    process.exit(1);
}

for (const f of files) {
    try {
        execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
    } catch {
        // Node already printed the SyntaxError + line number to stderr.
        process.exit(1);
    }
}

console.log(`Syntax-checked ${files.length} .mjs files.`);
