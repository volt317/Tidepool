// server/src/services/httpAdmission.ts
//
// The admission engine: pure functions deciding whether a request that has
// reached the listener is a structurally valid Tidepool request. Kept free
// of sockets and TLS so the raw-framing regression tests exercise exactly
// what the proxy runs.
//
// Returns a decision, never throws on bad input — malformed requests are
// data to be rejected with a stable code, not exceptions.

import { PARAM_PATTERNS, applianceRoutes, type HttpErrorCode, type HttpRoutePolicy, type QueryPolicy } from "../../../shared/httpPolicy.js";

export interface AdmitContext {
  method: string;
  target: string; // raw request target (origin-form expected)
  headers: Record<string, string | string[] | undefined>;
  rawHeaderLines: string[]; // as received, for framing checks
  allowedHosts: string[];
  maxQueryBytes: number;
  maxHeaders: number;
  maxHeaderBytes: number;
}

export type AdmitResult =
  | { ok: true; route: HttpRoutePolicy; normalizedPath: string; params: Record<string, string>; query: Record<string, string> }
  | { ok: false; status: number; code: HttpErrorCode; reason: string; close?: boolean };

const ALLOWED_METHODS = new Set(["GET", "HEAD"]);
const CTRL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/; // any control char except handled framing
const VALID_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/; // RFC 7230 token

function reject(status: number, code: HttpErrorCode, reason: string, close = false): AdmitResult {
  return { ok: false, status, code, reason, close };
}

/** Single, canonical percent-decode + path normalization. Returns null on
 *  anything ambiguous (malformed %-encoding, NUL, traversal, backslash). */
export function normalizePath(target: string): string | null {
  const qIndex = target.indexOf("?");
  const path = qIndex === -1 ? target : target.slice(0, qIndex);
  if (!path.startsWith("/")) return null; // origin-form only (no absolute/authority form)
  if (path.includes("\\")) return null;
  // decode exactly once; reject malformed or NUL-producing encodings
  let decoded: string;
  try {
    if (/%(?![0-9a-fA-F]{2})/.test(path)) return null;
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes("\u0000") || CTRL_CHARS.test(decoded)) return null;
  // reject traversal in either raw or decoded form
  const segments = decoded.split("/");
  if (segments.some((s) => s === ".." || s === ".")) return null;
  // collapse duplicate slashes to a single normalization form
  const normalized = "/" + segments.filter((s, i) => !(s === "" && i !== 0 && i !== segments.length - 1)).join("/").replace(/^\/+/, "");
  return normalized === "" ? "/" : normalized.replace(/\/{2,}/g, "/");
}

/** Framing checks that must fail closed (connection close) BEFORE routing. */
export function checkFraming(ctx: AdmitContext): AdmitResult | null {
  // header count + individual/total size
  if (ctx.rawHeaderLines.length > ctx.maxHeaders) return reject(431, "HEADERS_TOO_LARGE", "too many headers", true);
  let total = 0;
  for (const line of ctx.rawHeaderLines) {
    total += line.length;
    if (line.length > ctx.maxHeaderBytes) return reject(431, "HEADERS_TOO_LARGE", "header too large", true);
    if (/^[ \t]/.test(line)) return reject(400, "MALFORMED_REQUEST", "obsolete line folding", true);
    const colon = line.indexOf(":");
    if (colon <= 0) return reject(400, "MALFORMED_REQUEST", "malformed header line", true);
    const name = line.slice(0, colon);
    if (!VALID_HEADER_NAME.test(name)) return reject(400, "MALFORMED_REQUEST", "invalid header name", true);
    if (CTRL_CHARS.test(line.slice(colon + 1))) return reject(400, "MALFORMED_REQUEST", "control char in header value", true);
  }
  if (total > ctx.maxHeaderBytes) return reject(431, "HEADERS_TOO_LARGE", "headers too large", true);

  // duplicate / conflicting framing headers → smuggling surface
  const host = ctx.headers["host"];
  if (Array.isArray(host)) return reject(400, "MALFORMED_REQUEST", "duplicate Host", true);
  if (!host) return reject(400, "MALFORMED_REQUEST", "missing Host", true);

  const cl = ctx.headers["content-length"];
  const te = ctx.headers["transfer-encoding"];
  if (te !== undefined) return reject(400, "MALFORMED_REQUEST", "Transfer-Encoding not allowed on read routes", true);
  if (Array.isArray(cl)) return reject(400, "MALFORMED_REQUEST", "duplicate Content-Length", true);
  if (cl !== undefined) {
    if (!/^\d+$/.test(cl)) return reject(400, "MALFORMED_REQUEST", "malformed Content-Length", true);
    if (Number(cl) > 0) return reject(413, "BODY_FORBIDDEN", "request body forbidden on read routes", true);
  }

  // control chars in the request target
  if (CTRL_CHARS.test(ctx.target)) return reject(400, "MALFORMED_REQUEST", "control char in request target", true);
  return null;
}

function hostMatches(hostHeader: string, allowed: string[]): boolean {
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase(); // strip port
  return allowed.some((a) => a.toLowerCase() === host);
}

function matchRoute(method: string, normalizedPath: string): { route: HttpRoutePolicy; params: Record<string, string> } | "method" | null {
  let pathKnownOtherMethod = false;
  for (const route of applianceRoutes) {
    const rSeg = route.path.split("/");
    const pSeg = normalizedPath.split("/");
    const params: Record<string, string> = {};
    let ok = true;
    if (rSeg[rSeg.length - 1] === "*") {
      // static tree: prefix must match, remainder is the asset param
      if (pSeg.length < rSeg.length) { ok = false; }
      else {
        for (let i = 0; i < rSeg.length - 1; i++) if (rSeg[i] !== pSeg[i]) { ok = false; break; }
        if (ok) params["*"] = pSeg.slice(rSeg.length - 1).join("/");
      }
    } else {
      if (rSeg.length !== pSeg.length) ok = false;
      else {
        for (let i = 0; i < rSeg.length; i++) {
          if (rSeg[i].startsWith(":")) params[rSeg[i].slice(1)] = decodeURIComponent(pSeg[i]);
          else if (rSeg[i] !== pSeg[i]) { ok = false; break; }
        }
      }
    }
    if (!ok) continue;
    // validate typed params — a failure here means this route does not match
    // this path (the identifier isn't the right shape), i.e. 404, never 405
    if (route.params) {
      let paramsOk = true;
      for (const [k, kind] of Object.entries(route.params)) {
        const raw = k === "*" ? params["*"] : params[k];
        if (raw === undefined || !PARAM_PATTERNS[kind].test(raw)) { paramsOk = false; break; }
      }
      if (!paramsOk) continue;
    }
    if (route.method !== method && !(route.method === "GET" && method === "HEAD")) { pathKnownOtherMethod = true; continue; }
    return { route, params };
  }
  return pathKnownOtherMethod ? "method" : null;
}

function validateQuery(target: string, route: HttpRoutePolicy, maxQueryBytes: number): { ok: true; query: Record<string, string> } | AdmitResult {
  const qIndex = target.indexOf("?");
  const rawQuery = qIndex === -1 ? "" : target.slice(qIndex + 1);
  if (rawQuery.length > maxQueryBytes) return reject(414 as number, "QUERY_TOO_LARGE", "query string too large", true) as AdmitResult;
  const declared = new Map((route.query ?? []).map((q) => [q.name, q]));
  const out: Record<string, string> = {};
  if (rawQuery === "") return { ok: true, query: out };
  const seen = new Set<string>();
  for (const pair of rawQuery.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? "" : pair.slice(eq + 1);
    let name: string, val: string;
    try {
      name = decodeURIComponent(rawName);
      val = decodeURIComponent(rawVal.replace(/\+/g, " "));
    } catch {
      return reject(400, "MALFORMED_REQUEST", "malformed query encoding");
    }
    const policy = declared.get(name);
    if (!policy) return reject(400, "MALFORMED_REQUEST", `unknown query parameter: ${name}`);
    if (seen.has(name)) return reject(400, "MALFORMED_REQUEST", `duplicate query parameter: ${name}`);
    seen.add(name);
    const err = checkQueryValue(policy, val);
    if (err) return reject(400, "MALFORMED_REQUEST", err);
    out[name] = val;
  }
  for (const q of route.query ?? []) if (q.required && !(q.name in out)) return reject(400, "MALFORMED_REQUEST", `missing required query parameter: ${q.name}`);
  return { ok: true, query: out };
}

function checkQueryValue(policy: QueryPolicy, val: string): string | null {
  if (policy.maximumLength !== undefined && val.length > policy.maximumLength) return `${policy.name} too long`;
  if (policy.type === "integer") {
    if (!/^-?\d+$/.test(val)) return `${policy.name} must be an integer`;
    const n = Number(val);
    if (policy.minimum !== undefined && n < policy.minimum) return `${policy.name} below minimum`;
    if (policy.maximum !== undefined && n > policy.maximum) return `${policy.name} above maximum`;
  }
  if (policy.type === "enum" && policy.allowedValues && !policy.allowedValues.includes(val)) return `${policy.name} not an allowed value`;
  if (policy.type === "flag" && val !== "" && val !== "1" && val !== "0" && val !== "true" && val !== "false") return `${policy.name} must be a flag`;
  return null;
}

/** The whole admission decision, framing → host → route → query. */
export function admit(ctx: AdmitContext): AdmitResult {
  if (!ALLOWED_METHODS.has(ctx.method)) {
    // known path + bad method is 405; but unknown method entirely is 405 too
    // per method policy (only GET/HEAD ever admitted)
    return reject(405, "METHOD_NOT_ALLOWED", `method ${ctx.method} not allowed`);
  }
  const framing = checkFraming(ctx);
  if (framing) return framing;

  const host = ctx.headers["host"] as string;
  if (!hostMatches(host, ctx.allowedHosts)) return reject(400, "HOST_NOT_ALLOWED", "Host not in allowlist");

  const normalizedPath = normalizePath(ctx.target);
  if (normalizedPath === null) return reject(400, "MALFORMED_REQUEST", "malformed or ambiguous request target", true);

  const matched = matchRoute(ctx.method, normalizedPath);
  if (matched === null) return reject(404, "ROUTE_NOT_PRESENT", "route not present");
  if (matched === "method") return reject(405, "METHOD_NOT_ALLOWED", "method not allowed for this route");

  const q = validateQuery(ctx.target, matched.route, ctx.maxQueryBytes);
  if ("ok" in q && q.ok === false) return q;
  const query = (q as { ok: true; query: Record<string, string> }).query;

  return { ok: true, route: matched.route, normalizedPath, params: matched.params, query };
}
