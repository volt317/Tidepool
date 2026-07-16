#!/usr/bin/env bash
# deploy/scripts/ci-topology.sh — start/stop the four-container Tidepool
# topology with unit-equivalent podman run flags, for CI and workstation
# testing. MOVED verbatim from ci-deploy-test.sh steps 7/18 so the explicit
# CI workflows and the integrated scenario share one definition
# instead of drifting copies.
#
#   ci-topology.sh up   <image-tag>    prepare $TIDEPOOL_HOME, write the CI
#                                      config, start collector/api/proxy/
#                                      scheduler (proxy on 127.0.0.1:18747)
#   ci-topology.sh down                stop all four, asserting clean exit 0
#
# Requires: TIDEPOOL_HOME exported. AppArmor confinement is applied when the
# per-service profiles are loaded in the kernel, else skipped (stated).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
deploy_config_refuse_root

MODE="${1:?usage: ci-topology.sh up <image-tag> | down}"
: "${TIDEPOOL_HOME:?TIDEPOOL_HOME must be exported}"

AA() {
  if [ -e /sys/kernel/security/apparmor/profiles ] && grep -q "^$1 " /sys/kernel/security/apparmor/profiles 2>/dev/null; then
    echo "--security-opt apparmor=$1"
  fi
}

up() {
  local IMAGE_TAG="${1:?up requires an image tag}"
  mkdir -p "$TIDEPOOL_HOME"/{config,keyrings,corpus,corpus/objects,corpus/snapshots,cache,published,run,backups,exports}
  cat > "$TIDEPOOL_HOME/config/tidepool.config.json" <<'CFG'
{
  "server": { "port": 8747, "indexTtlHours": 6 },
  "distros": [],
  "ecosystems": [
    { "id": "npm-ci", "label": "npm CI watchlist", "ecosystem": "npm", "enabled": true,
      "osvEcosystem": "npm", "scope": { "mode": "list", "packages": ["express"] } }
  ],
  "enrichment": { "osv": true, "endoflife": false, "github": false },
  "scheduler": { "enabled": true, "collectionInterval": "6h", "snapshotInterval": "24h", "verificationInterval": "7d" },
  "maintenance": { "publishReplicaAfterCollection": true, "enrichment": { "changedWindowHours": 24, "maxPerRun": 5 } }
}
CFG
  local COMMON=("--userns=keep-id:uid=$DEPLOY_CFG_CONTAINER_UID,gid=$DEPLOY_CFG_CONTAINER_GID" --read-only "--tmpfs" "/tmp:rw,noexec,nosuid" --cap-drop=all --security-opt no-new-privileges)
  local V="$TIDEPOOL_HOME"
  # shellcheck disable=SC2046
  podman run -d --name tidepool-collector "${COMMON[@]}" $(AA tidepool-collector) \
    -v "$V/config:/var/lib/tidepool/config:ro" -v "$V/keyrings:/var/lib/tidepool/keyrings:ro" \
    -v "$V/corpus:/var/lib/tidepool/corpus:rw" -v "$V/cache:/var/lib/tidepool/cache:rw" \
    -v "$V/published:/var/lib/tidepool/published:rw" -v "$V/run:/var/lib/tidepool/run:rw" \
    "$DEPLOY_CFG_IMAGE_PREFIX-collector:$IMAGE_TAG" >/dev/null
  # shellcheck disable=SC2046
  podman run -d --name tidepool-api --network=none "${COMMON[@]}" $(AA tidepool-api) \
    -v "$V/config:/var/lib/tidepool/config:ro" -v "$V/published:/var/lib/tidepool/published:ro" \
    -v "$V/corpus/objects:/var/lib/tidepool/corpus/objects:ro" -v "$V/corpus/snapshots:/var/lib/tidepool/corpus/snapshots:ro" \
    -v "$V/run:/var/lib/tidepool/run:rw" \
    "$DEPLOY_CFG_IMAGE_PREFIX-api:$IMAGE_TAG" >/dev/null
  # shellcheck disable=SC2046
  podman run -d --name tidepool-proxy "${COMMON[@]}" $(AA tidepool-proxy) \
    -v "$V/run:/var/lib/tidepool/run:rw" -v "$V/config:/var/lib/tidepool/config:ro" \
    -e TIDEPOOL_PROXY_ADDR=0.0.0.0 -p "127.0.0.1:18747:$DEPLOY_CFG_INTERNAL_PORT" \
    "$DEPLOY_CFG_IMAGE_PREFIX-proxy:$IMAGE_TAG" >/dev/null
  # shellcheck disable=SC2046
  podman run -d --name tidepool-scheduler --network=none "${COMMON[@]}" $(AA tidepool-scheduler) \
    -v "$V/config:/var/lib/tidepool/config:ro" -v "$V/run:/var/lib/tidepool/run:rw" \
    "$DEPLOY_CFG_IMAGE_PREFIX-scheduler:$IMAGE_TAG" >/dev/null
  echo "4 containers started (collector: egress netns; api+scheduler: --network=none; proxy: published 127.0.0.1:18747)"
  sleep 8
}

down() {
  local fail=0
  for c in tidepool-scheduler tidepool-proxy tidepool-api tidepool-collector; do
    podman stop -t 20 "$c" >/dev/null
    rc="$(podman inspect -f '{{.State.ExitCode}}' "$c")"
    if [ "$rc" != "0" ]; then
      echo "$c exited $rc — not a clean shutdown"
      podman logs --tail 5 "$c"
      fail=1
    else
      echo "$c stopped cleanly (exit 0)"
    fi
    podman rm -f "$c" >/dev/null 2>&1 || true
  done
  return "$fail"
}

case "$MODE" in
  up)   up "${2:?up requires an image tag}" ;;
  down) down ;;
  *)    echo "usage: ci-topology.sh up <image-tag> | down" >&2; exit 2 ;;
esac
