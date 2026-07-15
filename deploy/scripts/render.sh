#!/usr/bin/env bash
# deploy/scripts/render.sh — render Quadlet templates for THIS deployment.
#
# The templates carry @PLACEHOLDERS@ so that the installed units always
# agree with where the data actually lives (the spec's rule: never install
# fixed-path Quadlets while creating data directories elsewhere).
#
# Defaults come from deploy/deploy.yaml (the single location for values
# multiple files must agree on); environment variables override per-run:
#
#   TIDEPOOL_HOME    data root
#   IMAGE_TAG        immutable image tag  (default <version>-g<commit>)
#   LISTEN_ADDR      proxy bind address
#   LISTEN_PORT      proxy host port
#
# Renders into $OUT_DIR (default: deploy/quadlet/rendered), validates that
# no placeholder survived, and — where the quadlet generator binary is
# available — runs its dryrun so a syntactically broken unit fails HERE,
# not at boot.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TEMPLATES="$REPO/deploy/quadlet/templates"

# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
TIDEPOOL_HOME="${TIDEPOOL_HOME:-$DEPLOY_CFG_DATA_ROOT}"
LISTEN_ADDR="${LISTEN_ADDR:-$DEPLOY_CFG_LISTEN_ADDR}"
LISTEN_PORT="${LISTEN_PORT:-$DEPLOY_CFG_LISTEN_PORT}"
INTERNAL_PORT="${INTERNAL_PORT:-$DEPLOY_CFG_INTERNAL_PORT}"
CONTAINER_UID="${CONTAINER_UID:-$DEPLOY_CFG_CONTAINER_UID}"
CONTAINER_GID="${CONTAINER_GID:-$DEPLOY_CFG_CONTAINER_GID}"
IMAGE_PREFIX="${IMAGE_PREFIX:-$DEPLOY_CFG_IMAGE_PREFIX}"
OUT_DIR="${OUT_DIR:-$REPO/deploy/quadlet/rendered}"
echo "render: configurables from $DEPLOY_CFG_SOURCE"

if [ -z "${IMAGE_TAG:-}" ]; then
  commit="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo dev)"
  IMAGE_TAG="0.3.0-g${commit}"
fi

# profile digest: identity of the AppArmor profile set that should be loaded
APPARMOR_DIGEST="$(cat "$REPO"/deploy/apparmor/tidepool-* 2>/dev/null | sha256sum | cut -d' ' -f1 || echo unknown)"

mkdir -p "$OUT_DIR"
rendered=()
for tpl in "$TEMPLATES"/*.in; do
  out="$OUT_DIR/$(basename "${tpl%.in}")"
  sed \
    -e "s|@TIDEPOOL_HOME@|$TIDEPOOL_HOME|g" \
    -e "s|@COLLECTOR_IMAGE@|$IMAGE_PREFIX-collector:$IMAGE_TAG|g" \
    -e "s|@API_IMAGE@|$IMAGE_PREFIX-api:$IMAGE_TAG|g" \
    -e "s|@SCHEDULER_IMAGE@|$IMAGE_PREFIX-scheduler:$IMAGE_TAG|g" \
    -e "s|@PROXY_IMAGE@|$IMAGE_PREFIX-proxy:$IMAGE_TAG|g" \
    -e "s|@LISTEN_ADDR@|$LISTEN_ADDR|g" \
    -e "s|@LISTEN_PORT@|$LISTEN_PORT|g" \
    -e "s|@INTERNAL_PORT@|$INTERNAL_PORT|g" \
    -e "s|@CONTAINER_UID@|$CONTAINER_UID|g" \
    -e "s|@CONTAINER_GID@|$CONTAINER_GID|g" \
    -e "s|@APPARMOR_DIGEST@|$APPARMOR_DIGEST|g" \
    "$tpl" > "$out.tmp"
  mv "$out.tmp" "$out"
  rendered+=("$out")
done

# self-referential digest: each unit records the digest of the FULL rendered
# set with its own QUADLET_DIGEST line normalized (stable across renders)
QUADLET_DIGEST="$(cat "${rendered[@]}" | sed 's/@QUADLET_DIGEST@//' | sha256sum | cut -d' ' -f1)"
for f in "${rendered[@]}"; do
  sed -i "s|@QUADLET_DIGEST@|$QUADLET_DIGEST|g" "$f"
done

# ---- validation ------------------------------------------------------------
fail=0
for f in "${rendered[@]}"; do
  if grep -q "@[A-Z_]*@" "$f"; then
    echo "render: UNRESOLVED placeholder in $f:" >&2
    grep -n "@[A-Z_]*@" "$f" >&2
    fail=1
  fi
done
[ "$fail" -eq 0 ] || exit 1

# never ship a floating tag
if grep -l ":latest" "${rendered[@]}" >/dev/null 2>&1; then
  echo "render: refusing — a rendered unit references a :latest image" >&2
  grep -ln ":latest" "${rendered[@]}" >&2
  exit 1
fi

# quadlet generator dryrun (path varies across distributions)
for q in /usr/lib/podman/quadlet /usr/libexec/podman/quadlet; do
  if [ -x "$q" ]; then
    tmp="$(mktemp -d)"
    cp "$OUT_DIR"/*.container "$tmp"/ 2>/dev/null || true
    if QUADLET_UNIT_DIRS="$tmp" "$q" -dryrun -user >/dev/null 2>&1; then
      echo "render: quadlet dryrun OK ($q)"
    else
      echo "render: quadlet dryrun FAILED — inspect with: QUADLET_UNIT_DIRS=$OUT_DIR $q -dryrun -user" >&2
      rm -rf "$tmp"; exit 1
    fi
    rm -rf "$tmp"
    break
  fi
done

# the host firewall template shares the port define
sed -e "s|@LISTEN_PORT@|$LISTEN_PORT|g" "$REPO/deploy/nftables/tidepool.nft.in" > "$OUT_DIR/tidepool.nft"
if command -v nft >/dev/null; then
  nft -c -f "$OUT_DIR/tidepool.nft" && echo "render: nftables syntax OK" || { echo "render: nftables template failed syntax check" >&2; exit 1; }
fi

echo "render: ${#rendered[@]} unit(s) + tidepool.nft → $OUT_DIR"
echo "render: images tagged $IMAGE_TAG; data root $TIDEPOOL_HOME; listener $LISTEN_ADDR:$LISTEN_PORT"
echo "render: quadlet-set digest $QUADLET_DIGEST"
