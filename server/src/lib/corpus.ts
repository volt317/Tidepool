// server/src/lib/corpus.ts
//
// The file-access boundary, separated from all semantic interpretation.
// Rules enforced by this module's shape:
//
//   - File operations are one operation in one direction: a read is a single
//     read of the entire corpus; a write is a single atomic write of the
//     entire corpus (temp file + rename). No streaming parse, no partial
//     read that later code resumes, no read-modify-write of a region.
//   - This module never interprets bytes. Parsing to a JSON object happens
//     after the read has fully completed (`parseJsonCorpus`), and semantic
//     validation of that object happens in code, elsewhere (lib/validate.ts
//     and the callers) — three separate concerns, three separate functions.

import { readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

/** Read the entire corpus at `path` in one operation. */
export function readCorpus(path: string): Buffer {
  return readFileSync(path);
}

/** Read the entire corpus as UTF-8 text in one operation. */
export function readCorpusText(path: string): string {
  return readFileSync(path, "utf8");
}

/** True if a corpus exists at `path` (no read is performed). */
export function corpusExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Write the entire corpus in one atomic operation: the bytes land in a
 * temporary sibling and are renamed into place, so readers can never observe
 * a partially written corpus.
 */
export function writeCorpusAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * Append one complete record-corpus (e.g. a full NDJSON line, or several) in
 * a single operation. The unit appended is always whole records with their
 * terminator — never a partial record continued by a later call.
 */
export function appendCorpus(path: string, data: string): void {
  appendFileSync(path, data);
}

/**
 * Parse a fully-read corpus into a JSON object. Pure: no IO. Throws with the
 * corpus's name in the message so callers report *which* file was malformed.
 */
export function parseJsonCorpus(text: string, name: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`${name}: corpus is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}
