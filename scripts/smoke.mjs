// scripts/smoke.mjs
//
// Runtime smoke test. Boots the *built* service (server/dist) against a
// dedicated minimal config in a temp root and asserts the load-bearing
// behaviors end to end, live:
//
//   1. the API comes up and lists both domains;
//   2. a real apt pocket (noble-security) syncs with the full verification
//      chain — the source must report `signature+digest` and a plausible
//      package count;
//   3. a code unit resolves its scope across ALL npm surfaces, including the
//      cross-host yarnpkg mirror;
//   4. search returns the expected row with a per-source version;
//   5. the built frontend is served.
//
// External dependencies are deliberately minimal and highly-available
// (security.ubuntu.com, registry.npmjs.org, registry.yarnpkg.com); advisory
// and enrichment sources are disabled in the smoke config so their outages
// can never fail CI. Exit code is the verdict. Run locally with `npm run
// smoke` after `npm run build`.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8912;
const BASE = `http://localhost:${PORT}`;
const KEYRING = "/usr/share/keyrings/ubuntu-archive-keyring.gpg";

const smokeConfig = {
  server: { port: PORT, cacheDir: ".cache", indexTtlHours: 6, advisoryTtlHours: 2 },
  distros: [
    {
      id: "ubuntu-noble",
      label: "Ubuntu 24.04 (smoke: security pocket)",
      family: "apt",
      enabled: true,
      index: {
        pockets: [{ id: "security", base: "https://security.ubuntu.com/ubuntu", suite: "noble-security" }],
        components: ["main"],
        arch: "amd64",
        verifyDigests: true,
        verifySignatures: true,
        keyrings: [KEYRING],
      },
      advisories: { kind: "osv-on-demand" },
      osvEcosystem: "Ubuntu:24.04:LTS",
    },
  ],
  ecosystems: [
    {
      id: "npm",
      label: "npm (smoke)",
      ecosystem: "npm",
      enabled: true,
      osvEcosystem: null, // no advisory network dependency in smoke
      scope: { mode: "list", packages: ["express", "lodash"] },
    },
  ],
  enrichment: { osv: false, endoflife: false, github: false },
  packageHints: {},
};

// ------------------------------------------------------------------ helpers

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};

const ok = (msg) => console.log(`  ✓ ${msg}`);

async function get(path, { timeoutMs = 15000, expectJson = true } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { signal: ctrl.signal });
    const body = expectJson ? await res.json().catch(() => ({})) : await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function poll(desc, fn, { intervalMs = 2000, timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = await fn().catch(() => null);
    if (out) return out;
    if (Date.now() > deadline) fail(`timed out waiting for: ${desc}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// --------------------------------------------------------------------- main

const root = mkdtempSync(join(tmpdir(), "tidepool-smoke-"));
writeFileSync(join(root, "tidepool.config.json"), JSON.stringify(smokeConfig, null, 2));

// serve the built frontend from the temp root if it exists in the checkout
const webDist = join(process.cwd(), "web", "dist");
const haveWeb = existsSync(webDist);
if (haveWeb) cpSync(webDist, join(root, "web", "dist"), { recursive: true });

const serverEntry = join(process.cwd(), "server", "dist", "server", "src", "index.js");
if (!existsSync(serverEntry)) fail("server/dist missing — run `npm run build` first");

console.log(`smoke: root=${root} keyring=${existsSync(KEYRING) ? "present" : "MISSING"}`);
const child = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, TIDEPOOL_ROOT: root, TIDEPOOL_SERVE_STATIC: haveWeb ? "1" : "0" },
  stdio: ["ignore", "inherit", "inherit"],
});

let exitCode = 1;
try {
  // 1) API up, both domains present
  const domains = await poll("API up", async () => {
    const r = await get("/api/domains", { timeoutMs: 3000 });
    return r.status === 200 ? r.body.domains : null;
  }, { intervalMs: 500, timeoutMs: 20000 });
  const unitIds = domains.flatMap((d) => d.units.map((u) => `${d.id}/${u.id}`));
  if (!unitIds.includes("distro/ubuntu-noble") || !unitIds.includes("code/npm"))
    fail(`expected units missing, saw: ${unitIds.join(", ")}`);
  ok(`API up with units: ${unitIds.join(", ")}`);

  // 2) sync both units, wait for ready
  await get("/api/domains/distro/units/ubuntu-noble/sync", { timeoutMs: 3000 }).catch(() => null);
  await fetch(`${BASE}/api/domains/distro/units/ubuntu-noble/sync`, { method: "POST" });
  await fetch(`${BASE}/api/domains/code/units/npm/sync`, { method: "POST" });

  const ready = await poll("both units ready", async () => {
    const r = await get("/api/domains");
    const units = r.body.domains.flatMap((d) => d.units);
    const ubuntu = units.find((u) => u.id === "ubuntu-noble");
    const npm = units.find((u) => u.id === "npm");
    for (const u of [ubuntu, npm]) {
      if (u?.status === "error") fail(`${u.id} sync errored: ${u.error} :: ${JSON.stringify(u.sources.map((s) => s.error).filter(Boolean))}`);
    }
    return ubuntu?.status === "ready" && npm?.status === "ready" ? { ubuntu, npm } : null;
  });

  // 3) GPG + digest chain actually enforced on live data
  const pocket = ready.ubuntu.sources.find((s) => s.id === "pocket:security");
  if (!pocket || pocket.status !== "ok") fail(`security pocket not ok: ${pocket?.error}`);
  if (pocket.verified !== "signature+digest")
    fail(`expected signature+digest, got ${pocket.verified} (signedBy: ${pocket.signedBy})`);
  if ((pocket.packageCount ?? 0) < 1000) fail(`implausible package count: ${pocket.packageCount}`);
  ok(`ubuntu security pocket: ${pocket.packageCount} packages, verified=${pocket.verified}, signed by ${pocket.signedBy?.[0]}`);

  // 4) npm resolved on every surface, mirror included
  for (const sid of ["surface:packument", "surface:manifest", "surface:yarn"]) {
    const s = ready.npm.sources.find((x) => x.id === sid);
    if (!s || s.status !== "ok" || (s.packageCount ?? 0) < 2)
      fail(`${sid} not fully resolved: status=${s?.status} count=${s?.packageCount} err=${s?.error}`);
  }
  ok("npm scope resolved on all three surfaces (packument, manifest, cross-host yarn mirror)");

  const npmRows = await get("/api/domains/code/units/npm/packages?q=express&per=1");
  const express = npmRows.body.items?.[0];
  if (!express || !express.versions.packument || express.versions.packument !== express.versions.yarn)
    fail(`express surfaces incoherent: ${JSON.stringify(express?.versions)}`);
  ok(`express ${express.versions.packument} agrees across surfaces (drift=${express.drift})`);

  // 5) query the verified distro index
  const q = await get("/api/domains/distro/units/ubuntu-noble/packages?q=openssl&per=1");
  const row = q.body.items?.[0];
  if (!row || !row.versions.security) fail(`openssl query failed: ${JSON.stringify(q.body).slice(0, 200)}`);
  ok(`distro query: ${row.name} security=${row.versions.security}`);

  // 6) static frontend served (when built)
  if (haveWeb) {
    const page = await get("/", { expectJson: false });
    if (page.status !== 200 || !String(page.body).includes("<div id=\"root\">"))
      fail(`static frontend not served (status ${page.status})`);
    ok("built frontend served at /");
  } else {
    console.log("  - web/dist absent; static serving skipped");
  }

  // 7) snapshot pipeline: build twice on one explicit window → identical digest;
  //    markdown export must state the truth boundary
  const to = Date.now();
  const from = to - 24 * 3600 * 1000;
  const mkSnap = async () => {
    const r = await fetch(`${BASE}/api/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "interpretive", from, to }),
    });
    if (r.status !== 201) fail(`snapshot build failed: ${r.status}`);
    return r.json();
  };
  const s1 = await mkSnap();
  const s2 = await mkSnap();
  if (s1.digest !== s2.digest) fail(`snapshot not reproducible: ${s1.digest} vs ${s2.digest}`);
  const md = await get(`/api/snapshots/${s1.digest}/export/md`, { expectJson: false });
  if (!String(md.body).includes("Truth boundary")) fail("snapshot markdown lacks the truth boundary section");
  ok(`snapshot ${String(s1.digest).slice(0, 12)}: reproducible on a fixed window; ${s1.observations} obs, ${s1.changes} change(s), truth boundary exported`);

  // 8) dispatch: a fixture project pinned behind upstream must yield a
  //    dependency-update finding from the snapshot alone (no re-collection)
  const proj = mkdtempSync(join(tmpdir(), "tidepool-smoke-proj-"));
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "smoke", dependencies: { express: "^4.18.0" } }));
  writeFileSync(
    join(proj, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/express": { version: "4.18.0" } } })
  );
  const { spawnSync } = await import("node:child_process");
  const cli = join(process.cwd(), "server", "dist", "server", "src", "cli", "dispatch.js");
  const run = spawnSync(process.execPath, [cli, "--snapshot", s1.digest, "--store", join(root, ".tidepool"), proj], {
    encoding: "utf8",
  });
  rmSync(proj, { recursive: true, force: true });
  if (run.status !== 0 && run.status !== 3) fail(`dispatch CLI exit ${run.status}: ${run.stderr.slice(0, 300)}`);
  const artifact = JSON.parse(run.stdout);
  if (!artifact.findings.some((f) => f.kind === "dependency-update-available" && f.subject.endsWith("/express")))
    fail(`dispatch missing expected express finding: ${JSON.stringify(artifact.findings.map((f) => f.kind))}`);
  if (artifact.snapshotDigest !== s1.digest) fail("dispatch artifact does not reference the snapshot");
  ok(`dispatch: dependency-update-available for express, artifact ${String(artifact.digest).slice(0, 12)} references snapshot`);

  // 9) portable evidence: export the corpus, dry-run import it elsewhere —
  //    the bundle must carry the store without any recollection
  const corpusCli = join(process.cwd(), "server", "dist", "server", "src", "cli", "corpus.js");
  const exportOut = join(tmpdir(), `tidepool-smoke-corpus-${Date.now()}.tar.zst`);
  const exp = spawnSync(process.execPath, [corpusCli, "export", "--data", join(root, ".tidepool"), "--out", exportOut], { encoding: "utf8" });
  if (exp.status !== 0) fail(`corpus export exit ${exp.status}: ${exp.stderr.slice(0, 300)}`);
  const freshData = mkdtempSync(join(tmpdir(), "tidepool-smoke-import-"));
  const imp = spawnSync(process.execPath, [corpusCli, "import", "--data", freshData, "--in", exportOut, "--dry-run"], { encoding: "utf8" });
  rmSync(freshData, { recursive: true, force: true });
  rmSync(exportOut, { force: true });
  if (imp.status !== 0) fail(`corpus import dry-run exit ${imp.status}: ${imp.stderr.slice(0, 300)}`);
  if (!/observations: \+\d/.test(imp.stderr)) fail(`corpus dry-run reported no observations: ${imp.stderr.slice(0, 200)}`);
  ok("corpus: full export bundled and dry-run imported into a fresh store");

  console.log("SMOKE PASS");
  exitCode = 0;
} finally {
  child.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
