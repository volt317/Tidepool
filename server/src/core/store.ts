// server/src/core/store.ts
//
// The ObservationStore: Tidepool's durable local memory of upstream inflow.
// SQLite holds structured metadata, identities, observations, normalized
// states, changes, and snapshot manifests; large normalized record corpora
// live outside the database in a content-addressed object directory.
//
// Principles enforced here:
//   observe once · insert-mostly · reuse content-addressed data when content
//   repeats · preserve the observation occurrence even when unchanged ·
//   promote hot fields to typed columns, keep the rest as JSON · absence,
//   failure, and verification limits are first-class rows · historical
//   reconstruction never consults in-memory aggregator state.
//
// Nothing outside this module issues SQL against the store.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ChangeRecord,
  DomainId,
  Observation,
  SnapshotSourceCoverage,
  Verification,
} from "../../../shared/types.js";
import { iso, fromIso, openDatabase, openDatabaseQueryOnly, sqliteModule, type OpenedDb, type SqliteDatabase } from "./db.js";
import {
  detectChanges,
  digestOf,
  stableStringify,
  type AdvisoryRecordLite,
  type CoverageMode,
  type IndexRecordLite,
} from "./inflow.js";
import { newestOf } from "../lib/versions.js";
import type { SnapshotEntity } from "../../../shared/types.js";
import { parseJsonCorpus, readCorpus } from "../lib/corpus.js";
import { sha256hex } from "../lib/util.js";

export const STORE_SCHEMA_VERSION = "1";

export interface CollectionInput {
  domain: DomainId;
  unitId: string;
  unitKind: string;
  authority: string;
  /** source id within the unit, e.g. "pocket:security", "surface:api" */
  sourceType: string;
  canonicalUrl: string | null;
  scope: string;
  collectedAt: number;
  status: "ok" | "error";
  error: string | null;
  verification: Verification;
  signedBy: string[];
  limitations: string[];
  /** collector-reported digest of the raw fetched artifact, when it has one */
  rawArtifactDigest: string | null;
  /** structural coverage claim for this source (complete vs bounded vs scoped) */
  coverageMode: CoverageMode;
  parserVersion: string;
  configVersion: string;
  recordKind: "index" | "advisory";
  records: IndexRecordLite[] | AdvisoryRecordLite[];
}

export interface AppendResult {
  observationId: string;
  normalizedDigest: string;
  newStates: number;
  analysisStatus: "pending";
}

export interface AnalysisResult {
  observationId: string;
  status: "complete" | "failed";
  changes: ChangeRecord[];
  error?: string;
}

export interface CollectionResult {
  observationId: string;
  normalizedDigest: string;
  newStates: number;
  changes: ChangeRecord[];
  analysis: { status: "complete" | "failed"; error?: string };
}

/**
 * The durable storage boundary. Everything above the storage layer —
 * collectors, providers, snapshot builders, routes, dispatch — depends on
 * this interface, never on SQLite (or any file layout) directly.
 */
export interface ObservationStore {
  registerSource(inp: Pick<CollectionInput, "domain" | "unitId" | "sourceType" | "authority" | "canonicalUrl" | "configVersion">): string;
  storeArtifact(bytes: Buffer, meta: { mediaType: string; role: string; fetchedUrl?: string | null }): string;
  /** collection phase: preserve the observation regardless of later analysis */
  appendObservation(inp: CollectionInput): AppendResult;
  /** analysis phase: derive changes; failure never erases the observation */
  analyzeObservation(observationId: string): AnalysisResult;
  /** convenience: appendObservation + analyzeObservation */
  recordCollection(inp: CollectionInput): CollectionResult;
  previousObservation(sourceId: string, before: number): Observation | null;
  observationsFor(domain: string, unitId: string, opts?: { from?: number; to?: number }): Observation[];
  changesFor(domain: string, unitId: string, opts?: { from?: number; to?: number }): ChangeRecord[];
  sourceStateAt(sourceId: string, at: number): HistoricalSourceState;
  unitStateAt(domain: string, unitId: string, at: number): HistoricalUnitState;
  sourceHead(sourceId: string): SourceHead | null;
  verifyCorpus(): CorpusVerification;
  counts(): Record<string, number>;
}

export interface HistoricalSourceState {
  /** latest observation at or before the boundary, any status */
  atBoundary: Observation | null;
  /** latest SUCCESSFUL observation at or before the boundary — state source */
  lastSuccessful: Observation | null;
  records: unknown[];
}

export interface HistoricalUnitState {
  kind: string;
  entities: SnapshotEntity[];
  sources: ReconstructedSource[];
}

export interface SourceHead {
  sourceId: string;
  latestObservationId: string;
  latestSuccessfulId: string | null;
  collectedAt: number;
  status: string;
}

export interface CorpusVerification {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface ReconstructedSource {
  sourceType: string;
  coverage: SnapshotSourceCoverage;
  observation: Observation | null;
  recordKind: "index" | "advisory";
  records: IndexRecordLite[] | AdvisoryRecordLite[];
}

const objectPath = (root: string, digest: string): string => join(root, "objects", "sha256", digest.slice(0, 2), digest);

export class SqliteObservationStore implements ObservationStore {
  readonly dataDir: string;
  readonly opened: OpenedDb;
  private db: SqliteDatabase;

  constructor(dataDir: string, migrationsDir?: string, opts: { readOnly?: boolean } = {}) {
    this.dataDir = dataDir;
    if (opts.readOnly) {
      // Deployment-split addition: the API service opens the SAME corpus but
      // through a query_only connection — SQLite rejects every write on it,
      // preserving the single-writer invariant (the collector is the writer).
      // No directories are created: a read-only consumer must find the
      // corpus already laid out, or fail visibly.
      this.opened = openDatabaseQueryOnly(dataDir, migrationsDir);
      this.db = this.opened.db;
      return;
    }
    for (const d of ["objects/sha256", "snapshots", "exports", "locks"]) mkdirSync(join(dataDir, d), { recursive: true });
    this.opened = openDatabase(dataDir, migrationsDir);
    this.db = this.opened.db;
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------- sources

  /** Deterministic, configuration-independent source identity. */
  sourceIdOf(domain: string, unitId: string, sourceType: string): string {
    return digestOf({ store: STORE_SCHEMA_VERSION, domain, unitId, sourceType });
  }

  registerSource(inp: Pick<CollectionInput, "domain" | "unitId" | "sourceType" | "authority" | "canonicalUrl" | "configVersion">): string {
    const id = this.sourceIdOf(inp.domain, inp.unitId, inp.sourceType);
    const existing = this.db.prepare("SELECT configuration_digest FROM sources WHERE id = ?").get(id);
    const configJson = stableStringify({ configVersion: inp.configVersion });
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO sources (id, domain, unit_id, source_type, authority, canonical_url,
             configuration_json, configuration_digest, created_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(id, inp.domain, inp.unitId, inp.sourceType, inp.authority, inp.canonicalUrl, configJson, inp.configVersion, iso(Date.now()));
    } else if (String(existing.configuration_digest) !== inp.configVersion) {
      // the catalog row reflects the CURRENT configuration; every observation
      // row carries the config digest that produced it, so history is intact
      this.db
        .prepare("UPDATE sources SET configuration_json = ?, configuration_digest = ? WHERE id = ?")
        .run(configJson, inp.configVersion, id);
    }
    return id;
  }

  sources(): { id: string; domain: string; unitId: string; sourceType: string }[] {
    return this.db
      .prepare("SELECT id, domain, unit_id, source_type FROM sources ORDER BY domain, unit_id, source_type")
      .all()
      .map((r) => ({ id: String(r.id), domain: String(r.domain), unitId: String(r.unit_id), sourceType: String(r.source_type) }));
  }

  // ------------------------------------------------------------ artifacts

  /** Write bytes to a temp file, hash, and atomically rename into the
   *  content-addressed object store. Conflict-safe by construction. */
  storeArtifact(bytes: Buffer, meta: { mediaType: string; role: string; fetchedUrl?: string | null }): string {
    const digest = sha256hex(bytes);
    const dest = objectPath(this.dataDir, digest);
    if (!existsSync(dest)) {
      mkdirSync(join(this.dataDir, "objects", "sha256", digest.slice(0, 2)), { recursive: true });
      const tmp = join(this.dataDir, "objects", `.tmp-${digest.slice(0, 16)}-${process.pid}`);
      writeFileSync(tmp, bytes);
      const check = createHash("sha256").update(readCorpus(tmp)).digest("hex");
      if (check !== digest) {
        rmSync(tmp, { force: true });
        throw new Error(`artifact write verification failed: expected ${digest.slice(0, 12)}, got ${check.slice(0, 12)}`);
      }
      renameSync(tmp, dest);
    }
    this.db
      .prepare(
        `INSERT INTO artifacts (digest, algorithm, media_type, compression, byte_size, storage_path,
           fetched_url, etag, last_modified, created_at, metadata_json)
         VALUES (?, 'sha256', ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(digest) DO NOTHING`
      )
      .run(digest, meta.mediaType, bytes.length, `objects/sha256/${digest.slice(0, 2)}/${digest}`, meta.fetchedUrl ?? null, iso(Date.now()), stableStringify({ role: meta.role }));
    return digest;
  }

  /** Register a digest the collector reported for a raw artifact whose bytes
   *  were not retained (storage_path NULL states that honestly). */
  private registerReportedArtifact(digest: string, fetchedUrl: string | null): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (digest, algorithm, media_type, compression, byte_size, storage_path,
           fetched_url, etag, last_modified, created_at, metadata_json)
         VALUES (?, 'sha256', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)
         ON CONFLICT(digest) DO NOTHING`
      )
      .run(digest, fetchedUrl, iso(Date.now()), stableStringify({ role: "raw-reported-digest-only" }));
  }

  getObjectBytes(digest: string): Buffer | null {
    const m = /^([0-9a-f]{64})$/.exec(digest);
    if (!m) return null;
    const p = objectPath(this.dataDir, m[1]);
    return existsSync(p) ? readCorpus(p) : null;
  }

  // -------------------------------------------------------- the transaction
  //
  //   BEGIN IMMEDIATE
  //     insert or reuse artifact(s)
  //     insert observation
  //     insert or reuse entities; insert entity states (new content only)
  //     derive and insert changes
  //     update source head
  //   COMMIT

  appendObservation(inp: CollectionInput): AppendResult {
    const sourceId = this.registerSource(inp);
    const effective = inp.status === "ok" ? inp.records : [];
    const body = Buffer.from(stableStringify(effective));
    const normalizedDigest = sha256hex(body);

    const observationId = digestOf({
      store: STORE_SCHEMA_VERSION,
      sourceId,
      collectedAt: inp.collectedAt,
      normalizedDigest,
      configVersion: inp.configVersion,
      parserVersion: inp.parserVersion,
      status: inp.status,
    });

    // the normalized record corpus is a content-addressed object — identical
    // re-observations reuse it (unchanged-content deduplication)
    this.storeArtifact(body, { mediaType: "application/json", role: "normalized-records" });
    if (inp.rawArtifactDigest && /^[0-9a-f]{64}$/.test(inp.rawArtifactDigest))
      this.registerReportedArtifact(inp.rawArtifactDigest, inp.canonicalUrl);

    const contentIsNew = !this.db
      .prepare("SELECT o.id FROM observations o WHERE o.source_id = ? AND o.normalized_digest = ? AND EXISTS (SELECT 1 FROM entity_states es WHERE es.observation_id = o.id) LIMIT 1")
      .get(sourceId, normalizedDigest);

    this.db.exec("BEGIN IMMEDIATE");
    let newStates = 0;
    try {
      this.db
        .prepare(
          `INSERT INTO observations (id, source_id, collected_at, fetch_started_at, fetch_finished_at, status,
             artifact_digest, normalized_digest, verification_level, signer_fingerprint, verification_json,
             coverage_complete, coverage_json, parser_name, parser_version, config_digest, analysis_status, error_json, metadata_json)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          observationId, sourceId, iso(inp.collectedAt), iso(inp.collectedAt), inp.status,
          inp.rawArtifactDigest && /^[0-9a-f]{64}$/.test(inp.rawArtifactDigest) ? inp.rawArtifactDigest : null,
          normalizedDigest,
          inp.verification ?? null,
          inp.signedBy.join("; ") || null,
          stableStringify({ signedBy: inp.signedBy }),
          inp.coverageMode === "complete" && inp.limitations.length === 0 ? 1 : 0,
          stableStringify({ mode: inp.coverageMode, complete: inp.coverageMode === "complete" && inp.limitations.length === 0, observed: effective.length, limitations: inp.limitations }),
          `${inp.domain}-collector`,
          inp.parserVersion,
          inp.configVersion,
          inp.error ? stableStringify({ message: inp.error }) : null,
          stableStringify({ scope: inp.scope, authority: inp.authority, unitKind: inp.unitKind, recordKind: inp.recordKind, recordCount: effective.length })
        );

      if (inp.status === "ok" && contentIsNew && effective.length > 0) {
        newStates = this.insertEntityStates(inp, observationId, effective);
      }

      // dual heads: what happened most recently vs the last time it worked
      this.db
        .prepare(
          `INSERT INTO source_heads (source_id, latest_observation_id, collected_at, normalized_digest, status)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(source_id) DO UPDATE SET latest_observation_id = excluded.latest_observation_id,
             collected_at = excluded.collected_at, normalized_digest = excluded.normalized_digest, status = excluded.status`
        )
        .run(sourceId, observationId, iso(inp.collectedAt), normalizedDigest, inp.status);
      if (inp.status === "ok") {
        this.db.prepare("UPDATE source_heads SET latest_successful_id = ? WHERE source_id = ?").run(observationId, sourceId);
      }

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { observationId, normalizedDigest, newStates, analysisStatus: "pending" };
  }

  /** Analysis is separate and retryable: a diffing failure marks the
   *  observation analysis_status='failed' but the evidence stays preserved. */
  analyzeObservation(observationId: string): AnalysisResult {
    const row = this.db
      .prepare(`SELECT ${this.obsColumns}, o.source_id AS db_source_id FROM observations o JOIN sources s ON s.id = o.source_id WHERE o.id = ?`)
      .get(observationId);
    if (!row) return { observationId, status: "failed", changes: [], error: "unknown observation" };
    const dbSourceId = String(row.db_source_id);
    const obs = this.rowToObservation(row);
    const meta = row.metadata_json ? (parseJsonCorpus(String(row.metadata_json), "obs meta") as { recordKind?: string; unitKind?: string }) : {};
    const cov = row.coverage_json ? (parseJsonCorpus(String(row.coverage_json), "obs coverage") as { mode?: CoverageMode }) : {};
    const kind = meta.recordKind === "advisory" ? "advisory" : "index";

    try {
      const prev = this.previousObservation(dbSourceId, obs.collectedAt);
      const prevRecords = prev && prev.status === "ok" ? ((this.readNormalized(prev.recordsDigest) ?? []) as IndexRecordLite[]) : [];
      const records = obs.status === "ok" ? ((this.readNormalized(obs.recordsDigest) ?? []) as IndexRecordLite[]) : [];
      const changes = detectChanges(prev, obs, prevRecords, records, kind, cov.mode);

      const inpLike = { domain: obs.domain, unitKind: meta.unitKind ?? "unknown", recordKind: kind } as Pick<CollectionInput, "domain" | "unitKind" | "recordKind">;
      const prevByName = new Map((prevRecords as { name?: string; package?: string }[]).map((r) => [r.name ?? r.package ?? "", r]));
      const currByName = new Map((records as { name?: string; package?: string }[]).map((r) => [r.name ?? r.package ?? "", r]));

      this.db.exec("BEGIN IMMEDIATE");
      try {
        const insChange = this.db.prepare(
          `INSERT INTO changes (id, domain, unit_id, source_id, entity_id, previous_observation_id,
             current_observation_id, change_type, detected_at, previous_state_digest, current_state_digest, details_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
        );
        for (const c of changes) {
          const entityId = c.package ? this.entityIdFor(inpLike, c.package) : null;
          const prevRec = c.package ? prevByName.get(c.package) : undefined;
          const currRec = c.package ? currByName.get(c.package) : undefined;
          const fields =
            c.fields ??
            (c.from !== undefined || c.to !== undefined
              ? { [fieldOfKind(c.kind)]: { from: c.from ?? null, to: c.to ?? null } }
              : {});
          insChange.run(
            c.id, c.domain, c.unit, dbSourceId, entityId, c.fromObservation, c.toObservation, c.kind, iso(c.detectedAt),
            prevRec ? digestOf(prevRec) : null,
            currRec ? digestOf(currRec) : null,
            stableStringify({ fields, detail: c.detail ?? null, sourceType: obs.sourceId })
          );
        }
        this.db.prepare("UPDATE observations SET analysis_status = 'complete' WHERE id = ?").run(observationId);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return { observationId, status: "complete", changes };
    } catch (e) {
      this.db.prepare("UPDATE observations SET analysis_status = 'failed' WHERE id = ?").run(observationId);
      return { observationId, status: "failed", changes: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  recordCollection(inp: CollectionInput): CollectionResult {
    const appended = this.appendObservation(inp);
    const analysis = this.analyzeObservation(appended.observationId);
    return {
      observationId: appended.observationId,
      normalizedDigest: appended.normalizedDigest,
      newStates: appended.newStates,
      changes: analysis.changes,
      analysis: { status: analysis.status, error: analysis.error },
    };
  }

  private entityIdentity(inp: Pick<CollectionInput, "domain" | "unitKind" | "recordKind">, name: string) {
    const entityType =
      inp.recordKind === "advisory" ? "advisory-subject" : inp.domain === "distro" ? "binary-package" : "registry-package";
    return { domain: inp.domain, ecosystem: inp.unitKind, entityType, canonicalName: name, namespace: null as string | null, architecture: null as string | null };
  }

  private entityIdFor(inp: Pick<CollectionInput, "domain" | "unitKind" | "recordKind">, name: string): string {
    return digestOf({ store: STORE_SCHEMA_VERSION, kind: "entity", ...this.entityIdentity(inp, name) });
  }

  private insertEntityStates(inp: CollectionInput, observationId: string, records: CollectionInput["records"]): number {
    const upsertEntity = this.db.prepare(
      `INSERT INTO entities (id, domain, ecosystem, entity_type, canonical_name, namespace, architecture, identity_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
    );
    const insState = this.db.prepare(
      `INSERT INTO entity_states (id, entity_id, observation_id, version, source_package, repository, channel,
         component, section, architecture, state_digest, state_json)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(entity_id, observation_id) DO NOTHING`
    );
    const now = iso(inp.collectedAt);
    let n = 0;
    for (const r of records) {
      const name = "name" in r ? r.name : r.package;
      const identity = this.entityIdentity(inp, name);
      const entityId = this.entityIdFor(inp, name);
      upsertEntity.run(entityId, identity.domain, identity.ecosystem, identity.entityType, identity.canonicalName, identity.namespace, identity.architecture, stableStringify(identity), now, now);
      const stateDigest = digestOf(r);
      const meta = "meta" in r ? (r.meta ?? "") : "";
      const [component = null, section = null] = meta ? meta.split("|") : [null, null];
      insState.run(
        digestOf({ entityId, observationId }),
        entityId,
        observationId,
        "version" in r ? r.version : null,
        inp.sourceType,
        component || null,
        section || null,
        stateDigest,
        stableStringify(r)
      );
      n++;
    }
    return n;
  }

  // --------------------------------------------------------------- queries

  private readNormalized(digest: string): unknown | null {
    const bytes = this.getObjectBytes(digest);
    return bytes ? parseJsonCorpus(bytes.toString("utf8"), `normalized ${digest.slice(0, 12)}`) : null;
  }

  private rowToObservation(r: Record<string, unknown>): Observation {
    const meta = r.metadata_json ? (parseJsonCorpus(String(r.metadata_json), "observation metadata") as Record<string, unknown>) : {};
    const cov = r.coverage_json ? (parseJsonCorpus(String(r.coverage_json), "observation coverage") as { observed?: number; limitations?: string[] }) : {};
    const ver = r.verification_json ? (parseJsonCorpus(String(r.verification_json), "observation verification") as { signedBy?: string[] }) : {};
    const err = r.error_json ? (parseJsonCorpus(String(r.error_json), "observation error") as { message?: string }) : null;
    return {
      id: String(r.id),
      domain: String(r.domain) as DomainId,
      unit: String(r.unit_id),
      authority: String(meta.authority ?? ""),
      sourceId: String(r.source_type),
      collectedAt: fromIso(String(r.collected_at)),
      scope: String(meta.scope ?? ""),
      verification: (r.verification_level as Verification) ?? null,
      signedBy: ver.signedBy ?? [],
      status: String(r.status) as "ok" | "error",
      error: err?.message ?? null,
      coverage: { observed: Number(cov.observed ?? 0), limitations: cov.limitations ?? [] },
      artifactDigest: r.artifact_digest ? String(r.artifact_digest) : null,
      parserVersion: String(r.parser_version ?? ""),
      configVersion: String(r.config_digest ?? ""),
      recordsDigest: String(r.normalized_digest ?? ""),
      recordCount: Number(meta.recordCount ?? cov.observed ?? 0),
    };
  }

  private readonly obsColumns =
    "o.id, s.domain, s.unit_id, s.source_type, o.collected_at, o.status, o.artifact_digest, o.normalized_digest, o.verification_level, o.verification_json, o.coverage_json, o.parser_version, o.config_digest, o.error_json, o.metadata_json";

  /** newest observation of a source (the head), as the DTO */
  headObservation(sourceId: string): Observation | null {
    const r = this.db
      .prepare(
        `SELECT ${this.obsColumns} FROM source_heads h
           JOIN observations o ON o.id = h.latest_observation_id
           JOIN sources s ON s.id = o.source_id
         WHERE h.source_id = ?`
      )
      .get(sourceId);
    return r ? this.rowToObservation(r) : null;
  }

  sourceHead(sourceId: string): SourceHead | null {
    const r = this.db.prepare("SELECT * FROM source_heads WHERE source_id = ?").get(sourceId);
    if (!r) return null;
    return {
      sourceId,
      latestObservationId: String(r.latest_observation_id),
      latestSuccessfulId: r.latest_successful_id ? String(r.latest_successful_id) : null,
      collectedAt: fromIso(String(r.collected_at)),
      status: String(r.status),
    };
  }

  previousObservation(sourceId: string, before: number): Observation | null {
    const r = this.db
      .prepare(
        `SELECT ${this.obsColumns} FROM observations o JOIN sources s ON s.id = o.source_id
         WHERE o.source_id = ? AND o.collected_at < ? ORDER BY o.collected_at DESC LIMIT 1`
      )
      .get(sourceId, iso(before));
    return r ? this.rowToObservation(r) : null;
  }

  observationsFor(domain: string, unitId: string, opts: { from?: number; to?: number } = {}): Observation[] {
    return this.db
      .prepare(
        `SELECT ${this.obsColumns} FROM observations o JOIN sources s ON s.id = o.source_id
         WHERE s.domain = ? AND s.unit_id = ? AND o.collected_at >= ? AND o.collected_at <= ?
         ORDER BY o.collected_at`
      )
      .all(domain, unitId, iso(opts.from ?? 0), iso(opts.to ?? 4102444800000))
      .map((r) => this.rowToObservation(r));
  }

  private rowToChange(r: Record<string, unknown>): ChangeRecord {
    const details = parseJsonCorpus(String(r.details_json), "change details") as {
      fields?: Record<string, { from: string | null; to: string | null }>;
      detail?: string | null;
      sourceType?: string;
    };
    const kind = String(r.change_type) as ChangeRecord["kind"];
    const primary = details.fields?.[fieldOfKind(kind)] ?? Object.values(details.fields ?? {})[0];
    return {
      id: String(r.id),
      domain: String(r.domain) as DomainId,
      unit: String(r.unit_id),
      sourceId: String(details.sourceType ?? r.source_id),
      kind,
      package: r.entity_name ? String(r.entity_name) : undefined,
      from: primary?.from ?? undefined,
      to: primary?.to ?? undefined,
      detail: details.detail ?? undefined,
      fields: details.fields && Object.keys(details.fields).length ? details.fields : undefined,
      fromObservation: r.previous_observation_id ? String(r.previous_observation_id) : null,
      toObservation: String(r.current_observation_id),
      detectedAt: fromIso(String(r.detected_at)),
    };
  }

  private readonly changeColumns =
    "c.id, c.domain, c.unit_id, c.source_id, c.change_type, c.detected_at, c.previous_observation_id, c.current_observation_id, c.details_json, e.canonical_name AS entity_name";

  changesFor(domain: string, unitId: string, opts: { from?: number; to?: number } = {}): ChangeRecord[] {
    return this.db
      .prepare(
        `SELECT ${this.changeColumns} FROM changes c LEFT JOIN entities e ON e.id = c.entity_id
         WHERE c.domain = ? AND c.unit_id = ? AND c.detected_at >= ? AND c.detected_at <= ?
         ORDER BY c.detected_at`
      )
      .all(domain, unitId, iso(opts.from ?? 0), iso(opts.to ?? 4102444800000))
      .map((r) => this.rowToChange(r));
  }

  /**
   * Historical reconstruction primitive. The boundary observation (latest at
   * or before `at`, any status) describes what was KNOWN; the last successful
   * observation supplies the STATE. Later observations are invisible by
   * construction; source heads are never consulted.
   */
  sourceStateAt(sourceId: string, at: number): HistoricalSourceState {
    const pick = (successOnly: boolean) => {
      const r = this.db
        .prepare(
          `SELECT ${this.obsColumns} FROM observations o JOIN sources s ON s.id = o.source_id
           WHERE o.source_id = ? AND o.collected_at <= ? ${successOnly ? "AND o.status = 'ok'" : ""}
           ORDER BY o.collected_at DESC LIMIT 1`
        )
        .get(sourceId, iso(at));
      return r ? this.rowToObservation(r) : null;
    };
    const atBoundary = pick(false);
    const lastSuccessful = atBoundary?.status === "ok" ? atBoundary : pick(true);
    const records = lastSuccessful ? ((this.readNormalized(lastSuccessful.recordsDigest) as unknown[]) ?? []) : [];
    return { atBoundary, lastSuccessful, records };
  }

  /** Everything the snapshot builder needs for one unit, reconstructed at
   *  the window boundary from stored observations alone. */
  buildSnapshotInputs(domain: string, unitId: string, window: { from: number; to: number }): ReconstructedSource[] {
    const srcs = this.db
      .prepare("SELECT id, source_type FROM sources WHERE domain = ? AND unit_id = ? ORDER BY source_type")
      .all(domain, unitId);
    const out: ReconstructedSource[] = [];
    for (const s2 of srcs) {
      const { atBoundary, lastSuccessful, records } = this.sourceStateAt(String(s2.id), window.to);
      const limitations = [...(atBoundary?.coverage.limitations ?? [])];
      if (atBoundary && atBoundary.status === "error" && lastSuccessful) {
        limitations.push(`source failing at the boundary; state shown is the last successful observation (${iso(lastSuccessful.collectedAt)})`);
      }
      const meta = atBoundary
        ? {
            status: atBoundary.status,
            verification: (lastSuccessful ?? atBoundary).verification,
            signedBy: (lastSuccessful ?? atBoundary).signedBy,
            recordCount: lastSuccessful?.recordCount ?? 0,
            collectedAt: atBoundary.collectedAt as number | null,
            error: atBoundary.error ?? null,
            limitations,
          }
        : { status: "unobserved" as const, verification: null, signedBy: [], recordCount: 0, collectedAt: null, error: null, limitations: [] };
      const kindMeta = (lastSuccessful ?? atBoundary)
        ? (this.db.prepare("SELECT metadata_json FROM observations WHERE id = ?").get((lastSuccessful ?? atBoundary)!.id))
        : null;
      const recordKind = kindMeta?.metadata_json
        ? ((parseJsonCorpus(String(kindMeta.metadata_json), "obs meta") as { recordKind?: string }).recordKind === "advisory" ? "advisory" : "index")
        : String(s2.source_type).startsWith("advisories:") ? "advisory" : "index";
      out.push({
        sourceType: String(s2.source_type),
        coverage: {
          domain: domain as DomainId,
          unit: unitId,
          authority: atBoundary?.authority ?? "",
          sourceId: String(s2.source_type),
          ...meta,
        },
        observation: atBoundary,
        recordKind,
        records: records as IndexRecordLite[] | AdvisoryRecordLite[],
      });
    }
    return out;
  }

  /** The unit's merged state as known at `at`: reconstruction + native
   *  ecosystem version semantics — the storage-layer home of "current". */
  unitStateAt(domain: string, unitId: string, at: number): HistoricalUnitState {
    const sources = this.buildSnapshotInputs(domain, unitId, { from: 0, to: at });
    const kindRow = this.db
      .prepare(
        `SELECT o.metadata_json FROM observations o JOIN sources s ON s.id = o.source_id
         WHERE s.domain = ? AND s.unit_id = ? ORDER BY o.collected_at DESC LIMIT 1`
      )
      .get(domain, unitId);
    const kind = kindRow?.metadata_json
      ? String((parseJsonCorpus(String(kindRow.metadata_json), "obs meta") as { unitKind?: string }).unitKind ?? "unknown")
      : "unknown";

    const versionsByName = new Map<string, Record<string, string>>();
    const advisoriesByName = new Map<string, number>();
    for (const src of sources) {
      const suffix = src.sourceType.includes(":") ? src.sourceType.slice(src.sourceType.indexOf(":") + 1) : src.sourceType;
      if (src.recordKind === "index") {
        for (const r of src.records as IndexRecordLite[]) {
          const v = versionsByName.get(r.name) ?? {};
          v[suffix] = r.version;
          versionsByName.set(r.name, v);
        }
      } else {
        for (const r of src.records as AdvisoryRecordLite[]) advisoriesByName.set(r.package, (advisoriesByName.get(r.package) ?? 0) + 1);
      }
    }
    const entities: SnapshotEntity[] = [];
    for (const [name, versions] of [...versionsByName].sort((a, b) => a[0].localeCompare(b[0]))) {
      const vals = Object.values(versions);
      const { newest, ordering } = newestOf(kind, vals);
      entities.push({
        domain: domain as DomainId,
        unit: unitId,
        name,
        source: name,
        versions,
        current: newest,
        ordering,
        drift: new Set(vals).size > 1,
        advisoryCount: advisoriesByName.get(name) ?? 0,
      });
    }
    return { kind, entities, sources };
  }

  unitsWithSources(): { domain: string; unitId: string }[] {
    return this.db
      .prepare("SELECT DISTINCT domain, unit_id FROM sources ORDER BY domain, unit_id")
      .all()
      .map((r) => ({ domain: String(r.domain), unitId: String(r.unit_id) }));
  }

  // ------------------------------------------------------ snapshot manifests

  recordSnapshotManifest(doc: {
    digest: string;
    window: { from: number; to: number };
    createdAt: number;
    scope: unknown;
    notObserved: string[];
    ambiguities: string[];
    observations: { id: string }[];
    changes: { id: string }[];
    findings: { ruleId: string; title: string; summary: string; confidence: number; confidenceBasis: string; severityHint: string; evidence: unknown; ambiguities: string[] }[];
    bundlePath: string | null;
  }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO snapshots (id, schema_version, window_start, window_end, created_at, scope_json, truth_boundary_json, content_digest, bundle_path, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(id) DO NOTHING`
        )
        .run(doc.digest, STORE_SCHEMA_VERSION, iso(doc.window.from), iso(doc.window.to), iso(doc.createdAt), stableStringify(doc.scope), stableStringify({ notObserved: doc.notObserved, ambiguities: doc.ambiguities }), doc.digest, doc.bundlePath);
      const so = this.db.prepare("INSERT INTO snapshot_observations (snapshot_id, observation_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const o of doc.observations) so.run(doc.digest, o.id);
      const sc = this.db.prepare("INSERT INTO snapshot_changes (snapshot_id, change_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const ch of doc.changes) sc.run(doc.digest, ch.id);
      const fi = this.db.prepare(
        `INSERT INTO findings (id, rule_id, rule_version, created_at, confidence, confidence_basis, finding_type, summary, evidence_json, counterevidence_json, ambiguity_json, metadata_json)
         VALUES (?, ?, '1', ?, ?, ?, ?, ?, ?, NULL, ?, NULL) ON CONFLICT(id) DO NOTHING`
      );
      const sf = this.db.prepare("INSERT INTO snapshot_findings (snapshot_id, finding_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const f of doc.findings) {
        const fid = digestOf({ rule: f.ruleId, summary: f.summary, snapshot: doc.digest });
        fi.run(fid, f.ruleId, iso(doc.createdAt), f.confidence, f.confidenceBasis, f.severityHint, f.summary, stableStringify(f.evidence), stableStringify(f.ambiguities));
        sf.run(doc.digest, fid);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  snapshotManifests(): { id: string; windowStart: string; windowEnd: string; createdAt: string }[] {
    return this.db
      .prepare("SELECT id, window_start, window_end, created_at FROM snapshots ORDER BY created_at DESC")
      .all()
      .map((r) => ({ id: String(r.id), windowStart: String(r.window_start), windowEnd: String(r.window_end), createdAt: String(r.created_at) }));
  }

  /** internal: storage-layer modules (corpusio) only — never routes/collectors */
  get database(): SqliteDatabase {
    return this.db;
  }

  observationRange(): { from: string | null; to: string | null } {
    const r = this.db.prepare("SELECT MIN(collected_at) AS a, MAX(collected_at) AS b FROM observations").get();
    return { from: r?.a ? String(r.a) : null, to: r?.b ? String(r.b) : null };
  }

  /** every object digest referenced by any observation (normalized or raw) */
  referencedObjectDigests(): Set<string> {
    const out = new Set<string>();
    for (const r of this.db.prepare("SELECT DISTINCT normalized_digest AS d FROM observations WHERE normalized_digest IS NOT NULL").all()) out.add(String(r.d));
    for (const r of this.db
      .prepare("SELECT DISTINCT a.digest AS d FROM artifacts a JOIN observations o ON o.artifact_digest = a.digest WHERE a.storage_path IS NOT NULL")
      .all())
      out.add(String(r.d));
    return out;
  }

  /** normalized-record object digests referenced by the given snapshots */
  normalizedDigestsForSnapshots(snapshotIds: string[]): Set<string> {
    const out = new Set<string>();
    const q = this.db.prepare(
      `SELECT DISTINCT o.normalized_digest AS d FROM snapshot_observations so
         JOIN observations o ON o.id = so.observation_id
       WHERE so.snapshot_id = ? AND o.normalized_digest IS NOT NULL`
    );
    for (const id of snapshotIds) for (const r of q.all(id)) out.add(String(r.d));
    return out;
  }

  /** heads are a current-state optimization — rebuild them from observations */
  recomputeSourceHeads(): void {
    const latest = this.db
      .prepare(
        `SELECT o.source_id, o.id, o.collected_at, o.normalized_digest, o.status FROM observations o
           JOIN (SELECT source_id, MAX(collected_at) AS m FROM observations GROUP BY source_id) l
             ON l.source_id = o.source_id AND l.m = o.collected_at`
      )
      .all();
    const success = new Map(
      this.db
        .prepare(
          `SELECT o.source_id, o.id FROM observations o
             JOIN (SELECT source_id, MAX(collected_at) AS m FROM observations WHERE status = 'ok' GROUP BY source_id) l
               ON l.source_id = o.source_id AND l.m = o.collected_at AND o.status = 'ok'`
        )
        .all()
        .map((r) => [String(r.source_id), String(r.id)])
    );
    const up = this.db.prepare(
      `INSERT INTO source_heads (source_id, latest_observation_id, collected_at, normalized_digest, status, latest_successful_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET latest_observation_id = excluded.latest_observation_id,
         collected_at = excluded.collected_at, normalized_digest = excluded.normalized_digest,
         status = excluded.status, latest_successful_id = excluded.latest_successful_id`
    );
    for (const r of latest)
      up.run(String(r.source_id), String(r.id), String(r.collected_at), r.normalized_digest as string | null, String(r.status), success.get(String(r.source_id)) ?? null);
  }

  // -------------------------------------------------------------- integrity

  /** Corpus verification: structural integrity of the evidence store. */
  verifyCorpus(): CorpusVerification {
    const checks: CorpusVerification["checks"] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

    const integ = this.db.prepare("PRAGMA integrity_check").get();
    add("sqlite-integrity", String(integ?.integrity_check) === "ok", String(integ?.integrity_check ?? "?"));
    const fk = this.db.prepare("PRAGMA foreign_key_check").all();
    add("foreign-keys", fk.length === 0, fk.length === 0 ? "no violations" : `${fk.length} violation(s)`);

    // object store: every stored artifact exists and re-digests correctly
    let missing = 0;
    let corrupt = 0;
    const stored = this.db.prepare("SELECT digest, storage_path FROM artifacts WHERE storage_path IS NOT NULL").all();
    for (const a of stored) {
      const bytes = this.getObjectBytes(String(a.digest));
      if (!bytes) missing++;
      else if (sha256hex(bytes) !== String(a.digest)) corrupt++;
    }
    add("object-existence", missing === 0, missing === 0 ? `${stored.length} object(s) present` : `${missing} missing`);
    add("object-digests", corrupt === 0, corrupt === 0 ? "all re-digest correctly" : `${corrupt} corrupt object(s)`);

    // normalized record sets referenced by successful observations must exist
    const normMissing = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM observations o
         WHERE o.status = 'ok' AND o.normalized_digest IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.digest = o.normalized_digest AND a.storage_path IS NOT NULL)`
      )
      .get();
    add("normalized-records", Number(normMissing?.n ?? 0) === 0, `${Number(normMissing?.n ?? 0)} observation(s) missing their record set`);

    const badHeads = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM source_heads h
         WHERE NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = h.latest_observation_id)
            OR (h.latest_successful_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = h.latest_successful_id))`
      )
      .get();
    add("head-references", Number(badHeads?.n ?? 0) === 0, `${Number(badHeads?.n ?? 0)} dangling head reference(s)`);

    const orphanStates = this.db
      .prepare("SELECT COUNT(*) AS n FROM entity_states es WHERE NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = es.observation_id)")
      .get();
    add("entity-state-owners", Number(orphanStates?.n ?? 0) === 0, `${Number(orphanStates?.n ?? 0)} orphaned state(s)`);

    const badSnapRefs = this.db
      .prepare("SELECT COUNT(*) AS n FROM snapshot_observations so WHERE NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = so.observation_id)")
      .get();
    add("snapshot-references", Number(badSnapRefs?.n ?? 0) === 0, `${Number(badSnapRefs?.n ?? 0)} dangling snapshot reference(s)`);

    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE analysis_status = 'pending'").get();
    const failed = this.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE analysis_status = 'failed'").get();
    add("analysis-pending", Number(pending?.n ?? 0) === 0, `${Number(pending?.n ?? 0)} pending`);
    add("analysis-failed", Number(failed?.n ?? 0) === 0, `${Number(failed?.n ?? 0)} failed (retryable)`);

    const residue = readdirSync(join(this.dataDir, "objects")).filter((f) => f.startsWith(".tmp-"));
    add("temp-residue", residue.length === 0, `${residue.length} temporary file(s)`);

    return { ok: checks.every((ch) => ch.ok || ch.name === "analysis-pending"), checks };
  }

  /** reclaim incremental auto-vacuum pages — explicit, never automatic */
  vacuumIncremental(): void {
    this.db.exec("PRAGMA incremental_vacuum");
  }

  // ------------------------------------------------------------------ stats

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of ["sources", "artifacts", "observations", "entities", "entity_states", "changes", "snapshots"]) {
      out[t] = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0);
    }
    return out;
  }

  // ------------------------------------------------------------- export/import

  /** Consistent SQLite copy via the backup API (never a raw WAL file copy). */
  async backupDatabaseTo(destPath: string): Promise<void> {
    const mod = sqliteModule();
    if (mod.backup) {
      await mod.backup(this.db as never, destPath);
    } else {
      this.db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    }
  }

  objectDigests(): string[] {
    const root = join(this.dataDir, "objects", "sha256");
    const out: string[] = [];
    for (const prefix of existsSync(root) ? readdirSync(root) : []) {
      const d = join(root, prefix);
      if (!statSync(d).isDirectory()) continue;
      for (const f of readdirSync(d)) if (/^[0-9a-f]{64}$/.test(f)) out.push(f);
    }
    return out.sort();
  }
}

function fieldOfKind(kind: string): string {
  if (kind === "version-moved") return "version";
  if (kind === "metadata-changed") return "meta";
  if (kind.startsWith("advisory-")) return "advisory-id";
  if (kind === "verification-transition") return "verification";
  if (kind === "signer-transition") return "signer";
  return "state";
}


