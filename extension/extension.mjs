// Extension entry point: autopilot
//
// Wires the autopilot controller to a Copilot CLI session. The
// controller registers:
//   - 4 first-class tools: autopilot_run / autopilot_stop /
//     autopilot_status / autopilot_scout (#118, #120),
//   - 5 deprecation shims for the legacy ap_loop / ap_status /
//     ap_pause / ap_resume / ap_stop (will be removed in 0.8.0, #122),
//   - 1 custom agent: autopilot-shipper (#119),
//   - 1 slash command: /autopilot [run|stop|status],
//   - hooks that inject post-loop context into the next user prompt.

import { joinSession } from "@github/copilot-sdk/extension";
import { createAutopilotController } from "./handler.mjs";

const controller = createAutopilotController();

// joinSession can fail if the SDK's contract drifts (missing customAgents,
// command field rejected, etc.). Without a try/catch the rejection becomes
// an unhandled promise rejection at module-load time and the user sees
// neither the autopilot tools in /tools nor any clue why. Surface the
// failure on stderr and rethrow so the SDK's own error reporter still
// catches it.
function fatal(stage, err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`autopilot extension: failed to ${stage}: ${msg}\n`);
    throw err;
}

let session;
try {
    session = await joinSession({
        tools: controller.tools,
        commands: controller.commands,
        customAgents: controller.customAgents,
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
