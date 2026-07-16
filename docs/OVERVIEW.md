# Tidepool — Mission and Operating Modes

This is the authoritative short statement of what Tidepool is and what it
guarantees. Where deployment notes, ADRs, or the docs/ references go into mechanism,
this document governs intent. It is deliberately brief.

## 1. Mission

Aggregate declared upstream sources, preserve observations and evidence,
produce bounded historical snapshots, and evaluate local project paths
against those snapshots.

The unit of truth is the **observation**: an append-only record that a
source asserted something at a point in time. Observations accumulate into
a **corpus**; a **snapshot** is a reconstruction of corpus state at or
before a declared time boundary; **dispatch** evaluates a project path
against a snapshot, entirely offline.

```text
upstream inflow → observations → corpus → snapshot → offline dispatch
```

## 2. Operating modes

**Standalone (`npm start`)** — a single process for development and trusted
local use. Convenient, but it provides none of the isolation guarantees
below. Do not treat standalone mode as a security boundary.

**Isolated appliance** — the preferred unattended runtime: independent
rootless services in which only the collector may cross the Internet
boundary. This is an operating mode for the mission above; it does not
change the data model or the user workflow.

## 3. Guarantees unique to appliance mode

* **Collector-only Internet access.** Of all services, only the collector
  has a network namespace that can reach upstreams. The API, scheduler,
  proxy, and dispatch run without external connectivity as a structural
  property (`Network=none`), not merely as policy.
* **Single authoritative writer.** The collector is the sole writer of the
  authoritative corpus. Other services never mount the writer database.
* **Read-only serving.** The API answers from a published, read-only
  replica. The LAN-facing HTTP API cannot trigger upstream fetches and
  cannot write the corpus.
* **Bounded, reconstructable history.** A snapshot is rebuilt entirely from
  observations at or before its declared boundary; identical inputs yield an
  identical snapshot digest, preserved across backup and restore.

## 4. Internet boundary

Only the collector reaches external networks. Collection, enrichment,
publication, and maintenance are triggered through the scheduler, the local
administrative CLI, or a protected Unix control socket — never through the
ordinary HTTP API. Enrichment is collector-owned, bounded by configuration,
and persisted as evidence or observations.

## 5. SQLite and snapshot authority

SQLite is the durable authority. The API reads corpus-derived state from the
published read-only replica; the collector's cache is private and disposable,
and deleting it does not change what the API serves. Snapshots are the
provenance unit for offline evaluation.

## 6. Non-goals

* Not a general vulnerability scanner or a live query proxy to upstreams.
* Not a shared-pod deployment: appliance services are independent, with no
  shared network namespace and no pod-internal control endpoints.
* Not a writable API: the LAN-facing surface is read-only in appliance mode.
* This alignment does not add collectors, analyzers, storage features, UI
  features, or deployment abstractions; it makes the existing parts agree.
