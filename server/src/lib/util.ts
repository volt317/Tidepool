// server/src/lib/util.ts
//
// Shared machinery for the collectors. Deliberately boring and dependency-free
// (node built-ins only): fetch with timeout, gzip, sha256, a deb822 stanza
// parser, a faithful port of dpkg's version comparison (Debian versions are
// NEVER string-compared anywhere in Tidepool), a minimal ustar reader for
// Alpine's APKINDEX.tar.gz, and a disk cache with TTL.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

// ------------------------------------------------------------------ fetch

export async function timedFetch(url: string, opts: RequestInit = {}, ms = 60000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      headers: { "user-agent": "tidepool/0.1 (change-intelligence service)", ...(opts.headers || {}) },
      ...opts,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchBytes(url: string, opts?: RequestInit, ms?: number): Promise<Buffer> {
  const res = await timedFetch(url, opts, ms);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchJson<T = unknown>(url: string, opts?: RequestInit, ms?: number): Promise<T> {
  const res = await timedFetch(url, opts, ms);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json() as Promise<T>;
}

export const gunzip = (buf: Buffer): Buffer => gunzipSync(buf);
export const sha256hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

// ----------------------------------------------------------------- deb822

/** Parse deb822 text into stanzas of {field: value}; continuation lines fold. */
export function parseDeb822(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (Object.keys(cur).length) out.push(cur);
      cur = {};
      lastKey = null;
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (lastKey) cur[lastKey] += "\n" + line.trimStart();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx > 0) {
      lastKey = line.slice(0, idx).trim();
      cur[lastKey] = line.slice(idx + 1).trim();
    }
  }
  if (Object.keys(cur).length) out.push(cur);
  return out;
}

/** Extract the SHA256 table (relpath -> hex) from a clear-signed InRelease. */
export function inReleaseSha256Table(text: string): Record<string, string> {
  const table: Record<string, string> = {};
  let inTable = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("SHA256:")) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!line.startsWith(" ")) break;
      const parts = line.trim().split(/\s+/);
      if (parts.length === 3 && parts[0].length === 64) table[parts[2]] = parts[0];
    }
  }
  return table;
}

// --------------------------------------------------- dpkg version compare

const ord = (c: string): number => {
  if (c === "~") return -1;
  if (c >= "a" && c <= "z") return c.charCodeAt(0);
  if (c >= "A" && c <= "Z") return c.charCodeAt(0);
  return c.charCodeAt(0) + 256;
};
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

function cmpFragment(a: string, b: string): number {
  let i = 0, j = 0;
  for (;;) {
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const ac = i < a.length && !isDigit(a[i]) ? ord(a[i]) : 0;
      const bc = j < b.length && !isDigit(b[j]) ? ord(b[j]) : 0;
      if (ac !== bc) return ac < bc ? -1 : 1;
      if (i < a.length && !isDigit(a[i])) i++;
      if (j < b.length && !isDigit(b[j])) j++;
    }
    if (i >= a.length && j >= b.length) return 0;
    while (a[i] === "0") i++;
    while (b[j] === "0") j++;
    let ei = i, ej = j;
    while (ei < a.length && isDigit(a[ei])) ei++;
    while (ej < b.length && isDigit(b[ej])) ej++;
    const da = a.slice(i, ei), db = b.slice(j, ej);
    if (da.length !== db.length) return da.length < db.length ? -1 : 1;
    if (da !== db) return da < db ? -1 : 1;
    i = ei; j = ej;
  }
}

export function splitDebVersion(v: string): { epoch: number; upstream: string; revision: string } {
  let epoch = 0, rest = v;
  const colon = v.indexOf(":");
  if (colon >= 0) {
    epoch = parseInt(v.slice(0, colon), 10) || 0;
    rest = v.slice(colon + 1);
  }
  const dash = rest.lastIndexOf("-");
  if (dash >= 0) return { epoch, upstream: rest.slice(0, dash), revision: rest.slice(dash + 1) };
  return { epoch, upstream: rest, revision: "0" };
}

/** Full dpkg comparison: -1 | 0 | 1. */
export function debCompare(a: string, b: string): number {
  const A = splitDebVersion(a), B = splitDebVersion(b);
  if (A.epoch !== B.epoch) return A.epoch < B.epoch ? -1 : 1;
  const up = cmpFragment(A.upstream, B.upstream);
  if (up !== 0) return up;
  return cmpFragment(A.revision, B.revision);
}

// -------------------------------------------------------------- tar (ustar)

/** Walk a tar buffer, returning [{name, data}] for regular files. */
export function tarEntries(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.subarray(off, off + 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break; // two zero blocks end the archive
    const size = parseInt(buf.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    const type = buf[off + 156];
    const dataStart = off + 512;
    if (type === 0 || type === 48 /* '0' */) {
      out.push({ name, data: buf.subarray(dataStart, dataStart + size) });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ------------------------------------------------------------------ cache

export interface CacheEnvelope<T> { savedAt: number; data: T }

export class DiskCache {
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  path(key: string): string {
    return join(this.dir, key.replace(/[^a-zA-Z0-9._-]+/g, "_") + ".json");
  }
  /** Returns {savedAt, data} or null if missing/expired. */
  get<T>(key: string, ttlMs: number | null): CacheEnvelope<T> | null {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    try {
      const wrapped = JSON.parse(readFileSync(p, "utf8")) as CacheEnvelope<T>;
      if (ttlMs != null && Date.now() - wrapped.savedAt > ttlMs) return null;
      return wrapped;
    } catch {
      return null;
    }
  }
  set<T>(key: string, data: T): void {
    const p = this.path(key);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), data }));
    renameSync(tmp, p); // write-then-rename: never a torn cache file
  }
}
