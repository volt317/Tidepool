# ADR 0010 — Node 24 as the single runtime baseline

Date: 2026-07-16
Status: accepted

## Context

The project pins Node ≥ 24 in four reinforcing places: `engines` in every
`package.json` with `engine-strict=true` in `.npmrc`, `.node-version` as the
CI source of truth, `scripts/assert-node24.mjs` as a workflow preflight, and
`deploy/scripts/verify-image-node.sh` asserting the built runtime images.
The rationale lived nowhere, which invited two failure modes: contributors
on Node 22 hitting a wall with no stated reason, and future maintainers
unable to tell which of the four gates is load-bearing versus incidental.

## Decision

Node 24 is the baseline, for one load-bearing reason and two supporting
ones:

1. **`node:sqlite` is the durable authority** (ADR 0003). The observation
   store loads it via `process.getBuiltinModule("node:sqlite")` and fails
   closed with a named error when absent. The module exists behind
   experimental status in the Node 22 line — the test suite in fact passes
   on late 22.x — but an *experimental* API underneath the corpus (the one
   component whose integrity everything else derives from) is not an
   acceptable foundation. Node 24 is where the project treats it as
   settled.
2. **One runtime everywhere.** The appliance images are built FROM
   `node:24-bookworm-slim` (digest-pinned); letting the development floor
   drift below the deployment runtime reintroduces exactly the class of
   works-locally-fails-in-image drift the component locks exist to prevent.
3. **LTS timing.** Node 24 is the active LTS line; 22 enters maintenance.

## Consequences

* Contributors need Node 24. The error message a Node 22 user sees is
  npm's engine check, not a mid-run `node:sqlite` failure — that is the
  point of `engine-strict=true`.
* When evidence emerges that a lower floor is safe (e.g. `node:sqlite`
  declared stable in an earlier line, or the deployment base image moves),
  this ADR is where the floor gets reargued — not by loosening one of the
  four gates in isolation.
* The four gates are deliberate redundancy, not accident: manifest floor
  (developers), `.node-version` (CI), assert script (workflow drift), image
  verification (deployment). Removing any one requires updating this ADR.
