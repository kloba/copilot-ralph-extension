import { test } from "node:test";
import assert from "node:assert/strict";
import { createDashboardServer } from "../extension/dashboard.mjs";

test("dashboard: starts on loopback, serves HTML, returns url+close+broadcast", async () => {
    const server = await createDashboardServer({});
    try {
        assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+$/);
        assert.equal(typeof server.close, "function");
        assert.equal(typeof server.broadcast, "function");
        const res = await fetch(new URL(server.url).origin + "/");
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.match(html, /Ralph Loop Dashboard/);
        // broadcast should not throw with no clients
        assert.doesNotThrow(() => server.broadcast("hello", { x: 1 }));
    } finally {
        await server.close();
    }
});

test("dashboard: rejects /events without matching token", async () => {
    const server = await createDashboardServer({ token: "secret" });
    try {
        const base = new URL(server.url).origin;
        const wrong = await fetch(base + "/events?token=nope");
        assert.equal(wrong.status, 403);
    } finally {
        await server.close();
    }
});

test("dashboard: 404 on unknown paths", async () => {
    const server = await createDashboardServer({});
    try {
        const base = new URL(server.url).origin;
        const r = await fetch(base + "/nope");
        assert.equal(r.status, 404);
    } finally {
        await server.close();
    }
});
