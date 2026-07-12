# Tidepool

**A self-hosted upstream survey service.** Tidepool runs one contained
aggregation flow over two parallel domains: **Linux distributions** (the
complete package list from each distro's own index sources, advisory feed
joined on top) and **code ecosystems** (a declared scope of crates.io / PyPI
/ npm packages, each resolved against multiple independent surfaces of its
registry, OSV advisories joined on top). In both domains every source is
fetched, cryptographically verified where the authority signs, and parsed
individually — so every fact on screen traces back to the endpoint that said
it.

> A tidepool is what the ocean leaves behind where you can actually look at
> it. Upstream churns constantly; this makes your slice of it inspectable.

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
modified/withdrawn, source-failure/recovery, verification/signer transitions),
each naming the observation pair it came from. Heuristic rules
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
disk cache (TTL'd)  →  summaries: current version (dpkg compare), drift,
advisory counts  →  search / filter / pagination  →  on-demand enrichment
```

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
- **On-demand upstream enrichment.** Opening a package queries OSV for the
  unit's ecosystem (full count via `querybatch`, details for the newest
  few), plus endoflife.date lifecycle and GitHub releases for packages mapped
  in `packageHints` — each panel with its own status and endpoint.

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

## Layout

```
tidepool.config.json          everything the service does is declared here
shared/types.ts               the typed API contract (server implements, web consumes)
server/src/
  index.ts                    thin bootstrap: config → providers → core → routes
  core/aggregator.ts          the contained flow: sync, cache, summaries, drift,
                              enrichment — domain-agnostic
  core/routes.ts              /api/domains/:domain/units/:unit/… (symmetric)
  core/enrich.ts              shared OSV / endoflife / GitHub adapters + OSV batch join
  lib/util.ts                 fetch/gzip/sha256, deb822 parsing, dpkg version
                              compare, ustar reader, disk cache
  lib/gpg.ts                  InRelease signature verification via gpgv
  domains/providers.ts        config → UnitProviders for both domains
  domains/distro/             apt pockets (signature+digest verified), Alpine
                              APKINDEX + secdb, Arch packages API + AVG, USN feed
  domains/code/surfaces.ts    crates.io / PyPI / npm dual-surface resolvers
web/                          React + Vite console (TypeScript)
eslint.config.js              flat config: typescript-eslint + react-hooks
```

The server exists because it has to: distro archives and most advisory feeds
do not serve CORS headers, so a browser cannot read them first-hand — and a
9,000-package index should be synced once and cached, not re-pulled per
visitor. The browser talks only to the service; the service talks to the
authorities.

## Running

```sh
npm install               # root: TypeScript, ESLint, typescript-eslint
npm --prefix server install
npm --prefix web install

npm run typecheck         # tsc across server, shared, and web — must be clean
npm run lint              # eslint (flat config) — must be clean

# development (two terminals)
npm run dev:server        # compiles server, API on :8747
npm run dev:web           # Vite on :5173, proxies /api → :8747

# production (single process: API + built frontend)
npm run build             # tsc → server/dist, vite → web/dist
npm start                 # http://localhost:8747 (run from the repo root)
```

The entire codebase is TypeScript against the shared contract in
`shared/types.ts`. `npm run lint` and `npm run typecheck` pass with zero
findings and are the gate for any change.

## Testing

Unit tests use `node:test` with Node's native V8 coverage — no test-framework
dependency, matching the rest of the stack. 49 tests cover the pure spine:
the dpkg comparator and deb822/InRelease parsers, the corpus boundary and
every validator error class, pure gpgv verdict interpretation (good / BAD on
exit 0 / missing key / silent output — the exact stderr shapes observed
live), canonical digests, all change-detection kinds with observation
attribution, the heuristic rules' thresholds and non-firing cases, every
snapshot export format from one doc (including HTML escaping of
upstream-controlled package names and a tar round-trip through our own
reader), the contained aggregation flow against stub providers (sync →
summaries → observations → re-sync change detection → store-only peek), the
HTTP surface over real sockets (snapshot lifecycle, traversal and format
guards), config→provider mapping, and the dispatch classifier + analyzer.

```sh
npm test              # build + run the suite
npm run test:coverage # + V8 coverage, thresholds enforced, lcov emitted
```

Coverage stands at ~70% lines / 76% branches / 73% functions, with
thresholds set just below (65/70/68) so regressions fail the run. The
uncovered remainder is deliberate and visible in the report: the network
fetch paths of the collectors (apt/apk/arch, registry surfaces, enrichment
adapters) are exercised by the live runtime smoke in CI, not by unit tests.

## CI

Four workflows under `.github/workflows/` (validated with actionlint):

- **lint** — ESLint + the TypeScript compiler across server, shared, and web;
  the same commands as the local gates, so CI and a checkout can never
  disagree about "clean".
- **build** — compiles both halves and uploads `server/dist` + `web/dist` as
  an artifact, then a **runtime smoke** job downloads that artifact,
  installs production-only server deps, and runs `npm run smoke`
  (`scripts/smoke.mjs`): boots the built service on a minimal dedicated
  config and asserts live that a real apt pocket syncs `signature+digest`
  through gpgv, an npm scope resolves on all three surfaces including the
  cross-host yarnpkg mirror, search returns per-source versions, and the
  built frontend is served. Advisory/enrichment sources are disabled in the
  smoke config so only security.ubuntu.com and the npm registries can affect
  the verdict. The smoke runs locally too: `npm run build && npm run smoke`.
- **test** — the unit suite with coverage thresholds on a Node 22/24
  matrix; the lcov report is uploaded as an artifact.
- **codeql** — CodeQL analysis (javascript-typescript, security-and-quality
  suite) on pushes, PRs, and a weekly schedule. The suite was run locally
  against this tree with the CodeQL 2.26.0 CLI during development: it found
  two real path-injection errors on the snapshot digest routes (fixed —
  digests are now validated as 64-hex content addresses at the store, route,
  and CLI boundaries, with the path built from the regex capture), plus a
  missing-rate-limit warning (fixed — `express-rate-limit`, 30 POSTs/min for
  sync/snapshot builds, 600/min elsewhere). Two findings remain by design
  and can be dismissed as such in code scanning: `js/file-access-to-http`
  (outbound URLs come from the config file — that is the product) and
  `js/http-to-file-access` (fetched InRelease bytes are written to a private
  temp file precisely so gpgv can verify them).

Lint runs on a Node 22/24 matrix; build, smoke, and the runtime target
Node 24 (active LTS). The service requires Node >= 22.13 (`node:sqlite`
unflagged; declared in `engines`).

## What each distro aggregates

| distro | comprehensive list from | advisory feed | enrichment ecosystem |
|---|---|---|---|
| Ubuntu 24.04 | `noble`, `noble-updates`, `noble-security` pockets — InRelease GPG-verified, Packages.gz digest-verified against it; both fail closed per pocket | ubuntu.com USN feed (newest N pages, joined by package name) | OSV `Ubuntu:24.04:LTS` |
| Debian 12 | `bookworm`, `bookworm-updates`, `bookworm-security` — same two-link verification, Debian keyrings | OSV on demand per package | OSV `Debian:12` |
| Alpine 3.20 | `main` APKINDEX.tar.gz | Alpine secdb (small enough to join in full) | OSV `Alpine:v3.20` |
| Arch | packages API, `Core` + `Extra` (paginated) | Arch AVG feed | — (no OSV ecosystem) |

## Configuration

`tidepool.config.json` declares everything; edit it and either restart or
`POST /api/reload`. The shipped file is commented inline. Highlights:

- `distros[]` — enable/disable, pockets/repos/components/arch, signature and
  digest verification with keyring paths, advisory feed and its depth
  (`pages`), OSV ecosystem string. Adding another release or a derivative is
  a new entry with different suites — no code.
- `ecosystems[]` — code units: ecosystem (`crates-io` / `pypi` / `npm`), OSV
  ecosystem string, and the `scope` package set. Widening the watch is
  editing a list.
- `server.indexTtlHours` / `advisoryTtlHours` — how long synced data is
  trusted (disk-cached under `cacheDir`; a restart reuses fresh cache).
- `packageHints` — source-package → upstream mappings (`github`, `eol`) that
  switch on the corresponding enrichment panels.
- `enrichment.githubToken` (or env `TIDEPOOL_GITHUB_TOKEN`) — raises
  api.github.com anonymous limits.
- Ubuntu/Debian `components` default to `["main"]`; add `"universe"` (or
  `"contrib"`, `"non-free"`) for the full archive — bigger sync, same code
  paths.

## API

Domain-symmetric by construction — the same routes serve both domains:

```
GET  /api/config
GET  /api/domains                                        domains → units → per-source health
POST /api/domains/:domain/units/:unit/sync               force re-sync
GET  /api/domains/:domain/units/:unit/packages?q=&page=&per=&advisories=1&drift=1
GET  /api/domains/:domain/units/:unit/packages/:name     all sources + joined advisories
GET  /api/domains/:domain/units/:unit/packages/:name/enrich
POST /api/reload                                         re-read config
```

## The observation store

Persistence is an insert-mostly SQLite accumulated-awareness layer under
`.tidepool/` — durable local memory of upstream inflow, not a disposable
response cache (the TTL serving cache stays separate in `.cache/`, with a
deliberately opposite contract):

```
.tidepool/
├── tidepool.sqlite3        WAL, synchronous=NORMAL, foreign keys ON,
│                           busy_timeout 5s, incremental auto-vacuum
├── objects/sha256/xx/…     content-addressed normalized record corpora
├── snapshots/              snapshot documents (manifest rows join contents)
├── exports/                portable evidence bundles
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
deleted by default; compaction is a documented later feature and must stay
explicit, logged, and reversible.

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

## Development-direction status

| direction item | status |
|---|---|
| Immutable observations with full provenance fields | implemented |
| Deterministic change detection, observation-attributed | implemented (11 change kinds) |
| Inflow heuristics with rule ids / confidence basis / ambiguity | implemented — 5 rules; toolchain-migration, ABI-wave, coordinated-churn, upstream-lag rules are seams on the same Rule type, not yet written |
| Observation / churn / interpretive snapshot stages | implemented |
| Content-addressed, schema-versioned, reproducible snapshots | implemented (digest binds content; fixed-window rebuild identity smoke-asserted) |
| Exports: JSON, NDJSON, SQLite, bundle, Markdown, HTML from one model | implemented |
| Explicit truth boundary (notObserved, failures, partial coverage, ambiguity) | implemented |
| Project classes | Rust, Node, Python, C/C++, Linux package, container, kernel module, mixed monorepo, unrecognized — firmware trees and infrastructure repos classify as `unrecognized` today |
| Dispatch findings | 6 of the listed kinds emitted; migration-likely / compatibility-review / already-mitigated need richer local analysis and are not yet emitted |
| Dispatch artifact: immutable, snapshot-referencing, reproducible | implemented |
| Console rendering of observations/changes/snapshots | not yet — API + CLI complete; the UI still renders current state only |
| SQLite observation store: migrations, sources, artifacts, observations, entities/states, heads, changes | implemented (milestones 1–8) |
| Historical queries + snapshot reconstruction from SQLite | implemented (9–10); old-window digest identity test-proven |
| Backup-API export, full + thin evidence bundles, safe import | implemented (11–12) with dry-run, checksum, schema-ledger, and conflict-retention guarantees |
| Milestone test classes 13–16 | implemented (dedup, failure/recovery, old-snapshot immutability, offline load) |
| Evidence / relationships / finding-join tables | schema present (0002); only findings are written today (at snapshot persist) — evidence extraction is the seam |
| Two-stage collection/analysis transactions, retention policies, compaction | deferred by design |
| "Do not restrict collection to relevance" | collection is scope-bounded by config (whole archives for distros; declared sets for registries); registry-wide enumeration remains the documented scope.mode seam |

## Known limitations

- **Alpine's APKINDEX signature is not yet checked** (the RSA signature
  embedded in the tarball); Alpine index data is fetch-trusted over TLS.
  Arch's packages API is likewise TLS-only, with no detached signing to
  verify.
- Endpoints verified live from the build environment: Ubuntu archive (all
  pockets, GPG + digest), crates.io (both surfaces), PyPI (both), npm (all
  three including the yarnpkg mirror). The remaining defaults — Debian,
  Alpine, Arch mirrors; RubyGems, Maven, Go proxy, NuGet, Packagist, Hex,
  pub.dev, CRAN, ConanCenter — are written to their documented protocols but
  were not reachable from the build environment (vcpkg's two surfaces WERE
  live-verified, via the raw vcpkg repository); any that has drifted will show a
  visible per-source error with its URL, and the fix is a config edit.
- Ubuntu binary↔source advisory joins use the names the USN feed provides; a
  notice naming only source packages joins on the source name.
- Version-drift ordering for apk/Arch/registry schemes uses the dpkg
  comparator, which orders them correctly in practice but is not their native
  comparator.
- Code-unit scopes are explicit lists; registry-wide enumeration (e.g. the
  PyPI simple index's full name list) is a further `scope.mode` behind the
  same seam, not yet implemented.

## License

MIT — see `LICENSE`.
