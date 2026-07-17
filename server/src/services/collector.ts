// server/src/services/collector.ts
//
// The COLLECTOR service: the ONLY Tidepool process that touches the
// Internet, the ONLY writer of the authoritative corpus, and — new in the
// isolated-appliance evolution — the PUBLISHER of the read replica every
// other consumer lives on.
//
//   responsibilities  fetch, verify, normalize, preserve artifacts, write
//                     observations/changes, build snapshots, process bounded
//                     enrichment, publish the read replica
//   capabilities      outbound HTTPS/DNS; config + keyrings (ro);
//                     corpus + cache + published + run (rw)
//   must not          expose ANY TCP listener; serve UI; accept arbitrary
//                     fetch URLs (every control request is validated against
//                     the loaded configuration)
//
// Control surface: JSON-over-HTTP on a UNIX DOMAIN SOCKET
// (run/collector-control.sock). No TCP at all — the previous pod-loopback
// port is gone. Socket mode 0660 plus per-service mounts scope who can dial.

import express from "../http/index.js";

import { Aggregator } from "../core/aggregator.js";
import { SqliteObservationStore } from "../core/store.js";
import { SnapshotStore } from "../core/snapshot.js";
import { buildControlRouter } from "../core/routes.control.js";
import { buildProviders } from "../domains/providers.js";
import { DiskCache } from "../lib/util.js";
import { availableKeyrings, gpgvAvailable } from "../lib/gpg.js";
import { join } from "node:path";
import { accessSync, constants, mkdirSync } from "node:fs";

import {
  generatorIdentity,
  loadConfig,
  makeLogger,
  onShutdown,
  prepareSocket,
  resolveDirs,
  resolveRuntimeDirs,
  socketPaths,
} from "./bootstrap.js";

const log = makeLogger("collector");

// ------------------------------------------------------------ start-up
// Fail safely: every critical resource is validated BEFORE the service
// starts collecting.

const initial = loadConfig();
if (!initial.config) {
  log.error("refusing to start — tidepool.config.json failed validation", { errors: initial.errors });
  process.exit(1);
}
const config = initial.config;
const { cacheDir, dataDir } = resolveDirs(config);
const { runDir, publishedDir } = resolveRuntimeDirs(config);
const sockets = socketPaths(runDir);

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

for (const dir of [dataDir, cacheDir, publishedDir, runDir]) mkdirSync(dir, { recursive: true });
for (const dir of [dataDir, cacheDir, publishedDir, runDir]) {
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    log.error("refusing to start — required writable directory is missing or read-only", { dir });
    process.exit(1);
  }
}

let store: SqliteObservationStore;
try {
  store = new SqliteObservationStore(dataDir);
} catch (e) {
  log.error("refusing to start — corpus failed to open/migrate", { error: String(e instanceof Error ? e.message : e) });
  process.exit(1);
}
const startupVerify = store.verifyCorpus();
if (!startupVerify.ok) {
  const sqliteOk = startupVerify.checks.find((c) => c.name === "sqlite-integrity")?.ok ?? false;
  log.error("corpus verification reported problems at startup", { checks: startupVerify.checks });
  if (!sqliteOk) process.exit(1);
} else {
  log.info("corpus verified at startup", { checks: startupVerify.checks.length });
}

const disk = new DiskCache(cacheDir); // PRIVATE optimization — nothing else reads it
const snapshots = new SnapshotStore(join(dataDir, "snapshots"), store);
snapshots.provenance = { ...generatorIdentity(), configDigest: initial.configDigest ?? null, storeMigrations: null };
const agg = new Aggregator(buildProviders(config), disk, config, store, { recordEvidence: true });

// ------------------------------------------------------------ publication
// Debounced replica publication: mutations coalesce (a sync-all of a dozen
// units publishes once, shortly after the last one lands). Publication is
// serialized — never two backup passes at once.

const provenance = { ...generatorIdentity(), role: "collector" };
let publishTimer: ReturnType<typeof setTimeout> | null = null;
let publishing: Promise<void> = Promise.resolve();
let lastPublication: { at: string; digest: string; reason: string } | null = null;

function publishSoon(reason: string): void {
  if (config.maintenance?.publishReplicaAfterCollection === false && reason !== "explicit publish request" && reason !== "startup") return;
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publishing = publishing.then(async () => {
      try {
        const out = await store.publishReplica(publishedDir, provenance);
        lastPublication = { at: new Date().toISOString(), digest: out.digest, reason };
        log.info("read replica published", { reason, digest: out.digest.slice(0, 12) });
      } catch (e) {
        log.error("replica publication failed", { reason, error: String(e instanceof Error ? e.message : e) });
      }
    });
  }, 2000);
  publishTimer.unref();
}

// -------------------------------------------------------------- server

const app = express();
app.use(express.json({ limit: 262_144 })); // control bodies are small by contract

app.get("/healthz", (_req, res) => {
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
    lastPublication,
    units: units.map((u) => ({ unit: `${u.domain}/${u.id}`, status: u.status, finishedAt: u.finishedAt, error: u.error })),
  });
});

app.use(
  "/internal",
  buildControlRouter(agg, snapshots, {
    afterMutation: publishSoon,
    logRequest: (fields) => log.info("control request", fields),
  })
);

const tighten = prepareSocket(sockets.control);
const server = app.listen(sockets.control, () => {
  tighten();
  log.info("collector control surface listening (unix socket — no TCP)", { socket: sockets.control, dataDir, publishedDir });
  // ensure consumers have SOMETHING as soon as a corpus exists
  publishSoon("startup");
});

// ------------------------------------------------------------- shutdown
// Stop accepting control requests, complete in-flight observations
// (bounded), let a pending publication finish, close the writer cleanly.

onShutdown(
  log,
  async () => {
    await new Promise<void>((done) => server.close(() => done()));
    const deadline = Date.now() + 90_000;
    while (agg.busy() > 0 && Date.now() < deadline) {
      log.info("waiting for in-flight observations", { pendingSyncs: agg.busy() });
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (agg.busy() > 0) log.warn("shutdown proceeding with syncs still in flight", { pendingSyncs: agg.busy() });
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    await publishing; // never abandon a half-written replica temp file
    store.close();
  },
  110_000 // Quadlet TimeoutStopSec=120 leaves headroom above this
);
