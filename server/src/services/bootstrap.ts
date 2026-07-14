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

import { join, resolve } from "node:path";

import { parseJsonCorpus, readCorpusText } from "../lib/corpus.js";
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
export function loadConfig(): { config?: TidepoolConfig; errors: string[] } {
  const path = process.env.TIDEPOOL_CONFIG
    ? resolve(process.env.TIDEPOOL_CONFIG)
    : join(ROOT, "tidepool.config.json");
  let parsed: unknown;
  try {
    parsed = parseJsonCorpus(readCorpusText(path), "tidepool.config.json");
  } catch (e) {
    return { errors: [String(e instanceof Error ? e.message : e)] };
  }
  return validateConfig(parsed);
}

/** Resolve the two on-disk trees every service agrees on. */
export function resolveDirs(config: TidepoolConfig): { cacheDir: string; dataDir: string } {
  const cacheDir = process.env.TIDEPOOL_CACHE_DIR
    ? resolve(process.env.TIDEPOOL_CACHE_DIR)
    : join(ROOT, config.server.cacheDir ?? ".cache");
  const dataDir = process.env.TIDEPOOL_DATA_DIR
    ? resolve(process.env.TIDEPOOL_DATA_DIR)
    : join(ROOT, config.server.dataDir ?? ".tidepool");
  return { cacheDir, dataDir };
}

/** Pod-internal collector control endpoint. The collector binds it; the API
 *  and scheduler dial it. Inside a Podman pod all containers share one
 *  network namespace, so 127.0.0.1 is the pod, not the host. */
export const COLLECTOR_BIND = process.env.TIDEPOOL_COLLECTOR_BIND || "127.0.0.1";
export const COLLECTOR_PORT = Number(process.env.TIDEPOOL_COLLECTOR_PORT || 8748);
export const COLLECTOR_URL = process.env.TIDEPOOL_COLLECTOR_URL || `http://127.0.0.1:${COLLECTOR_PORT}`;

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
