#!/usr/bin/env bash
# deploy/scripts/verify-render.sh — STRUCTURAL verification, no install and
# no running deployment required. Suitable as a fast per-change CI gate and
# as an operator preflight before install.sh.
#
#   verify render        templates render with zero surviving placeholders,
#                        no :latest reference, quadlet generator dry-run
#                        (render.sh enforces all three; failure is fatal there)
#   verify nftables      rendered tidepool.nft passes `nft -c` (skips if nft
#                        absent — render.sh also checks when it can)
#   verify apparmor      every shipped profile parses with apparmor_parser -Q
#                        (skips if the parser is absent)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
# shellcheck source=lib/verify-lib.sh
source "$HERE/lib/verify-lib.sh"

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

if OUT_DIR="$OUT_DIR" "$HERE/render.sh" >/dev/null 2>&1; then
  pass "render: templates render clean (no placeholders, no :latest, quadlet dry-run where available)"
else
  fail "render: render.sh failed — run OUT_DIR=/tmp/tidepool-render $HERE/render.sh to inspect"
fi

if [[ -f "$OUT_DIR/tidepool.nft" ]]; then
  if command -v nft >/dev/null; then
    if nft -c -f "$OUT_DIR/tidepool.nft" >/dev/null 2>&1; then
      pass "nftables: rendered tidepool.nft passes syntax check"
    else
      fail "nftables: rendered tidepool.nft failed nft -c"
    fi
  else
    skip "nftables: nft not present on this host"
  fi
else
  fail "nftables: render produced no tidepool.nft"
fi

if command -v apparmor_parser >/dev/null; then
  for p in "$REPO"/deploy/apparmor/tidepool-*; do
    if apparmor_parser -Q "$p" >/dev/null 2>&1; then
      pass "apparmor: $(basename "$p") parses"
    else
      fail "apparmor: $(basename "$p") failed apparmor_parser -Q"
    fi
  done
else
  skip "apparmor: apparmor_parser not present on this host"
fi

exit "$FAIL"
