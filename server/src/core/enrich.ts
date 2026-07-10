// server/src/core/enrich.ts
//
// Shared on-demand enrichment adapters (OSV, endoflife.date, GitHub) used by
// every domain, plus the OSV querybatch join used by the code domain to
// attach advisory counts to a whole scope in one request. Every record
// carries its own status, error, and endpoint — never blended.

import type { EnrichItem, EnrichRecord, JoinedAdvisory, SourceRecord } from "../../../shared/types.js";
import { fetchJson, timedFetch } from "../lib/util.js";

export type EnrichRecordT = EnrichRecord;

interface OsvBatchResponse {
  results?: { vulns?: { id: string; modified?: string }[]; next_page_token?: string }[];
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  modified?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  affected?: { ranges?: { events?: { fixed?: string }[] }[] }[];
}

interface EolCycle {
  cycle: string | number;
  latest?: string;
  latestReleaseDate?: string;
  eol?: string | boolean;
  lts?: boolean;
}

interface GithubRelease {
  tag_name: string;
  name?: string;
  published_at?: string;
  prerelease?: boolean;
  html_url: string;
}

// -------------------------------------------- OSV batch join (whole scope)

/**
 * One querybatch POST for an entire package scope: returns per-package
 * advisory id lists (ids only — details are fetched per package on demand).
 */
export async function osvBatchJoin(packages: string[], ecosystem: string): Promise<{
  source: SourceRecord;
  byPackage: Record<string, JoinedAdvisory[]>;
}> {
  const qUrl = "https://api.osv.dev/v1/querybatch";
  const source: SourceRecord = {
    id: "advisories:osv-batch",
    kind: "osv-batch",
    label: `OSV batch (${ecosystem}, ${packages.length} packages)`,
    urls: [qUrl],
    status: "syncing",
    error: null,
    fetchedAt: null,
    advisoryCount: 0,
  };
  const byPackage: Record<string, JoinedAdvisory[]> = {};
  try {
    const res = await timedFetch(qUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: packages.map((name) => ({ package: { name, ecosystem } })) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as OsvBatchResponse;
    (data.results ?? []).forEach((r, i) => {
      const name = packages[i];
      const vulns = r.vulns ?? [];
      if (vulns.length === 0) return;
      byPackage[name] = vulns.map((v) => ({ id: v.id, url: `https://osv.dev/vulnerability/${v.id}` }));
      source.advisoryCount = (source.advisoryCount ?? 0) + vulns.length;
    });
    source.status = "ok";
    source.fetchedAt = Date.now();
    if ((data.results ?? []).some((r) => r.next_page_token)) {
      source.note = "some packages have more advisories than one OSV page — open them for details";
    }
  } catch (e) {
    source.status = "error";
    source.error = String(e instanceof Error ? e.message : e);
  }
  return { source, byPackage };
}

// --------------------------------------------------------------- OSV (demand)

/** Advisories for one package in one ecosystem: querybatch for the full id
 *  list (tiny), then detail-fetch the newest few so the panel carries meaning. */
export async function osvForPackage(name: string, ecosystem: string): Promise<EnrichRecord> {
  const qUrl = "https://api.osv.dev/v1/querybatch";
  const record: EnrichRecord = { id: "enrich:osv", label: `OSV — ${ecosystem}`, url: qUrl, status: "ok", items: [], count: 0, more: false };
  try {
    const res = await timedFetch(qUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: [{ package: { name, ecosystem } }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as OsvBatchResponse;
    const vulns = data.results?.[0]?.vulns ?? [];
    record.count = vulns.length;
    record.more = !!data.results?.[0]?.next_page_token;
    const newest = [...vulns].sort((x, y) => String(y.modified).localeCompare(String(x.modified))).slice(0, 6);
    record.items = await Promise.all(
      newest.map(async (v): Promise<EnrichItem> => {
        try {
          const d = await fetchJson<OsvVuln>(`https://api.osv.dev/v1/vulns/${v.id}`);
          const fixed = (d.affected ?? [])
            .flatMap((af) => af.ranges ?? [])
            .flatMap((r) => r.events ?? [])
            .map((e) => e.fixed)
            .filter((x): x is string => !!x)[0];
          return {
            id: d.id,
            summary: (d.summary ?? d.details ?? "").slice(0, 140),
            severity: d.database_specific?.severity ?? null,
            fixedIn: fixed ?? null,
            modified: d.modified ?? null,
            aliases: (d.aliases ?? []).slice(0, 4),
            url: `https://osv.dev/vulnerability/${d.id}`,
          };
        } catch {
          return { id: v.id, url: `https://osv.dev/vulnerability/${v.id}` };
        }
      })
    );
    if (record.count === 0) record.status = "empty";
  } catch (e) {
    record.status = "error";
    record.error = String(e instanceof Error ? e.message : e);
  }
  return record;
}

// ---------------------------------------------------------- endoflife.date

export async function eolForSlug(slug: string): Promise<EnrichRecord> {
  const url = `https://endoflife.date/api/${encodeURIComponent(slug)}.json`;
  const record: EnrichRecord = { id: "enrich:eol", label: "endoflife.date", url, status: "ok", items: [] };
  try {
    const res = await timedFetch(url);
    if (res.status === 404) {
      record.status = "empty";
      record.note = `endoflife.date does not track “${slug}”.`;
      return record;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cycles = (await res.json()) as EolCycle[];
    const today = new Date().toISOString().slice(0, 10);
    record.items = (Array.isArray(cycles) ? cycles : []).slice(0, 5).map((c): EnrichItem => ({
      cycle: String(c.cycle),
      latest: c.latest ?? null,
      latestReleaseDate: c.latestReleaseDate ?? null,
      eol: c.eol,
      eolPassed: c.eol === true || (typeof c.eol === "string" && c.eol <= today),
      lts: !!c.lts,
      url: `https://endoflife.date/${slug}`,
    }));
    if (record.items.length === 0) record.status = "empty";
  } catch (e) {
    record.status = "error";
    record.error = String(e instanceof Error ? e.message : e);
  }
  return record;
}

// ------------------------------------------------------------------ GitHub

export async function githubReleases(repo: string, token: string): Promise<EnrichRecord> {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=6`;
  const record: EnrichRecord = { id: "enrich:github", label: `GitHub — ${repo}`, url, status: "ok", items: [] };
  try {
    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await timedFetch(url, { headers });
    if (res.status === 403 || res.status === 429) {
      record.status = "error";
      record.error =
        res.headers.get("x-ratelimit-remaining") === "0"
          ? "GitHub anonymous rate limit exhausted — set enrichment.githubToken or TIDEPOOL_GITHUB_TOKEN."
          : `HTTP ${res.status}`;
      return record;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as GithubRelease[];
    record.items = (rows ?? []).map((r): EnrichItem => ({
      tag: r.tag_name,
      name: r.name ?? null,
      published: r.published_at ?? null,
      prerelease: !!r.prerelease,
      url: r.html_url,
    }));
    if (record.items.length === 0) {
      record.status = "empty";
      record.note = "Repository publishes no GitHub releases.";
    }
  } catch (e) {
    record.status = "error";
    record.error = String(e instanceof Error ? e.message : e);
  }
  return record;
}
