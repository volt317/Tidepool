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
#   1. stop the pod           systemctl --user stop tidepool-pod
#   2. run this script
#   3. restore config if needed (backups include tidepool.config.json)
#   4. start the pod          systemctl --user start tidepool-pod
#   5. ./deploy/scripts/verify.sh
set -euo pipefail

BASE="${TIDEPOOL_HOME:-$HOME/.local/share/tidepool}"
BUNDLE="${1:?usage: restore.sh <corpus-….tar.zst>}"
BUNDLE="$(readlink -f "$BUNDLE")"
[[ -f "$BUNDLE" ]] || { echo "restore: $BUNDLE not found"; exit 2; }

if systemctl --user is-active tidepool-collector.service >/dev/null 2>&1; then
  echo "restore: refusing to run while the collector (the corpus writer) is active."
  echo "         systemctl --user stop tidepool-pod   — then re-run."
  exit 2
fi

# bundle-adjacent checksums, if the backup script produced them
if [[ -f "$(dirname "$BUNDLE")/SHA256SUMS" ]]; then
  ( cd "$(dirname "$BUNDLE")" && sha256sum -c SHA256SUMS )
fi

run_import() {
  podman run --rm --network=none \
    --userns=keep-id:uid=10001,gid=10001 \
    -v "$BASE/corpus":/var/lib/tidepool/corpus:rw \
    -v "$(dirname "$BUNDLE")":/restore:ro \
    localhost/tidepool-utility \
    node /app/server/dist/server/src/cli/corpus.js import \
      --data /var/lib/tidepool/corpus \
      --in "/restore/$(basename "$BUNDLE")" "$@"
}

mkdir -p "$BASE/corpus"
echo "==> restore verification (dry run — nothing written)"
run_import --dry-run
echo "==> importing"
run_import
echo "restore: done — start the pod and run verify.sh"
