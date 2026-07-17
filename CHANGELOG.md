# Changelog

Notable changes. Pre-1.0: minor versions may break anything; the corpus
schema version and snapshot digest semantics are called out explicitly when
they change.

## [Unreleased]

### Changed
- AppArmor and nftables demoted from required enforcement layers to
  documented optional hardening (ADR 0011): rootless podman refuses custom
  AppArmor profiles on every current version, and the CI conditional that
  should have caught it degraded silently. Security-opt args removed from
  units, CI topology, and corpus verification; enforcement table rewritten
  to claim only what binds by default, explicitly naming the two claims no
  longer made (exec restriction, collector egress narrowing); profiles and
  the nft template remain in-tree with parse checks so they cannot rot.
- Image builds run `npm ci --ignore-scripts` (no dependency needs lifecycle
  scripts; closes install-time code execution at build time).
- Root README reduced to a front door; full material moved to
  `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/CONFIGURATION.md`,
  and `deploy/README.md` (deployment build/runtime detail).
- `deploy/scripts/verify.sh` split into an orchestrator over independent
  `verify-host.sh` / `verify-install.sh` / `verify-apparmor.sh` /
  `verify-deployment.sh` / `verify-corpus.sh`, plus a new structural
  `verify-render.sh` (render + nftables + AppArmor parse; no install
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
- `render.sh` could never pass on a host with nftables installed: `nft -c`
  needs CAP_NET_ADMIN even as a pure check (netlink cache init), and
  render.sh refuses to run as root. Both render.sh and `verify-render.sh`
  now escalate only that check through passwordless sudo when available,
  report an honest SKIP when no privilege path exists, and print the tool's
  real output on a genuine failure. (Latent since the nft check was added —
  no prior CI job ever installed nftables.) Escalation is visible
  (`(via sudo)` in the PASS line), covers only two read-only fixed-argv
  commands, and `TIDEPOOL_VERIFY_NO_SUDO=1` disables it.

### Added
- `deploy/scripts/uninstall.sh`: backtracks the install (services, timers,
  units, containers, images, tooling removed; root steps printed, mirroring
  install.sh). Data root preserved by default; `--purge-data` with typed
  confirmation to delete; idempotent.
- `structure` workflow: slim per-change structural appliance gate
  (deploy-config drift, lock drift, render/nftables/AppArmor parse).
- `shellcheck` job in the lint workflow covering all shell scripts.
- ADR 0010 recording the Node 24 baseline rationale.
- SECURITY.md, CONTRIBUTING.md, this file.

### Removed
- Dead pre-TypeScript implementation (`server/index.js`,
  `server/sources/*.js`, `server/lib/util.js`, `web/src/App.jsx`,
  `web/src/main.jsx`).

## [0.3.0] — 2026-07-16
Pre-existing state at the time this changelog was introduced: two-domain
collection (distro + code ecosystems), append-only observation store on
`node:sqlite`, inflow change detection and heuristics, content-addressed
snapshots with six export formats, offline dispatch, isolated-appliance
deployment (rootless quadlets, AppArmor, nftables), CI: build+smoke, test,
lint, CodeQL, http-security, weekly integrated deploy scenario.
