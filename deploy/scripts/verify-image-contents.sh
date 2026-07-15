#!/usr/bin/env bash
# deploy/scripts/verify-image-contents.sh — assert that runtime images
# contain NO package manager and NO compiler toolchain.
#
#   verify-image-contents.sh <image-tag>     checks all five targets
#
# Rationale: AppArmor denying execution of npm is policy; npm not existing
# is fact. The runtime base stage deletes the npm/corepack installation the
# node:slim base ships; this script is the gate proving that deletion (and
# the continued absence of compilers) for every target, using node itself
# as the prober — no shell assumptions about the image.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-config.sh
source "$HERE/lib/deploy-config.sh"

TAG="${1:?usage: verify-image-contents.sh <image-tag>}"
TARGETS=(collector api scheduler proxy utility)
FORBIDDEN=(npm npx corepack yarn pnpm node-gyp cc gcc g++ c++ clang clang++ make cmake pkg-config ld as)

fail=0
for t in "${TARGETS[@]}"; do
  image="$DEPLOY_CFG_IMAGE_PREFIX-$t:$TAG"
  found="$(podman run --rm --network=none --entrypoint "" "$image" node -e '
    const { existsSync, readdirSync } = require("fs");
    const forbidden = new Set(process.argv.slice(1));
    const dirs = [...new Set([...(process.env.PATH || "").split(":"), "/usr/local/bin", "/usr/bin", "/bin", "/usr/local/lib/node_modules"])];
    const hits = new Set();
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) if (forbidden.has(f)) hits.add(d + "/" + f);
    }
    if (existsSync("/usr/local/lib/node_modules/npm")) hits.add("/usr/local/lib/node_modules/npm");
    process.stdout.write([...hits].join("\n"));
  ' "${FORBIDDEN[@]}")"
  if [ -n "$found" ]; then
    echo "FAIL  $image contains forbidden tooling:"
    echo "$found" | sed 's/^/        /'
    fail=1
  else
    echo "clean $image — no package manager, no compiler toolchain"
  fi
done

exit "$fail"
