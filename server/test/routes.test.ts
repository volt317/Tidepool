// server/test/routes.test.ts — the HTTP surface, exercised over real sockets
// against stub providers: no network, no collectors, ephemeral port.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";

import type { PackageRow, SourceRecord, TidepoolConfig } from "../../shared/types.js";
import { Aggregator, type UnitProvider, type IndexResult, type AdvisoryJoin } from "../src/core/aggregator.js";
import { digestOf } from "../src/core/inflow.js";
import { SqliteObservationStore } from "../src/core/store.js";
import { SnapshotStore } from "../src/core/snapshot.js";
import { buildRouter } from "../src/core/routes.js";
import { DiskCache } from "../src/lib/util.js";
import { buildProviders } from "../src/domains/providers.js";

let dir: string;
let server: Server;
let base: string;

function stub(id: string, versions: Record<string, string>): UnitProvider {
  const packages: PackageRow[] = Object.entries(versions).map(([name, v]) => ({
    name, source: name, section: null, component: "test", arch: "-",
    homepage: null, description: null, versions: { api: v },
  }));
  const source: SourceRecord = {
    id: "surface:api", kind: "registry-surface", label: "stub api", urls: [],
    status: "ok", verified: null, error: null, fetchedAt: 1, packageCount: packages.length,
  };
  return {
    domain: "code", id, label: `stub ${id}`, kind: "npm", osvEcosystem: null,
    sourceOrder: ["api"], parserVersion: "1", configVersion: digestOf({ id }),
    syncIndex: (): Promise<IndexResult> => Promise.resolve({ sources: [source], packages }),
    syncAdvisories: (): Promise<AdvisoryJoin> =>
      Promise.resolve({
        source: { id: "advisories:none", kind: "none", label: "none", urls: [], status: "ok", advisoryCount: 0 },
        byPackage: {},
      }),
  };
}

const j = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-routes-"));
  const store = new SqliteObservationStore(join(dir, "data"));
  const agg = new Aggregator(
    [stub("alpha-unit", { express: "5.2.1", lodash: "4.18.1" })],
    new DiskCache(join(dir, "cache")),
    { server: {}, distros: [] } as unknown as TidepoolConfig,
    store
  );
  const app = express();
  app.use(express.json());
  app.use("/api", buildRouter(agg, new SnapshotStore(join(dir, "snapshots"), store)));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("GET /api/domains lists units with source order", async () => {
  const { status, body } = await j("/api/domains");
  assert.equal(status, 200);
  const domains = body.domains as { id: string; units: { id: string; sourceOrder: string[] }[] }[];
  assert.equal(domains[0].id, "code");
  assert.equal(domains[0].units[0].id, "alpha-unit");
  assert.deepEqual(domains[0].units[0].sourceOrder, ["api"]);
});

test("packages route syncs on demand (stub — no network) and filters", async () => {
  const q1 = await j("/api/domains/code/units/alpha-unit/packages?per=10");
  // first hit may return 202 while the stub 'sync' settles
  const rows = q1.status === 200 ? q1 : await j("/api/domains/code/units/alpha-unit/packages?per=10");
  assert.equal(rows.status, 200);
  assert.equal((rows.body.items as unknown[]).length, 2);
  const filtered = await j("/api/domains/code/units/alpha-unit/packages?q=expr");
  assert.equal((filtered.body.items as { name: string }[])[0].name, "express");
  const detail = await j("/api/domains/code/units/alpha-unit/packages/express");
  assert.equal((detail.body.package as { name: string }).name, "express");
  assert.equal((await j("/api/domains/code/units/alpha-unit/packages/ghost")).status, 404);
  assert.equal((await j("/api/domains/nope/units/alpha-unit/packages")).status, 404);
});

test("snapshot lifecycle over HTTP: build → reproducible → export → guards", async () => {
  const win = { from: 1, to: 4102444800000 };
  const mk = () =>
    j("/api/snapshots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "interpretive", ...win }),
    });
  const s1 = await mk();
  const s2 = await mk();
  assert.equal(s1.status, 201);
  assert.equal(s1.body.digest, s2.body.digest, "fixed window reproduces the digest");

  const digest = s1.body.digest as string;
  assert.equal((await j(`/api/snapshots/${digest}`)).status, 200);
  assert.equal((await j("/api/snapshots")).status, 200);

  const md = await fetch(`${base}/api/snapshots/${digest}/export/md`);
  assert.equal(md.status, 200);
  assert.ok((await md.text()).includes("Truth boundary"));

  assert.equal((await j(`/api/snapshots/${digest}/export/pdf`)).status, 400, "unknown format refused");
  assert.equal((await j("/api/snapshots/..%2f..%2fetc%2fpasswd")).status, 400, "traversal refused");
  assert.equal((await j(`/api/snapshots/${"0".repeat(64)}`)).status, 404, "well-formed but unknown digest");
  assert.equal(
    (await j("/api/snapshots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "vibes" }) })).status,
    400,
    "unknown stage refused"
  );
});

test("observations and changes endpoints serve the history", async () => {
  const obs = await j("/api/domains/code/units/alpha-unit/observations");
  assert.equal(obs.status, 200);
  assert.ok((obs.body.observations as unknown[]).length >= 2, "index + advisory observations recorded by the earlier sync");
  const ch = await j("/api/domains/code/units/alpha-unit/changes");
  assert.equal(ch.status, 200);
  assert.deepEqual(ch.body.changes, [], "single sync fabricates no changes");
});

// ------------------------------------------------------- config → providers

test("buildProviders maps the full shipped-config shape to units", () => {
  const config = {
    server: {},
    distros: [
      {
        id: "ubuntu-noble", label: "Ubuntu 24.04", family: "apt",
        index: { pockets: [{ id: "release", base: "https://archive.ubuntu.com/ubuntu", suite: "noble" }, { id: "security", base: "https://security.ubuntu.com/ubuntu", suite: "noble-security" }], components: ["main"], arch: "amd64" },
        advisories: { kind: "osv-on-demand" }, osvEcosystem: "Ubuntu:24.04:LTS",
      },
      { id: "disabled-one", label: "off", family: "apt", enabled: false, index: { pockets: [{ id: "x", base: "https://x.example", suite: "s" }], components: ["main"], arch: "amd64" } },
      { id: "arch", label: "Arch", family: "arch", index: { api: "https://archlinux.org/packages/search/json/", repos: ["Core"] } },
    ],
    ecosystems: [
      { id: "npm", label: "npm", ecosystem: "npm", scope: { mode: "list", packages: ["express"] } },
      { id: "vcpkg", label: "vcpkg", ecosystem: "vcpkg", scope: { mode: "list", packages: ["zlib"] } },
    ],
  } as unknown as TidepoolConfig;

  const providers = buildProviders(config);
  assert.deepEqual(providers.map((p) => `${p.domain}/${p.id}`), ["distro/ubuntu-noble", "distro/arch", "code/npm", "code/vcpkg"], "disabled units excluded, order preserved");

  const ubuntu = providers[0];
  assert.deepEqual(ubuntu.sourceOrder, ["release", "security"]);
  assert.equal(ubuntu.kind, "apt");
  assert.match(ubuntu.configVersion, /^[0-9a-f]{64}$/, "config version is a content address");

  const archP = providers[1];
  assert.deepEqual(archP.sourceOrder, ["core"], "arch repos lowercase in source order");

  const npm = providers[2];
  assert.deepEqual(npm.sourceOrder, ["packument", "manifest", "yarn"], "npm's three surfaces incl. the cross-host mirror");
  const vcpkg = providers[3];
  assert.deepEqual(vcpkg.sourceOrder, ["versions-db", "manifest"]);

  assert.notEqual(ubuntu.configVersion, providers[1].configVersion, "different configs → different versions");
});

test("a distro provider without a bulk feed reports an honest advisory source", async () => {
  const config = {
    server: {},
    distros: [{ id: "d", label: "D", family: "apt", index: { pockets: [{ id: "p", base: "https://x.example", suite: "s" }], components: ["main"], arch: "amd64" }, advisories: { kind: "osv-on-demand" }, osvEcosystem: "X" }],
    ecosystems: [],
  } as unknown as TidepoolConfig;
  const adv = await buildProviders(config)[0].syncAdvisories();
  assert.equal(adv.source.status, "ok");
  assert.match(adv.source.note ?? "", /fetched per package from OSV/);
  assert.deepEqual(adv.byPackage, {});
});
