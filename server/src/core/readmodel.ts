// server/src/core/readmodel.ts
//
// The API's view of published truth (deployment-evolution addition).
//
// Everything the read surface serves is reconstructed from exactly three
// inputs — the atomically published SQLite replica, finalized snapshot
// files, and the publication metadata document — never from the collector's
// private TTL cache and never from the authoritative writer database. The
// collector's cache can be deleted without changing anything the API says.
//
// Two pieces:
//   ReplicaHandle  opens published/tidepool-read.sqlite3 with real SQLite
//                  read-only mode and transparently reopens when a new
//                  publication lands (detected via publication.json, which
//                  the collector rename-swaps after the replica itself).
//   replicaStateFor  rebuilds the UnitState shape the read handlers already
//                  consume, from store.unitStateAt() — so routes.read.ts
//                  handlers keep working verbatim via Aggregator's
//                  stateSource hook.
//
// Known, deliberate fidelity notes (documented, not hidden): package
// descriptions are not part of normalized index records, so replica-served
// listings have no description text; advisory detail is reconstructed from
// each advisory record's diff fingerprint (title, severity, fixedIn, CVEs)
// and carries no click-through URL. Evidence (enrichment) is served in full
// from stored observations.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { JoinedAdvisory, PackageRow, SourceRecord } from "../../../shared/types.js";
import type { UnitProvider, UnitState } from "./aggregator.js";
import { SqliteObservationStore } from "./store.js";

export class ReplicaHandle {
  private store_: SqliteObservationStore | null = null;
  private openedMtimeMs = 0;
  readonly publishedDir: string;
  /** dataDir supplies the read-only sibling trees (objects/, snapshots/) */
  readonly dataDir: string;

  constructor(publishedDir: string, dataDir: string) {
    this.publishedDir = publishedDir;
    this.dataDir = dataDir;
  }

  private metaPath(): string {
    return join(this.publishedDir, "publication.json");
  }
  replicaPath(): string {
    return join(this.publishedDir, "tidepool-read.sqlite3");
  }

  available(): boolean {
    return existsSync(this.replicaPath());
  }

  /** Current store handle, reopened when a newer publication is observed.
   *  The old file handle stays valid across the collector's rename (POSIX),
   *  so readers mid-request are never torn. */
  store(): SqliteObservationStore {
    const meta = this.metaPath();
    const mtime = existsSync(meta) ? statSync(meta).mtimeMs : existsSync(this.replicaPath()) ? statSync(this.replicaPath()).mtimeMs : 0;
    if (!this.store_ || mtime > this.openedMtimeMs) {
      const next = new SqliteObservationStore(this.dataDir, undefined, { replicaFile: this.replicaPath() });
      this.store_?.close();
      this.store_ = next;
      this.openedMtimeMs = mtime;
    }
    return this.store_;
  }

  close(): void {
    this.store_?.close();
    this.store_ = null;
  }
}

/** Advisory diff fingerprints are JSON.stringify([title, severity, fixedIn,
 *  cves.join(",")]) — see Aggregator.sourceRecords. Recover the fields. */
function advisoryFromFingerprint(id: string, fingerprint: string): JoinedAdvisory {
  try {
    const [title, severity, fixedIn, cves] = JSON.parse(fingerprint) as string[];
    return {
      id,
      title: title || null,
      severity: severity || null,
      fixedIn: fixedIn || null,
      cves: cves ? cves.split(",") : [],
      url: "",
    };
  } catch {
    return { id, url: "" };
  }
}

/** Rebuild the UnitState the read handlers consume, from published truth. */
export function replicaStateFor(handle: ReplicaHandle, p: UnitProvider): UnitState | null {
  if (!handle.available()) return null;
  const store = handle.store();
  const unit = store.unitStateAt(p.domain, p.id, Date.now());
  if (unit.sources.length === 0) return null; // never observed

  // per-source version keys use the source-type suffix — same convention as
  // the aggregator's merge (pocket:security → "security")
  const packagesByName = new Map<string, PackageRow>();
  const advisoriesByPackage: Record<string, JoinedAdvisory[]> = {};
  const sources: SourceRecord[] = [];
  let newestCollected: number | null = null;

  for (const src of unit.sources) {
    const suffix = src.sourceType.includes(":") ? src.sourceType.slice(src.sourceType.indexOf(":") + 1) : src.sourceType;
    const cov = src.coverage;
    if (cov.collectedAt && (!newestCollected || cov.collectedAt > newestCollected)) newestCollected = cov.collectedAt;
    sources.push({
      id: src.sourceType,
      kind: "published-replica",
      label: `${cov.authority || p.label} — ${src.sourceType}`,
      urls: [],
      status: cov.status === "ok" ? "ok" : "error",
      verified: cov.verification ?? undefined,
      signedBy: cov.signedBy,
      error: cov.error ?? undefined,
      fetchedAt: cov.collectedAt ?? null,
      packageCount: cov.recordCount,
      note: cov.limitations.length ? cov.limitations.join("; ") : undefined,
    });
    if (src.recordKind === "index") {
      for (const r of src.records as { name: string; version: string; meta?: string }[]) {
        const row =
          packagesByName.get(r.name) ??
          ({
            name: r.name,
            source: r.name,
            component: "",
            section: null,
            arch: "",
            homepage: null,
            description: null, // not part of normalized records — documented fidelity gap
            versions: {},
          } satisfies PackageRow);
        row.versions[suffix] = r.version;
        if (r.meta && (!row.component || !row.section)) {
          const [component = null, section = null] = r.meta.split("|");
          row.component = row.component || (component ?? "");
          row.section = row.section ?? (section || null);
        }
        packagesByName.set(r.name, row);
      }
    } else if (src.recordKind === "advisory") {
      for (const r of src.records as { package: string; id: string; fingerprint: string }[]) {
        (advisoriesByPackage[r.package] ??= []).push(advisoryFromFingerprint(r.id, r.fingerprint));
      }
    }
    // evidence sources: coverage above; the evidence itself is served by the
    // dedicated stored-evidence route, not folded into package rows
  }

  return {
    status: "ready",
    startedAt: null,
    finishedAt: newestCollected,
    sources,
    packages: [...packagesByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    advisoriesByPackage,
    error: null,
  };
}
