// server/test/pipeline.test.ts — snapshot exports, the contained aggregation
// flow (stub providers, zero network), dispatch analysis, surface helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SnapshotDoc, PackageRow, SourceRecord, TidepoolConfig } from "../../shared/types.js";
import { exportSnapshot, SnapshotStore } from "../src/core/snapshot.js";
import { digestOf } from "../src/core/inflow.js";
import { ObservationStore } from "../src/core/store.js";
import { Aggregator, mapLimit, type UnitProvider, type IndexResult, type AdvisoryJoin } from "../src/core/aggregator.js";
import { DiskCache, tarEntries } from "../src/lib/util.js";
import { classifyPath, analyzeAgainstSnapshot } from "../src/dispatch/analyze.js";
import { cratesIndexPath, goEscape, mavenParts, vcpkgVersion } from "../src/domains/code/surfaces.js";

// ---------------------------------------------------------------- snapshots

const sampleDoc = (): SnapshotDoc => {
  const doc: SnapshotDoc = {
    schema: "tidepool-snapshot-v1",
    stage: "interpretive",
    generatorVersion: "1",
    createdAt: 1700000000000,
    scope: { domains: ["code"], units: ["code/npm"] },
    window: { from: 1699990000000, to: 1700000000000 },
    authorities: ["npm (test)"],
    coverage: [
      {
        domain: "code", unit: "npm", authority: "npm (test)", sourceId: "surface:api",
        status: "ok", verification: null, recordCount: 2, collectedAt: 1699999999000,
        error: null, limitations: [],
      },
    ],
    notObserved: ["code/npm/surface:mirror: latest collection failed (HTTP 503)"],
    entities: [
      { domain: "code", unit: "npm", name: "express", source: "express", versions: { api: "5.2.1" }, current: "5.2.1", drift: false, advisoryCount: 1 },
    ],
    observations: [],
    changes: [
      { id: "e".repeat(64), domain: "code", unit: "npm", sourceId: "surface:api", kind: "version-moved", package: "express", from: "5.2.0", to: "5.2.1", fromObservation: "a".repeat(64), toObservation: "b".repeat(64), detectedAt: 1699999999500 },
      // package names come from upstream indexes: hostile ones must render
      // escaped in the HTML report, not execute
      { id: "f".repeat(64), domain: "code", unit: "npm", sourceId: "surface:api", kind: "package-added", package: "<script>alert(1)</script>", to: "6.6.6", fromObservation: "a".repeat(64), toObservation: "b".repeat(64), detectedAt: 1699999999600 },
    ],
    relationships: [],
    findings: [],
    ambiguities: ["test ambiguity"],
  };
  doc.digest = digestOf({ ...doc, createdAt: 0 });
  return doc;
};

test("snapshot digest binds content, not wall-clock", () => {
  const a = sampleDoc();
  const b = { ...sampleDoc(), createdAt: 1800000000000 };
  assert.equal(a.digest, digestOf({ ...b, digest: undefined, createdAt: 0 }));
});

test("every export format renders from the same doc", () => {
  const doc = sampleDoc();

  const json = exportSnapshot(doc, "json");
  assert.equal((JSON.parse(json.body.toString()) as SnapshotDoc).digest, doc.digest);

  const nd = exportSnapshot(doc, "ndjson").body.toString().trim().split("\n").map((l) => JSON.parse(l));
  const types = new Set(nd.map((r: { type: string }) => r.type));
  for (const t of ["meta", "coverage", "not-observed", "entity", "change", "ambiguity"]) assert.ok(types.has(t), `ndjson has ${t}`);

  const md = exportSnapshot(doc, "md").body.toString();
  assert.ok(md.includes("## Truth boundary"), "markdown states the truth boundary");
  assert.ok(md.includes("HTTP 503"), "notObserved entries surface");
  assert.ok(md.includes("version-moved"), "changes listed");

  const html = exportSnapshot(doc, "html").body.toString();
  assert.ok(!html.includes("<script>alert(1)</script>"), "upstream-controlled names are escaped in HTML");
  assert.ok(html.includes("&lt;script&gt;"), "escaping, not omission");

  const bundle = exportSnapshot(doc, "bundle");
  const members = tarEntries(gunzipSync(bundle.body)).map((e) => e.name.split("/").pop());
  assert.deepEqual(members?.sort(), ["report.html", "report.md", "snapshot.json", "snapshot.ndjson"]);

  const sqlite = exportSnapshot(doc, "sqlite");
  assert.equal(sqlite.body.subarray(0, 15).toString(), "SQLite format 3", "sqlite export is a real database file");
});

test("SnapshotStore refuses traversal and invalid stored content", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-snap-"));
  try {
    const store = new SnapshotStore(dir);
    const doc = sampleDoc();
    const digest = store.save(doc);
    assert.equal(store.load(digest)?.digest, doc.digest, "round trip");
    assert.equal(store.load("../../etc/passwd"), null);
    assert.equal(store.load("zzzz"), null);
    const planted = "ab".repeat(32);
    writeFileSync(join(dir, `${planted}.json`), '{"schema":"tidepool-snapshot-v1","stage":"bogus"}');
    assert.throws(() => store.load(planted), /failed validation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------- contained flow (no network)

function stubProvider(versions: Record<string, string>, over: Partial<UnitProvider> = {}): UnitProvider {
  const packages: PackageRow[] = Object.entries(versions).map(([name, v]) => ({
    name, source: name, section: null, component: "test", arch: "-",
    homepage: null, description: null, versions: { api: v },
  }));
  const source: SourceRecord = {
    id: "surface:api", kind: "registry-surface", label: "stub api", urls: [],
    status: "ok", verified: null, error: null, fetchedAt: 1, packageCount: packages.length,
  };
  return {
    domain: "code", id: "stub", label: "stub unit", kind: "npm", osvEcosystem: null,
    sourceOrder: ["api"], parserVersion: "1", configVersion: digestOf({ stub: true }),
    syncIndex: (): Promise<IndexResult> => Promise.resolve({ sources: [source], packages }),
    syncAdvisories: (): Promise<AdvisoryJoin> =>
      Promise.resolve({
        source: { id: "advisories:none", kind: "none", label: "none", urls: [], status: "ok", advisoryCount: 0 },
        byPackage: { alpha: [{ id: "ADV-1", url: "https://osv.dev/ADV-1" }] },
      }),
    ...over,
  };
}

test("Aggregator: sync → summaries → inflow observations; re-sync detects moves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-agg-"));
  try {
    const disk = new DiskCache(join(dir, "cache"));
    const store = new ObservationStore(join(dir, "data"));
    const config = { server: {}, distros: [] } as unknown as TidepoolConfig;

    const p1 = stubProvider({ alpha: "1.0.0", beta: "2.0.0" });
    const agg = new Aggregator([p1], disk, config, store);
    const st = await agg.sync(p1, { force: true });
    assert.equal(st.status, "ready");

    const page = agg.packages(p1, st, { per: 10, page: 1 });
    assert.equal(page.total, 2);
    const alpha = page.items.find((i) => i.name === "alpha");
    assert.equal(alpha?.current, "1.0.0");
    assert.equal(alpha?.advisoryCount, 1, "advisory join lands in the summary");
    assert.equal(agg.packages(p1, st, { per: 10, page: 1, advisoriesOnly: true }).total, 1);
    assert.equal(agg.packages(p1, st, { per: 10, page: 1, q: "bet" }).items[0]?.name, "beta");

    assert.equal(store.observationsFor("code", "stub").length, 2, "one observation per source (index + advisories)");
    assert.equal(store.changesFor("code", "stub").length, 0, "first sight fabricates nothing");

    // upstream moves; a second real sync must yield exactly one attributed change
    const p2 = stubProvider({ alpha: "1.0.1", beta: "2.0.0" });
    const agg2 = new Aggregator([p2], disk, config, store);
    await agg2.sync(p2, { force: true });
    const changes = store.changesFor("code", "stub");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "version-moved");
    assert.equal(changes[0].package, "alpha");
    assert.equal(changes[0].to, "1.0.1");

    // peek serves from cache without any provider call
    const p3 = stubProvider({}, { syncIndex: () => Promise.reject(new Error("peek must not fetch")) });
    const peeked = new Aggregator([p3], disk, config, store).peek(p3);
    assert.equal(peeked?.packages.length, 2, "peek reads the store, never the network");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Aggregator: a unit whose only source fails is an error state, recorded as an observation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-agg2-"));
  try {
    const failing = stubProvider({}, {
      syncIndex: (): Promise<IndexResult> =>
        Promise.resolve({
          sources: [{ id: "surface:api", kind: "registry-surface", label: "stub", urls: [], status: "error", error: "HTTP 503" }],
          packages: [],
        }),
    });
    const store = new ObservationStore(join(dir, "data"));
    const agg = new Aggregator([failing], new DiskCache(join(dir, "cache")), { server: {}, distros: [] } as unknown as TidepoolConfig, store);
    const st = await agg.sync(failing, { force: true });
    assert.equal(st.status, "error");
    const obs = store.observationsFor("code", "stub").find((o) => o.sourceId === "surface:api");
    assert.equal(obs?.status, "error");
    assert.equal(obs?.error, "HTTP 503", "failures are observations too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mapLimit bounds concurrency and preserves order", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `peak concurrency ${peak} within limit`);
});

// ----------------------------------------------------------------- dispatch

test("classifyPath: node project with lockfile, container base, unrecognized", () => {
  const root = mkdtempSync(join(tmpdir(), "tp-cls-"));
  try {
    const node = join(root, "node");
    mkdirSync(node);
    writeFileSync(join(node, "package.json"), JSON.stringify({ dependencies: { express: "^4.18.0" } }));
    writeFileSync(join(node, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/express": { version: "4.18.0" }, "node_modules/@scope/pkg": { version: "1.2.3" } } }));
    const p = classifyPath(node);
    assert.ok(p.classes.includes("node-project"));
    assert.deepEqual(
      p.dependencies.map((d) => `${d.name}@${d.version}`).sort(),
      ["@scope/pkg@1.2.3", "express@4.18.0"],
      "lockfile wins, scoped names parse"
    );
    assert.match(p.fingerprint, /^[0-9a-f]{64}$/);

    const docker = join(root, "img");
    mkdirSync(docker);
    writeFileSync(join(docker, "Dockerfile"), "FROM ubuntu:24.04\nRUN true\nFROM scratch\n");
    const d = classifyPath(docker);
    assert.ok(d.classes.includes("container-image"));
    assert.deepEqual(d.baseImages, [{ image: "ubuntu:24.04", unit: "ubuntu-noble" }], "scratch excluded, noble mapped");

    const empty = join(root, "misc");
    mkdirSync(empty);
    writeFileSync(join(empty, "notes.txt"), "hello");
    assert.deepEqual(classifyPath(empty).classes, ["unrecognized"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analyzeAgainstSnapshot: update, security, bounded-scope, shared exposure", () => {
  const snapshot = sampleDoc(); // express@5.2.1 with 1 advisory in code/npm
  const root = mkdtempSync(join(tmpdir(), "tp-disp-"));
  try {
    for (const [name, lock] of [["a", "4.18.0"], ["b", "4.19.2"]] as const) {
      const d = join(root, name);
      mkdirSync(d);
      writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { express: "*", ghostpkg: "*" } }));
      writeFileSync(join(d, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/express": { version: lock }, "node_modules/ghostpkg": { version: "1.0.0" } } }));
    }
    const artifact = analyzeAgainstSnapshot([classifyPath(join(root, "a")), classifyPath(join(root, "b"))], snapshot);
    const kinds = artifact.findings.map((f) => f.kind);
    assert.ok(kinds.includes("dependency-update-available"), "4.18.0 < 5.2.1");
    assert.ok(kinds.includes("security-review-required"), "advisoryCount 1 on the entity");
    assert.ok(
      artifact.findings.some((f) => f.kind === "insufficient-evidence" && f.subject.includes("ghostpkg") && f.summary.includes("not proof of absence")),
      "out-of-scope dependency is insufficient evidence, never silence"
    );
    assert.ok(artifact.sharedExposure.some((s) => s.name === "express" && s.paths.length === 2));
    assert.equal(artifact.snapshotDigest, snapshot.digest, "artifact references its snapshot");
    assert.match(artifact.digest ?? "", /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- surface helpers

test("cratesIndexPath follows the sparse-index sharding rules", () => {
  assert.equal(cratesIndexPath("a"), "1/a");
  assert.equal(cratesIndexPath("io"), "2/io");
  assert.equal(cratesIndexPath("fnv"), "3/f/fnv");
  assert.equal(cratesIndexPath("serde"), "se/rd/serde");
  assert.equal(cratesIndexPath("Inflector"), "in/fl/inflector", "lowercased");
});

test("goEscape bang-escapes capitals per the module proxy protocol", () => {
  assert.equal(goEscape("github.com/Azure/azure-sdk"), "github.com/!azure/azure-sdk");
  assert.equal(goEscape("golang.org/x/crypto"), "golang.org/x/crypto");
});

test("mavenParts splits group:artifact and rejects malformed names", () => {
  assert.deepEqual(mavenParts("org.apache.logging.log4j:log4j-core"), { g: "org.apache.logging.log4j", a: "log4j-core" });
  assert.equal(mavenParts("no-colon"), null);
  assert.equal(mavenParts(":leading"), null);
  assert.equal(mavenParts("trailing:"), null);
});

test("vcpkgVersion renders version#port-version across the field variants", () => {
  assert.equal(vcpkgVersion({ version: "1.3.2", "port-version": 1 }), "1.3.2#1");
  assert.equal(vcpkgVersion({ version: "1.3.2", "port-version": 0 }), "1.3.2");
  assert.equal(vcpkgVersion({ "version-semver": "8.21.0" }), "8.21.0");
  assert.equal(vcpkgVersion({ "version-date": "2026-01-01", "port-version": 2 }), "2026-01-01#2");
  assert.equal(vcpkgVersion({}), null);
});
