// server/src/services/proxy.ts
//
// The FRONTEND PROXY: the appliance's sole TCP endpoint and its HTTP
// admission gate. Strict-admission evolution — no longer a blind forwarder.
//
// Layered model (this process owns exactly ONE layer):
//   host firewall / netns   → who can reach the port     (NOT us)
//   AppArmor / mounts       → process + fs authority      (NOT us)
//   >>> THIS: HTTP admission → is this a valid Tidepool request?
//   API (over UDS)          → application semantics       (downstream)
//
// It terminates TLS, validates framing against the deny-by-default route
// manifest (shared/httpPolicy.ts, engine in httpAdmission.ts), strips
// client forwarding headers, sets security headers, and forwards only
// admitted requests to the API's Unix socket. It never reads the corpus,
// keyrings, the collector control socket, or the CA private key, and it
// makes NO claim about packet filtering — it accepts, rejects, or closes
// HTTP connections that have already arrived.

import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, makeLogger, onShutdown, resolveDirs, resolveRuntimeDirs, socketPaths } from "./bootstrap.js";
import { DEPLOY_CONFIG } from "../../../shared/deployConfig.generated.js";
import { LIMIT_BOUNDS, type HttpErrorCode } from "../../../shared/httpPolicy.js";
import { admit } from "./httpAdmission.js";
import { tlsPaths } from "./tls.js";

const log = makeLogger("proxy");

const initial = loadConfig();
if (!initial.config) {
  log.error("refusing to start — tidepool.config.json failed validation", { errors: initial.errors });
  process.exit(1);
}
const config = initial.config;
const { runDir } = resolveRuntimeDirs(config);
const { dataDir } = resolveDirs(config);
const API_SOCKET = socketPaths(runDir).api;
const http = config.http ?? {};

const LISTEN_ADDR = process.env.TIDEPOOL_PROXY_ADDR || http.listenAddress || "127.0.0.1";
const LISTEN_PORT = Number(process.env.TIDEPOOL_PROXY_PORT || http.port || config.server.port || DEPLOY_CONFIG.internalPort);
const ALLOWED_HOSTS = (http.allowedHosts && http.allowedHosts.length > 0)
  ? http.allowedHosts
  : ["localhost", "127.0.0.1", LISTEN_ADDR];

const L = http.limits ?? {};
const LIMITS = {
  maxConnections: L.maxConnections ?? LIMIT_BOUNDS.maxConnections.default,
  maxConnectionsPerClient: L.maxConnectionsPerClient ?? LIMIT_BOUNDS.maxConnectionsPerClient.default,
  maxHeaderBytes: L.maxHeaderBytes ?? LIMIT_BOUNDS.maxHeaderBytes.default,
  maxHeaders: L.maxHeaders ?? LIMIT_BOUNDS.maxHeaders.default,
  maxQueryBytes: L.maxQueryBytes ?? LIMIT_BOUNDS.maxQueryBytes.default,
  requestTimeoutMs: L.requestTimeoutMs ?? LIMIT_BOUNDS.requestTimeoutMs.default,
};

const TIMEOUTS = { headers: 10_000, idle: 15_000, socketConnect: 2_000, apiResponse: 30_000 };
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "font-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'none'", "object-src 'none'", "worker-src 'none'", "manifest-src 'self'",
].join("; ");
// hop-by-hop headers (RFC 7230) + client forwarding headers we must strip
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const CLIENT_FORWARDING = new Set(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-request-id"]);

const STATUS_TEXT: Record<HttpErrorCode, string> = {
  MALFORMED_REQUEST: "The request could not be parsed.",
  BODY_FORBIDDEN: "Request bodies are not accepted on this interface.",
  ROUTE_NOT_PRESENT: "No such route.",
  METHOD_NOT_ALLOWED: "Method not allowed.",
  REQUEST_TOO_LARGE: "The request exceeded the configured limit.",
  HEADERS_TOO_LARGE: "The request headers exceeded the configured limit.",
  QUERY_TOO_LARGE: "The query string exceeded the configured limit.",
  UNSUPPORTED_MEDIA_TYPE: "Unsupported media type.",
  HOST_NOT_ALLOWED: "Host not recognized.",
  AUTHENTICATION_REQUIRED: "Authentication required.",
  FORBIDDEN: "Forbidden.",
  REQUEST_LIMIT_EXCEEDED: "Too many requests.",
  UPSTREAM_UNAVAILABLE: "The service is temporarily unavailable.",
  SERVICE_OVERLOADED: "The service is overloaded.",
  REQUEST_TIMEOUT: "The request timed out.",
};

function securityHeaders(res: ServerResponse, cachePolicy: string, extra: Record<string, string> = {}): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", CSP);
  res.removeHeader("X-Powered-By");
  if (cachePolicy === "no-cache") res.setHeader("Cache-Control", "no-cache");
  else if (cachePolicy === "no-store") res.setHeader("Cache-Control", "no-store");
  else if (cachePolicy === "immutable") res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

function sendError(res: ServerResponse, status: number, code: HttpErrorCode, requestId: string, close = false): void {
  if (!res.headersSent) {
    securityHeaders(res, "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (close) res.setHeader("Connection", "close");
    res.writeHead(status);
  }
  res.end(JSON.stringify({ error: { code, message: STATUS_TEXT[code], requestId } }));
}

// --------------------------------------------------------------- readiness
function readinessState(): { ready: boolean; detail: Record<string, unknown> } {
  const pub = join(resolveRuntimeDirs(config).publishedDir, "publication.json");
  const replica = join(resolveRuntimeDirs(config).publishedDir, "tidepool-read.sqlite3");
  const hasReplica = existsSync(replica) && existsSync(pub);
  const apiUp = existsSync(API_SOCKET);
  return { ready: hasReplica && apiUp, detail: { publishedReplica: hasReplica, apiSocket: apiUp } };
}

// --------------------------------------------------------------- connection accounting
const perClient = new Map<string, number>();
let activeConnections = 0;

// ------------------------------------------------------------------ handler
function handle(req: IncomingMessage, res: ServerResponse, tlsVersion: string): void {
  const requestId = randomUUID(); // proxy-generated; client X-Request-Id is discarded
  const start = Date.now();
  const method = (req.method ?? "").toUpperCase();
  const target = req.url ?? "/";

  const done = (status: number, reason: string) => {
    const t = tlsVersion || "none";
    // query values omitted from logs (may carry inventory names)
    log.info("request", { requestId, method, path: target.split("?")[0], status, ms: Date.now() - start, tls: t, reason });
  };

  // liveness/readiness are proxy-local — never forwarded
  if (method === "GET" && (target === "/health/live" || target === "/health/ready")) {
    securityHeaders(res, "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (target === "/health/live") {
      res.writeHead(200);
      res.end(JSON.stringify({ live: true }));
      return done(200, "liveness");
    }
    const r = readinessState();
    res.writeHead(r.ready ? 200 : 503);
    res.end(JSON.stringify({ ready: r.ready, ...r.detail }));
    return done(r.ready ? 200 : 503, "readiness");
  }

  const decision = admit({
    method,
    target,
    headers: req.headers,
    rawHeaderLines: rawHeaderLines(req),
    allowedHosts: ALLOWED_HOSTS,
    maxQueryBytes: LIMITS.maxQueryBytes,
    maxHeaders: LIMITS.maxHeaders,
    maxHeaderBytes: LIMITS.maxHeaderBytes,
  });

  if (!decision.ok) {
    sendError(res, decision.status, decision.code, requestId, decision.close);
    if (decision.close) req.socket.destroy();
    return done(decision.status, decision.reason);
  }

  // admitted → forward to the API over the fixed Unix socket. Client
  // forwarding + hop-by-hop headers are dropped; canonical metadata is
  // generated internally.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP.has(lk) || CLIENT_FORWARDING.has(lk)) continue;
    if (typeof v === "string") headers[k] = v;
  }
  headers["x-request-id"] = requestId;
  headers["x-tidepool-proxy"] = "1"; // the API trusts forwarding only with this marker over UDS
  headers["x-forwarded-proto"] = "https";

  const upstream = httpRequest(
    { socketPath: API_SOCKET, method, path: target, headers, timeout: TIMEOUTS.apiResponse },
    (up) => {
      const cache = decision.route.cachePolicy;
      securityHeaders(res, cache);
      // pass through the API's content-type and any ETag (snapshots)
      for (const [k, v] of Object.entries(up.headers)) {
        const lk = k.toLowerCase();
        if (HOP.has(lk)) continue;
        if (lk === "cache-control") continue; // policy set by us, not the API
        if (v !== undefined) res.setHeader(k, v as string | string[]);
      }
      res.writeHead(up.statusCode ?? 502);
      up.pipe(res);
      up.on("end", () => done(up.statusCode ?? 0, "forwarded"));
    }
  );
  upstream.on("error", () => {
    sendError(res, 503, "UPSTREAM_UNAVAILABLE", requestId);
    done(503, "api-unavailable");
  });
  // read routes carry no body; end immediately (any body was already rejected)
  upstream.end();
}

/** Reconstruct raw header lines for framing checks. Node lowercases and
 *  de-duplicates most headers, but rawHeaders preserves order/case and
 *  repetition, which is what smuggling checks need. */
function rawHeaderLines(req: IncomingMessage): string[] {
  const lines: string[] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
  return lines;
}

// -------------------------------------------------------------- TLS material
function loadTlsOptions(): { key: Buffer; cert: Buffer; ca?: Buffer } | null {
  const mode = http.tls?.mode ?? (http.enabled ? "generated-local-ca" : "disabled");
  if (mode === "disabled") return null;
  const paths = tlsPaths(join(dataDir, "tls"));
  const keyPath = process.env.TIDEPOOL_TLS_KEY || paths.serverKey;
  const certPath = process.env.TIDEPOOL_TLS_CERT || paths.chain; // chain preferred (leaf+CA)
  const leafOnly = process.env.TIDEPOOL_TLS_CERT || paths.serverCrt;
  if (!existsSync(keyPath) || !existsSync(existsSync(certPath) ? certPath : leafOnly)) {
    log.error("TLS enabled but certificate material is missing — run `npm run tls init`", { keyPath, certPath });
    process.exit(1);
  }
  return { key: readFileSync(keyPath), cert: readFileSync(existsSync(certPath) ? certPath : leafOnly) };
}

// ------------------------------------------------------------------- listen
const tls = loadTlsOptions();
let server: TlsServer | ReturnType<typeof createHttpServer>;

const commonServerOpts = {
  maxHeaderSize: LIMITS.maxHeaderBytes,
  requestTimeout: LIMITS.requestTimeoutMs,
  headersTimeout: TIMEOUTS.headers,
  keepAliveTimeout: TIMEOUTS.idle,
};

if (tls) {
  server = createTlsServer(
    { ...commonServerOpts, key: tls.key, cert: tls.cert, minVersion: "TLSv1.2", honorCipherOrder: true },
    (req, res) => handle(req, res, (req.socket as TLSSocket).getProtocol?.() ?? "unknown")
  );
  log.info("proxy listening over HTTPS (TLS ≥1.2)", { addr: LISTEN_ADDR, port: LISTEN_PORT, allowedHosts: ALLOWED_HOSTS });
} else {
  if (http.enabled) log.warn("http.enabled but tls.mode=disabled — plaintext listener; appliance HTTPS guarantees are NOT active");
  server = createHttpServer(commonServerOpts, (req, res) => handle(req, res, ""));
  log.info("proxy listening over plaintext HTTP (development / tls disabled)", { addr: LISTEN_ADDR, port: LISTEN_PORT });
}

// connection + per-client caps (application layer, atop container limits)
server.on("connection", (socket) => {
  const key = socket.remoteAddress ?? "unknown";
  if (activeConnections >= LIMITS.maxConnections) {
    socket.destroy();
    return;
  }
  const n = (perClient.get(key) ?? 0) + 1;
  if (n > LIMITS.maxConnectionsPerClient) {
    socket.destroy();
    return;
  }
  activeConnections++;
  perClient.set(key, n);
  socket.on("close", () => {
    activeConnections--;
    const c = (perClient.get(key) ?? 1) - 1;
    if (c <= 0) perClient.delete(key);
    else perClient.set(key, c);
  });
});
server.on("clientError", (_err, socket) => {
  // malformed TLS/HTTP at the socket layer → close without disclosure
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(LISTEN_PORT, LISTEN_ADDR, () => {
  log.info("proxy ready", { addr: LISTEN_ADDR, port: LISTEN_PORT, tls: !!tls, apiSocket: API_SOCKET });
});

onShutdown(log, async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
