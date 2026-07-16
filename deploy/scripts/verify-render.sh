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

render_out="$(OUT_DIR="$OUT_DIR" "$HERE/render.sh" 2>&1)" && render_rc=0 || render_rc=$?
if [ "$render_rc" -eq 0 ]; then
  pass "render: templates render clean (no placeholders, no :latest, quadlet dry-run where available)"
else
  fail "render: render.sh failed — full output follows"
  sed 's/^/      /' <<<"$render_out"
fi

# nft -c needs CAP_NET_ADMIN even for a check (netlink cache init), so an
# unprivileged failure is escalated through passwordless sudo when present,
# and honestly SKIPped — never FAILed — when no privilege path exists.
# Only a genuine syntax rejection is a FAIL, and it prints nft's output.
if [[ -f "$OUT_DIR/tidepool.nft" ]]; then
  if command -v nft >/dev/null; then
    nft_out="$(nft -c -f "$OUT_DIR/tidepool.nft" 2>&1)" && nft_rc=0 || nft_rc=$?
    if [[ "$nft_rc" -ne 0 ]] && grep -qi "not permitted" <<<"$nft_out" && sudo -n true 2>/dev/null; then
      nft_out="$(sudo -n nft -c -f "$OUT_DIR/tidepool.nft" 2>&1)" && nft_rc=0 || nft_rc=$?
    fi
    if [[ "$nft_rc" -eq 0 ]]; then
      pass "nftables: rendered tidepool.nft passes syntax check"
    elif grep -qi "not permitted" <<<"$nft_out"; then
      skip "nftables: nft -c needs CAP_NET_ADMIN and no passwordless sudo — not checked"
    else
      fail "nftables: rendered tidepool.nft failed nft -c:"
      sed 's/^/      /' <<<"$nft_out"
    fi
  else
    skip "nftables: nft not present on this host"
  fi
else
  fail "nftables: render produced no tidepool.nft"
fi

# apparmor_parser can behave differently when the kernel AppArmor interface
# exists but the caller is unprivileged; same policy as nft: escalate the
# single check via passwordless sudo, print the parser's real output on a
# genuine compile failure, and never report a check that could not run.
if command -v apparmor_parser >/dev/null; then
  for p in "$REPO"/deploy/apparmor/tidepool-*; do
    aa_out="$(apparmor_parser -Q "$p" 2>&1)" && aa_rc=0 || aa_rc=$?
    if [[ "$aa_rc" -ne 0 ]] && sudo -n true 2>/dev/null; then
      aa_out="$(sudo -n apparmor_parser -Q "$p" 2>&1)" && aa_rc=0 || aa_rc=$?
    fi
    if [[ "$aa_rc" -eq 0 ]]; then
      pass "apparmor: $(basename "$p") parses"
    else
      fail "apparmor: $(basename "$p") failed apparmor_parser -Q:"
      sed 's/^/      /' <<<"$aa_out"
    fi
  done
else
  skip "apparmor: apparmor_parser not present on this host"
fi

exit "$FAIL"
