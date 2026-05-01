// Extension: ralph
// Hook/event-driven Ralph Wiggum iterative loop for GitHub Copilot CLI.
// Inspired by the Stop-hook re-injection pattern.

import { joinSession } from "@github/copilot-sdk/extension";
import { createRalphController } from "./handler.mjs";

const controller = createRalphController();

// joinSession / attach can fail (SDK version mismatch, missing session
// methods). Without a try/catch the rejection becomes an unhandled
// promise rejection at module-load and the user sees neither ralph_loop
// in /extensions nor any clue why. Emit stderr and rethrow.
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
