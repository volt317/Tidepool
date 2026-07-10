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

export interface DistroStatusBody {
  id: string;
  label: string;
  family: DistroFamily;
  osvEcosystem: string | null;
  pocketOrder: string[];
  status: "idle" | "syncing" | "ready" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  packageCount: number;
  error: string | null;
  sources: SourceRecord[];
}

export interface PackagesBody {
  total: number;
  page: number;
  per: number;
  pocketOrder: string[];
  items: PackageSummary[];
}

export interface PackageDetailBody {
  distro: string;
  package: PackageRow;
  pocketOrder: string[];
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

export interface PackageHints {
  github?: string;
  eol?: string;
}

export interface TidepoolConfig {
  server: {
    port?: number;
    cacheDir?: string;
    indexTtlHours?: number;
    advisoryTtlHours?: number;
  };
  distros: DistroConfig[];
  enrichment?: {
    osv?: boolean;
    endoflife?: boolean;
    github?: boolean;
    githubToken?: string;
  };
  packageHints?: Record<string, PackageHints>;
}
