// server/src/domains/providers.ts
//
// The two domains, expressed as `UnitProvider`s over the contained core.
// This file is the entire mapping from configuration to aggregation — a new
// distro or ecosystem is a config entry; a new *family* of either is one
// provider branch here.

import type { CodeUnitConfig, DistroConfig, PackageRow, SourceRecord, TidepoolConfig } from "../../../shared/types.js";
import type { AdvisoryJoin, IndexResult, UnitProvider } from "../core/aggregator.js";
import { mapLimit } from "../core/aggregator.js";
import { osvBatchJoin } from "../core/enrich.js";
import { syncAptIndex } from "./distro/apt.js";
import { fetchAlpineSecdb, fetchArchAvg, syncApkIndex, syncArchIndex } from "./distro/apk_arch.js";
import { fetchUbuntuNotices } from "./distro/advisories.js";
import { SURFACES } from "./code/surfaces.js";

// ------------------------------------------------------------------ distro

function distroSourceOrder(d: DistroConfig): string[] {
  if (d.family === "apt") return (d.index as { pockets: { id: string }[] }).pockets.map((p) => p.id);
  if (d.family === "apk") return (d.index as { repos: string[] }).repos;
  return (d.index as { repos: string[] }).repos.map((r) => r.toLowerCase());
}

function distroProvider(d: DistroConfig): UnitProvider {
  return {
    domain: "distro",
    id: d.id,
    label: d.label,
    kind: d.family,
    osvEcosystem: d.osvEcosystem ?? null,
    sourceOrder: distroSourceOrder(d),
    syncIndex(): Promise<IndexResult> {
      if (d.family === "apt") return syncAptIndex(d);
      if (d.family === "apk") return syncApkIndex(d);
      return syncArchIndex(d);
    },
    syncAdvisories(): Promise<AdvisoryJoin> {
      const kind = d.advisories?.kind;
      if (kind === "ubuntu-notices" && d.advisories) return fetchUbuntuNotices(d.advisories);
      if (kind === "alpine-secdb" && d.advisories) return fetchAlpineSecdb(d.advisories);
      if (kind === "arch-avg" && d.advisories) return fetchArchAvg(d.advisories);
      return Promise.resolve({
        source: {
          id: "advisories:on-demand",
          kind: kind ?? "none",
          label: kind === "osv-on-demand" ? `OSV on demand (${d.osvEcosystem})` : "no bulk advisory feed",
          urls: [],
          status: "ok",
          note:
            kind === "osv-on-demand"
              ? "No bulk feed configured; advisories are fetched per package from OSV when opened."
              : "No advisory feed configured for this distro.",
          advisoryCount: 0,
        },
        byPackage: {},
      });
    },
  };
}

// -------------------------------------------------------------------- code

function codeProvider(c: CodeUnitConfig): UnitProvider {
  const surfaces = SURFACES[c.ecosystem];
  return {
    domain: "code",
    id: c.id,
    label: c.label,
    kind: c.ecosystem,
    osvEcosystem: c.osvEcosystem ?? null,
    sourceOrder: surfaces.map((s) => s.id),
    async syncIndex(): Promise<IndexResult> {
      const names = [...new Set(c.scope.packages)].sort((a, b) => a.localeCompare(b));

      // per-surface source records: each surface is one source, resolved
      // package-by-package with bounded concurrency
      const sources: SourceRecord[] = [];
      const byName = new Map<string, PackageRow>();
      for (const name of names) {
        byName.set(name, {
          name,
          source: name,
          section: null,
          component: c.ecosystem,
          arch: "-",
          homepage: null,
          description: null,
          versions: {},
        });
      }

      for (const surface of surfaces) {
        const source: SourceRecord = {
          id: `surface:${surface.id}`,
          kind: "registry-surface",
          label: surface.label,
          urls: [surface.urlTemplate],
          status: "syncing",
          verified: null, // registries are TLS-only; nothing detached to verify
          error: null,
          fetchedAt: null,
          packageCount: 0,
        };
        const errors: string[] = [];
        await mapLimit(names, 6, async (name) => {
          try {
            const hit = await surface.fetch(name);
            const row = byName.get(name);
            if (!row) return;
            if (hit.version) {
              row.versions[surface.id] = hit.version;
              source.packageCount = (source.packageCount ?? 0) + 1;
            }
            row.description = row.description ?? hit.description ?? null;
            row.homepage = row.homepage ?? hit.homepage ?? null;
          } catch (e) {
            errors.push(`${name}: ${String(e instanceof Error ? e.message : e)}`);
          }
        });
        if ((source.packageCount ?? 0) > 0) {
          source.status = "ok";
          source.fetchedAt = Date.now();
          if (errors.length) source.note = `${errors.length}/${names.length} failed (first: ${errors[0]})`;
        } else {
          source.status = "error";
          source.error = errors[0] ?? "no package resolved on this surface";
        }
        sources.push(source);
      }

      return { sources, packages: [...byName.values()] };
    },
    async syncAdvisories(): Promise<AdvisoryJoin> {
      if (!c.osvEcosystem) {
        return {
          source: {
            id: "advisories:none",
            kind: "none",
            label: "no advisory ecosystem configured",
            urls: [],
            status: "ok",
            note: "Set osvEcosystem on this unit to join OSV advisories.",
            advisoryCount: 0,
          },
          byPackage: {},
        };
      }
      const { source, byPackage } = await osvBatchJoin([...new Set(c.scope.packages)], c.osvEcosystem);
      return { source, byPackage };
    },
  };
}

// ------------------------------------------------------------------ export

export function buildProviders(config: TidepoolConfig): UnitProvider[] {
  const distros = (config.distros ?? []).filter((d) => d.enabled !== false).map(distroProvider);
  const ecosystems = (config.ecosystems ?? []).filter((c) => c.enabled !== false).map(codeProvider);
  return [...distros, ...ecosystems];
}
