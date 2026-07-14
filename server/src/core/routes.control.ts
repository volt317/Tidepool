// server/src/core/routes.control.ts
//
// The CONTROL surface: everything that reaches the network (sync,
// enrichment) or writes through the single SQLite writer connection
// (snapshot creation records manifest rows).
//
// REFACTOR NOTE (deployment split): the sync, enrich, and snapshot-creation
// handlers were MOVED VERBATIM from routes.ts. In the containerized
// deployment this router is hosted ONLY by the collector service, bound to
// the pod-internal loopback — the collector never publishes a port. The API
// service proxies these three operations to the collector so the web UI
// keeps working, and the scheduler drives them on a timer.
//
// The /control/* endpoints below are NEW code (marked as such): a small
// scheduler-facing surface added to fit the deployment model.

import { Router } from "express";
import type { Aggregator } from "./aggregator.js";
import { buildSnapshot, type SnapshotStore } from "./snapshot.js";
import type { SnapshotStage } from "../../../shared/types.js";

const STAGES: SnapshotStage[] = ["observation", "churn", "interpretive"];

export interface ControlHooks {
  /** invoked after any corpus-mutating operation completes — the collector
   *  uses it to publish a fresh read replica (deployment-evolution) */
  afterMutation?: (reason: string) => void;
  /** structured request logging with attribution */
  logRequest?: (fields: Record<string, unknown>) => void;
}

export function buildControlRouter(agg: Aggregator, snapshots: SnapshotStore, hooks: ControlHooks = {}): Router {
  const r = Router();

  // attribution: every control request carries a request id + caller — part
  // of the narrow-protocol contract (see services/ipc.ts)
  r.use((req, _res, next) => {
    hooks.logRequest?.({
      op: `${req.method} ${req.path}`,
      requestId: req.header("x-request-id") ?? null,
      caller: req.header("x-caller") ?? null,
    });
    next();
  });

  r.post("/domains/:domain/units/:unit/sync", (req, res) => {
    const p = agg.provider(req.params.domain, req.params.unit);
    if (!p) {
      res.status(404).json({ error: "unknown unit" });
      return;
    }
    void agg
      .sync(p, { force: true })
      .then(() => hooks.afterMutation?.(`sync ${p.domain}/${p.id}`))
      .catch(() => {
        /* state carries the error */
      });
    res.status(202).json({ started: true });
  });

  r.get("/domains/:domain/units/:unit/packages/:name/enrich", async (req, res) => {
    try {
      const p = agg.provider(req.params.domain, req.params.unit);
      if (!p) {
        res.status(404).json({ error: "unknown unit" });
        return;
      }
      const st = await agg.ensureSynced(p);
      if (st.status !== "ready") {
        res.status(202).json({ syncing: true });
        return;
      }
      const out = await agg.enrich(p, st, req.params.name);
      if (!out) {
        res.status(404).json({ error: "package not in this unit's index" });
        return;
      }
      res.json({ ...out.payload, cached: out.cached });
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  r.post("/snapshots", async (req, res) => {
    try {
      const stage = (req.body?.stage ?? "interpretive") as SnapshotStage;
      if (!STAGES.includes(stage)) {
        res.status(400).json({ error: `stage must be one of ${STAGES.join(", ")}` });
        return;
      }
      const windowHours = Number(req.body?.windowHours ?? 24 * 7);
      const explicit =
        req.body?.from && req.body?.to ? { from: Number(req.body.from), to: Number(req.body.to) } : undefined;
      const doc = await buildSnapshot({
        providers: agg.allProviders(),
        store: agg.store,
        stage,
        windowHours,
        window: explicit,
      });
      const digest = snapshots.save(doc);
      hooks.afterMutation?.(`snapshot ${digest.slice(0, 12)}`);
      res.status(201).json({
        digest,
        stage: doc.stage,
        window: doc.window,
        entities: doc.entities.length,
        observations: doc.observations.length,
        changes: doc.changes.length,
        findings: doc.findings.length,
        notObserved: doc.notObserved.length,
      });
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  // -------------------------------------------------- scheduler surface
  // NEW code (not moved): minimal endpoints so the scheduler can drive the
  // collector without enumerating units itself or touching the corpus.

  /** Kick off a sync of every configured unit; returns immediately with the
   *  set of units started. Per-unit state (including failures) is visible
   *  through the read surface exactly as with manual syncs. */
  r.post("/control/sync-all", (_req, res) => {
    const started: string[] = [];
    const work: Promise<unknown>[] = [];
    for (const p of agg.allProviders()) {
      started.push(`${p.domain}/${p.id}`);
      work.push(
        agg.sync(p, { force: true }).catch(() => {
          /* state carries the error */
        })
      );
    }
    void Promise.all(work).then(() => hooks.afterMutation?.("sync-all"));
    res.status(202).json({ started });
  });

  /** Publish a fresh read replica on demand. */
  r.post("/control/publish", (_req, res) => {
    hooks.afterMutation?.("explicit publish request");
    res.status(202).json({ publishing: true });
  });

  /** Bounded enrichment of a KNOWN entity: the unit must be configured and
   *  the package must exist in the unit's current state — arbitrary names
   *  never reach the network. Results are recorded as evidence observations
   *  by the aggregator (recordEvidence: true in the collector). */
  r.post("/control/enrich", async (req, res) => {
    try {
      const { domain, unit, package: name } = (req.body ?? {}) as { domain?: string; unit?: string; package?: string };
      if (!domain || !unit || !name) {
        res.status(400).json({ error: "domain, unit, and package are required" });
        return;
      }
      const p = agg.provider(domain, unit);
      if (!p) {
        res.status(404).json({ error: "unknown unit" });
        return;
      }
      const st = await agg.ensureSynced(p);
      if (st.status !== "ready") {
        res.status(409).json({ error: "unit has no current state to validate against — sync first" });
        return;
      }
      const out = await agg.enrich(p, st, name);
      if (!out) {
        res.status(404).json({ error: "package not in this unit's index — enrichment of unknown entities is refused" });
        return;
      }
      hooks.afterMutation?.(`enrich ${domain}/${unit}/${name}`);
      res.json({ package: name, surfaces: out.payload.records.length, cached: out.cached });
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** Policy enrichment: enrich packages that CHANGED in the recent window,
   *  bounded by maxPerRun. This is the scheduler's enrichment entry point —
   *  configured, bounded, attributable, persisted. */
  r.post("/control/enrich-changed", async (req, res) => {
    try {
      const windowHours = Math.min(Number(req.body?.windowHours ?? 24), 24 * 30);
      const limit = Math.min(Number(req.body?.limit ?? 25), 1000);
      const since = Date.now() - windowHours * 3600_000;
      const enriched: string[] = [];
      const skippedUnits: string[] = [];
      outer: for (const p of agg.allProviders()) {
        const changes = agg.store.changesFor(p.domain, p.id, { from: since });
        const names = [...new Set(changes.map((c) => c.package).filter((n): n is string => !!n))];
        if (names.length === 0) continue;
        const st = await agg.ensureSynced(p);
        if (st.status !== "ready") {
          skippedUnits.push(`${p.domain}/${p.id}`);
          continue;
        }
        for (const name of names) {
          if (enriched.length >= limit) break outer;
          const out = await agg.enrich(p, st, name);
          if (out) enriched.push(`${p.domain}/${p.id}/${name}`);
        }
      }
      if (enriched.length > 0) hooks.afterMutation?.(`enrich-changed (${enriched.length})`);
      res.json({ windowHours, limit, enriched, skippedUnits });
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** Corpus maintenance: integrity verification.
   *  Runs inside the single-writer process by construction. */
  r.post("/control/maintenance", (_req, res) => {
    try {
      const verification = agg.store.verifyCorpus();
      hooks.afterMutation?.("maintenance");
      res.json({ ok: verification.ok, checks: verification.checks });
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  return r;
}
