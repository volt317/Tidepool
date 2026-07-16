// server/src/core/store.types.ts
//
// The storage CONTRACT, separated from the SQLite implementation so that
// everything above the storage layer — collectors, providers, snapshot
// builders, routes, dispatch — can depend on the interface without pulling
// in the implementation module. store.ts re-exports everything here, so
// `import ... from "./store.js"` continues to work unchanged.

import type {
  ChangeRecord,
  DomainId,
  Observation,
  SnapshotEntity,
  SnapshotSourceCoverage,
  Verification,
} from "../../../shared/types.js";
import type {
  AdvisoryRecordLite,
  CoverageMode,
  EvidenceRecordLite,
  IndexRecordLite,
} from "./inflow.js";

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
  recordKind: "index" | "advisory" | "evidence";
  records: IndexRecordLite[] | AdvisoryRecordLite[] | EvidenceRecordLite[];
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
  /** stored enrichment evidence for a subject (deployment-evolution) */
  evidenceFor(domain: string, unitId: string, subject: string): { sourceType: string; observedAt: string; records: unknown[] }[];
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
  recordKind: "index" | "advisory" | "evidence";
  records: IndexRecordLite[] | AdvisoryRecordLite[] | EvidenceRecordLite[];
}
