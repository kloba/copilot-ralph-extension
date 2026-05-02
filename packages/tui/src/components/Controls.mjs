// <Controls> — bottom hint row for `autopilot watch`.
//
// Uses React.createElement (no JSX) so the file runs in plain Node ESM.

import React from "react";
import { Box, Text } from "ink";

const h = React.createElement;

export default function Controls({ status }) {
    const live = status === "running" || status === "paused";

    const hints = h(Box, { flexDirection: "row" },
        h(Text, { dimColor: true }, "q"),
        h(Text, null, " quit  "),
        h(Text, { dimColor: true }, "↑/↓"),
        h(Text, null, " scroll  "),
        h(Text, { dimColor: true }, "r"),
        h(Text, null, " reload"),
    );

    const indicator = h(Box, null,
        live
            ? h(Text, { color: "cyan" }, "● live")
            : h(Text, { dimColor: true }, "○ idle"),
    );

    return h(Box, {
        paddingX: 1,
        flexDirection: "row",
        justifyContent: "space-between",
    }, hints, indicator);
}
