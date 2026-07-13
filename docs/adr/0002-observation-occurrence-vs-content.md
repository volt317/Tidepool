# ADR 0002: Observations are occurrences, not content

An observation records that a collection HAPPENED — an unchanged source
still produces a new observation, because learning that upstream was alive
and unchanged at time T is knowledge. Content is deduplicated underneath:
normalized record sets are content-addressed objects shared across
observations, and entity states materialize only when a source digest is
new. Terminology is deliberate: artifacts and record sets are
*content-addressed*; observations are *deterministically identified*
(collection time participates in identity, so they are not pure content
hashes). Failures are observations too, with status, error, and coverage.
