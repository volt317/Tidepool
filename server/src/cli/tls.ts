// server/src/cli/tls.ts
//
// The TLS administrative CLI: init / inspect / renew / export-ca / verify.
// A thin command surface over services/tls.ts. Runs host-side as the
// appliance user (never as root — the loader guard applies), operates on
// $TIDEPOOL_HOME/tls, and never exposes the CA private key through any
// command (export-ca emits only the CA certificate).
//
//   npm run tls init         create CA (if absent) + server cert
//   npm run tls inspect      subject/issuer/SAN/serial/fingerprint/expiry
//   npm run tls renew        reissue the server cert (atomic swap)
//   npm run tls export-ca    print the CA certificate (for client trust)
//   npm run tls verify       key/cert match, chain, SAN, expiry, perms

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, resolveDirs } from "../services/bootstrap.js";
import { initCa, inspect, issueSelfSigned, issueServerCert, opensslAvailable, tlsPaths, verifyTls, type KeyAlgorithm, type TlsPlan } from "../services/tls.js";

function planFrom(config: ReturnType<typeof loadConfig>["config"]): { plan: TlsPlan; mode: string } {
  const tls = config?.http?.tls ?? {};
  const plan: TlsPlan = {
    serverNames: tls.serverNames ?? ["localhost"],
    ipAddresses: tls.ipAddresses ?? ["127.0.0.1"],
    keyAlgorithm: (tls.keyAlgorithm ?? "ec-p256") as KeyAlgorithm,
    certLifetimeDays: tls.certLifetimeDays ?? 120,
    caLifetimeDays: 365 * 4,
  };
  return { plan, mode: tls.mode ?? "generated-local-ca" };
}

function main(): void {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error("usage: tls <init|inspect|renew|export-ca|verify>");
    process.exit(2);
  }
  if (!opensslAvailable()) {
    console.error("tls: openssl is not available on PATH — required for certificate operations");
    process.exit(1);
  }
  const { config, errors } = loadConfig();
  if (!config) {
    console.error("tidepool.config.json failed validation:", errors);
    process.exit(1);
  }
  const { dataDir } = resolveDirs(config);
  const paths = tlsPaths(join(dataDir, "tls"));
  const { plan, mode } = planFrom(config);

  switch (cmd) {
    case "init": {
      const force = process.argv.includes("--force");
      if ((existsSync(paths.serverKey) || existsSync(paths.caKey)) && !force) {
        console.error("tls: key material already exists — pass --force to overwrite (this invalidates issued certs and client trust)");
        process.exit(1);
      }
      if (mode === "generated-self-signed") {
        issueSelfSigned(paths, plan);
        console.log("tls: self-signed server certificate created");
      } else {
        initCa(paths, plan, force);
        issueServerCert(paths, plan);
        const meta = inspect(paths);
        console.log("tls: local CA + server certificate created");
        console.log("CA fingerprint:", (meta.ca as { fingerprint?: string })?.fingerprint ?? "?");
        console.log("install the CA on LAN clients with:  npm run tls export-ca > tidepool-ca.crt");
      }
      break;
    }
    case "inspect":
      console.log(JSON.stringify(inspect(paths), null, 2));
      break;
    case "renew": {
      if (mode === "generated-self-signed") issueSelfSigned(paths, plan);
      else {
        if (!existsSync(paths.caKey)) {
          console.error("tls: no CA present — run `tls init` first");
          process.exit(1);
        }
        issueServerCert(paths, plan);
      }
      const v = verifyTls(paths, plan, { expectCa: mode !== "generated-self-signed" });
      console.log(JSON.stringify({ renewed: true, verified: v.ok, checks: v.checks }, null, 2));
      console.log("reload the proxy to pick up the new certificate: systemctl --user restart tidepool-proxy");
      if (!v.ok) process.exit(1);
      break;
    }
    case "export-ca": {
      if (!existsSync(paths.caCrt)) {
        console.error("tls: no CA certificate (self-signed mode, or not initialized)");
        process.exit(1);
      }
      process.stdout.write(readFileSync(paths.caCrt, "utf8")); // certificate ONLY, never the key
      break;
    }
    case "verify": {
      const v = verifyTls(paths, plan, { expectCa: mode !== "generated-self-signed" });
      console.log(JSON.stringify(v, null, 2));
      if (!v.ok) process.exit(1);
      break;
    }
    default:
      console.error(`tls: unknown command ${cmd}`);
      process.exit(2);
  }
}

main();
