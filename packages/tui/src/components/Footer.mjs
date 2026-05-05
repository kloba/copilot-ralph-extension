// <Footer> — single-line key hint row.

import React from "react";
import { Box, Text } from "ink";

const h = React.createElement;

export default function Footer({ armed }) {
    return h(Box, {
        paddingX: 1,
        flexDirection: "row",
        justifyContent: "space-between",
    },
        h(Box, { flexDirection: "row" },
            h(Text, { dimColor: true }, "q"),
            h(Text, null, " quit (does not stop the loop)"),
        ),
        h(Box, null,
            armed
                ? h(Text, { color: "cyan" }, "● live")
                : h(Text, { dimColor: true }, "○ idle"),
        ),
    );
}
