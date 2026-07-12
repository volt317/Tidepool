// server/test/store.test.ts — the SQLite observation store: the four
// milestone-required test classes plus the migration ledger's guarantees.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, cpSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DomainId, Verification } from "../../shared/types.js";
import { ObservationStore, type CollectionInput } from "../src/core/store.js";
import { exportCorpus, importCorpus } from "../src/core/corpusio.js";
import { buildSnapshot, SnapshotStore } from "../src/core/snapshot.js";
import { openDatabase, DEFAULT_MIGRATIONS_DIR } from "../src/core/db.js";
import type { UnitProvider } from "../src/core/aggregator.js";

const tmp = () => mkdtempSync(join(tmpdir(), "tp-store-"));

const T0 = 1700000000000;

function collection(over: Partial<CollectionInput> = {}): CollectionInput {
  return {
    domain: "code" as DomainId,
    unitId: "stub",
    unitKind: "npm",
    authority: "stub (test)",
    sourceType: "surface:api",
    canonicalUrl: "https://registry.example/api",
    scope: "test scope",
    collectedAt: T0,
    status: "ok",
    error: null,
    verification: null as Verification,
    signedBy: [],
    limitations: [],
    rawArtifactDigest: null,
    parserVersion: "1",
    configVersion: "c".repeat(64),
    recordKind: "index",
    records: [
      { name: "alpha", version: "1.0.0", meta: "main|libs" },
      { name: "beta", version: "2.0.0", meta: "main|libs" },
    ],
    ...over,
  };
}

/** enough of a UnitProvider for the snapshot builder (never fetched from) */
const fakeProvider = (): UnitProvider => ({
  domain: "code",
  id: "stub",
  label: "stub (test)",
  kind: "npm",
  osvEcosystem: null,
  sourceOrder: ["api"],
  parserVersion: "1",
  configVersion: "c".repeat(64),
  syncIndex: () => Promise.reject(new Error("snapshot building must not fetch")),
  syncAdvisories: () => Promise.reject(new Error("snapshot building must not fetch")),
});

// ------------------------------------------------- 13: unchanged-content dedup

test("unchanged content: new observation, deduplicated states and objects, zero changes", () => {
  const dir = tmp();
  try {
    const store = new ObservationStore(dir);
    const r1 = store.recordCollection(collection({ collectedAt: T0 }));
    const r2 = store.recordCollection(collection({ collectedAt: T0 + 60_000 }));

    assert.notEqual(r1.observationId, r2.observationId, "each collection occurrence is its own observation");
    assert.equal(r1.normalizedDigest, r2.normalizedDigest, "identical content shares one content address");
    assert.equal(r1.newStates, 2, "first sight materializes entity states");
    assert.equal(r2.newStates, 0, "re-observation reuses them");
    assert.equal(r2.changes.length, 0, "nothing changed, nothing fabricated");

    const counts = store.counts();
    assert.equal(counts.observations, 2, "the occurrence itself is preserved — Tidepool learned the source was still there");
    assert.equal(counts.entity_states, 2, "states stored once, not per occurrence");
    assert.equal(store.objectDigests().length, 1, "one normalized object for both observations");

    const obs = store.observationsFor("code", "stub");
    assert.equal(obs.length, 2);
    assert.equal(obs[0].recordsDigest, obs[1].recordsDigest);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- 14: failure and recovery

test("failure and recovery are first-class observations with derived transitions", () => {
  const dir = tmp();
  try {
    const store = new ObservationStore(dir);
    store.recordCollection(collection({ collectedAt: T0 }));
    store.recordCollection(collection({ collectedAt: T0 + 1000, status: "error", error: "HTTP 503", records: [] }));
    store.recordCollection(collection({ collectedAt: T0 + 2000 }));

    const obs = store.observationsFor("code", "stub");
    assert.equal(obs.length, 3);
    assert.equal(obs[1].status, "error");
    assert.equal(obs[1].error, "HTTP 503", "the failure is recorded, not skipped");
    assert.equal(obs[1].recordCount, 0);

    const kinds = store.changesFor("code", "stub").map((c) => c.kind);
    assert.deepEqual(kinds, ["source-failure", "source-recovery"]);
    const changes = store.changesFor("code", "stub");
    assert.equal(changes[0].toObservation, obs[1].id, "failure attributed to the failing observation");
    assert.equal(changes[1].fromObservation, obs[1].id, "recovery names the failed observation as its predecessor");

    // recovery back to identical content must not fabricate per-record adds
    assert.ok(!kinds.includes("package-added"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------- 15: old snapshots identical after newer observations

test("historical reconstruction: an old snapshot rebuilds identically after newer syncs", async () => {
  const dir = tmp();
  try {
    const store = new ObservationStore(dir);
    const providers = [fakeProvider()];

    store.recordCollection(collection({ collectedAt: T0 }));
    const windowV1 = { from: T0 - 1000, to: T0 + 1000 };
    const snapA = await buildSnapshot({ providers, store, stage: "interpretive", windowHours: 1, window: windowV1 });

    // upstream moves later: alpha 1.0.0 → 1.0.1
    store.recordCollection(
      collection({
        collectedAt: T0 + 3_600_000,
        records: [
          { name: "alpha", version: "1.0.1", meta: "main|libs" },
          { name: "beta", version: "2.0.0", meta: "main|libs" },
        ],
      })
    );

    const snapB = await buildSnapshot({ providers, store, stage: "interpretive", windowHours: 1, window: windowV1 });
    assert.equal(snapA.digest, snapB.digest, "newer observations are invisible behind the old boundary");
    assert.equal(snapB.entities.find((e) => e.name === "alpha")?.current, "1.0.0", "the OLD state is reconstructed");

    const windowV2 = { from: T0 - 1000, to: T0 + 7_200_000 };
    const snapC = await buildSnapshot({ providers, store, stage: "interpretive", windowHours: 1, window: windowV2 });
    assert.notEqual(snapC.digest, snapA.digest);
    assert.equal(snapC.entities.find((e) => e.name === "alpha")?.current, "1.0.1", "the new boundary sees the movement");
    assert.ok(snapC.changes.some((c) => c.kind === "version-moved" && c.package === "alpha"));
    assert.equal(snapA.changes.length, 0, "the movement postdates the old window");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------ 16: exported data loads without network

test("full corpus export loads into a fresh store offline, provenance intact", async () => {
  const a = tmp();
  const b = tmp();
  try {
    const src = new ObservationStore(a);
    src.recordCollection(collection({ collectedAt: T0 }));
    src.recordCollection(
      collection({
        collectedAt: T0 + 1000,
        records: [
          { name: "alpha", version: "1.0.1", meta: "main|libs" },
          { name: "beta", version: "2.0.0", meta: "main|libs" },
        ],
      })
    );
    const snap = await buildSnapshot({ providers: [fakeProvider()], store: src, stage: "churn", windowHours: 1, window: { from: T0 - 1, to: T0 + 2000 } });
    src.recordSnapshotManifest({
      digest: snap.digest ?? "",
      window: snap.window,
      createdAt: snap.createdAt,
      scope: snap.scope,
      notObserved: snap.notObserved,
      ambiguities: snap.ambiguities,
      observations: snap.observations,
      changes: snap.changes,
      findings: [],
      bundlePath: null,
    });

    const bundle = join(a, "exports", "test.tar.zst");
    const exported = await exportCorpus(src, bundle);
    assert.equal(exported.manifest.mode, "full");
    assert.ok(exported.manifest.objectDigests.length >= 2, "both normalized corpora travel");

    const dst = new ObservationStore(b);
    const dry = importCorpus(dst, bundle, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.inserted.observations >= 2, "dry run reports what WOULD be inserted");
    assert.equal(dst.counts().observations, 0, "dry run writes nothing");

    const real = importCorpus(dst, bundle);
    assert.equal(real.checksumFailures.length, 0);
    assert.ok(real.schemaCompatible);
    assert.equal(dst.counts().observations, src.counts().observations);
    assert.equal(dst.counts().entities, src.counts().entities);
    assert.equal(dst.counts().changes, src.counts().changes);
    assert.equal(real.objectsWritten, exported.manifest.objectDigests.length);

    // the imported store answers historical queries with no network and no recollection
    const sourceId = dst.sources()[0].id;
    const at = dst.queryStateAt(sourceId, T0 + 500);
    assert.equal((at.records as { name: string; version: string }[]).find((r) => r.name === "alpha")?.version, "1.0.0");
    const moved = dst.changesFor("code", "stub").find((c) => c.kind === "version-moved");
    assert.equal(moved?.package, "alpha");
    assert.equal(moved?.to, "1.0.1", "provenance and attribution survive the transfer");

    // re-import is idempotent: identical rows are reused, never conflicting
    const again = importCorpus(dst, bundle);
    assert.equal(Object.values(again.inserted).reduce((x, y) => x + y, 0), 0);
    assert.equal(again.conflicts.length, 0);

    // a tampered bundle is rejected by checksums before any merge
    const tampered = join(a, "exports", "tampered.tar.zst");
    const bytes = readFileSync(bundle);
    bytes[bytes.length - 12] ^= 0xff;
    writeFileSync(tampered, bytes);
    assert.throws(() => importCorpus(dst, tampered), /corrupt|invalid|manifest|zstd|checksum/i);

    src.close();
    dst.close();
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("thin export carries only snapshot-referenced objects", async () => {
  const a = tmp();
  try {
    const src = new ObservationStore(a);
    src.recordCollection(collection({ collectedAt: T0 }));
    const snap = await buildSnapshot({ providers: [fakeProvider()], store: src, stage: "observation", windowHours: 1, window: { from: T0 - 1, to: T0 + 1 } });
    // the production path: SnapshotStore writes the document AND the manifest rows
    new SnapshotStore(join(a, "snapshots"), src).save(snap);
    // content the snapshot does NOT reference
    src.recordCollection(collection({ collectedAt: T0 + 9_999_000, records: [{ name: "gamma", version: "9.9.9", meta: "x|y" }] }));
    assert.equal(src.objectDigests().length, 2);

    const bundle = join(a, "exports", "thin.tar.zst");
    const thin = await exportCorpus(src, bundle, { snapshotIds: [snap.digest ?? ""] });
    assert.equal(thin.manifest.mode, "thin");
    assert.equal(thin.manifest.objectDigests.length, 1, "only the referenced normalized corpus travels");
    assert.deepEqual(thin.manifest.snapshotIds, [snap.digest]);
    src.close();
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- migration guarantees

test("migration ledger: applied versions recorded with digests; drift refuses to run", () => {
  const dir = tmp();
  const migs = mkdtempSync(join(tmpdir(), "tp-migs-"));
  try {
    cpSync(DEFAULT_MIGRATIONS_DIR, migs, { recursive: true });
    const first = openDatabase(dir, migs);
    assert.equal(first.migrations.length, 3, "all three migrations applied");
    first.db.close();

    // reopen: idempotent, nothing re-applied, digests verified
    const second = openDatabase(dir, migs);
    assert.deepEqual(second.migrations, first.migrations);
    second.db.close();

    // drift: the applied file's content changes on disk → hard refusal
    appendFileSync(join(migs, "0001_initial.sql"), "\n-- drifted\n");
    assert.throws(() => openDatabase(dir, migs), /drifted schema history/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(migs, { recursive: true, force: true });
  }
});

test("source identity is stable across configuration changes; config provenance is per-observation", () => {
  const dir = tmp();
  try {
    const store = new ObservationStore(dir);
    store.recordCollection(collection({ collectedAt: T0, configVersion: "a".repeat(64) }));
    store.recordCollection(collection({ collectedAt: T0 + 1000, configVersion: "b".repeat(64) }));
    assert.equal(store.sources().length, 1, "one source identity across config revisions");
    const obs = store.observationsFor("code", "stub");
    assert.equal(obs[0].configVersion, "a".repeat(64));
    assert.equal(obs[1].configVersion, "b".repeat(64), "each observation carries the config that produced it");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
