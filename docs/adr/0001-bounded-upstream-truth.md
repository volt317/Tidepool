# ADR 0001: Bounded upstream truth

Tidepool never claims knowledge of "the upstream world" — only of the
configured observation scope. Every snapshot carries its scope, its
coverage per source (complete / bounded-pages / explicit-scope / …), and an
explicit not-observed list. **Not observed is not absent**: a package
missing from scope yields insufficient-evidence findings in dispatch, never
silence. Consequence: adding sources widens truth; it never retroactively
falsifies old snapshots, which remain correct statements about their own
boundaries.
