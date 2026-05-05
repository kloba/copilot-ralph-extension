import { test } from "node:test";
import assert from "node:assert/strict";

import {
    SHIPPER_AGENT_NAME,
    SHIPPER_PROMPT,
    SHIPPER_TOOLS,
    createShipperAgentConfig,
    __test__,
} from "../extension/shipper-agent.mjs";

const MAX_PROMPT_BYTES = 6144;

test("createShipperAgentConfig: returns the required CustomAgentConfig fields", () => {
    const cfg = createShipperAgentConfig();
    // Required by SDK CustomAgentConfig (types.d.ts:847).
    assert.equal(typeof cfg.name, "string", "name must be a string");
    assert.equal(typeof cfg.prompt, "string", "prompt must be a string");
    assert.equal(cfg.infer, true, "infer must be true so the agent is exposed for delegation");
    // Optional but documented fields we explicitly set.
    assert.equal(typeof cfg.displayName, "string");
    assert.equal(typeof cfg.description, "string");
    assert.ok(Array.isArray(cfg.tools), "tools must be a string[] (not null) so the allowlist is explicit");
});

test("createShipperAgentConfig: name is exactly 'autopilot-shipper'", () => {
    assert.equal(SHIPPER_AGENT_NAME, "autopilot-shipper");
    assert.equal(createShipperAgentConfig().name, "autopilot-shipper");
});

test("createShipperAgentConfig: prompt byte length is under the 6 KB ceiling", () => {
    const bytes = Buffer.byteLength(SHIPPER_PROMPT, "utf8");
    assert.ok(
        bytes < MAX_PROMPT_BYTES,
        `SHIPPER_PROMPT is ${bytes} bytes, must be < ${MAX_PROMPT_BYTES}`,
    );
    // Pin the ceiling constant the module enforces internally so a
    // future edit that loosens it surfaces in this test, not at
    // module-load time.
    assert.equal(__test__.MAX_PROMPT_BYTES, MAX_PROMPT_BYTES);
});

test("createShipperAgentConfig: prompt contains the contract tokens and required phrases", () => {
    const required = [
        "SHIPPED:",
        "BLOCKED:",
        "Closes #",
        "Co-authored-by: Copilot",
        "Co-authored-by: copilot-ralph",
        "NEVER ask the user",
        // Scout handoff schema field names — the shipper must read
        // these by exact name from the JSON it receives.
        "scope_files",
        "acceptance",
        "ref_kind",
    ];
    for (const phrase of required) {
        assert.ok(
            SHIPPER_PROMPT.includes(phrase),
            `SHIPPER_PROMPT must include the literal phrase ${JSON.stringify(phrase)}`,
        );
    }
});

test("createShipperAgentConfig: prompt drops the legacy [STAGE: …] marker contract", () => {
    assert.ok(
        !SHIPPER_PROMPT.includes("[STAGE:"),
        "SHIPPER_PROMPT must not reintroduce the [STAGE: …] marker contract — the loop driver does not parse stage markers from shipper output",
    );
});

test("SHIPPER_TOOLS: allowlist excludes ap_* / autopilot_* names (no recursion)", () => {
    const violators = SHIPPER_TOOLS.filter((t) => /^(?:ap_|autopilot_)/.test(t));
    assert.deepEqual(
        violators,
        [],
        `SHIPPER_TOOLS leaked loop-driving tool names: ${violators.join(", ")}`,
    );
});

test("SHIPPER_TOOLS: also excludes ask_user / task / delegate (sub-agent must not stall or recurse)", () => {
    for (const banned of ["ask_user", "task", "delegate"]) {
        assert.ok(
            !SHIPPER_TOOLS.includes(banned),
            `SHIPPER_TOOLS must not include ${banned} — would let the shipper stall or spawn its own sub-agents`,
        );
    }
});

test("createShipperAgentConfig: returns a fresh object each call so callers cannot mutate shared state", () => {
    const a = createShipperAgentConfig();
    const b = createShipperAgentConfig();
    assert.notStrictEqual(a, b);
    a.tools.push("ap_loop");
    assert.ok(
        !b.tools.includes("ap_loop"),
        "mutating one returned config's tools array must not bleed into the next",
    );
    // SHIPPER_TOOLS itself must be frozen (defence-in-depth).
    assert.throws(() => SHIPPER_TOOLS.push("ap_loop"), /read only|TypeError|Cannot/);
});
