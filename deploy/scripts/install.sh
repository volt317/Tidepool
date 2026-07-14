#!/usr/bin/env bash
# deploy/scripts/install.sh
#
# One-shot installer for the rootless Tidepool appliance. Idempotent: safe
# to re-run after pulling a new release (it rebuilds images and re-installs
# units; the corpus and config are never touched once they exist).
#
#   ./deploy/scripts/install.sh                # everything except AppArmor
#   sudo ./deploy/scripts/install.sh apparmor  # kernel profile load (root)
#
# What it sets up (host side):
#   ~/.local/share/tidepool/config/    tidepool.config.json (seeded once)
#   ~/.local/share/tidepool/keyrings/  distro archive keyrings (copied ro)
#   ~/.local/share/tidepool/corpus/    durable evidence (created empty)
#   ~/.local/share/tidepool/backups/   corpus backups
#   ~/.local/share/tidepool/bin/       backup.sh for ExecStartPre use
#   ~/.config/containers/systemd/      Quadlet units
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${TIDEPOOL_HOME:-$HOME/.local/share/tidepool}"
QUADLET_DIR="$HOME/.config/containers/systemd"

# ---------------------------------------------------------------- apparmor
# Root-only step, deliberately separate: rootless containers can be CONFINED
# by AppArmor, but only root can LOAD profiles into the kernel.
if [[ "${1:-}" == "apparmor" ]]; then
  [[ $EUID -eq 0 ]] || { echo "apparmor step must run as root"; exit 1; }
  for p in tidepool-collector tidepool-api tidepool-scheduler tidepool-dispatch; do
    install -m 644 "$REPO/deploy/apparmor/$p" "/etc/apparmor.d/$p"
    apparmor_parser -r "/etc/apparmor.d/$p"
    echo "loaded AppArmor profile: $p"
  done
  exit 0
fi

[[ $EUID -ne 0 ]] || { echo "run the main install as your rootless user (only the 'apparmor' step is root)"; exit 1; }
command -v podman >/dev/null || { echo "podman is required"; exit 1; }

echo "==> host layout under $BASE"
mkdir -p "$BASE"/{config,keyrings,corpus,backups,bin}
chmod 700 "$BASE" "$BASE/corpus" "$BASE/backups"
chmod 755 "$BASE/config" "$BASE/keyrings"

# seed config exactly once — it is the operator's document from then on
if [[ ! -f "$BASE/config/tidepool.config.json" ]]; then
  install -m 644 "$REPO/tidepool.config.json" "$BASE/config/tidepool.config.json"
  echo "    seeded config (edit $BASE/config/tidepool.config.json, then: systemctl --user restart tidepool-api)"
fi

# copy whichever configured archive keyrings exist on this host; the
# collector validates availability at startup and fails closed per-distro
echo "==> keyrings"
copied=0
for k in /usr/share/keyrings/ubuntu-archive-keyring.gpg \
         /usr/share/keyrings/debian-archive-keyring.gpg \
         /usr/share/keyrings/debian-archive-bookworm-stable.gpg \
         /usr/share/keyrings/debian-archive-bookworm-automatic.gpg \
         /usr/share/keyrings/debian-archive-bookworm-security-automatic.gpg; do
  [[ -f "$k" ]] && install -m 444 "$k" "$BASE/keyrings/$(basename "$k")" && copied=$((copied+1))
done
echo "    $copied keyring(s) staged (install ubuntu-keyring / debian-archive-keyring for more,"
echo "    then point config .index.keyrings at /var/lib/tidepool/keyrings/<file>)"

echo "==> building images (this compiles the release inside the build stage)"
for target in collector api scheduler utility; do
  podman build -q -f "$REPO/deploy/oci/Containerfile" --target "$target" -t "localhost/tidepool-$target:latest" "$REPO"
  echo "    localhost/tidepool-$target:latest"
done

echo "==> backup helper (used manually and by the optional ExecStartPre)"
install -m 755 "$REPO/deploy/scripts/backup.sh" "$BASE/bin/backup.sh"

echo "==> quadlet units"
mkdir -p "$QUADLET_DIR"
install -m 644 "$REPO"/deploy/quadlet/tidepool.pod "$QUADLET_DIR/"
install -m 644 "$REPO"/deploy/quadlet/tidepool-collector.container "$QUADLET_DIR/"
install -m 644 "$REPO"/deploy/quadlet/tidepool-api.container "$QUADLET_DIR/"
install -m 644 "$REPO"/deploy/quadlet/tidepool-scheduler.container "$QUADLET_DIR/"
systemctl --user daemon-reload

cat <<EOF

Done. Next steps:
  1. sudo $REPO/deploy/scripts/install.sh apparmor     # load kernel profiles
  2. Edit $BASE/config/tidepool.config.json
     (keyring paths become /var/lib/tidepool/keyrings/<file> inside the pod)
  3. systemctl --user start tidepool-pod
  4. loginctl enable-linger \$USER                      # survive logout/boot
  5. $REPO/deploy/scripts/verify.sh                    # validate everything
EOF
