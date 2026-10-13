// Node host for the coordinator API: node:http in front of the Web-standard router.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createApi } from "../core/api.js";
import { Coordinator } from "../core/coordinator.js";
import { openNodeSql } from "../core/sql-node.js";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]);
/** The dashboard page, served at `/` and `/app/*` (works from both src/ and dist/). */
const WEB_INDEX = new URL("../../web/index.html", import.meta.url);
function isAppPath(pathname) {
    return pathname === "/" || pathname === "/app" || pathname.startsWith("/app/");
}
async function sendStatic(method, res) {
    let body;
    try {
        body = await readFile(WEB_INDEX);
    }
    catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("dashboard not found");
        return;
    }
    res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(body.length),
        "cache-control": "no-cache",
    });
    res.end(method === "HEAD" ? undefined : body);
}
async function toRequest(req, origin) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase()))
            continue;
        if (Array.isArray(value))
            for (const v of value)
                headers.append(name, v);
        else
            headers.set(name, value);
    }
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", origin).toString();
    let body;
    if (method !== "GET" && method !== "HEAD") {
        const chunks = [];
        for await (const chunk of req)
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 0)
            body = new Uint8Array(buffer);
    }
    return new Request(url, { method, headers, body });
}
async function send(response, res) {
    const body = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((value, name) => {
        headers[name] = value;
    });
    headers["content-length"] = String(body.length);
    res.writeHead(response.status, headers);
    res.end(body);
}
export async function serve(opts) {
    if (opts.dbPath !== ":memory:")
        mkdirSync(dirname(opts.dbPath), { recursive: true });
    const sql = openNodeSql(opts.dbPath);
    const coordinator = new Coordinator(sql);
    const api = createApi(coordinator, opts.token === undefined ? {} : { token: opts.token });
    const host = opts.host ?? "127.0.0.1";
    let origin = `http://${host}:${opts.port}`;
    const server = createServer((req, res) => {
        void (async () => {
            try {
                const method = req.method ?? "GET";
                if ((method === "GET" || method === "HEAD") && isAppPath(new URL(req.url ?? "/", origin).pathname)) {
                    await sendStatic(method, res);
                    return;
                }
                const response = await api(await toRequest(req, origin));
                await send(response, res);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (!res.headersSent)
                    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: message }));
            }
        })();
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        // Longer than any client's idle keep-alive: a server that closes a socket the client is reusing turns a request into
        // a connection reset (Node's 5 s default lost a race with a busy integrator process in the eleventh run).
        server.keepAliveTimeout = 65_000;
        server.headersTimeout = 66_000;
        server.listen(opts.port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : opts.port;
    origin = `http://${host}:${port}`;
    let closed = null;
    return {
        url: origin,
        close() {
            closed ??= new Promise((resolve, reject) => {
                server.close((err) => {
                    sql.close();
                    if (err)
                        reject(err);
                    else
                        resolve();
                });
                server.closeAllConnections();
            });
            return closed;
        },
    };
}
//# sourceMappingURL=node-server.js.map