#!/usr/bin/env bash
# deploy/scripts/http-security-test.sh — the HTTP-layer gate.
#
# Generates a temporary local CA + server cert, starts the API (Unix
# socket) and the proxy (HTTPS) as plain processes, and asserts the
# strict-admission contract end to end: route manifest, method policy,
# body/query/framing rejection, security headers, per-route caching, TLS
# version policy, CA-key confinement, and stable API-down behavior. Uses
# raw-socket framing tests over the TLS connection (openssl s_client), not
# just a well-behaved HTTP client.
#
# Runs on any host with node + openssl + curl; the CI job wraps it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
PORT="${HTTP_TEST_PORT:-8791}"
FAIL=0
declare -a PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

check() { # check <name> <actual> <expected>
  if [ "$2" = "$3" ]; then printf 'ok    %-42s %s\n' "$1" "$2"; else printf 'FAIL  %-42s got %s want %s\n' "$1" "$2" "$3"; FAIL=1; fi
}

command -v openssl >/dev/null || { echo "openssl required"; exit 1; }

# ---- config + TLS ----------------------------------------------------------
export TIDEPOOL_HOME="$WORK/home"
export TIDEPOOL_CONFIG="$WORK/config.json"
mkdir -p "$TIDEPOOL_HOME"/{data,cache,run,published}
cat > "$TIDEPOOL_CONFIG" <<CFG
{
  "server": { "port": $PORT, "dataDir": "$TIDEPOOL_HOME/data", "cacheDir": "$TIDEPOOL_HOME/cache" },
  "distros": [], "ecosystems": [], "enrichment": {},
  "http": {
    "enabled": true, "listenAddress": "127.0.0.1", "port": $PORT,
    "allowedHosts": ["localhost", "127.0.0.1"],
    "tls": { "mode": "generated-local-ca", "serverNames": ["localhost"], "ipAddresses": ["127.0.0.1"], "keyAlgorithm": "ec-p256", "certLifetimeDays": 90 },
    "limits": { "maxQueryBytes": 4096, "maxHeaders": 50 }
  }
}
CFG

node "$REPO/server/dist/server/src/cli/tls.js" init >/dev/null 2>&1
CA="$TIDEPOOL_HOME/data/tls/ca/tidepool-local-ca.crt"
[ -f "$CA" ] || { echo "TLS init failed"; exit 1; }

# ---- CA private key confinement (files exist where expected, not elsewhere)
check "ca-key-under-ca-dir" "$([ -f "$TIDEPOOL_HOME/data/tls/ca/tidepool-local-ca.key" ] && echo yes)" "yes"
check "ca-key-not-under-server-dir" "$([ -f "$TIDEPOOL_HOME/data/tls/server/tidepool-local-ca.key" ] && echo yes || echo no)" "no"
check "server-key-perms-0600" "$(stat -c %a "$TIDEPOOL_HOME/data/tls/server/tidepool.key")" "600"
check "ca-key-perms-0600" "$(stat -c %a "$TIDEPOOL_HOME/data/tls/ca/tidepool-local-ca.key")" "600"

# ---- start API (unix) + proxy (https) --------------------------------------
# minimal published replica so readiness can pass isn't required for these
# protocol tests; the API answers /api/domains from an empty store.
TIDEPOOL_API_LISTEN=unix TIDEPOOL_SERVE_STATIC=0 node "$REPO/server/dist/server/src/services/api.js" >"$WORK/api.log" 2>&1 &
PIDS+=($!)
sleep 2
node "$REPO/server/dist/server/src/services/proxy.js" >"$WORK/proxy.log" 2>&1 &
PIDS+=($!)
sleep 2

U="https://localhost:$PORT"
c() { curl -s -o /dev/null -w "%{http_code}" --cacert "$CA" --resolve "localhost:$PORT:127.0.0.1" "$@"; }

# ---- TLS handshake + route manifest ---------------------------------------
check "tls-valid-request"        "$(c "$U/api/domains")" "200"
check "unknown-route-404"        "$(c "$U/api/nope")" "404"
check "mutation-post-405"        "$(c -X POST "$U/api/snapshots")" "405"
check "put-405"                  "$(c -X PUT "$U/api/domains")" "405"
check "delete-405"               "$(c -X DELETE "$U/api/domains")" "405"
check "get-body-413"             "$(c -H 'Content-Length: 5' --data-binary hello -G "$U/api/domains")" "413"
check "unknown-query-400"        "$(c "$U/api/domains?evil=1")" "400"
check "oversized-query-414"      "$(c "$U/api/domains?q=$(printf 'A%.0s' $(seq 1 5000))")" "414"
check "traversal-404"            "$(c "$U/api/../../etc/passwd")" "404"
check "bad-digest-404"           "$(c "$U/api/snapshots/nothex")" "404"
check "disallowed-host-400"      "$(c -H 'Host: evil.example.com' "$U/api/domains")" "400"
check "liveness-200"             "$(c "$U/health/live")" "200"

# ---- security headers + caching -------------------------------------------
HDR="$(curl -s -D- -o /dev/null --cacert "$CA" --resolve "localhost:$PORT:127.0.0.1" "$U/api/domains")"
grep -qi "^content-security-policy: default-src 'none'" <<<"$HDR" && check "csp-strict" yes yes || check "csp-strict" no yes
grep -qi "^x-content-type-options: nosniff" <<<"$HDR" && check "nosniff" yes yes || check "nosniff" no yes
grep -qi "^x-frame-options: DENY" <<<"$HDR" && check "frame-deny" yes yes || check "frame-deny" no yes
grep -qi "^cache-control: no-store" <<<"$HDR" && check "api-no-store" yes yes || check "api-no-store" no yes
grep -qi "^access-control-allow-origin" <<<"$HDR" && check "cors-absent" no yes || check "cors-absent" yes yes
grep -qi "^x-powered-by" <<<"$HDR" && check "no-x-powered-by" no yes || check "no-x-powered-by" yes yes
grep -qi "^server:" <<<"$HDR" && check "no-server-banner" no yes || check "no-server-banner" yes yes

# ---- TLS version policy ----------------------------------------------------
echo | openssl s_client -connect "127.0.0.1:$PORT" -tls1_1 >/dev/null 2>&1 && check "tls1.1-rejected" accepted rejected || check "tls1.1-rejected" rejected rejected
echo | openssl s_client -connect "127.0.0.1:$PORT" -servername localhost -tls1_2 >/dev/null 2>&1 && check "tls1.2-accepted" ok ok || check "tls1.2-accepted" fail ok
echo | openssl s_client -connect "127.0.0.1:$PORT" -servername localhost -tls1_3 >/dev/null 2>&1 && check "tls1.3-accepted" ok ok || check "tls1.3-accepted" fail ok

# ---- raw-socket framing over TLS (smuggling-style) -------------------------
raw() { printf '%b' "$1" | openssl s_client -quiet -connect "127.0.0.1:$PORT" -servername localhost 2>/dev/null | head -1; }
DUP_CL="$(raw 'GET /api/domains HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nContent-Length: 5\r\n\r\n')"
grep -q "400" <<<"$DUP_CL" && check "raw-dup-content-length-400" ok ok || check "raw-dup-content-length-400" "$DUP_CL" "400-line"
CL_TE="$(raw 'GET /api/domains HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n')"
grep -qE "40[03]" <<<"$CL_TE" && check "raw-cl+te-rejected" ok ok || check "raw-cl+te-rejected" "$CL_TE" "40x-line"

# ---- API-down stable error -------------------------------------------------
kill "${PIDS[0]}" 2>/dev/null; sleep 2
DOWN="$(c "$U/api/domains")"
check "api-down-503-or-502" "$([ "$DOWN" = "503" ] || [ "$DOWN" = "502" ] && echo ok)" "ok"
# and no socket path disclosed in the body
BODY="$(curl -s --cacert "$CA" --resolve "localhost:$PORT:127.0.0.1" "$U/api/domains")"
grep -q "run/api.sock\|/var/lib" <<<"$BODY" && check "api-down-no-path-disclosure" leaked clean || check "api-down-no-path-disclosure" clean clean

echo
[ "$FAIL" -eq 0 ] && echo "== http-security: ALL CHECKS PASSED ==" || echo "== http-security: FAILURES ABOVE =="
exit "$FAIL"
