# Tidepool — Architecture

The mechanism reference: how the layers, the pipeline, and the store work.
`docs/OVERVIEW.md` governs intent; `docs/adr/` records individual decisions;
this document collects the moved-in-full architecture sections that used to
live in the root README.

## Layered architecture

The development direction ("inflow awareness → truth snapshots → dispatch
analysis") is implemented as strictly separated layers, each forbidden from
reaching past its boundary:

```
collectors observe        domains/  (apt pockets, registry surfaces, feeds)
normalizers structure     the same modules — pure bytes → records
history preserves         core/inflow.ts   append-only Observations, content-
                          addressed record blobs; nothing ever rewritten
change detection compares core/inflow.ts   deterministic diffs of consecutive
                          observations; every change names its observation pair
inflow heuristics         core/inflow.ts   rule-id'd findings with confidence
interpret                 basis, evidence refs, ambiguities; read-only
snapshots compress and    core/snapshot.ts three stages (observation ⊂ churn ⊂
export truth              interpretive), content-addressed, store-only,
                          six export formats from one model
project analyzers         dispatch/analyze.ts  classify, fingerprint, extract
understand local state    dependencies — never embedded in collectors
dispatch evaluates the    dispatch/analyze.ts + cli/dispatch.js  snapshot ×
relationship              paths → immutable findings artifact
```

## Inflow: observations and changes

Every real collection appends one immutable **Observation** per source:
authority, source, collection time, scope, verification state (and signer),
coverage limitations, raw-artifact digest, parser version, configuration
version, and a content address of the normalized records (stored once —
identical re-observations cost one log line, not a copy). Consecutive
observations of a source are diffed deterministically into **ChangeRecords**
(package-added/removed, version-moved, metadata-changed, advisory-published/
modified/withdrawn, source-failure/recovery, verification/signer transitions,
and evidence-observed/changed/no-longer-observed for enrichment surfaces —
explicit-scope evidence never claims withdrawal), each naming the observation
pair it came from. Heuristic rules
(`inflow.release-burst`, `inflow.security-burst`, `inflow.corrective-release`,
`inflow.source-degradation`, `inflow.signer-transition`) read that history and
emit findings with rule ids, confidence basis, evidence references, and their
own ambiguities — and can never mutate it.

## Snapshots: bounded truth

`POST /api/snapshots {stage, windowHours | from,to}` builds a snapshot from
the store alone (never the network): scope, window, authorities, per-source
coverage with verification state, **an explicit notObserved list** (failed
sources, never-synced units, coverage limitations), entities, observations,
changes, relationships (e.g. advisory ↔ version movement on one package =
security-response), findings, and ambiguities. Content-addressed over
canonical JSON with the digest binding content rather than wall-clock —
rebuilding the same explicit window from the same store yields the same
digest (smoke-asserted). Exports — JSON, NDJSON, Markdown, HTML, SQLite
(node:sqlite single-file database), and a tar.gz bundle — all render from
the same SnapshotDoc.

## Dispatch: snapshots × project paths

`node server/dist/server/src/cli/dispatch.js --snapshot <digest|latest>
[--store DIR] [--out FILE] <path>...` classifies each path (Rust workspace,
Node, Python, C/C++, Debian package, container image, kernel module, mixed
monorepo — or an explicit `unrecognized`), extracts manifests and lockfiles,
fingerprints the local state, and correlates against the snapshot: dependency
updates (dpkg-semantic version comparison of locked vs current),
security-review findings from advisory joins and advisory changes,
rebuild-recommended for base images whose distro took security movements,
informational when local already satisfies upstream, and — critically —
**insufficient-evidence when a dependency falls outside the snapshot's
bounded scope** (bounded truth is not proof of absence). Multiple paths get
shared-exposure grouping. The output is an immutable, digest-bearing
artifact referencing the snapshot, reproducible without re-collection.
Exit code 3 signals security-review findings for pipeline use.

## The contained flow

Every unit of either domain moves through the same pipeline, implemented once
in `server/src/core/aggregator.ts`:

```
syncIndex()  →  rows with per-source versions   (sources never blended)
syncAdvisories()  →  advisories joined by name
observation store (SQLite)  →  summaries: current version (dpkg compare),
drift, advisory counts  →  search / filter / pagination  →  stored evidence
```

The collector keeps a TTL'd disk cache as a *private* optimization — in the
deployed appliance nothing else reads it, and the API reconstructs the same
summaries from the atomically published SQLite read replica (deleting the
cache changes nothing the API serves; that property is verified in CI). In
single-process development mode the in-memory state serves directly.

A domain implements only the `UnitProvider` seam — how to enumerate and
verify its sources. The distro domain's providers are apt pockets, Alpine
APKINDEX repos, and Arch's packages API; the code domain's providers are
registry surfaces. Everything above the seam is shared and identical: drift
detection, advisory joins, caching, the API, and the console.

## What it does

- **Comprehensive per-distro package lists.** Ubuntu 24.04, Debian 12,
  Alpine 3.20, and Arch ship configured out of the box. An apt distro's
  `main` component alone is ~9,000 binary packages; Tidepool indexes all of
  them, disk-caches the result, and serves search/filter/pagination over it.
- **Every information source stands alone.** For Ubuntu, the `release`,
  `updates`, and `security` pockets are three independent sources — each with
  its own fetch, its own verification, its own status, and its own column in
  the table. They are never blended, and a failing source is a visible fact
  (hatched marker, error text, endpoint URL), never a silent gap.
- **Version drift as a first-class signal.** Because per-source versions are
  kept separate, the console shows at a glance where pockets disagree —
  `sudo: release 1.9.15p5-3ubuntu5 → security …-3ubuntu5.24.04.2` — computed
  with a faithful implementation of dpkg's version comparison (versions are
  never string-compared).
- **Advisories joined onto the list.** Ubuntu's USN feed, Alpine's secdb, and
  Arch's AVG feed are joined by package name; Debian uses OSV per package on
  demand. Advisory counts appear in the table; details, CVEs, and fixed
  versions in the package drawer.
- **Enrichment as evidence.** OSV per-package detail, endoflife.date
  lifecycle, and GitHub releases (for packages mapped in `packageHints`) are
  collected by the collector — on bounded policy ("packages that changed in
  the last window"), on schedule, or on explicit `npm run admin enrich` —
  and recorded as immutable *evidence observations* like every other source,
  with their own change kinds and coverage rows in snapshots. The package
  drawer serves the stored evidence; a UI click never silently creates an
  upstream query. (Dev mode keeps live on-open enrichment, which is likewise
  recorded.)

## The code-ecosystem domain

The same premises, applied to language registries. A code unit declares a
**scope** (an explicit package set today; registry-wide enumerators plug into
the same seam as further modes) and each package in it is resolved against
*two independent surfaces of its authority*, kept as separate columns exactly
like pockets:

| unit | surfaces | advisories (OSV) |
|---|---|---|
| crates.io (Rust) | API `crates.io/api/v1` · sparse index `index.crates.io` (raw NDJSON) | `crates.io` |
| PyPI (Python) | JSON API · simple index (PEP 691 JSON) | `PyPI` |
| npm (JavaScript) | packument · `/latest` manifest · **cross-host yarnpkg mirror** | `npm` |
| RubyGems (Ruby) | gems API · versions API | `RubyGems` |
| Maven Central (JVM) | **repository `maven-metadata.xml` · search index** (`group:artifact` names) | `Maven` |
| Go modules | proxy `@latest` (resolved) · proxy `@v/list` (raw; module-path names, bang-escaped) | `Go` |
| NuGet (.NET) | flat container · registration index | `NuGet` |
| Packagist (PHP) | metadata CDN `repo.packagist.org/p2` · `packagist.org` API (`vendor/package` names) | `Packagist` |
| Hex (Elixir) | hex.pm API — single surface (repo endpoints are signed protobuf) | `Hex` |
| pub.dev (Dart) | pub.dev API — single surface | `Pub` |
| CRAN (R) | package DESCRIPTION file — single surface | `CRAN` |
| ConanCenter (C/C++) | **current remote `center2.conan.io` · frozen legacy remote** | `ConanCenter` |
| vcpkg (C/C++) | **versions database · port manifest** (vcpkg policy requires these to agree — drift is a genuine repo inconsistency) | — |

Advisory joins are one OSV `querybatch` per unit for the whole scope.

Where surfaces disagree — CDN staleness, yank propagation, search-index lag
(Maven's is famous), mirror lag, or vcpkg's versions-db falling out of step
with a port manifest — that is drift, surfaced identically to pocket drift.
C/C++ deserves one framing note: its registry of record has historically been
the system package manager, so the distro domain already covers it; the
ConanCenter and vcpkg units add the dedicated C/C++ package-manager view on
top. The honesty gradient is stated in the surface labels: Maven's
two are genuinely separate services, npm's yarnpkg surface is a real
cross-host mirror, while npm's own pair and RubyGems' pair are different
resources of one backend; Hex, pub.dev, and CRAN expose one practical read
path, so their single-surface units can never show drift — stated, not
hidden. Prerelease-policy noise is filtered (surface comparison prefers final
releases), so drift means something real. Version comparison never falls back
to string order.

## Signature verification

apt pockets are authenticated as a two-link, fail-closed chain:

1. **Signature** — `gpgv` must find a good signature on the clearsigned
   `InRelease` from a key in the distro's archive keyring
   (`index.keyrings`), or the pocket contributes nothing.
2. **Digest** — the fetched `Packages.gz` must match the SHA256 table inside
   that verified document.

Pockets passing both are labeled `signature+digest` in the UI, with the
signing identity shown (e.g. *Ubuntu Archive Automatic Signing Key (2018)*).
The failure paths behave as designed and are exercised: a wrong keyring
reports "key not present", a tampered document reports "BAD signature", and a
missing keyring or missing `gpgv` reports exactly what to install. Setting
`verifySignatures: false` on a distro degrades to digest-only verification,
which the UI then labels honestly as `digest` — the interface can never
overstate what was proven (the label is a typed union:
`"signature+digest" | "digest" | null`).

Requirements: `gpgv` on PATH and the keyring files for each verified distro —
the `ubuntu-keyring` / `debian-archive-keyring` packages, or copy the keyring
files onto the host and point `index.keyrings` at them.

## The observation store

Persistence is an insert-mostly SQLite accumulated-awareness layer under
`.tidepool/` — durable local memory of upstream inflow, not a disposable
response cache (the TTL serving cache stays separate in `.cache/`, with a
deliberately opposite contract):

```
.tidepool/                  (dev; the appliance uses $TIDEPOOL_HOME/corpus)
├── writer/tidepool.sqlite3 the AUTHORITATIVE database — WAL,
│                           synchronous=NORMAL, foreign keys ON, busy_timeout
│                           5s, incremental auto-vacuum; its own directory so
│                           read-side services can mount corpus subtrees
│                           while the writer path stays out of their
│                           namespaces entirely (legacy root-level databases
│                           are relocated once at open)
├── objects/sha256/xx/…     content-addressed normalized record corpora
├── snapshots/              snapshot documents (manifest rows join contents,
│                           plus generator provenance: version, commit,
│                           image/config/profile digests)
├── exports/                portable evidence bundles, retention audits
├── published/              tidepool-read.sqlite3 + publication.json — the
│                           consistent replica the API serves (dev default;
│                           its own mount in the appliance)
├── run/                    control + api sockets, scheduler heartbeat (dev)
└── locks/
```

Invariant: one Tidepool writer process owns a local database; collectors
fetch concurrently but every normalized write passes through the
ObservationStore's `BEGIN IMMEDIATE` transaction (artifact → observation →
entities/states → changes → head). Schema lives in ordered migrations
(`server/migrations/000N_*.sql`) applied transactionally and recorded in a
ledger with content digests — drifted history refuses to run; nothing is
inferred from whether a table happens to exist.

Terminology is deliberate: artifacts and normalized record sets are
**content-addressed**; observations are **deterministically identified**
(the collection timestamp participates in identity — an unchanged source
still yields a new observation, because learning it was still there is
knowledge). Identical content is stored once; entity states materialize
only when a source's normalized digest is new. Failures, coverage limits,
and verification levels are columns, not log lines. Bounded advisory feeds
never produce "withdrawn" — only `advisory-no-longer-observed`.

**Historical reconstruction**: snapshots are rebuilt from SQLite at the
window boundary — the latest observation at or before `window.to` per
source, later ones invisible, aggregator memory never consulted — so an old
snapshot rebuilds to the identical digest after any amount of newer
synchronization (test-proven). Source heads exist only to accelerate
current-state reads.

**Portable evidence**: `corpus export` produces a `tar.zst` bundle
(manifest, backup-API database copy — never a raw WAL copy — objects,
snapshot documents, checksums); `--snapshot <digest>` yields a thin bundle
carrying only the objects those snapshots reference. `corpus import`
validates the manifest, verifies every checksum, inspects schema
compatibility via the migration ledger (newer schemas refused), merges
immutable rows without ever silently replacing conflicting history, records
the import in a ledger, and supports `--dry-run`. Retention: nothing is
deleted by default. `npm run retention plan` computes snapshot-aware
reachability (every snapshot's truth boundary plus each source's latest
observation protect their referenced blobs); `apply` additionally requires
`maintenance.retention.enabled` in the config *and* a verified backup newer
than 24h, writes an audit record before touching anything, deletes only
unreferenced object bytes, nulls the artifact's `storage_path` (provenance
rows are permanent), and re-verifies the corpus afterwards.

## The corpus boundary

File access and semantic validity are separate functions, by rule
(`lib/corpus.ts` / `lib/validate.ts`):

1. **File operations are one operation in one direction** — a read is a
   single read of the entire corpus; a write is a single atomic write of the
   entire corpus (temp + rename). NDJSON history appends whole records in
   one operation. Nothing streams, resumes, or read-modify-writes.
2. **The corpus is parsed into a JSON object after the fact** — parsing is
   pure and happens only once the read has fully completed.
3. **The object is validated in code** before anything uses it: every field
   type-checked, range-checked (ports 1–65535, TTLs 0–8760h, pages bounded,
   package names ≤214 chars in the allowed charset), URL schemes restricted
   to http(s), enums enforced, unknown keys rejected as probable typos
   (`$comment.*` exempt), with field-path-accurate errors
   (`config.distros[0].index.pockets[0].base: URL scheme must be http(s)`).

This applies to every corpus the service touches: `tidepool.config.json`
(startup refuses to run on an invalid config, printing every field error;
`POST /api/reload` refuses invalid configs with a 400 carrying the details
and keeps serving on the last valid one), stored snapshots (a planted or
corrupted snapshot fails validation loudly as a 500 naming the fields — the
service keeps serving), the append-only observation/change history (each
line validated on read; corruption of the truth log throws with file and
line), and the gpgv path, which is now three separated functions: one
whole-corpus write into a private temp dir, one process run, one pure
verdict interpretation (`interpretGpgvVerdict` is testable without gpg).

## Design principles

1. **Sources are never blended.** Each pocket, repo, and feed is fetched,
   verified, and parsed on its own; disagreement between sources is data, not
   noise to be averaged away.
2. **Provenance everywhere.** Every panel carries the endpoint it came from;
   verified data is labeled with what was actually verified, and nothing is
   labeled beyond it.
3. **Failures are visible facts.** A source that errors shows its status,
   its error, and its URL. The service never fills a gap silently or lets a
   transient outage pin itself into the cache (all-error results are not
   cached).
4. **Configuration over code.** Which distros, which sources, how deep, how
   fresh, and which upstream mappings are all declaration, not modification.

