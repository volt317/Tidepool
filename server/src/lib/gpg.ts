// server/src/lib/gpg.ts
//
// InRelease signature verification via the host `gpgv` and the distribution's
// archive keyring(s). Same trust posture as apt itself: the clearsigned
// InRelease must carry a good signature from a key in the configured
// keyring(s), or the pocket fails closed.
//
// Mechanics that matter (validated against a live Ubuntu InRelease and a
// deliberately tampered copy during development):
//   - gpgv exits 0 with "Good signature from …" lines on success;
//   - a single flipped byte in the signed body yields "BAD signature" —
//     but exit codes must be read from gpgv itself, never through a shell
//     pipeline, so this module uses spawnSync and inspects both the exit
//     code and the stderr verdict lines (belt and braces).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCorpusAtomic } from "./corpus.js";

export interface GpgVerdict {
  ok: boolean;
  /** identities from "Good signature from …" lines */
  signedBy: string[];
  /** human-readable reason when !ok */
  reason?: string;
}

/** Which of the configured keyring paths actually exist on this host. */
export function availableKeyrings(paths: string[]): string[] {
  return paths.filter((p) => existsSync(p));
}

export function gpgvAvailable(): boolean {
  const r = spawnSync("gpgv", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/** Run gpgv over an on-disk document: a process operation, no interpretation. */
export function runGpgv(documentPath: string, keyrings: string[]): { status: number | null; stderr: string } {
  const args = keyrings.flatMap((r) => ["--keyring", r]).concat([documentPath]);
  const res = spawnSync("gpgv", args, { encoding: "utf8", timeout: 30_000 });
  return { status: res.status, stderr: res.stderr || "" };
}

/**
 * Semantic interpretation of a gpgv run — pure: no IO, no process, just the
 * validity check over the outputs. Exit code is authoritative; the stderr
 * verdict lines are the belt-and-braces cross-check.
 */
export function interpretGpgvVerdict(status: number | null, stderr: string): GpgVerdict {
  const signedBy = [...stderr.matchAll(/Good signature from "([^"]+)"/g)].map((m) => m[1]);
  const bad = /BAD signature/.test(stderr);
  const noPubkey = /Can't check signature|No public key/i.test(stderr);

  if (status === 0 && signedBy.length > 0 && !bad) {
    return { ok: true, signedBy };
  }
  let reason = `gpgv exit ${status}`;
  if (bad) reason = "BAD signature — the document does not match its signature (tampering or corruption)";
  else if (noPubkey) reason = "signature made by a key not present in the configured keyrings";
  else if (signedBy.length === 0)
    reason = `no good signature found (gpgv said: ${stderr.trim().split("\n").slice(-2).join(" / ")})`;
  return { ok: false, signedBy, reason };
}

/**
 * Verify a clearsigned document (InRelease bytes) against keyrings.
 * Fail-closed contract: any missing tool, missing keyring, non-zero exit,
 * or absence of a "Good signature" verdict is a failure with a reason.
 * Composition of three separated concerns: one whole-corpus write into a
 * private temp dir, one gpgv process run, one pure verdict interpretation.
 */
export function verifyClearsigned(document: Buffer, keyrings: string[]): GpgVerdict {
  const rings = availableKeyrings(keyrings);
  if (rings.length === 0) {
    return {
      ok: false,
      signedBy: [],
      reason:
        `no configured keyring exists on this host (looked for: ${keyrings.join(", ")}). ` +
        `Install the distro's archive keyring package or point index.keyrings at the right file.`,
    };
  }
  if (!gpgvAvailable()) {
    return { ok: false, signedBy: [], reason: "gpgv not found on PATH (install gpgv / gnupg)" };
  }

  const dir = mkdtempSync(join(tmpdir(), "tidepool-gpg-"));
  const file = join(dir, "InRelease");
  try {
    writeCorpusAtomic(file, document); // one whole-corpus write, nothing partial
    const run = runGpgv(file, rings);
    return interpretGpgvVerdict(run.status, run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
