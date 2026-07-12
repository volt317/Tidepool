// server/src/cli/dispatch.ts
//
// The dispatch analyzer CLI: evaluate one or more project paths against a
// stored Tidepool truth snapshot, without repeating any upstream collection.
//
//   node server/dist/server/src/cli/dispatch.js \
//     --snapshot <digest|latest> [--store .cache] [--out artifact.json] <path>...
//
// Exit codes: 0 = analyzed; 3 = analyzed with security-review findings;
// 2 = usage/store error.

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { SnapshotDoc } from "../../../shared/types.js";
import { parseJsonCorpus, readCorpusText, writeCorpusAtomic } from "../lib/corpus.js";
import { validateSnapshotDoc } from "../lib/validate.js";
import { analyzeAgainstSnapshot, classifyPath } from "../dispatch/analyze.js";

function loadSnapshotCorpus(path: string, name: string): SnapshotDoc {
  const v = validateSnapshotDoc(parseJsonCorpus(readCorpusText(path), name), name);
  if (!v.doc) {
    console.error(`dispatch: ${name} failed validation:`);
    for (const e of v.errors.slice(0, 8)) console.error(`  - ${e}`);
    process.exit(2);
  }
  return v.doc;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function main(): number {
  const storeDir = resolve(arg("--store") ?? join(process.env.TIDEPOOL_ROOT ?? process.cwd(), ".tidepool"));
  const snapDir = join(storeDir, "snapshots");
  const wanted = arg("--snapshot") ?? "latest";
  const out = arg("--out");
  const flagValues = new Set([arg("--snapshot"), arg("--store"), arg("--out")].filter(Boolean));
  const paths = process.argv.slice(2).filter((a) => !a.startsWith("--") && !flagValues.has(a));

  if (paths.length === 0) {
    console.error("usage: dispatch --snapshot <digest|latest> [--store DIR] [--out FILE] <path>...");
    return 2;
  }

  let digest = wanted;
  if (wanted === "latest") {
    const all = readdirSync(snapDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, doc: loadSnapshotCorpus(join(snapDir, f), f) }))
      .sort((a, b) => b.doc.createdAt - a.doc.createdAt);
    if (all.length === 0) {
      console.error("dispatch: no snapshots in store — POST /api/snapshots first");
      return 2;
    }
    digest = all[0].f.replace(/\.json$/, "");
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    console.error(`dispatch: snapshot digest must be 64 hex chars (got: ${digest.slice(0, 40)})`);
    return 2;
  }
  const doc = loadSnapshotCorpus(join(snapDir, `${digest}.json`), `snapshot ${digest.slice(0, 12)}`);

  const profiles = paths.map((p) => classifyPath(p));
  const artifact = analyzeAgainstSnapshot(profiles, doc);

  const summaryByKind = new Map<string, number>();
  for (const f of artifact.findings) summaryByKind.set(f.kind, (summaryByKind.get(f.kind) ?? 0) + 1);
  console.error(`dispatch: snapshot ${digest.slice(0, 16)} (${doc.stage}) vs ${paths.length} path(s)`);
  for (const p of artifact.targets)
    console.error(`  ${p.path}: ${p.classes.join("+")} · ${p.dependencies.length} deps · fp ${p.fingerprint.slice(0, 12)}`);
  for (const [k, n] of [...summaryByKind].sort()) console.error(`  ${k}: ${n}`);
  if (artifact.sharedExposure.length) console.error(`  shared exposure: ${artifact.sharedExposure.length} dependency group(s)`);
  console.error(`  artifact digest: ${artifact.digest}`);

  const body = JSON.stringify(artifact, null, 2);
  if (out) {
    writeCorpusAtomic(out, body);
    console.error(`  written: ${out}`);
  } else {
    console.log(body);
  }
  return artifact.findings.some((f) => f.kind === "security-review-required") ? 3 : 0;
}

process.exit(main());
