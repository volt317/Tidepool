# ADR 0005: Snapshots are historical reconstructions

The snapshot builder never reads live aggregator state. For boundary
window.to, each source contributes its latest observation at or before the
boundary (status from the boundary, records from the last success), later
observations are invisible by construction, and unit state is merged with
native ecosystem version semantics. Therefore rebuilding an old window
after any amount of newer synchronization yields byte-identical canonical
content and an identical digest — enforced by a regression test. Source
heads are a current-state read optimization only. "Current version" is a
native ordering claim per ecosystem; where ordering is unsupported the
entity says so instead of approximating with another ecosystem's rules.
