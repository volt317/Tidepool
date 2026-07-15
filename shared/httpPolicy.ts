// shared/httpPolicy.ts
//
// THE APPLIANCE HTTP SURFACE, AS DATA (strict-admission evolution).
//
// A versioned, deny-by-default route manifest: the proxy admits a request
// only if it matches an entry here — method, normalized path shape,
// declared query parameters, body policy — and the protocol tests compile
// against the same object, so surface and tests cannot drift apart.
//
// Scope discipline (the layered model): this file describes PROTOCOL
// admission only. Packet reachability belongs to the host firewall and
// network namespaces; application semantics remain the API's authority.
// Nothing here claims to block packets — it accepts, rejects, or closes
// HTTP connections that have already arrived.

export const HTTP_POLICY_VERSION = 1;

export type ParamKind = "domain" | "unit" | "package" | "digest" | "format" | "asset";

export interface QueryPolicy {
  name: string;
  type: "string" | "integer" | "enum" | "flag";
  required?: boolean;
  maximumLength?: number;
  minimum?: number;
  maximum?: number;
  allowedValues?: readonly string[];
}

export interface HttpRoutePolicy {
  method: "GET" | "HEAD";
  /** path pattern: literal segments, :param segments (typed below), or a
   *  trailing "*" for the static asset tree */
  path: string;
  params?: Record<string, ParamKind>;
  query?: readonly QueryPolicy[];
  body: "forbidden";
  responseType: "html" | "json" | "snapshot" | "static";
  cachePolicy: "no-store" | "no-cache" | "immutable";
  authentication: "none" | "optional" | "required";
}

/** Identifier shapes — identifiers, never filesystem paths. The API applies
 *  the same rules; store lookups map them to content. */
export const PARAM_PATTERNS: Record<ParamKind, RegExp> = {
  domain: /^[a-z][a-z0-9-]{0,31}$/,
  unit: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  // npm scopes arrive percent-encoded (@scope%2Fname) — after single
  // decoding: letters, digits, @ / . _ - +, no traversal, bounded
  package: /^(?!.*\.\.)[@a-zA-Z0-9][a-zA-Z0-9._+/-]{0,213}$/,
  digest: /^[0-9a-f]{64}$/,
  format: /^(json|md)$/,
  asset: /^(?!.*\.\.)[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/,
};

const pageQuery: QueryPolicy[] = [
  { name: "q", type: "string", maximumLength: 128 },
  { name: "page", type: "integer", minimum: 1, maximum: 100000 },
  { name: "per", type: "integer", minimum: 1, maximum: 500 },
  { name: "advisories", type: "flag" },
  { name: "drift", type: "flag" },
];
const windowQuery: QueryPolicy[] = [
  { name: "from", type: "string", maximumLength: 40 },
  { name: "to", type: "string", maximumLength: 40 },
  { name: "limit", type: "integer", minimum: 1, maximum: 1000 },
];

/** The complete appliance-mode HTTP surface. Anything absent is 404;
 *  a listed path with another method is 405; mutation verbs never appear —
 *  administration is the control socket, not HTTP. */
export const applianceRoutes: readonly HttpRoutePolicy[] = [
  { method: "GET", path: "/", body: "forbidden", responseType: "html", cachePolicy: "no-cache", authentication: "optional" },
  { method: "GET", path: "/index.html", body: "forbidden", responseType: "html", cachePolicy: "no-cache", authentication: "optional" },
  { method: "GET", path: "/assets/*", params: { "*": "asset" }, body: "forbidden", responseType: "static", cachePolicy: "immutable", authentication: "optional" },
  { method: "GET", path: "/vite.svg", body: "forbidden", responseType: "static", cachePolicy: "immutable", authentication: "optional" },

  { method: "GET", path: "/healthz", body: "forbidden", responseType: "json", cachePolicy: "no-store", authentication: "optional" },
  { method: "GET", path: "/api/config", body: "forbidden", responseType: "json", cachePolicy: "no-store", authentication: "optional" },
  { method: "GET", path: "/api/domains", body: "forbidden", responseType: "json", cachePolicy: "no-store", authentication: "optional" },
  {
    method: "GET",
    path: "/api/domains/:domain/units/:unit/packages",
    params: { domain: "domain", unit: "unit" },
    query: pageQuery,
    body: "forbidden", responseType: "json", cachePolicy: "no-store", authentication: "optional",
  },
  {
    method: "GET",
    path: "/api/domains/:domain/units/:unit/packages/:name",
    params: { domain: "domain", unit: "unit", name: "package" },
    body: "forbidden", responseType: "json", cachePolicy: "no-store", authentication: "optional",
  },
  {
    method: "GET",
    path: "/api/domains/:domain/units/:unit/packages/:name/enrich",
    params: { domain: "domain", unit: "unit", name: "package" },
    body: "forbidden", responseType: "json", cachePolicy: "no-store", authentication: "optional",
  },
  {
    method: "GET",
    path: "/api/domains/:domain/units/:unit/observations",
    params: { domain: "domain", unit: "unit" },
    query: windowQuery,
    body: "forbidden", responseType: "json", cachePolicy: "no-store", authentication: "optional",
  },
  {
    method: "GET",
    path: "/api/domains/:domain/units/:unit/changes",
    params: { domain: "domain", unit: "unit" },
    query: windowQuery,
    body: "forbidden", responseType: "json", cachePolicy: "no-store", authentication: "optional",
  },
  { method: "GET", path: "/api/snapshots", body: "forbidden", responseType: "json", cachePolicy: "no-store", authentication: "optional" },
  {
    method: "GET",
    path: "/api/snapshots/:digest",
    params: { digest: "digest" },
    body: "forbidden", responseType: "snapshot", cachePolicy: "immutable", authentication: "optional",
  },
  {
    method: "GET",
    path: "/api/snapshots/:digest/export/:format",
    params: { digest: "digest", format: "format" },
    body: "forbidden", responseType: "snapshot", cachePolicy: "immutable", authentication: "optional",
  },
];

/** Structured, non-disclosing error codes (stable contract). */
export type HttpErrorCode =
  | "MALFORMED_REQUEST"
  | "BODY_FORBIDDEN"
  | "ROUTE_NOT_PRESENT"
  | "METHOD_NOT_ALLOWED"
  | "REQUEST_TOO_LARGE"
  | "HEADERS_TOO_LARGE"
  | "QUERY_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "HOST_NOT_ALLOWED"
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "REQUEST_LIMIT_EXCEEDED"
  | "UPSTREAM_UNAVAILABLE"
  | "SERVICE_OVERLOADED"
  | "REQUEST_TIMEOUT";

/** Hard floors/ceilings for configurable limits — config may move within
 *  these, never outside (reject, don't clamp silently, at validation). */
export const LIMIT_BOUNDS = {
  maxConnections: { min: 8, max: 4096, default: 128 },
  maxConnectionsPerClient: { min: 2, max: 256, default: 16 },
  maxHeaderBytes: { min: 4096, max: 65536, default: 16384 },
  maxHeaders: { min: 16, max: 200, default: 50 },
  maxQueryBytes: { min: 256, max: 16384, default: 4096 },
  requestTimeoutMs: { min: 5000, max: 300000, default: 45000 },
} as const;
