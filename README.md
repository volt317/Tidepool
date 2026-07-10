# Tidepool — distro survey service

A web-app service for **distro-first change intelligence**: for each configured
distribution, Tidepool pulls the *comprehensive package list* from the distro's
own index sources, joins the distro's advisory feed on top, and offers
on-demand upstream enrichment per package — every source fetched, verified,
and parsed individually, every fact traceable to the endpoint that produced it.

```
tidepool.config.json          everything is declared here
server/                       Node collector + API (express, node ≥ 18)
  index.js                    orchestration, cache, HTTP API, static serving
  lib/util.js                 fetch/gzip/sha256, deb822, dpkg version compare,
                              ustar reader, disk cache
  sources/apt.js              Ubuntu/Debian pockets (digest-verified)
  sources/apk_arch.js         Alpine APKINDEX + secdb, Arch packages API + AVG
  sources/advisories.js       Ubuntu USN feed, OSV / endoflife / GitHub enrichment
web/                          React + Vite frontend
```

## Why there is a server

Distro archives and most advisory feeds do not serve CORS headers, so a pure
browser app cannot read them first-hand. The service is the collector: it
fetches, verifies, parses, and caches; the browser reads only the service.
It also means a 30k-package index is synced once and cached, not re-pulled
per visitor.

## Running

```sh
npm --prefix server install
npm --prefix web install

# development (two terminals)
npm run dev:server        # API on :8747
npm run dev:web           # Vite on :5173, proxies /api → :8747

# production (single process: API + built frontend)
npm run build
npm start                 # http://localhost:8747
```

## What each distro aggregates

| distro | comprehensive list from | advisory feed | enrichment ecosystem |
|---|---|---|---|
| Ubuntu 24.04 | `noble`, `noble-updates`, `noble-security` pockets (Packages.gz, **digest-verified against the signed InRelease**, fails closed per pocket) | ubuntu.com USN feed (newest N pages, joined by package name) | OSV `Ubuntu:24.04:LTS` |
| Debian 12 | `bookworm`, `bookworm-updates`, `bookworm-security` (same verification) | OSV on demand per package | OSV `Debian:12` |
| Alpine 3.20 | `main` APKINDEX.tar.gz | Alpine secdb (small enough to join in full) | OSV `Alpine:v3.20` |
| Arch | packages API, `Core` + `Extra` (paginated) | Arch AVG feed | — (no OSV ecosystem) |

Each pocket/repo is an **independent source** with its own status, error, and
provenance URLs (visible under "sources" in the UI). Per-package version drift
across pockets — e.g. `release 1.9.15p5-3ubuntu5` vs `security
…-3ubuntu5.24.04.2` — is surfaced as a first-class signal, computed with a
faithful port of dpkg's version comparison (Debian versions are never
string-compared).

Opening a package fetches on-demand enrichment: OSV advisories for the
distro's ecosystem (querybatch for the full count, detail for the newest few),
endoflife.date lifecycle, and GitHub releases — the latter two driven by
`packageHints` in the config.

## Configuration

`tidepool.config.json` declares everything; edit it and either restart or
`POST /api/reload`. The shipped file is commented inline. Highlights:

- `distros[]` — enable/disable, pockets/repos/components/arch, digest
  verification, advisory feed and its depth (`pages`), OSV ecosystem string.
  Adding a derivative (Mint, another Ubuntu release, Debian testing) is a new
  entry with different suites — no code.
- `server.indexTtlHours` / `advisoryTtlHours` — how long synced data is
  trusted (disk-cached under `cacheDir`; a restart reuses fresh cache).
- `packageHints` — source-package → upstream mappings (`github`, `eol`) that
  switch on the corresponding enrichment panels.
- `enrichment.githubToken` (or env `TIDEPOOL_GITHUB_TOKEN`) — raises
  api.github.com anonymous limits.
- Ubuntu `components` defaults to `["main"]`; add `"universe"` for the full
  ~70k-package archive (bigger sync, same code paths).

## API

```
GET  /api/config
GET  /api/distros                              status + per-source health
POST /api/distros/:id/sync                     force re-sync
GET  /api/distros/:id/packages?q=&page=&per=&advisories=1&drift=1
GET  /api/distros/:id/packages/:name           all index sources + joined advisories
GET  /api/distros/:id/packages/:name/enrich    OSV / endoflife / GitHub, per-record status
POST /api/reload                               re-read config
```

## Honest caveats

- **InRelease GPG signatures are not yet verified** — the digest chain from
  InRelease's SHA256 table down to each Packages.gz is enforced (fail-closed),
  but the signature over InRelease itself is trusted-on-fetch. Verifying it
  against the archive keyrings (e.g. via `gpgv`) is the next hardening step.
  Alpine's APKINDEX signature is likewise not yet checked.
- **The Arch AVG endpoint** (`security.archlinux.org/issues/all.json`) is the
  one URL in the default config not verified from the build environment (the
  sandbox couldn't reach it); if it has moved, the source will show a visible
  error with the URL — adjust it in the config.
- Ubuntu binary↔source advisory joins use the names the USN feed provides;
  a notice naming only source packages joins on the source name (the UI shows
  which name matched).
- Version-drift ordering for apk/Arch uses the dpkg comparator, which orders
  those schemes correctly in practice but is not their native comparator.

## Provenance ethos

Carried over from the Tidepool engine design: sources are never blended, a
failing source is a visible fact with its error and endpoint, verified data is
labeled as verified, and nothing pretends to more certainty than its source
provides.

MIT — see LICENSE.
