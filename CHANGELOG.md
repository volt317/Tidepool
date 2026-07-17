# Changelog

Notable changes. Pre-1.0: minor versions may break anything; the corpus
schema version and snapshot digest semantics are called out explicitly when
they change.

## [Unreleased]

### Changed
- Runtime dependencies: two → ZERO. `express` and `express-rate-limit`
  (a 69-package, 723-file, ~35k-line transitive closure) replaced by
  `server/src/http/` — ~300 typed local lines implementing exactly the
  surface the codebase used (segment router with params + HEAD derivation,
  JSON responses with weak ETag/304, capped JSON body reading, safe static
  serving, flat query parsing, fixed-window rate limiting) — under
  adversarial unit tests (path traversal, body caps, window math). The
  runtime image no longer contains a node_modules directory at all.
- Image builds run `npm ci --ignore-scripts` (no dependency needs lifecycle
  scripts; closes install-time code execution at build time).
- Root README reduced to a front door; full material moved to
  `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/CONFIGURATION.md`,
  and `deploy/README.md` (deployment build/runtime detail).
- `deploy/scripts/verify.sh` split into an orchestrator over independent
  `verify-host.sh` / `verify-install.sh` /
  `verify-deployment.sh` / `verify-corpus.sh`, plus a new structural
  `verify-render.sh` (structural render checks; no install
  required).
- Store contract extracted to `server/src/core/store.types.ts`
  (re-exported from `store.js`; no import changes required).
- Web console no longer requests fonts from a third-party CDN; system
  font stacks only.
- Smoke test now probes upstream reachability first and fails fast with an
  explicit `UPSTREAM UNREACHABLE` verdict, so a mirror outage is
  distinguishable from a pipeline regression.

### Fixed
- The image build stage never received `.npmrc`, so `engine-strict=true`
  did not apply inside `podman build`: `npm ci` on a wrong-Node base only
  warned, and the mistake surfaced at the final image-node tripwire after
  a full compile. `.npmrc` is now copied with the manifests, failing the
  build at dependency install in seconds.

### Added
- `deploy/scripts/uninstall.sh`: backtracks the install (services, timers,
  units, containers, images, tooling removed; root steps printed, mirroring
  install.sh). Data root preserved by default; `--purge-data` with typed
  confirmation to delete; idempotent.
- `structure` workflow: slim per-change structural appliance gate
  (deploy-config drift, lock drift, structural render checks).
- `shellcheck` job in the lint workflow covering all shell scripts.
- ADR 0010 recording the Node 24 baseline rationale.
- SECURITY.md, CONTRIBUTING.md, this file.

### Removed
- Host-level MAC-profile and firewall-ruleset integrations, end to end
  (unit args, install/uninstall steps, CI tooling, verification checks,
  shipped artifacts, and documentation claims). ADR 0011 is the single
  record of what they were and why they left; a slimmer per-service
  hardening path replaces the role (see ADR 0011 Consequences).
- Dead pre-TypeScript implementation (`server/index.js`,
  `server/sources/*.js`, `server/lib/util.js`, `web/src/App.jsx`,
  `web/src/main.jsx`).

## [0.3.0] — 2026-07-16
Pre-existing state at the time this changelog was introduced: two-domain
collection (distro + code ecosystems), append-only observation store on
`node:sqlite`, inflow change detection and heuristics, content-addressed
snapshots with six export formats, offline dispatch, isolated-appliance
deployment (rootless quadlets), CI: build+smoke, test,
lint, CodeQL, http-security, weekly integrated deploy scenario.
