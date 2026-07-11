// server/src/lib/validate.ts
//
// Semantic validity checks, separated from file access. Everything here is
// pure: it receives the JSON object a corpus parsed into, and answers whether
// the values are valid, correct, and within expected type and range — with
// field-path-accurate errors ("distros[0].index.pockets[1].base: …"), never
// a stack trace from deep inside a collector.
//
// Strictness is deliberate: unknown keys are errors (typo detection beats
// forward tolerance in an operator-authored file), except keys beginning
// with "$comment", which are documentation.

import type {
  ChangeRecord,
  Observation,
  SnapshotDoc,
  TidepoolConfig,
} from "../../../shared/types.js";

export class Ctx {
  errors: string[] = [];
  fail(path: string, msg: string): undefined {
    this.errors.push(`${path}: ${msg}`);
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ------------------------------------------------------------- primitives

export function str(
  c: Ctx,
  v: unknown,
  path: string,
  opts: { min?: number; max?: number; pattern?: RegExp; what?: string } = {}
): string | undefined {
  if (typeof v !== "string") return c.fail(path, `expected string, got ${typeof v}`);
  const { min = 1, max = 500, pattern, what } = opts;
  if (v.length < min || v.length > max) return c.fail(path, `length must be ${min}..${max}, got ${v.length}`);
  if (v.includes("\u0000")) return c.fail(path, "must not contain NUL");
  if (pattern && !pattern.test(v)) return c.fail(path, `${what ?? `must match ${pattern}`}, got ${JSON.stringify(v.slice(0, 40))}`);
  return v;
}

export function int(
  c: Ctx,
  v: unknown,
  path: string,
  opts: { min: number; max: number }
): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return c.fail(path, `expected finite number, got ${typeof v}`);
  if (!Number.isInteger(v)) return c.fail(path, `expected integer, got ${v}`);
  if (v < opts.min || v > opts.max) return c.fail(path, `must be within ${opts.min}..${opts.max}, got ${v}`);
  return v;
}

export function num(c: Ctx, v: unknown, path: string, opts: { min: number; max: number }): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return c.fail(path, `expected finite number, got ${typeof v}`);
  if (v < opts.min || v > opts.max) return c.fail(path, `must be within ${opts.min}..${opts.max}, got ${v}`);
  return v;
}

export function bool(c: Ctx, v: unknown, path: string): boolean | undefined {
  if (typeof v !== "boolean") return c.fail(path, `expected boolean, got ${typeof v}`);
  return v;
}

export function enumOf<T extends string>(c: Ctx, v: unknown, path: string, allowed: readonly T[]): T | undefined {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v))
    return c.fail(path, `must be one of ${allowed.join(", ")}, got ${JSON.stringify(v).slice(0, 40)}`);
  return v as T;
}

/** http(s) URL with a hostname — the only scheme this service ever fetches. */
export function httpUrl(c: Ctx, v: unknown, path: string): string | undefined {
  const s = str(c, v, path, { max: 500 });
  if (s === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return c.fail(path, `expected a URL, got ${JSON.stringify(s.slice(0, 60))}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return c.fail(path, `URL scheme must be http(s), got ${u.protocol}`);
  if (!u.hostname) return c.fail(path, "URL must have a hostname");
  return s;
}

export function obj(
  c: Ctx,
  v: unknown,
  path: string,
  knownKeys: readonly string[]
): Record<string, unknown> | undefined {
  if (!isObj(v)) return c.fail(path, `expected object, got ${Array.isArray(v) ? "array" : typeof v}`);
  for (const k of Object.keys(v)) {
    if (!k.startsWith("$comment") && !knownKeys.includes(k)) c.fail(`${path}.${k}`, "unknown key (typo?)");
  }
  return v;
}

export function arr(c: Ctx, v: unknown, path: string, opts: { min?: number; max?: number } = {}): unknown[] | undefined {
  if (!Array.isArray(v)) return c.fail(path, `expected array, got ${typeof v}`);
  const { min = 0, max = 100000 } = opts;
  if (v.length < min || v.length > max) return c.fail(path, `array length must be ${min}..${max}, got ${v.length}`);
  return v;
}

// ------------------------------------------------------------ shared atoms

export const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
/** package names across all ecosystems: npm scopes, maven colon, go/packagist slashes */
const PKG_NAME = /^[A-Za-z0-9@/:._+-]{1,214}$/;
const SUITE = /^[A-Za-z0-9.+_-]{1,64}$/;
const ARCH = /^[a-z0-9_]{1,32}$/;
const GH_REPO = /^[\w.-]+\/[\w.-]+$/;

const FAMILIES = ["apt", "apk", "arch"] as const;
const ECOSYSTEMS = [
  "crates-io", "pypi", "npm", "rubygems", "maven", "go", "nuget", "packagist", "hex", "pub", "cran", "conan", "vcpkg",
] as const;
const ADVISORY_KINDS = ["ubuntu-notices", "alpine-secdb", "arch-avg", "osv-on-demand", "none"] as const;
const CHANGE_KINDS = [
  "package-added", "package-removed", "version-moved", "metadata-changed",
  "advisory-published", "advisory-modified", "advisory-withdrawn",
  "source-failure", "source-recovery", "verification-transition", "signer-transition",
] as const;
const STAGES = ["observation", "churn", "interpretive"] as const;

function keyringPath(c: Ctx, v: unknown, path: string): string | undefined {
  const s = str(c, v, path, { max: 300 });
  if (s === undefined) return undefined;
  if (!s.startsWith("/")) return c.fail(path, "keyring path must be absolute");
  if (s.includes("..")) return c.fail(path, "keyring path must not contain '..'");
  return s;
}

// ------------------------------------------------------------- the config

function validateAdvisories(c: Ctx, v: unknown, path: string): void {
  const o = obj(c, v, path, ["kind", "url", "urls", "release", "pages"]);
  if (!o) return;
  enumOf(c, o.kind, `${path}.kind`, ADVISORY_KINDS);
  if (o.url !== undefined) httpUrl(c, o.url, `${path}.url`);
  if (o.urls !== undefined) arr(c, o.urls, `${path}.urls`, { max: 20 })?.forEach((u, i) => httpUrl(c, u, `${path}.urls[${i}]`));
  if (o.release !== undefined) str(c, o.release, `${path}.release`, { max: 64 });
  if (o.pages !== undefined) int(c, o.pages, `${path}.pages`, { min: 1, max: 50 });
}

function validateDistro(c: Ctx, v: unknown, path: string): void {
  const o = obj(c, v, path, ["id", "label", "codename", "family", "enabled", "index", "advisories", "osvEcosystem"]);
  if (!o) return;
  str(c, o.id, `${path}.id`, { pattern: SLUG, what: "must be a slug (lowercase letters, digits, . _ -)" });
  str(c, o.label, `${path}.label`, { max: 120 });
  if (o.codename !== undefined) str(c, o.codename, `${path}.codename`, { max: 64 });
  const family = enumOf(c, o.family, `${path}.family`, FAMILIES);
  if (o.enabled !== undefined) bool(c, o.enabled, `${path}.enabled`);
  if (o.osvEcosystem !== undefined && o.osvEcosystem !== null) str(c, o.osvEcosystem, `${path}.osvEcosystem`, { max: 64 });
  if (o.advisories !== undefined) validateAdvisories(c, o.advisories, `${path}.advisories`);

  const ip = `${path}.index`;
  if (family === "apt") {
    const idx = obj(c, o.index, ip, ["pockets", "components", "arch", "verifyDigests", "verifySignatures", "keyrings"]);
    if (!idx) return;
    arr(c, idx.pockets, `${ip}.pockets`, { min: 1, max: 20 })?.forEach((p, i) => {
      const po = obj(c, p, `${ip}.pockets[${i}]`, ["id", "base", "suite"]);
      if (!po) return;
      str(c, po.id, `${ip}.pockets[${i}].id`, { pattern: SLUG, what: "must be a slug" });
      httpUrl(c, po.base, `${ip}.pockets[${i}].base`);
      str(c, po.suite, `${ip}.pockets[${i}].suite`, { pattern: SUITE, what: "must be an apt suite name" });
    });
    arr(c, idx.components, `${ip}.components`, { min: 1, max: 10 })?.forEach((x, i) =>
      str(c, x, `${ip}.components[${i}]`, { pattern: SLUG, what: "must be a component slug" })
    );
    str(c, idx.arch, `${ip}.arch`, { pattern: ARCH, what: "must be an architecture id" });
    if (idx.verifyDigests !== undefined) bool(c, idx.verifyDigests, `${ip}.verifyDigests`);
    if (idx.verifySignatures !== undefined) bool(c, idx.verifySignatures, `${ip}.verifySignatures`);
    if (idx.keyrings !== undefined)
      arr(c, idx.keyrings, `${ip}.keyrings`, { max: 10 })?.forEach((k, i) => keyringPath(c, k, `${ip}.keyrings[${i}]`));
  } else if (family === "apk") {
    const idx = obj(c, o.index, ip, ["base", "repos", "arch"]);
    if (!idx) return;
    httpUrl(c, idx.base, `${ip}.base`);
    arr(c, idx.repos, `${ip}.repos`, { min: 1, max: 10 })?.forEach((r, i) =>
      str(c, r, `${ip}.repos[${i}]`, { pattern: SLUG, what: "must be a repo slug" })
    );
    str(c, idx.arch, `${ip}.arch`, { pattern: ARCH, what: "must be an architecture id" });
  } else if (family === "arch") {
    const idx = obj(c, o.index, ip, ["api", "repos", "maxPagesPerRepo"]);
    if (!idx) return;
    httpUrl(c, idx.api, `${ip}.api`);
    arr(c, idx.repos, `${ip}.repos`, { min: 1, max: 10 })?.forEach((r, i) =>
      str(c, r, `${ip}.repos[${i}]`, { pattern: /^[A-Za-z]{1,32}$/, what: "must be a repo name" })
    );
    if (idx.maxPagesPerRepo !== undefined) int(c, idx.maxPagesPerRepo, `${ip}.maxPagesPerRepo`, { min: 1, max: 500 });
  }
}

function validateEcosystem(c: Ctx, v: unknown, path: string): void {
  const o = obj(c, v, path, ["id", "label", "ecosystem", "enabled", "osvEcosystem", "scope"]);
  if (!o) return;
  str(c, o.id, `${path}.id`, { pattern: SLUG, what: "must be a slug" });
  str(c, o.label, `${path}.label`, { max: 120 });
  enumOf(c, o.ecosystem, `${path}.ecosystem`, ECOSYSTEMS);
  if (o.enabled !== undefined) bool(c, o.enabled, `${path}.enabled`);
  if (o.osvEcosystem !== undefined && o.osvEcosystem !== null) str(c, o.osvEcosystem, `${path}.osvEcosystem`, { max: 64 });
  const sc = obj(c, o.scope, `${path}.scope`, ["mode", "packages"]);
  if (!sc) return;
  enumOf(c, sc.mode, `${path}.scope.mode`, ["list"] as const);
  arr(c, sc.packages, `${path}.scope.packages`, { min: 1, max: 5000 })?.forEach((p, i) =>
    str(c, p, `${path}.scope.packages[${i}]`, { max: 214, pattern: PKG_NAME, what: "must be a package name" })
  );
}

/**
 * Validate the parsed config corpus: every field type-checked, range-checked,
 * URL-scheme-checked, enum-checked. Returns the typed config or the full
 * list of field errors — never a partially-trusted object.
 */
export function validateConfig(v: unknown): { config?: TidepoolConfig; errors: string[] } {
  const c = new Ctx();
  const root = obj(c, v, "config", ["server", "distros", "ecosystems", "enrichment", "packageHints"]);
  if (!root) return { errors: c.errors };

  const server = obj(c, root.server ?? {}, "config.server", ["port", "cacheDir", "indexTtlHours", "advisoryTtlHours"]);
  if (server) {
    if (server.port !== undefined) int(c, server.port, "config.server.port", { min: 1, max: 65535 });
    if (server.cacheDir !== undefined) {
      const cd = str(c, server.cacheDir, "config.server.cacheDir", { max: 200 });
      if (cd !== undefined && cd.includes("..")) c.fail("config.server.cacheDir", "must not contain '..'");
    }
    if (server.indexTtlHours !== undefined) num(c, server.indexTtlHours, "config.server.indexTtlHours", { min: 0, max: 8760 });
    if (server.advisoryTtlHours !== undefined)
      num(c, server.advisoryTtlHours, "config.server.advisoryTtlHours", { min: 0, max: 8760 });
  }

  const distros = arr(c, root.distros ?? [], "config.distros", { max: 50 });
  distros?.forEach((d, i) => validateDistro(c, d, `config.distros[${i}]`));
  const ecosystems = arr(c, root.ecosystems ?? [], "config.ecosystems", { max: 50 });
  ecosystems?.forEach((e, i) => validateEcosystem(c, e, `config.ecosystems[${i}]`));

  // duplicate unit ids are a config error, not a runtime surprise
  const seen = new Set<string>();
  for (const [i, u] of [...(distros ?? []), ...(ecosystems ?? [])].entries()) {
    const id = isObj(u) && typeof u.id === "string" ? u.id : `#${i}`;
    if (seen.has(id)) c.fail("config", `duplicate unit id: ${id}`);
    seen.add(id);
  }

  if (root.enrichment !== undefined) {
    const en = obj(c, root.enrichment, "config.enrichment", ["osv", "endoflife", "github", "githubToken"]);
    if (en) {
      for (const k of ["osv", "endoflife", "github"] as const)
        if (en[k] !== undefined) bool(c, en[k], `config.enrichment.${k}`);
      if (en.githubToken !== undefined) str(c, en.githubToken, "config.enrichment.githubToken", { min: 0, max: 200 });
    }
  }

  if (root.packageHints !== undefined) {
    if (!isObj(root.packageHints)) c.fail("config.packageHints", "expected object");
    else
      for (const [k, h] of Object.entries(root.packageHints)) {
        if (k.startsWith("$comment")) continue;
        const hp = `config.packageHints[${JSON.stringify(k)}]`;
        str(c, k, `${hp} (key)`, { max: 214, pattern: PKG_NAME, what: "must be a package name" });
        const ho = obj(c, h, hp, ["github", "eol"]);
        if (ho) {
          if (ho.github !== undefined) str(c, ho.github, `${hp}.github`, { max: 120, pattern: GH_REPO, what: "must be owner/repo" });
          if (ho.eol !== undefined) str(c, ho.eol, `${hp}.eol`, { max: 64, pattern: SLUG, what: "must be an endoflife.date slug" });
        }
      }
  }

  return c.errors.length ? { errors: c.errors } : { config: v as TidepoolConfig, errors: [] };
}

// -------------------------------------------------- stored-corpus validators

/** Structural validation of one Observation parsed from the history corpus. */
export function validateObservation(v: unknown, where: string): { obs?: Observation; errors: string[] } {
  const c = new Ctx();
  if (!isObj(v)) return { errors: [`${where}: expected object`] };
  str(c, v.id, `${where}.id`, { pattern: HEX64, what: "must be a 64-hex content address" });
  str(c, v.sourceId, `${where}.sourceId`, { max: 120 });
  num(c, v.collectedAt, `${where}.collectedAt`, { min: 0, max: 4102444800000 });
  enumOf(c, v.status, `${where}.status`, ["ok", "error"] as const);
  str(c, v.recordsDigest, `${where}.recordsDigest`, { pattern: HEX64, what: "must be a 64-hex content address" });
  int(c, v.recordCount, `${where}.recordCount`, { min: 0, max: 100000000 });
  return c.errors.length ? { errors: c.errors } : { obs: v as unknown as Observation, errors: [] };
}

/** Structural validation of one ChangeRecord parsed from the history corpus. */
export function validateChange(v: unknown, where: string): { change?: ChangeRecord; errors: string[] } {
  const c = new Ctx();
  if (!isObj(v)) return { errors: [`${where}: expected object`] };
  str(c, v.id, `${where}.id`, { pattern: HEX64, what: "must be a 64-hex content address" });
  enumOf(c, v.kind, `${where}.kind`, CHANGE_KINDS);
  str(c, v.toObservation, `${where}.toObservation`, { pattern: HEX64, what: "must reference an observation id" });
  num(c, v.detectedAt, `${where}.detectedAt`, { min: 0, max: 4102444800000 });
  return c.errors.length ? { errors: c.errors } : { change: v as unknown as ChangeRecord, errors: [] };
}

/** Structural validation of a SnapshotDoc parsed from the snapshot store. */
export function validateSnapshotDoc(v: unknown, where: string): { doc?: SnapshotDoc; errors: string[] } {
  const c = new Ctx();
  if (!isObj(v)) return { errors: [`${where}: expected object`] };
  if (v.schema !== "tidepool-snapshot-v1") c.fail(`${where}.schema`, `expected tidepool-snapshot-v1, got ${JSON.stringify(v.schema).slice(0, 40)}`);
  enumOf(c, v.stage, `${where}.stage`, STAGES);
  num(c, v.createdAt, `${where}.createdAt`, { min: 0, max: 4102444800000 });
  const w = isObj(v.window) ? v.window : c.fail(`${where}.window`, "expected object");
  if (w) {
    const from = num(c, w.from, `${where}.window.from`, { min: 0, max: 4102444800000 });
    const to = num(c, w.to, `${where}.window.to`, { min: 0, max: 4102444800000 });
    if (from !== undefined && to !== undefined && from > to) c.fail(`${where}.window`, `from (${from}) must be <= to (${to})`);
  }
  for (const k of ["coverage", "notObserved", "entities", "observations", "changes", "relationships", "findings", "ambiguities"] as const) {
    arr(c, v[k], `${where}.${k}`);
  }
  if (v.digest !== undefined) str(c, v.digest, `${where}.digest`, { pattern: HEX64, what: "must be a 64-hex content address" });
  return c.errors.length ? { errors: c.errors } : { doc: v as unknown as SnapshotDoc, errors: [] };
}
