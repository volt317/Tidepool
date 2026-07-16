#!/usr/bin/env bash
# deploy/scripts/verify-apparmor.sh — AppArmor profiles loaded on this host.
#
#   verify apparmor      profiles loaded (skips if AppArmor absent)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
# shellcheck source=lib/verify-lib.sh
source "$HERE/lib/verify-lib.sh"
verify_lib_resolve_base

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

exit "$FAIL"
