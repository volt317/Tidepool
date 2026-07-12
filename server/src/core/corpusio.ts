// server/src/core/corpusio.ts
//
// Portable evidence bundles: export the accumulated-awareness store (or a
// snapshot-bounded slice of it) as a tar.zst that another Tidepool instance
// or dispatch analyzer can load without repeating collection — and import
// such bundles safely: manifest validated, checksums verified, schema
// compatibility inspected, immutable rows merged without silently replacing
// conflicting history, provenance recorded.
//
// This module is part of the storage layer (db.ts / store.ts / corpusio.ts);
// nothing outside that layer issues SQL.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync, gunzipSync } from "node:zlib";

import { iso, sqliteModule, type SqliteDatabase } from "./db.js";
import { digestOf, stableStringify } from "./inflow.js";
import type { ObservationStore } from "./store.js";
import { parseJsonCorpus, readCorpus, writeCorpusAtomic } from "../lib/corpus.js";
import { sha256hex, tarEntries, tarWrite } from "../lib/util.js";
import { validateExportManifest } from "../lib/validate.js";

export const TIDEPOOL_VERSION = "0.2.0";

export interface ExportManifest {
  tidepoolVersion: string;
  schemaVersion: string;
  migrations: [number, string][];
  exportedAt: string;
  mode: "full" | "thin";
  observationRange: { from: string | null; to: string | null };
  sources: { id: string; domain: string; unitId: string; sourceType: string }[];
  databaseDigest: string;
  objectDigests: string[];
  missingObjects: string[];
  snapshotIds: string[];
  limitations: string[];
}

export interface ExportResult {
  path: string;
  manifest: ExportManifest;
  bytes: number;
}

/** table merge order respecting foreign keys */
const MERGE_TABLES = [
  "sources",
  "artifacts",
  "observations",
  "entities",
  "entity_states",
  "changes",
  "evidence",
  "entity_relationships",
  "entity_evidence",
  "change_evidence",
  "findings",
  "snapshots",
  "snapshot_observations",
  "snapshot_changes",
  "snapshot_findings",
] as const;

const PK: Record<string, string[]> = {
  sources: ["id"], artifacts: ["digest"], observations: ["id"], entities: ["id"], entity_states: ["id"],
  changes: ["id"], evidence: ["id"],
  entity_relationships: ["source_entity_id", "target_entity_id", "relationship_type"],
  entity_evidence: ["entity_id", "evidence_id", "relationship_type"],
  change_evidence: ["change_id", "evidence_id", "relationship_type"],
  findings: ["id"], snapshots: ["id"],
  snapshot_observations: ["snapshot_id", "observation_id"],
  snapshot_changes: ["snapshot_id", "change_id"],
  snapshot_findings: ["snapshot_id", "finding_id"],
};

// ------------------------------------------------------------------- export

export async function exportCorpus(
  store: ObservationStore,
  outPath: string,
  opts: { snapshotIds?: string[] } = {}
): Promise<ExportResult> {
  const thin = (opts.snapshotIds?.length ?? 0) > 0;
  const work = mkdtempSync(join(tmpdir(), "tidepool-export-"));
  try {
    // consistent database copy via the backup mechanism — never a WAL file copy
    const dbCopy = join(work, "tidepool.sqlite3");
    await store.backupDatabaseTo(dbCopy);
    const dbBytes = readCorpus(dbCopy);

    const allObjects = store.objectDigests();
    const wanted = thin ? store.normalizedDigestsForSnapshots(opts.snapshotIds ?? []) : new Set(allObjects);
    const objectDigests = allObjects.filter((d) => wanted.has(d));
    const missingObjects = [...wanted].filter((d) => !allObjects.includes(d)).sort();

    const snapDir = join(store.dataDir, "snapshots");
    const snapFiles = existsSync(snapDir)
      ? readdirSync(snapDir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f) && (!thin || (opts.snapshotIds ?? []).includes(f.replace(/\.json$/, ""))))
      : [];

    const range = store.observationRange();
    const manifest: ExportManifest = {
      tidepoolVersion: TIDEPOOL_VERSION,
      schemaVersion: String(store.opened.migrations.length ? store.opened.migrations[store.opened.migrations.length - 1][0] : 0),
      migrations: store.opened.migrations,
      exportedAt: iso(Date.now()),
      mode: thin ? "thin" : "full",
      observationRange: range,
      sources: store.sources(),
      databaseDigest: sha256hex(dbBytes),
      objectDigests,
      missingObjects,
      snapshotIds: snapFiles.map((f) => f.replace(/\.json$/, "")),
      limitations: [
        ...(thin ? ["thin export: objects are limited to those referenced by the selected snapshots"] : []),
        ...(missingObjects.length ? [`${missingObjects.length} referenced object(s) were not present locally`] : []),
      ],
    };

    const entries: { name: string; data: Buffer }[] = [
      { name: "manifest.json", data: Buffer.from(stableStringify(manifest)) },
      { name: "tidepool.sqlite3", data: dbBytes },
    ];
    for (const d of objectDigests) {
      const bytes = store.getObjectBytes(d);
      if (bytes) entries.push({ name: `objects/sha256/${d.slice(0, 2)}/${d}`, data: bytes });
    }
    for (const f of snapFiles) entries.push({ name: `snapshots/${f}`, data: readCorpus(join(snapDir, f)) });
    const checksums = entries.map((e) => `${sha256hex(e.data)}  ${e.name}`).join("\n") + "\n";
    entries.push({ name: "checksums.sha256", data: Buffer.from(checksums) });

    const body = zstdCompressSync(tarWrite(entries));
    writeCorpusAtomic(outPath, body);
    return { path: outPath, manifest, bytes: body.length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- import

export interface ImportReport {
  dryRun: boolean;
  manifest: ExportManifest;
  checksumFailures: string[];
  schemaCompatible: boolean;
  schemaNotes: string[];
  inserted: Record<string, number>;
  conflicts: { table: string; key: string; note: string }[];
  objectsWritten: number;
  snapshotFilesWritten: number;
}

export function importCorpus(store: ObservationStore, bundlePath: string, opts: { dryRun?: boolean } = {}): ImportReport {
  const dryRun = opts.dryRun ?? false;
  const raw = readCorpus(bundlePath);
  let tarBytes: Buffer;
  try {
    tarBytes = zstdDecompressSync(raw);
  } catch {
    try {
      tarBytes = gunzipSync(raw); // tolerate .tar.gz bundles
    } catch {
      throw new Error(`${bundlePath}: bundle is corrupt or not a tar.zst/tar.gz archive`);
    }
  }
  const entries = tarEntries(tarBytes);
  const byName = new Map(entries.map((e) => [e.name, e.data]));

  const manifestBytes = byName.get("manifest.json");
  if (!manifestBytes) throw new Error("bundle has no manifest.json");
  const parsed = parseJsonCorpus(manifestBytes.toString("utf8"), "manifest.json");
  const mv = validateExportManifest(parsed, "manifest.json");
  if (!mv.manifest) throw new Error(`manifest invalid: ${mv.errors.slice(0, 5).join("; ")}`);
  const manifest = mv.manifest as unknown as ExportManifest;

  // checksum verification of every listed entry
  const checksumFailures: string[] = [];
  const sums = byName.get("checksums.sha256")?.toString("utf8") ?? "";
  for (const line of sums.split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
    if (!m) continue;
    const data = byName.get(m[2]);
    if (!data) checksumFailures.push(`${m[2]}: listed but absent`);
    else if (sha256hex(data) !== m[1]) checksumFailures.push(`${m[2]}: checksum mismatch`);
  }
  const dbBytes = byName.get("tidepool.sqlite3");
  if (!dbBytes) throw new Error("bundle has no tidepool.sqlite3");
  if (sha256hex(dbBytes) !== manifest.databaseDigest) checksumFailures.push("tidepool.sqlite3: digest differs from manifest");
  if (checksumFailures.length) {
    return { dryRun, manifest, checksumFailures, schemaCompatible: false, schemaNotes: ["not inspected: checksums failed"], inserted: {}, conflicts: [], objectsWritten: 0, snapshotFilesWritten: 0 };
  }

  // schema compatibility: the bundle's applied migrations must be a prefix of
  // ours with identical digests; newer schemas are rejected
  const ours = new Map(store.opened.migrations);
  const schemaNotes: string[] = [];
  let schemaCompatible = true;
  for (const [version, digest] of manifest.migrations) {
    const local = ours.get(version);
    if (local === undefined) {
      schemaCompatible = false;
      schemaNotes.push(`bundle schema version ${version} is newer than this instance — refusing`);
    } else if (local !== digest) {
      schemaCompatible = false;
      schemaNotes.push(`migration ${version} digest differs (${digest.slice(0, 12)} vs ${local.slice(0, 12)})`);
    }
  }
  if (!schemaCompatible) {
    return { dryRun, manifest, checksumFailures, schemaCompatible, schemaNotes, inserted: {}, conflicts: [], objectsWritten: 0, snapshotFilesWritten: 0 };
  }

  // open the bundled database from a temp file and merge immutable rows
  const work = mkdtempSync(join(tmpdir(), "tidepool-import-"));
  const inserted: Record<string, number> = {};
  const conflicts: ImportReport["conflicts"] = [];
  let objectsWritten = 0;
  let snapshotFilesWritten = 0;
  try {
    const importedPath = join(work, "imported.sqlite3");
    writeCorpusAtomic(importedPath, dbBytes);
    const { DatabaseSync } = sqliteModule();
    const src: SqliteDatabase = new DatabaseSync(importedPath);
    const dst = store.database;

    if (!dryRun) dst.exec("BEGIN IMMEDIATE");
    try {
      for (const table of MERGE_TABLES) {
        const rows = src.prepare(`SELECT * FROM ${table}`).all();
        inserted[table] = 0;
        if (rows.length === 0) continue;
        const cols = Object.keys(rows[0]);
        const pk = PK[table];
        const find = dst.prepare(`SELECT * FROM ${table} WHERE ${pk.map((k) => `${k} = ?`).join(" AND ")}`);
        const ins = dryRun
          ? null
          : dst.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
        for (const row of rows) {
          const key = pk.map((k) => String(row[k])).join("/");
          const existing = find.get(...pk.map((k) => row[k] as string));
          if (existing) {
            // never silently replace conflicting historical rows
            if (digestOf(normalizeRow(existing)) !== digestOf(normalizeRow(row))) {
              conflicts.push({ table, key, note: "existing row differs from bundle row; local history retained" });
            }
            continue;
          }
          if (ins) ins.run(...cols.map((c) => row[c] as string | number | null));
          inserted[table]++;
        }
      }
      // source heads are current-state, not history: recompute after merge
      if (!dryRun) store.recomputeSourceHeads();
      if (!dryRun) {
        dst
          .prepare("INSERT INTO imports (id, imported_at, source_path, manifest_json, dry_run, inserted_json, conflicts_json) VALUES (?, ?, ?, ?, 0, ?, ?)")
          .run(digestOf({ bundle: manifest.databaseDigest, at: Date.now() }), iso(Date.now()), bundlePath, stableStringify(manifest), stableStringify(inserted), stableStringify(conflicts));
        dst.exec("COMMIT");
      }
    } catch (e) {
      if (!dryRun) dst.exec("ROLLBACK");
      throw e;
    }
    src.close();

    // objects and snapshot documents: content-addressed, reuse by digest
    for (const [name, data] of byName) {
      if (name.startsWith("objects/sha256/") && !dryRun) {
        const digest = name.split("/").pop() ?? "";
        if (/^[0-9a-f]{64}$/.test(digest) && sha256hex(data) === digest && !store.getObjectBytes(digest)) {
          store.storeArtifact(data, { mediaType: "application/json", role: "imported-object" });
          objectsWritten++;
        }
      }
      if (name.startsWith("snapshots/") && name.endsWith(".json") && !dryRun) {
        const dest = join(store.dataDir, "snapshots", name.slice("snapshots/".length));
        if (!existsSync(dest)) {
          mkdirSync(join(store.dataDir, "snapshots"), { recursive: true });
          writeCorpusAtomic(dest, data);
          snapshotFilesWritten++;
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { dryRun, manifest, checksumFailures, schemaCompatible, schemaNotes, inserted, conflicts, objectsWritten, snapshotFilesWritten };
}

/** row canonicalization for conflict comparison: null-normalize values */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === undefined ? null : v;
  return out;
}

export function loadManifestFromBundle(bundlePath: string): ExportManifest {
  const raw = readCorpus(bundlePath);
  let tarBytes: Buffer;
  try {
    tarBytes = zstdDecompressSync(raw);
  } catch {
    tarBytes = gunzipSync(raw);
  }
  const m = tarEntries(tarBytes).find((e) => e.name === "manifest.json");
  if (!m) throw new Error("bundle has no manifest.json");
  return parseJsonCorpus(m.data.toString("utf8"), "manifest.json") as ExportManifest;
}

