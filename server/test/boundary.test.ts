// server/test/boundary.test.ts — the corpus boundary: whole-corpus IO,
// parse-after-the-fact, in-code semantic validation, pure gpgv verdicts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendCorpus, parseJsonCorpus, readCorpusText, writeCorpusAtomic } from "../src/lib/corpus.js";
import {
  validateConfig,
  validateObservation,
  validateChange,
  validateSnapshotDoc,
} from "../src/lib/validate.js";
import { interpretGpgvVerdict, availableKeyrings } from "../src/lib/gpg.js";

// ------------------------------------------------------------------ corpus

test("writeCorpusAtomic + readCorpusText round-trip, no partial state left", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-corpus-"));
  try {
    const p = join(dir, "doc.json");
    writeCorpusAtomic(p, '{"a":1}');
    assert.equal(readCorpusText(p), '{"a":1}');
    writeCorpusAtomic(p, '{"a":2}');
    assert.equal(readCorpusText(p), '{"a":2}', "atomic overwrite");
    assert.throws(() => readFileSync(`${p}.tmp`), "temp sibling is renamed away");
    appendCorpus(p, "\nline2");
    assert.ok(readCorpusText(p).endsWith("line2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseJsonCorpus names the corpus in its error", () => {
  assert.equal((parseJsonCorpus('{"ok":true}', "x") as { ok: boolean }).ok, true);
  assert.throws(() => parseJsonCorpus("{nope", "tidepool.config.json"), /tidepool\.config\.json/);
});

// ------------------------------------------------------------------ config

const minimalConfig = () => ({
  server: { port: 8747 },
  distros: [
    {
      id: "ubuntu-noble",
      label: "Ubuntu",
      family: "apt",
      index: {
        pockets: [{ id: "release", base: "https://archive.ubuntu.com/ubuntu", suite: "noble" }],
        components: ["main"],
        arch: "amd64",
      },
    },
  ],
  ecosystems: [
    {
      id: "npm",
      label: "npm",
      ecosystem: "npm",
      scope: { mode: "list", packages: ["express", "@types/node", "golang.org/x/crypto"] },
    },
  ],
});

test("validateConfig accepts a minimal valid config", () => {
  const r = validateConfig(minimalConfig());
  assert.deepEqual(r.errors, []);
  assert.ok(r.config);
});

test("validateConfig rejects each error class with a field-accurate path", () => {
  const cases: [(c: ReturnType<typeof minimalConfig>) => void, RegExp][] = [
    [(c) => ((c.server as Record<string, unknown>).port = "8747"), /config\.server\.port: expected finite number/],
    [(c) => ((c.server as Record<string, unknown>).port = 70000), /port: must be within 1\.\.65535/],
    [(c) => (c.distros[0].index.pockets[0].base = "ftp://x.example/y"), /pockets\[0\]\.base: URL scheme must be http/],
    [(c) => (c.distros[0].index.pockets[0].base = "not a url"), /pockets\[0\]\.base: expected a URL/],
    [(c) => ((c as Record<string, unknown>).distross = []), /config\.distross: unknown key/],
    [(c) => (c.ecosystems[0].scope.packages[0] = "has spaces"), /packages\[0\]: must be a package name/],
    [(c) => ((c.ecosystems[0] as Record<string, unknown>).ecosystem = "cargo"), /ecosystem: must be one of/],
    [(c) => (c.distros[0].id = "UPPER"), /distros\[0\]\.id: must be a slug/],
    [(c) => ((c.distros[0].index as Record<string, unknown>).keyrings = ["relative/path.gpg"]), /keyrings\[0\]: keyring path must be absolute/],
    [(c) => ((c.distros[0].index as Record<string, unknown>).keyrings = ["/etc/../etc/k.gpg"]), /must not contain '\.\.'/],
  ];
  for (const [mutate, expected] of cases) {
    const cfg = minimalConfig();
    mutate(cfg);
    const r = validateConfig(cfg);
    assert.equal(r.config, undefined, `mutation should invalidate: ${expected}`);
    assert.ok(r.errors.some((e) => expected.test(e)), `${expected} in: ${r.errors.join(" | ")}`);
  }
});

test("validateConfig catches duplicate unit ids across domains", () => {
  const cfg = minimalConfig();
  cfg.ecosystems[0].id = "ubuntu-noble";
  const r = validateConfig(cfg);
  assert.ok(r.errors.some((e) => /duplicate unit id: ubuntu-noble/.test(e)));
});

test("validateConfig exempts $comment keys from unknown-key strictness", () => {
  const cfg = minimalConfig();
  (cfg.distros[0].index as Record<string, unknown>)["$comment.verifySignatures"] = "docs";
  assert.deepEqual(validateConfig(cfg).errors, []);
});

// ----------------------------------------------------------- stored corpora

test("validateObservation / validateChange enforce structure and enums", () => {
  const goodObs = {
    id: "a".repeat(64),
    sourceId: "surface:api",
    collectedAt: 1700000000000,
    status: "ok",
    recordsDigest: "b".repeat(64),
    recordCount: 3,
  };
  assert.ok(validateObservation(goodObs, "t").obs);
  assert.ok(validateObservation({ ...goodObs, id: "zz" }, "t").errors[0].includes("content address"));
  assert.ok(validateObservation({ ...goodObs, status: "meh" }, "t").errors[0].includes("must be one of"));

  const goodChange = {
    id: "c".repeat(64),
    kind: "version-moved",
    toObservation: "a".repeat(64),
    detectedAt: 1700000000000,
  };
  assert.ok(validateChange(goodChange, "t").change);
  assert.ok(validateChange({ ...goodChange, kind: "package-teleported" }, "t").errors[0].includes("must be one of"));
});

test("validateSnapshotDoc rejects wrong schema, bad stage, inverted window", () => {
  const good = {
    schema: "tidepool-snapshot-v1",
    stage: "churn",
    createdAt: 1700000000000,
    window: { from: 1, to: 2 },
    coverage: [], notObserved: [], entities: [], observations: [],
    changes: [], relationships: [], findings: [], ambiguities: [],
  };
  assert.ok(validateSnapshotDoc(good, "s").doc);
  assert.ok(validateSnapshotDoc({ ...good, schema: "v2" }, "s").errors[0].includes("tidepool-snapshot-v1"));
  assert.ok(validateSnapshotDoc({ ...good, stage: "bogus" }, "s").errors[0].includes("must be one of"));
  assert.ok(validateSnapshotDoc({ ...good, window: { from: 9, to: 1 } }, "s").errors[0].includes("must be <="));
  assert.ok(validateSnapshotDoc({ ...good, entities: "nope" }, "s").errors[0].includes("expected array"));
});

// ------------------------------------------------------------- gpg verdicts
// Pure interpretation of gpgv runs — the exact stderr shapes observed live.

test("interpretGpgvVerdict: good signature", () => {
  const v = interpretGpgvVerdict(
    0,
    'gpgv: Signature made Wed Jul  8 22:58:07 2026 UTC\ngpgv: Good signature from "Ubuntu Archive Automatic Signing Key (2018) <ftpmaster@ubuntu.com>"\n'
  );
  assert.equal(v.ok, true);
  assert.ok(v.signedBy[0].includes("Ubuntu Archive"));
});

test("interpretGpgvVerdict: tampered document is refused even on exit 0", () => {
  // exit codes read through pipelines can lie — the verdict line must rule
  const v = interpretGpgvVerdict(0, 'gpgv: BAD signature from "Ubuntu Archive Automatic Signing Key (2018)"\n');
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /BAD signature/);
});

test("interpretGpgvVerdict: missing key and empty output fail closed", () => {
  const noKey = interpretGpgvVerdict(2, "gpgv: Can't check signature: No public key\n");
  assert.equal(noKey.ok, false);
  assert.match(noKey.reason ?? "", /not present in the configured keyrings/);

  const silent = interpretGpgvVerdict(0, "");
  assert.equal(silent.ok, false, "exit 0 without a Good signature line is still a failure");
});

test("availableKeyrings filters to existing files only", () => {
  const rings = availableKeyrings(["/nonexistent/ring.gpg", "/etc/hostname"]);
  assert.deepEqual(rings, ["/etc/hostname"]);
});
