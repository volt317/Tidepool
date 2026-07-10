// server/sources/advisories.js
//
// Advisory feeds joined against the comprehensive list, plus the on-demand
// per-package enrichment adapters (fetched when a package is opened).
// Every function returns a source record with independent status and
// provenance URLs — a failing feed is a visible fact, not a silent gap.

import { fetchJson, timedFetch } from "../lib/util.js";

// -------------------------------------------------- Ubuntu Security Notices

/**
 * Pull the newest N pages of ubuntu.com's USN feed for a release and map
 * source-package name -> notices. The feed is newest-first; `pages` bounds
 * how far back the join reaches (configurable).
 */
export async function fetchUbuntuNotices(advCfg) {
  const source = {
    id: "advisories:ubuntu-notices",
    kind: "ubuntu-notices",
    label: `USN feed (${advCfg.release}, newest ${advCfg.pages * 100})`,
    urls: [],
    status: "syncing",
    error: null,
    fetchedAt: null,
    advisoryCount: 0,
  };
  const byPackage = new Map();
  try {
    for (let page = 0; page < (advCfg.pages || 3); page++) {
      const url = `${advCfg.url}?release=${encodeURIComponent(advCfg.release)}&limit=100&offset=${page * 100}`;
      source.urls.push(url);
      const data = await fetchJson(url);
      const notices = data.notices || [];
      if (notices.length === 0) break;
      for (const n of notices) {
        const pkgs = (n.release_packages && n.release_packages[advCfg.release]) || [];
        const seen = new Set();
        for (const p of pkgs) {
          const name = p.source_link ? p.name : p.name; // binary rows carry name; join on both binary + source names
          for (const key of [name, p.source]) {
            if (!key || seen.has(key + n.id)) continue;
            seen.add(key + n.id);
            const list = byPackage.get(key) || [];
            list.push({
              id: n.id,
              title: n.title || null,
              published: n.published || null,
              fixedIn: p.version || null,
              cves: (n.cves_ids || n.cves || []).slice(0, 6),
              url: `https://ubuntu.com/security/notices/${n.id}`,
            });
            byPackage.set(key, list);
          }
        }
        source.advisoryCount++;
      }
    }
    source.status = "ok";
    source.fetchedAt = Date.now();
  } catch (e) {
    source.status = "error";
    source.error = String(e.message || e);
  }
  return { source, byPackage: Object.fromEntries(byPackage) };
}

// --------------------------------------------------------------- OSV (demand)

/** Advisories for one package in one ecosystem: querybatch for the full id
 *  list (tiny), then detail-fetch the newest few so the panel carries meaning. */
export async function osvForPackage(name, ecosystem) {
  const qUrl = "https://api.osv.dev/v1/querybatch";
  const record = { id: "enrich:osv", label: `OSV — ${ecosystem}`, url: qUrl, status: "ok", items: [], count: 0, more: false };
  try {
    const res = await timedFetch(qUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: [{ package: { name, ecosystem } }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const vulns = (data.results?.[0]?.vulns) || [];
    record.count = vulns.length;
    record.more = !!data.results?.[0]?.next_page_token;
    const newest = [...vulns].sort((a, b) => String(b.modified).localeCompare(String(a.modified))).slice(0, 6);
    record.items = await Promise.all(
      newest.map(async (v) => {
        try {
          const d = await fetchJson(`https://api.osv.dev/v1/vulns/${v.id}`);
          const fixed = (d.affected || [])
            .flatMap((a) => a.ranges || [])
            .flatMap((r) => r.events || [])
            .map((e) => e.fixed)
            .filter(Boolean)[0];
          return {
            id: d.id,
            summary: (d.summary || d.details || "").slice(0, 140),
            severity: d.database_specific?.severity || null,
            fixedIn: fixed || null,
            modified: d.modified || null,
            aliases: (d.aliases || []).slice(0, 4),
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
    record.error = String(e.message || e);
  }
  return record;
}

// ---------------------------------------------------------- endoflife.date

export async function eolForSlug(slug) {
  const url = `https://endoflife.date/api/${encodeURIComponent(slug)}.json`;
  const record = { id: "enrich:eol", label: "endoflife.date", url, status: "ok", items: [] };
  try {
    const res = await timedFetch(url);
    if (res.status === 404) {
      record.status = "empty";
      record.note = `endoflife.date does not track “${slug}”.`;
      return record;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cycles = await res.json();
    const today = new Date().toISOString().slice(0, 10);
    record.items = (Array.isArray(cycles) ? cycles : []).slice(0, 5).map((c) => ({
      cycle: String(c.cycle),
      latest: c.latest || null,
      latestReleaseDate: c.latestReleaseDate || null,
      eol: c.eol,
      eolPassed: c.eol === true || (typeof c.eol === "string" && c.eol <= today),
      lts: !!c.lts,
      url: `https://endoflife.date/${slug}`,
    }));
    if (record.items.length === 0) record.status = "empty";
  } catch (e) {
    record.status = "error";
    record.error = String(e.message || e);
  }
  return record;
}

// ------------------------------------------------------------------ GitHub

export async function githubReleases(repo, token) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=6`;
  const record = { id: "enrich:github", label: `GitHub — ${repo}`, url, status: "ok", items: [] };
  try {
    const headers = { accept: "application/vnd.github+json" };
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
    const rows = await res.json();
    record.items = (rows || []).map((r) => ({
      tag: r.tag_name,
      name: r.name || null,
      published: r.published_at || null,
      prerelease: !!r.prerelease,
      url: r.html_url,
    }));
    if (record.items.length === 0) {
      record.status = "empty";
      record.note = "Repository publishes no GitHub releases.";
    }
  } catch (e) {
    record.status = "error";
    record.error = String(e.message || e);
  }
  return record;
}
