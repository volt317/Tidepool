// server/test/util.test.ts — the parsing and comparison bedrock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  debCompare,
  splitDebVersion,
  parseDeb822,
  inReleaseSha256Table,
  tarEntries,
  sha256hex,
  DiskCache,
} from "../src/lib/util.js";

test("debCompare orders like dpkg", () => {
  // cases validated against real dpkg --compare-versions during development
  const lt: [string, string][] = [
    ["1.0", "1.1"],
    ["1.0", "1.0.1"],
    ["2.9", "2.10"], // numeric fragments compare numerically
    ["1.0~rc1", "1.0"], // tilde sorts before everything, even empty
    ["1.0~~", "1.0~"],
    ["1.0", "1:0.5"], // epoch dominates
    ["1.0-1", "1.0-2"], // revision breaks ties
    ["1.0-1ubuntu1", "1.0-1ubuntu2"],
    ["3.0.13-0ubuntu3", "3.0.13-0ubuntu3.11"], // the live openssl case
    ["1.0a", "1.0b"],
    ["1.0", "1.0+git1"],
  ];
  for (const [a, b] of lt) {
    assert.ok(debCompare(a, b) < 0, `${a} < ${b}`);
    assert.ok(debCompare(b, a) > 0, `${b} > ${a}`);
  }
  for (const v of ["1.0", "1:2.3-4", "1.0~rc1", "0"]) assert.equal(debCompare(v, v), 0, `${v} == ${v}`);
});

test("debCompare never falls back to string order", () => {
  assert.ok(debCompare("10.0", "9.0") > 0, "10.0 > 9.0 numerically");
  assert.ok(debCompare("1.10", "1.9") > 0, "1.10 > 1.9");
});

test("splitDebVersion extracts epoch, upstream, revision", () => {
  assert.deepEqual(splitDebVersion("1:2.3.4-5ubuntu6"), { epoch: 1, upstream: "2.3.4", revision: "5ubuntu6" });
  // dpkg semantics: an absent revision is "0", not empty — 1.0 == 1.0-0
  assert.deepEqual(splitDebVersion("2.3.4"), { epoch: 0, upstream: "2.3.4", revision: "0" });
  // only the LAST hyphen separates the revision
  assert.deepEqual(splitDebVersion("1.0-rc1-2"), { epoch: 0, upstream: "1.0-rc1", revision: "2" });
});

test("parseDeb822 handles stanzas, continuations, and blank separation", () => {
  const text = [
    "Package: alpha",
    "Version: 1.0",
    "Description: first line",
    " continued second line",
    " .",
    " after blank marker",
    "",
    "Package: beta",
    "Version: 2.0",
    "",
    "",
  ].join("\n");
  const stanzas = parseDeb822(text);
  assert.equal(stanzas.length, 2);
  assert.equal(stanzas[0].Package, "alpha");
  assert.ok(stanzas[0].Description.includes("continued second line"), "continuation folded in");
  assert.equal(stanzas[1].Package, "beta");
  assert.equal(stanzas[1].Version, "2.0");
});

test("inReleaseSha256Table maps paths to digests from the SHA256 section only", () => {
  const doc = [
    "Origin: Ubuntu",
    "MD5Sum:",
    " deadbeef 100 main/binary-amd64/Packages.gz",
    "SHA256:",
    " " + "a".repeat(64) + " 12345 main/binary-amd64/Packages.gz",
    " " + "b".repeat(64) + " 678 universe/binary-amd64/Packages.gz",
  ].join("\n");
  const table = inReleaseSha256Table(doc);
  assert.equal(table["main/binary-amd64/Packages.gz"], "a".repeat(64));
  assert.equal(table["universe/binary-amd64/Packages.gz"], "b".repeat(64));
  assert.equal(Object.keys(table).length, 2, "MD5 section not absorbed");
});

test("tarEntries reads a well-formed ustar stream", () => {
  // build a minimal ustar archive by hand and read it back
  const mk = (name: string, data: Buffer): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, 8, "utf8");
    h.write("0000000\0", 108, 8, "utf8");
    h.write("0000000\0", 116, 8, "utf8");
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
    h.write("00000000000\0", 136, 12, "utf8");
    h.write("        ", 148, 8, "utf8");
    h[156] = 0x30;
    h.write("ustar\0", 257, 6, "utf8");
    h.write("00", 263, 2, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
    const pad = (512 - (data.length % 512)) % 512;
    return Buffer.concat([h, data, Buffer.alloc(pad)]);
  };
  const tar = Buffer.concat([mk("a.txt", Buffer.from("hello")), mk("b/c.json", Buffer.from("{}")), Buffer.alloc(1024)]);
  const entries = tarEntries(tar);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "a.txt");
  assert.equal(entries[0].data.toString(), "hello");
  assert.equal(entries[1].name, "b/c.json");
});

test("sha256hex matches a known vector", () => {
  assert.equal(sha256hex(Buffer.from("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("DiskCache round-trips and honors TTL semantics", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-cache-"));
  try {
    const cache = new DiskCache(dir);
    cache.set("k", { n: 42 });
    const hit = cache.get<{ n: number }>("k", 60_000);
    assert.equal(hit?.data.n, 42);
    assert.equal(cache.get("k", -1), null, "expired entries do not return");
    assert.notEqual(cache.get("k", null), null, "ttl null = no expiry (peek path)");
    assert.equal(cache.get("missing", 60_000), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
