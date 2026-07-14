// server/src/services/proxy.ts
//
// The FRONTEND PROXY: the only network-facing process in the appliance, and
// the least trusted one — deliberately built on node:http alone with no
// application knowledge whatsoever.
//
//   does      listen on the configured local address (127.0.0.1:8747 by
//             default; a trusted-LAN address is an explicit configuration),
//             forward HTTP to the API's Unix socket with size and time
//             limits, add attribution headers
//   must not  touch the corpus, snapshots, config, keyrings, or collector
//             control — none of those paths exist in its mount namespace;
//             originate Internet traffic (nothing here constructs an
//             outbound target: the only dial is the fixed socket path)
//
// This is what makes the API's --network=none possible: strong isolation
// for the process that holds data, a ~150-line forwarder for the process
// that holds a port.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { loadConfig, makeLogger, onShutdown, resolveRuntimeDirs, socketPaths } from "./bootstrap.js";

const log = makeLogger("proxy");

const initial = loadConfig();
if (!initial.config) {
  log.error("refusing to start — tidepool.config.json failed validation", { errors: initial.errors });
  process.exit(1);
}
const { runDir } = resolveRuntimeDirs(initial.config);
const API_SOCKET = socketPaths(runDir).api;

// conservative listener defaults: loopback unless explicitly widened
const LISTEN_ADDR = process.env.TIDEPOOL_PROXY_ADDR || "127.0.0.1";
const LISTEN_PORT = Number(process.env.TIDEPOOL_PROXY_PORT || initial.config.server.port || 8747);
const MAX_BODY = Number(process.env.TIDEPOOL_PROXY_MAX_BODY || 1_048_576); // 1 MiB
const TIMEOUT_MS = Number(process.env.TIDEPOOL_PROXY_TIMEOUT_MS || 60_000);

// hop-by-hop headers must not be forwarded (RFC 7230 §6.1)
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function forward(req: IncomingMessage, res: ServerResponse): void {
  const requestId = randomUUID();
  let size = 0;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  }
  headers["x-request-id"] = requestId;
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";

  const upstream = httpRequest(
    { socketPath: API_SOCKET, method: req.method, path: req.url, headers, timeout: TIMEOUT_MS },
    (up) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    }
  );
  upstream.setTimeout(TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (e) => {
    log.warn("api unavailable", { requestId, error: e.message });
    if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "api unavailable" }));
  });
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) {
      upstream.destroy();
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "request body too large" }));
      req.destroy();
    }
  });
  req.pipe(upstream);
}

const server = createServer(forward);
server.headersTimeout = 15_000;
server.requestTimeout = TIMEOUT_MS;
server.listen(LISTEN_PORT, LISTEN_ADDR, () => {
  log.info("proxy listening", { addr: LISTEN_ADDR, port: LISTEN_PORT, apiSocket: API_SOCKET });
});

onShutdown(log, async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
