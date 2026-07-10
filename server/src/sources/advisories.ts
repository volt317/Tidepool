// server/src/sources/advisories.ts
//
// Advisory feeds joined against the comprehensive list, plus the on-demand
// per-package enrichment adapters (fetched when a package is opened).
// Every function returns a source record with independent status and
// provenance URLs — a failing feed is a visible fact, not a silent gap.

import type { AdvisoryConfig, EnrichItem, EnrichRecord, JoinedAdvisory, SourceRecord } from "../../../shared/types.js";
import type { AdvisoryJoin } from "./apk_arch.js";
import { fetchJson, timedFetch } from "../lib/util.js";

interface UbuntuNoticesPage {
  notices?: {
    id: string;
    title?: string;
    published?: string;
    cves_ids?: string[];
    cves?: string[];
    release_packages?: Record<string, { name: string; source?: string; version?: string; source_link?: string }[]>;
  }[];
}

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

// -------------------------------------------------- Ubuntu Security Notices

/**
 * Pull the newest N pages of ubuntu.com's USN feed for a release and map
 * source-package name -> notices. The feed is newest-first; `pages` bounds
 * how far back the join reaches (configurable).
 */
export async function fetchUbuntuNotices(advCfg: AdvisoryConfig): Promise<AdvisoryJoin> {
  const source: SourceRecord = {
    id: "advisories:ubuntu-notices",
    kind: "ubuntu-notices",
    label: `USN feed (${advCfg.release}, newest ${(advCfg.pages ?? 3) * 100})`,
    urls: [],
    status: "syncing",
    error: null,
    fetchedAt: null,
    advisoryCount: 0,
  };
  const byPackage = new Map<string, JoinedAdvisory[]>();
  try {
    for (let page = 0; page < (advCfg.pages ?? 3); page++) {
      if (!advCfg.url || !advCfg.release) throw new Error("ubuntu-notices advisories require url and release");
      const url = `${advCfg.url}?release=${encodeURIComponent(advCfg.release)}&limit=100&offset=${page * 100}`;
      source.urls.push(url);
      const data = await fetchJson<UbuntuNoticesPage>(url);
      const notices = data.notices ?? [];
      if (notices.length === 0) break;
      for (const n of notices) {
        const pkgs = (advCfg.release && n.release_packages?.[advCfg.release]) || [];
        const seen = new Set<string>();
        for (const p of pkgs) {
          for (const key of [p.name, p.source]) {
            if (!key || seen.has(key + n.id)) continue;
            seen.add(key + n.id);
            const list = byPackage.get(key) ?? [];
            list.push({
              id: n.id,
              title: n.title || null,
              published: n.published || null,
              fixedIn: p.version || null,
              cves: (n.cves_ids ?? n.cves ?? []).slice(0, 6),
              url: `https://ubuntu.com/security/notices/${n.id}`,
            });
            byPackage.set(key, list);
          }
        }
        source.advisoryCount = (source.advisoryCount ?? 0) + 1;
      }
    }
    source.status = "ok";
    source.fetchedAt = Date.now();
  } catch (e) {
    source.status = "error";
    source.error = String(e instanceof Error ? e.message : e);
  }
  return { source, byPackage: Object.fromEntries(byPackage) };
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
