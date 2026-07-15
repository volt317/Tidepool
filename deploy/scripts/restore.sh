#!/usr/bin/env bash
# deploy/scripts/restore.sh
#
# Restore a corpus from a backup bundle, with verification BEFORE anything
# is written: the importer's --dry-run pass checks the bundle's checksums
# and schema compatibility and reports exactly what would be imported; only
# then does the real import run.
#
#   ./restore.sh ~/.local/share/tidepool/backups/<stamp>/corpus-<stamp>.tar.zst
#
# Procedure (also in deploy/README.md):
#   1. stop the writer        systemctl --user stop tidepool-scheduler tidepool-collector
#   2. run this script        (dry-run verify → transactional import →
#                              corpus verify → fresh replica publication)
#   3. restore config if needed (backups include tidepool.config.json)
#   4. start services         systemctl --user start tidepool-collector tidepool-scheduler
#   5. verify                 ~/.local/share/tidepool/bin/verify.sh && bin/boundaries-verify.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
deploy_config_refuse_root

BASE="${TIDEPOOL_HOME:-$DEPLOY_CFG_DATA_ROOT}"
BUNDLE="${1:?usage: restore.sh <corpus-….tar.zst>}"
BUNDLE="$(readlink -f "$BUNDLE")"
[[ -f "$BUNDLE" ]] || { echo "restore: $BUNDLE not found"; exit 2; }

if systemctl --user is-active tidepool-collector.service >/dev/null 2>&1; then
  echo "restore: refusing to run while the collector (the corpus writer) is active."
  echo "         systemctl --user stop tidepool-scheduler tidepool-collector   — then re-run."
  exit 2
fi

# bundle-adjacent checksums, if the backup script produced them
if [[ -f "$(dirname "$BUNDLE")/SHA256SUMS" ]]; then
  ( cd "$(dirname "$BUNDLE")" && sha256sum -c SHA256SUMS )
fi

UTILITY="${UTILITY:-$(podman images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' | grep '^localhost/tidepool-utility:' | sort -k2 -r | head -1 | cut -d' ' -f1)}"
[ -n "$UTILITY" ] || { echo "restore: no tidepool-utility image"; exit 1; }
APPARMOR_OPT=""
if [ -e /sys/kernel/security/apparmor/profiles ] && grep -q tidepool-corpus-import /sys/kernel/security/apparmor/profiles 2>/dev/null; then
  APPARMOR_OPT="--security-opt apparmor=tidepool-corpus-import"
fi

run_import() {
  # shellcheck disable=SC2086
  podman run --rm --network=none \
    --userns=keep-id:uid=$DEPLOY_CFG_CONTAINER_UID,gid=$DEPLOY_CFG_CONTAINER_GID \
    -v "$BASE/corpus":/var/lib/tidepool/corpus:rw \
    -v "$(dirname "$BUNDLE")":/restore:ro \
    ${APPARMOR_OPT:-} \
    "$UTILITY" \
    node /app/server/dist/server/src/cli/corpus.js import \
      --data /var/lib/tidepool/corpus \
      --in "/restore/$(basename "$BUNDLE")" "$@"
}

mkdir -p "$BASE/corpus"
echo "==> restore verification (dry run — nothing written)"
run_import --dry-run
echo "==> importing"
run_import
echo "==> verifying restored corpus"
podman run --rm --network=none ${APPARMOR_OPT:-} \
  --userns=keep-id:uid=$DEPLOY_CFG_CONTAINER_UID,gid=$DEPLOY_CFG_CONTAINER_GID \
  -v "$BASE/corpus":/var/lib/tidepool/corpus:rw \
  "$UTILITY" \
  node /app/server/dist/server/src/cli/corpus.js verify --data /var/lib/tidepool/corpus
echo "==> publishing a fresh read replica from the restored corpus"
mkdir -p "$BASE/published"
podman run --rm --network=none \
  --userns=keep-id:uid=$DEPLOY_CFG_CONTAINER_UID,gid=$DEPLOY_CFG_CONTAINER_GID \
  -v "$BASE/corpus":/var/lib/tidepool/corpus:rw \
  -v "$BASE/published":/var/lib/tidepool/published:rw \
  "$UTILITY" \
  node -e 'import("/app/server/dist/server/src/core/store.js").then(async m => { const s = new m.SqliteObservationStore("/var/lib/tidepool/corpus"); const r = await s.publishReplica("/var/lib/tidepool/published", { role: "restore" }); console.log("published", r.digest.slice(0,12)); s.close(); })'
echo "restore: done — start the services and verify:"
echo "  systemctl --user start tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler"
echo "  $BASE/bin/verify.sh && $BASE/bin/boundaries-verify.sh"
