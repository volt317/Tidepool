#!/usr/bin/env bash
# deploy/scripts/uninstall.sh — backtrack everything install.sh (and the
# printed root steps) put on this host. The mirror of install.sh's stance:
# unprivileged removals are PERFORMED, root removals are PRINTED.
#
#   ./deploy/scripts/uninstall.sh                 # remove runtime, keep data
#   ./deploy/scripts/uninstall.sh --keep-images   # also keep built images
#   ./deploy/scripts/uninstall.sh --purge-data    # ALSO delete the data root
#                                                 # (typed confirmation, or
#                                                 #  TIDEPOOL_UNINSTALL_FORCE=1)
#
# DATA POLICY: the corpus is recorded evidence, backups are its history,
# config and keyrings are operator-authored. None of it is removed unless
# --purge-data is given and confirmed. Everything else — services, timers,
# unit files, containers, images, installed tooling — is reproducible from
# the repository and is removed.
#
# Idempotent: absent artifacts report "absent" and the script continues.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"

TIDEPOOL_HOME="${TIDEPOOL_HOME:-$DEPLOY_CFG_DATA_ROOT}"
IMAGE_PREFIX="${IMAGE_PREFIX:-$DEPLOY_CFG_IMAGE_PREFIX}"
QUADLET_DIR="$HOME/.config/containers/systemd"
TIMER_DIR="$HOME/.config/systemd/user"

SERVICES=(tidepool-collector tidepool-api tidepool-proxy tidepool-scheduler)
TIMERS=(tidepool-backup tidepool-verify)
TARGETS=(collector api scheduler proxy utility)

KEEP_IMAGES=0
PURGE_DATA=0
for arg in "$@"; do
  case "$arg" in
    --keep-images) KEEP_IMAGES=1 ;;
    --purge-data)  PURGE_DATA=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "uninstall: unknown argument '$arg' (--keep-images, --purge-data)" >&2; exit 2 ;;
  esac
done

FAIL=0
did()    { printf 'removed   %s\n' "$1"; }
absent() { printf 'absent    %s\n' "$1"; }
kept()   { printf 'kept      %s\n' "$1"; }
oops()   { printf 'FAILED    %s\n' "$1"; FAIL=1; }

main() {
  echo "== tidepool uninstall — data root: $TIDEPOOL_HOME =="

  # ------------------------------------------------------ services & timers
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    for t in "${TIMERS[@]}"; do
      systemctl --user disable --now "$t.timer" >/dev/null 2>&1 || true
    done
    for s in "${SERVICES[@]}" "${TIMERS[@]}"; do
      systemctl --user stop "$s.service" >/dev/null 2>&1 || true
    done
    systemctl --user reset-failed 'tidepool-*' >/dev/null 2>&1 || true
    did "services stopped, timers disabled, failure latches cleared"
  else
    absent "systemd user session (nothing to stop here)"
  fi

  # ------------------------------------------------------------- containers
  if command -v podman >/dev/null; then
    leftovers="$(podman ps -a --format '{{.Names}}' 2>/dev/null | grep '^tidepool-' || true)"
    if [[ -n "$leftovers" ]]; then
      # shellcheck disable=SC2086  # word-splitting the name list is the point
      podman rm -f -i $leftovers >/dev/null 2>&1 && did "containers: $(tr '\n' ' ' <<<"$leftovers")" \
        || oops "containers: podman rm reported errors"
    else
      absent "containers named tidepool-*"
    fi
  else
    absent "podman (no containers or images to remove)"
  fi

  # -------------------------------------------------------------- unit files
  removed_units=0
  for s in "${SERVICES[@]}"; do
    if [[ -f "$QUADLET_DIR/$s.container" ]]; then rm -f "$QUADLET_DIR/$s.container"; removed_units=1; fi
  done
  for t in "${TIMERS[@]}"; do
    for ext in service timer; do
      if [[ -f "$TIMER_DIR/$t.$ext" ]]; then rm -f "$TIMER_DIR/$t.$ext"; removed_units=1; fi
    done
  done
  if [[ "$removed_units" -eq 1 ]]; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    did "unit files ($QUADLET_DIR, $TIMER_DIR) + daemon-reload"
  else
    absent "unit files"
  fi

  # ------------------------------------------------------------------ images
  if command -v podman >/dev/null; then
    if [[ "$KEEP_IMAGES" -eq 1 ]]; then
      kept "images (--keep-images)"
    else
      removed_any=0
      for target in "${TARGETS[@]}"; do
        imgs="$(podman images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep "^$IMAGE_PREFIX-$target:" || true)"
        if [[ -n "$imgs" ]]; then
          # shellcheck disable=SC2086
          podman rmi -f $imgs >/dev/null 2>&1 && removed_any=1 || oops "images: podman rmi $target reported errors"
        fi
      done
      [[ "$removed_any" -eq 1 ]] && did "images ($IMAGE_PREFIX-{collector,api,scheduler,proxy,utility}, all tags)" \
                                 || absent "images ($IMAGE_PREFIX-*)"
    fi
  fi

  # ------------------------------------------------------- installed tooling
  # bin/ is ours (scripts + deploy.yaml copies); safe even while this script
  # runs from it — main() was fully parsed before execution began.
  if [[ -d "$TIDEPOOL_HOME/bin" ]]; then
    rm -rf "${TIDEPOOL_HOME:?}/bin" && did "operator tooling ($TIDEPOOL_HOME/bin)" || oops "tooling: rm failed"
  else
    absent "operator tooling ($TIDEPOOL_HOME/bin)"
  fi

  # -------------------------------------------------------------------- data
  if [[ -d "$TIDEPOOL_HOME" ]]; then
    if [[ "$PURGE_DATA" -eq 1 ]]; then
      echo ""
      echo "  --purge-data will DELETE: $TIDEPOOL_HOME"
      du -sh "$TIDEPOOL_HOME" 2>/dev/null | sed 's/^/  /'
      echo "  This includes the corpus (recorded evidence), backups, config,"
      echo "  and keyrings. There is no undo. Consider bin/backup.sh first."
      if [[ "${TIDEPOOL_UNINSTALL_FORCE:-0}" == "1" ]]; then
        confirmed=1
      else
        printf '  Type the full path to confirm: '
        read -r answer
        [[ "$answer" == "$TIDEPOOL_HOME" ]] && confirmed=1 || confirmed=0
      fi
      if [[ "$confirmed" -eq 1 ]]; then
        rm -rf "${TIDEPOOL_HOME:?}" && did "data root $TIDEPOOL_HOME (purged)" || oops "purge: rm failed"
      else
        kept "data root (confirmation did not match — nothing deleted)"
      fi
    else
      kept "data root $TIDEPOOL_HOME (corpus, backups, config, keyrings, exports)"
      echo "          re-run with --purge-data to delete it"
    fi
  else
    absent "data root $TIDEPOOL_HOME"
  fi

  # ------------------------------------------------------------- root steps
  cat <<EOF

== remaining ROOT steps (printed, not performed) ==

1. If you added a ufw rule for the proxy port:
     sudo ufw status numbered        # find it
     sudo ufw delete <number>

2. Linger — ONLY if nothing else of yours should survive logout
   (this affects ALL your user services, not just Tidepool):
     loginctl disable-linger \$USER

Nothing above is required for a re-install; install.sh is idempotent over
leftover root artifacts.
EOF

  exit "$FAIL"
}

main "$@"
