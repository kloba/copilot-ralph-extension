// Extension: ralph
// Hook/event-driven Ralph Wiggum iterative loop for GitHub Copilot CLI.
// Inspired by the Stop-hook re-injection pattern.

import { joinSession } from "@github/copilot-sdk/extension";
import { createRalphController } from "./handler.mjs";

const controller = createRalphController();

// joinSession can fail (SDK version mismatch, malformed manifest, no live
// session) and attach() can fail (missing session methods). Without a
// try/catch either rejection becomes an unhandled promise rejection at
// module-load and the extension fails silently — the user sees neither
// ralph_loop in /extensions nor any clue why. Emit a clear stderr line
// and rethrow so the runtime still treats it as a load failure.
function fatal(stage, err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`ralph extension: failed to ${stage}: ${msg}\n`);
    throw err;
}

let session;
try {
    session = await joinSession({
        tools: controller.tools,
        hooks: controller.hooks,
    });
} catch (err) {
    fatal("join Copilot session", err);
}

try {
    controller.attach(session);
} catch (err) {
    fatal("attach controller", err);
}
