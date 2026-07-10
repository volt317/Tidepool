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

// ----------------------------------------------------------------- lookup

export const SURFACES: Record<CodeEcosystem, Surface[]> = {
  "crates-io": [cratesApi, cratesIndex],
  pypi: [pypiApi, pypiSimple],
  npm: [npmPackument, npmManifest],
};
