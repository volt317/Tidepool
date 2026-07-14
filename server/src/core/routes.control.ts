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

export function buildControlRouter(agg: Aggregator, snapshots: SnapshotStore): Router {
  const r = Router();

  r.post("/domains/:domain/units/:unit/sync", (req, res) => {
    const p = agg.provider(req.params.domain, req.params.unit);
    if (!p) {
      res.status(404).json({ error: "unknown unit" });
      return;
    }
    void agg.sync(p, { force: true }).catch(() => {
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
    for (const p of agg.allProviders()) {
      started.push(`${p.domain}/${p.id}`);
      void agg.sync(p, { force: true }).catch(() => {
        /* state carries the error */
      });
    }
    res.status(202).json({ started });
  });

  /** Corpus maintenance: integrity verification.
   *  Runs inside the single-writer process by construction. */
  r.post("/control/maintenance", (_req, res) => {
    try {
      const verification = agg.store.verifyCorpus();
      res.json({ ok: verification.ok, checks: verification.checks });
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  return r;
}
