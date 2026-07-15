#!/usr/bin/env bash
# scripts/sync-component-locks.sh — maintain the per-component
# package-lock.json files alongside the workspace root lock.
#
# LOCK STRATEGY (two kinds of lock, two distinct jobs — deliberately):
#
#   package-lock.json (root)      the PROJECT lock. npm workspaces maintain
#                                 exactly one lock at the root; it governs
#                                 every developer/CI install (`npm ci` at
#                                 the root installs all workspaces, hoisted).
#
#   server/package-lock.json      STANDALONE-mode locks, one per component.
#   web/package-lock.json         npm ignores these in workspace mode; their
#                                 job is the container build, where each
#                                 runtime image performs a deterministic
#                                 `npm ci --omit=dev --workspaces=false`
#                                 against its own lock, with no knowledge of
#                                 the monorepo. They are regenerated here —
#                                 never hand-edited — and CI fails on drift,
#                                 exactly like shared/deployConfig.generated.ts.
#
# Usage:
#   ./scripts/sync-component-locks.sh           # regenerate both
#   ./scripts/sync-component-locks.sh --check   # exit 1 if regeneration
#                                               # would change anything
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENTS=(server web)
MODE="${1:-sync}"

fail=0
for c in "${COMPONENTS[@]}"; do
  dir="$REPO/$c"
  lock="$dir/package-lock.json"
  before=""
  [ -f "$lock" ] && before="$(sha256sum "$lock" | cut -d' ' -f1)"

  if [ "$MODE" = "--check" ]; then
    # a check must be side-effect free: preserve the committed lock,
    # regenerate, compare, and ALWAYS restore the original
    saved="$(mktemp)"
    [ -f "$lock" ] && cp "$lock" "$saved"
    ( cd "$dir" && npm install --package-lock-only --workspaces=false --no-audit --no-fund >/dev/null 2>&1 )
    after="$(sha256sum "$lock" | cut -d' ' -f1)"
    if [ -s "$saved" ]; then cp "$saved" "$lock"; fi
    rm -f "$saved"
    if [ "$before" != "$after" ]; then
      echo "DRIFT: $c/package-lock.json is stale — regenerate with ./scripts/sync-component-locks.sh and commit" >&2
      fail=1
    else
      echo "ok:    $c/package-lock.json in sync"
    fi
  else
    # --workspaces=false forces standalone resolution even though this
    # directory belongs to a workspace root; --package-lock-only touches
    # the lock and nothing else (no node_modules churn)
    ( cd "$dir" && npm install --package-lock-only --workspaces=false --no-audit --no-fund >/dev/null 2>&1 )
    after="$(sha256sum "$lock" | cut -d' ' -f1)"
    if [ "$before" != "$after" ]; then
      echo "updated: $c/package-lock.json"
    else
      echo "ok:      $c/package-lock.json (no change)"
    fi
  fi
done

exit "$fail"
