#!/usr/bin/env bash
# deploy/scripts/render.sh — render Quadlet templates for THIS deployment.
#
# The templates carry @PLACEHOLDERS@ so that the installed units always
# agree with where the data actually lives (the spec's rule: never install
# fixed-path Quadlets while creating data directories elsewhere).
#
#   TIDEPOOL_HOME    data root            (default ~/.local/share/tidepool)
#   IMAGE_TAG        immutable image tag  (default 0.3.0-g<commit>)
#   LISTEN_ADDR      proxy bind address   (default 127.0.0.1)
#   LISTEN_PORT      proxy port           (default 8747)
#
# Renders into $OUT_DIR (default: deploy/quadlet/rendered), validates that
# no placeholder survived, and — where the quadlet generator binary is
# available — runs its dryrun so a syntactically broken unit fails HERE,
# not at boot.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TEMPLATES="$REPO/deploy/quadlet/templates"

TIDEPOOL_HOME="${TIDEPOOL_HOME:-$HOME/.local/share/tidepool}"
LISTEN_ADDR="${LISTEN_ADDR:-127.0.0.1}"
LISTEN_PORT="${LISTEN_PORT:-8747}"
OUT_DIR="${OUT_DIR:-$REPO/deploy/quadlet/rendered}"

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
    -e "s|@COLLECTOR_IMAGE@|localhost/tidepool-collector:$IMAGE_TAG|g" \
    -e "s|@API_IMAGE@|localhost/tidepool-api:$IMAGE_TAG|g" \
    -e "s|@SCHEDULER_IMAGE@|localhost/tidepool-scheduler:$IMAGE_TAG|g" \
    -e "s|@PROXY_IMAGE@|localhost/tidepool-proxy:$IMAGE_TAG|g" \
    -e "s|@LISTEN_ADDR@|$LISTEN_ADDR|g" \
    -e "s|@LISTEN_PORT@|$LISTEN_PORT|g" \
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

echo "render: ${#rendered[@]} unit(s) → $OUT_DIR"
echo "render: images tagged $IMAGE_TAG; data root $TIDEPOOL_HOME; listener $LISTEN_ADDR:$LISTEN_PORT"
echo "render: quadlet-set digest $QUADLET_DIGEST"
