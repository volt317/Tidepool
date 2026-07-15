// server/test/tls.test.ts — the self-managed TLS toolkit: CA + server cert
// generation, SAN coverage, key/cert match, verification, and the security
// invariant that the CA private key never lands in the proxy-mounted
// server/ directory. Skips cleanly where openssl is unavailable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initCa, inspect, issueSelfSigned, issueServerCert, opensslAvailable, tlsPaths, verifyTls, type TlsPlan } from "../src/services/tls.js";

const plan: TlsPlan = {
  serverNames: ["tidepool.home.arpa", "localhost"],
  ipAddresses: ["127.0.0.1", "192.168.10.5"],
  keyAlgorithm: "ec-p256",
  certLifetimeDays: 120,
  caLifetimeDays: 1461,
};

const hasOpenssl = opensslAvailable();
const opts = hasOpenssl ? {} : { skip: "openssl not available" };

test("local CA + server cert generate and verify", opts, () => {
  const root = mkdtempSync(join(tmpdir(), "tls-"));
  try {
    const p = tlsPaths(root);
    initCa(p, plan);
    issueServerCert(p, plan);
    assert.ok(existsSync(p.caCrt) && existsSync(p.caKey));
    assert.ok(existsSync(p.serverCrt) && existsSync(p.serverKey) && existsSync(p.chain));
    const v = verifyTls(p, plan, { expectCa: true });
    for (const c of v.checks) assert.ok(c.ok, `${c.name}: ${c.detail ?? ""}`);
    assert.equal(v.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("server key is 0600, CA key is 0600", opts, () => {
  const root = mkdtempSync(join(tmpdir(), "tls-"));
  try {
    const p = tlsPaths(root);
    initCa(p, plan);
    issueServerCert(p, plan);
    assert.equal((statSync(p.serverKey).mode & 0o777).toString(8), "600");
    assert.equal((statSync(p.caKey).mode & 0o777).toString(8), "600");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CA private key never appears in the proxy-mounted server/ dir", opts, () => {
  const root = mkdtempSync(join(tmpdir(), "tls-"));
  try {
    const p = tlsPaths(root);
    initCa(p, plan);
    issueServerCert(p, plan);
    assert.ok(!existsSync(join(root, "server", "tidepool-local-ca.key")));
    // the CA key exists, but under ca/ only
    assert.ok(existsSync(p.caKey));
    assert.ok(p.caKey.includes(`${root}/ca/`) || p.caKey.includes(`${root}\\ca\\`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("certificate SAN covers every configured name and IP", opts, () => {
  const root = mkdtempSync(join(tmpdir(), "tls-"));
  try {
    const p = tlsPaths(root);
    initCa(p, plan);
    issueServerCert(p, plan);
    const info = inspect(p) as { server?: { sans?: string } };
    const sans = info.server?.sans ?? "";
    for (const n of plan.serverNames) assert.ok(sans.includes(n), `SAN missing ${n}`);
    for (const a of plan.ipAddresses) assert.ok(sans.includes(a), `SAN missing ${a}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renewal reissues an independently verifiable cert (atomic)", opts, () => {
  const root = mkdtempSync(join(tmpdir(), "tls-"));
  try {
    const p = tlsPaths(root);
    initCa(p, plan);
    issueServerCert(p, plan);
    const before = (inspect(p) as { server?: { fingerprint?: string } }).server?.fingerprint;
    issueServerCert(p, plan); // renew
    const after = (inspect(p) as { server?: { fingerprint?: string } }).server?.fingerprint;
    assert.notEqual(before, after, "renewed cert should differ");
    assert.equal(verifyTls(p, plan, { expectCa: true }).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-signed leaf mode has no CA and still verifies key/cert match", opts, () => {
  const root = mkdtempSync(join(tmpdir(), "tls-"));
  try {
    const p = tlsPaths(root);
    issueSelfSigned(p, plan);
    assert.ok(!existsSync(p.caKey));
    const v = verifyTls(p, plan, { expectCa: false });
    assert.equal(v.checks.find((c) => c.name === "server-key-cert-match")?.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
