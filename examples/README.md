# Examples

Small, deterministic artifacts produced by the real pipeline against a
fixture store (fixed timestamps, no network):

- `snapshot-small.json` — an interpretive snapshot of one npm unit across a
  2-hour window: an `express` version movement, one advisory, coverage and
  truth-boundary sections, per-rule versions.
- `snapshot-small.md` — the same document rendered as the markdown report.
- `dispatch-node.json` — a dispatch artifact for a tiny Node project pinned
  to the older `express`, evaluated **offline** against that snapshot:
  `dependency-update-available` + `security-review-required`, referencing
  the snapshot digest it was judged against.

The flow they demonstrate is the whole system in miniature:

    observed inflow → bounded snapshot → offline project dispatch finding
