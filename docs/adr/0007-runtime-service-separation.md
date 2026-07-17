# ADR 0007 — Runtime service separation for the containerized deployment

Status: accepted (pod topology and TCP control plane superseded by ADR 0008; the service split itself stands).

## Context

Tidepool's architecture already separates collection, storage, snapshot
generation, dispatch analysis, and presentation at the module level
(ADR 0004 fixed the collector/analysis boundary), but the runtime was a
single process: `server/src/index.ts` hosted upstream collection, the
SQLite writer, snapshot creation, the REST read surface, and the frontend
behind one port. A hardened deployment (rootless Podman + Quadlet +
`deploy/`) wants those responsibilities in separately privileged
processes: the network-facing service should not be the process that can
write evidence or reach upstream, and the process that parses untrusted
upstream bytes should not be reachable from the network.

Two codebase invariants constrained the design: `core/db.ts` declares a
single-writer contract for the SQLite corpus, and snapshot creation writes
manifest rows — so snapshot creation belongs to whichever process owns the
writer.

## Decision

Split the runtime into three cooperating services along the existing module
seams, by MOVING code rather than rewriting it:

* `core/routes.ts` was split into `routes.read.ts` (GET handlers — memory /
  disk cache / SQLite / snapshot files) and `routes.control.ts` (sync,
  enrichment, snapshot creation — network egress and corpus writes). Every
  handler moved verbatim; `routes.ts` now composes both, so the
  single-process development mode and the test suite see a byte-identical
  HTTP surface.
* `index.ts`'s bootstrap (config pipeline, path resolution, build wiring)
  moved into `services/bootstrap.ts` and the per-service entrypoints
  `services/collector.ts` and `services/api.ts`; `index.ts` remains the
  all-in-one development mode.
* `services/scheduler.ts` is new code (no scheduler existed): interval
  triggers against the collector's pod-internal control surface, owning no
  data. Its knobs are environment variables so the validated
  `tidepool.config.json` schema (which rejects unknown keys) did not grow.

Additive changes filled in where a moved handler's dependency crossed the
new boundary:

* `Aggregator` gained `{ collect: false }`: `sync()` then answers only from
  the collector-written disk cache (TTL-ignored) and never fetches — the
  read handlers stayed verbatim instead of forking.
* `core/db.ts` gained `openDatabaseQueryOnly()` and `SqliteObservationStore`
  a `{ readOnly: true }` option: the API opens the same corpus through a
  connection latched with `PRAGMA query_only = ON` (SQLite rejects every
  write; migrations are verified against the digest ledger, never applied),
  preserving the single-writer invariant across processes. A latched normal
  connection was chosen over `SQLITE_OPEN_READONLY` because WAL readers
  must map the `-shm` file.
* `Aggregator.busy()` and small health endpoints support graceful drain and
  Quadlet health checks.

The web UI's three collect-capable operations (sync, enrich, snapshot
creation) are proxied by the API to the collector over the pod loopback —
fixed-target message passing between siblings, not arbitrary egress — so
the frontend is unchanged.

## Consequences

Each service now carries only its own privileges (see `deploy/README.md`
for the full matrix for per-permission
justifications), and each is independently restartable: the API keeps
serving evidence while the collector is down (control operations answer
503, truthfully). Snapshot creation lives in the collector because manifest
recording is a corpus write; a future dedicated snapshot worker would take
over that seam by owning (or coordinating with) the writer. Dispatch stays
an ad-hoc, network-less container (`tidepool-utility` +
`tidepool-dispatch` profile); the same pair becomes a queue-driven worker
without touching the other services. The API startup now depends on the
collector having migrated the schema, expressed both in code (verify,
never apply) and in unit ordering.
