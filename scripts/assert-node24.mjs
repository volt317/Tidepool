#!/usr/bin/env node
// scripts/assert-node24.mjs — fail immediately if the active Node major is
// not 24. Used as an explicit CI verification step so a misconfigured
// runner (or a setup-node cache miss resolving an unexpected version) is a
// hard error, not a subtle one. The expected major is read from
// .node-version, keeping this in lockstep with the single source of truth.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const want = Number(readFileSync(join(root, ".node-version"), "utf8").trim().split(".")[0]);
const have = Number(process.versions.node.split(".")[0]);

if (!Number.isInteger(want)) {
  console.error(`assert-node24: .node-version does not specify a numeric major (got "${want}")`);
  process.exit(1);
}
if (have !== want) {
  console.error(`assert-node24: active Node is v${process.versions.node} (major ${have}); this project requires Node ${want}.`);
  console.error("CI pins the runtime via .node-version + actions/setup-node node-version-file; a mismatch means the runner did not honor it.");
  process.exit(1);
}
console.log(`assert-node24: Node ${process.versions.node} — major ${have} as required.`);
