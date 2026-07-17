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
| API cannot reach the Internet | `Network=none` — no network namespace exists |
| Scheduler cannot reach the Internet | `Network=none` |
| Dispatch cannot reach the Internet | `--network=none` per job |
| API cannot touch the authoritative DB | writer directory absent from its mount namespace **and** its only DB connection is `SQLITE_OPEN_READONLY` against the replica |
| API cannot write published/objects/snapshots | `:ro` mounts |
| Collector accepts no inbound TCP | no `PublishPort` in its unit (verified: `podman port` empty) — its control surface is a Unix socket, mode 0660 |
| Proxy holds no data | only `run/`, `config/`, and `tls/server/` exist in its mount namespace |
| Only declared HTTP requests reach the API | proxy admission gate: deny-by-default route manifest, method/body/query/framing checks (`shared/httpPolicy.ts`) — anything unlisted is 404/405, mutation verbs never appear |
| HTTP mutation is impossible in appliance mode | the manifest omits mutation routes **and** the API independently 405s every non-GET/HEAD (defense in depth) |
| Proxy never holds the CA private key | only `tls/server/` (cert+key+chain) is mounted; `tls/ca/` is not — `boundaries-verify.sh` and `tls verify` both assert it |
| TLS is modern | proxy sets `minVersion: TLSv1.2`; the http-security job asserts TLS 1.0/1.1 rejected, 1.2/1.3 accepted |
| Collection can't be triggered from the API | the API has no route to the control socket in code, and answers 405; control requires filesystem access to the socket (admin CLI or scheduler) |
| Evidence can't be silently created by UI clicks | enrichment happens only in the collector and is recorded as observations; the API serves stored evidence only |

Claims the default deployment does NOT make (they require the optional
hardening below): "only node may execute inside a container" (was
AppArmor-only; a shell inside a container still executes — the walls around
that shell are the mount matrix, `Network=none`, and keep-id), and
"collector egress is limited to DNS+443" (host nftables; without it,
collector egress is ordinary user traffic).

## Optional hardening — and why these layers matter

Two enforcement layers ship in this repository but are NOT part of the
default rootless deployment. They are not decoration; each closes a class
the core layers do not:

**AppArmor (`deploy/apparmor/`)** is the only layer that constrains
*syscalls by program*, independent of namespaces and mounts: it is what
turned "the API has no network namespace" into "the API cannot open an
inet socket even if a unit regression restored one", and it is the sole
enforcement behind "only node executes". It cannot be applied here because
rootless podman categorically refuses custom profiles — every current
version short-circuits on rootlessness before consulting the kernel (ADR
0011 has the source citation). The kernel itself permits unprivileged
entry into a pre-loaded profile (`aa-exec -p tidepool-api -- true` proves
it); the refusal is podman policy, not physics. The profiles bind under a
rootful deployment, and outside-in confinement (systemd
`AppArmorProfile=` / an `aa-exec` wrapper, with wrapper profiles that also
account for podman and pasta) is a plausible but UNVERIFIED path.

**nftables (`deploy/nftables/tidepool.nft.in`, rendered by the install)**
is the only egress control the collector has: rootless container traffic
is ordinary user-level traffic at the host, so without these rules a
compromised collector may connect anywhere, not just to DNS and 443.
The layer works fine — root loads it; podman is never involved — but it
constrains the *entire uid*, so applied to a login account it will confine
your shell, your package manager, and your day. Deploy Tidepool under a
dedicated user account, then edit the three site values (uid, resolvers,
LAN subnet) in the rendered file and `sudo nft -f` it. On a hostile
network, treat this layer as required in fact even though the install no
longer requires it in form.

If you apply either layer: `verify-apparmor.sh` (standalone) checks
profiles are loaded, `verify-render.sh` parse-checks both artifact sets on
every change so they cannot rot, and `boundaries-verify.sh` asserts the
exec restriction only when a container is actually confined.

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

Why a per-user folder and not `/var/lib`: the appliance is **rootless end
to end** — per-user Podman image storage, user-level systemd units, per-user
subuid mappings — so the data root is the *appliance user's* XDG data dir,
owned and operated without a privileged installer. `/var/lib/tidepool`
exists only as the fixed **in-container** mount target, deliberately
decoupled from wherever the host keeps the data. Run Tidepool under a
dedicated unprivileged account (the nftables policy already assumes one);
every script that touches the data root refuses to run as root, because a
sudo'd invocation would silently resolve `~` to `/root` and build a
parallel tree (`TIDEPOOL_ALLOW_ROOT=1` plus an explicit `TIDEPOOL_HOME`
exists for deliberate root-managed layouts).

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

## One place for shared configurables: `deploy/deploy.yaml`

Every value that more than one file must agree on — base image tag, host
listener address/port, container-internal port, in-container uid/gid,
default data root — lives in `deploy/deploy.yaml` and nowhere else. The
renderer, installer, base-pinner, operator scripts, and the CI test all
load it via `deploy/scripts/lib/deploy-config.sh` (a flat `key: value`
parser; no yq/python needed), with the precedence:

```
environment variable  >  deploy.yaml  >  built-in fallback
```

so `LISTEN_PORT=9000 ./deploy/scripts/install.sh` still works for one-off
runs, and a missing deploy.yaml degrades to the historical defaults.

TypeScript consumes the same file at **compile time only**:
`scripts/generate-deploy-config.mjs` runs before `tsc` (wired into
`build:server`) and bakes the values into the committed
`shared/deployConfig.generated.ts` — the running services hold them as
static consts in compiled JS and never open deploy.yaml. Both parsers
implement the identical flat `key: value` contract, and CI's
`--check` step fails the build if the generated module and the YAML
disagree. The shell scripts' reads happen when *those scripts* run
(render, install, backup — operator actions), not in any long-running
service.
`install.sh` copies the file (and the loader) into `$TIDEPOOL_HOME/bin/`,
so installed backup/restore/verify tooling reads the same values the units
were rendered from. The host firewall is rendered from
`deploy/nftables/tidepool.nft.in` with the same port, then hand-edited for
the three genuinely site-specific defines (uid, resolvers, LAN subnet).

Deliberately **not** in this file: application behavior
(`tidepool.config.json`, validated), the release version (`package.json`),
and per-service resource limits (each appears exactly once, in its unit
template — no agreement problem to solve).

## Service roles at a glance

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

## Images and build discipline

All five images come from one multi-target Containerfile,
`deploy/oci/Containerfile` (targets: `collector`, `api`, `scheduler`,
`proxy`, `utility` — the last carries the CLIs for dispatch, corpus
export/import, and verification jobs). `install.sh` drives the build, but
it is ordinary `podman build`:

```sh
BASE=$(deploy/scripts/pin-base.sh)          # resolves the node:24-bookworm-slim
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
[Configuration](../docs/CONFIGURATION.md)); the build reads it through the same
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

## Runtime units

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
layers; `git` and Node 24 to build and to run the admin CLI from the
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

## Install

```bash
./deploy/scripts/install.sh              # builds (digest-pinned base,
                                         # immutable tags), renders units,
                                         # installs, prints the root steps
```

Then perform the printed root steps: load the seven AppArmor profiles,
adapt and load the rendered `deploy/quadlet/rendered/tidepool.nft`, copy keyrings, review the
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

### Rootless build warnings (`can't raise ambient capability CAP_…`)

Seeing a block of `can't raise ambient capability CAP_CHOWN … operation not
permitted` warnings during `podman build` means the build process could not
assume the container's default capability set. Two causes, one of which
matters:

- **Missing subordinate uid/gid ranges** (`/etc/subuid` has no entry for
  your user, or `newuidmap`/`newgidmap` aren't installed): Podman falls back
  to a single-uid user namespace with no in-namespace root. The Tidepool
  images build anyway — nothing in them installs file capabilities or
  foreign-uid files (`gpgv` is the only added package) — **but the runtime
  will not start**, because every unit's `UserNS=keep-id:uid=10001` needs a
  real range. Fix before starting services:

  ```sh
  sudo apt install uidmap
  sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
  podman system migrate
  ```

  Diagnose with `podman unshare cat /proc/self/uid_map` — one line mapping
  only your uid means this case.

- **Nested/chroot-isolation builds** (building inside another container or
  a restricted environment): cosmetic for this image set.

Either way, verify the layer that triggered the warnings rather than
trusting it: `podman run --rm localhost/tidepool-collector:<tag> gpgv
--version` — and the first live collection re-proves gpgv end-to-end as a
per-pocket verification status.

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

## HTTP admission and self-managed TLS

The proxy is the appliance's sole TCP endpoint and its HTTP admission gate.
It owns exactly one layer of the stack:

```
host firewall / netns   who can reach the port        (not the proxy)
AppArmor / mounts       process + filesystem authority (not the proxy)
>>> proxy: HTTP admission — is this a valid Tidepool request?
API over Unix socket    application semantics          (downstream)
```

The proxy makes **no claim about packets** — the firewall and network
namespaces remain the source of truth for reachability. The proxy decides,
for a connection that already arrived, whether it is a structurally and
semantically valid request: it terminates TLS, checks framing, matches the
request against a versioned deny-by-default route manifest
(`shared/httpPolicy.ts`), strips client forwarding headers, sets security
headers, and forwards only admitted GET/HEAD requests to the API's Unix
socket. Administration is never on this surface — mutation verbs return
405, and collection/enrichment stay on the control socket.

What the gate rejects (each with a stable, non-disclosing error body):
unknown routes (404), disallowed methods (405), request bodies on read
routes (413), unknown/duplicate/oversized query parameters (400/414),
duplicate `Host`/`Content-Length`, `Content-Length`+`Transfer-Encoding`,
obsolete line folding, control characters, path traversal, and malformed
percent-encoding (400, connection closed on framing ambiguity). Responses
carry a strict CSP (`default-src 'none'`), `nosniff`, `X-Frame-Options:
DENY`, no `Server`/`X-Powered-By`, and per-route caching (immutable for
hashed assets and content-addressed snapshots, `no-store` for current
state). CORS is disabled by default.

### TLS setup

TLS is self-managed: a Tidepool-owned local CA issues short-lived server
certificates. The CA private key lives host-side under
`$TIDEPOOL_HOME/tls/ca/` at 0600 and is **never mounted into the proxy** —
the proxy receives only `tls/server/` (cert + key + chain).

```sh
npm run tls init                      # create the local CA + server cert
npm run tls inspect                   # subject/issuer/SAN/serial/fingerprint/expiry
npm run tls verify                    # key/cert match, chain, SAN, expiry, perms,
                                      # and CA-key-absence-from-server-dir
npm run tls export-ca > tidepool-ca.crt   # the CA CERTIFICATE only, for clients
npm run tls renew                     # reissue the server cert (atomic swap),
                                      # then: systemctl --user restart tidepool-proxy
```

Certificate modes (`http.tls.mode`): `generated-local-ca` (default for
LAN — one CA to trust on clients), `generated-self-signed` (testing; each
client trusts the leaf), `provided` (mount an externally managed cert), and
`disabled` (plaintext — dev only). Keys default to ECDSA P-256 (Ed25519 and
RSA-3072 are selectable); server lifetime defaults to 120 days, the CA to
four years.

**Installing the CA on LAN clients** (Tidepool never touches client trust
stores — you export, you choose where to trust):

- Debian/Ubuntu: `sudo cp tidepool-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`
- Fedora: `sudo cp tidepool-ca.crt /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust`
- Alpine: `sudo cp tidepool-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`
- Firefox: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import
- Chromium: Settings → Privacy and security → Security → Manage certificates → Authorities → Import
- CLI tools: point at the file, e.g. `curl --cacert tidepool-ca.crt https://tidepool.home.arpa:8747/`

### Health endpoints

The proxy answers `/health/live` (process up) and `/health/ready`
(published replica present + API socket reachable) itself — these are never
forwarded. `/healthz` and `/api/*` are forwarded to the API.

## Verification

`verify.sh` — positive checks, now an orchestrator over independently
runnable pieces (each prints PASS/FAIL/SKIP and exits non-zero on FAIL):

| Script | Checks |
|---|---|
| `verify-host.sh` | rootless podman present and functional |
| `verify-install.sh` | host layout exists; corpus not world-readable |
| `verify-apparmor.sh` | (standalone, optional hardening) profiles loaded |
| `verify-deployment.sh` | units active, containers healthy, proxy answers, collector publishes no port, replica digest matches `publication.json` |
| `verify-corpus.sh` | corpus + snapshots structurally verify (in a confined utility container, query-only) |
| `verify-render.sh` | STRUCTURAL, needs no install: templates render with zero placeholders and no `:latest`, quadlet dry-run, rendered `tidepool.nft` passes `nft -c`, every AppArmor profile parses (`apparmor_parser -Q`) |

`verify.sh` runs the first five in order; `verify-render.sh` is the
preflight/CI piece and is not part of the live sequence.

Privilege note: `nft -c` needs CAP_NET_ADMIN even as a pure check, so
`verify-render.sh` and `render.sh` re-run only the two read-only,
fixed-argv kernel-facing checks (`nft -c`, `apparmor_parser -Q`) through
non-interactive `sudo -n` when an unprivileged run fails. This exercises a
passwordless grant the invoking user already holds — it never prompts and
grants nothing new. Escalated checks are marked `(via sudo)` in output,
and `TIDEPOOL_VERIFY_NO_SUDO=1` disables escalation (permission-blocked
checks then SKIP with a stated reason rather than reporting a result).

`boundaries-verify.sh` — negative: ~20 prohibited operations attempted for
real (write the writer, open the authoritative DB, reach the Internet from
the API/scheduler/dispatch, exec a shell everywhere, read keyrings/cache,
symlink-escape a project mount, trigger collection through the API…), each
tagged with the enforcement layer under test. Success of any prohibited
operation is an incident, and exits non-zero. `--json` emits the
machine-readable report the weekly `tidepool-verify.timer` archives.

CI covers this in two tiers. `structure.yml` is the slim per-change gate:
generated-config drift, lock drift, and `verify-render.sh` (render,
nftables, AppArmor parse) — no image builds, so it runs on every relevant
PR in minutes. `deploy.yml` is the heavy integrated tier (weekly and
on-demand): real image builds against `deploy/scripts/ci-topology.sh`,
**no npm/compilers in any runtime image** (`verify-image-contents.sh`),
one live topology session for the negative boundary suite, backup →
clean-corpus restore → verify, and API availability with the collector
stopped. `http-security.yml` is a focused gate: it generates a temporary local CA,
starts the API and HTTPS proxy, and runs the admission matrix, security
headers, TLS version policy, raw-socket smuggling-style framing tests, and
CA-private-key confinement (`deploy/scripts/http-security-test.sh`, runnable
locally). The 19-step `ci-deploy-test.sh`
scenario inside `deploy.yml` also covers snapshot creation, offline
dispatch, and the restore-then-compare-snapshot-digests round trip.

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

## Removal

`deploy/scripts/uninstall.sh` backtracks the install with the same stance
install.sh takes: unprivileged removals performed (services, timers, unit
files, containers, images, installed tooling), root removals printed
(AppArmor profiles, the nftables table, any ufw rule, linger). The data
root — corpus, backups, config, keyrings, exports — is **preserved by
default**; `--purge-data` deletes it after a typed-path confirmation
(`TIDEPOOL_UNINSTALL_FORCE=1` for non-interactive use), and `--keep-images`
retains the built images. The script is idempotent: re-running it reports
what is already absent and exits cleanly.
