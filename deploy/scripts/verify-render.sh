#!/usr/bin/env bash
# deploy/scripts/verify-render.sh — STRUCTURAL verification, no install and
# no running deployment required. Suitable as a fast per-change CI gate and
# as an operator preflight before install.sh.
#
#   verify render        templates render with zero surviving placeholders,
#                        no :latest reference, quadlet generator dry-run
#                        (render.sh enforces all three; failure is fatal there)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
# shellcheck source=lib/verify-lib.sh
source "$HERE/lib/verify-lib.sh"

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

render_out="$(OUT_DIR="$OUT_DIR" "$HERE/render.sh" 2>&1)" && render_rc=0 || render_rc=$?
if [ "$render_rc" -eq 0 ]; then
  pass "render: templates render clean (no placeholders, no :latest, quadlet dry-run where available)"
else
  fail "render: render.sh failed — full output follows"
  sed 's/^/      /' <<<"$render_out"
fi

exit "$FAIL"
