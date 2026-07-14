// server/src/services/collector.ts
//
// The COLLECTOR service: the only Tidepool process that (a) reaches the
// network and (b) owns the single SQLite writer connection.
//
//   responsibilities  fetch upstream sources, verify signatures, normalize,
//                     preserve artifacts, write observations/changes,
//                     build snapshots (manifest rows are corpus writes)
//   capabilities      outbound HTTPS/DNS; read config + keyrings;
//                     read/write corpus + cache
//   must not          publish a port; serve UI; evaluate local projects
//
// Its HTTP control surface (routes.control.ts, moved from routes.ts) binds
// to the pod-internal loopback ONLY. In a Podman pod every container shares
// one network namespace, so the API and scheduler reach it on 127.0.0.1
// while nothing outside the pod can. Quadlet never publishes this port.
//
// REFACTOR NOTE: the build wiring below is the collector's half of what
// index.ts's build() used to do; nothing new besides the health endpoint,
// startup validation, and graceful drain.

import express from "express";

import { Aggregator } from "../core/aggregator.js";
import { SqliteObservationStore } from "../core/store.js";
import { SnapshotStore } from "../core/snapshot.js";
import { buildControlRouter } from "../core/routes.control.js";
import { buildProviders } from "../domains/providers.js";
import { DiskCache } from "../lib/util.js";
import { availableKeyrings, gpgvAvailable } from "../lib/gpg.js";
import { join } from "node:path";
import { accessSync, constants } from "node:fs";

import { COLLECTOR_BIND, COLLECTOR_PORT, loadConfig, makeLogger, onShutdown, resolveDirs } from "./bootstrap.js";

const log = makeLogger("collector");

// ------------------------------------------------------------ start-up
// Fail safely: every critical resource is validated BEFORE the service
// starts collecting. A collector that cannot verify signatures or cannot
// write the corpus must not run half-blind.

const initial = loadConfig();
if (!initial.config) {
  log.error("refusing to start — tidepool.config.json failed validation", { errors: initial.errors });
  process.exit(1);
}
const config = initial.config;
const { cacheDir, dataDir } = resolveDirs(config);

// keyring + gpgv validation: any signature-verifying distro needs gpgv and
// at least one of its configured keyrings present, or its pockets would
// fail closed forever — surface that at startup, not per-sync.
const signing = (config.distros ?? []).filter((d) => d.enabled !== false && d.index && (d.index as { verifySignatures?: boolean }).verifySignatures);
if (signing.length > 0 && !gpgvAvailable()) {
  log.error("refusing to start — gpgv is unavailable but verifySignatures is configured", {
    distros: signing.map((d) => d.id),
  });
  process.exit(1);
}
for (const d of signing) {
  const keyrings = ((d.index as { keyrings?: string[] }).keyrings ?? []) as string[];
  const present = availableKeyrings(keyrings);
  if (keyrings.length > 0 && present.length === 0) {
    log.error("refusing to start — none of the configured keyrings exist", { distro: d.id, keyrings });
    process.exit(1);
  }
}

// corpus + cache must be writable bind mounts
for (const dir of [dataDir, cacheDir]) {
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    log.error("refusing to start — required writable directory is missing or read-only", { dir });
    process.exit(1);
  }
}

// opening the store applies migrations transactionally (with automatic
// pre-migration backup handled by deploy/scripts/backup.sh in the Quadlet
// deployment via ExecStartPre) and validates the schema ledger digests
let store: SqliteObservationStore;
try {
  store = new SqliteObservationStore(dataDir);
} catch (e) {
  log.error("refusing to start — corpus failed to open/migrate", { error: String(e instanceof Error ? e.message : e) });
  process.exit(1);
}
const startupVerify = store.verifyCorpus();
if (!startupVerify.ok) {
  // integrity problems are visible facts; degrade loudly but do not
  // silently continue if SQLite itself reports corruption
  const sqliteOk = startupVerify.checks.find((c) => c.name === "sqlite-integrity")?.ok ?? false;
  log.error("corpus verification reported problems at startup", { checks: startupVerify.checks });
  if (!sqliteOk) process.exit(1);
} else {
  log.info("corpus verified at startup", { checks: startupVerify.checks.length });
}

const disk = new DiskCache(cacheDir);
const snapshots = new SnapshotStore(join(dataDir, "snapshots"), store);
const agg = new Aggregator(buildProviders(config), disk, config, store); // collect: true (default)

// -------------------------------------------------------------- server

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  // machine-readable collector health: last successful collection per unit,
  // pending (in-flight) work, and failed sources — straight from unit state.
  const domains = agg.domains();
  const units = domains.flatMap((d) => d.units);
  const failedSources = units.flatMap((u) =>
    (u.sources ?? []).filter((s) => s.status !== "ok").map((s) => ({ unit: `${u.domain}/${u.id}`, source: s.id, error: s.error ?? null }))
  );
  const lastFinished = units.reduce<number | null>((m, u) => (u.finishedAt && (!m || u.finishedAt > m) ? u.finishedAt : m), null);
  res.json({
    service: "collector",
    ok: true,
    lastSuccessfulCollection: lastFinished,
    pendingSyncs: agg.busy(),
    failedSources,
    units: units.map((u) => ({ unit: `${u.domain}/${u.id}`, status: u.status, finishedAt: u.finishedAt, error: u.error })),
  });
});

app.use("/internal", buildControlRouter(agg, snapshots));

const server = app.listen(COLLECTOR_PORT, COLLECTOR_BIND, () => {
  log.info("collector control surface listening (pod-internal)", { bind: COLLECTOR_BIND, port: COLLECTOR_PORT, dataDir, cacheDir });
});

// ------------------------------------------------------------- shutdown
// "Collectors should complete current observations before shutdown":
// stop accepting control requests, wait (bounded) for in-flight syncs so no
// observation is half-recorded, then close the writer connection cleanly.

onShutdown(
  log,
  async () => {
    await new Promise<void>((done) => server.close(() => done()));
    const deadline = Date.now() + 55_000;
    while (agg.busy() > 0 && Date.now() < deadline) {
      log.info("waiting for in-flight observations", { pendingSyncs: agg.busy() });
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (agg.busy() > 0) log.warn("shutdown proceeding with syncs still in flight", { pendingSyncs: agg.busy() });
    store.close();
  },
  60_000
);
