#!/usr/bin/env bash
# deploy/scripts/verify.sh — automated deployment verification, suitable for
# CI and for validating a live install. Now a thin orchestrator: each check
# family lives in its own verify-*.sh (runnable individually), this script
# runs them all in order. Every check prints PASS/FAIL/SKIP and the script
# exits non-zero if anything FAILed.
#
#   verify-host.sh        rootless podman present and functional
#   verify-install.sh     host layout exists with sane permissions
#   verify-apparmor.sh    profiles loaded (skips if AppArmor absent)
#   verify-deployment.sh  units active, containers healthy, collector
#                         publishes no port, API healthz, publication coherent
#   verify-corpus.sh      sqlite integrity + verifyCorpus + snapshot digests
#
# verify-render.sh (structural: templates/nftables/apparmor parse) needs no
# install and is not part of the live sequence — CI runs it per change.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAIL=0
for part in verify-host.sh verify-install.sh verify-apparmor.sh verify-deployment.sh verify-corpus.sh; do
  "$HERE/$part" || FAIL=1
done

exit "$FAIL"
