// server/src/cli/retention.ts
//
// SNAPSHOT-AWARE RETENTION: reference reachability, never age deletion.
//
// The corpus grows monotonically by design. When space eventually matters,
// the only defensible pruning is of object blobs that NOTHING refers to:
//
//   reachable = ∪ normalized-record digests referenced by ANY snapshot
//             ∪ normalized + raw-artifact digests referenced by ANY
//               observation that is the latest for its source ("heads" —
//               current state must always be reconstructable)
//             ∪ raw-artifact digests referenced by observations included
//               in ANY snapshot (a snapshot's truth boundary keeps its
//               evidence)
//
//   prunable  = stored object files whose digest is in no reachable set
//
// Durable rows (sources, observations, changes, findings, snapshot
// manifests, digests, verification metadata) are NEVER deleted — pruning
// removes policy-retained blob bytes only, and nulls the artifact row's
// storage_path so the corpus honestly records "we no longer hold these
// bytes" while keeping the provenance (digest, URL, size) forever.
//
// Posture (deliberate): retention is DISABLED by default, is never run by
// the scheduler, and `plan` (dry-run) is the default mode. `--apply`
// additionally requires maintenance.retention.enabled=true in the config,
// refuses to run without a verified backup from the last 24h, writes a
// pruning audit record before deleting anything, and re-verifies the
// corpus afterwards.
//
// Usage:
//   tsx server/src/cli/retention.ts plan
//   tsx server/src/cli/retention.ts apply   (requires config opt-in + fresh verified backup marker)

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SqliteObservationStore } from "../core/store.js";
import { loadConfig, makeLogger, resolveDirs } from "../services/bootstrap.js";

const log = makeLogger("retention");

interface Plan {
  createdAt: string;
  dataDir: string;
  reachable: number;
  storedObjects: number;
  prunable: { digest: string; path: string; bytes: number }[];
  prunableBytes: number;
  protectedBySnapshots: number;
  protectedByHeads: number;
}

function computePlan(store: SqliteObservationStore, dataDir: string): Plan {
  const { bySnapshots, byHeads } = store.retentionReachability();
  const heads = byHeads;
  const reachable = new Set([...bySnapshots, ...heads]);

  // layout: objects/<algorithm>/<2-char shard>/<full digest>[.ext]
  const objectsDir = join(dataDir, "objects");
  const prunable: Plan["prunable"] = [];
  let prunableBytes = 0;
  if (existsSync(objectsDir)) {
    for (const algo of readdirSync(objectsDir)) {
      const algoDir = join(objectsDir, algo);
      if (!statSync(algoDir).isDirectory()) continue;
      for (const shard of readdirSync(algoDir)) {
        const shardDir = join(algoDir, shard);
        if (!statSync(shardDir).isDirectory()) continue;
        for (const f of readdirSync(shardDir)) {
          const digest = f.replace(/\.(json|bin)(\.gz)?$/, "");
          if (reachable.has(digest)) continue;
          const p = join(shardDir, f);
          if (!statSync(p).isFile()) continue;
          const bytes = statSync(p).size;
          prunable.push({ digest, path: p, bytes });
          prunableBytes += bytes;
        }
      }
    }
  }
  return {
    createdAt: new Date().toISOString(),
    dataDir,
    reachable: reachable.size,
    storedObjects: prunable.length + reachable.size,
    prunable,
    prunableBytes,
    protectedBySnapshots: bySnapshots.size,
    protectedByHeads: heads.size,
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "plan";
  if (mode !== "plan" && mode !== "apply") {
    console.error("usage: retention [plan|apply]");
    process.exit(2);
  }
  const { config, errors } = loadConfig();
  if (!config) {
    console.error("tidepool.config.json failed validation:", errors);
    process.exit(1);
  }
  const { dataDir } = resolveDirs(config);
  const store = new SqliteObservationStore(dataDir);
  try {
    const plan = computePlan(store, dataDir);
    const summary = {
      mode,
      reachableObjects: plan.reachable,
      prunableObjects: plan.prunable.length,
      prunableBytes: plan.prunableBytes,
      protectedBySnapshots: plan.protectedBySnapshots,
      protectedByHeads: plan.protectedByHeads,
    };

    if (mode === "plan") {
      console.log(JSON.stringify({ ...summary, prunable: plan.prunable.slice(0, 50) }, null, 2));
      if (plan.prunable.length > 50) console.log(`… and ${plan.prunable.length - 50} more (full list written on apply)`);
      return;
    }

    // ---- apply guards ---------------------------------------------------
    if (!config.maintenance?.retention?.enabled) {
      console.error("refusing: maintenance.retention.enabled is not true in tidepool.config.json (retention is disabled by default)");
      process.exit(1);
    }
    const marker = join(dataDir, "exports", "last-verified-backup.json");
    let backupOk = false;
    if (existsSync(marker)) {
      try {
        const m = JSON.parse(readFileSync(marker, "utf8")) as { verifiedAt?: string };
        backupOk = !!m.verifiedAt && Date.now() - Date.parse(m.verifiedAt) < 24 * 3600_000;
      } catch {
        /* treated as missing */
      }
    }
    if (!backupOk) {
      console.error(`refusing: no verified backup marker newer than 24h at ${marker} — run deploy/scripts/backup.sh first`);
      process.exit(1);
    }

    // ---- audit record BEFORE deletion ------------------------------------
    const auditPath = join(dataDir, "exports", `retention-audit-${Date.now()}.json`);
    writeFileSync(auditPath, JSON.stringify({ ...plan, appliedAt: new Date().toISOString() }, null, 2));
    log.info("pruning audit record written", { auditPath, prunable: plan.prunable.length });

    let removed = 0;
    for (const item of plan.prunable) {
      rmSync(item.path, { force: true });
      store.markArtifactPruned(item.digest);
      log.info("pruned unreferenced object", { digest: item.digest.slice(0, 12), bytes: item.bytes });
      removed++;
    }

    const verify = store.verifyCorpus();
    console.log(JSON.stringify({ ...summary, removed, auditPath, corpusVerifiedAfter: verify.ok, checks: verify.checks }, null, 2));
    if (!verify.ok) process.exit(1);
  } finally {
    store.close();
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
