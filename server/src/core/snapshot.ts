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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { digestOf, runHeuristics, stableStringify, type InflowStore } from "./inflow.js";
import type { Aggregator, UnitProvider } from "./aggregator.js";

export const GENERATOR_VERSION = "1";

export interface SnapshotInputs {
  providers: UnitProvider[];
  inflow: InflowStore;
  aggregator: Aggregator;
  stage: SnapshotStage;
  windowHours: number;
  /** explicit window overrides windowHours — required for exact reproduction */
  window?: { from: number; to: number };
}

export async function buildSnapshot(inp: SnapshotInputs): Promise<SnapshotDoc> {
  const now = Date.now();
  const window = inp.window ?? { from: now - inp.windowHours * 3600 * 1000, to: now };
  const inWindow = (t: number) => t >= window.from && t <= window.to;

  const coverage: SnapshotSourceCoverage[] = [];
  const observations: Observation[] = [];
  const changes: ChangeRecord[] = [];
  const entities: SnapshotEntity[] = [];
  const notObserved: string[] = [];
  const ambiguities: string[] = [];

  for (const p of inp.providers) {
    const allObs = inp.inflow.observations(p.domain, p.id);
    const windowObs = allObs.filter((o) => inWindow(o.collectedAt));
    observations.push(...windowObs);

    // coverage: latest observation per source (inside or before the window)
    const bySource = new Map<string, Observation>();
    for (const o of allObs) if (o.collectedAt <= window.to) bySource.set(o.sourceId, o);
    if (bySource.size === 0) {
      notObserved.push(`${p.domain}/${p.id}: no observations exist — unit never synced`);
    }
    for (const [sourceId, o] of bySource) {
      coverage.push({
        domain: p.domain,
        unit: p.id,
        authority: p.label,
        sourceId,
        status: o.status,
        verification: o.verification,
        signedBy: o.signedBy,
        recordCount: o.recordCount,
        collectedAt: o.collectedAt,
        error: o.error ?? null,
        limitations: o.coverage.limitations,
      });
      if (o.status === "error") {
        notObserved.push(`${p.domain}/${p.id}/${sourceId}: latest collection failed (${o.error ?? "unknown"})`);
      }
      for (const lim of o.coverage.limitations) {
        notObserved.push(`${p.domain}/${p.id}/${sourceId}: ${lim}`);
      }
    }

    if (inp.stage !== "observation") {
      changes.push(...inp.inflow.changes(p.domain, p.id).filter((c) => inWindow(c.detectedAt)));
    }

    // entities: current merged state, served from the aggregator's store-backed state
    const st = await inp.aggregator.peek(p);
    if (st) {
      const page = inp.aggregator.packages(p, st, { per: 500000, page: 1 });
      for (const s of page.items) {
        entities.push({
          domain: p.domain,
          unit: p.id,
          name: s.name,
          source: s.source,
          versions: s.versions,
          current: s.current,
          drift: s.drift,
          advisoryCount: s.advisoryCount,
        });
      }
    }
  }

  // relationships (churn+): a version movement and an advisory event on the
  // same package inside the window are related — the security-response join.
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
    // binary↔source name join ambiguity is structural for apt advisories
    if (coverage.some((c) => c.sourceId === "advisories:ubuntu-notices" && c.status === "ok")) {
      ambiguities.push(
        "apt advisory joins match on both binary and source package names; a notice naming only a source package attaches to the source name"
      );
    }
  }

  const findings =
    inp.stage === "interpretive" ? runHeuristics({ window, observations, changes }) : [];
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
  // the digest binds content (window, coverage, entities, observations,
  // changes, findings) — not the generation wall-clock, so rebuilding the
  // same explicit window from the same store yields the same digest.
  doc.digest = digestOf({ ...doc, createdAt: 0 });
  return doc;
}

// ----------------------------------------------------------------- storage

export class SnapshotStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }
  save(doc: SnapshotDoc): string {
    const digest = doc.digest ?? digestOf(doc);
    const path = join(this.root, `${digest}.json`);
    if (!existsSync(path)) {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, stableStringify(doc));
      renameSync(tmp, path);
    }
    return digest;
  }
  load(digest: string): SnapshotDoc | null {
    const path = join(this.root, `${digest}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as SnapshotDoc;
  }
  list(): { digest: string; stage: SnapshotStage; createdAt: number; units: number; changes: number }[] {
    return readdirSync(this.root)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const d = JSON.parse(readFileSync(join(this.root, f), "utf8")) as SnapshotDoc;
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

/** Minimal ustar writer for the archive bundle (we already read ustar). */
function tarWrite(entries: { name: string; data: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const header = Buffer.alloc(512);
    header.write(e.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "utf8"); // mode
    header.write("0000000\0", 108, 8, "utf8"); // uid
    header.write("0000000\0", 116, 8, "utf8"); // gid
    header.write(e.data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "utf8");
    header.write("        ", 148, 8, "utf8"); // checksum placeholder = spaces
    header[156] = 0x30; // '0' regular file
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
    blocks.push(header, e.data);
    const pad = 512 - (e.data.length % 512 || 512);
    if (pad > 0 && pad < 512) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
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
