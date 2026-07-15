#!/usr/bin/env node
// scripts/generate-deploy-config.mjs
//
// Bakes deploy/deploy.yaml into TypeScript at COMPILATION time.
//
//   deploy/deploy.yaml ──(this script, before tsc)──▶ shared/deployConfig.generated.ts
//
// The services never read deploy.yaml at runtime: the values are static
// consts in the compiled JavaScript, imported like any other module. The
// generated file is COMMITTED so `tsx` dev runs, tests, and typechecks work
// without a generation step; `npm run build:server` regenerates it, and
// `--check` (run in CI) fails when the committed file has drifted from the
// YAML.
//
// Parsing matches deploy/scripts/lib/deploy-config.sh exactly — the same
// flat `key: value` subset (comments stripped at the first '#', flat
// snake_case keys, optional quotes, no nesting/lists) — so the shell and
// TypeScript consumers can never disagree about what the file says.
//
// Determinism: keys are emitted sorted, values via JSON.stringify, one
// fixed header — regenerating from an unchanged YAML is always a no-op
// diff.
//
// Usage:
//   node scripts/generate-deploy-config.mjs           # (re)generate
//   node scripts/generate-deploy-config.mjs --check   # exit 1 on drift

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "deploy", "deploy.yaml");
const OUT = join(ROOT, "shared", "deployConfig.generated.ts");

const entries = [];
for (const raw of readFileSync(SRC, "utf8").split("\n")) {
  const line = raw.split("#")[0]; // comment strip — same rule as the shell lib
  const m = /^([a-z_]+)\s*:\s*(.+?)\s*$/.exec(line);
  if (!m) continue;
  const key = m[1];
  const val = m[2].replace(/^["']|["']$/g, "");
  if (val === "") continue;
  const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  entries.push({ camel, key, value: /^\d+$/.test(val) ? Number(val) : val });
}
entries.sort((a, b) => a.camel.localeCompare(b.camel));

if (entries.length === 0) {
  console.error(`generate-deploy-config: no entries parsed from ${SRC} — refusing to emit an empty module`);
  process.exit(1);
}

const body = entries
  .map((e) => `  /** deploy.yaml: ${e.key} */\n  ${e.camel}: ${typeof e.value === "number" ? e.value : JSON.stringify(e.value)},`)
  .join("\n");

const generated = `// GENERATED FILE — DO NOT EDIT.
//
// Source of truth: deploy/deploy.yaml (the single location for build/deploy
// configurables). Regenerate with \`npm run generate:deploy-config\`;
// \`npm run build:server\` does so automatically, and CI fails on drift.
//
// These values are baked at COMPILATION: the compiled JavaScript carries
// them as static consts and never reads deploy.yaml at runtime.

export const DEPLOY_CONFIG = {
${body}
} as const;
`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing counts as drift */
  }
  if (current !== generated) {
    console.error(`generate-deploy-config: ${relative(ROOT, OUT)} is out of sync with deploy/deploy.yaml`);
    console.error("run: npm run generate:deploy-config  — and commit the result");
    process.exit(1);
  }
  console.log(`generate-deploy-config: ${relative(ROOT, OUT)} is in sync`);
} else {
  writeFileSync(OUT, generated);
  console.log(`generate-deploy-config: wrote ${relative(ROOT, OUT)} (${entries.length} values)`);
}
