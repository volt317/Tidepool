// server/src/index.ts
//
// Thin bootstrap: read config, build domain providers, hand them to the
// contained core, mount the routes. All aggregation logic lives in
// core/aggregator.ts; all domain knowledge in domains/.
//
// DEPLOYMENT NOTE: this is the single-process DEVELOPMENT mode (collection,
// API, and snapshot creation in one process). The hardened container
// deployment (deploy/) runs the split entrypoints instead:
//   services/collector.ts   network egress + the SQLite writer
//   services/api.ts         read-only presentation surface
//   services/scheduler.ts   interval triggers
// buildRouter() below composes routes.read.ts + routes.control.ts, so this
// mode's HTTP surface is byte-identical to what it was before the split.

import express from "express";
import rateLimit from "express-rate-limit";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseJsonCorpus, readCorpusText } from "./lib/corpus.js";
import { validateConfig } from "./lib/validate.js";

import type { TidepoolConfig } from "../../shared/types.js";
import { Aggregator } from "./core/aggregator.js";
import { SqliteObservationStore } from "./core/store.js";
import { SnapshotStore } from "./core/snapshot.js";
import { buildRouter } from "./core/routes.js";
import { buildProviders } from "./domains/providers.js";
import { DiskCache } from "./lib/util.js";
import { prepareSocket, resolveRuntimeDirs, socketPaths } from "./services/bootstrap.js";
import { DEPLOY_CONFIG } from "../../shared/deployConfig.generated.js";

const ROOT = resolve(process.env.TIDEPOOL_ROOT || process.cwd());

/**
 * Config pipeline, three separated steps: (1) one whole-corpus read;
 * (2) parse the corpus into a JSON object after the fact; (3) validate the
 * object in code — types, ranges, URL schemes, enums, unknown keys. Nothing
 * downstream ever sees an unvalidated value.
 */
function loadConfig(): { config?: TidepoolConfig; errors: string[] } {
  const path = join(ROOT, "tidepool.config.json");
  let parsed: unknown;
  try {
    parsed = parseJsonCorpus(readCorpusText(path), "tidepool.config.json");
  } catch (e) {
    return { errors: [String(e instanceof Error ? e.message : e)] };
  }
  return validateConfig(parsed);
}

function build(config: TidepoolConfig): { config: TidepoolConfig; router: express.Router; store: SqliteObservationStore } {
  // .cache stays a disposable TTL response cache; .tidepool is the durable
  // evidence store — two directories, two very different contracts
  const cacheDir = join(ROOT, config.server.cacheDir ?? ".cache");
  const dataDir = join(ROOT, config.server.dataDir ?? ".tidepool");
  const disk = new DiskCache(cacheDir);
  const store = new SqliteObservationStore(dataDir);
  const snapshots = new SnapshotStore(join(dataDir, "snapshots"), store);
  const agg = new Aggregator(buildProviders(config), disk, config, store);
  return { config, router: buildRouter(agg, snapshots), store };
}

const initial = loadConfig();
if (!initial.config) {
  console.error("tidepool: refusing to start — tidepool.config.json failed validation:");
  for (const e of initial.errors) console.error(`  - ${e}`);
  process.exit(1);
}
let current = build(initial.config);

const app = express();
app.use(express.json());

// self-hosted service, but sync/snapshot POSTs trigger real upstream work —
// bound how fast anyone can make this machine fetch archives
const expensive = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const general = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
app.use("/api", (req, res, next) => (req.method === "POST" ? expensive(req, res, next) : general(req, res, next)));

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

app.use("/api", (req, res, next) => current.router(req, res, next));

if (process.env.TIDEPOOL_SERVE_STATIC === "1") {
  const dist = join(ROOT, "web", "dist");
  if (existsSync(dist)) {
    app.use(general, express.static(dist));
    app.get(/^\/(?!api\/).*/, general, (_req, res) => res.sendFile(join(dist, "index.html")));
  } else {
    console.warn("TIDEPOOL_SERVE_STATIC=1 but web/dist is missing — run `npm run build` first.");
  }
}

const port = current.config.server.port ?? DEPLOY_CONFIG.listenPort; // fallback baked from deploy.yaml at compile time
app.listen(port, () => {
  console.log(`tidepool service listening on :${port} (root: ${ROOT})`);
});

// Deployment parity: dev mode also serves the control surface on the same
// Unix socket path the appliance's collector uses, so the admin CLI
// (`npm run admin …`) works identically against `npm start` and against a
// deployed collector. The composed router already contains the control
// routes; this is a second, local-only door to the same handlers.
try {
  const control = express();
  control.use(express.json({ limit: "256kb" }));
  control.get("/healthz", (_req, res) => res.json({ service: "dev", ok: true, note: "single-process development mode" }));
  control.use("/internal", (req, res, next) => current.router(req, res, next));
  const sock = socketPaths(resolveRuntimeDirs(current.config).runDir).control;
  const tighten = prepareSocket(sock);
  control.listen(sock, () => {
    tighten();
    console.log(`tidepool control socket at ${sock} (admin CLI: npm run admin …)`);
  });
} catch (e) {
  console.warn(`control socket unavailable (${String(e instanceof Error ? e.message : e)}) — admin CLI disabled in this session`);
}
