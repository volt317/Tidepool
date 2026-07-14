// server/src/services/scheduler.ts
//
// The SCHEDULER service: turns Tidepool from request-driven into a
// continuously collecting appliance.
//
//   responsibilities  trigger collection, snapshot generation, and corpus
//                     maintenance on intervals
//   capabilities      talk to the collector's pod-internal control surface;
//                     read config (for TTL-derived defaults)
//   must not          touch the corpus, the cache, keyrings, or upstream
//                     sources — it holds no data access at all
//
// This file is NEW code (no scheduler existed): the smallest process that
// satisfies "trigger collection / snapshot / retention jobs" while owning
// zero state. All configuration is environment-based so the validated
// tidepool.config.json schema did not have to grow:
//
//   TIDEPOOL_SYNC_INTERVAL_HOURS       default: config indexTtlHours (6)
//   TIDEPOOL_SNAPSHOT_INTERVAL_HOURS   default: 24 (0 disables)
//   TIDEPOOL_SNAPSHOT_STAGE            default: interpretive
//   TIDEPOOL_SNAPSHOT_WINDOW_HOURS     default: 168
//   TIDEPOOL_MAINTENANCE_INTERVAL_HOURS default: 24 (0 disables)
//   TIDEPOOL_SCHEDULER_PORT            health endpoint, default: 8749

import express from "express";

import { COLLECTOR_URL, loadConfig, makeLogger, onShutdown } from "./bootstrap.js";

const log = makeLogger("scheduler");

const initial = loadConfig();
if (!initial.config) {
  log.error("refusing to start — tidepool.config.json failed validation", { errors: initial.errors });
  process.exit(1);
}
const config = initial.config;

const hours = (env: string, dflt: number): number => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const SYNC_H = hours("TIDEPOOL_SYNC_INTERVAL_HOURS", config.server.indexTtlHours ?? 6);
const SNAP_H = hours("TIDEPOOL_SNAPSHOT_INTERVAL_HOURS", 24);
const MAINT_H = hours("TIDEPOOL_MAINTENANCE_INTERVAL_HOURS", 24);
const SNAP_STAGE = process.env.TIDEPOOL_SNAPSHOT_STAGE || "interpretive";
const SNAP_WINDOW_H = hours("TIDEPOOL_SNAPSHOT_WINDOW_HOURS", 168);
const PORT = Number(process.env.TIDEPOOL_SCHEDULER_PORT || 8749);

interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastDetail: string | null;
  nextRunAt: number;
}

async function post(path: string, body?: unknown): Promise<string> {
  const r = await fetch(`${COLLECTOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok && r.status !== 202) throw new Error(`${path} → ${r.status}: ${text.slice(0, 200)}`);
  return text.slice(0, 500);
}

const jitter = (ms: number) => ms + Math.floor(Math.random() * Math.min(ms * 0.05, 300_000));

const jobs: Job[] = [];
function addJob(name: string, intervalHours: number, run: () => Promise<unknown>): void {
  if (intervalHours <= 0) {
    log.info("job disabled", { job: name });
    return;
  }
  // stagger the FIRST runs (sync +5s, snapshot +5m, maintenance +10m) so the
  // first snapshot after a cold start captures the first collection instead
  // of racing it; steady-state cadence is interval + jitter thereafter
  const firstDelayMs = 5_000 + jobs.length * 300_000;
  jobs.push({ name, intervalMs: intervalHours * 3600_000, run, lastRunAt: null, lastOk: null, lastDetail: null, nextRunAt: Date.now() + firstDelayMs });
}

addJob("sync-all", SYNC_H, () => post("/internal/control/sync-all"));
addJob("snapshot", SNAP_H, () => post("/internal/snapshots", { stage: SNAP_STAGE, windowHours: SNAP_WINDOW_H }));
addJob("maintenance", MAINT_H, () => post("/internal/control/maintenance"));

// simple single-timer loop: no overlapping runs of the same job, bounded
// retry (next interval), jitter so restarts don't thundering-herd upstream
let timer: ReturnType<typeof setInterval> | null = setInterval(async () => {
  const now = Date.now();
  for (const j of jobs) {
    if (now < j.nextRunAt) continue;
    j.nextRunAt = now + jitter(j.intervalMs);
    j.lastRunAt = now;
    try {
      const detail = await j.run();
      j.lastOk = true;
      j.lastDetail = String(detail).slice(0, 200);
      log.info("job completed", { job: j.name });
    } catch (e) {
      j.lastOk = false;
      j.lastDetail = String(e instanceof Error ? e.message : e);
      log.warn("job failed — will retry next interval", { job: j.name, error: j.lastDetail });
    }
  }
}, 10_000);

const app = express();
app.get("/healthz", (_req, res) => {
  res.json({
    service: "scheduler",
    ok: true,
    collector: COLLECTOR_URL,
    jobs: jobs.map((j) => ({
      name: j.name,
      intervalHours: j.intervalMs / 3600_000,
      lastRunAt: j.lastRunAt,
      lastOk: j.lastOk,
      lastDetail: j.lastDetail,
      nextRunAt: j.nextRunAt,
    })),
  });
});
const server = app.listen(PORT, "127.0.0.1", () => {
  log.info("scheduler running", { port: PORT, jobs: jobs.map((j) => j.name) });
});

onShutdown(log, async () => {
  if (timer) clearInterval(timer);
  timer = null;
  await new Promise<void>((done) => server.close(() => done()));
});
