#!/usr/bin/env bash
# deploy/scripts/verify-corpus.sh — corpus, sqlite, and snapshot integrity.
#
#   verify sqlite        integrity_check via a query-only connection
#   verify corpus        full structural verification (verifyCorpus)
#   verify snapshots     every stored snapshot re-validates and its filename
#                        matches its content digest
#
# All three run inside an ad-hoc utility container against the real corpus,
# through a query-only connection — verification can never mutate evidence.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
# shellcheck source=lib/verify-lib.sh
source "$HERE/lib/verify-lib.sh"
verify_lib_resolve_base

# Isolation for this job: --network=none + the read-only-intent connection.
UTILITY="$(podman images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' 2>/dev/null | grep '^localhost/tidepool-utility:' | sort -k2 -r | head -1 | cut -d' ' -f1)"
if [[ -n "$UTILITY" && -f "$BASE/corpus/writer/tidepool.sqlite3" ]]; then
  # shellcheck disable=SC2086
  out=$(podman run --rm --network=none \
      -v "$BASE/corpus":/var/lib/tidepool/corpus:rw \
      --userns=keep-id:uid="$DEPLOY_CFG_CONTAINER_UID",gid="$DEPLOY_CFG_CONTAINER_GID" \
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

exit "$FAIL"
