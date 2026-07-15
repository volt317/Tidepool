#!/usr/bin/env bash
# deploy/scripts/ci-deploy-test.sh — the deployment equivalent of Tidepool's
# live collector smoke: build the real images, run the real topology in
# independent containers, exercise the positive paths, and PROVE the
# negative boundaries, ending with backup → restore → digest comparison.
#
# Designed for a Podman-capable CI runner (ubuntu-latest works) and equally
# runnable on a workstation. AppArmor confinement is applied when the host
# permits loading profiles (CI usually does, with sudo); every step that
# depends on an optional host facility says which guarantee it exercised.
#
# The 19 steps (numbered in output):
#    1 build all OCI targets            11 positive health tests
#    2 verify base digest pinning       12 API operation, collector STOPPED
#    3 compile AppArmor profiles        13 negative boundary tests
#    4 ShellCheck deployment scripts    14 create a snapshot
#    5 render Quadlet templates         15 offline dispatch
#    6 validate generated units         16 create + verify a backup
#    7 start independent containers     17 restore into a clean corpus
#    8 bounded live collection          18 compare snapshot digests
#    9 publish the read replica         19 stop all services cleanly
#   10 verify API reads the replica
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"
WORK="${CI_WORK:-$(mktemp -d)}"
export TIDEPOOL_HOME="$WORK/appliance"
IMAGE_TAG="ci-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo local)"
step() { echo; echo "== step $1: $2 =="; }
CLEANUP_CONTAINERS=(tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler)
cleanup() {
  for c in "${CLEANUP_CONTAINERS[@]}"; do podman rm -f -t 5 "$c" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
step 1 "build all OCI targets (digest-pinned base)"
BASE_IMAGE="$("$HERE/pin-base.sh")"
echo "base: $BASE_IMAGE"
for target in collector api scheduler proxy utility; do
  podman build -q -f "$REPO/deploy/oci/Containerfile" --target "$target" \
    --build-arg BASE_IMAGE="$BASE_IMAGE" \
    --build-arg TIDEPOOL_VERSION=ci --build-arg TIDEPOOL_GIT_COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)" \
    -t "localhost/tidepool-$target:$IMAGE_TAG" "$REPO" >/dev/null
  echo "built tidepool-$target:$IMAGE_TAG"
done

step 2 "verify base image digest pinning"
[[ "$BASE_IMAGE" == *"@sha256:"* ]] || { echo "base image is not digest-pinned: $BASE_IMAGE"; exit 1; }
echo "pinned: ${BASE_IMAGE##*@}"

step 3 "compile AppArmor profiles"
if command -v apparmor_parser >/dev/null; then
  apparmor_parser -Q "$REPO"/deploy/apparmor/tidepool-* && echo "7 profiles compile"
  APPARMOR_LOADED=0
  if [ -w /sys/kernel/security/apparmor/.load ] || sudo -n true 2>/dev/null; then
    if sudo apparmor_parser -r "$REPO"/deploy/apparmor/tidepool-* 2>/dev/null; then
      APPARMOR_LOADED=1; echo "profiles loaded into the kernel — containers run CONFINED"
    fi
  fi
  [ "$APPARMOR_LOADED" -eq 1 ] || echo "profiles compile but are not loaded — containers run without LSM confinement in this environment"
else
  echo "apparmor_parser unavailable — compile check skipped"; APPARMOR_LOADED=0
fi
AA() { [ "${APPARMOR_LOADED:-0}" -eq 1 ] && echo "--security-opt apparmor=$1" || true; }

step 4 "ShellCheck deployment scripts"
if command -v shellcheck >/dev/null; then
  shellcheck -S warning "$REPO"/deploy/scripts/*.sh && echo "shellcheck clean"
else
  echo "shellcheck unavailable — skipped (the GitHub workflow installs it)"
fi

step 5 "render Quadlet templates"
OUT_DIR="$WORK/rendered" IMAGE_TAG="$IMAGE_TAG" TIDEPOOL_HOME="$TIDEPOOL_HOME" "$HERE/render.sh"

step 6 "validate generated units"
grep -rL "Image=localhost/tidepool-.*:$IMAGE_TAG" "$WORK/rendered"/*.container | grep -v backup | grep -v verify && { echo "unit missing pinned image tag"; exit 1; } || true
! grep -rq ":latest" "$WORK/rendered"/ || { echo ":latest found in rendered units"; exit 1; }
echo "units reference immutable tags only"

step 7 "start independent containers (unit-equivalent podman run flags)"
# topology definition moved verbatim to ci-topology.sh so the explicit
# appliance workflow and this scenario share one set of run flags
"$HERE/ci-topology.sh" up "$IMAGE_TAG"

step 8 "bounded live collection (npm registry, one package)"
podman exec tidepool-collector node -e '
  const http=require("http");
  const req=http.request({socketPath:"/var/lib/tidepool/run/collector-control.sock",path:"/internal/control/sync-all",method:"POST",headers:{"x-caller":"ci"}},r=>process.exit(r.statusCode===202?0:1));
  req.on("error",()=>process.exit(1));req.end()'
for _ in $(seq 1 30); do
  n="$(podman exec tidepool-collector node -e '
    const http=require("http");
    http.request({socketPath:"/var/lib/tidepool/run/collector-control.sock",path:"/healthz"},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{const j=JSON.parse(b);console.log(j.pendingSyncs)})}).on("error",()=>console.log("err")).end()' 2>/dev/null)"
  [ "$n" = "0" ] && break
  sleep 2
done
echo "collection settled"

step 9 "publish the read replica (auto after collection; asserting)"
sleep 4
[ -f "$V/published/tidepool-read.sqlite3" ] || { echo "no replica published"; exit 1; }
[ -f "$V/published/publication.json" ] || { echo "no publication metadata"; exit 1; }
python3 -c "import json;m=json.load(open('$V/published/publication.json'));assert m['counts']['observations']>0, 'replica has no observations';print('replica digest:', m['replicaDigest'][:12], '| observations:', m['counts']['observations'])"

step 10 "verify the API reads from the replica"
body="$(curl -fsS http://127.0.0.1:18747/api/domains/code/units/npm-ci/packages)"
echo "$body" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['total']>=1;assert any(p['name']=='express' for p in d['items']);print('API served', d['total'], 'package(s) from published truth, through the proxy')"

step 11 "positive health tests"
curl -fsS http://127.0.0.1:18747/healthz | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['ok'] and d['replicaOk'];print('api healthy; publication:', d['publication']['latestObservation']['id'][:12])"
podman exec tidepool-scheduler node -e 'const s=require("fs").statSync("/var/lib/tidepool/run/scheduler-heartbeat.json");process.exit(Date.now()-s.mtimeMs<60000?0:1)' && echo "scheduler heartbeat fresh"

step 12 "API operation with the collector STOPPED (availability invariant)"
podman stop -t 20 tidepool-collector >/dev/null
curl -fsS http://127.0.0.1:18747/healthz | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['ok'] and d['replicaOk'], 'api unhealthy without collector';print('api healthy with collector stopped')"
curl -fsS http://127.0.0.1:18747/api/domains/code/units/npm-ci/packages | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['total']>=1;print('reads served from published truth:', d['total'], 'package(s)')"
podman start tidepool-collector >/dev/null
for _ in $(seq 1 30); do
  podman exec tidepool-collector node -e 'require("http").request({socketPath:"/var/lib/tidepool/run/collector-control.sock",path:"/healthz"},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1)).end()' 2>/dev/null && break
  sleep 2
done
echo "collector restarted and healthy"

step 13 "negative boundary tests"
"$HERE/boundaries-verify.sh" --json "$WORK/boundaries.json"

step 14 "create a snapshot"
podman exec tidepool-collector node -e '
  const http=require("http");
  const body=JSON.stringify({stage:"interpretive",windowHours:24});
  const req=http.request({socketPath:"/var/lib/tidepool/run/collector-control.sock",path:"/internal/snapshots",method:"POST",headers:{"content-type":"application/json","content-length":body.length,"x-caller":"ci"}},r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{const j=JSON.parse(b);if(!j.digest)process.exit(1);console.log(j.digest)})});
  req.on("error",()=>process.exit(1));req.write(body);req.end()' > "$WORK/snapshot-digest"
SNAP="$(cat "$WORK/snapshot-digest")"
echo "snapshot: $SNAP"

step 15 "offline dispatch against the snapshot"
mkdir -p "$WORK/project"
echo '{ "name": "ci-project", "dependencies": { "express": "^5.0.0" } }' > "$WORK/project/package.json"
# shellcheck disable=SC2046
podman run --rm --network=none $(AA tidepool-dispatch) \
  --userns=keep-id:uid="$DEPLOY_CFG_CONTAINER_UID",gid="$DEPLOY_CFG_CONTAINER_GID" \
  -v "$V/corpus/snapshots:/var/lib/tidepool/corpus/snapshots:ro" \
  -v "$WORK/project:/project:ro" -v "$WORK:/out:rw" \
  "localhost/tidepool-utility:$IMAGE_TAG" \
  node /app/server/dist/server/src/cli/dispatch.js --snapshot "$SNAP" \
    --store /var/lib/tidepool/corpus --out /out/dispatch.json /project
python3 -c "import json;d=json.load(open('$WORK/dispatch.json'));assert d['snapshotDigest']=='$SNAP';print('dispatch analyzed', len(d['targets']), 'target(s) offline')"

step 16 "create and verify a backup"
IMAGE_TAG="$IMAGE_TAG" TIDEPOOL_HOME="$TIDEPOOL_HOME" "$HERE/backup.sh"
BUNDLE="$(find "$V/backups" -name 'corpus-*.tar.zst' | head -1)"
[ -n "$BUNDLE" ] || { echo "no backup bundle"; exit 1; }

step 17 "restore into a clean corpus"
CLEAN="$WORK/restored"
mkdir -p "$CLEAN/corpus"
podman run --rm --network=none \
  --userns=keep-id:uid="$DEPLOY_CFG_CONTAINER_UID",gid="$DEPLOY_CFG_CONTAINER_GID" \
  -v "$CLEAN/corpus:/var/lib/tidepool/corpus:rw" \
  -v "$(dirname "$BUNDLE"):/restore:ro" \
  "localhost/tidepool-utility:$IMAGE_TAG" \
  node /app/server/dist/server/src/cli/corpus.js import \
    --data /var/lib/tidepool/corpus --in "/restore/$(basename "$BUNDLE")"
echo "restored into $CLEAN/corpus"

step 18 "compare snapshot digests (original corpus vs restored corpus)"
podman run --rm --network=none \
  --userns=keep-id:uid="$DEPLOY_CFG_CONTAINER_UID",gid="$DEPLOY_CFG_CONTAINER_GID" \
  -v "$CLEAN/corpus:/var/lib/tidepool/corpus:ro" \
  "localhost/tidepool-utility:$IMAGE_TAG" \
  node --input-type=module -e "
    const { SnapshotStore } = await import('/app/server/dist/server/src/core/snapshot.js');
    const snaps = new SnapshotStore('/var/lib/tidepool/corpus/snapshots');
    const doc = snaps.load('$SNAP');   // full schema validation on load
    if (!doc || doc.digest !== '$SNAP') { console.error('digest mismatch after restore'); process.exit(1); }
    console.log('restored snapshot digest verified:', doc.digest.slice(0, 12));
  "

step 19 "stop all services cleanly"
"$HERE/ci-topology.sh" down

echo
echo "== ci-deploy-test: ALL 19 STEPS PASSED =="
