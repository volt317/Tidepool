# ADR 0008 — Isolated appliance topology: collector-only Internet, published read replica, Unix-socket control

Date: 2026-07-14
Status: accepted
Supersedes: parts of ADR 0007 (shared-pod runtime; TCP control plane)

## Context

ADR 0007 split the single process into collector/API/scheduler services in
one Podman pod: a shared network namespace, a loopback TCP control plane,
and — the part that aged worst — the collector's disk cache doubling as the
API's read path. Three weaknesses followed directly:

1. **The cache was a cross-process interface.** The API answered from TTL'd
   cache files the collector wrote. Deleting a cache changed API responses;
   durable truth (SQLite) and served truth (cache) could disagree.
2. **The pod's shared loopback made "who can dial the collector" a matter of
   process behavior**, not namespace structure: anything in the pod could
   reach :8748, and the API proxied sync/enrich requests from the network
   into it — so an Internet-facing route could trigger collection.
3. **Enrichment bypassed the evidence model.** UI-triggered OSV/GitHub/EOL
   fetches went network → response → cache; nothing durable recorded that
   the appliance had queried an upstream, and snapshots could not cover it.

## Decision

Independent containers, one Internet-capable process, published truth:

- **No pod.** Each service has its own network namespace, mount set,
  restart policy, and health signal. The API and
  scheduler run `--network=none`; a data-less proxy holds the only
  published TCP port and forwards to the API's Unix socket.
- **The collector publishes a read replica** (SQLite backup API → temp →
  `integrity_check` → atomic rename → `publication.json` with digests,
  latest-observation markers, schema/migration versions, and generator
  identity). The API opens it `SQLITE_OPEN_READONLY` and reopens on new
  publications. API availability no longer depends on a live collector.
- **The cache is private again.** The API's state is reconstructed from
  the replica via the same store reconstruction the snapshot builder uses
  (`unitStateAt`); the aggregator gained a pluggable `stateSource` so read
  handlers did not change. Known fidelity cost, accepted and documented:
  descriptions (not in normalized records) are absent from replica-served
  listings, and reconstructed advisories carry no URL.
- **Control is a Unix domain socket** (`run/collector-control.sock`,
  0660). The protocol is fixed operation paths with small validated JSON
  bodies and request/caller attribution; arbitrary URLs, paths, and shell
  arguments have no representation in it. Administration is a local CLI
  (`cli/admin.ts`) or the scheduler; the web API answers 405 for control
  verbs.
- **Enrichment is collection.** Every enrichment surface result is recorded
  as an *evidence* observation (`enrich:<surface>:<subject>`, coverage
  `explicit-scope`) with a third record kind threaded through change
  detection (`evidence-observed/-changed/-no-longer-observed` — never a
  withdrawal claim, matching ADR 0006's coverage semantics). The API serves
  stored evidence only. Policy enrichment ("packages changed in the last
  window", bounded) runs on the scheduler's cadence.
- **One validated configuration document** gained `scheduler` and
  `maintenance` blocks; environment variables are deployment wiring only.
- **The writer moved to `corpus/writer/`** so read-side mounts can include
  corpus subtrees (objects, snapshots) while the authoritative database is
  structurally absent from every namespace but the collector's (with a
  one-time legacy relocation at open).
- **Retention is reachability-based and administratively invoked**:
  reachable = snapshot truth boundaries ∪ per-source head observations;
  pruning deletes only unreferenced blobs, nulls `storage_path` (provenance
  rows are permanent), writes an audit record first, and refuses to run
  without config opt-in and a fresh verified backup.

## Consequences

- The acceptance list is testable, and tested: `boundaries-verify.sh` runs
  ~20 negative probes (each tagged with the layer it exercises) and the
  deploy CI runs the full build→collect→publish→read→snapshot→dispatch→
  backup→restore→digest-compare loop in real containers.
- Claims match mechanisms (the README's enforcement table). Where a layer
  cannot deliver (rootless
  egress is per-user), the limitation is stated and the host firewall is
  declared REQUIRED rather than implied optional.
- Cost: more moving parts (four units + timers), a replica publication step
  after mutations, and a read model that must track any future changes to
  normalized record shapes. The dev mode (`index.ts`, single process, live
  enrich, TCP) is unchanged, so day-to-day development pays none of this.
