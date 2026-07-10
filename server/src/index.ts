// server/src/index.ts
//
// Thin bootstrap: read config, build domain providers, hand them to the
// contained core, mount the routes. All aggregation logic lives in
// core/aggregator.ts; all domain knowledge in domains/.

import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { TidepoolConfig } from "../../shared/types.js";
import { Aggregator } from "./core/aggregator.js";
import { InflowStore } from "./core/inflow.js";
import { SnapshotStore } from "./core/snapshot.js";
import { buildRouter } from "./core/routes.js";
import { buildProviders } from "./domains/providers.js";
import { DiskCache } from "./lib/util.js";

const ROOT = resolve(process.env.TIDEPOOL_ROOT || process.cwd());

function loadConfig(): TidepoolConfig {
  return JSON.parse(readFileSync(join(ROOT, "tidepool.config.json"), "utf8")) as TidepoolConfig;
}

function build(): { config: TidepoolConfig; router: express.Router } {
  const config = loadConfig();
  const cacheDir = join(ROOT, config.server.cacheDir ?? ".cache");
  const disk = new DiskCache(cacheDir);
  const inflow = new InflowStore(join(cacheDir, "history"));
  const snapshots = new SnapshotStore(join(cacheDir, "snapshots"));
  const agg = new Aggregator(buildProviders(config), disk, config, inflow);
  return { config, router: buildRouter(agg, inflow, snapshots) };
}

let current = build();

const app = express();
app.use(express.json());

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
  current = build();
  res.json({ ok: true, note: "config reloaded; unit state cleared" });
});

app.use("/api", (req, res, next) => current.router(req, res, next));

if (process.env.TIDEPOOL_SERVE_STATIC === "1") {
  const dist = join(ROOT, "web", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
  } else {
    console.warn("TIDEPOOL_SERVE_STATIC=1 but web/dist is missing — run `npm run build` first.");
  }
}

const port = current.config.server.port ?? 8747;
app.listen(port, () => {
  console.log(`tidepool service listening on :${port} (root: ${ROOT})`);
});
