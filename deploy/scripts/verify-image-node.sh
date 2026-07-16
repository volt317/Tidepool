#!/usr/bin/env bash
# deploy/scripts/verify-image-node.sh — assert that the Node runtime baked
# into every built runtime image is major 24.
#
#   verify-image-node.sh <image-tag>     checks all five targets
#
# Rationale: a Node 24 base *digest* in a build arg proves what was pulled,
# not what the final image actually runs. This runs `node` INSIDE each built
# image (network-isolated) and fails unless the active major is 24 — the
# post-build, actual-image proof the spec requires.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"

TAG="${1:?usage: verify-image-node.sh <image-tag>}"
TARGETS=(collector api scheduler proxy utility)

fail=0
for t in "${TARGETS[@]}"; do
  image="$DEPLOY_CFG_IMAGE_PREFIX-$t:$TAG"
  major="$(podman run --rm --network=none --entrypoint "" "$image" \
             node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  if [ "$major" = "24" ]; then
    echo "ok    $image runs Node major $major"
  else
    echo "FAIL  $image runs Node major $major (expected 24)"
    fail=1
  fi
done

exit "$fail"
