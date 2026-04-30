// Extension: ralph
// Ralph Wiggum iterative loop — re-fires a prompt until completion-promise appears
// or max_iterations is reached. In-session: retains conversation context across iterations.
// Inspired by Anthropic's Ralph Wiggum plugin and Th0rgal/open-ralph-wiggum.

import { joinSession } from "@github/copilot-sdk/extension";
import { TOOL_SPEC, runRalphLoop } from "./handler.mjs";

const session = await joinSession({
    tools: [
        {
            ...TOOL_SPEC,
            handler: (args) => runRalphLoop(session, args),
        },
    ],
});
