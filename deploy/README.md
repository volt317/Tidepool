# Tidepool — Isolated Local-Network Appliance Deployment

Independent rootless Podman containers. One rule above all others:

> **The collector is the only Tidepool process permitted to access the
> Internet.** Every other service is offline from upstream — most of them
> offline from *everything*, holding a Unix socket and a read-only file
> tree instead of a network.

```
Internet
   │  outbound HTTPS/DNS only (nftables-narrowed; no inbound port at all)
   ▼
┌──────────────┐   writes    corpus/writer/tidepool.sqlite3  (sole writer)
│  collector   │──────────▶  corpus/objects, corpus/snapshots, exports
│              │   publishes published/tidepool-read.sqlite3 (atomic rename)
│              │   listens   run/collector-control.sock      (never TCP)
└──────────────┘
       ▲ unix socket                     ▲ reads (all read-only)
┌──────────────┐                  ┌──────────────┐    ┌────────────────┐
│  scheduler   │                  │     api      │◀───│ published/ ro  │
│ network=none │                  │ network=none │    │ objects/   ro  │
│ config+run   │                  │ run/api.sock │    │ snapshots/ ro  │
└──────────────┘                  └──────────────┘    └────────────────┘
                                         ▲ unix socket
                                  ┌──────────────┐
   trusted LAN ──── 127.0.0.1 ───▶│    proxy     │  (the ONLY published port;
                    :8747         │  no data at  │   holds no data)
                                  │     all      │
                                  └──────────────┘

   snapshot ──── offline ──── dispatch job (--network=none, ad hoc)
```

## What is enforced, and by which layer

Per the design rule ("no service claim is stronger than the enforcement
actually provided"), every claim below names its mechanism. Anything not
listed here is a convention, not a guarantee.

| Claim | Enforced by |
|---|---|
| API cannot reach the Internet | `Network=none` (no network namespace exists) **and** AppArmor `deny network inet/inet6` |
| Scheduler cannot reach the Internet | same two layers |
| Dispatch cannot reach the Internet | `--network=none` per job |
| API cannot touch the authoritative DB | writer directory absent from its mount namespace **and** AppArmor `deny /var/lib/tidepool/corpus/writer/** ` by name **and** its only DB connection is `SQLITE_OPEN_READONLY` against the replica |
| API cannot write published/objects/snapshots | `:ro` mounts **and** AppArmor read-only rules |
| Collector accepts no inbound TCP | no `PublishPort` in its unit (verified: `podman port` empty) — its control surface is a Unix socket, mode 0660 |
| Proxy holds no data | only `run/` and `config/` exist in its mount namespace; AppArmor denies the rest by name |
| Only node executes (any container) | AppArmor `deny …sh x`, `deny /usr/bin/** x` (collector additionally allows `gpgv`) |
| Collection can't be triggered from the API | the API has no route to the control socket in code, and answers 405; control requires filesystem access to the socket (admin CLI or scheduler) |
| Collector egress limited to DNS+443 | **host nftables** (`deploy/nftables/tidepool.nft`) — a REQUIRED layer on hostile networks, because rootless egress is user-level traffic |
| Proxy originates no Internet traffic | its *code* dials only the fixed socket path; nftables drops other egress from the appliance user. AppArmor cannot distinguish inbound accept from outbound connect on inet sockets — stated, not papered over |
| Evidence can't be silently created by UI clicks | enrichment happens only in the collector and is recorded as observations; the API serves stored evidence only |

Two honest limitations worth knowing before deployment:
- **Rootless egress is per-user, not per-container.** The nftables rules
  constrain the *appliance user*; run Tidepool under a dedicated account so
  "the user's egress" and "the collector's egress" are the same statement.
- **Replica-served package listings carry no description text** — package
  descriptions are not part of normalized index records, so the read model
  reconstructed from published truth omits them (versions, drift,
  advisories, components are all present). Advisory rows reconstructed from
  the corpus carry no click-through URL.

## Host layout (`$TIDEPOOL_HOME`, default `~/.local/share/tidepool`)

```
config/      tidepool.config.json        — ONE validated document: sources,
                                           scheduler cadence, maintenance policy
keyrings/    archive trust anchors (ro into the collector only)
corpus/      writer/tidepool.sqlite3     — authoritative DB (collector only)
             objects/, snapshots/, exports/, locks/
cache/       collector-PRIVATE TTL cache — deleting it changes nothing the
                                           API serves (verified in CI)
published/   tidepool-read.sqlite3 + publication.json — atomic publications
run/         collector-control.sock, api.sock, scheduler-heartbeat.json
backups/     verified backup bundles
exports/     image digests, boundary reports, retention audits
bin/         backup.sh restore.sh verify.sh boundaries-verify.sh
```

## Install

```bash
./deploy/scripts/install.sh              # builds (digest-pinned base,
                                         # immutable tags), renders units,
                                         # installs, prints the root steps
```

Then perform the printed root steps: load the seven AppArmor profiles,
adapt and load `deploy/nftables/tidepool.nft`, copy keyrings, review the
rendered units in `~/.config/containers/systemd/`, and start:

```bash
systemctl --user start tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler
systemctl --user enable tidepool-backup.timer tidepool-verify.timer
loginctl enable-linger $USER
```

The listener defaults to `127.0.0.1:8747`. For a trusted LAN:
`LISTEN_ADDR=192.168.1.20 ./deploy/scripts/install.sh` — and mirror the
subnet into the nftables `lan_clients` define. TLS/mTLS or reverse-proxy
authentication can front the proxy port; the API itself remains
read-oriented either way.

## Operating

```bash
# administration goes through the control socket, never the web API
npm run admin health
npm run admin sync-all
npm run admin snapshot interpretive 168
npm run admin enrich distro ubuntu-24.04 openssl   # bounded, recorded
npm run admin publish

~/.local/share/tidepool/bin/verify.sh              # positive checks
~/.local/share/tidepool/bin/boundaries-verify.sh   # negative checks (JSON: --json out.json)

npm run retention plan                             # dry-run reachability report
npm run retention apply                            # requires config opt-in AND a <24h verified backup
```

The scheduler reads `config.scheduler` (`collectionInterval`, `snapshotInterval`,
`verificationInterval`, `enrichmentInterval` — durations like `"6h"`) and
`config.maintenance` (replica publication policy, enrichment policy, backup
retention). Environment variables carry deployment wiring only (paths,
socket locations, provenance identity).

Backups run daily via `tidepool-backup.timer`: consistent SQLite copy →
bundle → checksum + dry-run-import verification → success marker. A backup
that fails verification deletes itself and fails the unit. Restore
(`bin/restore.sh <bundle>`) refuses to run while the collector is active,
dry-runs first, imports transactionally, verifies the corpus, and publishes
a fresh replica so the API serves restored truth immediately.

## Verification

`verify.sh` — positive: units active, containers healthy, proxy answers,
collector publishes no port, replica digest matches `publication.json`,
corpus + snapshots structurally verify (in a confined utility container).

`boundaries-verify.sh` — negative: ~20 prohibited operations attempted for
real (write the writer, open the authoritative DB, reach the Internet from
the API/scheduler/dispatch, exec a shell everywhere, read keyrings/cache,
symlink-escape a project mount, trigger collection through the API…), each
tagged with the enforcement layer under test. Success of any prohibited
operation is an incident, and exits non-zero. `--json` emits the
machine-readable report the weekly `tidepool-verify.timer` archives.

CI (`.github/workflows/deploy.yml`) runs the full 18-step
`ci-deploy-test.sh` on every deployment-affecting change and weekly: build →
pin check → profile compile → shellcheck → render+validate → start the real
topology → bounded live collection → publication → replica-served reads →
positive + negative suites → snapshot → offline dispatch → verified backup →
clean-corpus restore → snapshot digest comparison → clean stop.

## Updating

```bash
git pull && ./deploy/scripts/install.sh   # new immutable tag, re-rendered units
systemctl --user daemon-reload
systemctl --user restart tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler
~/.local/share/tidepool/bin/verify.sh && ~/.local/share/tidepool/bin/boundaries-verify.sh
```

Old image tags remain until pruned (`podman image prune`), so rollback is
`systemctl --user stop …`, re-render with the previous `IMAGE_TAG`, start.
Take a backup before updating (or enable the `ExecStartPre=` line in the
collector unit to make that automatic).
