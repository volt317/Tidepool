// server/src/services/scheduler.ts
//
// The SCHEDULER: interval triggers over the collector's Unix control
// socket. It owns NO data (no corpus, keyrings, or cache in its mount set)
// and, in the deployed form, NO network namespace (--network=none): its
// entire reachable world is the control socket, the config file, and its
// own heartbeat.
//
// Isolated-appliance evolution: cadence now lives in the VALIDATED
// configuration (config.scheduler / config.maintenance) — one document
// declares what the appliance does. Environment variables remain only for
// deployment wiring (paths/sockets), per the design rule.
//
// Health: a heartbeat file (run/scheduler-heartbeat.json, rewritten every
// tick) that the container HealthCmd checks for freshness — no listener of
// any kind.

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, makeLogger, onShutdown, parseDuration, resolveRuntimeDirs, socketPaths } from "./bootstrap.js";
import { udsRequest } from "./ipc.js";

const log = makeLogger("scheduler");

const initial = loadConfig();
if (!initial.config) {
  log.error("refusing to start — tidepool.config.json failed validation", { errors: initial.errors });
  process.exit(1);
}
const config = initial.config;
const sch = config.scheduler ?? {};
if (sch.enabled === false) {
  log.info("scheduler disabled in configuration — exiting cleanly");
  process.exit(0);
}
const { runDir } = resolveRuntimeDirs(config);
const CONTROL = socketPaths(runDir).control;
const HEARTBEAT = join(runDir, "scheduler-heartbeat.json");

const ms = (d: string | undefined, dflt: string) => parseDuration(d ?? dflt);

interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastDetail: string | null;
  nextRunAt: number;
}

async function control(path: string, body?: unknown): Promise<string> {
  const r = await udsRequest(CONTROL, "POST", path, body, { caller: "scheduler", timeoutMs: 120_000 });
  if (r.status >= 400) throw new Error(`${path} → ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return JSON.stringify(r.body).slice(0, 300);
}

const jitter = (v: number) => v + Math.floor(Math.random() * Math.min(v * 0.05, 300_000));

const jobs: Job[] = [];
function addJob(name: string, intervalMs: number, enabled: boolean, run: () => Promise<unknown>): void {
  if (!enabled || intervalMs <= 0) {
    log.info("job disabled", { job: name });
    return;
  }
  // stagger first runs (5s, then +5min each) so the first snapshot follows
  // the first collection instead of racing it
  const firstDelayMs = 5_000 + jobs.length * 300_000;
  jobs.push({ name, intervalMs, run, lastRunAt: null, lastOk: null, lastDetail: null, nextRunAt: Date.now() + firstDelayMs });
}

addJob("sync-all", ms(sch.collectionInterval, `${config.server.indexTtlHours ?? 6}h`), true, () => control("/internal/control/sync-all"));
addJob("snapshot", ms(sch.snapshotInterval, "24h"), true, () =>
  control("/internal/snapshots", { stage: sch.snapshotStage ?? "interpretive", windowHours: sch.snapshotWindowHours ?? 168 })
);
addJob("verification", ms(sch.verificationInterval, "7d"), true, () => control("/internal/control/maintenance"));
const enrichPolicy = config.maintenance?.enrichment;
addJob("enrich-changed", ms(sch.enrichmentInterval, "24h"), enrichPolicy !== undefined, () =>
  control("/internal/control/enrich-changed", {
    windowHours: enrichPolicy?.changedWindowHours ?? 24,
    limit: enrichPolicy?.maxPerRun ?? 25,
  })
);
// retention stays a deliberate, administratively invoked operation until
// its verification/restore behavior has been exercised (design decision):
if (config.maintenance?.retention?.enabled) {
  log.warn("maintenance.retention.enabled is set, but retention runs only via the retention CLI — see deploy/README.md");
}

function heartbeat(): void {
  const body = JSON.stringify({
    service: "scheduler",
    at: new Date().toISOString(),
    control: CONTROL,
    jobs: jobs.map((j) => ({
      name: j.name,
      intervalMs: j.intervalMs,
      lastRunAt: j.lastRunAt,
      lastOk: j.lastOk,
      lastDetail: j.lastDetail,
      nextRunAt: j.nextRunAt,
    })),
  });
  try {
    writeFileSync(HEARTBEAT + ".tmp", body);
    renameSync(HEARTBEAT + ".tmp", HEARTBEAT);
  } catch (e) {
    log.warn("heartbeat write failed", { error: String(e instanceof Error ? e.message : e) });
  }
}

let running = false;
let timer: ReturnType<typeof setInterval> | null = setInterval(async () => {
  heartbeat();
  if (running) return; // never overlap job execution
  running = true;
  try {
    const now = Date.now();
    for (const j of jobs) {
      if (now < j.nextRunAt) continue;
      j.nextRunAt = now + jitter(j.intervalMs);
      j.lastRunAt = now;
      try {
        j.lastDetail = String(await j.run()).slice(0, 200);
        j.lastOk = true;
        log.info("job completed", { job: j.name });
      } catch (e) {
        j.lastOk = false;
        j.lastDetail = String(e instanceof Error ? e.message : e);
        log.warn("job failed — will retry next interval", { job: j.name, error: j.lastDetail });
      }
    }
  } finally {
    running = false;
    heartbeat();
  }
}, 10_000);

heartbeat();
log.info("scheduler running (unix control socket; no listener)", { control: CONTROL, jobs: jobs.map((j) => j.name) });

onShutdown(log, async () => {
  if (timer) clearInterval(timer);
  timer = null;
});
