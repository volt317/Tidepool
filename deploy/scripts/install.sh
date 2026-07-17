#!/usr/bin/env bash
# deploy/scripts/install.sh — build and install the isolated-appliance
# deployment: independent rootless containers, digest-pinned base, immutable
# image tags, rendered Quadlet units, timers.
#
#   TIDEPOOL_HOME   data root (default ~/.local/share/tidepool)
#   LISTEN_ADDR     proxy bind address (default 127.0.0.1 — set a trusted
#                   LAN address ONLY deliberately)
#   LISTEN_PORT     proxy port (default 8747)
#
# What this script does NOT do (deliberately):
#   * apply host-side network policy (site-specific — operator's domain)
#   * start services (operators review rendered units first)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
TIDEPOOL_HOME="${TIDEPOOL_HOME:-$DEPLOY_CFG_DATA_ROOT}"
LISTEN_ADDR="${LISTEN_ADDR:-$DEPLOY_CFG_LISTEN_ADDR}"
LISTEN_PORT="${LISTEN_PORT:-$DEPLOY_CFG_LISTEN_PORT}"
IMAGE_PREFIX="${IMAGE_PREFIX:-$DEPLOY_CFG_IMAGE_PREFIX}"
QUADLET_DIR="$HOME/.config/containers/systemd"
TIMER_DIR="$HOME/.config/systemd/user"

command -v podman >/dev/null || { echo "podman is required"; exit 1; }
command -v git >/dev/null || { echo "git is required (image tags embed the commit)"; exit 1; }
if [[ $EUID -eq 0 ]]; then
  echo "run as the unprivileged appliance user, not root (rootless deployment)"; exit 1
fi

VERSION="$(node -e "console.log(require('$REPO/package.json').version)" 2>/dev/null || echo 0.3.0)"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
COMMIT_FULL="$(git -C "$REPO" rev-parse HEAD)"
IMAGE_TAG="${VERSION}-g${COMMIT}"

echo "== Tidepool isolated-appliance install =="
echo "   config    : $DEPLOY_CFG_SOURCE"
echo "   data root : $TIDEPOOL_HOME"
echo "   image tag : $IMAGE_TAG (immutable; no :latest anywhere)"
echo "   listener  : $LISTEN_ADDR:$LISTEN_PORT (proxy; the only published port)"

# ---------------------------------------------------------------- data trees
# Per-service mount matrix (the enforcement, in directory form):
#   collector: config ro, keyrings ro, corpus rw, cache rw, published rw, run rw
#   api:       config ro, published ro, corpus/objects ro, corpus/snapshots ro, run rw
#   scheduler: config ro, run rw
#   proxy:     config ro, run rw
mkdir -p "$TIDEPOOL_HOME"/{config,keyrings,corpus,corpus/objects,corpus/snapshots,cache,published,run,backups,exports,bin}
chmod 700 "$TIDEPOOL_HOME" "$TIDEPOOL_HOME"/{keyrings,corpus,cache,run,backups}
chmod 755 "$TIDEPOOL_HOME"/{published,exports}

if [ ! -f "$TIDEPOOL_HOME/config/tidepool.config.json" ]; then
  install -m 640 "$REPO/tidepool.config.json" "$TIDEPOOL_HOME/config/tidepool.config.json"
  echo "   config    : seeded from repository default — EDIT IT before first start"
fi

# --------------------------------------------------------------------- build
BASE_IMAGE="$("$HERE/pin-base.sh")"
echo "   base image: $BASE_IMAGE (digest-pinned)"
for target in collector api scheduler proxy utility; do
  echo "-- building tidepool-$target:$IMAGE_TAG"
  podman build -q -f "$REPO/deploy/oci/Containerfile" --target "$target" \
    --build-arg BASE_IMAGE="$BASE_IMAGE" \
    --build-arg TIDEPOOL_VERSION="$VERSION" \
    --build-arg TIDEPOOL_GIT_COMMIT="$COMMIT_FULL" \
    --build-arg INTERNAL_PORT="$DEPLOY_CFG_INTERNAL_PORT" \
    -t "$IMAGE_PREFIX-$target:$IMAGE_TAG" "$REPO"
done

# record final image digests: the identity that snapshot provenance names
digest_manifest="$TIDEPOOL_HOME/exports/image-digests-$IMAGE_TAG.json"
{
  echo "{"
  first=1
  for target in collector api scheduler proxy utility; do
    d="$(podman image inspect --format '{{.Digest}}' "$IMAGE_PREFIX-$target:$IMAGE_TAG")"
    [ $first -eq 1 ] || echo ","
    first=0
    printf '  "tidepool-%s": "%s"' "$target" "$d"
  done
  echo ""
  echo "}"
} > "$digest_manifest"
echo "   digests   : $digest_manifest"

# ------------------------------------------------------------------- render
OUT_DIR="$REPO/deploy/quadlet/rendered" TIDEPOOL_HOME="$TIDEPOOL_HOME" \
  IMAGE_TAG="$IMAGE_TAG" LISTEN_ADDR="$LISTEN_ADDR" LISTEN_PORT="$LISTEN_PORT" \
  "$HERE/render.sh"

mkdir -p "$QUADLET_DIR" "$TIMER_DIR"
install -m 644 "$REPO"/deploy/quadlet/rendered/*.container "$QUADLET_DIR/"
install -m 644 "$REPO"/deploy/quadlet/rendered/tidepool-backup.service "$TIMER_DIR/" 2>/dev/null || true
install -m 644 "$REPO"/deploy/quadlet/rendered/tidepool-backup.timer "$TIMER_DIR/" 2>/dev/null || true
install -m 644 "$REPO"/deploy/quadlet/rendered/tidepool-verify.service "$TIMER_DIR/" 2>/dev/null || true
install -m 644 "$REPO"/deploy/quadlet/rendered/tidepool-verify.timer "$TIMER_DIR/" 2>/dev/null || true

# operator tooling next to the data — deploy.yaml and the loader travel with
# the scripts so installed tooling reads the same values the units used
install -m 755 "$HERE"/backup.sh "$HERE"/restore.sh "$HERE"/boundaries-verify.sh \
  "$HERE"/verify.sh "$HERE"/verify-host.sh "$HERE"/verify-install.sh \
  "$HERE"/verify-deployment.sh "$HERE"/verify-corpus.sh \
  "$HERE"/uninstall.sh \
  "$TIDEPOOL_HOME/bin/"
install -m 644 "$REPO/deploy/deploy.yaml" "$TIDEPOOL_HOME/bin/deploy.yaml"
mkdir -p "$TIDEPOOL_HOME/bin/lib"
install -m 644 "$HERE/lib/deploy-config.sh" "$TIDEPOOL_HOME/bin/lib/deploy-config.sh"
install -m 644 "$HERE/lib/verify-lib.sh" "$TIDEPOOL_HOME/bin/lib/verify-lib.sh"

systemctl --user daemon-reload

cat <<NEXT

== install complete — remaining ROOT steps (printed, not performed) ==

1. Keyrings: copy the archive keyrings your config references into
     $TIDEPOOL_HOME/keyrings/

2. TLS (if http.tls.mode is generated-local-ca, the default for LAN use):
     npm run tls init                     # creates the local CA + server cert
     npm run tls export-ca > tidepool-ca.crt   # install on LAN clients
   The CA private key stays under $TIDEPOOL_HOME/tls/ca/ and is never
   mounted into the proxy (only tls/server/ is).

3. Review, then start (independent services — no pod):
     systemctl --user start tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler
     systemctl --user enable tidepool-backup.timer tidepool-verify.timer
     loginctl enable-linger \$USER   # survive logout

4. Verify the deployment AND its boundaries:
     $TIDEPOOL_HOME/bin/verify.sh
     $TIDEPOOL_HOME/bin/boundaries-verify.sh
NEXT
