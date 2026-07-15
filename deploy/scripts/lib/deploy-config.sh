#!/usr/bin/env bash
# deploy/scripts/lib/deploy-config.sh — loader for deploy/deploy.yaml.
#
# Parses the flat `key: value` YAML subset (comments and blank lines
# ignored; no nesting, no lists — deploy.yaml documents this contract) with
# nothing but bash, so operator hosts need no yq/python.
#
# Usage:   source ".../lib/deploy-config.sh"   # sets DEPLOY_CFG_* variables
# Then:    LISTEN_PORT="${LISTEN_PORT:-$DEPLOY_CFG_LISTEN_PORT}"
#
# Search order for the file (first hit wins):
#   $TIDEPOOL_DEPLOY_CONFIG                      explicit override
#   <this lib>/../../deploy.yaml                 repository checkout layout
#   <this lib>/../deploy.yaml                    installed $TIDEPOOL_HOME/bin/lib
#   <sourcing script's dir>/deploy.yaml          installed $TIDEPOOL_HOME/bin
#
# Every variable comes with a built-in fallback identical to the historical
# hardcoded value, so a missing deploy.yaml degrades to prior behavior
# instead of failing.

# shellcheck disable=SC2034  # every DEPLOY_CFG_* is consumed by the sourcing script
_dc_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_dc_caller_dir="$(cd "$(dirname "${BASH_SOURCE[1]:-$0}")" && pwd)"

# fallbacks = the values that were hardcoded before deploy.yaml existed
DEPLOY_CFG_BASE_IMAGE="docker.io/library/node:22-bookworm-slim"
DEPLOY_CFG_IMAGE_PREFIX="localhost/tidepool"
DEPLOY_CFG_LISTEN_ADDR="127.0.0.1"
DEPLOY_CFG_LISTEN_PORT="8747"
DEPLOY_CFG_INTERNAL_PORT="8747"
DEPLOY_CFG_CONTAINER_UID="10001"
DEPLOY_CFG_CONTAINER_GID="10001"
DEPLOY_CFG_DATA_ROOT="$HOME/.local/share/tidepool"

_dc_file=""
for candidate in \
  "${TIDEPOOL_DEPLOY_CONFIG:-}" \
  "$_dc_lib_dir/../../deploy.yaml" \
  "$_dc_lib_dir/../deploy.yaml" \
  "$_dc_caller_dir/deploy.yaml"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    _dc_file="$candidate"
    break
  fi
done

if [ -n "$_dc_file" ]; then
  while IFS= read -r _dc_line; do
    _dc_line="${_dc_line%%#*}"                       # strip comments
    case "$_dc_line" in *:*) ;; *) continue ;; esac  # need key: value
    _dc_key="${_dc_line%%:*}"
    _dc_val="${_dc_line#*:}"
    # trim whitespace and optional quotes
    _dc_key="$(printf '%s' "$_dc_key" | tr -d '[:space:]')"
    _dc_val="$(printf '%s' "$_dc_val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
    case "$_dc_key" in
      *[!a-z_]*|"") continue ;;                      # flat snake_case keys only
    esac
    [ -n "$_dc_val" ] || continue
    _dc_val="${_dc_val/#\~/$HOME}"                   # expand leading ~
    # shellcheck disable=SC2140
    eval "DEPLOY_CFG_$(printf '%s' "$_dc_key" | tr '[:lower:]' '[:upper:]')=\"\$_dc_val\""
  done < "$_dc_file"
  DEPLOY_CFG_SOURCE="$_dc_file"
else
  DEPLOY_CFG_SOURCE="(built-in fallbacks — deploy.yaml not found)"
fi

unset _dc_lib_dir _dc_caller_dir _dc_file _dc_line _dc_key _dc_val

# Refuse to operate as root. The appliance is rootless by design: the data
# root is the APPLIANCE USER's XDG data dir, and a root invocation (sudo'd
# script, root cron) would silently build a parallel tree under
# /root/.local/share/tidepool instead of touching the real one. Scripts that
# read or write the data root call this; deliberate root-managed layouts can
# set TIDEPOOL_ALLOW_ROOT=1 together with an explicit TIDEPOOL_HOME.
deploy_config_refuse_root() {
  if [ "$(id -u)" -eq 0 ] && [ "${TIDEPOOL_ALLOW_ROOT:-0}" != "1" ]; then
    echo "refusing to run as root: the appliance is rootless, and ~ would resolve to /root, creating a parallel data tree." >&2
    echo "run as the appliance user — or, for a deliberate root-managed layout, set TIDEPOOL_ALLOW_ROOT=1 and an explicit TIDEPOOL_HOME." >&2
    exit 1
  fi
}
