// server/src/core/snapshot.ts
//
// The snapshot pipeline. A snapshot is a bounded, provenance-backed truth
// set: what the configured authorities reported in a window, what changed,
// and (interpretive stage) what appears to be happening — with the truth
// boundary stated inside the document itself (notObserved, failed sources,
// partial coverage, ambiguities).
//
// Stages are cumulative: observation ⊂ churn ⊂ interpretive. All three are
// built from the same store-only inputs (no network), content-addressed over
// canonical JSON, and every export format renders from the same SnapshotDoc.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { parseJsonCorpus, readCorpusText, writeCorpusAtomic } from "../lib/corpus.js";
import { validateSnapshotDoc } from "../lib/validate.js";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

import type {
  ChangeRecord,
  DomainId,
  Observation,
  SnapshotDoc,
  SnapshotEntity,
  SnapshotSourceCoverage,
  SnapshotStage,
} from "../../../shared/types.js";
import { digestOf, runHeuristics, stableStringify, type AdvisoryRecordLite, type IndexRecordLite } from "./inflow.js";
import { debCompare, tarWrite } from "../lib/util.js";
import type { ObservationStore } from "./store.js";
import type { UnitProvider } from "./aggregator.js";

export const GENERATOR_VERSION = "1";

export interface SnapshotInputs {
  providers: UnitProvider[];
  store: ObservationStore;
  stage: SnapshotStage;
  windowHours: number;
  /** explicit window overrides windowHours — required for exact reproduction */
  window?: { from: number; to: number };
}

/**
 * Build a snapshot by HISTORICAL RECONSTRUCTION from the observation store:
 * for every configured source, the latest observation at or before window.to
 * defines its state; later observations are invisible. The aggregator's
 * in-memory state is never consulted, so rebuilding an old window after
 * newer synchronization yields the identical document and digest.
 */
export async function buildSnapshot(inp: SnapshotInputs): Promise<SnapshotDoc> {
  const now = Date.now();
  const window = inp.window ?? { from: now - inp.windowHours * 3600 * 1000, to: now };

  const coverage: SnapshotSourceCoverage[] = [];
  const observations: Observation[] = [];
  const changes: ChangeRecord[] = [];
  const entities: SnapshotEntity[] = [];
  const notObserved: string[] = [];
  const ambiguities: string[] = [];

  for (const p of inp.providers) {
    const recon = inp.store.buildSnapshotInputs(p.domain, p.id, window);
    if (recon.length === 0) {
      notObserved.push(`${p.domain}/${p.id}: no observations exist — unit never synced`);
      continue;
    }
    observations.push(...inp.store.observationsFor(p.domain, p.id, window));
    if (inp.stage !== "observation") {
      changes.push(...inp.store.changesFor(p.domain, p.id, window));
    }

    // reconstruct the unit's merged state as it was known at window.to
    const versionsByName = new Map<string, Record<string, string>>();
    const advisoriesByName = new Map<string, number>();
    for (const src of recon) {
      coverage.push({ ...src.coverage, authority: src.coverage.authority || p.label });
      if (src.observation?.status === "error") {
        notObserved.push(`${p.domain}/${p.id}/${src.sourceType}: latest collection at the boundary failed (${src.observation.error ?? "unknown"})`);
      }
      if (src.coverage.status === "unobserved") {
        notObserved.push(`${p.domain}/${p.id}/${src.sourceType}: never observed at or before the window boundary`);
      }
      for (const lim of src.coverage.limitations) notObserved.push(`${p.domain}/${p.id}/${src.sourceType}: ${lim}`);

      const suffix = src.sourceType.includes(":") ? src.sourceType.slice(src.sourceType.indexOf(":") + 1) : src.sourceType;
      if (src.recordKind === "index") {
        for (const r of src.records as IndexRecordLite[]) {
          const v = versionsByName.get(r.name) ?? {};
          v[suffix] = r.version;
          versionsByName.set(r.name, v);
        }
      } else {
        for (const r of src.records as AdvisoryRecordLite[]) {
          advisoriesByName.set(r.package, (advisoriesByName.get(r.package) ?? 0) + 1);
        }
      }
    }
    for (const [name, versions] of [...versionsByName].sort((a, b) => a[0].localeCompare(b[0]))) {
      const vals = Object.values(versions);
      const current = vals.reduce((best, v) => (best === null || debCompare(v, best) > 0 ? v : best), null as string | null);
      const drift = new Set(vals).size > 1;
      entities.push({
        domain: p.domain,
        unit: p.id,
        name,
        source: name,
        versions,
        current,
        drift,
        advisoryCount: advisoriesByName.get(name) ?? 0,
      });
    }
  }

  // relationships (churn+): advisory activity and a version movement on the
  // same package inside the window — the security-response join
  const relationships: SnapshotDoc["relationships"] = [];
  if (inp.stage !== "observation") {
    const advisoryPkgs = new Map<string, ChangeRecord>();
    for (const c of changes) {
      if ((c.kind === "advisory-published" || c.kind === "advisory-modified") && c.package)
        advisoryPkgs.set(`${c.unit}\u0000${c.package}`, c);
    }
    for (const c of changes) {
      if (c.kind !== "version-moved" || !c.package) continue;
      const adv = advisoryPkgs.get(`${c.unit}\u0000${c.package}`);
      if (adv) {
        relationships.push({
          kind: "security-response",
          a: adv.id,
          b: c.id,
          rationale: `${c.package}: advisory activity and a version movement in the same window (${adv.to ?? adv.from} ↔ ${c.from} → ${c.to})`,
        });
      }
    }
    if (coverage.some((c) => c.sourceId === "advisories:ubuntu-notices" && c.status === "ok")) {
      ambiguities.push(
        "apt advisory joins match on both binary and source package names; a notice naming only a source package attaches to the source name"
      );
    }
  }

  const findings = inp.stage === "interpretive" ? runHeuristics({ window, observations, changes }) : [];
  for (const f of findings) ambiguities.push(...f.ambiguities.map((a) => `${f.ruleId}: ${a}`));

  const doc: SnapshotDoc = {
    schema: "tidepool-snapshot-v1",
    stage: inp.stage,
    generatorVersion: GENERATOR_VERSION,
    createdAt: now,
    scope: {
      domains: [...new Set(inp.providers.map((p) => p.domain))] as DomainId[],
      units: inp.providers.map((p) => `${p.domain}/${p.id}`),
    },
    window,
    authorities: inp.providers.map((p) => p.label),
    coverage,
    notObserved: [...new Set(notObserved)],
    entities,
    observations,
    changes,
    relationships,
    findings,
    ambiguities: [...new Set(ambiguities)],
  };
  // the digest binds content, not wall-clock: same window + same store ⇒ same digest
  doc.digest = digestOf({ ...doc, createdAt: 0 });
  return doc;
}

// ----------------------------------------------------------------- storage

/** Content addresses are lowercase hex sha256 — nothing else touches disk. */
const DIGEST_RE = /^([0-9a-f]{64})$/;

export class SnapshotStore {
  constructor(
    private root: string,
    private manifests?: ObservationStore
  ) {
    mkdirSync(root, { recursive: true });
  }
  save(doc: SnapshotDoc): string {
    const digest = doc.digest ?? digestOf(doc);
    const path = join(this.root, `${digest}.json`);
    if (!existsSync(path)) writeCorpusAtomic(path, stableStringify(doc)); // one whole-corpus write
    // snapshot manifests are immutable rows joining the exact observation,
    // change, and finding sets the document was built from
    this.manifests?.recordSnapshotManifest({
      digest,
      window: doc.window,
      createdAt: doc.createdAt,
      scope: doc.scope,
      notObserved: doc.notObserved,
      ambiguities: doc.ambiguities,
      observations: doc.observations,
      changes: doc.changes,
      findings: doc.findings,
      bundlePath: `snapshots/${digest}.json`,
    });
    return digest;
  }
  load(digest: string): SnapshotDoc | null {
    // content addresses are 64 hex chars; the value used to build the path is
    // the anchored match's capture, never the caller's string
    const m = DIGEST_RE.exec(digest);
    if (!m) return null;
    const path = join(this.root, `${m[1]}.json`);
    if (!existsSync(path)) return null;
    // one whole-corpus read → parse to an object → validate in code
    const parsed = parseJsonCorpus(readCorpusText(path), `snapshot ${m[1].slice(0, 12)}`);
    const v = validateSnapshotDoc(parsed, `snapshot ${m[1].slice(0, 12)}`);
    if (!v.doc) throw new Error(`stored snapshot failed validation: ${v.errors.slice(0, 3).join("; ")}`);
    return v.doc;
  }
  list(): { digest: string; stage: SnapshotStage; createdAt: number; units: number; changes: number }[] {
    return readdirSync(this.root)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const parsed = parseJsonCorpus(readCorpusText(join(this.root, f)), f);
        const v = validateSnapshotDoc(parsed, f);
        if (!v.doc) throw new Error(`stored snapshot ${f} failed validation: ${v.errors.slice(0, 3).join("; ")}`);
        const d = v.doc;
        return {
          digest: f.replace(/\.json$/, ""),
          stage: d.stage,
          createdAt: d.createdAt,
          units: d.scope.units.length,
          changes: d.changes.length,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

// ----------------------------------------------------------------- exports
// Every format renders from the same SnapshotDoc — no format has private data.

export type ExportFormat = "json" | "ndjson" | "md" | "html" | "sqlite" | "bundle";

export function exportSnapshot(doc: SnapshotDoc, format: ExportFormat): { body: Buffer; contentType: string; filename: string } {
  const digest = (doc.digest ?? "snapshot").slice(0, 16);
  switch (format) {
    case "json":
      return { body: Buffer.from(stableStringify(doc)), contentType: "application/json", filename: `tidepool-${digest}.json` };
    case "ndjson":
      return { body: Buffer.from(toNdjson(doc)), contentType: "application/x-ndjson", filename: `tidepool-${digest}.ndjson` };
    case "md":
      return { body: Buffer.from(toMarkdown(doc)), contentType: "text/markdown; charset=utf-8", filename: `tidepool-${digest}.md` };
    case "html":
      return { body: Buffer.from(toHtml(doc)), contentType: "text/html; charset=utf-8", filename: `tidepool-${digest}.html` };
    case "sqlite":
      return { body: toSqlite(doc), contentType: "application/vnd.sqlite3", filename: `tidepool-${digest}.sqlite` };
    case "bundle":
      return { body: toBundle(doc), contentType: "application/gzip", filename: `tidepool-${digest}.tar.gz` };
  }
}

function toNdjson(doc: SnapshotDoc): string {
  const rows: string[] = [];
  const push = (type: string, row: unknown) => rows.push(JSON.stringify({ type, ...(row as object) }));
  push("meta", {
    schema: doc.schema, stage: doc.stage, digest: doc.digest, createdAt: doc.createdAt,
    window: doc.window, scope: doc.scope, generatorVersion: doc.generatorVersion,
  });
  for (const c of doc.coverage) push("coverage", c);
  for (const n of doc.notObserved) push("not-observed", { note: n });
  for (const e of doc.entities) push("entity", e);
  for (const o of doc.observations) push("observation", o);
  for (const c of doc.changes) push("change", c);
  for (const r of doc.relationships) push("relationship", r);
  for (const f of doc.findings) push("finding", f);
  for (const a of doc.ambiguities) push("ambiguity", { note: a });
  return rows.join("\n") + "\n";
}

const ts = (t: number | null) => (t ? new Date(t).toISOString() : "—");

function toMarkdown(doc: SnapshotDoc): string {
  const L: string[] = [];
  L.push(`# Tidepool ${doc.stage} snapshot`);
  L.push("");
  L.push(`- digest: \`${doc.digest}\``);
  L.push(`- window: ${ts(doc.window.from)} → ${ts(doc.window.to)}`);
  L.push(`- scope: ${doc.scope.units.join(", ")}`);
  L.push(`- schema ${doc.schema} · generator v${doc.generatorVersion}`);
  L.push("");
  L.push(`## Truth boundary`);
  L.push("");
  L.push(`Observed: ${doc.observations.length} observation(s) across ${doc.coverage.length} source(s); ${doc.entities.length} entities; ${doc.changes.length} change(s).`);
  if (doc.notObserved.length) {
    L.push("");
    L.push("**Not observed / limitations:**");
    for (const n of doc.notObserved) L.push(`- ${n}`);
  }
  L.push("");
  L.push(`## Source coverage`);
  L.push("");
  L.push(`| unit | source | status | verification | records | collected |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const c of doc.coverage) {
    L.push(
      `| ${c.domain}/${c.unit} | ${c.sourceId} | ${c.status}${c.error ? ` (${c.error.slice(0, 60)})` : ""} | ${c.verification ?? "—"} | ${c.recordCount} | ${ts(c.collectedAt)} |`
    );
  }
  if (doc.changes.length) {
    L.push("");
    L.push(`## Changes (${doc.changes.length})`);
    L.push("");
    const byKind = new Map<string, number>();
    for (const c of doc.changes) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
    for (const [k, n] of [...byKind].sort()) L.push(`- ${k}: ${n}`);
    L.push("");
    for (const c of doc.changes.slice(0, 200)) {
      L.push(
        `- \`${c.kind}\` ${c.domain}/${c.unit}/${c.sourceId}${c.package ? ` **${c.package}**` : ""}${c.from || c.to ? ` ${c.from ?? "·"} → ${c.to ?? "·"}` : ""} _(obs ${c.toObservation.slice(0, 12)})_`
      );
    }
    if (doc.changes.length > 200) L.push(`- … ${doc.changes.length - 200} more (see machine exports)`);
  }
  if (doc.relationships.length) {
    L.push("");
    L.push(`## Relationships`);
    L.push("");
    for (const r of doc.relationships) L.push(`- **${r.kind}**: ${r.rationale}`);
  }
  if (doc.findings.length) {
    L.push("");
    L.push(`## Findings`);
    for (const f of doc.findings) {
      L.push("");
      L.push(`### ${f.title} \`${f.ruleId}\` (${f.severityHint}, confidence ${f.confidence})`);
      L.push("");
      L.push(f.summary);
      L.push("");
      L.push(`- basis: ${f.confidenceBasis}`);
      L.push(`- evidence: ${f.evidence.changes.length} change(s), ${f.evidence.observations.length} observation(s)`);
      for (const a of f.ambiguities) L.push(`- ambiguity: ${a}`);
    }
  }
  if (doc.ambiguities.length) {
    L.push("");
    L.push(`## Ambiguities`);
    L.push("");
    for (const a of doc.ambiguities) L.push(`- ${a}`);
  }
  L.push("");
  return L.join("\n");
}

function toHtml(doc: SnapshotDoc): string {
  // same model, minimal deterministic HTML rendering of the markdown structure
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const md = toMarkdown(doc);
  const body = md
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) return `<h1>${esc(line.slice(2))}</h1>`;
      if (line.startsWith("## ")) return `<h2>${esc(line.slice(3))}</h2>`;
      if (line.startsWith("### ")) return `<h3>${esc(line.slice(4))}</h3>`;
      if (line.startsWith("|")) return `<div class="row">${esc(line)}</div>`;
      if (line.startsWith("- ")) return `<li>${esc(line.slice(2))}</li>`;
      if (line.trim() === "") return "";
      return `<p>${esc(line)}</p>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tidepool snapshot ${esc(doc.digest ?? "")}</title>
<style>body{font-family:ui-monospace,monospace;background:#0B1E24;color:#E9F2EF;max-width:1000px;margin:2rem auto;padding:0 1rem;font-size:14px}h1,h2,h3{font-family:system-ui,sans-serif;color:#53D6C0}.row{white-space:pre;color:#9DB8B4}li{color:#9DB8B4}</style>
</head><body>${body}</body></html>`;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: (string | number | null)[]): unknown };
    close(): void;
  };
}

function toSqlite(doc: SnapshotDoc): Buffer {
  // node:sqlite is a built-in on this runtime (verified); loaded via
  // process.getBuiltinModule so environments without it fail with a clear
  // message instead of a resolution error at import time.
  const sqlite = process.getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
  if (!sqlite) throw new Error("sqlite export requires node:sqlite (Node >= 22.5)");
  const { DatabaseSync } = sqlite;
  const dir = mkdtempSync(join(tmpdir(), "tidepool-sqlite-"));
  const path = join(dir, "snapshot.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE coverage (domain TEXT, unit TEXT, source TEXT, status TEXT, verification TEXT, records INTEGER, collected_at INTEGER, error TEXT);
      CREATE TABLE entities (domain TEXT, unit TEXT, name TEXT, source TEXT, current TEXT, drift INTEGER, advisories INTEGER, versions TEXT);
      CREATE TABLE observations (id TEXT PRIMARY KEY, domain TEXT, unit TEXT, source TEXT, collected_at INTEGER, status TEXT, verification TEXT, records INTEGER, records_digest TEXT, parser_version TEXT, config_version TEXT);
      CREATE TABLE changes (id TEXT PRIMARY KEY, domain TEXT, unit TEXT, source TEXT, kind TEXT, package TEXT, "from" TEXT, "to" TEXT, from_obs TEXT, to_obs TEXT, detected_at INTEGER);
      CREATE TABLE findings (rule_id TEXT, title TEXT, severity TEXT, confidence REAL, summary TEXT, basis TEXT);
      CREATE TABLE ambiguities (note TEXT);
    `);
    const meta = db.prepare("INSERT INTO meta VALUES (?, ?)");
    meta.run("schema", doc.schema);
    meta.run("stage", doc.stage);
    meta.run("digest", doc.digest ?? "");
    meta.run("window_from", String(doc.window.from));
    meta.run("window_to", String(doc.window.to));
    meta.run("generator_version", doc.generatorVersion);
    const cov = db.prepare("INSERT INTO coverage VALUES (?,?,?,?,?,?,?,?)");
    for (const c of doc.coverage) cov.run(c.domain, c.unit, c.sourceId, c.status, c.verification ?? null, c.recordCount, c.collectedAt, c.error ?? null);
    const ent = db.prepare("INSERT INTO entities VALUES (?,?,?,?,?,?,?,?)");
    for (const e of doc.entities) ent.run(e.domain, e.unit, e.name, e.source, e.current, e.drift ? 1 : 0, e.advisoryCount, JSON.stringify(e.versions));
    const obs = db.prepare("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const o of doc.observations) obs.run(o.id, o.domain, o.unit, o.sourceId, o.collectedAt, o.status, o.verification ?? null, o.recordCount, o.recordsDigest, o.parserVersion, o.configVersion);
    const chg = db.prepare('INSERT INTO changes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const c of doc.changes) chg.run(c.id, c.domain, c.unit, c.sourceId, c.kind, c.package ?? null, c.from ?? null, c.to ?? null, c.fromObservation, c.toObservation, c.detectedAt);
    const fin = db.prepare("INSERT INTO findings VALUES (?,?,?,?,?,?)");
    for (const f of doc.findings) fin.run(f.ruleId, f.title, f.severityHint, f.confidence, f.summary, f.confidenceBasis);
    const amb = db.prepare("INSERT INTO ambiguities VALUES (?)");
    for (const a of doc.ambiguities) amb.run(a);
    db.close();
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


function toBundle(doc: SnapshotDoc): Buffer {
  const digest = (doc.digest ?? "snapshot").slice(0, 16);
  const entries = [
    { name: `tidepool-${digest}/snapshot.json`, data: Buffer.from(stableStringify(doc)) },
    { name: `tidepool-${digest}/snapshot.ndjson`, data: Buffer.from(toNdjson(doc)) },
    { name: `tidepool-${digest}/report.md`, data: Buffer.from(toMarkdown(doc)) },
    { name: `tidepool-${digest}/report.html`, data: Buffer.from(toHtml(doc)) },
  ];
  return gzipSync(tarWrite(entries));
}
