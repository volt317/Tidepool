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

(`docs/OVERVIEW.md` is the short authoritative statement of the mission,
operating modes, and appliance guarantees; `examples/` holds a small
deterministic snapshot + dispatch artifact produced by this exact pipeline;
`docs/adr/` records the individual architecture decisions.)


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

## What it does, in five lines

- **Comprehensive per-distro package lists** — Ubuntu 24.04, Debian 12, Alpine 3.20, and Arch ship configured; every index source fetched, verified where the distro signs, and kept separate.
- **Every information source stands alone** — per-source versions, status, and endpoint; a failing source is a visible fact, never a silent gap.
- **Version drift as a first-class signal** — dpkg-faithful version comparison across pockets, never string compares.
- **Advisories and enrichment as immutable evidence** — USN / secdb / AVG / OSV joined on, endoflife.date and GitHub releases recorded as evidence observations.
- **Bounded snapshots and offline dispatch** — content-addressed truth at a time boundary, projects judged against it with no network.

## Running

```sh
npm install               # workspace root — covers server and web
npm run build             # tsc → server/dist, vite → web/dist
npm start                 # single process: http://localhost:8747

# the deployed form is the isolated appliance — see deploy/README.md
./deploy/scripts/install.sh
```

Requires Node ≥ 24 (see `docs/adr/0010-node-24-runtime-baseline.md` for why).
`npm run lint`, `npm run typecheck`, and `npm test` are the gates for any
change.

## Where everything is documented

| Document | Governs |
|---|---|
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | mission, operating modes, appliance guarantees — the authoritative short statement |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | layers, the contained flow, inflow/snapshots/dispatch mechanism, the observation store, design principles |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | repository layout, workflows, tooling model, testing, CI, status and known limitations |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | `tidepool.config.json`, what each distro aggregates, the HTTP API |
| [`deploy/README.md`](deploy/README.md) | the isolated appliance: enforcement layers, images, quadlets, verification, TLS |
| [`docs/adr/`](docs/adr/) | individual architecture decisions |
| [`examples/`](examples/) | a deterministic snapshot + dispatch artifact produced by this exact pipeline |

## License

MIT — see `LICENSE`.
