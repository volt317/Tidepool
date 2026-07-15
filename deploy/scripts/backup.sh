#!/usr/bin/env bash
# deploy/scripts/backup.sh — VERIFIED corpus backup for the isolated
# appliance (systemd timer target: tidepool-backup.timer).
#
# The bundle is a consistent SQLite copy (backup API — never a raw WAL file
# copy) + objects + snapshots + checksums, produced by the corpus CLI in an
# ad-hoc utility container under the tidepool-corpus-export profile.
#
# HARD RULES (spec):
#   * the bundle is VERIFIED before success is declared — an unverifiable
#     backup is a failure, not a warning
#   * at least one PRIOR verified backup is always preserved
#   * success writes exports/last-verified-backup.json — the freshness
#     marker the retention CLI requires before it will delete anything
#
#   ./backup.sh                 → $TIDEPOOL_HOME/backups/<stamp>/
#   TIDEPOOL_HOME=… IMAGE_TAG=… ./backup.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"

BASE="${TIDEPOOL_HOME:-$DEPLOY_CFG_DATA_ROOT}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BASE/backups/$STAMP"
RETAIN="${RETAIN_VERIFIED:-14}"

# resolve the utility image: explicit tag, else newest local immutable tag
if [ -n "${IMAGE_TAG:-}" ]; then
  UTILITY="localhost/tidepool-utility:$IMAGE_TAG"
else
  UTILITY="$(podman images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
    | grep '^localhost/tidepool-utility:' | sort -k2 -r | head -1 | cut -d' ' -f1)"
fi
[ -n "$UTILITY" ] || { echo "backup: no tidepool-utility image — run install.sh first"; exit 1; }

[[ -f "$BASE/corpus/writer/tidepool.sqlite3" ]] || { echo "backup: no corpus at $BASE/corpus/writer — nothing to do"; exit 0; }
mkdir -p "$DEST"

APPARMOR_OPT=""
if [ -e /sys/kernel/security/apparmor/profiles ] && grep -q tidepool-corpus-export /sys/kernel/security/apparmor/profiles 2>/dev/null; then
  APPARMOR_OPT="--security-opt apparmor=tidepool-corpus-export"
fi

# corpus is mounted rw because reading a live WAL database requires -shm
# cooperation (shared-memory index) — the export takes a consistent copy via
# the SQLite backup API and writes nothing else; the corpus-export AppArmor
# profile narrows writes to exactly the writer db's WAL/-shm files.
# shellcheck disable=SC2086
podman run --rm --network=none $APPARMOR_OPT \
  --userns=keep-id:uid=$DEPLOY_CFG_CONTAINER_UID,gid=$DEPLOY_CFG_CONTAINER_GID \
  -v "$BASE/corpus":/var/lib/tidepool/corpus:rw \
  -v "$DEST":/var/lib/tidepool/exports:rw \
  "$UTILITY" \
  node /app/server/dist/server/src/cli/corpus.js export \
    --data /var/lib/tidepool/corpus \
    --out "/var/lib/tidepool/exports/corpus-$STAMP.tar.zst"

install -m 444 "$BASE/config/tidepool.config.json" "$DEST/tidepool.config.json"
# provenance alongside evidence: which images produced this corpus
latest_digests="$(ls -1t "$BASE"/exports/image-digests-*.json 2>/dev/null | head -1 || true)"
[ -n "$latest_digests" ] && install -m 444 "$latest_digests" "$DEST/image-digests.json"
( cd "$DEST" && sha256sum ./* > SHA256SUMS )

# --------------------------------------------------------------- VERIFY
# 1. checksums; 2. the importer's own dry-run validation of the bundle.
( cd "$DEST" && sha256sum -c --quiet SHA256SUMS )
# a dry-run import against a scratch corpus IS the bundle verifier: it
# checks the manifest, every checksum, and migration compatibility without
# writing anything durable
scratch="$(mktemp -d)"
# shellcheck disable=SC2086
podman run --rm --network=none \
  --userns=keep-id:uid=$DEPLOY_CFG_CONTAINER_UID,gid=$DEPLOY_CFG_CONTAINER_GID \
  -v "$DEST":/var/lib/tidepool/exports:ro \
  -v "$scratch":/var/lib/tidepool/corpus:rw \
  "$UTILITY" \
  node /app/server/dist/server/src/cli/corpus.js import \
    --data /var/lib/tidepool/corpus \
    --in "/var/lib/tidepool/exports/corpus-$STAMP.tar.zst" --dry-run \
  || { echo "backup: bundle FAILED dry-run verification — backup is NOT valid"; rm -rf "$DEST" "$scratch"; exit 1; }
rm -rf "$scratch"

echo "backup: verified → $DEST"
ls -lh "$DEST"

# marker consumed by the retention CLI's 24h-fresh-verified-backup guard
mkdir -p "$BASE/exports"
printf '{ "verifiedAt": "%s", "bundle": "%s" }\n' "$(date -u +%FT%TZ)" "$DEST/corpus-$STAMP.tar.zst" \
  > "$BASE/exports/last-verified-backup.json"

# retention: newest $RETAIN backups, and NEVER fewer than two (current +
# one prior verified) regardless of the configured count
keep=$((RETAIN > 2 ? RETAIN : 2))
ls -1dt "$BASE"/backups/*/ 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -rf
