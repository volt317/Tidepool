# Tidepool — Configuration and API

Everything the collectors do is declared in `tidepool.config.json`; this
document covers what ships configured, the configuration model, and the
HTTP API surface.

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

