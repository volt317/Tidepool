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

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { SnapshotDoc } from "../../../shared/types.js";
import { analyzeAgainstSnapshot, classifyPath } from "../dispatch/analyze.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function main(): number {
  const storeDir = resolve(arg("--store") ?? join(process.env.TIDEPOOL_ROOT ?? process.cwd(), ".cache"));
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
      .map((f) => ({ f, doc: JSON.parse(readFileSync(join(snapDir, f), "utf8")) as SnapshotDoc }))
      .sort((a, b) => b.doc.createdAt - a.doc.createdAt);
    if (all.length === 0) {
      console.error("dispatch: no snapshots in store — POST /api/snapshots first");
      return 2;
    }
    digest = all[0].f.replace(/\.json$/, "");
  }
  const doc = JSON.parse(readFileSync(join(snapDir, `${digest}.json`), "utf8")) as SnapshotDoc;

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
    writeFileSync(out, body);
    console.error(`  written: ${out}`);
  } else {
    console.log(body);
  }
  return artifact.findings.some((f) => f.kind === "security-review-required") ? 3 : 0;
}

process.exit(main());
