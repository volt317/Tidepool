// server/src/core/db.ts
//
// SQLite connection and migration layer for the observation store.
//
// The database is evidence-bearing state, not disposable acceleration data:
// WAL journaling with synchronous=NORMAL (never OFF), foreign keys enforced,
// and the single-writer invariant — one Tidepool writer process owns a local
// database; collectors fetch concurrently but every normalized write passes
// through the ObservationStore, whose transactions serialize on this one
// connection.
//
// Migrations are explicit, ordered, applied transactionally, and recorded in
// a ledger with their content digests. State is never inferred from whether
// a table happens to exist, and a previously applied migration whose file
// content has drifted is a hard failure.

import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readCorpusText } from "../lib/corpus.js";
import { sha256hex } from "../lib/util.js";

// node:sqlite via getBuiltinModule so environments without it fail with a
// clear message at open time rather than a resolution error at import time
export interface SqliteStatement {
  run(...args: (string | number | null)[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...args: (string | number | null)[]): Record<string, unknown> | undefined;
  all(...args: (string | number | null)[]): Record<string, unknown>[];
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
  backup?: (db: SqliteDatabase, path: string, options?: Record<string, unknown>) => Promise<unknown>;
}

export function sqliteModule(): SqliteModule {
  const mod = process.getBuiltinModule?.("node:sqlite") as unknown as SqliteModule | undefined;
  if (!mod) throw new Error("the observation store requires node:sqlite (Node >= 22.13)");
  return mod;
}

/** Default migrations directory: server/migrations. The compiled layout is
 *  server/dist/server/src/core (four levels above → server/); a direct tsx
 *  run executes from server/src/core (three levels above → server/). Probe
 *  both so every entrypoint — services, CLIs, tests — resolves correctly. */
export const DEFAULT_MIGRATIONS_DIR = ((): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "..", "..", "..", "migrations"), join(here, "..", "..", "migrations")]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(here, "..", "..", "..", "..", "migrations"); // let open fail with a clear path
})();

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA temp_store = MEMORY",
  "PRAGMA auto_vacuum = INCREMENTAL",
];

export interface OpenedDb {
  db: SqliteDatabase;
  path: string;
  /** [version, digest] pairs in applied order */
  migrations: [number, string][];
}

/**
 * Open (creating if needed) the store database under `dataDir`, apply
 * pragmas, and bring the schema up to date via the ordered migrations.
 *
 * DEPLOYMENT-EVOLUTION NOTE: the authoritative database now lives in a
 * dedicated `writer/` subdirectory (corpus/writer/tidepool.sqlite3) so
 * read-side services can be given the corpus tree WITHOUT the writer path
 * ever appearing in their mount namespace. A legacy database at the old
 * dataDir root is moved into place once, before opening (safe: the writer
 * is the only opener of this path, and it hasn't opened it yet).
 */
export function openDatabase(dataDir: string, migrationsDir = DEFAULT_MIGRATIONS_DIR): OpenedDb {
  const writerDir = join(dataDir, "writer");
  mkdirSync(writerDir, { recursive: true });
  const path = join(writerDir, "tidepool.sqlite3");
  // one-time legacy relocation (pre-split layouts kept the db at the root)
  const legacy = join(dataDir, "tidepool.sqlite3");
  if (!existsSync(path) && existsSync(legacy)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(legacy + suffix)) renameSync(legacy + suffix, path + suffix);
    }
  }
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(path);
  for (const p of PRAGMAS) db.exec(p);
  const migrations = runMigrations(db, migrationsDir);
  return { db, path, migrations };
}

/**
 * Open a PUBLISHED REPLICA file with SQLite's real read-only mode
 * (SQLITE_OPEN_READONLY): the API's connection to published truth. Replicas
 * are consistent single-file images produced by the collector's backup step
 * and replaced only by atomic rename — never modified in place — so a
 * read-only open needs no WAL/-shm cooperation. Migrations are VERIFIED
 * against the shipped files' digests, never applied.
 */
export function openReplica(file: string, migrationsDir = DEFAULT_MIGRATIONS_DIR): OpenedDb {
  if (!existsSync(file)) throw new Error(`published replica not found at ${file} — has the collector published yet?`);
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA query_only = ON"); // belt and braces on top of readOnly
  const migrations = verifyMigrations(db, migrationsDir);
  return { db, path: file, migrations };
}

/**
 * Deployment-split addition: open the store database for READ-ONLY use.
 *
 * The API service must be able to query the corpus without ever becoming a
 * second writer (db.ts's single-writer invariant: the collector owns the
 * one writer connection). A WAL database still needs the -shm file mappable,
 * so we open a normal connection and then latch it with
 * `PRAGMA query_only = ON` — SQLite itself rejects every write on this
 * connection from that point on, which is a stronger guarantee than code
 * review of the read router.
 *
 * Migrations are VERIFIED here, never applied: if the schema is behind the
 * shipped migration files, or a previously applied migration's content has
 * drifted, this refuses to open — matching the "validates SQLite schema
 * version before startup" requirement.
 */
export function openDatabaseQueryOnly(dataDir: string, migrationsDir = DEFAULT_MIGRATIONS_DIR): OpenedDb {
  const path = join(dataDir, "writer", "tidepool.sqlite3");
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(path);
  for (const p of PRAGMAS) db.exec(p);
  const migrations = verifyMigrations(db, migrationsDir);
  db.exec("PRAGMA query_only = ON");
  return { db, path, migrations };
}

/** Check that every shipped migration is applied with a matching digest,
 *  without executing any of them. */
export function verifyMigrations(db: SqliteDatabase, migrationsDir: string): [number, string][] {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${migrationsDir}`);

  let appliedRows: Record<string, unknown>[];
  try {
    appliedRows = db.prepare("SELECT version, digest FROM schema_migrations ORDER BY version").all();
  } catch {
    throw new Error("store database has no schema_migrations ledger — start the collector (the writer) first");
  }
  const applied = new Map(appliedRows.map((r) => [Number(r.version), String(r.digest)]));
  const out: [number, string][] = [];
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    const digest = sha256hex(Buffer.from(readCorpusText(join(migrationsDir, file))));
    const prior = applied.get(version);
    if (prior === undefined) {
      throw new Error(`migration ${file} has not been applied — start the collector (the writer) to migrate first`);
    }
    if (prior !== digest) {
      throw new Error(
        `migration ${file} was applied with digest ${prior.slice(0, 12)} but the file now digests to ${digest.slice(0, 12)} — refusing to read a drifted schema history`
      );
    }
    out.push([version, digest]);
  }
  return out;
}

export function runMigrations(db: SqliteDatabase, migrationsDir: string): [number, string][] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    digest     TEXT NOT NULL
  )`);

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${migrationsDir}`);

  const appliedRows = db.prepare("SELECT version, digest FROM schema_migrations ORDER BY version").all();
  const applied = new Map(appliedRows.map((r) => [Number(r.version), String(r.digest)]));
  const out: [number, string][] = [];

  for (const file of files) {
    const version = Number(file.slice(0, 4));
    const sql = readCorpusText(join(migrationsDir, file)); // one whole-corpus read
    const digest = sha256hex(Buffer.from(sql));
    const prior = applied.get(version);
    if (prior !== undefined) {
      if (prior !== digest) {
        throw new Error(
          `migration ${file} was applied with digest ${prior.slice(0, 12)} but the file now digests to ${digest.slice(0, 12)} — refusing to run on a drifted schema history`
        );
      }
      out.push([version, digest]);
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at, digest) VALUES (?, ?, ?)").run(
        version,
        new Date().toISOString(),
        digest
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`);
    }
    out.push([version, digest]);
  }
  return out;
}

/** ISO-8601 UTC — the store's uniform timestamp representation. */
export const iso = (ms: number): string => new Date(ms).toISOString();
export const fromIso = (s: string): number => Date.parse(s);
