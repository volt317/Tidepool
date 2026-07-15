// shared/types.ts
//
// The API contract between the collector service and the console. One source
// of truth: the server implements these shapes, the frontend consumes them.

// ------------------------------------------------------------- provenance

/** How thoroughly a source's data was authenticated. */
export type Verification =
  | "signature+digest" // gpgv-verified InRelease AND digest-matched index
  | "digest" // digest-matched against a (fetch-trusted) InRelease
  | null; // no verification applicable/performed

export type SourceStatus = "ok" | "error" | "syncing";

/** One information source (a pocket, a repo index, an advisory feed). */
export interface SourceRecord {
  id: string;
  kind: string;
  label: string;
  urls: string[];
  status: SourceStatus;
  verified?: Verification;
  /** e.g. gpgv "Good signature from …" identities, when signature-verified */
  signedBy?: string[];
  /** digest of the raw fetched artifact backing this source, when it has one */
  artifactDigest?: string | null;
  error?: string | null;
  note?: string;
  fetchedAt?: number | null;
  packageCount?: number;
  advisoryCount?: number;
}

// --------------------------------------------------------------- packages

/** A package as merged from a distro's index sources. */
export interface PackageRow {
  name: string;
  /** source package (apt Source:, apk origin, arch pkgbase) */
  source: string;
  section: string | null;
  component: string;
  arch: string;
  homepage: string | null;
  description: string | null;
  /** per-source versions, keyed by pocket/repo id — never blended */
  versions: Record<string, string>;
}

export interface PackageSummary {
  name: string;
  source: string;
  component: string;
  section: string | null;
  description: string | null;
  versions: Record<string, string>;
  /** greatest version across sources (dpkg comparison) */
  current: string | null;
  /** true when sources disagree on the version */
  drift: boolean;
  advisoryCount: number;
}

// -------------------------------------------------------------- advisories

export interface JoinedAdvisory {
  id: string;
  title?: string | null;
  severity?: string | null;
  status?: string | null;
  published?: string | null;
  fixedIn?: string | null;
  cves?: string[];
  url: string;
}

// -------------------------------------------------------------- enrichment

export interface EnrichItem {
  // OSV
  id?: string;
  summary?: string;
  severity?: string | null;
  fixedIn?: string | null;
  modified?: string | null;
  aliases?: string[];
  // GitHub
  tag?: string;
  name?: string | null;
  published?: string | null;
  prerelease?: boolean;
  // endoflife
  cycle?: string;
  latest?: string | null;
  latestReleaseDate?: string | null;
  eol?: string | boolean;
  eolPassed?: boolean;
  lts?: boolean;
  url: string;
}

export interface EnrichRecord {
  id: string;
  label: string;
  url: string;
  status: "ok" | "empty" | "error";
  items?: EnrichItem[];
  count?: number;
  more?: boolean;
  note?: string;
  error?: string;
}

// -------------------------------------------------------------- API bodies

/** Aggregation domains. Both run the same contained core flow. */
export type DomainId = "distro" | "code";

export interface UnitStatusBody {
  domain: DomainId;
  id: string;
  label: string;
  /** distro family or code ecosystem, e.g. "apt", "crates-io" */
  kind: string;
  osvEcosystem: string | null;
  /** ordered ids of this unit's index sources (pockets / repos / surfaces) */
  sourceOrder: string[];
  status: "idle" | "syncing" | "ready" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  packageCount: number;
  error: string | null;
  sources: SourceRecord[];
}

export interface DomainBody {
  id: DomainId;
  label: string;
  units: UnitStatusBody[];
}

export interface PackagesBody {
  total: number;
  page: number;
  per: number;
  sourceOrder: string[];
  items: PackageSummary[];
}

export interface PackageDetailBody {
  domain: DomainId;
  unit: string;
  package: PackageRow;
  sourceOrder: string[];
  summary: PackageSummary;
  advisories: JoinedAdvisory[];
  hints: PackageHints | null;
}

export interface EnrichBody {
  package: string;
  records: EnrichRecord[];
  cached?: boolean;
}

// ----------------------------------------------------------- configuration

export type DistroFamily = "apt" | "apk" | "arch";

export interface AptPocket {
  id: string;
  base: string;
  suite: string;
}

export interface AptIndexConfig {
  pockets: AptPocket[];
  components: string[];
  arch: string;
  verifyDigests?: boolean;
  /** require gpgv verification of each pocket's InRelease (fail-closed) */
  verifySignatures?: boolean;
  /** keyring files handed to gpgv --keyring; first existing set is used */
  keyrings?: string[];
}

export interface ApkIndexConfig {
  base: string;
  repos: string[];
  arch: string;
}

export interface ArchIndexConfig {
  api: string;
  repos: string[];
  maxPagesPerRepo?: number;
}

export interface AdvisoryConfig {
  kind: "ubuntu-notices" | "alpine-secdb" | "arch-avg" | "osv-on-demand" | "none";
  url?: string;
  urls?: string[];
  release?: string;
  pages?: number;
}

export interface DistroConfig {
  id: string;
  label: string;
  codename?: string;
  family: DistroFamily;
  enabled?: boolean;
  index: AptIndexConfig | ApkIndexConfig | ArchIndexConfig;
  advisories?: AdvisoryConfig;
  osvEcosystem?: string | null;
}

// ---------------------------------------------------- code-ecosystem units

export type CodeEcosystem =
  | "crates-io"
  | "pypi"
  | "npm"
  | "rubygems"
  | "maven"
  | "go"
  | "nuget"
  | "packagist"
  | "hex"
  | "pub"
  | "cran"
  | "conan"
  | "vcpkg";

export interface CodeScope {
  /** "list" = the explicit package set below. The seam is deliberate:
   *  registry-wide enumerators plug in here as further modes. */
  mode: "list";
  packages: string[];
}

export interface CodeUnitConfig {
  id: string;
  label: string;
  enabled?: boolean;
  ecosystem: CodeEcosystem;
  osvEcosystem?: string | null;
  scope: CodeScope;
}

export interface PackageHints {
  github?: string;
  eol?: string;
}

export interface TidepoolConfig {
  server: {
    port?: number;
    cacheDir?: string;
    dataDir?: string;
    indexTtlHours?: number;
    advisoryTtlHours?: number;
  };
  distros: DistroConfig[];
  ecosystems?: CodeUnitConfig[];
  /** Deployment-evolution addition: scheduler cadence and maintenance
   *  policy belong to the ONE validated configuration document, not to
   *  environment variables (env stays for deployment wiring only). */
  scheduler?: {
    enabled?: boolean;
    /** durations: "<n>h" | "<n>d" | "<n>m" (e.g. "6h", "7d") */
    collectionInterval?: string;
    snapshotInterval?: string;
    verificationInterval?: string;
    enrichmentInterval?: string;
    snapshotStage?: SnapshotStage;
    snapshotWindowHours?: number;
  };
  /** strict local HTTP admission + self-managed TLS (deployment evolution) */
  http?: {
    enabled?: boolean;
    listenAddress?: string;
    port?: number;
    allowedHosts?: string[];
    tls?: {
      mode?: "disabled" | "generated-local-ca" | "generated-self-signed" | "provided";
      serverNames?: string[];
      ipAddresses?: string[];
      renewBeforeDays?: number;
      certLifetimeDays?: number;
      keyAlgorithm?: "ec-p256" | "ed25519" | "rsa-3072";
    };
    authentication?: { mode?: "none" | "basic-over-tls" | "mtls" };
    limits?: {
      maxConnections?: number;
      maxConnectionsPerClient?: number;
      maxHeaderBytes?: number;
      maxHeaders?: number;
      maxQueryBytes?: number;
      requestTimeoutMs?: number;
    };
  };
  maintenance?: {
    publishReplicaAfterCollection?: boolean;
    enrichment?: {
      /** enrich packages that changed during the latest window */
      changedWindowHours?: number;
      /** upper bound of packages enriched per policy run */
      maxPerRun?: number;
    };
    backup?: { enabled?: boolean; retainVerified?: number };
    retention?: { enabled?: boolean };
  };
  enrichment?: {
    osv?: boolean;
    endoflife?: boolean;
    github?: boolean;
    githubToken?: string;
  };
  packageHints?: Record<string, PackageHints>;
}

// ============================================================ inflow model

/** An immutable record of one collection act against one source. */
export interface Observation {
  /** content address over (unit, source, collectedAt, recordsDigest, …) */
  id: string;
  domain: DomainId;
  unit: string;
  /** the authority as configured (unit label) */
  authority: string;
  /** source within the unit, e.g. "pocket:security", "surface:api" */
  sourceId: string;
  collectedAt: number;
  /** human-readable observation scope, e.g. "noble-security main/amd64" */
  scope: string;
  verification: Verification;
  signedBy?: string[];
  status: "ok" | "error";
  error?: string | null;
  coverage: {
    observed: number;
    limitations: string[];
  };
  /** digest of the raw fetched artifact when the source has one */
  artifactDigest: string | null;
  parserVersion: string;
  /** digest of the unit's configuration block at collection time */
  configVersion: string;
  /** content address of the normalized records blob (records/<digest>.json) */
  recordsDigest: string;
  recordCount: number;
}

export type ChangeKind =
  | "package-added"
  | "package-removed"
  | "version-moved"
  | "metadata-changed"
  | "advisory-published"
  | "advisory-modified"
  | "advisory-withdrawn"
  | "advisory-left-coverage-window"
  | "advisory-no-longer-observed"
  | "source-failure"
  | "source-recovery"
  | "verification-transition"
  | "signer-transition"
  // evidence (enrichment) observations — deployment-evolution addition:
  // enrichment results are first-class observations now, so their
  // appearance/change/disappearance are first-class change kinds
  | "evidence-observed"
  | "evidence-changed"
  | "evidence-no-longer-observed";

/** A deterministic difference between two observations of the same source. */
export interface ChangeRecord {
  id: string;
  domain: DomainId;
  unit: string;
  sourceId: string;
  kind: ChangeKind;
  package?: string;
  from?: string | null;
  to?: string | null;
  detail?: string;
  /** structured field-level differences (e.g. component/section for metadata) */
  fields?: Record<string, { from: string | null; to: string | null }>;
  fromObservation: string | null;
  toObservation: string;
  detectedAt: number;
}

// ===================================================== inflow heuristics

export interface HeuristicFinding {
  ruleId: string;
  title: string;
  severityHint: "info" | "notable" | "attention";
  summary: string;
  /** what the confidence rests on */
  confidenceBasis: string;
  confidence: number; // 0..1
  subjects: string[]; // units and/or packages
  evidence: {
    observations: string[];
    changes: string[];
  };
  ambiguities: string[];
}

// ============================================================== snapshots

export type SnapshotStage = "observation" | "churn" | "interpretive";

export interface SnapshotEntity {
  domain: DomainId;
  unit: string;
  name: string;
  source: string;
  versions: Record<string, string>;
  current: string | null;
  /** whether `current` is a native ordering claim or unsupported for this ecosystem */
  ordering: "native" | "unsupported";
  drift: boolean;
  advisoryCount: number;
}

export interface SnapshotSourceCoverage {
  domain: DomainId;
  unit: string;
  authority: string;
  sourceId: string;
  status: "ok" | "error" | "unobserved";
  verification: Verification;
  signedBy?: string[];
  recordCount: number;
  collectedAt: number | null;
  error?: string | null;
  limitations: string[];
}

export interface SnapshotDoc {
  schema: "tidepool-snapshot-v1";
  stage: SnapshotStage;
  generatorVersion: string;
  createdAt: number;
  scope: {
    domains: DomainId[];
    units: string[];
  };
  window: { from: number; to: number };
  authorities: string[];
  coverage: SnapshotSourceCoverage[];
  /** explicit truth boundary */
  notObserved: string[];
  entities: SnapshotEntity[];
  observations: Observation[];
  changes: ChangeRecord[];
  relationships: { kind: string; a: string; b: string; rationale: string }[];
  findings: HeuristicFinding[];
  /** exact rule versions used — changed rule logic changes the snapshot */
  ruleVersions: Record<string, string>;
  ambiguities: string[];
  /** filled after digesting */
  digest?: string;
}

// =============================================================== dispatch

export type ProjectClass =
  | "rust-workspace"
  | "node-project"
  | "python-project"
  | "c-cpp-project"
  | "linux-package"
  | "container-image"
  | "kernel-module"
  | "mixed-monorepo"
  | "unrecognized";

export interface ProjectDependency {
  ecosystem: string; // maps to a code unit kind or distro
  name: string;
  /** locked or pinned version when known */
  version: string | null;
  origin: string; // which manifest/lockfile declared it
}

export interface ProjectProfile {
  path: string;
  classes: ProjectClass[];
  languages: string[];
  buildSystems: string[];
  manifests: string[];
  dependencies: ProjectDependency[];
  baseImages: { image: string; unit: string | null }[];
  fingerprint: string;
}

export type DispatchFindingKind =
  | "no-relevant-upstream-change"
  | "informational-upstream-change"
  | "dependency-update-available"
  | "rebuild-recommended"
  | "retest-recommended"
  | "compatibility-review-required"
  | "security-review-required"
  | "insufficient-evidence";

export interface DispatchFinding {
  path: string;
  kind: DispatchFindingKind;
  subject: string;
  summary: string;
  confidence: number;
  confidenceBasis: string;
  evidence: {
    snapshotEntities: string[];
    changes: string[];
    localOrigins: string[];
  };
  recommendedAction: string;
}

export interface DispatchArtifact {
  schema: "tidepool-dispatch-v1";
  createdAt: number;
  snapshotDigest: string;
  snapshotWindow: { from: number; to: number };
  targets: ProjectProfile[];
  findings: DispatchFinding[];
  sharedExposure: {
    ecosystem: string;
    name: string;
    paths: string[];
    rationale: string;
  }[];
  ambiguities: string[];
  analyzerVersions: Record<string, string>;
  digest?: string;
}
