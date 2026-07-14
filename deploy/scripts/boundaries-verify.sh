#!/usr/bin/env bash
# deploy/scripts/boundaries-verify.sh — NEGATIVE tests: prove the prohibited
# operations actually fail. Positive health belongs to verify.sh; this
# script's entire job is attempting what must not work and treating success
# as failure.
#
#   usage: boundaries-verify.sh [--json /path/out.json]
#
# Exit 0 = every boundary held. Exit 1 = at least one prohibited operation
# SUCCEEDED (treat as an incident, not a flake) or a required container is
# not running.
#
# Every test names the enforcement layer it exercises, so a failure message
# says which layer regressed (mount set, network namespace, AppArmor,
# SQLite mode, or published-port set).
set -uo pipefail

JSON_OUT=""
[ "${1:-}" = "--json" ] && JSON_OUT="${2:-}"

declare -a RESULTS=()
FAILURES=0

# record <suite> <name> <expected-to-fail-cmd-result: 0 means the forbidden
# thing SUCCEEDED> <layer> <detail>
record() {
  local suite="$1" name="$2" forbidden_succeeded="$3" layer="$4" detail="$5"
  local ok
  if [ "$forbidden_succeeded" -eq 0 ]; then
    ok=false; FAILURES=$((FAILURES + 1))
    printf 'FAIL  %-10s %-46s [%s]\n' "$suite" "$name" "$layer"
    printf '      the prohibited operation SUCCEEDED: %s\n' "$detail"
  else
    ok=true
    printf 'hold  %-10s %-46s [%s]\n' "$suite" "$name" "$layer"
  fi
  RESULTS+=("{\"suite\":\"$suite\",\"test\":\"$name\",\"held\":$ok,\"layer\":\"$layer\",\"detail\":\"$detail\"}")
}

running() { podman container exists "$1" 2>/dev/null && [ "$(podman inspect -f '{{.State.Running}}' "$1")" = "true" ]; }

require_running() {
  if ! running "$1"; then
    printf 'SKIP  %s is not running — boundary tests require live containers\n' "$1"
    RESULTS+=("{\"suite\":\"$1\",\"test\":\"container-running\",\"held\":false,\"layer\":\"deployment\",\"detail\":\"container not running\"}")
    FAILURES=$((FAILURES + 1))
    return 1
  fi
}

X() { podman exec "$@" >/dev/null 2>&1; } # quiet exec

echo "== Tidepool boundary verification (negative tests) =="

# ---------------------------------------------------------------- API suite
if require_running tidepool-api; then
  X tidepool-api node -e 'require("fs").writeFileSync("/var/lib/tidepool/corpus/writer/x","")'
  record api write-writer-corpus $? "mount-set+apparmor" "writer/ is not mounted and is denied by name"

  X tidepool-api node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/var/lib/tidepool/corpus/writer/tidepool.sqlite3");d.exec("SELECT 1")'
  record api open-writable-authoritative-db $? "mount-set" "no path to the authoritative database exists in this namespace"

  X tidepool-api node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/var/lib/tidepool/published/tidepool-read.sqlite3");d.exec("CREATE TABLE pwned(x)")'
  record api write-published-replica $? "ro-mount+sqlite-readonly" "published/ is a read-only mount; connections are SQLITE_OPEN_READONLY"

  X tidepool-api node -e 'require("fs").readdirSync("/var/lib/tidepool/keyrings")'
  record api read-keyrings $? "mount-set+apparmor" "keyrings are not mounted and are denied by profile"

  X tidepool-api node -e 'require("fs").readdirSync("/var/lib/tidepool/cache")'
  record api read-collector-cache $? "mount-set+apparmor" "the TTL cache is private collector state"

  X tidepool-api timeout 8 node -e 'fetch("https://example.com").then(()=>process.exit(0),()=>process.exit(1))'
  record api reach-internet $? "network-none" "the container has no network namespace connectivity"

  X tidepool-api /bin/sh -c 'true'
  record api execute-shell $? "apparmor" "only node may execute"

  # invariant 10 exercised end-to-end through the real listener
  code="$(podman exec tidepool-api node -e 'require("http").request({socketPath:"/var/lib/tidepool/run/api.sock",path:"/api/domains/code/units/any/sync",method:"POST"},r=>{console.log(r.statusCode);process.exit(0)}).on("error",()=>{console.log(0);process.exit(0)}).end()' 2>/dev/null)"
  [ "$code" = "405" ]; rc=$?
  record api trigger-collection-via-api "$([ $rc -eq 0 ] && echo 1 || echo 0)" "application" "sync routes answer 405 (got: ${code:-none})"
fi

# ---------------------------------------------------------- scheduler suite
if require_running tidepool-scheduler; then
  X tidepool-scheduler node -e 'require("fs").readdirSync("/var/lib/tidepool/corpus")'
  record scheduler read-corpus $? "mount-set+apparmor" "no corpus tree exists in this namespace"

  X tidepool-scheduler node -e 'require("fs").readdirSync("/var/lib/tidepool/keyrings")'
  record scheduler read-keyrings $? "mount-set+apparmor" "keyrings are not mounted"

  X tidepool-scheduler timeout 8 node -e 'fetch("https://example.com").then(()=>process.exit(0),()=>process.exit(1))'
  record scheduler reach-internet $? "network-none" "no network namespace connectivity"

  X tidepool-scheduler timeout 5 node -e 'require("net").createServer().listen(9999,"0.0.0.0",()=>{require("http").get("http://127.0.0.1:9999",()=>{}).on("error",()=>{});setTimeout(()=>process.exit(0),500)}).on("error",()=>process.exit(1))'
  record scheduler tcp-listen-meaningful $? "network-none+apparmor" "inet sockets are denied by profile; the namespace has no external reachability"

  X tidepool-scheduler /bin/sh -c 'true'
  record scheduler execute-shell $? "apparmor" "only node may execute"
fi

# ---------------------------------------------------------- collector suite
if require_running tidepool-collector; then
  ports="$(podman port tidepool-collector 2>/dev/null | wc -l)"
  [ "$ports" -eq 0 ]; rc=$?
  record collector published-tcp-port "$([ $rc -eq 0 ] && echo 1 || echo 0)" "quadlet" "podman port must list nothing (listed: $ports)"

  X tidepool-collector /bin/sh -c 'true'
  record collector execute-shell $? "apparmor" "only node and gpgv may execute"

  X tidepool-collector node -e 'require("fs").readdirSync("/project")'
  record collector read-dispatch-mounts $? "mount-set" "project paths belong to dispatch jobs, never the collector"

  X tidepool-collector node -e 'require("fs").readdirSync("/root")'
  record collector read-host-paths $? "mount-set+apparmor" "no host paths beyond the declared mounts"
fi

# -------------------------------------------------------------- proxy suite
if require_running tidepool-proxy; then
  X tidepool-proxy node -e 'require("fs").readdirSync("/var/lib/tidepool/corpus")'
  record proxy read-corpus $? "mount-set+apparmor" "the network-facing process holds no data"

  X tidepool-proxy node -e 'require("fs").readdirSync("/var/lib/tidepool/published")'
  record proxy read-published $? "mount-set+apparmor" "not even the replica — the proxy forwards bytes, it does not read truth"

  X tidepool-proxy node -e 'require("http").request({socketPath:"/var/lib/tidepool/run/collector-control.sock",path:"/healthz"},()=>process.exit(0)).on("error",()=>process.exit(1)).end()'
  record proxy dial-collector-control $? "socket-permissions" "control socket is not the proxy's to dial"

  X tidepool-proxy /bin/sh -c 'true'
  record proxy execute-shell $? "apparmor" "only node may execute"
fi

# ----------------------------------------------------------- dispatch suite
# Dispatch is a job, not a service: run a disposable container the way
# dispatch jobs actually run, with a symlink escape planted in the project.
UTILITY_IMAGE="$(podman images --format '{{.Repository}}:{{.Tag}}' | grep '^localhost/tidepool-utility:' | head -1)"
if [ -n "$UTILITY_IMAGE" ]; then
  workdir="$(mktemp -d)"
  echo '{"name":"probe"}' > "$workdir/package.json"
  ln -s /etc/passwd "$workdir/escape"

  podman run --rm --network=none -v "$workdir:/project:ro" "$UTILITY_IMAGE" \
    timeout 8 node -e 'fetch("https://example.com").then(()=>process.exit(0),()=>process.exit(1))' >/dev/null 2>&1
  record dispatch reach-internet $? "network-none" "dispatch jobs run with --network=none"

  podman run --rm --network=none -v "$workdir:/project:ro" "$UTILITY_IMAGE" \
    node -e 'require("fs").writeFileSync("/project/tampered","")' >/dev/null 2>&1
  record dispatch modify-project-path $? "ro-mount" "project mounts are read-only"

  podman run --rm --network=none -v "$workdir:/project:ro" "$UTILITY_IMAGE" \
    node -e 'const c=require("fs").readFileSync("/project/escape","utf8");process.exit(c.includes("root:")?0:1)' >/dev/null 2>&1
  record dispatch symlink-escape-to-host $? "mount-namespace" "a symlink to /etc/passwd must not resolve to host content"

  podman run --rm --network=none -v "$workdir:/project:ro" "$UTILITY_IMAGE" \
    node -e 'require("fs").readdirSync("/var/lib/tidepool/corpus")' >/dev/null 2>&1
  record dispatch read-corpus $? "mount-set" "dispatch consumes a snapshot, never the corpus"

  rm -rf "$workdir"
else
  echo "SKIP  dispatch suite — no localhost/tidepool-utility image found"
fi

# ------------------------------------------------------------------- output
total=${#RESULTS[@]}
held=$((total - FAILURES))
echo
echo "== boundaries: $held/$total held =="

if [ -n "$JSON_OUT" ]; then
  {
    echo "{"
    echo "  \"verifiedAt\": \"$(date -u +%FT%TZ)\","
    echo "  \"total\": $total,"
    echo "  \"held\": $held,"
    echo "  \"ok\": $([ "$FAILURES" -eq 0 ] && echo true || echo false),"
    echo "  \"results\": ["
    printf '    %s' "${RESULTS[0]:-}"
    for r in "${RESULTS[@]:1}"; do printf ',\n    %s' "$r"; done
    echo
    echo "  ]"
    echo "}"
  } > "$JSON_OUT"
  echo "json report: $JSON_OUT"
fi

[ "$FAILURES" -eq 0 ]
