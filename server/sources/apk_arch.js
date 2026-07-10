// server/sources/apk_arch.js
//
// Index collectors for the apk family (Alpine) and Arch Linux.
// Same contract as apt.js: every remote endpoint is its own source record
// with independent status, and packages carry per-repo versions.

import { fetchBytes, fetchJson, gunzip, tarEntries } from "../lib/util.js";

// ------------------------------------------------------------------ Alpine

/** Parse an APKINDEX body: blank-line-separated blocks of "X:value" lines. */
function parseApkIndex(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    const rec = {};
    for (const line of block.split("\n")) {
      if (line.length > 2 && line[1] === ":") rec[line[0]] = line.slice(2);
    }
    if (rec.P && rec.V) out.push(rec);
  }
  return out;
}

export async function syncApkIndex(distroCfg) {
  const { base, repos, arch } = distroCfg.index;
  const sources = [];
  const byName = new Map();

  for (const repo of repos) {
    const url = `${base}/${repo}/${arch}/APKINDEX.tar.gz`;
    const source = {
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
      source.error = String(e.message || e);
    }
    sources.push(source);
  }

  const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { sources, packages };
}

/** Alpine's own security database: join secfixes onto the package list. */
export async function fetchAlpineSecdb(advCfg) {
  const source = {
    id: "advisories:alpine-secdb",
    kind: "alpine-secdb",
    label: "Alpine secdb",
    urls: [...advCfg.urls],
    status: "syncing",
    error: null,
    fetchedAt: null,
    advisoryCount: 0,
  };
  const byPackage = new Map(); // source-package name -> [{id, version, url}]
  try {
    for (const url of advCfg.urls) {
      const db = await fetchJson(url);
      for (const p of db.packages || []) {
        const pkg = p.pkg || {};
        const fixes = pkg.secfixes || {};
        for (const [version, cves] of Object.entries(fixes)) {
          for (const cve of cves) {
            const list = byPackage.get(pkg.name) || [];
            list.push({
              id: cve.split(" ")[0],
              fixedIn: version,
              url: `https://security.alpinelinux.org/vuln/${cve.split(" ")[0]}`,
            });
            byPackage.set(pkg.name, list);
            source.advisoryCount++;
          }
        }
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

// -------------------------------------------------------------------- Arch

export async function syncArchIndex(distroCfg) {
  const { api, repos, maxPagesPerRepo } = distroCfg.index;
  const sources = [];
  const byName = new Map();

  for (const repo of repos) {
    const source = {
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
        const data = await fetchJson(url);
        numPages = data.num_pages || 1;
        for (const r of data.results || []) {
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
      source.error = String(e.message || e);
    }
    sources.push(source);
  }

  const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { sources, packages };
}

/** Arch Vulnerability Group feed: join AVGs onto package names. */
export async function fetchArchAvg(advCfg) {
  const source = {
    id: "advisories:arch-avg",
    kind: "arch-avg",
    label: "Arch AVG feed",
    urls: [advCfg.url],
    status: "syncing",
    error: null,
    fetchedAt: null,
    advisoryCount: 0,
  };
  const byPackage = new Map();
  try {
    const issues = await fetchJson(advCfg.url);
    if (!Array.isArray(issues)) throw new Error("unexpected AVG payload shape (expected array)");
    for (const issue of issues) {
      for (const pkg of issue.packages || []) {
        const list = byPackage.get(pkg) || [];
        list.push({
          id: issue.name,
          severity: issue.severity || null,
          status: issue.status || null,
          fixedIn: issue.fixed || null,
          url: `https://security.archlinux.org/${issue.name}`,
        });
        byPackage.set(pkg, list);
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
