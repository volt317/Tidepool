// server/src/domains/distro/advisories.ts
//
// Advisory feeds joined against the comprehensive list, plus the on-demand
// per-package enrichment adapters (fetched when a package is opened).
// Every function returns a source record with independent status and
// provenance URLs — a failing feed is a visible fact, not a silent gap.

import type { AdvisoryConfig, JoinedAdvisory, SourceRecord } from "../../../../shared/types.js";
import type { AdvisoryJoin } from "../../core/aggregator.js";
import { fetchJson } from "../../lib/util.js";

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

