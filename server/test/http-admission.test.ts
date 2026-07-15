// server/test/http-admission.test.ts — the deny-by-default admission engine:
// framing, path normalization, route/method/query/param matching. Pure
// function tests (no sockets); raw-socket TLS framing lives in the CI
// http-security job which needs a running proxy.

import { test } from "node:test";
import assert from "node:assert/strict";

import { admit, normalizePath, type AdmitContext } from "../src/services/httpAdmission.js";

const base = (over: Partial<AdmitContext> = {}): AdmitContext => ({
  method: "GET",
  target: "/api/domains",
  headers: { host: "localhost" },
  rawHeaderLines: ["Host: localhost"],
  allowedHosts: ["localhost", "127.0.0.1", "tidepool.home.arpa"],
  maxQueryBytes: 4096,
  maxHeaders: 50,
  maxHeaderBytes: 16384,
  ...over,
});

test("admits a declared GET route", () => {
  const r = admit(base());
  assert.equal(r.ok, true);
});

test("unknown route → 404 ROUTE_NOT_PRESENT", () => {
  const r = admit(base({ target: "/api/nope" }));
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 404);
});

test("mutation method on a known path → 405", () => {
  const r = admit(base({ method: "POST", target: "/api/snapshots" }));
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 405);
});

test("rejected methods never admitted (PUT/PATCH/DELETE/OPTIONS/TRACE/CONNECT)", () => {
  for (const m of ["PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]) {
    const r = admit(base({ method: m }));
    assert.equal(r.ok, false, `${m} must be rejected`);
    assert.equal((r as { status: number }).status, 405);
  }
});

test("GET with Content-Length > 0 → 413 BODY_FORBIDDEN", () => {
  const r = admit(base({ headers: { host: "localhost", "content-length": "5" }, rawHeaderLines: ["Host: localhost", "Content-Length: 5"] }));
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 413);
});

test("Transfer-Encoding on a read route → rejected + close", () => {
  const r = admit(base({ headers: { host: "localhost", "transfer-encoding": "chunked" }, rawHeaderLines: ["Host: localhost", "Transfer-Encoding: chunked"] }));
  assert.equal(r.ok, false);
  assert.equal((r as { close?: boolean }).close, true);
});

test("duplicate Host → 400 + close", () => {
  const r = admit(base({ headers: { host: ["localhost", "evil"] } }));
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 400);
  assert.equal((r as { close?: boolean }).close, true);
});

test("duplicate Content-Length → 400 + close", () => {
  const r = admit(base({ headers: { host: "localhost", "content-length": ["0", "5"] } }));
  assert.equal(r.ok, false);
  assert.equal((r as { close?: boolean }).close, true);
});

test("too many headers → 431", () => {
  const many = Array.from({ length: 60 }, (_, i) => `X-H-${i}: v`);
  const r = admit(base({ rawHeaderLines: ["Host: localhost", ...many] }));
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 431);
});

test("obsolete line folding → 400", () => {
  const r = admit(base({ rawHeaderLines: ["Host: localhost", " folded: bad"] }));
  assert.equal(r.ok, false);
});

test("invalid header name → 400", () => {
  const r = admit(base({ rawHeaderLines: ["Host: localhost", "Bad Header: x"] }));
  assert.equal(r.ok, false);
});

test("unknown query parameter → 400", () => {
  const r = admit(base({ target: "/api/domains?evil=1" }));
  assert.equal(r.ok, false);
});

test("declared query parameter admitted; page bounds enforced", () => {
  const ok = admit(base({ target: "/api/domains/code/units/npm/packages?page=2&per=50" }));
  assert.equal(ok.ok, true);
  const bad = admit(base({ target: "/api/domains/code/units/npm/packages?per=99999" }));
  assert.equal(bad.ok, false);
});

test("duplicate query parameter → 400", () => {
  const r = admit(base({ target: "/api/domains/code/units/npm/packages?page=1&page=2" }));
  assert.equal(r.ok, false);
});

test("path traversal rejected by normalization", () => {
  assert.equal(normalizePath("/api/../etc/passwd"), null);
  assert.equal(normalizePath("/api/%2e%2e/secret"), null);
  assert.equal(normalizePath("/a/./b"), null);
  assert.equal(normalizePath("/a\\b"), null);
  assert.equal(normalizePath("/ok/path"), "/ok/path");
});

test("NUL and control chars in path rejected", () => {
  assert.equal(normalizePath("/api/%00"), null);
});

test("malformed percent-encoding rejected", () => {
  assert.equal(normalizePath("/api/%zz"), null);
  assert.equal(normalizePath("/api/%f"), null);
});

test("invalid digest shape → 404 (not a match), valid shape passes to API", () => {
  const bad = admit(base({ target: "/api/snapshots/nothex" }));
  assert.equal((bad as { status: number }).status, 404);
  const good = admit(base({ target: "/api/snapshots/" + "a".repeat(64) }));
  assert.equal(good.ok, true);
});

test("Host allowlist enforced", () => {
  const r = admit(base({ headers: { host: "evil.example.com" }, rawHeaderLines: ["Host: evil.example.com"] }));
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 400);
});

test("Host with port still matches allowlist entry", () => {
  const r = admit(base({ headers: { host: "localhost:8760" }, rawHeaderLines: ["Host: localhost:8760"] }));
  assert.equal(r.ok, true);
});

test("static asset tree matches under /assets/*", () => {
  const r = admit(base({ target: "/assets/index-abc123.js" }));
  assert.equal(r.ok, true);
  assert.equal((r as { route: { responseType: string } }).route.responseType, "static");
});

test("query string over the byte bound → rejected", () => {
  const r = admit(base({ target: "/api/domains/code/units/npm/packages?q=" + "a".repeat(5000) }));
  assert.equal(r.ok, false);
});
