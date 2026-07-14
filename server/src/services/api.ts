// server/src/services/api.ts
//
// The API service: serves the REST read surface, the frontend, snapshot
// listings and exports — and NOTHING that reaches upstream or writes the
// corpus.
//
//   responsibilities  REST API, frontend, corpus queries, exports, health
//   capabilities      read config; read corpus (query-only SQLite
//                     connection); read the collector-written disk cache
//   must not          perform upstream collection; write the corpus;
//                     perform arbitrary outbound networking
//
// REFACTOR NOTE (deployment split): the express bootstrap here was MOVED
// from index.ts (rate limits, /api/config redaction, static serving,
// /api/reload fail-closed semantics — all verbatim). What changed to fit
// the service boundary:
//   - the store opens with { readOnly: true }  → query_only connection
//   - the Aggregator is built with { collect: false } → cache-only reads
//   - the router mounted is the READ router only
//   - the three control operations the web UI uses (sync, enrich, snapshot
//     creation) are proxied over the pod-internal loopback to the collector,
//     which is the only process allowed to do them. This is fixed-target
//     message passing to a sibling service, not arbitrary egress.

import express from "express";
import rateLimit from "express-rate-limit";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Aggregator } from "../core/aggregator.js";
import { SqliteObservationStore } from "../core/store.js";
import { SnapshotStore } from "../core/snapshot.js";
import { buildReadRouter } from "../core/routes.read.js";
import { buildProviders } from "../domains/providers.js";
import { DiskCache } from "../lib/util.js";

import { COLLECTOR_URL, ROOT, loadConfig, makeLogger, onShutdown, resolveDirs } from "./bootstrap.js";
import type { TidepoolConfig } from "../../../shared/types.js";

const log = makeLogger("api");

const initial = loadConfig();
if (!initial.config) {
  log.error("refusing to start — tidepool.config.json failed validation", { errors: initial.errors });
  process.exit(1);
}

function build(config: TidepoolConfig): { config: TidepoolConfig; router: express.Router; store: SqliteObservationStore } {
  const { cacheDir, dataDir } = resolveDirs(config);
  const disk = new DiskCache(cacheDir);
  // readOnly: query_only connection — SQLite rejects writes; migrations are
  // verified (never applied) so schema drift fails at startup, visibly
  const store = new SqliteObservationStore(dataDir, undefined, { readOnly: true });
  // manifests writer deliberately NOT passed: this SnapshotStore can only
  // load/list/export existing snapshots, never record new manifests
  const snapshots = new SnapshotStore(join(dataDir, "snapshots"));
  const agg = new Aggregator(buildProviders(config), disk, config, store, { collect: false });
  return { config, router: buildReadRouter(agg, snapshots), store };
}

let current: ReturnType<typeof build>;
try {
  current = build(initial.config);
} catch (e) {
  log.error("refusing to start — corpus unavailable or schema not migrated", {
    error: String(e instanceof Error ? e.message : e),
  });
  process.exit(1);
}

const app = express();
app.use(express.json());

// self-hosted service, but sync/snapshot POSTs trigger real upstream work —
// bound how fast anyone can make this machine fetch archives
// (moved verbatim from index.ts)
const expensive = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const general = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
app.use("/api", (req, res, next) => (req.method === "POST" ? expensive(req, res, next) : general(req, res, next)));

app.get("/healthz", (_req, res) => {
  // SQLite availability + snapshot store reachability + trivially, latency
  const t0 = process.hrtime.bigint();
  let sqliteOk = false;
  let snapshotsOk = false;
  let counts: Record<string, number> = {};
  try {
    counts = current.store.counts();
    sqliteOk = true;
  } catch {
    /* reported below */
  }
  try {
    snapshotsOk = Array.isArray(new SnapshotStore(join(resolveDirs(current.config).dataDir, "snapshots")).list());
  } catch {
    /* reported below */
  }
  const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
  res.status(sqliteOk ? 200 : 503).json({ service: "api", ok: sqliteOk, sqliteOk, snapshotsOk, latencyMs, counts });
});

app.get("/api/config", (_req, res) => {
  const { server, distros, ecosystems, packageHints, enrichment } = current.config;
  res.json({
    server: { ...server },
    distros,
    ecosystems: ecosystems ?? [],
    packageHints,
    enrichment: { ...enrichment, githubToken: enrichment?.githubToken ? "(set)" : "" },
  });
});

app.post("/api/reload", (_req, res) => {
  const next = loadConfig();
  if (!next.config) {
    // fail closed on the reload, not the service: keep running on the last
    // valid config and report exactly which fields are wrong
    res.status(400).json({ error: "config invalid; previous config retained", details: next.errors });
    return;
  }
  current.store.close();
  current = build(next.config);
  res.json({ ok: true, note: "config reloaded; unit state cleared" });
});

// ---------------------------------------------------------------- proxy
// The three control operations, forwarded to the collector's pod-internal
// control surface. Paths are pinned; bodies pass through; nothing else is
// forwardable. If the collector is down, the truthful answer is 503 —
// reads keep working from the corpus.
async function forward(req: express.Request, res: express.Response): Promise<void> {
  try {
    const upstream = await fetch(`${COLLECTOR_URL}/internal${req.path.replace(/^\/api/, "")}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
    });
    const body = await upstream.text();
    res.status(upstream.status).type("application/json").send(body);
  } catch {
    res.status(503).json({ error: "collector unavailable — collection, enrichment and snapshot creation are handled by the collector service" });
  }
}
app.post("/api/domains/:domain/units/:unit/sync", forward);
app.get("/api/domains/:domain/units/:unit/packages/:name/enrich", forward);
app.post("/api/snapshots", forward);

app.use("/api", (req, res, next) => current.router(req, res, next));

// static frontend (moved verbatim from index.ts; on by default in the API
// image — this IS the presentation service)
if (process.env.TIDEPOOL_SERVE_STATIC !== "0") {
  const dist = process.env.TIDEPOOL_WEB_DIST || join(ROOT, "web", "dist");
  if (existsSync(dist)) {
    app.use(general, express.static(dist));
    app.get(/^\/(?!api\/).*/, general, (_req, res) => res.sendFile(join(dist, "index.html")));
  } else {
    log.warn("static serving enabled but web dist is missing", { dist });
  }
}

const port = current.config.server.port ?? 8747;
const server = app.listen(port, () => {
  log.info("api listening", { port, root: ROOT });
});

onShutdown(log, async () => {
  await new Promise<void>((done) => server.close(() => done()));
  current.store.close();
});
