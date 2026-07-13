# ADR 0003: SQLite as the local corpus

The corpus is durable local memory, not a response cache (the TTL serving
cache lives separately in .cache/ with the opposite contract). WAL +
synchronous=NORMAL + foreign keys + busy_timeout 5s + incremental
auto-vacuum; never synchronous=OFF. One writer process owns a corpus;
collectors fetch concurrently but every mutation passes through the
SqliteObservationStore transaction boundary. Schema evolves only through
ordered migrations recorded in a digest ledger — an applied migration whose
file has changed refuses to run. Large payloads live outside the database
in objects/sha256/<xx>/<digest>; rows reference digests. Nothing outside
the storage layer (db.ts / store.ts / corpusio.ts) issues SQL.
