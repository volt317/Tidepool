// server/test/inflow.test.ts — immutable observations, deterministic change
// detection, and the heuristic rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Observation } from "../../shared/types.js";
import {
  stableStringify,
  digestOf,
  detectChanges,
  runHeuristics,
  type IndexRecordLite,
} from "../src/core/inflow.js";

/** local observation fixture — identity assignment is the store's concern
 *  now (see store.test.ts); detectChanges only needs a well-formed DTO */
const mkObs = (fields: Omit<Observation, "id">): Observation => ({ id: digestOf(fields), ...fields });

// ------------------------------------------------------- canonical digests

test("stableStringify is key-order invariant; digests bind content", () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(digestOf({ x: 1, y: 2 }), digestOf({ y: 2, x: 1 }));
  assert.notEqual(digestOf({ x: 1 }), digestOf({ x: 2 }));
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}', "undefined fields do not perturb digests");
});

// -------------------------------------------------------------- observation

const obsFields = (over: Partial<Omit<Observation, "id">> = {}): Omit<Observation, "id"> => ({
  domain: "code",
  unit: "npm",
  authority: "npm (test)",
  sourceId: "surface:api",
  collectedAt: 1700000000000,
  scope: "test scope",
  verification: null,
  status: "ok",
  error: null,
  coverage: { observed: 1, limitations: [] },
  artifactDigest: null,
  parserVersion: "1",
  configVersion: "c".repeat(64),
  recordsDigest: "d".repeat(64),
  recordCount: 1,
  ...over,
});

// --------------------------------------------------------- change detection

const rec = (name: string, version: string, meta = "main|libs"): IndexRecordLite => ({ name, version, meta });

test("detectChanges: added, removed, moved, metadata — attributed to the pair", () => {
  const prev = mkObs(obsFields({ recordsDigest: "1".repeat(64) }));
  const next = mkObs(obsFields({ recordsDigest: "2".repeat(64), collectedAt: 1700000001000 }));
  const changes = detectChanges(
    prev,
    next,
    [rec("keep", "1.0"), rec("gone", "0.9"), rec("moves", "1.0"), rec("meta", "1.0", "main|old")],
    [rec("keep", "1.0"), rec("fresh", "2.0"), rec("moves", "1.1"), rec("meta", "1.0", "main|new")],
    "index"
  );
  const byKind = Object.fromEntries(changes.map((c) => [c.kind, c]));
  assert.equal(changes.length, 4);
  assert.equal(byKind["package-added"].package, "fresh");
  assert.equal(byKind["package-removed"].package, "gone");
  assert.equal(byKind["version-moved"].from, "1.0");
  assert.equal(byKind["version-moved"].to, "1.1");
  assert.equal(byKind["metadata-changed"].package, "meta");
  for (const c of changes) {
    assert.equal(c.fromObservation, prev.id, "every change names its from-observation");
    assert.equal(c.toObservation, next.id);
  }
});

test("detectChanges: identical recordsDigest short-circuits to zero changes", () => {
  const prev = mkObs(obsFields());
  const next = mkObs(obsFields({ collectedAt: 1700000001000 }));
  const changes = detectChanges(prev, next, [rec("a", "1.0")], [rec("a", "9.9")], "index");
  assert.equal(changes.length, 0, "equal digests mean equal content by contract; records are not even consulted");
});

test("detectChanges: first sight fabricates nothing; failure/recovery transition", () => {
  const first = mkObs(obsFields());
  assert.equal(detectChanges(null, first, [], [rec("a", "1.0")], "index").length, 0, "no prior = no per-record changes");

  const ok = mkObs(obsFields());
  const failed = mkObs(obsFields({ status: "error", error: "HTTP 503", recordsDigest: digestOf([]), collectedAt: 1700000002000 }));
  const f = detectChanges(ok, failed, [rec("a", "1.0")], [], "index");
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "source-failure");

  const recovered = mkObs(obsFields({ collectedAt: 1700000003000 }));
  const r = detectChanges(failed, recovered, [], [rec("a", "1.0")], "index");
  assert.equal(r[0].kind, "source-recovery");
  assert.equal(r.length, 1, "recovery does not fabricate per-record adds against an error observation");
});

test("detectChanges: verification and signer transitions", () => {
  const signed = mkObs(obsFields({ verification: "signature+digest", signedBy: ["Key A <a@x>"] }));
  const digestOnly = mkObs(
    obsFields({ verification: "digest", signedBy: [], collectedAt: 1700000004000 })
  );
  const kinds = detectChanges(signed, digestOnly, [rec("a", "1")], [rec("a", "1")], "index").map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["signer-transition", "verification-transition"]);
});

test("detectChanges: advisory publication, modification, withdrawal", () => {
  const prev = mkObs(obsFields({ sourceId: "advisories:test", recordsDigest: "3".repeat(64) }));
  const next = mkObs(obsFields({ sourceId: "advisories:test", recordsDigest: "4".repeat(64), collectedAt: 1700000005000 }));
  const changes = detectChanges(
    prev,
    next,
    [
      { package: "openssl", id: "USN-1", fingerprint: "v1" },
      { package: "openssl", id: "USN-2", fingerprint: "v1" },
      { package: "curl", id: "USN-3", fingerprint: "v1" },
    ],
    [
      { package: "openssl", id: "USN-1", fingerprint: "v2" }, // modified
      { package: "openssl", id: "USN-2", fingerprint: "v1" }, // unchanged
      { package: "zlib", id: "USN-4", fingerprint: "v1" }, // published
    ],
    "advisory"
  );
  const kinds = changes.map((c) => `${c.kind}:${c.package}`).sort();
  assert.deepEqual(kinds, ["advisory-modified:openssl", "advisory-no-longer-observed:curl", "advisory-published:zlib"]);
});

// --------------------------------------------------------------- heuristics

const change = (kind: string, over: Record<string, unknown> = {}) => ({
  id: digestOf({ kind, ...over }),
  domain: "code" as const,
  unit: "npm",
  sourceId: "surface:api",
  kind,
  fromObservation: "a".repeat(64),
  toObservation: "b".repeat(64),
  detectedAt: 1700000000000,
  ...over,
});

test("heuristics: corrective-release fires on rapid repeat moves, not singletons", () => {
  const window = { from: 1699999000000, to: 1700001000000 };
  const single = runHeuristics({
    window,
    observations: [],
    changes: [change("version-moved", { package: "left-pad", to: "1.0.1" })] as never,
  });
  assert.ok(!single.findings.some((f) => f.ruleId === "inflow.corrective-release"));

  const rapid = runHeuristics({
    window,
    observations: [],
    changes: [
      change("version-moved", { package: "left-pad", from: "1.0.0", to: "1.0.1", detectedAt: 1700000000000 }),
      change("version-moved", { package: "left-pad", from: "1.0.1", to: "1.0.2", detectedAt: 1700000600000 }),
    ] as never,
  });
  const f = rapid.findings.find((x) => x.ruleId === "inflow.corrective-release");
  assert.ok(f, "two moves within 72h fire the rule");
  assert.equal(f?.evidence.changes.length, 2, "evidence references both changes");
  assert.ok((f?.ambiguities.length ?? 0) > 0, "the rule declares its own ambiguity");
});

test("heuristics: security-burst thresholds at 5 publications", () => {
  const window = { from: 0, to: 1 };
  const four = Array.from({ length: 4 }, (_, i) => change("advisory-published", { package: `p${i}`, to: `ADV-${i}` }));
  assert.ok(!runHeuristics({ window, observations: [], changes: four as never }).findings.some((f) => f.ruleId === "inflow.security-burst"));
  const five = [...four, change("advisory-published", { package: "p4", to: "ADV-4" })];
  const f = runHeuristics({ window, observations: [], changes: five as never }).findings.find((x) => x.ruleId === "inflow.security-burst");
  assert.ok(f);
  assert.equal(f?.severityHint, "attention");
});

test("heuristics: source-degradation only when failure has no later recovery", () => {
  const window = { from: 0, to: 1 };
  const failThenRecover = [
    change("source-failure", { detectedAt: 100 }),
    change("source-recovery", { detectedAt: 200 }),
  ];
  assert.ok(!runHeuristics({ window, observations: [], changes: failThenRecover as never }).findings.some((f) => f.ruleId === "inflow.source-degradation"));
  const stillDown = [change("source-recovery", { detectedAt: 100 }), change("source-failure", { detectedAt: 200 })];
  assert.ok(runHeuristics({ window, observations: [], changes: stillDown as never }).findings.some((f) => f.ruleId === "inflow.source-degradation"));
});
