// server/src/sources/apk_arch.ts
//
// Index collectors for the apk family (Alpine) and Arch Linux.
// Same contract as apt.js: every remote endpoint is its own source record
// with independent status, and packages carry per-repo versions.

import type { AdvisoryConfig, ApkIndexConfig, ArchIndexConfig, DistroConfig, JoinedAdvisory, PackageRow, SourceRecord } from "../../../shared/types.js";
import type { IndexResult } from "./apt.js";
import { fetchBytes, fetchJson, gunzip, tarEntries } from "../lib/util.js";

export interface AdvisoryJoin {
  source: SourceRecord;
  byPackage: Record<string, JoinedAdvisory[]>;
}

interface ArchApiPage {
  num_pages?: number;
  results?: { pkgname: string; pkgbase?: string; arch: string; url?: string; pkgdesc?: string; epoch?: number; pkgver: string; pkgrel: string }[];
}

interface AlpineSecdb {
  packages?: { pkg?: { name?: string; secfixes?: Record<string, string[]> } }[];
}

interface ArchIssue {
  name: string;
  packages?: string[];
  severity?: string;
  status?: string;
  fixed?: string | null;
}

// ------------------------------------------------------------------ Alpine

/** Parse an APKINDEX body: blank-line-separated blocks of "X:value" lines. */
function parseApkIndex(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const block of text.split("\n\n")) {
    const rec: Record<string, string> = {};
    for (const line of block.split("\n")) {
      if (line.length > 2 && line[1] === ":") rec[line[0]] = line.slice(2);
    }
    if (rec.P && rec.V) out.push(rec);
  }
  return out;
}

export async function syncApkIndex(distroCfg: DistroConfig): Promise<IndexResult> {
  const idx = distroCfg.index as ApkIndexConfig;
  const { base, repos, arch } = idx;
  const sources: SourceRecord[] = [];
  const byName = new Map<string, PackageRow>();

  for (const repo of repos) {
    const url = `${base}/${repo}/${arch}/APKINDEX.tar.gz`;
    const source: SourceRecord = {
      id: `repo:${repo}`,
      kind: "apk-index",
      label: `${repo}/${arch} APKINDEX`,
      urls: [url],
      status: "syncing",
      verified: null, // APKINDEX signature (RSA in the tarball) not yet verified — stated, not hidden
      error: null,
      fetchedAt: null,
      packageCount: 0,
    };
    try {
      const gz = await fetchBytes(url);
      const tar = gunzip(gz);
      const entry = tarEntries(tar).find((e) => e.name === "APKINDEX" || e.name.endsWith("/APKINDEX"));
      if (!entry) throw new Error("APKINDEX member not found in tarball");
      const records = parseApkIndex(entry.data.toString("utf8"));
      for (const r of records) {
        let row = byName.get(r.P);
        if (!row) {
          row = {
            name: r.P,
            source: r.o || r.P, // origin = source package
            section: null,
            component: repo,
            arch: r.A || arch,
            homepage: r.U || null,
            description: r.T || null,
            versions: {},
          };
          byName.set(r.P, row);
        }
        row.versions[repo] = r.V;
      }
      source.status = "ok";
      source.fetchedAt = Date.now();
      source.packageCount = records.length;
    } catch (e) {
      source.status = "error";
      source.error = String(e instanceof Error ? e.message : e);
    }
    sources.push(source);
  }

  const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { sources, packages };
}

/** Alpine's own security database: join secfixes onto the package list. */
export async function fetchAlpineSecdb(advCfg: AdvisoryConfig): Promise<AdvisoryJoin> {
  const source: SourceRecord = {
    id: "advisories:alpine-secdb",
    kind: "alpine-secdb",
    label: "Alpine secdb",
    urls: [...(advCfg.urls ?? [])],
    status: "syncing",
    error: null,
    fetchedAt: null,
    advisoryCount: 0,
  };
  const byPackage = new Map<string, JoinedAdvisory[]>();
  try {
    for (const url of advCfg.urls ?? []) {
      const db = await fetchJson<AlpineSecdb>(url);
      for (const p of db.packages ?? []) {
        const pkg = p.pkg ?? {};
        const fixes = pkg.secfixes ?? {};
        for (const [version, cves] of Object.entries(fixes)) {
          for (const cve of cves) {
            if (!pkg.name) continue;
            const list = byPackage.get(pkg.name) ?? [];
            list.push({
              id: cve.split(" ")[0],
              fixedIn: version,
              url: `https://security.alpinelinux.org/vuln/${cve.split(" ")[0]}`,
            });
            byPackage.set(pkg.name, list);
            source.advisoryCount = (source.advisoryCount ?? 0) + 1;
          }
        }
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

// -------------------------------------------------------------------- Arch

export async function syncArchIndex(distroCfg: DistroConfig): Promise<IndexResult> {
  const idx = distroCfg.index as ArchIndexConfig;
  const { api, repos, maxPagesPerRepo } = idx;
  const sources: SourceRecord[] = [];
  const byName = new Map<string, PackageRow>();

  for (const repo of repos) {
    const source: SourceRecord = {
      id: `repo:${repo}`,
      kind: "arch-packages-api",
      label: `${repo} via packages API`,
      urls: [`${api}?repo=${repo}`],
      status: "syncing",
      verified: null,
      error: null,
      fetchedAt: null,
      packageCount: 0,
    };
    try {
      let page = 1;
      let numPages = 1;
      let count = 0;
      do {
        const url = `${api}?repo=${encodeURIComponent(repo)}&page=${page}`;
        const data = await fetchJson<ArchApiPage>(url);
        numPages = data.num_pages ?? 1;
        for (const r of data.results ?? []) {
          let row = byName.get(r.pkgname);
          if (!row) {
            row = {
              name: r.pkgname,
              source: r.pkgbase || r.pkgname,
              section: null,
              component: repo.toLowerCase(),
              arch: r.arch,
              homepage: r.url || null,
              description: r.pkgdesc || null,
              versions: {},
            };
            byName.set(r.pkgname, row);
          }
          row.versions[repo.toLowerCase()] = `${r.epoch ? r.epoch + ":" : ""}${r.pkgver}-${r.pkgrel}`;
          count++;
        }
        page++;
      } while (page <= numPages && page <= (maxPagesPerRepo || 60));
      if (numPages > (maxPagesPerRepo || 60)) {
        source.note = `truncated at ${maxPagesPerRepo} pages of ${numPages} — raise index.maxPagesPerRepo for the full repo`;
      }
      source.status = "ok";
      source.fetchedAt = Date.now();
      source.packageCount = count;
    } catch (e) {
      source.status = "error";
      source.error = String(e instanceof Error ? e.message : e);
    }
    sources.push(source);
  }

  const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { sources, packages };
}

/** Arch Vulnerability Group feed: join AVGs onto package names. */
export async function fetchArchAvg(advCfg: AdvisoryConfig): Promise<AdvisoryJoin> {
  const source: SourceRecord = {
    id: "advisories:arch-avg",
    kind: "arch-avg",
    label: "Arch AVG feed",
    urls: advCfg.url ? [advCfg.url] : [],
    status: "syncing",
    error: null,
    fetchedAt: null,
    advisoryCount: 0,
  };
  const byPackage = new Map<string, JoinedAdvisory[]>();
  try {
    if (!advCfg.url) throw new Error("arch-avg advisories require a url");
    const issues = await fetchJson<ArchIssue[]>(advCfg.url);
    if (!Array.isArray(issues)) throw new Error("unexpected AVG payload shape (expected array)");
    for (const issue of issues) {
      for (const pkg of issue.packages ?? []) {
        const list = byPackage.get(pkg) ?? [];
        list.push({
          id: issue.name,
          severity: issue.severity || null,
          status: issue.status || null,
          fixedIn: issue.fixed || null,
          url: `https://security.archlinux.org/${issue.name}`,
        });
        byPackage.set(pkg, list);
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
