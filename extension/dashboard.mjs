/**
 * Live loop dashboard — minimal stub for issue #6.
 *
 * This is a v0 implementation: a tiny zero-dependency HTTP server that
 * streams loop events over Server-Sent Events (SSE) to a single static
 * HTML page. The full UX described in #6 (timeline, diff pane, replay
 * controls, "built with Ralph" badge) will land in follow-up PRs; this
 * stub locks in the surface area, the wiring contract with the
 * controller, and the security defaults so future iterations don't have
 * to re-litigate them.
 *
 * Surface (kept intentionally narrow):
 *   - createDashboardServer({ controller, port?, host?, token? }) →
 *       { url, close, broadcast }
 *   - The server binds to 127.0.0.1 only, picks a free port if `port`
 *     is omitted, and gates the SSE endpoint behind a one-time random
 *     token in the URL so other processes on the same machine can't
 *     snoop the stream.
 *
 * Activation is opt-in via env var (RALPH_DASHBOARD=1) — no behavior
 * change for existing users. The full per-run `dashboard: true` arg
 * surface and `ralph_dashboard` companion tool will land later.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const STATIC_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ralph Loop Dashboard</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; max-width: 960px; }
  h1 { margin-top: 0; }
  .badge { display: inline-block; padding: 0.15em 0.5em; border-radius: 4px; background: #eef; font-family: monospace; font-size: 0.9em; }
  #events { white-space: pre-wrap; font-family: monospace; background: #f6f6f6; padding: 1rem; border-radius: 6px; max-height: 60vh; overflow-y: auto; }
  .stub-banner { background: #fff8d6; border-left: 4px solid #d4b300; padding: 0.75rem 1rem; margin-bottom: 1rem; }
  footer { margin-top: 2rem; font-size: 0.85em; color: #666; }
  footer a { color: #444; }
</style>
</head>
<body>
<h1>🧹 Ralph Loop Dashboard <span class="badge">v0</span></h1>
<div class="stub-banner"><strong>Stub UI.</strong> Full timeline, diff pane, and replay controls are tracked in <a href="https://github.com/kloba/copilot-ralph-extension/issues/6">issue #6</a>. This page just verifies the SSE stream.</div>
<div id="status">Connecting…</div>
<pre id="events"></pre>
<footer>Built with <a href="https://github.com/kloba/copilot-ralph-extension">Ralph</a>.</footer>
<script>
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const status = document.getElementById("status");
  const events = document.getElementById("events");
  const es = new EventSource("/events?token=" + encodeURIComponent(token || ""));
  es.onopen = () => { status.textContent = "Connected. Waiting for loop events…"; };
  es.onerror = () => { status.textContent = "Disconnected."; };
  es.onmessage = (ev) => {
    const line = "[" + new Date().toLocaleTimeString() + "] " + ev.data + "\\n";
    events.textContent += line;
    events.scrollTop = events.scrollHeight;
  };
</script>
</body>
</html>`;

/**
 * Spin up the dashboard HTTP server. Returns once listening.
 *
 * @param {Object} opts
 * @param {Object} [opts.controller] - Optional ralph controller; the
 *   server subscribes to its `state` snapshot for the homepage but
 *   loop events are pushed via the returned `broadcast(eventName, data)`
 *   callback, which the caller wires into the controller's hooks.
 * @param {number} [opts.port=0] - Port to bind. 0 means OS-chosen free port.
 * @param {string} [opts.host="127.0.0.1"] - Bind address. Loopback only by default.
 * @param {string} [opts.token] - Auth token; auto-generated when omitted.
 * @returns {Promise<{ url: string, close: () => Promise<void>, broadcast: (eventName: string, data: any) => void }>}
 */
export async function createDashboardServer(opts = {}) {
    const host = opts.host ?? "127.0.0.1";
    const port = Number.isInteger(opts.port) ? opts.port : 0;
    const token = opts.token ?? randomBytes(16).toString("hex");
    /** @type {Set<import('node:http').ServerResponse>} */
    const sseClients = new Set();

    const server = createServer((req, res) => {
        let url;
        try {
            url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        } catch {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("bad request");
            return;
        }
        if (url.pathname === "/" || url.pathname === "/index.html") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(STATIC_HTML);
            return;
        }
        if (url.pathname === "/events") {
            if (url.searchParams.get("token") !== token) {
                res.writeHead(403, { "Content-Type": "text/plain" });
                res.end("forbidden");
                return;
            }
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            });
            res.write(`: connected ${Date.now()}\n\n`);
            sseClients.add(res);
            req.on("close", () => sseClients.delete(res));
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    const url = `http://${host}:${boundPort}/?token=${encodeURIComponent(token)}`;

    /**
     * Broadcast a JSON-serializable event to all SSE clients. Failed
     * writes drop the client silently — the next iteration will simply
     * not send to that connection.
     */
    function broadcast(eventName, data) {
        const payload = JSON.stringify({ event: eventName, data, ts: Date.now() });
        for (const client of sseClients) {
            try {
                client.write(`data: ${payload}\n\n`);
            } catch {
                sseClients.delete(client);
            }
        }
    }

    async function close() {
        for (const client of sseClients) {
            try { client.end(); } catch { /* ignore */ }
        }
        sseClients.clear();
        // Close idle keep-alive connections so the server actually
        // shuts down promptly in tests / short-lived processes.
        if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        await new Promise((resolve) => server.close(() => resolve()));
    }

    return { url, close, broadcast };
}
