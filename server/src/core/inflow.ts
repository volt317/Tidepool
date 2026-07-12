// server/src/core/inflow.ts
//
// The inflow layer: immutable observations, deterministic change detection,
// and ecosystem-level heuristics. Three principles from the development
// direction, enforced structurally:
//
//   - Observations are append-only and content-addressed; nothing here ever
//     rewrites one. Normalized records are stored as content-addressed blobs
//     (records/<digest>.json), so an unchanged source costs one small
//     observation line, not a data copy.
//   - Change detection is a pure comparison of consecutive observations of
//     the same source; every ChangeRecord names the observation pair it was
//     derived from.
//   - Heuristics read observations and changes and emit findings with rule
//     ids, confidence basis, evidence references, and ambiguities. They
//     never touch the observation log.


import type { ChangeKind, ChangeRecord, HeuristicFinding, Observation } from "../../../shared/types.js";
import { sha256hex } from "../lib/util.js";

export const INFLOW_SCHEMA_VERSION = "1";

/** Canonical JSON: sorted keys, no whitespace — digests must be stable. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export const digestOf = (v: unknown): string => sha256hex(Buffer.from(stableStringify(v)));

// ---------------------------------------------------------- change detection

/** Normalized index record shape used for diffing (both domains emit it). */
export interface IndexRecordLite {
  name: string;
  version: string;
  meta?: string; // stable string of diff-relevant metadata (section/component…)
}

/** Advisory record shape used for diffing. */
export interface AdvisoryRecordLite {
  package: string;
  id: string;
  fingerprint: string; // stable string of the advisory's diff-relevant content
}

function change(
  base: Pick<ChangeRecord, "domain" | "unit" | "sourceId" | "fromObservation" | "toObservation" | "detectedAt">,
  kind: ChangeKind,
  rest: Partial<ChangeRecord>
): ChangeRecord {
  const body = { ...base, kind, ...rest };
  return { id: digestOf(body), ...body };
}

/**
 * Deterministic diff of two observations of one source. `prevRecords` /
 * `nextRecords` are the blobs the observations point at; passing them in
 * keeps this a pure function.
 */
export function detectChanges(
  prev: Observation | null,
  next: Observation,
  prevRecords: unknown,
  nextRecords: unknown,
  sourceKind: "index" | "advisory"
): ChangeRecord[] {
  const base = {
    domain: next.domain,
    unit: next.unit,
    sourceId: next.sourceId,
    fromObservation: prev?.id ?? null,
    toObservation: next.id,
    detectedAt: next.collectedAt,
  };
  const out: ChangeRecord[] = [];

  // source availability transitions
  if (prev && prev.status === "ok" && next.status === "error") {
    out.push(change(base, "source-failure", { detail: next.error ?? "collection failed" }));
  }
  if (prev && prev.status === "error" && next.status === "ok") {
    out.push(change(base, "source-recovery", { detail: "source collecting again" }));
  }

  // verification / signer transitions
  if (prev && prev.status === "ok" && next.status === "ok") {
    if ((prev.verification ?? null) !== (next.verification ?? null)) {
      out.push(
        change(base, "verification-transition", { from: prev.verification ?? "none", to: next.verification ?? "none" })
      );
    }
    const prevSigners = (prev.signedBy ?? []).join("; ");
    const nextSigners = (next.signedBy ?? []).join("; ");
    if (prevSigners !== nextSigners && (prevSigners || nextSigners)) {
      out.push(change(base, "signer-transition", { from: prevSigners || null, to: nextSigners || null }));
    }
  }

  if (next.status !== "ok") return out;
  if (prev && prev.recordsDigest === next.recordsDigest) return out; // identical content: nothing to diff
  if (!prev || prev.status !== "ok") return out; // first sight / recovery: state recorded, no per-record fabrication

  if (sourceKind === "index") {
    const a = new Map((prevRecords as IndexRecordLite[]).map((r) => [r.name, r]));
    const b = new Map((nextRecords as IndexRecordLite[]).map((r) => [r.name, r]));
    for (const [name, rec] of b) {
      const old = a.get(name);
      if (!old) {
        out.push(change(base, "package-added", { package: name, to: rec.version }));
      } else {
        if (old.version !== rec.version)
          out.push(change(base, "version-moved", { package: name, from: old.version, to: rec.version }));
        if ((old.meta ?? "") !== (rec.meta ?? ""))
          out.push(change(base, "metadata-changed", { package: name, from: old.meta ?? "", to: rec.meta ?? "" }));
      }
    }
    for (const [name, rec] of a) {
      if (!b.has(name)) out.push(change(base, "package-removed", { package: name, from: rec.version }));
    }
  } else {
    const a = new Map((prevRecords as AdvisoryRecordLite[]).map((r) => [`${r.package}\u0000${r.id}`, r]));
    const b = new Map((nextRecords as AdvisoryRecordLite[]).map((r) => [`${r.package}\u0000${r.id}`, r]));
    for (const [key, rec] of b) {
      const old = a.get(key);
      if (!old) out.push(change(base, "advisory-published", { package: rec.package, to: rec.id }));
      else if (old.fingerprint !== rec.fingerprint)
        out.push(change(base, "advisory-modified", { package: rec.package, to: rec.id }));
    }
    for (const [, rec] of a) {
      if (!b.has(`${rec.package}\u0000${rec.id}`))
        // bounded feeds cannot prove withdrawal — only that the advisory is no
        // longer inside the configured observation window
        out.push(change(base, "advisory-no-longer-observed", { package: rec.package, from: rec.id }));
    }
  }
  return out;
}

// ------------------------------------------------------------- heuristics

export const HEURISTICS_VERSION = "1";

interface RuleInput {
  window: { from: number; to: number };
  observations: Observation[];
  changes: ChangeRecord[];
}

type Rule = (input: RuleInput) => HeuristicFinding[];

const finding = (f: Omit<HeuristicFinding, "confidence"> & { confidence: number }): HeuristicFinding => f;

/** inflow.release-burst — unusually many version movements in one unit. */
const releaseBurst: Rule = ({ changes }) => {
  const byUnit = new Map<string, ChangeRecord[]>();
  for (const c of changes) {
    if (c.kind === "version-moved" || c.kind === "package-added") {
      const k = `${c.domain}/${c.unit}`;
      byUnit.set(k, [...(byUnit.get(k) ?? []), c]);
    }
  }
  const out: HeuristicFinding[] = [];
  for (const [unit, cs] of byUnit) {
    if (cs.length < 25) continue;
    out.push(
      finding({
        ruleId: "inflow.release-burst",
        title: "Unusual release volume",
        severityHint: "notable",
        summary: `${cs.length} version movements/additions in ${unit} within the window.`,
        confidenceBasis: `count threshold (>=25) over deterministic change records; no per-unit baseline history yet`,
        confidence: 0.6,
        subjects: [unit],
        evidence: { observations: [...new Set(cs.map((c) => c.toObservation))], changes: cs.map((c) => c.id) },
        ambiguities: ["without longer history, 'unusual' is a static threshold, not a learned baseline"],
      })
    );
  }
  return out;
};

/** inflow.security-burst — a wave of advisory publications. */
const securityBurst: Rule = ({ changes }) => {
  const pubs = changes.filter((c) => c.kind === "advisory-published");
  if (pubs.length < 5) return [];
  const units = [...new Set(pubs.map((c) => `${c.domain}/${c.unit}`))];
  return [
    finding({
      ruleId: "inflow.security-burst",
      title: "Security-response burst",
      severityHint: "attention",
      summary: `${pubs.length} advisory publications across ${units.length} unit(s) within the window.`,
      confidenceBasis: "advisory-published change records from configured advisory feeds",
      confidence: 0.75,
      subjects: units,
      evidence: { observations: [...new Set(pubs.map((c) => c.toObservation))], changes: pubs.map((c) => c.id) },
      ambiguities: pubs.some((c) => c.sourceId.includes("osv-batch"))
        ? ["OSV batch joins carry ids only; severity distribution not assessed"]
        : [],
    }),
  ];
};

/** inflow.corrective-release — the same package moved twice quickly. */
const correctiveRelease: Rule = ({ changes }) => {
  const moves = changes.filter((c) => c.kind === "version-moved" && c.package);
  const byPkg = new Map<string, ChangeRecord[]>();
  for (const c of moves) {
    const k = `${c.domain}/${c.unit}/${c.sourceId}/${c.package}`;
    byPkg.set(k, [...(byPkg.get(k) ?? []), c]);
  }
  const out: HeuristicFinding[] = [];
  for (const [key, cs] of byPkg) {
    if (cs.length < 2) continue;
    const sorted = [...cs].sort((x, y) => x.detectedAt - y.detectedAt);
    const spanH = (sorted[sorted.length - 1].detectedAt - sorted[0].detectedAt) / 3600000;
    if (spanH > 72) continue;
    const pkg = sorted[0].package as string;
    out.push(
      finding({
        ruleId: "inflow.corrective-release",
        title: "Rapid corrective releases",
        severityHint: "notable",
        summary: `${pkg} moved ${cs.length} times within ${Math.max(1, Math.round(spanH))}h (${sorted
          .map((c) => c.to)
          .join(" → ")}) in ${key.split("/").slice(0, 2).join("/")}.`,
        confidenceBasis: "multiple version-moved records for one package within 72h",
        confidence: 0.7,
        subjects: [pkg],
        evidence: { observations: [...new Set(cs.map((c) => c.toObservation))], changes: cs.map((c) => c.id) },
        ambiguities: ["cannot distinguish a botched release from a fast security follow-up without changelog analysis"],
      })
    );
  }
  return out;
};

/** inflow.source-degradation — a source failed and has not recovered. */
const sourceDegradation: Rule = ({ changes }) => {
  const bySource = new Map<string, ChangeRecord[]>();
  for (const c of changes) {
    if (c.kind === "source-failure" || c.kind === "source-recovery") {
      const k = `${c.domain}/${c.unit}/${c.sourceId}`;
      bySource.set(k, [...(bySource.get(k) ?? []), c]);
    }
  }
  const out: HeuristicFinding[] = [];
  for (const [key, cs] of bySource) {
    const last = [...cs].sort((x, y) => x.detectedAt - y.detectedAt).pop();
    if (last?.kind !== "source-failure") continue;
    out.push(
      finding({
        ruleId: "inflow.source-degradation",
        title: "Source degradation",
        severityHint: "attention",
        summary: `${key} failed during the window and has not recovered (${last.detail ?? "no detail"}).`,
        confidenceBasis: "source-failure without subsequent source-recovery in the window",
        confidence: 0.9,
        subjects: [key],
        evidence: { observations: [last.toObservation], changes: cs.map((c) => c.id) },
        ambiguities: ["a failure at the window edge may already be recovered outside it"],
      })
    );
  }
  return out;
};

/** inflow.signer-transition — the signing identity of a source changed. */
const signerTransition: Rule = ({ changes }) => {
  return changes
    .filter((c) => c.kind === "signer-transition" || c.kind === "verification-transition")
    .map((c) =>
      finding({
        ruleId: "inflow.signer-transition",
        title: c.kind === "signer-transition" ? "Signing identity changed" : "Verification level changed",
        severityHint: "attention",
        summary: `${c.domain}/${c.unit}/${c.sourceId}: ${c.from ?? "none"} → ${c.to ?? "none"}.`,
        confidenceBasis: "direct comparison of verification fields between consecutive observations",
        confidence: 0.95,
        subjects: [`${c.domain}/${c.unit}/${c.sourceId}`],
        evidence: { observations: [c.toObservation, ...(c.fromObservation ? [c.fromObservation] : [])], changes: [c.id] },
        ambiguities: ["key rotation and key compromise are indistinguishable from transition data alone"],
      })
    );
};

export const RULES: Rule[] = [releaseBurst, securityBurst, correctiveRelease, sourceDegradation, signerTransition];

export function runHeuristics(input: RuleInput): HeuristicFinding[] {
  return RULES.flatMap((r) => r(input));
}
