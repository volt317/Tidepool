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
#
# PRIVILEGE: nft -c needs CAP_NET_ADMIN even as a pure check, so when an
# unprivileged run fails, this script re-runs ONLY the two read-only,
# fixed-argv checks (nft -c, apparmor_parser -Q) through non-interactive
# `sudo -n` — it can never prompt, and succeeds only where a passwordless
# grant already exists. Every escalated check is marked "(via sudo)" in its
# PASS line, and TIDEPOOL_VERIFY_NO_SUDO=1 disables escalation entirely
# (permission-blocked checks then report SKIP, never a false PASS/FAIL).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
# shellcheck source=lib/verify-lib.sh
source "$HERE/lib/verify-lib.sh"

can_sudo() { [[ "${TIDEPOOL_VERIFY_NO_SUDO:-0}" != "1" ]] && sudo -n true 2>/dev/null; }

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
    nft_via=""
    nft_out="$(LC_ALL=C nft -c -f "$OUT_DIR/tidepool.nft" 2>&1)" && nft_rc=0 || nft_rc=$?
    if [[ "$nft_rc" -ne 0 ]] && grep -qi "not permitted" <<<"$nft_out" && can_sudo; then
      nft_via=" (via sudo)"
      nft_out="$(sudo -n env LC_ALL=C nft -c -f "$OUT_DIR/tidepool.nft" 2>&1)" && nft_rc=0 || nft_rc=$?
    fi
    if [[ "$nft_rc" -eq 0 ]]; then
      pass "nftables: rendered tidepool.nft passes syntax check$nft_via"
    elif grep -qi "not permitted" <<<"$nft_out"; then
      skip "nftables: nft -c needs CAP_NET_ADMIN and no privilege path (or TIDEPOOL_VERIFY_NO_SUDO=1) — not checked"
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
# exists but the caller is unprivileged, and its failure messages for that
# case are not pinned down the way nft's are — so escalation here is
# DELIBERATELY gated on any unprivileged failure, not on a matched
# permission string. The escalated command is the same read-only parse of
# the same file; the cost of a pointless root re-parse on a genuine compile
# error is lower than the cost of a wrongly-matched string re-breaking CI.
if command -v apparmor_parser >/dev/null; then
  for p in "$REPO"/deploy/apparmor/tidepool-*; do
    aa_via=""
    aa_out="$(LC_ALL=C apparmor_parser -Q "$p" 2>&1)" && aa_rc=0 || aa_rc=$?
    if [[ "$aa_rc" -ne 0 ]] && can_sudo; then
      aa_via=" (via sudo)"
      aa_out="$(sudo -n env LC_ALL=C apparmor_parser -Q "$p" 2>&1)" && aa_rc=0 || aa_rc=$?
    fi
    if [[ "$aa_rc" -eq 0 ]]; then
      pass "apparmor: $(basename "$p") parses$aa_via"
    else
      fail "apparmor: $(basename "$p") failed apparmor_parser -Q:"
      sed 's/^/      /' <<<"$aa_out"
    fi
  done
else
  skip "apparmor: apparmor_parser not present on this host"
fi

exit "$FAIL"
