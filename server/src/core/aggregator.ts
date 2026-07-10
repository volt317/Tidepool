// server/src/core/aggregator.ts
//
// The contained aggregation flow — the whole lifecycle a unit of any domain
// moves through, in one place:
//
//   provider.syncIndex()      → merged rows with per-source versions
//   provider.syncAdvisories() → advisory records joined by package name
//   disk cache (TTL'd)        → survive restarts without re-pulling
//   summaries                 → current version (dpkg compare), drift,
//                               advisory counts; search/filter/pagination
//   enrichment                → on-demand OSV / endoflife / GitHub per package
//
// Domains (distro, code) implement only `UnitProvider`: how to enumerate and
// verify their sources. Everything above that line is shared and identical —
// that symmetry is the point.

import type {
  DomainId,
  JoinedAdvisory,
  PackageRow,
  PackageSummary,
  SourceRecord,
  TidepoolConfig,
  UnitStatusBody,
} from "../../../shared/types.js";
import type { DiskCache } from "../lib/util.js";
import { debCompare } from "../lib/util.js";
import { eolForSlug, githubReleases, osvForPackage, type EnrichRecordT } from "./enrich.js";

export interface IndexResult {
  sources: SourceRecord[];
  packages: PackageRow[];
}

export interface AdvisoryJoin {
  source: SourceRecord;
  byPackage: Record<string, JoinedAdvisory[]>;
}

/** What a domain must supply per unit. Nothing else leaks past this seam. */
export interface UnitProvider {
  domain: DomainId;
  id: string;
  label: string;
  kind: string;
  osvEcosystem: string | null;
  sourceOrder: string[];
  syncIndex(): Promise<IndexResult>;
  syncAdvisories(): Promise<AdvisoryJoin>;
}

interface UnitState {
  status: "idle" | "syncing" | "ready" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  sources: SourceRecord[];
  packages: PackageRow[];
  advisoriesByPackage: Record<string, JoinedAdvisory[]>;
  error: string | null;
}

const blank = (): UnitState => ({
  status: "idle",
  startedAt: null,
  finishedAt: null,
  sources: [],
  packages: [],
  advisoriesByPackage: {},
  error: null,
});

interface IndexCachePayload {
  sources: SourceRecord[];
  packages: PackageRow[];
}
interface AdvisoryCachePayload {
  source: SourceRecord;
  byPackage: Record<string, JoinedAdvisory[]>;
}
interface EnrichPayload {
  package: string;
  records: EnrichRecordT[];
}

export interface PackagesQuery {
  q?: string;
  page?: number;
  per?: number;
  advisoriesOnly?: boolean;
  driftOnly?: boolean;
}

export class Aggregator {
  private providers = new Map<string, UnitProvider>();
  private states = new Map<string, UnitState>();
  private disk: DiskCache;
  private config: TidepoolConfig;

  constructor(providers: UnitProvider[], disk: DiskCache, config: TidepoolConfig) {
    this.disk = disk;
    this.config = config;
    for (const p of providers) this.providers.set(key(p.domain, p.id), p);
  }

  private indexTtl(): number {
    return (this.config.server.indexTtlHours ?? 6) * 3600 * 1000;
  }
  private advisoryTtl(): number {
    return (this.config.server.advisoryTtlHours ?? 2) * 3600 * 1000;
  }
  private githubToken(): string {
    return process.env.TIDEPOOL_GITHUB_TOKEN || this.config.enrichment?.githubToken || "";
  }

  domains(): { id: DomainId; label: string; units: UnitStatusBody[] }[] {
    const order: { id: DomainId; label: string }[] = [
      { id: "distro", label: "Distributions" },
      { id: "code", label: "Code ecosystems" },
    ];
    return order
      .map((d) => ({
        ...d,
        units: [...this.providers.values()].filter((p) => p.domain === d.id).map((p) => this.status(p)),
      }))
      .filter((d) => d.units.length > 0);
  }

  provider(domain: string, id: string): UnitProvider | undefined {
    return this.providers.get(key(domain, id));
  }

  private status(p: UnitProvider): UnitStatusBody {
    const st = this.states.get(key(p.domain, p.id));
    return {
      domain: p.domain,
      id: p.id,
      label: p.label,
      kind: p.kind,
      osvEcosystem: p.osvEcosystem,
      sourceOrder: p.sourceOrder,
      status: st?.status ?? "idle",
      startedAt: st?.startedAt ?? null,
      finishedAt: st?.finishedAt ?? null,
      packageCount: st?.packages.length ?? 0,
      error: st?.error ?? null,
      sources: st?.sources ?? [],
    };
  }

  async sync(p: UnitProvider, opts: { force?: boolean } = {}): Promise<UnitState> {
    const k = key(p.domain, p.id);
    const st = this.states.get(k) ?? blank();
    if (st.status === "syncing") return st;
    this.states.set(k, st);

    if (!opts.force) {
      const cached = this.disk.get<IndexCachePayload>(`index-${k}`, this.indexTtl());
      const cachedAdv = this.disk.get<AdvisoryCachePayload>(`advisories-${k}`, this.advisoryTtl());
      if (cached && cachedAdv) {
        st.packages = cached.data.packages;
        st.sources = [...cached.data.sources, cachedAdv.data.source];
        st.advisoriesByPackage = cachedAdv.data.byPackage;
        st.status = "ready";
        st.finishedAt = cached.savedAt;
        return st;
      }
    }

    st.status = "syncing";
    st.startedAt = Date.now();
    st.error = null;
    try {
      const [index, adv] = await Promise.all([p.syncIndex(), p.syncAdvisories()]);
      st.packages = index.packages;
      st.sources = [...index.sources, adv.source];
      st.advisoriesByPackage = adv.byPackage;
      st.status = index.sources.some((s) => s.status === "ok") ? "ready" : "error";
      if (st.status === "error") st.error = "no index source succeeded — see per-source errors";
      st.finishedAt = Date.now();
      this.disk.set<IndexCachePayload>(`index-${k}`, { sources: index.sources, packages: index.packages });
      this.disk.set<AdvisoryCachePayload>(`advisories-${k}`, { source: adv.source, byPackage: adv.byPackage });
    } catch (e) {
      st.status = "error";
      st.error = String(e instanceof Error ? e.message : e);
      st.finishedAt = Date.now();
    }
    return st;
  }

  async ensureSynced(p: UnitProvider): Promise<UnitState> {
    const st = this.states.get(key(p.domain, p.id));
    if (st && (st.status === "ready" || st.status === "syncing")) return st;
    return this.sync(p);
  }

  // ----------------------------------------------------------- summaries

  private summarize(row: PackageRow, order: string[], adv: Record<string, JoinedAdvisory[]>): PackageSummary {
    const advisories = adv[row.name] ?? adv[row.source] ?? [];
    let current: string | null = null;
    for (const k2 of order) {
      const v = row.versions[k2];
      if (v && (current === null || debCompare(v, current) > 0)) current = v;
    }
    const present = order.filter((k2) => row.versions[k2]);
    const drift = present.length >= 2 && present.some((k2) => row.versions[k2] !== row.versions[present[0]]);
    return {
      name: row.name,
      source: row.source,
      component: row.component,
      section: row.section,
      description: row.description,
      versions: row.versions,
      current,
      drift,
      advisoryCount: advisories.length,
    };
  }

  packages(p: UnitProvider, st: UnitState, query: PackagesQuery) {
    const order = p.sourceOrder;
    const q = (query.q ?? "").toLowerCase();
    const per = Math.min(query.per ?? 50, 500);
    const page = Math.max(query.page ?? 1, 1);

    let rows = st.packages;
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.source.toLowerCase().includes(q));
    let summaries = rows.map((r) => this.summarize(r, order, st.advisoriesByPackage));
    if (query.advisoriesOnly) summaries = summaries.filter((s) => s.advisoryCount > 0);
    if (query.driftOnly) summaries = summaries.filter((s) => s.drift);

    return {
      total: summaries.length,
      page,
      per,
      sourceOrder: order,
      items: summaries.slice((page - 1) * per, page * per),
    };
  }

  detail(p: UnitProvider, st: UnitState, name: string) {
    const row = st.packages.find((r) => r.name === name);
    if (!row) return null;
    return {
      domain: p.domain,
      unit: p.id,
      package: row,
      sourceOrder: p.sourceOrder,
      summary: this.summarize(row, p.sourceOrder, st.advisoriesByPackage),
      advisories: st.advisoriesByPackage[row.name] ?? st.advisoriesByPackage[row.source] ?? [],
      hints: this.config.packageHints?.[row.source] ?? this.config.packageHints?.[row.name] ?? null,
    };
  }

  // ---------------------------------------------------------- enrichment

  async enrich(p: UnitProvider, st: UnitState, name: string): Promise<{ payload: EnrichPayload; cached: boolean } | null> {
    const row = st.packages.find((r) => r.name === name);
    if (!row) return null;

    const cacheKey = `enrich-${key(p.domain, p.id)}-${row.name}`;
    const cached = this.disk.get<EnrichPayload>(cacheKey, this.advisoryTtl());
    if (cached) return { payload: cached.data, cached: true };

    const hints = this.config.packageHints?.[row.source] ?? this.config.packageHints?.[row.name] ?? {};
    const en = this.config.enrichment ?? {};
    const tasks: Promise<EnrichRecordT>[] = [];
    if (en.osv !== false && p.osvEcosystem) tasks.push(osvForPackage(row.source || row.name, p.osvEcosystem));
    if (en.endoflife !== false && hints.eol) tasks.push(eolForSlug(hints.eol));
    if (en.github !== false && hints.github) tasks.push(githubReleases(hints.github, this.githubToken()));

    const records = await Promise.all(tasks);
    const payload: EnrichPayload = { package: row.name, records };
    // never pin a transient outage: all-error results are not cached
    if (records.some((r) => r.status !== "error")) this.disk.set(cacheKey, payload);
    return { payload, cached: false };
  }
}

const key = (domain: string, id: string) => `${domain}/${id}`;

/** Small concurrency limiter for per-package surface fetches. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
