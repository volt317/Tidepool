# Fix: quadlet dryrun FAILED — unsupported key 'StopTimeout' in [Container]

Cause: the four container templates set `StopTimeout=N` in the [Container]
group. Quadlet has no such key there, so `render.sh`'s quadlet -dryrun gate
rejects all four units. (render.sh only runs the dryrun when the quadlet
binary is present — which it is in CI — so this surfaced only in CI.)

Fix: express the same podman stop grace via `PodmanArgs=--stop-timeout=N`,
which quadlet passes straight to `podman run`. Values preserved:
  api=25  collector=115  proxy=15  scheduler=15
The [Service] `TimeoutStopSec=120` is unchanged, so the drain/kill layering
(internal deadline < podman stop-timeout < systemd TimeoutStopSec) still holds.

Verified with the real quadlet binary (podman 4.9.3): dryrun exits 0 and the
generated ExecStart carries --stop-timeout=<N>.

## Option A — patch
    git am < ../fix-quadlet-stoptimeout.patch
    git push

## Option B — copy the four templates over yours, then:
    git add -A && git commit && git push

## Verify (needs podman/quadlet present)
    OUT_DIR=/tmp/r IMAGE_TAG=0.0.0-test ./deploy/scripts/render.sh
    # expect: "render: quadlet dryrun OK"
