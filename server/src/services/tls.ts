// server/src/services/tls.ts
//
// Self-managed TLS for the appliance: a Tidepool-owned local CA and short-
// lived server certificates, generated with openssl (Node's crypto cannot
// mint X.509). Host-side only — the CA PRIVATE KEY never enters a container;
// the proxy receives server cert + key + chain and nothing else.
//
// Layout (under $TIDEPOOL_HOME/tls):
//   ca/tidepool-local-ca.crt   ca/tidepool-local-ca.key (0600)
//   server/tidepool.crt  server/tidepool.key (0600)  server/tidepool-chain.crt
//   metadata.json  (fingerprints, expiry, SANs, algorithm)
//
// Modes: generated-local-ca (default), generated-self-signed, provided,
// disabled. This module implements generation/inspection/renewal/verify;
// the CLI (cli/tls.ts) is the thin command surface over it.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type KeyAlgorithm = "ec-p256" | "ed25519" | "rsa-3072";

export interface TlsPaths {
  root: string;
  caCrt: string;
  caKey: string;
  serverCrt: string;
  serverKey: string;
  chain: string;
  metadata: string;
}

export interface TlsPlan {
  serverNames: string[];
  ipAddresses: string[];
  keyAlgorithm: KeyAlgorithm;
  certLifetimeDays: number;
  caLifetimeDays: number;
}

export function tlsPaths(tlsRoot: string): TlsPaths {
  return {
    root: tlsRoot,
    caCrt: join(tlsRoot, "ca", "tidepool-local-ca.crt"),
    caKey: join(tlsRoot, "ca", "tidepool-local-ca.key"),
    serverCrt: join(tlsRoot, "server", "tidepool.crt"),
    serverKey: join(tlsRoot, "server", "tidepool.key"),
    chain: join(tlsRoot, "server", "tidepool-chain.crt"),
    metadata: join(tlsRoot, "metadata.json"),
  };
}

function ossl(args: string[], opts: { input?: string } = {}): string {
  return execFileSync("openssl", args, { encoding: "utf8", input: opts.input, stdio: ["pipe", "pipe", "pipe"] });
}

/** Emit a keypair in the requested algorithm to `path` (0600). */
function genKey(path: string, algo: KeyAlgorithm): void {
  if (algo === "ed25519") ossl(["genpkey", "-algorithm", "ED25519", "-out", path]);
  else if (algo === "rsa-3072") ossl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", path]);
  else ossl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", path]);
  chmodSync(path, 0o600);
}

/** Build an openssl SAN/extension config for a leaf certificate. */
function leafExtConf(plan: TlsPlan): string {
  const alt: string[] = [];
  let dns = 0, ip = 0;
  for (const n of plan.serverNames) alt.push(`DNS.${++dns} = ${n}`);
  for (const a of plan.ipAddresses) alt.push(`IP.${++ip} = ${a}`);
  return [
    "[req]",
    "distinguished_name = dn",
    "[dn]",
    "[v3_leaf]",
    "basicConstraints = critical, CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "subjectAltName = @alt",
    "[alt]",
    ...alt,
  ].join("\n");
}

function fingerprint(certPath: string): string {
  const out = ossl(["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"]);
  return out.split("=")[1]?.trim() ?? "";
}

function notAfter(certPath: string): string {
  return ossl(["x509", "-in", certPath, "-noout", "-enddate"]).split("=")[1]?.trim() ?? "";
}

export interface TlsMetadata {
  createdAt: string;
  mode: string;
  keyAlgorithm: KeyAlgorithm;
  serverNames: string[];
  ipAddresses: string[];
  caFingerprint?: string;
  caNotAfter?: string;
  serverFingerprint: string;
  serverNotAfter: string;
}

function writeMetadata(paths: TlsPaths, mode: string, plan: TlsPlan, withCa: boolean): TlsMetadata {
  const meta: TlsMetadata = {
    createdAt: new Date().toISOString(),
    mode,
    keyAlgorithm: plan.keyAlgorithm,
    serverNames: plan.serverNames,
    ipAddresses: plan.ipAddresses,
    caFingerprint: withCa ? fingerprint(paths.caCrt) : undefined,
    caNotAfter: withCa ? notAfter(paths.caCrt) : undefined,
    serverFingerprint: fingerprint(paths.serverCrt),
    serverNotAfter: notAfter(paths.serverCrt),
  };
  writeFileSync(paths.metadata, JSON.stringify(meta, null, 2));
  chmodSync(paths.metadata, 0o644);
  return meta;
}

/** Create the local CA if absent (idempotent unless force). */
export function initCa(paths: TlsPaths, plan: TlsPlan, force = false): void {
  mkdirSync(join(paths.root, "ca"), { recursive: true });
  chmodSync(paths.root, 0o700);
  if (existsSync(paths.caKey) && !force) return;
  genKey(paths.caKey, plan.keyAlgorithm);
  ossl([
    "req", "-x509", "-new", "-key", paths.caKey, "-sha256",
    "-days", String(plan.caLifetimeDays),
    "-subj", "/CN=Tidepool Local CA/O=Tidepool Appliance",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-out", paths.caCrt,
  ]);
  chmodSync(paths.caCrt, 0o644);
}

/** Issue (or reissue) the server certificate from the CA. Writes to temp
 *  files then atomically renames — safe to call for renewal while running. */
export function issueServerCert(paths: TlsPaths, plan: TlsPlan): void {
  mkdirSync(join(paths.root, "server"), { recursive: true });
  const tmpKey = paths.serverKey + ".tmp";
  const tmpCrt = paths.serverCrt + ".tmp";
  const tmpChain = paths.chain + ".tmp";
  const csr = join(paths.root, "server", ".csr.tmp");
  const conf = join(paths.root, "server", ".ext.tmp");
  try {
    writeFileSync(conf, leafExtConf(plan));
    genKey(tmpKey, plan.keyAlgorithm);
    const cn = plan.serverNames[0] ?? plan.ipAddresses[0] ?? "tidepool.local";
    ossl(["req", "-new", "-key", tmpKey, "-subj", `/CN=${cn}/O=Tidepool Appliance`, "-config", conf, "-out", csr]);
    ossl([
      "x509", "-req", "-in", csr, "-CA", paths.caCrt, "-CAkey", paths.caKey, "-CAcreateserial",
      "-days", String(plan.certLifetimeDays), "-sha256",
      "-extfile", conf, "-extensions", "v3_leaf", "-out", tmpCrt,
    ]);
    // chain = leaf + CA
    writeFileSync(tmpChain, readFileSync(tmpCrt, "utf8") + readFileSync(paths.caCrt, "utf8"));
    chmodSync(tmpCrt, 0o644);
    chmodSync(tmpChain, 0o644);
    // atomic swap
    renameSync(tmpKey, paths.serverKey);
    renameSync(tmpCrt, paths.serverCrt);
    renameSync(tmpChain, paths.chain);
    writeMetadata(paths, "generated-local-ca", plan, true);
  } finally {
    for (const f of [csr, conf, tmpKey, tmpCrt, tmpChain]) rmSync(f, { force: true });
  }
}

/** Self-signed leaf mode: no CA, the leaf signs itself. */
export function issueSelfSigned(paths: TlsPaths, plan: TlsPlan): void {
  mkdirSync(join(paths.root, "server"), { recursive: true });
  const conf = join(paths.root, "server", ".ext.tmp");
  const tmpKey = paths.serverKey + ".tmp";
  const tmpCrt = paths.serverCrt + ".tmp";
  try {
    writeFileSync(conf, leafExtConf(plan));
    genKey(tmpKey, plan.keyAlgorithm);
    const cn = plan.serverNames[0] ?? plan.ipAddresses[0] ?? "tidepool.local";
    ossl([
      "req", "-x509", "-new", "-key", tmpKey, "-sha256", "-days", String(plan.certLifetimeDays),
      "-subj", `/CN=${cn}/O=Tidepool Appliance`, "-config", conf, "-extensions", "v3_leaf", "-out", tmpCrt,
    ]);
    chmodSync(tmpCrt, 0o644);
    renameSync(tmpKey, paths.serverKey);
    renameSync(tmpCrt, paths.serverCrt);
    writeFileSync(paths.chain, readFileSync(paths.serverCrt, "utf8"));
    chmodSync(paths.chain, 0o644);
    writeMetadata(paths, "generated-self-signed", plan, false);
  } finally {
    for (const f of [conf, tmpKey, tmpCrt]) rmSync(f, { force: true });
  }
}

export interface VerifyResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

function pubkeyOf(kind: "cert" | "key", path: string): string {
  return kind === "cert"
    ? ossl(["x509", "-in", path, "-noout", "-pubkey"])
    : ossl(["pkey", "-in", path, "-pubout"]);
}

/** Independent verification: key/cert match, chain, SAN coverage, expiry,
 *  permissions, and (defense in depth) that no CA key sits in server/. */
export function verifyTls(paths: TlsPaths, plan: TlsPlan, opts: { expectCa: boolean } = { expectCa: true }): VerifyResult {
  const checks: VerifyResult["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  try {
    add("server-key-cert-match", pubkeyOf("key", paths.serverKey).trim() === pubkeyOf("cert", paths.serverCrt).trim());
  } catch (e) {
    add("server-key-cert-match", false, String(e instanceof Error ? e.message : e));
  }

  if (opts.expectCa) {
    try {
      ossl(["verify", "-CAfile", paths.caCrt, paths.serverCrt]);
      add("chain-verifies-to-ca", true);
    } catch (e) {
      add("chain-verifies-to-ca", false, String(e instanceof Error ? e.message : e));
    }
  }

  try {
    const text = ossl(["x509", "-in", paths.serverCrt, "-noout", "-text"]);
    const sanOk = plan.serverNames.every((n) => text.includes(`DNS:${n}`)) && plan.ipAddresses.every((a) => text.includes(`IP Address:${a}`));
    add("san-covers-configured-names", sanOk, sanOk ? undefined : "certificate SAN missing a configured name/IP");
  } catch (e) {
    add("san-covers-configured-names", false, String(e instanceof Error ? e.message : e));
  }

  try {
    ossl(["x509", "-in", paths.serverCrt, "-noout", "-checkend", "0"]);
    add("not-expired", true);
  } catch {
    add("not-expired", false, "server certificate has expired");
  }

  // permission checks
  const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
  try {
    add("server-key-perms-0600", mode(paths.serverKey) === "600", `mode=${mode(paths.serverKey)}`);
  } catch (e) {
    add("server-key-perms-0600", false, String(e instanceof Error ? e.message : e));
  }
  if (opts.expectCa && existsSync(paths.caKey)) {
    add("ca-key-perms-0600", mode(paths.caKey) === "600", `mode=${mode(paths.caKey)}`);
    // the CA key must NOT live under server/ (which is what the proxy mounts)
    add("ca-key-not-in-server-dir", !existsSync(join(paths.root, "server", "tidepool-local-ca.key")));
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function inspect(paths: TlsPaths): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (existsSync(paths.serverCrt)) {
    out.server = {
      subject: ossl(["x509", "-in", paths.serverCrt, "-noout", "-subject"]).trim(),
      issuer: ossl(["x509", "-in", paths.serverCrt, "-noout", "-issuer"]).trim(),
      serial: ossl(["x509", "-in", paths.serverCrt, "-noout", "-serial"]).trim(),
      fingerprint: fingerprint(paths.serverCrt),
      notAfter: notAfter(paths.serverCrt),
      sans: ossl(["x509", "-in", paths.serverCrt, "-noout", "-ext", "subjectAltName"]).trim(),
    };
  }
  if (existsSync(paths.caCrt)) {
    out.ca = { fingerprint: fingerprint(paths.caCrt), notAfter: notAfter(paths.caCrt) };
  }
  if (existsSync(paths.metadata)) out.metadata = JSON.parse(readFileSync(paths.metadata, "utf8"));
  return out;
}

export function opensslAvailable(): boolean {
  try {
    ossl(["version"]);
    return true;
  } catch {
    return false;
  }
}
