# shellcheck shell=bash
# deploy/scripts/lib/verify-lib.sh — shared helpers for the verify-* family.
#
# Every verify script prints PASS/FAIL/SKIP lines and exits non-zero if
# anything FAILed. Source this after lib/deploy-config.sh; it resolves BASE
# (the data root) the same way verify.sh always has.
#
# Not executable on purpose: source it.

# shellcheck disable=SC2034  # FAIL/BASE are consumed by the sourcing verify-* script
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }
skip() { printf 'SKIP  %s\n' "$1"; }

verify_lib_resolve_base() {
  BASE="${TIDEPOOL_HOME:-$DEPLOY_CFG_DATA_ROOT}"
}
