#!/usr/bin/env node
// scripts/assert-scripts-present.mjs — fail with a clear message if any
// npm script named on the command line is absent from package.json.
//
// Guards against the confusing npm "Missing script" error when a workflow
// references a script the committed manifest doesn't define (e.g. a
// workflow and a package.json script added in different commits). Run as a
// CI preflight: `node scripts/assert-scripts-present.mjs check:deploy-config check:locks`
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const have = new Set(Object.keys(pkg.scripts ?? {}));
const want = process.argv.slice(2);

const missing = want.filter((s) => !have.has(s));
if (missing.length > 0) {
  console.error(`assert-scripts-present: package.json is missing script(s): ${missing.join(", ")}`);
  console.error(`declared scripts: ${[...have].sort().join(", ")}`);
  console.error("this usually means a workflow and package.json drifted across commits — add the script and commit.");
  process.exit(1);
}
console.log(`assert-scripts-present: all required scripts present (${want.join(", ")}).`);
