#!/usr/bin/env bash
# deploy/scripts/backup.sh
#
# Consistent corpus backup: runs the corpus CLI's `export` in an ad-hoc
# utility container, producing one portable .tar.zst bundle containing a
# CONSISTENT SQLite copy (taken via the backup API — never a raw file/WAL
# copy), the content-addressed object store, snapshots, and checksums the
# importer verifies. The live services keep running: SQLite WAL permits the
# backup reader alongside the collector's writer.
#
# Also copies the current configuration next to the bundle — restoring
# evidence without the config that produced it is half a restore.
#
#   ./backup.sh                 → ~/.local/share/tidepool/backups/…
#   TIDEPOOL_HOME=… ./backup.sh
#
# Use before updates/migrations (or uncomment ExecStartPre in the collector
# unit to make it automatic on every start).
set -euo pipefail

BASE="${TIDEPOOL_HOME:-$HOME/.local/share/tidepool}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BASE/backups/$STAMP"
mkdir -p "$DEST"

[[ -f "$BASE/corpus/tidepool.sqlite3" ]] || { echo "backup: no corpus at $BASE/corpus — nothing to do"; exit 0; }

podman run --rm --network=none \
  --userns=keep-id:uid=10001,gid=10001 \
  -v "$BASE/corpus":/var/lib/tidepool/corpus:rw \
  -v "$DEST":/backup:rw \
  localhost/tidepool-utility \
  node /app/server/dist/server/src/cli/corpus.js export \
    --data /var/lib/tidepool/corpus \
    --out /backup/corpus-$STAMP.tar.zst

install -m 444 "$BASE/config/tidepool.config.json" "$DEST/tidepool.config.json"
( cd "$DEST" && sha256sum ./* > SHA256SUMS )

echo "backup: $DEST"
ls -lh "$DEST"

# retention: keep the newest 14 backups
ls -1dt "$BASE"/backups/*/ 2>/dev/null | tail -n +15 | xargs -r rm -rf
