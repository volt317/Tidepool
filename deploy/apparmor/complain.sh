#!/bin/sh
# deploy/apparmor/complain.sh
#
# Generate complain-mode variants of every Tidepool AppArmor profile for
# development: identical rules, but violations are LOGGED (audit/journal)
# instead of denied — the honest way to discover a missing rule before
# switching to enforce.
#
#   ./complain.sh            → writes tidepool-*.complain next to the sources
#   sudo install -m 644 tidepool-collector.complain /etc/apparmor.d/tidepool-collector
#   sudo apparmor_parser -r /etc/apparmor.d/tidepool-collector
#
# (Alternatively, on hosts with apparmor-utils: sudo aa-complain tidepool-collector)
set -eu
cd "$(dirname "$0")"
for p in tidepool-collector tidepool-api tidepool-scheduler tidepool-dispatch; do
  sed 's/flags=(\(.*\))/flags=(\1,complain)/' "$p" > "$p.complain"
  echo "wrote $p.complain"
done
