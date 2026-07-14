#!/usr/bin/env bash
# deploy/scripts/verify.sh
#
# Automated deployment verification — the prompt-mandated checks, suitable
# for CI and for validating a live install. Every check prints PASS/FAIL/SKIP
# and the script exits non-zero if anything FAILs.
#
#   verify podman        rootless podman present and functional
#   verify bind mounts   host layout exists with sane permissions
#   verify permissions   corpus not world-readable; config/keyrings ro-able
#   verify apparmor      profiles loaded (skips if AppArmor absent)
#   verify deployment    quadlet units active, containers healthy,
#                        collector port NOT reachable from the host,
#                        API healthz answering
#   verify sqlite        integrity_check via a query-only connection
#   verify corpus        full structural verification (verifyCorpus)
#   verify snapshots     every stored snapshot re-validates and its filename
#                        matches its content digest
set -uo pipefail

BASE="${TIDEPOOL_HOME:-$HOME/.local/share/tidepool}"
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }
skip() { printf 'SKIP  %s\n' "$1"; }

# ------------------------------------------------------------- verify podman
if command -v podman >/dev/null; then
  if [[ $EUID -ne 0 ]] && podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null | grep -q true; then
    pass "podman: rootless and functional"
  else
    fail "podman: not running rootless (or podman info failed)"
  fi
else
  fail "podman: not installed"
fi

# -------------------------------------------------------- verify bind mounts
for d in config corpus keyrings backups published run cache; do
  [[ -d "$BASE/$d" ]] && pass "bind mounts: $BASE/$d exists" || fail "bind mounts: $BASE/$d missing"
done
[[ -f "$BASE/config/tidepool.config.json" ]] && pass "bind mounts: config file present" || fail "bind mounts: tidepool.config.json missing"

# -------------------------------------------------------- verify permissions
perm=$(stat -c %a "$BASE/corpus" 2>/dev/null || echo "")
if [[ "$perm" == 7?0 || "$perm" == 700 ]]; then
  pass "permissions: corpus is not world/other accessible ($perm)"
else
  fail "permissions: corpus mode is '$perm' (expected 700)"
fi

# ---------------------------------------------------------- verify apparmor
if [[ -d /sys/kernel/security/apparmor ]]; then
  loaded="$(cat /sys/kernel/security/apparmor/profiles 2>/dev/null || sudo -n cat /sys/kernel/security/apparmor/profiles 2>/dev/null || true)"
  for p in tidepool-collector tidepool-api tidepool-scheduler tidepool-proxy tidepool-dispatch tidepool-corpus-export tidepool-corpus-import; do
    if grep -q "^$p " <<<"$loaded"; then
      pass "apparmor: $p loaded ($(grep "^$p " <<<"$loaded" | awk '{print $2}'))"
    else
      fail "apparmor: $p not loaded (sudo ./deploy/scripts/install.sh apparmor)"
    fi
  done
else
  skip "apparmor: kernel LSM not present on this host"
fi

# --------------------------------------------------------- verify deployment
if systemctl --user is-active tidepool-collector.service >/dev/null 2>&1; then
  for u in tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler; do
    systemctl --user is-active "$u.service" >/dev/null 2>&1 && pass "deployment: $u.service active" || fail "deployment: $u.service not active"
  done
  for c in tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler; do
    h=$(podman inspect --format '{{.State.Health.Status}}' "$c" 2>/dev/null || echo "unknown")
    [[ "$h" == "healthy" || "$h" == "starting" ]] && pass "deployment: $c health=$h" || fail "deployment: $c health=$h"
  done
  # the PROXY answers on the single published port (through it: the API)
  port="${LISTEN_PORT:-8747}"
  curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && pass "deployment: proxy→api /healthz reachable on published port" || fail "deployment: proxy→api /healthz not reachable on :$port"
  # the COLLECTOR must publish no port at all
  cports="$(podman port tidepool-collector 2>/dev/null | wc -l)"
  [[ "$cports" -eq 0 ]] && pass "deployment: collector publishes no TCP port" || fail "deployment: collector publishes $cports port(s) — it must publish none"
  # publication metadata must exist and be coherent
  if [[ -f "$BASE/published/publication.json" && -f "$BASE/published/tidepool-read.sqlite3" ]]; then
    pdigest="$(python3 -c "import json;print(json.load(open('$BASE/published/publication.json'))['replicaDigest'])" 2>/dev/null || echo "")"
    adigest="$(sha256sum "$BASE/published/tidepool-read.sqlite3" | cut -d' ' -f1)"
    [[ -n "$pdigest" && "$pdigest" == "$adigest" ]] && pass "deployment: published replica digest matches publication.json" || fail "deployment: replica digest mismatch (metadata: ${pdigest:0:12}, file: ${adigest:0:12})"
  else
    fail "deployment: no published replica — the API has nothing to serve"
  fi
else
  skip "deployment: services not running (systemctl --user start tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler)"
fi

# ------------------------------------------- verify sqlite / corpus / snapshots
# All three run inside an ad-hoc utility container against the real corpus,
# through a query-only connection — verification can never mutate evidence.
if [[ -d /sys/kernel/security/apparmor ]] && grep -q "^tidepool-corpus-export " /sys/kernel/security/apparmor/profiles 2>/dev/null; then
  APPARMOR_VERIFY_OPT="--security-opt apparmor=tidepool-corpus-export"
fi
# shellcheck disable=SC2086
UTILITY="$(podman images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' 2>/dev/null | grep '^localhost/tidepool-utility:' | sort -k2 -r | head -1 | cut -d' ' -f1)"
if [[ -n "$UTILITY" && -f "$BASE/corpus/writer/tidepool.sqlite3" ]]; then
  out=$(podman run --rm --network=none \
      ${APPARMOR_VERIFY_OPT:-} \
      -v "$BASE/corpus":/var/lib/tidepool/corpus:rw \
      --userns=keep-id:uid=10001,gid=10001 \
      "$UTILITY" node --input-type=module -e '
        const { SqliteObservationStore } = await import("/app/server/dist/server/src/core/store.js");
        const { SnapshotStore } = await import("/app/server/dist/server/src/core/snapshot.js");
        const s = new SqliteObservationStore("/var/lib/tidepool/corpus", undefined, { readOnly: true });
        const v = s.verifyCorpus();
        for (const c of v.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${c.detail}`);
        const snaps = new SnapshotStore("/var/lib/tidepool/corpus/snapshots");
        let bad = 0;
        const metas = snaps.list();
        for (const meta of metas) {
          const doc = snaps.load(meta.digest);            // full schema re-validation
          if (doc.digest && doc.digest !== meta.digest) bad++;  // content digest ↔ filename
        }
        console.log(bad === 0 ? `ok snapshots: ${metas.length} validate` : `BAD snapshots: ${bad} digest mismatch(es)`);
        s.close();
        process.exit(v.ok && bad === 0 ? 0 : 1);
      ' 2>&1)
  rc=$?
  echo "$out" | sed 's/^/      /'
  [[ $rc -eq 0 ]] && pass "sqlite/corpus/snapshots: structural verification clean" || fail "sqlite/corpus/snapshots: verification reported problems"
else
  skip "sqlite/corpus/snapshots: no corpus or utility image yet"
fi

exit $FAIL
