#!/usr/bin/env bash
# deploy/scripts/verify-host.sh — host prerequisites.
#
#   verify podman        rootless podman present and functional
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
# shellcheck source=lib/verify-lib.sh
source "$HERE/lib/verify-lib.sh"
verify_lib_resolve_base

if command -v podman >/dev/null; then
  if [[ $EUID -ne 0 ]] && podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null | grep -q true; then
    pass "podman: rootless and functional"
  else
    fail "podman: not running rootless (or podman info failed)"
  fi
else
  fail "podman: not installed"
fi

exit "$FAIL"
