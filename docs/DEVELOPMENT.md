# Tidepool — Development

Repository layout, local workflows, the tooling model, testing, CI, and
current status. See `docs/ARCHITECTURE.md` for mechanism and
`deploy/README.md` for the appliance.

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

The workflows under `.github/workflows/` (validated with actionlint):

- **lint** — ESLint + the TypeScript compiler across server, shared, and web;
  the same commands as the local gates, so CI and a checkout can never
  disagree about "clean". A second job runs **shellcheck** (`-S warning -x`)
  over every shell script in `deploy/scripts/`, `deploy/scripts/lib/`, and
  `scripts/`.
- **build** — compiles both halves and uploads `server/dist` + `web/dist` as
  an artifact, then a **runtime smoke** job downloads that artifact,
  installs production-only server deps, and runs `npm run smoke`
  (`scripts/smoke.mjs`): boots the built service on a minimal dedicated
  config and asserts live that a real apt pocket syncs `signature+digest`
  through gpgv, an npm scope resolves on all three surfaces including the
  cross-host yarnpkg mirror, search returns per-source versions, and the
  built frontend is served. Advisory/enrichment sources are disabled in the
  smoke config so only security.ubuntu.com and the npm registries can affect
  the verdict, and the smoke probes those upstreams first, failing fast with
  an explicit `UPSTREAM UNREACHABLE` verdict so a mirror outage is
  distinguishable from a pipeline regression (a mirror being down is still a
  legitimate failure — aggregating upstream is the point). The smoke runs locally too: `npm run build && npm run smoke`.
- **test** — the unit suite with coverage thresholds on Node 24; the lcov
  report is uploaded as an artifact.
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

Lint, build, smoke, and the runtime image all target Node 24, single-sourced
from `.node-version` (`node-version-file`) so no workflow duplicates the
version. The service requires Node 24 (`node:sqlite` is unflagged there;
declared in `engines`, enforced by `engine-strict=true`) — ADR 0010 records
the full rationale and names the four reinforcing gates.
- **structure** — the slim per-change appliance gate: generated
  deploy-config and component-lock drift checks, then
  `deploy/scripts/verify-render.sh` — templates render with zero surviving
  placeholders and no `:latest`, quadlet generator dry-run, rendered
  `tidepool.nft` passes `nft -c`, and every AppArmor profile parses with
  `apparmor_parser -Q`. No image builds; it runs in minutes on any PR
  touching `deploy/`, `shared/`, `scripts/`, or the manifests. The heavy
  invariants (image contents, live topology, negative boundary suite,
  backup/restore round trip) run in **deploy** below.
- **http-security** — generates a temporary local CA, starts the API and
  HTTPS proxy, and asserts the admission contract: route manifest,
  method/body/query/framing rejection (including raw-socket smuggling-style
  tests over TLS), security headers, per-route caching, TLS 1.0/1.1
  rejection vs 1.2/1.3 acceptance, and that the CA private key never reaches
  the proxy. Runs locally too: `./deploy/scripts/http-security-test.sh`.
- **deploy** — the integrated 19-step scenario (`ci-deploy-test.sh`),
  weekly and on demand: real image builds (digest-pinned base, immutable
  tags, `verify-image-contents.sh` asserting no npm/compilers in runtime
  images), a live four-container topology (shared definition:
  `deploy/scripts/ci-topology.sh`), bounded live collection, the negative
  boundary suite, snapshot creation, offline dispatch, API availability
  with the collector stopped, and the restore-then-compare-snapshot-digests
  round trip.

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

