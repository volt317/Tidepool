# ADR 0006: Advisory disappearance follows coverage

Only a complete authoritative source can prove withdrawal. The change kind
is chosen by the source's structural coverage mode:
complete → advisory-withdrawn; bounded-pages →
advisory-left-coverage-window; anything else →
advisory-no-longer-observed. Bounded feeds (paged USN listings, scoped OSV
queries) therefore never fabricate withdrawal claims, and truth-boundary
reporting preserves the distinction end to end — through change records,
snapshots, and dispatch.
