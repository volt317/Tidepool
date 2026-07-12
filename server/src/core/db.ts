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

import { mkdirSync, readdirSync } from "node:fs";
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
  DatabaseSync: new (path: string) => SqliteDatabase;
  backup?: (db: SqliteDatabase, path: string, options?: Record<string, unknown>) => Promise<unknown>;
}

export function sqliteModule(): SqliteModule {
  const mod = process.getBuiltinModule?.("node:sqlite") as unknown as SqliteModule | undefined;
  if (!mod) throw new Error("the observation store requires node:sqlite (Node >= 22.13)");
  return mod;
}

/** Default migrations directory: server/migrations, resolved relative to the
 *  compiled module (server/dist/server/src/core → ../../../../migrations). */
export const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");

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
 */
export function openDatabase(dataDir: string, migrationsDir = DEFAULT_MIGRATIONS_DIR): OpenedDb {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "tidepool.sqlite3");
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(path);
  for (const p of PRAGMAS) db.exec(p);
  const migrations = runMigrations(db, migrationsDir);
  return { db, path, migrations };
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
