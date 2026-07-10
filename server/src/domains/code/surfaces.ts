// server/src/domains/code/surfaces.ts
//
// Registry surfaces for the code domain. The premise mirrors distro pockets:
// each package in a unit's scope is resolved against *multiple independent
// surfaces of its authority*, kept separate, never blended. Where the
// surfaces disagree — API says one latest, the raw index another — that's
// drift, and it is real signal (CDN staleness, yank propagation, prerelease
// policy differences), not noise.
//
//   crates.io : "api"    crates.io/api/v1/crates/{name}   (max stable)
//               "index"  index.crates.io/{prefix}/{name}  (sparse index, raw)
//   PyPI      : "api"    pypi.org/pypi/{name}/json        (info.version)
//               "simple" pypi.org/simple/{name}/          (PEP 691 JSON)
//   npm       : "packument" registry.npmjs.org/{name}     (abbreviated doc)
//               "manifest"  registry.npmjs.org/{name}/latest
//               "yarn"      registry.yarnpkg.com/{name}/latest (cross-host mirror)
//   RubyGems  : "gem"       rubygems.org/api/v1/gems/{name}.json
//               "versions"  rubygems.org/api/v1/versions/{name}/latest.json
//   Maven     : "metadata"  repo1.maven.org …/maven-metadata.xml (the repository)
//               "search"    search.maven.org solrsearch        (the search index)
//   Go        : "latest"    proxy.golang.org/{module}/@latest  (resolved)
//               "list"      proxy.golang.org/{module}/@v/list  (raw version list)
//   NuGet     : "flat"      api.nuget.org/v3-flatcontainer/…/index.json
//               "registration" api.nuget.org/v3/registration5-gz-semver2/…
//   Packagist : "repo"      repo.packagist.org/p2/{name}.json  (metadata CDN)
//               "api"       packagist.org/packages/{name}.json (the app)
//   Hex       : "api"       hex.pm/api/packages/{name}         (single surface)
//   pub.dev   : "api"       pub.dev/api/packages/{name}        (single surface)
//   CRAN      : "description" cran.r-project.org/web/packages/{name}/DESCRIPTION
//
// Note the honesty gradient: crates.io and PyPI expose two genuinely distinct
// serving paths; npm's two are different representations from one backend —
// the surface labels say which is which.

import type { CodeEcosystem } from "../../../../shared/types.js";
import { debCompare, fetchJson, timedFetch } from "../../lib/util.js";

export interface SurfaceHit {
  version: string | null;
  homepage?: string | null;
  description?: string | null;
  /** why version is null when status was reachable, e.g. "not found" */
  note?: string;
}

export interface Surface {
  id: string;
  label: string;
  /** template shown in provenance (with {name}) */
  urlTemplate: string;
  fetch(name: string): Promise<SurfaceHit>;
}

const FINAL_RELEASE = /^\d+(\.\d+)*$/;

// -------------------------------------------------------------- crates.io

function cratesIndexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

const cratesApi: Surface = {
  id: "api",
  label: "crates.io API",
  urlTemplate: "https://crates.io/api/v1/crates/{name}",
  async fetch(name) {
    interface Resp {
      crate?: { max_stable_version?: string; newest_version?: string; description?: string; homepage?: string; repository?: string };
    }
    const d = await fetchJson<Resp>(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
    const c = d.crate ?? {};
    return {
      version: c.max_stable_version ?? c.newest_version ?? null,
      description: c.description ?? null,
      homepage: c.homepage ?? c.repository ?? null,
    };
  },
};

const cratesIndex: Surface = {
  id: "index",
  label: "crates.io sparse index",
  urlTemplate: "https://index.crates.io/{prefix}/{name}",
  async fetch(name) {
    const res = await timedFetch(`https://index.crates.io/${cratesIndexPath(name)}`);
    if (res.status === 404) return { version: null, note: "not in index" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    interface Line {
      vers: string;
      yanked?: boolean;
    }
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Line)
      .filter((l) => !l.yanked);
    if (lines.length === 0) return { version: null, note: "all versions yanked" };
    // latest stable (no prerelease tag); fall back to newest line as published
    const stable = lines.filter((l) => !l.vers.includes("-"));
    const pick = (stable.length ? stable : lines).reduce((a, b) => (debCompare(a.vers, b.vers) >= 0 ? a : b));
    return { version: pick.vers };
  },
};

// ------------------------------------------------------------------- PyPI

const pypiApi: Surface = {
  id: "api",
  label: "PyPI JSON API",
  urlTemplate: "https://pypi.org/pypi/{name}/json",
  async fetch(name) {
    interface Resp {
      info?: { version?: string; summary?: string; home_page?: string; project_urls?: Record<string, string> };
    }
    const res = await timedFetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    if (res.status === 404) return { version: null, note: "not on PyPI" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as Resp;
    return {
      version: d.info?.version ?? null,
      description: d.info?.summary ?? null,
      homepage: d.info?.home_page || d.info?.project_urls?.Homepage || d.info?.project_urls?.Source || null,
    };
  },
};

const pypiSimple: Surface = {
  id: "simple",
  label: "PyPI simple index (PEP 691)",
  urlTemplate: "https://pypi.org/simple/{name}/",
  async fetch(name) {
    const res = await timedFetch(`https://pypi.org/simple/${encodeURIComponent(name)}/`, {
      headers: { accept: "application/vnd.pypi.simple.v1+json" },
    });
    if (res.status === 404) return { version: null, note: "not in simple index" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { versions?: string[] };
    const versions = d.versions ?? [];
    // compare final releases only, so prerelease policy differences between
    // surfaces do not masquerade as drift
    const finals = versions.filter((v) => FINAL_RELEASE.test(v));
    const pool = finals.length ? finals : versions;
    if (pool.length === 0) return { version: null, note: "no versions listed" };
    return { version: pool.reduce((a, b) => (debCompare(a, b) >= 0 ? a : b)) };
  },
};

// -------------------------------------------------------------------- npm

const npmPackument: Surface = {
  id: "packument",
  label: "npm packument (abbreviated)",
  urlTemplate: "https://registry.npmjs.org/{name}",
  async fetch(name) {
    const res = await timedFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (res.status === 404) return { version: null, note: "not on npm" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { "dist-tags"?: { latest?: string } };
    return { version: d["dist-tags"]?.latest ?? null };
  },
};

const npmManifest: Surface = {
  id: "manifest",
  label: "npm latest manifest",
  urlTemplate: "https://registry.npmjs.org/{name}/latest",
  async fetch(name) {
    const res = await timedFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    if (res.status === 404) return { version: null, note: "not on npm" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { version?: string; description?: string; homepage?: string };
    return { version: d.version ?? null, description: d.description ?? null, homepage: d.homepage ?? null };
  },
};

const npmYarnMirror: Surface = {
  id: "yarn",
  label: "yarnpkg mirror (cross-host)",
  urlTemplate: "https://registry.yarnpkg.com/{name}/latest",
  async fetch(name) {
    const res = await timedFetch(`https://registry.yarnpkg.com/${encodeURIComponent(name)}/latest`);
    if (res.status === 404) return { version: null, note: "not on mirror" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { version?: string };
    return { version: d.version ?? null };
  },
};

// --------------------------------------------------------------- RubyGems

const gemApi: Surface = {
  id: "gem",
  label: "RubyGems gem API",
  urlTemplate: "https://rubygems.org/api/v1/gems/{name}.json",
  async fetch(name) {
    const res = await timedFetch(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`);
    if (res.status === 404) return { version: null, note: "not on rubygems.org" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { version?: string; info?: string; homepage_uri?: string };
    return { version: d.version ?? null, description: d.info ?? null, homepage: d.homepage_uri ?? null };
  },
};

const gemVersionsLatest: Surface = {
  id: "versions",
  label: "RubyGems versions API",
  urlTemplate: "https://rubygems.org/api/v1/versions/{name}/latest.json",
  async fetch(name) {
    const res = await timedFetch(`https://rubygems.org/api/v1/versions/${encodeURIComponent(name)}/latest.json`);
    if (res.status === 404) return { version: null, note: "not on rubygems.org" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { version?: string };
    return { version: d.version && d.version !== "unknown" ? d.version : null };
  },
};

// ------------------------------------------------------------------ Maven
// Package names are "group:artifact".

function mavenParts(name: string): { g: string; a: string } | null {
  const i = name.indexOf(":");
  if (i <= 0 || i === name.length - 1) return null;
  return { g: name.slice(0, i), a: name.slice(i + 1) };
}

const mavenMetadata: Surface = {
  id: "metadata",
  label: "Maven Central repository metadata",
  urlTemplate: "https://repo1.maven.org/maven2/{group}/{artifact}/maven-metadata.xml",
  async fetch(name) {
    const p = mavenParts(name);
    if (!p) return { version: null, note: "expected group:artifact" };
    const res = await timedFetch(
      `https://repo1.maven.org/maven2/${p.g.replace(/\./g, "/")}/${p.a}/maven-metadata.xml`
    );
    if (res.status === 404) return { version: null, note: "not in Maven Central" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const release = /<release>([^<]+)<\/release>/.exec(xml)?.[1];
    const latest = /<latest>([^<]+)<\/latest>/.exec(xml)?.[1];
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    return { version: release ?? latest ?? versions[versions.length - 1] ?? null };
  },
};

const mavenSearch: Surface = {
  id: "search",
  label: "Maven Central search index",
  urlTemplate: "https://search.maven.org/solrsearch/select?q=g:{group}+AND+a:{artifact}",
  async fetch(name) {
    const p = mavenParts(name);
    if (!p) return { version: null, note: "expected group:artifact" };
    const q = encodeURIComponent(`g:${p.g} AND a:${p.a}`);
    const d = await fetchJson<{ response?: { docs?: { latestVersion?: string }[] } }>(
      `https://search.maven.org/solrsearch/select?q=${q}&rows=1&wt=json`
    );
    const doc = d.response?.docs?.[0];
    if (!doc) return { version: null, note: "not in search index" };
    return { version: doc.latestVersion ?? null };
  },
};

// --------------------------------------------------------------------- Go
// Package names are module paths; uppercase letters bang-escape per the
// module proxy protocol (e.g. github.com/Foo → github.com/!foo).

const goEscape = (mod: string) => mod.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());

const goLatest: Surface = {
  id: "latest",
  label: "Go module proxy @latest (resolved)",
  urlTemplate: "https://proxy.golang.org/{module}/@latest",
  async fetch(name) {
    const res = await timedFetch(`https://proxy.golang.org/${goEscape(name)}/@latest`);
    if (res.status === 404 || res.status === 410) return { version: null, note: "module not known to proxy" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { Version?: string };
    return { version: d.Version ?? null };
  },
};

const goList: Surface = {
  id: "list",
  label: "Go module proxy @v/list (raw)",
  urlTemplate: "https://proxy.golang.org/{module}/@v/list",
  async fetch(name) {
    const res = await timedFetch(`https://proxy.golang.org/${goEscape(name)}/@v/list`);
    if (res.status === 404 || res.status === 410) return { version: null, note: "module not known to proxy" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const versions = (await res.text()).trim().split("\n").filter(Boolean);
    if (versions.length === 0) return { version: null, note: "no tagged versions (proxy resolves pseudo-versions only)" };
    const finals = versions.filter((v) => !v.includes("-"));
    const pool = finals.length ? finals : versions;
    return { version: pool.reduce((a, b) => (debCompare(a.replace(/^v/, ""), b.replace(/^v/, "")) >= 0 ? a : b)) };
  },
};

// ------------------------------------------------------------------ NuGet

const nugetFlat: Surface = {
  id: "flat",
  label: "NuGet flat container",
  urlTemplate: "https://api.nuget.org/v3-flatcontainer/{id}/index.json",
  async fetch(name) {
    const res = await timedFetch(`https://api.nuget.org/v3-flatcontainer/${name.toLowerCase()}/index.json`);
    if (res.status === 404) return { version: null, note: "not on nuget.org" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { versions?: string[] };
    const versions = d.versions ?? [];
    const finals = versions.filter((v) => !v.includes("-"));
    const pool = finals.length ? finals : versions;
    if (pool.length === 0) return { version: null, note: "no versions listed" };
    return { version: pool.reduce((a, b) => (debCompare(a, b) >= 0 ? a : b)) };
  },
};

const nugetRegistration: Surface = {
  id: "registration",
  label: "NuGet registration index",
  urlTemplate: "https://api.nuget.org/v3/registration5-gz-semver2/{id}/index.json",
  async fetch(name) {
    const res = await timedFetch(`https://api.nuget.org/v3/registration5-gz-semver2/${name.toLowerCase()}/index.json`);
    if (res.status === 404) return { version: null, note: "not on nuget.org" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { items?: { upper?: string }[] };
    const uppers = (d.items ?? []).map((i) => i.upper).filter((x): x is string => !!x);
    if (uppers.length === 0) return { version: null, note: "no registration pages" };
    const finals = uppers.filter((v) => !v.includes("-"));
    const pool = finals.length ? finals : uppers;
    return { version: pool.reduce((a, b) => (debCompare(a, b) >= 0 ? a : b)) };
  },
};

// -------------------------------------------------------------- Packagist
// Package names are "vendor/package". Version values are normalized without
// a leading "v" so tag-style differences between surfaces are not fake drift.

const stripV = (v: string) => v.replace(/^v/, "");

const packagistRepo: Surface = {
  id: "repo",
  label: "Packagist metadata CDN (p2)",
  urlTemplate: "https://repo.packagist.org/p2/{vendor}/{package}.json",
  async fetch(name) {
    const res = await timedFetch(`https://repo.packagist.org/p2/${name}.json`);
    if (res.status === 404) return { version: null, note: "not on packagist" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { packages?: Record<string, { version?: string }[]> };
    const rows = d.packages?.[name] ?? [];
    const versions = rows.map((r) => r.version).filter((x): x is string => !!x && !x.toLowerCase().includes("dev"));
    if (versions.length === 0) return { version: null, note: "no stable versions" };
    return { version: versions.map(stripV).reduce((a, b) => (debCompare(a, b) >= 0 ? a : b)) };
  },
};

const packagistApi: Surface = {
  id: "api",
  label: "packagist.org package API",
  urlTemplate: "https://packagist.org/packages/{vendor}/{package}.json",
  async fetch(name) {
    const res = await timedFetch(`https://packagist.org/packages/${name}.json`);
    if (res.status === 404) return { version: null, note: "not on packagist" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as {
      package?: { description?: string; repository?: string; versions?: Record<string, unknown> };
    };
    const tags = Object.keys(d.package?.versions ?? {}).filter((t) => !t.toLowerCase().includes("dev"));
    if (tags.length === 0) return { version: null, note: "no stable versions" };
    return {
      version: tags.map(stripV).reduce((a, b) => (debCompare(a, b) >= 0 ? a : b)),
      description: d.package?.description ?? null,
      homepage: d.package?.repository ?? null,
    };
  },
};

// ------------------------------------------------- Hex / pub.dev / CRAN
// Single-surface authorities: each exposes one practical read path (Hex's
// repo endpoints are signed protobuf; pub.dev has one package API; CRAN's
// canonical per-package artifact is the DESCRIPTION file). One surface means
// drift cannot fire — stated, not hidden.

const hexApi: Surface = {
  id: "api",
  label: "hex.pm API (single surface)",
  urlTemplate: "https://hex.pm/api/packages/{name}",
  async fetch(name) {
    const res = await timedFetch(`https://hex.pm/api/packages/${encodeURIComponent(name)}`);
    if (res.status === 404) return { version: null, note: "not on hex.pm" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as {
      latest_stable_version?: string;
      latest_version?: string;
      meta?: { description?: string; links?: Record<string, string> };
    };
    return {
      version: d.latest_stable_version ?? d.latest_version ?? null,
      description: d.meta?.description ?? null,
      homepage: d.meta?.links?.GitHub ?? d.meta?.links?.github ?? null,
    };
  },
};

const pubApi: Surface = {
  id: "api",
  label: "pub.dev API (single surface)",
  urlTemplate: "https://pub.dev/api/packages/{name}",
  async fetch(name) {
    const res = await timedFetch(`https://pub.dev/api/packages/${encodeURIComponent(name)}`);
    if (res.status === 404) return { version: null, note: "not on pub.dev" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as {
      latest?: { version?: string; pubspec?: { description?: string; homepage?: string; repository?: string } };
    };
    return {
      version: d.latest?.version ?? null,
      description: d.latest?.pubspec?.description ?? null,
      homepage: d.latest?.pubspec?.homepage ?? d.latest?.pubspec?.repository ?? null,
    };
  },
};

const cranDescription: Surface = {
  id: "description",
  label: "CRAN DESCRIPTION (single surface)",
  urlTemplate: "https://cran.r-project.org/web/packages/{name}/DESCRIPTION",
  async fetch(name) {
    const res = await timedFetch(`https://cran.r-project.org/web/packages/${encodeURIComponent(name)}/DESCRIPTION`);
    if (res.status === 404) return { version: null, note: "not on CRAN" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const version = /^Version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    const title = /^Title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    const url = /^URL:\s*(\S+)/m.exec(text)?.[1]?.replace(/,$/, "") ?? null;
    return { version, description: title, homepage: url };
  },
};

// ----------------------------------------------------------------- lookup

export const SURFACES: Record<CodeEcosystem, Surface[]> = {
  "crates-io": [cratesApi, cratesIndex],
  pypi: [pypiApi, pypiSimple],
  npm: [npmPackument, npmManifest, npmYarnMirror],
  rubygems: [gemApi, gemVersionsLatest],
  maven: [mavenMetadata, mavenSearch],
  go: [goLatest, goList],
  nuget: [nugetFlat, nugetRegistration],
  packagist: [packagistRepo, packagistApi],
  hex: [hexApi],
  pub: [pubApi],
  cran: [cranDescription],
};
