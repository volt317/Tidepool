// server/src/services/bootstrap.ts
//
// Shared bootstrap for the split service entrypoints (collector / api /
// scheduler).
//
// REFACTOR NOTE (deployment split): loadConfig() and the ROOT/path
// resolution were MOVED here from index.ts so that every service reads its
// configuration through the identical validated pipeline. index.ts still
// works as the all-in-one development mode.
//
// NEW here (additive, to fit the container layout without changing the
// config schema): environment overrides for where things live, so the same
// images can mount /var/lib/tidepool/{config,corpus,cache} read-only or
// read-write per service:
//
//   TIDEPOOL_CONFIG     absolute path to tidepool.config.json
//   TIDEPOOL_DATA_DIR   corpus directory  (overrides config.server.dataDir)
//   TIDEPOOL_CACHE_DIR  cache directory   (overrides config.server.cacheDir)
//
// All default to the historical ROOT-relative behavior when unset.

import { dirname, join, resolve } from "node:path";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";

import { parseJsonCorpus, readCorpusText } from "../lib/corpus.js";
import { sha256hex } from "../lib/util.js";
import { validateConfig } from "../lib/validate.js";
import type { TidepoolConfig } from "../../../shared/types.js";

export const ROOT = resolve(process.env.TIDEPOOL_ROOT || process.cwd());

/**
 * Config pipeline, three separated steps: (1) one whole-corpus read;
 * (2) parse the corpus into a JSON object after the fact; (3) validate the
 * object in code — types, ranges, URL schemes, enums, unknown keys. Nothing
 * downstream ever sees an unvalidated value.
 * (Moved verbatim from index.ts; the only change is the TIDEPOOL_CONFIG
 * path override.)
 */
export function loadConfig(): { config?: TidepoolConfig; errors: string[]; configDigest?: string } {
  const path = process.env.TIDEPOOL_CONFIG
    ? resolve(process.env.TIDEPOOL_CONFIG)
    : join(ROOT, "tidepool.config.json");
  let parsed: unknown;
  let raw: string;
  try {
    raw = readCorpusText(path);
    parsed = parseJsonCorpus(raw, "tidepool.config.json");
  } catch (e) {
    return { errors: [String(e instanceof Error ? e.message : e)] };
  }
  const v = validateConfig(parsed);
  // provenance: the exact configuration document behind every snapshot
  return { ...v, configDigest: sha256hex(Buffer.from(raw)) };
}

/** Resolve the two on-disk trees every service agrees on. */
export function resolveDirs(config: TidepoolConfig): { cacheDir: string; dataDir: string } {
  const cacheDir = process.env.TIDEPOOL_CACHE_DIR
    ? resolve(process.env.TIDEPOOL_CACHE_DIR)
    : resolve(ROOT, config.server.cacheDir ?? ".cache");
  const dataDir = process.env.TIDEPOOL_DATA_DIR
    ? resolve(process.env.TIDEPOOL_DATA_DIR)
    : resolve(ROOT, config.server.dataDir ?? ".tidepool");
  return { cacheDir, dataDir };
}

/** Resolve the runtime (sockets) and publication (read replica) trees.
 *  Deployment-evolution: the control plane is Unix domain sockets, not TCP;
 *  the published replica is the API's only database. Env overrides define
 *  deployment wiring; defaults keep single-directory dev working. */
export function resolveRuntimeDirs(config: TidepoolConfig): { runDir: string; publishedDir: string } {
  const { dataDir } = resolveDirs(config);
  const runDir = process.env.TIDEPOOL_RUN_DIR ? resolve(process.env.TIDEPOOL_RUN_DIR) : join(dataDir, "run");
  const publishedDir = process.env.TIDEPOOL_PUBLISHED_DIR ? resolve(process.env.TIDEPOOL_PUBLISHED_DIR) : join(dataDir, "published");
  return { runDir, publishedDir };
}

/** Socket paths (overridable individually for container wiring). */
export function socketPaths(runDir: string): { control: string; api: string; scheduler: string } {
  return {
    control: process.env.TIDEPOOL_CONTROL_SOCKET || join(runDir, "collector-control.sock"),
    api: process.env.TIDEPOOL_API_SOCKET || join(runDir, "api.sock"),
    scheduler: process.env.TIDEPOOL_SCHEDULER_SOCKET || join(runDir, "scheduler.sock"),
  };
}

/** Parse validated config durations: "30m" | "6h" | "7d" → milliseconds. */
export function parseDuration(d: string): number {
  const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(d);
  if (!m) throw new Error(`invalid duration: ${d}`);
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60_000 : m[2] === "h" ? n * 3600_000 : n * 86_400_000;
}

/** Software identity for provenance records: baked into images at build
 *  time (ARG→ENV in the Containerfile), best-effort empty in dev. */
export function generatorIdentity(): Record<string, unknown> {
  return {
    tidepoolVersion: process.env.TIDEPOOL_VERSION || null,
    gitCommit: process.env.TIDEPOOL_GIT_COMMIT || null,
    ociImageDigest: process.env.TIDEPOOL_IMAGE_DIGEST || null,
    nodeVersion: process.version,
    quadletDigest: process.env.TIDEPOOL_QUADLET_DIGEST || null,
  };
}

// ------------------------------------------------------------------ logging

/**
 * Structured logging: one JSON object per line on stdout, which journald
 * captures per-unit in the Quadlet deployment. Fields follow the deployment
 * spec (timestamp, service, severity, plus whatever identifiers the call
 * site has: requestId, sourceId, observationId, snapshotId, unit, ...).
 * Never log secrets: callers must not pass tokens or raw config here.
 */
export function makeLogger(service: string) {
  const emit = (severity: "debug" | "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), service, severity, msg, ...fields });
    if (severity === "error" || severity === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
    info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
    warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
    error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
  };
}
export type Logger = ReturnType<typeof makeLogger>;

// ------------------------------------------------------------------- uds

/** Prepare a Unix socket path for listening: ensure the directory exists,
 *  remove a stale socket from a previous run, and return a chmod callback
 *  (0660: owner+group only — the socket is the authorization boundary). */
export function prepareSocket(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    unlinkSync(path);
  } catch {
    /* no stale socket */
  }
  return () => {
    try {
      chmodSync(path, 0o660);
    } catch {
      /* best effort on exotic filesystems */
    }
  };
}

// --------------------------------------------------------------- shutdown

/**
 * Wire SIGTERM/SIGINT to an async drain function with a hard deadline, so
 * `podman stop` / systemd stop produces a clean exit: servers stop accepting,
 * in-flight work completes (bounded), the SQLite connection closes with no
 * interrupted transaction.
 */
export function onShutdown(log: Logger, drain: () => Promise<void>, deadlineMs = 60_000): void {
  let closing = false;
  const handler = (sig: string) => {
    if (closing) return;
    closing = true;
    log.info("shutdown requested", { signal: sig, deadlineMs });
    const timer = setTimeout(() => {
      log.error("shutdown deadline exceeded — exiting");
      process.exit(1);
    }, deadlineMs);
    timer.unref();
    drain()
      .then(() => {
        log.info("shutdown complete");
        process.exit(0);
      })
      .catch((e) => {
        log.error("shutdown drain failed", { error: String(e instanceof Error ? e.message : e) });
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}
