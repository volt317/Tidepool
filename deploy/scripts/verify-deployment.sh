#!/usr/bin/env bash
# deploy/scripts/verify-deployment.sh — the running deployment.
#
#   verify deployment    quadlet units active, containers healthy,
#                        collector port NOT reachable from the host,
#                        API healthz answering, publication coherent
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
# shellcheck source=lib/verify-lib.sh
source "$HERE/lib/verify-lib.sh"
verify_lib_resolve_base

if systemctl --user is-active tidepool-collector.service >/dev/null 2>&1; then
  for u in tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler; do
    systemctl --user is-active "$u.service" >/dev/null 2>&1 && pass "deployment: $u.service active" || fail "deployment: $u.service not active"
  done
  for c in tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler; do
    h=$(podman inspect --format '{{.State.Health.Status}}' "$c" 2>/dev/null || echo "unknown")
    [[ "$h" == "healthy" || "$h" == "starting" ]] && pass "deployment: $c health=$h" || fail "deployment: $c health=$h"
  done
  # the PROXY answers on the single published port (through it: the API)
  port="${LISTEN_PORT:-$DEPLOY_CFG_LISTEN_PORT}"
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

exit "$FAIL"
