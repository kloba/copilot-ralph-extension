// <DetailPane> — last iteration's full excerpt + run metadata.
//
// Uses React.createElement (no JSX) so the file runs in plain Node ESM.

import React from "react";
import { Box, Text } from "ink";

const h = React.createElement;

export default function DetailPane({ snapshot }) {
    const excerpt = snapshot?.lastExcerpt;
    const reason = snapshot?.reason;
    const tokens = snapshot?.tokens ?? { input: 0, output: 0 };
    const stagnation = snapshot?.stagnationStreak ?? 0;
    const status = snapshot?.status ?? "idle";

    const tokenRow = h(Box, { flexDirection: "row" },
        h(Text, { dimColor: true }, "tokens "),
        h(Text, null, "in=" + (tokens.input ?? 0)),
        h(Text, null, "  "),
        h(Text, null, "out=" + (tokens.output ?? 0)),
        stagnation > 0 ? h(Text, null, "  ") : null,
        stagnation > 0 ? h(Text, { color: "yellow" }, "streak=" + stagnation) : null,
    );

    const reasonRow = reason
        ? h(Box, { flexDirection: "row" },
            h(Text, { dimColor: true }, "reason "),
            h(Text, { color: status === "aborted" ? "red" : "green" }, String(reason)),
        )
        : null;

    const excerptBlock = h(Box, { flexDirection: "column", marginTop: 1 },
        h(Text, { dimColor: true }, "last excerpt:"),
        h(Text, null, excerpt ? excerpt : "(none)"),
    );

    return h(Box, {
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        flexDirection: "column",
    },
        h(Text, { bold: true, underline: true }, "Detail"),
        tokenRow,
        reasonRow,
        excerptBlock,
    );
}
