// server/test/analysis.test.ts — the durable-analysis milestone: two-phase
// transactions, dual heads, native version semantics, structured diffs,
// coverage-aware advisory disappearance, conflict detection, integrity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DomainId, Verification } from "../../shared/types.js";
import { SqliteObservationStore, type CollectionInput } from "../src/core/store.js";
import { exportCorpus, importCorpus } from "../src/core/corpusio.js";
import { adapterFor, newestOf } from "../src/lib/versions.js";

const tmp = () => mkdtempSync(join(tmpdir(), "tp-an-"));
const T0 = 1700000000000;

function collection(over: Partial<CollectionInput> = {}): CollectionInput {
  return {
    domain: "code" as DomainId, unitId: "stub", unitKind: "npm", authority: "stub (test)",
    sourceType: "surface:api", canonicalUrl: null, scope: "test", collectedAt: T0,
    status: "ok", error: null, verification: null as Verification, signedBy: [], limitations: [],
    rawArtifactDigest: null, coverageMode: "explicit-scope", parserVersion: "1", configVersion: "c".repeat(64),
    recordKind: "index",
    records: [{ name: "alpha", version: "1.0.0", meta: "main|libs" }],
    ...over,
  };
}

// -------------------------------------- 4: latest vs latest-successful heads

test("dual heads: a failing source still reports its last known good state", () => {
  const dir = tmp();
  try {
    const store = new SqliteObservationStore(dir);
    const ok = store.recordCollection(collection({ collectedAt: T0 }));
    const bad = store.recordCollection(collection({ collectedAt: T0 + 1000, status: "error", error: "HTTP 503", records: [] }));

    const sourceId = store.sources()[0].id;
    const head = store.sourceHead(sourceId);
    assert.equal(head?.latestObservationId, bad.observationId, "latest = the failure");
    assert.equal(head?.latestSuccessfulId, ok.observationId, "successful = the last time it worked");
    assert.equal(head?.status, "error");

    // reconstruction states the same split: boundary shows the failure,
    // state comes from the last success, and the staleness is declared
    const st = store.sourceStateAt(sourceId, T0 + 2000);
    assert.equal(st.atBoundary?.status, "error");
    assert.equal(st.lastSuccessful?.id, ok.observationId);
    assert.equal((st.records as { name: string }[])[0]?.name, "alpha", "last successful records still served");
    const unit = store.unitStateAt("code", "stub", T0 + 2000);
    assert.ok(
      unit.sources[0].coverage.limitations.some((l) => l.includes("last successful observation")),
      "staleness is a declared limitation, not hidden state"
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------ 6: native versions per ecosystem

test("version adapters: each ecosystem gets its own ordering, never dpkg-for-everything", () => {
  // Debian: tilde sorts before release; epochs dominate
  assert.ok(adapterFor("apt").compareVersions("1.0~rc1", "1.0") < 0);
  assert.ok(adapterFor("apt").compareVersions("1:0.1", "2.0") > 0);
  // semver: prerelease sorts before release — OPPOSITE of a naive string sort
  assert.ok(adapterFor("npm").compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(adapterFor("npm").compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2") > 0, "numeric prerelease ids compare numerically");
  // apk: _rc before release, -r revisions break ties
  assert.ok(adapterFor("apk").compareVersions("1.2.0_rc1", "1.2.0") < 0);
  assert.ok(adapterFor("apk").compareVersions("1.2.0-r1", "1.2.0-r2") < 0);
  // pacman: epoch, then rpm-style segments, then pkgrel
  assert.ok(adapterFor("arch").compareVersions("1:1.0-1", "2.0-1") > 0);
  assert.ok(adapterFor("arch").compareVersions("1.0-1", "1.0-2") < 0);
  // pep440: dev < pre < release < post
  assert.ok(adapterFor("pypi").compareVersions("1.0.dev1", "1.0a1") < 0);
  assert.ok(adapterFor("pypi").compareVersions("1.0a1", "1.0") < 0);
  assert.ok(adapterFor("pypi").compareVersions("1.0", "1.0.post1") < 0);
  // go: canonicalizes the v prefix
  assert.equal(newestOf("go", ["v1.2.3", "v1.10.0"]).newest, "v1.10.0");

  // unsupported orderings never fabricate a "newest" from disagreeing inputs
  const maven = newestOf("maven", ["1.0-beta-2", "1.0"]);
  assert.equal(maven.ordering, "unsupported");
  assert.equal(maven.newest, null, "no approximate claim");
  assert.equal(newestOf("maven", ["1.0", "1.0"]).newest, "1.0", "unanimity is safe to report");
});

test("the same version pair orders differently under deb vs semver — proof the split matters", () => {
  const a = "1.0.0-rc1";
  const b = "1.0.0";
  assert.ok(adapterFor("npm").compareVersions(a, b) < 0, "semver: prerelease first");
  assert.ok(adapterFor("apt").compareVersions(a, b) > 0, "dpkg: -rc1 is a REVISION, sorting after 1.0.0");
});

// ---------------------------------------------- 7: structured metadata diffs

test("metadata changes carry field-level differences, not two opaque strings", () => {
  const dir = tmp();
  try {
    const store = new SqliteObservationStore(dir);
    store.recordCollection(collection({ collectedAt: T0, records: [{ name: "alpha", version: "1.0.0", meta: "universe|libs" }] }));
    const r = store.recordCollection(collection({ collectedAt: T0 + 1000, records: [{ name: "alpha", version: "1.0.0", meta: "main|admin" }] }));
    const meta = r.changes.find((c) => c.kind === "metadata-changed");
    assert.ok(meta);
    const stored = store.changesFor("code", "stub").find((c) => c.kind === "metadata-changed");
    assert.deepEqual(stored?.fields, {
      component: { from: "universe", to: "main" },
      section: { from: "libs", to: "admin" },
    }, "repository promotion is legible as component: universe → main");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------- 8+9: advisory disappearance under coverage modes

test("advisory disappearance: complete feeds prove withdrawal; bounded feeds prove only aging-out", () => {
  const dir = tmp();
  try {
    const store = new SqliteObservationStore(dir);
    const adv = (over: Partial<CollectionInput>) =>
      collection({
        sourceType: "advisories:feed", recordKind: "advisory",
        records: [{ package: "openssl", id: "ADV-1", fingerprint: "v1" }],
        ...over,
      });
    // complete authoritative source: disappearance IS withdrawal
    store.recordCollection(adv({ collectedAt: T0, coverageMode: "complete" }));
    const complete = store.recordCollection(adv({ collectedAt: T0 + 1000, coverageMode: "complete", records: [] }));
    assert.equal(complete.changes[0]?.kind, "advisory-withdrawn");

    // bounded feed on a different unit: only "left the coverage window"
    const bounded = (over: Partial<CollectionInput>) => adv({ unitId: "stub2", coverageMode: "bounded-pages", ...over });
    store.recordCollection(bounded({ collectedAt: T0 }));
    const aged = store.recordCollection(bounded({ collectedAt: T0 + 1000, records: [] }));
    assert.equal(aged.changes[0]?.kind, "advisory-left-coverage-window");

    // unprovable: explicitly-scoped source says only what it can
    const scoped = (over: Partial<CollectionInput>) => adv({ unitId: "stub3", coverageMode: "explicit-scope", ...over });
    store.recordCollection(scoped({ collectedAt: T0 }));
    const gone = store.recordCollection(scoped({ collectedAt: T0 + 1000, records: [] }));
    assert.equal(gone.changes[0]?.kind, "advisory-no-longer-observed");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------- 11: analysis failure without observation loss

test("a diffing failure marks analysis failed, preserves the observation, and is retryable", () => {
  const dir = tmp();
  try {
    const store = new SqliteObservationStore(dir);
    store.recordCollection(collection({ collectedAt: T0 }));
    const appended = store.appendObservation(collection({ collectedAt: T0 + 1000, records: [{ name: "alpha", version: "1.0.1", meta: "main|libs" }] }));
    assert.equal(appended.analysisStatus, "pending");

    // sabotage: remove the previous observation's normalized record object so
    // analysis cannot load it
    const digest = store.observationsFor("code", "stub")[0].recordsDigest;
    const objPath = join(dir, "objects", "sha256", digest.slice(0, 2), digest);
    writeFileSync(objPath, "{not json");

    const failed = store.analyzeObservation(appended.observationId);
    assert.equal(failed.status, "failed");
    assert.ok(failed.error, "the failure reason is reported");
    assert.equal(store.observationsFor("code", "stub").length, 2, "the observation survives its failed analysis");
    assert.ok(!store.verifyCorpus().checks.find((c) => c.name === "analysis-failed")?.ok, "verify surfaces the failed analysis");

    // repair the object and retry WITHOUT recollecting
    const original = Buffer.from(JSON.stringify([{ name: "alpha", version: "1.0.0", meta: "main|libs" }]));
    writeFileSync(objPath, original);
    const retried = store.analyzeObservation(appended.observationId);
    assert.equal(retried.status, "complete");
    assert.equal(retried.changes.find((c) => c.kind === "version-moved")?.to, "1.0.1", "retry derived the change from preserved evidence");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------- 18: import conflict detection

test("import: same immutable id with a different body is a reported conflict, never an overwrite", async () => {
  const a = tmp();
  const b = tmp();
  try {
    const src = new SqliteObservationStore(a);
    src.recordCollection(collection({ collectedAt: T0 }));
    const bundle = join(a, "exports", "x.tar.zst");
    await exportCorpus(src, bundle);

    const dst = new SqliteObservationStore(b);
    dst.recordCollection(collection({ collectedAt: T0 }));
    // craft divergent history: same source id, different configuration body
    dst.database.prepare("UPDATE sources SET configuration_json = '{\"configVersion\":\"tampered\"}' WHERE id = ?").run(dst.sources()[0].id);

    const report = importCorpus(dst, bundle);
    const conflict = report.conflicts.find((c) => c.table === "sources");
    assert.ok(conflict, "diverging row detected");
    assert.match(conflict?.note ?? "", /local history retained/);
    const kept = dst.database.prepare("SELECT configuration_json FROM sources").get();
    assert.match(String(kept?.configuration_json), /tampered/, "local row untouched");
    src.close();
    dst.close();
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// -------------------------------------- 19: artifact integrity verification

test("verifyCorpus catches missing and corrupted content-addressed objects", () => {
  const dir = tmp();
  try {
    const store = new SqliteObservationStore(dir);
    store.recordCollection(collection({ collectedAt: T0 }));
    assert.ok(store.verifyCorpus().checks.find((c) => c.name === "object-digests")?.ok, "clean store verifies clean");

    const digest = store.objectDigests()[0];
    writeFileSync(join(dir, "objects", "sha256", digest.slice(0, 2), digest), "corrupted bytes");
    const v = store.verifyCorpus();
    assert.equal(v.ok, false);
    assert.ok(!v.checks.find((c) => c.name === "object-digests")?.ok, "corruption detected by re-digesting");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------- first-sight baseline behavior

test("first observation creates no per-entity 'added' flood", () => {
  const dir = tmp();
  try {
    const store = new SqliteObservationStore(dir);
    const r = store.recordCollection(collection({ collectedAt: T0, records: Array.from({ length: 50 }, (_, i) => ({ name: `p${i}`, version: "1.0.0", meta: "m|s" })) }));
    assert.equal(r.changes.length, 0, "baseline sight is state, not 50 fabricated changes");
    assert.equal(r.newStates, 50);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entity identity is domain-safe: same name in different units never correlates", () => {
  const dir = tmp();
  try {
    const store = new SqliteObservationStore(dir);
    store.recordCollection(collection({ collectedAt: T0, unitId: "npm-unit", records: [{ name: "zlib", version: "1.0.0", meta: "m|s" }] }));
    store.recordCollection(collection({ collectedAt: T0, unitId: "vcpkg-unit", unitKind: "vcpkg", records: [{ name: "zlib", version: "1.3.2", meta: "m|s" }] }));
    assert.equal(store.counts().entities, 2, "identity includes domain + ecosystem, not just the name");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
