# Fix: AppArmor "Failed setting up policy cache … Permission denied" in CI

Cause: `apparmor_parser -Q` (compile-check, skip kernel load) still tries to
SAVE compiled profiles to /var/cache/apparmor, which is root-owned on the
runner. The unprivileged compile-check can't write there, so it fails before
the later `sudo apparmor_parser -r` load ever runs.

Fix: add `-K` (--skip-cache) to the compile-only checks. Compilation is fully
exercised; only the cache write is skipped. The sudo load line is unchanged.

Two files changed (same one-flag fix in each):
  .github/workflows/appliance.yml      (the step you saw fail)
  deploy/scripts/ci-deploy-test.sh     (same pattern, would fail the same way)

## Option A — patch
    git am < ../fix-apparmor-cache.patch
    git push

## Option B — copy these two files over the ones in your repo, then:
    chmod +x deploy/scripts/ci-deploy-test.sh   # preserve exec bit
    git add -A && git commit && git push

## Verify
    grep -rn "apparmor_parser -Q" .github/ deploy/    # every hit should be "-Q -K"
