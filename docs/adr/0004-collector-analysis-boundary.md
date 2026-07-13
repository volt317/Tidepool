# ADR 0004: Collection and analysis are separate transactions

Collection preserves evidence: source registration, artifacts, the
observation, entity states, and head updates commit together
(BEGIN IMMEDIATE). Analysis derives interpretation: change detection runs
in its own transaction and marks observations
analysis_status = pending | complete | failed. A diffing failure can never
erase a preserved observation, and failed analysis is retryable without
recollecting upstream. Heuristics are versioned per rule and never mutate
observations, states, or changes. Dual source heads record both the latest
observation (including failures) and the latest successful one, so a
failing source still reports its last known good state — with the
staleness declared as a limitation.
