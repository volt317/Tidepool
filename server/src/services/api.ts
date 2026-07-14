// server/src/services/api.ts
//
// The API service: the read surface over PUBLISHED truth.
//
//   reads     published/tidepool-read.sqlite3 (SQLITE_OPEN_READONLY),
//             finalized snapshots, publication metadata — and nothing else
//   serves    REST reads, stored enrichment evidence, snapshot exports,
//             the frontend, health (including publication state)
//   must not  mount the writer directory (it doesn't — enforcement is the
//             mount set, not politeness); write any corpus database; touch
//             keyrings or the collector cache; contact the Internet; cause
//             collection or enrichment
//
// Isolated-appliance evolution notes:
//   - the collector-cache read path is GONE: state is reconstructed from
//     the replica via core/readmodel.ts (the cache is private again — its
//     deletion cannot change anything this service returns)
//   - the API↔collector proxy is GONE: control operations are not part of
//     this surface at all; sync/snapshot POSTs answer 405 pointing at the
//     admin CLI (invariant: Internet-facing routes cannot trigger
//     collection)
//   - listener: a Unix socket (fronted by the proxy service) when
//     TIDEPOOL_API_LISTEN=unix, else TCP for development. With the socket
//     listener the container runs --network=none: "no Internet egress" is
//     the absence of a network namespace, not a promise.
//   - API availability does not depend on the collector: once a valid
//     replica exists, reads keep working with the collector stopped.

import express from "express";
import rateLimit from "express-rate-limit";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Aggregator } from "../core/aggregator.js";
import { SnapshotStore } from "../core/snapshot.js";
import { ReplicaHandle, replicaStateFor } from "../core/readmodel.js";
import { buildReadRouter } from "../core/routes.read.js";
import { buildProviders } from "../domains/providers.js";
import { DiskCache } from "../lib/util.js";

import { ROOT, loadConfig, makeLogger, onShutdown, prepareSocket, resolveDirs, resolveRuntimeDirs, socketPaths } from "./bootstrap.js";
import type { TidepoolConfig } from "../../../shared/types.js";

const log = makeLogger("api");

const initial = loadConfig();
if (!initial.config) {
  log.error("refusing to start — tidepool.config.json failed validation", { errors: initial.errors });
  process.exit(1);
}

interface Built {
  config: TidepoolConfig;
  router: express.Router;
  replica: ReplicaHandle;
  publishedDir: string;
  dataDir: string;
}

function build(config: TidepoolConfig): Built {
  const { dataDir } = resolveDirs(config);
  const { publishedDir } = resolveRuntimeDirs(config);
  const replica = new ReplicaHandle(publishedDir, dataDir);
  // throwaway cache dir under /tmp: the aggregator type requires one, but
  // with a stateSource it is never consulted — the collector's cache is not
  // mounted here at all
  const disk = new DiskCache(join(process.env.TMPDIR ?? "/tmp", "tidepool-api-unused-cache"));
  // the replica store is (re)opened lazily per publication; the aggregator's
  // store reference must follow it, so hand out a live proxy
  const storeProxy = new Proxy({} as ReturnType<ReplicaHandle["store"]>, {
    get(_t, prop) {
      const s = replica.store() as unknown as Record<string | symbol, unknown>;
      const v = s[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
    },
  });
  const agg = new Aggregator(buildProviders(config), disk, config, storeProxy, {
    collect: false,
    stateSource: (p) => replicaStateFor(replica, p),
  });
  const snapshots = new SnapshotStore(join(dataDir, "snapshots"));
  return { config, router: buildReadRouter(agg, snapshots), replica, publishedDir, dataDir };
}

let current: Built;
try {
  current = build(initial.config);
} catch (e) {
  log.error("refusing to start", { error: String(e instanceof Error ? e.message : e) });
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "256kb" }));

const general = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
app.use("/api", general);

function publicationMeta(): Record<string, unknown> | null {
  const p = join(current.publishedDir, "publication.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

app.get("/healthz", (_req, res) => {
  const t0 = process.hrtime.bigint();
  let replicaOk = false;
  let counts: Record<string, number> = {};
  if (current.replica.available()) {
    try {
      counts = current.replica.store().counts();
      replicaOk = true;
    } catch {
      /* reported below */
    }
  }
  let snapshotsOk = false;
  try {
    snapshotsOk = Array.isArray(new SnapshotStore(join(current.dataDir, "snapshots")).list());
  } catch {
    /* reported below */
  }
  const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
  res.status(replicaOk ? 200 : 503).json({
    service: "api",
    ok: replicaOk,
    replicaOk,
    snapshotsOk,
    latencyMs,
    counts,
    publication: publicationMeta(),
  });
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
    res.status(400).json({ error: "config invalid; previous config retained", details: next.errors });
    return;
  }
  current.replica.close();
  current = build(next.config);
  res.json({ ok: true, note: "config reloaded" });
});

// control operations are NOT part of this surface (invariant 10): honest
// 405s so the web UI's buttons explain themselves instead of half-working
const notHere = (what: string) => (_req: express.Request, res: express.Response) =>
  res.status(405).json({
    error: `${what} is an administrative operation, not an API route`,
    how: "use the admin CLI against the collector control socket (see deploy/README.md), or let the scheduler run it on policy",
  });
app.post("/api/domains/:domain/units/:unit/sync", notHere("collection"));
app.post("/api/snapshots", notHere("snapshot creation"));

app.use("/api", (req, res, next) => current.router(req, res, next));

if (process.env.TIDEPOOL_SERVE_STATIC !== "0") {
  const dist = process.env.TIDEPOOL_WEB_DIST || join(ROOT, "web", "dist");
  if (existsSync(dist)) {
    app.use(general, express.static(dist));
    app.get(/^\/(?!api\/).*/, general, (_req, res) => res.sendFile(join(dist, "index.html")));
  } else {
    log.warn("static serving enabled but web dist is missing", { dist });
  }
}

// ------------------------------------------------------------- listener
const { runDir } = resolveRuntimeDirs(current.config);
const sockets = socketPaths(runDir);
let server: ReturnType<typeof app.listen>;
if ((process.env.TIDEPOOL_API_LISTEN ?? "").startsWith("unix")) {
  const tighten = prepareSocket(sockets.api);
  server = app.listen(sockets.api, () => {
    tighten();
    log.info("api listening on unix socket (fronted by proxy; --network=none capable)", { socket: sockets.api });
  });
} else {
  const port = current.config.server.port ?? 8747;
  server = app.listen(port, "127.0.0.1", () => {
    log.info("api listening on loopback TCP (development mode)", { port });
  });
}

onShutdown(log, async () => {
  await new Promise<void>((done) => server.close(() => done()));
  current.replica.close();
});
