// server/src/lib/versions.ts
//
// Native version semantics per ecosystem. Every provider's ordering claims
// come from the ecosystem's own rules — Debian comparison is never silently
// applied to unrelated ecosystems. Where no native ordering is implemented,
// the adapter says so ("ordering: unsupported") instead of approximating.

import { debCompare } from "./util.js";

export interface EcosystemAdapter {
  /** which ordering these results carry */
  ordering: "native" | "unsupported";
  strategy: string;
  compareVersions(a: string, b: string): number;
  canonicalizeVersion?(version: string): string;
}

// ------------------------------------------------------------------ semver

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function semverCompare(a: string, b: string): number {
  const ma = SEMVER.exec(a.trim());
  const mb = SEMVER.exec(b.trim());
  if (!ma || !mb) return a === b ? 0 : a < b ? -1 : 1; // non-semver strings: stable but weak
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined && pb === undefined) return 0;
  if (pa === undefined) return 1; // release > pre-release
  if (pb === undefined) return -1;
  const as = pa.split(".");
  const bs = pb.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (nx) return -1; // numeric identifiers sort before alphanumeric
    else if (ny) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// --------------------------------------------------------------- alpine apk
// version ::= number{.number}letter?{_suffix{number}}{~hash}{-r#}
const APK_SUFFIX_ORDER: Record<string, number> = { alpha: -4, beta: -3, pre: -2, rc: -1, "": 0, cvs: 1, svn: 2, git: 3, hg: 4, p: 5 };

function apkCompare(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+(?:\.\d+)*)([a-z])?((?:_[a-z]+\d*)*)(?:-r(\d+))?$/.exec(v.trim());
    if (!m) return null;
    return {
      nums: m[1].split(".").map(Number),
      letter: m[2] ?? "",
      suffixes: (m[3] ?? "").split("_").filter(Boolean).map((s) => {
        const sm = /^([a-z]+)(\d*)$/.exec(s);
        return { name: sm?.[1] ?? s, n: sm?.[2] ? Number(sm[2]) : 0 };
      }),
      rel: m[4] ? Number(m[4]) : 0,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (pa.letter !== pb.letter) return pa.letter < pb.letter ? -1 : 1;
  for (let i = 0; i < Math.max(pa.suffixes.length, pb.suffixes.length); i++) {
    const sa = pa.suffixes[i];
    const sb = pb.suffixes[i];
    const ra = sa ? (APK_SUFFIX_ORDER[sa.name] ?? 0) : 0;
    const rb = sb ? (APK_SUFFIX_ORDER[sb.name] ?? 0) : 0;
    if (ra !== rb) return Math.sign(ra - rb);
    const d = (sa?.n ?? 0) - (sb?.n ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return Math.sign(pa.rel - pb.rel);
}

// ------------------------------------------------------------- pacman/arch
// epoch:version-pkgrel with rpm-style alphanumeric segment comparison —
// dpkg's algorithm minus tilde semantics is close enough that we implement
// pacman's own rules directly here
function pacmanCompare(a: string, b: string): number {
  const split = (v: string) => {
    const em = /^(?:(\d+):)?(.*?)(?:-(\d+(?:\.\d+)?))?$/.exec(v.trim());
    return { epoch: em?.[1] ? Number(em[1]) : 0, ver: em?.[2] ?? v, rel: em?.[3] ?? null };
  };
  const seg = (x: string, y: string): number => {
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      while (i < x.length && !/[a-zA-Z0-9]/.test(x[i])) i++;
      while (j < y.length && !/[a-zA-Z0-9]/.test(y[j])) j++;
      if (i >= x.length || j >= y.length) break;
      const xs = i;
      const ys = j;
      const numeric = /\d/.test(x[i]);
      if (numeric !== /\d/.test(y[j])) return numeric ? 1 : -1; // numeric beats alpha
      const re = numeric ? /\d/ : /[a-zA-Z]/;
      while (i < x.length && re.test(x[i])) i++;
      while (j < y.length && re.test(y[j])) j++;
      const sx = x.slice(xs, i);
      const sy = y.slice(ys, j);
      if (numeric) {
        const d = Number(sx.replace(/^0+/, "") || "0") - Number(sy.replace(/^0+/, "") || "0");
        if (d !== 0) return Math.sign(d);
      } else if (sx !== sy) return sx < sy ? -1 : 1;
    }
    return Math.sign((x.length - i) - (y.length - j)) * (i >= x.length && j >= y.length ? 0 : 1) || (x.length - i > 0 ? 1 : y.length - j > 0 ? -1 : 0);
  };
  const pa = split(a);
  const pb = split(b);
  if (pa.epoch !== pb.epoch) return Math.sign(pa.epoch - pb.epoch);
  const v = seg(pa.ver, pb.ver);
  if (v !== 0) return v;
  if (pa.rel !== null && pb.rel !== null) return Math.sign(Number(pa.rel) - Number(pb.rel));
  return 0;
}

// ----------------------------------------------------------------- pep 440
// core grammar: [N!]N(.N)*[{a|b|rc}N][.postN][.devN] — local versions and
// exotic spellings are out of scope; unparseable inputs compare weakly
function pep440Compare(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?$/.exec(v.trim().toLowerCase());
    if (!m) return null;
    return {
      epoch: m[1] ? Number(m[1]) : 0,
      release: m[2].split(".").map(Number),
      pre: m[3] ? [{ a: 0, b: 1, rc: 2 }[m[3]] ?? 0, Number(m[4])] : null,
      post: m[5] !== undefined ? Number(m[5]) : null,
      dev: m[6] !== undefined ? Number(m[6]) : null,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  if (pa.epoch !== pb.epoch) return Math.sign(pa.epoch - pb.epoch);
  for (let i = 0; i < Math.max(pa.release.length, pb.release.length); i++) {
    const d = (pa.release[i] ?? 0) - (pb.release[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  const rank = (p: ReturnType<typeof parse>) =>
    p!.dev !== null && p!.pre === null && p!.post === null ? -2 : p!.pre ? -1 : p!.post !== null ? 1 : 0;
  const ra = rank(pa);
  const rb = rank(pb);
  if (ra !== rb) return Math.sign(ra - rb);
  if (pa.pre && pb.pre) {
    if (pa.pre[0] !== pb.pre[0]) return Math.sign(pa.pre[0] - pb.pre[0]);
    if (pa.pre[1] !== pb.pre[1]) return Math.sign(pa.pre[1] - pb.pre[1]);
  }
  if (pa.post !== null && pb.post !== null && pa.post !== pb.post) return Math.sign(pa.post - pb.post);
  if (pa.dev !== null && pb.dev !== null && pa.dev !== pb.dev) return Math.sign(pa.dev - pb.dev);
  return 0;
}

// ------------------------------------------------------------ dotted numeric
function dottedCompare(a: string, b: string): number {
  const as = a.trim().split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const bs = b.trim().split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i] ?? 0;
    const y = bs[i] ?? 0;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return Math.sign(x - y);
    } else if (String(x) !== String(y)) return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

// ----------------------------------------------------------------- registry

const native = (strategy: string, cmp: (a: string, b: string) => number, canon?: (v: string) => string): EcosystemAdapter => ({
  ordering: "native",
  strategy,
  compareVersions: cmp,
  canonicalizeVersion: canon,
});

const unsupported = (strategy: string): EcosystemAdapter => ({
  ordering: "unsupported",
  strategy,
  // stable, but explicitly NOT an ordering claim — callers must check `ordering`
  compareVersions: (a, b) => (a === b ? 0 : a < b ? -1 : 1),
});

const ADAPTERS: Record<string, EcosystemAdapter> = {
  // distro families
  apt: native("dpkg", debCompare),
  apk: native("apk", apkCompare),
  arch: native("pacman-vercmp", pacmanCompare),
  // code ecosystems
  npm: native("semver", semverCompare),
  "crates-io": native("semver", semverCompare),
  hex: native("semver", semverCompare),
  pub: native("semver", semverCompare),
  go: native("semver", semverCompare, (v) => v.replace(/^v/, "")),
  nuget: native("semver", semverCompare),
  packagist: native("semver", semverCompare, (v) => v.replace(/^v/, "")),
  pypi: native("pep440-core", pep440Compare),
  cran: native("dotted-numeric", dottedCompare),
  rubygems: unsupported("gem-version (not implemented)"),
  maven: unsupported("maven ComparableVersion (not implemented)"),
  conan: unsupported("scheme varies per recipe"),
  vcpkg: unsupported("scheme varies per port (version/semver/date/string)"),
};

/** the adapter for a unit kind (distro family or code ecosystem) */
export function adapterFor(kind: string): EcosystemAdapter {
  return ADAPTERS[kind] ?? unsupported(`unknown ecosystem ${kind}`);
}

/**
 * The newest of a set of versions under the ecosystem's native ordering, or
 * an honest refusal: when ordering is unsupported, `newest` is only reported
 * if all candidates agree.
 */
export function newestOf(kind: string, versions: string[]): { newest: string | null; ordering: "native" | "unsupported" } {
  const a = adapterFor(kind);
  if (versions.length === 0) return { newest: null, ordering: a.ordering };
  const canon = (v: string) => (a.canonicalizeVersion ? a.canonicalizeVersion(v) : v);
  if (a.ordering === "unsupported") {
    const uniq = new Set(versions.map(canon));
    return { newest: uniq.size === 1 ? versions[0] : null, ordering: "unsupported" };
  }
  let best = versions[0];
  for (const v of versions.slice(1)) if (a.compareVersions(canon(v), canon(best)) > 0) best = v;
  return { newest: best, ordering: "native" };
}
