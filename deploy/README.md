# Deploying Tidepool as a hardened observation appliance

This directory turns Tidepool into a reproducible, minimally privileged,
self-contained upstream observation appliance: rootless Podman, Quadlet
units under the user's systemd, and a dedicated AppArmor profile per
service. Containerization here *reinforces* the architecture the codebase
already enforces in module boundaries — it does not become part of it: the
application never knows it is containerized, and the single-process
development mode (`npm start`) is unchanged.

The same deployment works on personal infrastructure, home labs,
workstations, build servers, and isolated or air-gapped collection nodes
(everything is local images + local state; only the collector ever needs a
route to the configured upstreams, and even that can be absent — sources
fail closed and are reported per-source, never hidden).

## Service boundaries

```
                       the Tidepool pod (one shared network namespace)
   ┌────────────────────────────────────────────────────────────────────────┐
   │                                                                        │
   │   ┌───────────────┐  POST /internal/…   ┌──────────────────────────┐   │
   │   │   scheduler    │────────────────────▶│        collector         │───┼──▶ upstream
   │   │  (triggers,    │   127.0.0.1:8748    │  fetch · gpgv-verify ·   │   │    HTTPS/DNS
   │   │   no data)     │   (pod-internal)    │  normalize · observe ·   │   │    (only
   │   └───────────────┘                      │  snapshot                │   │    egress in
   │                                          │  ── the ONLY writer ──   │   │    the pod)
   │   ┌───────────────┐  proxy: sync/enrich/ └───────────┬──────────────┘   │
   │   │      api       │  snapshot creation              │ writes           │
   │   │  reads only:   │─────────────────────────────────┘                  │
   │   │  query-only    │                    ┌──────────────────────────┐    │
   │   │  SQLite conn   │◀───── reads ───────│   /var/lib/tidepool/     │    │
   │   └───────┬────────┘                    │   corpus  (bind mount)   │    │
   │           │ :8747                       └──────────────────────────┘    │
   └───────────┼─────────────────────────────────────────────────────────────┘
               ▼
      127.0.0.1:8747 on the host — the pod's single published port

   ad hoc, outside the pod, --network=none:
      tidepool-utility  →  dispatch (snapshot × /project:ro), corpus
                           export/import/status, backup/restore/verify
```

Collection, storage, snapshot generation, dispatch analysis, and
presentation stay strictly separated; every service is independently
restartable; cross-service interaction is message passing over the pod
loopback or the corpus filesystem boundary — never shared process state.

| service   | image                | network                          | corpus | config | keyrings | port published |
|-----------|----------------------|----------------------------------|--------|--------|----------|----------------|
| collector | tidepool-collector   | outbound HTTPS/DNS; :8748 pod-internal | rw (the writer) | ro | ro | none |
| api       | tidepool-api         | :8747 inbound; fixed pod-loopback dial to collector | rw mount, **query-only connection** | ro | —  | 8747 |
| scheduler | tidepool-scheduler   | pod-loopback dial to collector only | —   | ro | —  | none |
| utility   | tidepool-utility     | `--network=none`                  | rw (ad hoc) | — | — | none |

The API's evidence-immutability guarantee is enforced by SQLite itself:
its connection is latched with `PRAGMA query_only = ON` at open, so every
write is rejected by the database engine (covered by
`deploy/scripts/verify.sh` and the code path is exercised in the repo's
split-mode smoke). WAL readers must map the `-shm` file, which is why the
*mount* is rw while the *connection* is not — this is documented in the
AppArmor profile rather than hidden.

## Filesystem layout

Host side (rootless-appropriate; override the base with `TIDEPOOL_HOME`):

```
~/.local/share/tidepool/
├── config/tidepool.config.json    read-only into every container
├── keyrings/                      distro archive keyrings, read-only
├── corpus/                        durable evidence — the collector's tree
│   ├── tidepool.sqlite3           observations, changes, snapshot manifests
│   ├── objects/sha256/            content-addressed artifacts & record sets
│   ├── snapshots/<digest>.json    bounded-truth documents
│   ├── exports/                   corpus bundles / dispatch artifacts
│   ├── cache/                     TTL'd response cache (disposable)
│   └── locks/
├── backups/<stamp>/               corpus bundle + config + SHA256SUMS
└── bin/backup.sh                  installed copy for ExecStartPre use
```

Inside every container the same tree appears at `/var/lib/tidepool/…`, so
host paths, container paths, AppArmor rules, and this document all read
identically. Configuration is mounted read-only *and* profile-denied for
writing; the corpus is durable state owned by the collector; exports are
externally consumable; the cache is disposable acceleration data that lives
under the corpus mount but survives no contract (deleting it costs one
re-sync). Logs are **not** files in this layout: every service emits one
JSON object per line to stdout/stderr, and journald owns storage and
rotation per unit (`journalctl --user -u tidepool-collector`), keeping logs
fully separated from evidence.

## Installation

Prerequisites: Podman ≥ 4.4 (Quadlet), a systemd user session, and — for
the hardening layer — an AppArmor-enabled kernel (Debian/Ubuntu default).

```sh
git clone https://github.com/volt317/Tidepool && cd Tidepool
./deploy/scripts/install.sh              # layout, keyrings, images, quadlets
sudo ./deploy/scripts/install.sh apparmor  # kernel profile load (root-only step)
$EDITOR ~/.local/share/tidepool/config/tidepool.config.json
#   → point distro keyrings at /var/lib/tidepool/keyrings/<file>
systemctl --user start tidepool-pod
loginctl enable-linger $USER             # keep running after logout / at boot
./deploy/scripts/verify.sh
```

`install.sh` is idempotent and never touches an existing config or corpus.
Images build locally from source in a multi-stage Containerfile
(`deploy/oci/Containerfile`) — the appliance's provenance is your checkout,
which also makes air-gapped installs a matter of `podman save`/`podman load`.

Rootless is the only supported mode: no daemon, no privileged containers,
user namespaces throughout (`UserNS=keep-id` maps the in-image UID 10001
back to your own user, so everything on disk stays owned and auditable by
the operator).

## Service startup, shutdown, health

```sh
systemctl --user start|stop|status tidepool-pod        # the whole appliance
systemctl --user restart tidepool-api                  # any service alone
journalctl --user -u tidepool-collector -f             # structured JSON logs
curl -s localhost:8747/healthz | jq                    # api health
podman exec tidepool-collector node -e "fetch('http://127.0.0.1:8748/healthz').then(r=>r.text()).then(console.log)"
```

Each service exposes a machine-readable `/healthz` that Quadlet's
`HealthCmd` polls: the collector reports last successful collection,
in-flight syncs, and failed sources; the API reports SQLite availability,
snapshot-store reachability, and probe latency; the scheduler reports every
job's last/next run and last error. All units restart on failure.

Shutdown is graceful by construction: on SIGTERM the collector stops
accepting control requests, waits (bounded, under the unit's
`StopTimeout=70`) for in-flight observations so none is half-recorded, then
closes the SQLite writer — no interrupted transactions. The API and
scheduler drain their listeners the same way.

Startup fails safely: every service validates its configuration before
serving; the collector additionally refuses to start if `gpgv` or all
configured keyrings are missing while signature verification is configured,
if the corpus/cache mounts aren't writable, or if SQLite reports integrity
corruption. The API *verifies* (never applies) the migration ledger — if the
schema is behind or a migration file's digest has drifted, it exits with the
reason and systemd retries until the collector (the writer, and the only
process that migrates) has brought the schema up to date. That ordering is
also expressed in the units (`After=tidepool-collector.service`).

## AppArmor

One profile per service under `deploy/apparmor/`, each heavily commented so
every granted permission carries its justification. Common posture: only
`node` (plus `gpgv`, collector only) may execute; shells and package
managers are denied by name; `deny capability`, `deny mount/umount/
pivot_root`, `deny ptrace`, no raw/packet sockets, no kernel interfaces
(`/proc/sys` writes, `/sys` writes, `/proc/kcore`, `/dev/mem`); filesystem
access enumerates exactly the mounted trees with config/keyrings/code
write-denied even though their mounts are already read-only (defense in
depth). Signals are restricted to lifecycle delivery from the runtime and
intra-profile send/receive.

Profiles are loaded by root (`sudo ./deploy/scripts/install.sh apparmor`);
the rootless containers are then confined via
`--security-opt apparmor=<profile>` in the Quadlet units. Complain-mode
variants for development are generated by `deploy/apparmor/complain.sh`
(identical rules, violations logged instead of denied).

Honest limits, so audits don't assume more than is enforced: AppArmor
cannot distinguish inbound from outbound TCP, so "API/scheduler make no
Internet connections" is guaranteed by the absence of any such code path
and by the pod publishing nothing but :8747 — administrators wanting a
kernel-hard egress boundary can add per-user nftables rules or run the pod
on an internal `tidepool.network` with a filtering gateway. The dispatch
profile *does* deny the network entirely (`deny network,` +
`--network=none`), because offline evaluation is the design.

## Networking policy

The pod publishes exactly one port, and on loopback by default
(`PublishPort=127.0.0.1:8747:8747` — widening it, or fronting it with a
reverse proxy, is an explicit edit to `tidepool.pod`). The collector's
control surface and the scheduler's health port bind the pod-internal
loopback and are unreachable from the host — `verify.sh` asserts this.
Host networking is never used; rootless pod networking (pasta/slirp4netns)
carries the collector's outbound HTTPS and DNS. Egress destinations are
exactly the URLs in the validated configuration; the config validator
rejects non-HTTPS schemes.

## SQLite as durable evidence

Already in the codebase and relied on here: WAL journaling with
`synchronous=NORMAL`, foreign keys enforced, transactional migrations
recorded in a digest-checked ledger (a drifted migration file refuses to
run), `busy_timeout` for the reader/writer coexistence, and startup
integrity verification (`verifyCorpus`) in the collector. The deployment
adds: exactly one writer process by construction, a query-only reader for
the API, graceful drain before the writer closes, and consistent backups
via the SQLite backup API — never a raw copy of a live WAL database.

## Backups, restore, updates, rollback

```sh
./deploy/scripts/backup.sh     # consistent bundle + config → backups/<stamp>/
./deploy/scripts/restore.sh backups/<stamp>/corpus-<stamp>.tar.zst
```

Backups run against the live pod (WAL permits the backup reader). Restore
refuses to run while the collector is active, checks the bundle's
SHA256SUMS, then performs the importer's `--dry-run` verification pass
(checksums + schema compatibility, nothing written) before the real import.

Updating is a rolling rebuild:

```sh
./deploy/scripts/backup.sh                       # 1. backup first — always
git pull && ./deploy/scripts/install.sh          # 2. rebuild images, refresh units
systemctl --user restart tidepool-collector      # 3. writer first (migrates
                                                 #    transactionally on start)
systemctl --user restart tidepool-api tidepool-scheduler
./deploy/scripts/verify.sh                       # 4. validate
```

The collector completes in-flight observations before the old container
exits; snapshots are content-addressed and written atomically, so none can
become partially generated; migrations either commit or roll back. To make
the pre-migration backup automatic, uncomment `ExecStartPre` in
`tidepool-collector.container`.

Rollback: `systemctl --user stop tidepool-pod`, check out the previous tag
and re-run `install.sh` (or `podman tag` a kept previous image back to
`:latest`), restore the pre-update backup if a newer schema was already
applied (`restore.sh`), start the pod, `verify.sh`. Schema migrations are
forward-only; the backup taken in step 1 is the rollback path for state.

## Resource limits

Conservative defaults live in the Quadlet units as `PodmanArgs` (memory,
cpus, pids-limit, nofile) — collector 1g/2cpu/256pids, API
512m/1cpu/128pids, scheduler 128m/0.5cpu/64pids — plus size-capped
`noexec,nosuid` tmpfs for the only temporary storage. Administrators
override by editing the unit (or a systemd drop-in) and
`systemctl --user daemon-reload`.

## Verification

`deploy/scripts/verify.sh` is CI-suitable (PASS/FAIL lines, non-zero exit on
any failure) and covers the required checks: rootless Podman functional;
bind-mount layout and permissions; all four AppArmor profiles loaded; units
active and containers healthy; the API answering on the published port and
the collector *not* reachable from the host; and — inside an ad-hoc,
network-less, dispatch-confined utility container over a query-only
connection — full corpus structural verification plus re-validation of
every stored snapshot against its content digest.

## Dispatch (evaluating local projects safely)

```sh
podman run --rm --network=none \
  --security-opt apparmor=tidepool-dispatch \
  --userns=keep-id:uid=10001,gid=10001 \
  -v ~/.local/share/tidepool/corpus:/var/lib/tidepool/corpus:rw \
  -v /path/to/project:/project:ro \
  localhost/tidepool-utility \
  node server/dist/server/src/cli/dispatch.js --snapshot latest \
    --store /var/lib/tidepool/corpus \
    --out /var/lib/tidepool/corpus/exports/dispatch.json /project
```

The project is mounted read-only and additionally write-denied by the
profile; the container has no network; exit code 3 still signals
security-review findings for pipeline use. This is the "future dispatch
worker" seam from the design: today an ad-hoc container, and the same
image/profile pair becomes a queue-driven service without touching the
other three.

## Security assumptions (audit summary)

Trust anchors are the host-provided keyrings and the TLS trust store baked
into the base image; the collector treats every upstream byte as untrusted
input and fails closed per source. The threat model assumes the API is the
first target (it faces the network): its worst case is bounded to reading
the corpus it already serves, because SQLite rejects its writes, the
profile denies config/keyring/code access, and it holds no upstream
credentials. The collector's worst case (malicious upstream exploiting a
parser) is bounded to the corpus tree and outbound sockets. The scheduler
holds no data at all. Images are immutable; containers run read-only with
all capabilities dropped, `NoNewPrivileges`, no host PID/IPC/network
namespaces, no devices, as a fixed unprivileged user inside a user
namespace. Every privilege that *is* granted is written down next to its
justification — in the Quadlet units and the AppArmor profiles.

## Troubleshooting

The API loops with "migration … has not been applied": expected ordering —
the collector migrates on start; check
`journalctl --user -u tidepool-collector`. The collector exits citing
keyrings/gpgv: stage keyrings into `~/.local/share/tidepool/keyrings/` and
point the config's `index.keyrings` at `/var/lib/tidepool/keyrings/<file>`,
or set `verifySignatures:false` for that distro (it will be recorded as an
unverified source, never silently trusted). AppArmor denials: run
`deploy/apparmor/complain.sh`, load the complain variant, reproduce, read
`journalctl -k | grep apparmor`, then return to enforce. Sync returns 503
via the API: the collector is down — reads keep working by design; check
its unit. Ports already bound: another pod instance or a dev `npm start`
holds 8747/8748.
