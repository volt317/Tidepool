# Tidepool

**A self-hosted distro survey service.** Point it at the Linux distributions
you care about and it pulls each one's *complete* package list from the
distribution's own index sources, joins the distribution's advisory feed on
top, and gives you a searchable console over the result — with every source
fetched, cryptographically verified where the distro signs, and parsed
individually, so every fact on screen traces back to the endpoint that said
it.

> A tidepool is what the ocean leaves behind where you can actually look at
> it. Upstream churns constantly; this makes your slice of it inspectable.

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
  distro's ecosystem (full count via `querybatch`, details for the newest
  few), plus endoflife.date lifecycle and GitHub releases for packages mapped
  in `packageHints` — each panel with its own status and endpoint.

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
server/src/                   TypeScript collector + API (express; node ≥ 18)
  index.ts                    orchestration, cache, HTTP API, static serving
  lib/util.ts                 fetch/gzip/sha256, deb822 parsing, dpkg version
                              compare, ustar reader, disk cache
  lib/gpg.ts                  InRelease signature verification via gpgv
  sources/apt.ts              Ubuntu/Debian pockets (signature- and digest-verified)
  sources/apk_arch.ts         Alpine APKINDEX + secdb, Arch packages API + AVG
  sources/advisories.ts       Ubuntu USN feed; OSV / endoflife / GitHub enrichment
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

```
GET  /api/config
GET  /api/distros                              status + per-source health
POST /api/distros/:id/sync                     force re-sync
GET  /api/distros/:id/packages?q=&page=&per=&advisories=1&drift=1
GET  /api/distros/:id/packages/:name           all index sources + joined advisories
GET  /api/distros/:id/packages/:name/enrich    OSV / endoflife / GitHub, per-record status
POST /api/reload                               re-read config
```

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

## Known limitations

- **Alpine's APKINDEX signature is not yet checked** (the RSA signature
  embedded in the tarball); Alpine index data is fetch-trusted over TLS.
  Arch's packages API is likewise TLS-only, with no detached signing to
  verify.
- The Arch AVG endpoint (`security.archlinux.org/issues/all.json`) is the one
  default URL not verified from the environment this project was built in; if
  it has moved, the source will show a visible error with the URL — adjust it
  in the config.
- Ubuntu binary↔source advisory joins use the names the USN feed provides; a
  notice naming only source packages joins on the source name.
- Version-drift ordering for apk/Arch uses the dpkg comparator, which orders
  those schemes correctly in practice but is not their native comparator.

## License

MIT — see `LICENSE`.
