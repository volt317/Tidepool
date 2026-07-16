#!/usr/bin/env bash
# deploy/scripts/verify-install.sh — installed host layout.
#
#   verify bind mounts   host layout exists with sane permissions
#   verify permissions   corpus not world-readable
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
# shellcheck source=lib/verify-lib.sh
source "$HERE/lib/verify-lib.sh"
verify_lib_resolve_base

for d in config corpus keyrings backups published run cache; do
  [[ -d "$BASE/$d" ]] && pass "bind mounts: $BASE/$d exists" || fail "bind mounts: $BASE/$d missing"
done
[[ -f "$BASE/config/tidepool.config.json" ]] && pass "bind mounts: config file present" || fail "bind mounts: tidepool.config.json missing"

perm=$(stat -c %a "$BASE/corpus" 2>/dev/null || echo "")
if [[ "$perm" == 7?0 || "$perm" == 700 ]]; then
  pass "permissions: corpus is not world/other accessible ($perm)"
else
  fail "permissions: corpus mode is '$perm' (expected 700)"
fi

exit "$FAIL"
