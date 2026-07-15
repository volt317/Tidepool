# Tidepool

<p align="center">
  <img src="assets/banner.png" alt="Project Tidepool Banner Image"/>
</p>

Tidepool observes configured upstream surfaces, preserves what it saw as
durable evidence, and lets projects be judged against that evidence — even
offline:

```sh
# 0. once: npm install && npm run build   (workspace install; compiled dist
#    is what every entrypoint — services, CLIs — runs from)

# 1. observe: collect every configured unit; every source becomes
#    immutable observations (admin CLI → collector control socket)
npm run admin sync-all

# 2. bound: build a snapshot — historical reconstruction at a time boundary
npm run admin snapshot interpretive 168

# 3. dispatch: evaluate a local project against that snapshot, offline
node server/dist/server/src/cli/dispatch.js --snapshot <digest> ./my-service
```

    observed inflow → bounded snapshot → offline project dispatch finding

Administration goes over a local Unix socket, never the web API — in the
deployed appliance the browser-facing service is read-only and cannot
trigger collection (its sync/snapshot routes answer 405 by design). The
single-process development mode (`npm start`) still accepts the same
operations as HTTP POSTs for convenience.

(`examples/` holds a small deterministic snapshot + dispatch artifact
produced by this exact pipeline; `docs/adr/` records the architecture
decisions.)


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

## Layout

```
tidepool.config.json          everything the service does is declared here
shared/types.ts               the typed API contract (server implements, web consumes)
server/src/
  index.ts                    single-process dev mode: config → providers →
                              core → composed routes
  services/                   the appliance: collector.ts (writer + control
                              socket + replica publication), api.ts (replica
                              reads), scheduler.ts, proxy.ts (HTTPS admission
                              gate), httpAdmission.ts (framing/route engine),
                              tls.ts (local CA + certs), ipc.ts (JSON over
                              Unix sockets), bootstrap.ts
  cli/                        dispatch.ts, corpus.ts, admin.ts (control
                              socket operations), retention.ts, tls.ts
                              (init/inspect/renew/export-ca/verify)
  core/aggregator.ts          the contained flow: sync, cache, summaries, drift,
                              enrichment-as-evidence — domain-agnostic
  core/readmodel.ts           UnitState reconstruction from the published
                              replica (what the deployed API serves)
  core/routes.ts              dev composition of routes.read.ts +
                              routes.control.ts (symmetric across domains)
  core/enrich.ts              shared OSV / endoflife / GitHub adapters + OSV batch join
  lib/util.ts                 fetch/gzip/sha256, deb822 parsing, dpkg version
                              compare, ustar reader, disk cache
  lib/gpg.ts                  InRelease signature verification via gpgv
  domains/providers.ts        config → UnitProviders for both domains
  domains/distro/             apt pockets (signature+digest verified), Alpine
                              APKINDEX + secdb, Arch packages API + AVG, USN feed
  domains/code/surfaces.ts    crates.io / PyPI / npm dual-surface resolvers
web/                          React + Vite console (TypeScript)
shared/types.ts               the one contract both sides compile against
shared/httpPolicy.ts          versioned deny-by-default HTTP route manifest
                              (proxy + tests compile against it)
shared/deployConfig.generated.ts  GENERATED from deploy/deploy.yaml before
                              tsc — deploy values as static consts in
                              compiled JS (no runtime YAML reads)
deploy/deploy.yaml            single location for build/deploy values that
                              multiple files must agree on (see Configuration)
deploy/oci/Containerfile      one multi-target build: collector/api/
                              scheduler/proxy/utility
deploy/quadlet/templates/     Quadlet unit templates (rendered per deployment)
deploy/apparmor/              seven per-service profiles
deploy/nftables/              host firewall template (rendered, then adapted)
deploy/scripts/               install/render/verify/boundaries/backup/restore
                              + lib/deploy-config.sh (the YAML loader)
scripts/                      generate-deploy-config.mjs (YAML → TS consts),
                              sync-component-locks.sh (standalone lock upkeep)
eslint.config.js              flat config: typescript-eslint + react-hooks
```

The server exists because it has to: distro archives and most advisory feeds
do not serve CORS headers, so a browser cannot read them first-hand — and a
9,000-package index should be synced once and cached, not re-pulled per
visitor. The browser talks only to the service; the service talks to the
authorities.

## Running

```sh
npm install               # workspace root — one install covers server and
                          # web too (npm workspaces, hoisted node_modules)

npm run typecheck         # tsc across server, shared, and web — must be clean
npm run lint              # eslint (flat config) — must be clean

# development (two terminals)
npm run dev:server        # compiles server, API on :8747
npm run dev:web           # Vite on :5173, proxies /api → :8747

# production, single process (API + built frontend + live control routes)
npm run build             # tsc → server/dist, vite → web/dist
npm start                 # http://localhost:8747 (run from the repo root)

# production, isolated appliance (the deployed form — see deploy/README.md)
./deploy/scripts/install.sh   # digest-pinned builds, immutable tags,
                              # rendered Quadlet units, printed root steps
systemctl --user start tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler
```

The entire codebase is TypeScript against the shared contract in
`shared/types.ts`. `npm run lint` and `npm run typecheck` pass with zero
findings and are the gate for any change.

The tooling model, in one sentence: **everything executes compiled
JavaScript from `server/dist` — services, the admin and retention CLIs,
the proxy — and the only build-time tools are `tsc`, Vite, and plain-Node
scripts** (no tsx/ts-node anywhere, declared or otherwise). The root
scripts fall into four groups:

| Group | Scripts |
|---|---|
| generated-artifact upkeep | `generate:deploy-config` / `check:deploy-config`, `sync:locks` / `check:locks` — each generator has a `check:` twin that CI runs as a drift gate |
| build & quality | `build`, `build:server` (regenerates the deploy-config module, then `tsc`), `build:web`, `typecheck`, `lint`, `test`, `test:coverage`, `smoke` |
| run | `dev:server`, `dev:web`, `start` (single-process), `start:collector` / `start:api` / `start:scheduler` / `start:proxy` (the appliance services, from dist) |
| operate | `admin` (control-socket CLI), `retention` (reachability pruning) — both run from dist, so build first |

The repository is an **npm workspace** (`server`, `web`) with a two-tier
lock strategy, each lock with a distinct job. The root
`package-lock.json` is the PROJECT lock: workspaces maintain exactly one,
and it governs every developer and CI install. `server/package-lock.json`
and `web/package-lock.json` are STANDALONE-mode locks that npm ignores
during workspace installs — their job is the container build, where each
runtime image runs `npm ci --omit=dev --workspaces=false` against its own
component lock, deterministically and with no monorepo knowledge. They are
generated, never hand-edited: `npm run sync:locks` regenerates them after
any dependency change, and `npm run check:locks` is the CI drift gate —
the same discipline as `shared/deployConfig.generated.ts`.

## Deployment: the isolated appliance

The deployed form (`deploy/`) runs four independent rootless Podman
containers with one governing invariant: **the collector is the only
Tidepool process permitted to access the Internet.**

```
collector   sole Internet egress · sole corpus writer · publishes an
            atomically replaced read-only SQLite replica · control surface
            is a Unix socket (run/collector-control.sock) — no TCP at all
api         --network=none · reads the published replica SQLITE_OPEN_READONLY
            plus objects/ and snapshots/ read-only · the writer directory is
            absent from its mount namespace · listens on a Unix socket
proxy       the only published TCP port (127.0.0.1:8747 by default) · holds
            no data · forwards to the API's socket with size/time limits
scheduler   --network=none · drives collection/snapshot/verification/
            enrichment cadence from the validated config over the socket
dispatch    ad-hoc jobs, --network=none, read-only project mounts
```

### Build path

All five images come from one multi-target Containerfile,
`deploy/oci/Containerfile` (targets: `collector`, `api`, `scheduler`,
`proxy`, `utility` — the last carries the CLIs for dispatch, corpus
export/import, and verification jobs). `install.sh` drives the build, but
it is ordinary `podman build`:

```sh
BASE=$(deploy/scripts/pin-base.sh)          # resolves the node:22-bookworm-slim
                                            # base to its CURRENT digest
podman build -f deploy/oci/Containerfile --target collector \
  --build-arg BASE_IMAGE="$BASE" \
  --build-arg TIDEPOOL_VERSION=0.3.0 \
  --build-arg TIDEPOOL_GIT_COMMIT=$(git rev-parse HEAD) \
  -t localhost/tidepool-collector:0.3.0-g$(git rev-parse --short HEAD) .
```

Every shared build/deploy value — ports, uid/gid, base image tag, data
root — comes from **`deploy/deploy.yaml`** (its consumption rules,
compile-time TypeScript baking included, are detailed under
[Configuration](#configuration)); the build reads it through the same
loader and `--build-arg` lines as everything else.

Image discipline, enforced rather than suggested: the base is pinned **by
digest** at build time (CI fails builds that used the floating tag); local
tags are immutable (`<version>-g<commit>` — rendered units never reference
`:latest`, and `render.sh` refuses to emit one that does); the version/
commit build args are baked as environment so every snapshot manifest and
replica publication records the exact software identity that produced it;
and `install.sh` writes the final image digests to
`exports/image-digests-<tag>.json`. The collector image is the only one
that adds a package (`gpgv`, for archive signature verification); the build
stage compiles TypeScript and the frontend after one workspace-root
`npm ci` (the project lock), and each runtime stage carries only
`server/dist`, migrations, (API only) `web/dist`, and a production
`node_modules` produced by a standalone
`npm ci --omit=dev --workspaces=false` against `server/package-lock.json` —
the per-component lock exists precisely for that step — the read-only root itself is the Quadlet unit's doing
(`ReadOnly=true`), so even the collector image contains nothing writable
at runtime beyond its mounted data trees and a `noexec` tmpfs.

### Runtime

The runtime is **rootless Podman under user-level systemd via Quadlet**
(Podman ≥ 4.4). Units are not hand-written: `deploy/scripts/render.sh`
renders the templates in `deploy/quadlet/templates/` with this
deployment's data root, image tag, and the `deploy/deploy.yaml`
configurables — listener, ports, uid/gid — refusing unresolved
placeholders, and additionally renders the host firewall policy
(`tidepool.nft`) so its port define can never disagree with the unit's
`PublishPort`; and `install.sh` places the result in
`~/.config/containers/systemd/`, where the Quadlet generator turns each
`.container` file into a systemd service:

```sh
systemctl --user start  tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler
systemctl --user status tidepool-collector      # health, restarts, journal
journalctl --user -u tidepool-collector -f      # structured JSON-line logs
loginctl enable-linger $USER                    # keep running after logout
```

Every unit declares a read-only root filesystem, dropped capabilities,
`NoNewPrivileges`, its AppArmor profile, pids/memory/cpu limits, a health
check (the collector and API answer over their Unix sockets; the scheduler
is checked by heartbeat-file freshness), restart-on-failure with startup
rate limiting (`StartLimitBurst=5`/300s), and `TimeoutStopSec=120` so the
collector's SIGTERM drain — finish in-flight observations, complete a
pending replica publication, close the writer — always has room. Two
systemd user timers (`tidepool-backup.timer` daily, `tidepool-verify.timer`
weekly) run the operational jobs in confined utility containers.

Host requirements: `podman` (≥ 4.4 for Quadlet) and a systemd user
session; `apparmor_parser` and `nft` for the two host-side enforcement
layers; `git` and Node ≥ 22.13 to build and to run the admin CLI from the
checkout (`npm run admin` — or exec the same CLI inside the utility image
if the host has no Node). Nothing on the host needs root except loading
AppArmor profiles and nftables rules — the printed post-install steps.

Each service has its own AppArmor profile (seven ship, including
corpus-export/import for backup tooling), and a host nftables policy
(rendered from `deploy/nftables/tidepool.nft.in`) narrows the collector to DNS + 443 —
required, not optional, on hostile networks. Manual operations go through
the admin CLI over the control socket:

```sh
npm run admin health | sync-all | snapshot | publish | enrich <d> <u> <pkg>
npm run retention plan          # reachability-based pruning, dry-run default
~/.local/share/tidepool/bin/verify.sh              # positive checks
~/.local/share/tidepool/bin/boundaries-verify.sh   # negative checks: ~20
                                                   # prohibited operations
                                                   # attempted for real
```

Every isolation claim, the layer that enforces it, and the two honest
limitations (per-user rootless egress; description-less replica listings)
are tabled in `deploy/README.md`; ADR 0008 records the reasoning. API
availability does not depend on the collector — once a replica is
published, reads keep working with the collector stopped.

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

Seven workflows under `.github/workflows/` (validated with actionlint):

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
- **appliance** — the per-change deployment gate, one named step per
  invariant: generated deploy-config and component-lock drift checks, all
  five OCI targets built from a digest-pinned base, **no npm or compilers
  in any runtime image** (the runtime base deletes what node:slim ships;
  `verify-image-contents.sh` asserts absence, not policy), immutable-tag
  validation, AppArmor compile + kernel load, Quadlet render and generator
  dry-run — then one live topology session (shared definition:
  `deploy/scripts/ci-topology.sh`) for the negative boundary suite,
  backup → clean-corpus restore → verify, and API availability with the
  collector stopped.
- **http-security** — generates a temporary local CA, starts the API and
  HTTPS proxy, and asserts the admission contract: route manifest,
  method/body/query/framing rejection (including raw-socket smuggling-style
  tests over TLS), security headers, per-route caching, TLS 1.0/1.1
  rejection vs 1.2/1.3 acceptance, and that the CA private key never reaches
  the proxy. Runs locally too: `./deploy/scripts/http-security-test.sh`.
- **deploy** — the integrated 19-step scenario (`ci-deploy-test.sh`),
  weekly and on demand: everything the gate checks plus bounded live
  collection, snapshot creation, offline dispatch, and the
  restore-then-compare-snapshot-digests round trip.

## What each distro aggregates

| distro | comprehensive list from | advisory feed | enrichment ecosystem |
|---|---|---|---|
| Ubuntu 24.04 | `noble`, `noble-updates`, `noble-security` pockets — InRelease GPG-verified, Packages.gz digest-verified against it; both fail closed per pocket | ubuntu.com USN feed (newest N pages, joined by package name) | OSV `Ubuntu:24.04:LTS` |
| Debian 12 | `bookworm`, `bookworm-updates`, `bookworm-security` — same two-link verification, Debian keyrings | OSV on demand per package | OSV `Debian:12` |
| Alpine 3.20 | `main` APKINDEX.tar.gz | Alpine secdb (small enough to join in full) | OSV `Alpine:v3.20` |
| Arch | packages API, `Core` + `Extra` (paginated) | Arch AVG feed | — (no OSV ecosystem) |

## Configuration

Three configuration surfaces, each with one job and a rule that keeps them
from bleeding into each other:

| Surface | Owns | Read |
|---|---|---|
| `tidepool.config.json` | application **behavior**: sources, scheduler cadence, maintenance policy | at service start / `POST /api/reload`, schema-validated |
| `deploy/deploy.yaml` | build/deploy values **multiple files must agree on**: ports, uid/gid, base image, data root | shell scripts when *they* run; TypeScript **at compile time only** |
| environment variables | deployment **wiring**: paths, socket locations, provenance identity — never behavior | at process start |

### `tidepool.config.json`

Declares what the appliance observes and when; edit it and either restart
or `POST /api/reload`. The shipped file is commented inline. Highlights:

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
- `scheduler` — the appliance's cadence, in the same validated document as
  everything else: `enabled`, `collectionInterval` / `snapshotInterval` /
  `verificationInterval` / `enrichmentInterval` (durations like `"30m"`,
  `"6h"`, `"7d"`), `snapshotStage`, `snapshotWindowHours`. Environment
  variables carry deployment wiring only (paths, sockets, provenance
  identity), never behavior.
- `http` — the appliance's strict HTTP admission + self-managed TLS
  (appliance mode). `enabled`, `listenAddress`/`port`, `allowedHosts`
  (Host allowlist), a `tls` block (`mode`: `generated-local-ca` |
  `generated-self-signed` | `provided` | `disabled`; `serverNames` /
  `ipAddresses` become certificate SANs; `keyAlgorithm`; lifetimes),
  `authentication.mode` (`none` | `basic-over-tls` | `mtls`), and `limits`
  (connection/header/query bounds enforced within safe floors and ceilings).
  Unknown keys are rejected. The proxy is a deny-by-default gate over a
  versioned route manifest; administration never appears on the HTTP surface.
- `maintenance` — `publishReplicaAfterCollection` (default on),
  `enrichment.changedWindowHours` / `maxPerRun` (the bounded
  enrich-what-changed policy), `backup.retainVerified`, and
  `retention.enabled` (default off; retention additionally runs only via
  its CLI).
- Ubuntu/Debian `components` default to `["main"]`; add `"universe"` (or
  `"contrib"`, `"non-free"`) for the full archive — bigger sync, same code
  paths.

### `deploy/deploy.yaml`

The single location for values that would otherwise drift across files —
before it existed the proxy port lived in eight places, the container uid
in six. Current contents: `base_image` (tag; builds pin its *digest*),
`image_prefix`, `listen_addr` / `listen_port` (the appliance's one
published listener), `internal_port`, `container_uid` / `container_gid`,
and `data_root` (the `$TIDEPOOL_HOME` default).

How it is consumed — deliberately never by a running service:

- **Shell** (`render.sh`, `install.sh`, `pin-base.sh`, backup/restore/
  verify, CI) sources `deploy/scripts/lib/deploy-config.sh`, a
  dependency-free flat-YAML parser, when those scripts are invoked.
  Precedence: environment variable > `deploy.yaml` > built-in fallback, so
  `LISTEN_PORT=9000 ./deploy/scripts/install.sh` works for one-off runs and
  a missing file degrades to the historical defaults. `install.sh` copies
  the YAML next to the installed operator scripts so both read one truth.
- **TypeScript** consumes it at **compilation**: `npm run build:server`
  first runs `scripts/generate-deploy-config.mjs`, which bakes the values
  into the committed `shared/deployConfig.generated.ts`; the compiled
  services carry them as static consts and never open the YAML at runtime.
- **Everything downstream is rendered from it**: the Quadlet units'
  `PublishPort`/uid mappings and the nftables `proxy_port` define come out
  of the same render pass, so they cannot disagree with each other or with
  the compiled fallbacks.

Editing a value means: change the YAML, `npm run generate:deploy-config`
(or just build), re-render/re-install, commit — and the CI gates fail
anything stale (`npm run check:deploy-config`, plus the unit renderer
refusing unresolved placeholders). The scope rule is stated in
the file's header: values with an existing authoritative home —
application behavior, the release version in `package.json`, per-service
resource limits in the unit templates — are *not* duplicated into it.

## API

Domain-symmetric by construction — the same routes serve both domains:

```
GET  /api/config
GET  /api/domains                                        domains → units → per-source health
GET  /api/domains/:domain/units/:unit/packages?q=&page=&per=&advisories=1&drift=1
GET  /api/domains/:domain/units/:unit/packages/:name     all sources + joined advisories
GET  /api/domains/:domain/units/:unit/packages/:name/enrich   stored evidence
POST /api/reload                                         re-read config
POST /api/domains/:domain/units/:unit/sync               ┐ dev mode only —
POST /api/snapshots                                      ┘ the deployed API
                                                           answers 405; use
                                                           the admin CLI or
                                                           the scheduler
```

In the appliance, `/enrich` returns evidence previously recorded by the
collector (surface, observation time, items); in dev mode the same path
performs — and records — a live bounded enrichment.

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

## Development-direction status

| direction item | status |
|---|---|
| Immutable observations with full provenance fields | implemented |
| Deterministic change detection, observation-attributed | implemented (14 change kinds incl. evidence) |
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
| Evidence / relationships / finding-join tables | findings written at snapshot persist; enrichment now writes first-class evidence *observations* (`enrich:<surface>:<subject>`, explicit-scope) served by the API and covered by snapshots |
| Two-phase collection/analysis transactions (analysis_status, retryable) | implemented — a diffing failure never erases evidence |
| Dual source heads (latest vs latest-successful) | implemented; staleness declared in reconstruction |
| Native version semantics per ecosystem (`ordering: unsupported` honesty) | implemented — dpkg/apk/pacman/semver/pep440/dotted native; gems/maven/conan/vcpkg honestly unsupported |
| Structured field-level metadata diffs; advisory trichotomy (withdrawn / left-coverage-window / no-longer-observed) | implemented, coverage-mode driven |
| Corpus status/verify/vacuum; export modes (full/thin/database-only/referenced-objects) | implemented |
| apt raw-artifact preservation (InRelease + Packages.gz into the corpus) | implemented; other collectors' raw capture + HTTP fetch-metadata threading deferred |
| NdjsonObservationStore parity impl | deliberately not resurrected — retired one milestone before the seam existed; the interface + SQLite impl serve the seam's purpose |
| UI: observation timeline / entity history / truth-boundary / UnitAvailability axes | deferred (Milestone 6) |
| Isolated-appliance runtime: collector-only egress, published replica, Unix-socket control, negative boundary tests, deploy CI | implemented (ADR 0008, `deploy/`) |
| Retention policies, compaction | reachability-based retention CLI implemented (plan/apply, audit-first, backup-gated); disabled by default and CLI-only by design |
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
- Replica-served listings (the deployed API) carry no package description
  text — descriptions are not part of normalized index records — and
  advisories reconstructed from the corpus carry no click-through URL.
  Versions, drift, components, and advisory counts/details are all present.
  Dev mode, serving from live collection state, shows both.

## License

MIT — see `LICENSE`.
