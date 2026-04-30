// Extension: ralph
// Hook/event-driven Ralph Wiggum iterative loop for GitHub Copilot CLI.
// Inspired by Anthropic's Claude Code ralph-wiggum plugin (Stop hook
// re-injection pattern) and Th0rgal/open-ralph-wiggum.

import { joinSession } from "@github/copilot-sdk/extension";
import { createRalphController } from "./handler.mjs";

const controller = createRalphController();
const session = await joinSession({
    tools: controller.tools,
    hooks: controller.hooks,
});
controller.attach(session);
