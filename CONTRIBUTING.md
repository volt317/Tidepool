# Contributing

Small, focused changes are welcome. The bar for any change is mechanical
and non-negotiable — CI runs exactly what you can run locally:

```sh
npm install            # Node ≥ 24 (docs/adr/0010-node-24-runtime-baseline.md)
npm run lint           # eslint — zero findings
npm run typecheck      # tsc across server, shared, web — zero findings
npm test               # builds, then runs the suite from dist
shellcheck -S warning -x deploy/scripts/*.sh deploy/scripts/lib/*.sh scripts/*.sh
```

Things that will get a change declined quickly:

* **Weakening a stated guarantee.** `docs/OVERVIEW.md` and the enforcement
  table in `deploy/README.md` are governing documents. A change that makes
  a claim stronger than its enforcement, or an enforcement weaker than its
  claim, needs an ADR, not a PR comment.
* **Mutating recorded evidence.** Observations are append-only; nothing is
  rewritten. Retention/pruning goes through the reachability-based
  retention CLI only.
* **Bypassing the generated-artifact discipline.** `shared/deployConfig
  .generated.ts` and the component locks are generated (`npm run
  generate:deploy-config`, `npm run sync:locks`); never hand-edit them —
  CI's `check:` twins will catch it.
* **New runtime dependencies.** The server intentionally carries two. A
  third needs a strong argument in the PR description.

Architecture decisions get an ADR in `docs/adr/` (sequential number, the
Context/Decision/Consequences shape of the existing ones). Documentation
lives next to what it documents: mechanism in `docs/ARCHITECTURE.md`,
workflows in `docs/DEVELOPMENT.md`, appliance matters in `deploy/README.md`.
The root README stays short.
