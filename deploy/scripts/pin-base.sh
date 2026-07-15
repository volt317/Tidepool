#!/usr/bin/env bash
# deploy/scripts/pin-base.sh — resolve the base image's CURRENT digest and
# print a digest-pinned reference for --build-arg BASE_IMAGE.
#
# Image discipline: builds must not depend on what a floating tag happens to
# point at today. install.sh and CI call this and pass the result into the
# build; CI additionally FAILS if the build arg is not digest-pinned.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
BASE_TAG="${BASE_TAG:-$DEPLOY_CFG_BASE_IMAGE}"
podman pull -q "$BASE_TAG" >/dev/null
digest="$(podman image inspect --format '{{index .RepoDigests 0}}' "$BASE_TAG")"
if [[ "$digest" != *"@sha256:"* ]]; then
  echo "pin-base: could not resolve a digest for $BASE_TAG" >&2
  exit 1
fi
echo "$digest"
