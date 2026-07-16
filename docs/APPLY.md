# Tidepool Alignment — how to apply

Generated against live main 0143843. Two ways:

## Option A — patch (handles deletions automatically)
    git am < ../tidepool-alignment.patch
    git push

## Option B — copy files, then delete the stale ones by hand
This tree mirrors the repo. Copy each file to the same path in your repo:

    .gitignore                              (NEW — main had none)
    .npmrc                                  (NEW — engine-strict=true)
    README.md                               (Node 22 language removed)
    package.json                            (+check:image-node script)
    server/package.json                     (marked internal versioning)
    web/package.json                        (marked internal versioning)
    deploy/oci/Containerfile                (yarn symlinks + Node-24 image proof)
    deploy/scripts/verify-image-node.sh     (NEW — make executable: chmod +x)
    docs/OVERVIEW.md                        (NEW — authoritative mission doc)
    .github/workflows/appliance.yml         (+verify-image-node step)

Then DELETE these stale shared-pod files (superseded by
deploy/quadlet/templates/*.in; nothing references them):

    git rm deploy/quadlet/tidepool.pod \
           deploy/quadlet/tidepool-api.container \
           deploy/quadlet/tidepool-collector.container \
           deploy/quadlet/tidepool-scheduler.container

Then:  chmod +x deploy/scripts/verify-image-node.sh && git add -A && git commit && git push

## Verify after applying (on a Node 24 machine / CI)
    npm ci
    npm run build && npm test
    npm run check:deploy-config && npm run check:locks
    # image proof runs in CI: appliance.yml → verify-image-node.sh (node major 24 inside each image)

Note: .npmrc engine-strict=true makes `npm install` REFUSE on Node < 24.
That is the intended enforcement, not a bug — use Node 24.
