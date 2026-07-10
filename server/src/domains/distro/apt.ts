// server/src/domains/distro/apt.ts
//
// Index collector for the apt family (Ubuntu, Debian, derivatives).
//
// Each configured *pocket* (release / updates / security) is an independent
// information source: fetched, verified, and parsed on its own, with its own
// status. Per-package version drift across pockets is the aggregation's core
// signal.
//
// Verification is now a two-link chain, each fail-closed per pocket:
//   1. signature  — when `verifySignatures` is set, the clearsigned InRelease
//      must carry a good signature from the configured archive keyring(s)
//      (gpgv), or the pocket contributes nothing;
//   2. digest     — when `verifyDigests` is set, the fetched Packages.gz must
//      match the SHA256 table inside that (now signature-verified) InRelease.
// A pocket that passes both is labeled "signature+digest"; digest-only passes
// are labeled "digest" so the UI never overstates what was proven.

import type { AptIndexConfig, DistroConfig, PackageRow, SourceRecord, Verification } from "../../../../shared/types.js";
import { fetchBytes, gunzip, inReleaseSha256Table, parseDeb822, sha256hex } from "../../lib/util.js";
import { verifyClearsigned } from "../../lib/gpg.js";

interface Stanza extends Omit<PackageRow, "versions"> {
  version: string;
  sha256: string | null;
  pocket: string;
}

interface PocketResult {
  source: SourceRecord;
  stanzas: Stanza[];
}

async function syncPocket(
  pocket: AptIndexConfig["pockets"][number],
  components: string[],
  arch: string,
  verifyDigests: boolean,
  verifySignatures: boolean,
  keyrings: string[]
): Promise<PocketResult> {
  const source: SourceRecord = {
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
  const stanzas: Stanza[] = [];
  try {
    const inReleaseUrl = `${pocket.base}/dists/${pocket.suite}/InRelease`;
    source.urls.push(inReleaseUrl);
    const inRelease = await fetchBytes(inReleaseUrl);

    let verification: Verification = null;
    if (verifySignatures) {
      const verdict = verifyClearsigned(inRelease, keyrings);
      if (!verdict.ok) {
        throw new Error(`InRelease signature verification failed: ${verdict.reason}. Failing closed.`);
      }
      source.signedBy = verdict.signedBy;
      verification = "signature+digest"; // digest check below is also mandatory on this path
    }

    const table = inReleaseSha256Table(inRelease.toString("utf8"));

    for (const component of components) {
      const rel = `${component}/binary-${arch}/Packages.gz`;
      const pkgUrl = `${pocket.base}/dists/${pocket.suite}/${rel}`;
      source.urls.push(pkgUrl);
      const gz = await fetchBytes(pkgUrl);

      if (verifyDigests || verifySignatures) {
        const expected = table[rel];
        if (!expected) throw new Error(`InRelease has no SHA256 entry for ${rel}`);
        const got = sha256hex(gz);
        if (got !== expected) {
          throw new Error(
            `digest mismatch for ${rel}: InRelease says ${expected.slice(0, 12)}…, fetched ${got.slice(0, 12)}…. Failing closed.`
          );
        }
        if (verification === null) verification = "digest";
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
          description: (st.Description || "").split("\n")[0] || null,
          sha256: st.SHA256 || null,
          pocket: pocket.id,
        });
      }
    }
    source.verified = verification;
    source.status = "ok";
    source.fetchedAt = Date.now();
    source.packageCount = stanzas.length;
  } catch (e) {
    source.status = "error";
    source.error = String(e instanceof Error ? e.message : e);
  }
  return { source, stanzas };
}

import type { IndexResult } from "../../core/aggregator.js";

/**
 * Sync all pockets of an apt distro and merge into the comprehensive list.
 * Merge policy: union of names across pockets; each pocket's version kept
 * separately under `versions[pocketId]` — never blended.
 */
export async function syncAptIndex(distroCfg: DistroConfig): Promise<IndexResult> {
  const idx = distroCfg.index as AptIndexConfig;
  const results = await Promise.all(
    idx.pockets.map((p) =>
      syncPocket(p, idx.components, idx.arch, !!idx.verifyDigests, !!idx.verifySignatures, idx.keyrings ?? [])
    )
  );

  const byName = new Map<string, PackageRow>();
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
      row.homepage = row.homepage || st.homepage;
      row.description = row.description || st.description;
    }
  }

  const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { sources: results.map((r) => r.source), packages };
}
