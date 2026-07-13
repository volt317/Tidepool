// server/src/cli/corpus.ts — portable evidence bundles from the command line.
//
//   corpus export --data .tidepool --out corpus.tar.zst [--snapshot <digest>]...
//   corpus import --data .tidepool --in corpus.tar.zst [--dry-run]
//
// Exit codes: 0 ok; 2 usage/store error; 4 import rejected (checksums/schema).

import { join, resolve } from "node:path";

import { SqliteObservationStore } from "../core/store.js";
import { exportCorpus, importCorpus, type ExportMode } from "../core/corpusio.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
function args(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]] : []));
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const dataDir = resolve(arg("--data") ?? join(process.env.TIDEPOOL_ROOT ?? process.cwd(), ".tidepool"));

  if (cmd === "status") {
    const store = new SqliteObservationStore(dataDir);
    try {
      const counts = store.counts();
      const range = store.observationRange();
      const pending = Number(store.database.prepare("SELECT COUNT(*) AS n FROM observations WHERE analysis_status = 'pending'").get()?.n ?? 0);
      const failedAnalysis = Number(store.database.prepare("SELECT COUNT(*) AS n FROM observations WHERE analysis_status = 'failed'").get()?.n ?? 0);
      const failedHeads = Number(store.database.prepare("SELECT COUNT(*) AS n FROM source_heads WHERE status != 'ok'").get()?.n ?? 0);
      const objBytes = store.objectDigests().reduce((n, d) => n + (store.getObjectBytes(d)?.length ?? 0), 0);
      const status = {
        databasePath: store.opened.path,
        schemaVersion: store.opened.migrations.at(-1)?.[0] ?? 0,
        migrations: store.opened.migrations.map(([v, d]) => `${v}:${d.slice(0, 12)}`),
        ...counts,
        objectBytes: objBytes,
        observationRange: range,
        failedSourceHeads: failedHeads,
        analysisPending: pending,
        analysisFailed: failedAnalysis,
      };
      if (process.argv.includes("--json")) console.log(JSON.stringify(status, null, 2));
      else for (const [k, v] of Object.entries(status)) console.error(`  ${k}: ${Array.isArray(v) ? v.join(", ") : JSON.stringify(v)}`);
      return 0;
    } finally {
      store.close();
    }
  }

  if (cmd === "verify") {
    const store = new SqliteObservationStore(dataDir);
    try {
      const v = store.verifyCorpus();
      if (process.argv.includes("--json")) console.log(JSON.stringify(v, null, 2));
      else for (const ch of v.checks) console.error(`  ${ch.ok ? "✓" : "✗"} ${ch.name}: ${ch.detail}`);
      return v.ok ? 0 : 1;
    } finally {
      store.close();
    }
  }

  if (cmd === "vacuum") {
    const store = new SqliteObservationStore(dataDir);
    try {
      store.vacuumIncremental();
      console.error("corpus: incremental vacuum complete");
      return 0;
    } finally {
      store.close();
    }
  }

  if (cmd === "export") {
    const snapshotIds = args("--snapshot");
    for (const s of snapshotIds) {
      if (!/^[0-9a-f]{64}$/.test(s)) {
        console.error(`corpus: snapshot ids must be 64 hex chars (got ${s.slice(0, 40)})`);
        return 2;
      }
    }
    const out = resolve(arg("--out") ?? join(dataDir, "exports", `tidepool-corpus-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.zst`));
    const modeArg = arg("--mode");
    if (modeArg && !["full", "thin", "database-only", "referenced-objects"].includes(modeArg)) {
      console.error(`corpus: unknown mode ${modeArg}`);
      return 2;
    }
    const store = new SqliteObservationStore(dataDir);
    try {
      const r = await exportCorpus(store, out, { snapshotIds, mode: (modeArg as ExportMode | null) ?? undefined });
      console.error(`corpus: ${r.manifest.mode} export → ${r.path}`);
      console.error(`  observations ${r.manifest.observationRange.from ?? "—"} … ${r.manifest.observationRange.to ?? "—"}`);
      console.error(`  objects ${r.manifest.objectDigests.length} · snapshots ${r.manifest.snapshotIds.length} · db ${r.manifest.databaseDigest.slice(0, 12)} · ${r.bytes} bytes`);
      for (const l of r.manifest.limitations) console.error(`  limitation: ${l}`);
      return 0;
    } finally {
      store.close();
    }
  }

  if (cmd === "import") {
    const input = arg("--in");
    if (!input) {
      console.error("usage: corpus import --in <bundle.tar.zst> [--data DIR] [--dry-run]");
      return 2;
    }
    const store = new SqliteObservationStore(dataDir);
    try {
      const r = importCorpus(store, resolve(input), { dryRun: process.argv.includes("--dry-run") });
      console.error(`corpus: import${r.dryRun ? " (dry run)" : ""} of ${r.manifest.mode} bundle from ${r.manifest.exportedAt}`);
      if (r.checksumFailures.length) {
        for (const f of r.checksumFailures) console.error(`  checksum: ${f}`);
        return 4;
      }
      if (!r.schemaCompatible) {
        for (const n of r.schemaNotes) console.error(`  schema: ${n}`);
        return 4;
      }
      for (const [t, n] of Object.entries(r.inserted)) if (n > 0) console.error(`  ${t}: +${n}`);
      for (const c2 of r.conflicts) console.error(`  conflict: ${c2.table}/${c2.key} — ${c2.note}`);
      console.error(`  objects written: ${r.objectsWritten} · snapshot docs: ${r.snapshotFilesWritten}`);
      return 0;
    } finally {
      store.close();
    }
  }

  console.error("usage: corpus <status|verify|vacuum|export|import> …");
  return 2;
}

process.exit(await main());
