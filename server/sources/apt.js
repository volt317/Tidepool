// server/sources/apt.js
//
// Index collector for the apt family (Ubuntu, Debian, derivatives).
//
// Each configured *pocket* (release / updates / security) is treated as an
// independent information source: fetched, verified, and parsed on its own,
// with its own status. Per-package version drift across pockets is the
// aggregation's core signal — e.g. "release ships 3.0.13-0ubuntu3,
// security ships 3.0.13-0ubuntu3.11" tells you the patch history at a glance.
//
// Verification: when `verifyDigests` is set, the fetched Packages.gz digest
// must match the SHA256 table inside the pocket's (GPG-signed) InRelease
// document, or that pocket fails closed and reports the mismatch instead of
// contributing unverifiable data. (Full signature verification of InRelease
// against the archive keyring is a documented gap — see README.)

import {
  fetchBytes,
  gunzip,
  sha256hex,
  parseDeb822,
  inReleaseSha256Table,
} from "../lib/util.js";

/**
 * Sync one apt pocket for one component/arch.
 * Returns { source: {…status/provenance}, stanzas: [...] }.
 */
async function syncPocket(pocket, components, arch, verifyDigests) {
  const source = {
    id: `pocket:${pocket.id}`,
    kind: "apt-pocket",
    label: `${pocket.suite} (${components.join(",")}/${arch})`,
    urls: [],
    status: "syncing",
    verified: null,
    error: null,
    fetchedAt: null,
    packageCount: 0,
  };
  const stanzas = [];
  try {
    const inReleaseUrl = `${pocket.base}/dists/${pocket.suite}/InRelease`;
    source.urls.push(inReleaseUrl);
    const inRelease = await fetchBytes(inReleaseUrl);
    const table = inReleaseSha256Table(inRelease.toString("utf8"));

    for (const component of components) {
      const rel = `${component}/binary-${arch}/Packages.gz`;
      const pkgUrl = `${pocket.base}/dists/${pocket.suite}/${rel}`;
      source.urls.push(pkgUrl);
      const gz = await fetchBytes(pkgUrl);

      if (verifyDigests) {
        const expected = table[rel];
        if (!expected) throw new Error(`InRelease has no SHA256 entry for ${rel}`);
        const got = sha256hex(gz);
        if (got !== expected) {
          throw new Error(
            `digest mismatch for ${rel}: InRelease says ${expected.slice(0, 12)}…, fetched ${got.slice(0, 12)}…. Failing closed.`
          );
        }
        source.verified = true;
      }

      const text = gunzip(gz).toString("utf8");
      for (const st of parseDeb822(text)) {
        if (!st.Package || !st.Version) continue;
        stanzas.push({
          name: st.Package,
          version: st.Version,
          source: st.Source ? st.Source.split(/\s/)[0] : st.Package,
          component,
          section: st.Section || null,
          arch: st.Architecture || arch,
          homepage: st.Homepage || null,
          description: (st.Description || "").split("\n")[0],
          sha256: st.SHA256 || null,
          pocket: pocket.id,
        });
      }
    }
    source.status = "ok";
    source.fetchedAt = Date.now();
    source.packageCount = stanzas.length;
  } catch (e) {
    source.status = "error";
    source.error = String(e.message || e);
  }
  return { source, stanzas };
}

/**
 * Sync all pockets of an apt distro and merge into the comprehensive list.
 *
 * Result shape:
 *   sources: per-pocket status/provenance records
 *   packages: [{ name, source, section, description, homepage,
 *                versions: {release?, updates?, security?}, arch }]
 * Merge policy: union of all package names across pockets; each pocket's
 * version is kept separately (never blended) under `versions[pocketId]`.
 */
export async function syncAptIndex(distroCfg) {
  const { pockets, components, arch, verifyDigests } = distroCfg.index;
  const results = await Promise.all(
    pockets.map((p) => syncPocket(p, components, arch, !!verifyDigests))
  );

  const byName = new Map();
  for (const { source, stanzas } of results) {
    if (source.status !== "ok") continue;
    for (const st of stanzas) {
      let row = byName.get(st.name);
      if (!row) {
        row = {
          name: st.name,
          source: st.source,
          section: st.section,
          component: st.component,
          arch: st.arch,
          homepage: st.homepage,
          description: st.description,
          versions: {},
        };
        byName.set(st.name, row);
      }
      row.versions[st.pocket] = st.version;
      // prefer richer fields from later pockets if earlier were sparse
      row.homepage = row.homepage || st.homepage;
      row.description = row.description || st.description;
    }
  }

  const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { sources: results.map((r) => r.source), packages };
}
