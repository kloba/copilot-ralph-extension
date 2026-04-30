// Extension: ralph
// Hook/event-driven Ralph Wiggum iterative loop for GitHub Copilot CLI.
// Inspired by Anthropic's Claude Code ralph-wiggum plugin (Stop hook
// re-injection pattern) and Th0rgal/open-ralph-wiggum.

import { joinSession } from "@github/copilot-sdk/extension";
import { createRalphController } from "./handler.mjs";

const controller = createRalphController();

// joinSession can fail (SDK version mismatch, malformed manifest, no live
// session). Without a try/catch the rejection becomes an unhandled
// promise rejection at module-load and the extension fails silently —
// the user sees neither ralph_loop in /extensions nor any clue why.
// Emit a clear stderr line and rethrow so the runtime still treats it
// as a load failure.
let session;
try {
    session = await joinSession({
        tools: controller.tools,
        hooks: controller.hooks,
    });
} catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`ralph extension: failed to join Copilot session: ${msg}\n`);
    throw err;
}

try {
    controller.attach(session);
} catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`ralph extension: failed to attach controller: ${msg}\n`);
    throw err;
}
