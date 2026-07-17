// server/test/http.binder.test.ts — the local HTTP binder under adversarial
// and behavioral tests: routing/params, HEAD derivation, ETag/304, body
// caps and content-type, static path traversal, rate-limit windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express, { Router, rateLimit } from "../src/http/index.js";

function listen(app: { listen: (...a: unknown[]) => Server }): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve({ base: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`, server });
    });
  });
}

test("router: params, mounts, 404 default, HEAD derives from GET", async () => {
  const app = express();
  const r = Router();
  r.get("/d/:a/u/:b", (req, res) => res.json({ a: req.params.a, b: req.params.b, q: req.query.x ?? null }));
  app.use("/api", (req, res, next) => r(req, res, next));
  const { base, server } = await listen(app);
  try {
    const ok = await fetch(base + "/api/d/one/u/two?x=3");
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { a: "one", b: "two", q: "3" });
    assert.equal((await fetch(base + "/api/d/one")).status, 404);
    assert.equal((await fetch(base + "/nope")).status, 404);
    const head = await fetch(base + "/api/d/one/u/two", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.ok(Number(head.headers.get("content-length")) > 0);
  } finally { server.close(); }
});

test("respond: ETag + If-None-Match → 304", async () => {
  const app = express();
  app.get("/x", (_req, res) => res.json({ stable: true }));
  const { base, server } = await listen(app);
  try {
    const first = await fetch(base + "/x");
    const etag = first.headers.get("etag");
    assert.ok(etag && etag.startsWith('W/"'));
    const second = await fetch(base + "/x", { headers: { "If-None-Match": etag } });
    assert.equal(second.status, 304);
  } finally { server.close(); }
});

test("body: cap enforced, wrong content-type 415, malformed 400", async () => {
  const app = express();
  app.use(express.json({ limit: 64 }));
  app.post("/b", (req, res) => res.json({ got: req.body }));
  const { base, server } = await listen(app);
  try {
    const big = await fetch(base + "/b", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "y".repeat(200) }) });
    assert.equal(big.status, 413);
    const wrong = await fetch(base + "/b", { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
    assert.equal(wrong.status, 415);
    const bad = await fetch(base + "/b", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
    const good = await fetch(base + "/b", { method: "POST", headers: { "content-type": "application/json" }, body: '{"k":1}' });
    assert.deepEqual(await good.json(), { got: { k: 1 } });
  } finally { server.close(); }
});

test("static: serves inside root, refuses traversal and null bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "binder-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html>ok</html>");
  writeFileSync(join(dir, "assets", "a.js"), "1;");
  const app = express();
  app.use(express.static(dir));
  const { base, server } = await listen(app);
  try {
    assert.equal((await fetch(base + "/")).status, 200);
    const js = await fetch(base + "/assets/a.js");
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(js.headers.get("cache-control") ?? "", /immutable/);
    for (const evil of ["/../etc/passwd", "/..%2f..%2fetc%2fpasswd", "/assets/%2e%2e/%2e%2e/etc/passwd", "/%00"]) {
      const r = await fetch(base + evil);
      assert.ok([400, 403, 404].includes(r.status), `${evil} → ${r.status}`);
    }
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ratelimit: fixed window trips at limit with standard headers", async () => {
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 3 }));
  app.get("/r", (_req, res) => res.json({ ok: 1 }));
  const { base, server } = await listen(app);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(base + "/r")).status, 200);
    const over = await fetch(base + "/r");
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("ratelimit-remaining"), "0");
  } finally { server.close(); }
});
