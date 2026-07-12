// server/src/core/routes.ts
//
// The HTTP surface over the contained aggregation core. Domain-symmetric by
// construction: every route is /api/domains/:domain/units/:unit/…, and the
// handlers know nothing about apt pockets or registry surfaces.

import { Router } from "express";
import type { Aggregator } from "./aggregator.js";
import { buildSnapshot, exportSnapshot, type ExportFormat, type SnapshotStore } from "./snapshot.js";
import type { SnapshotStage } from "../../../shared/types.js";

const STAGES: SnapshotStage[] = ["observation", "churn", "interpretive"];
const DIGEST_PARAM = /^([0-9a-f]{64})$/;
const FORMATS: ExportFormat[] = ["json", "ndjson", "md", "html", "sqlite", "bundle"];

export function buildRouter(agg: Aggregator, snapshots: SnapshotStore): Router {
  const r = Router();

  r.get("/domains", (_req, res) => {
    res.json({ domains: agg.domains() });
  });

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

  r.get("/domains/:domain/units/:unit/packages", async (req, res) => {
    try {
      const p = agg.provider(req.params.domain, req.params.unit);
      if (!p) {
        res.status(404).json({ error: "unknown unit" });
        return;
      }
      const st = await agg.ensureSynced(p);
      if (st.status === "syncing") {
        res.status(202).json({ syncing: true });
        return;
      }
      if (st.status === "error") {
        res.status(502).json({ error: st.error, sources: st.sources });
        return;
      }
      res.json(
        agg.packages(p, st, {
          q: String(req.query.q ?? ""),
          page: parseInt(String(req.query.page), 10) || 1,
          per: parseInt(String(req.query.per), 10) || 50,
          advisoriesOnly: req.query.advisories === "1",
          driftOnly: req.query.drift === "1",
        })
      );
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  r.get("/domains/:domain/units/:unit/packages/:name", async (req, res) => {
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
      const detail = agg.detail(p, st, req.params.name);
      if (!detail) {
        res.status(404).json({ error: "package not in this unit's index" });
        return;
      }
      res.json(detail);
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
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

  // ------------------------------------------------------------ inflow

  r.get("/domains/:domain/units/:unit/observations", (req, res) => {
    const p = agg.provider(req.params.domain, req.params.unit);
    if (!p) {
      res.status(404).json({ error: "unknown unit" });
      return;
    }
    res.json({ observations: agg.store.observationsFor(p.domain, p.id) });
  });

  r.get("/domains/:domain/units/:unit/changes", (req, res) => {
    const p = agg.provider(req.params.domain, req.params.unit);
    if (!p) {
      res.status(404).json({ error: "unknown unit" });
      return;
    }
    res.json({ changes: agg.store.changesFor(p.domain, p.id) });
  });

  // ---------------------------------------------------------- snapshots

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

  r.get("/snapshots", (_req, res) => {
    try {
      res.json({ snapshots: snapshots.list() });
    } catch (e) {
      // a stored snapshot failing validation is a visible fact, not a crash
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  r.get("/snapshots/:digest", (req, res) => {
    const dm = DIGEST_PARAM.exec(req.params.digest);
    if (!dm) {
      res.status(400).json({ error: "digest must be 64 hex characters" });
      return;
    }
    let doc;
    try {
      doc = snapshots.load(dm[1]);
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
      return;
    }
    if (!doc) {
      res.status(404).json({ error: "unknown snapshot" });
      return;
    }
    res.json(doc);
  });

  r.get("/snapshots/:digest/export/:format", (req, res) => {
    const dm = DIGEST_PARAM.exec(req.params.digest);
    if (!dm) {
      res.status(400).json({ error: "digest must be 64 hex characters" });
      return;
    }
    let doc;
    try {
      doc = snapshots.load(dm[1]);
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
      return;
    }
    if (!doc) {
      res.status(404).json({ error: "unknown snapshot" });
      return;
    }
    const format = req.params.format as ExportFormat;
    if (!FORMATS.includes(format)) {
      res.status(400).json({ error: `format must be one of ${FORMATS.join(", ")}` });
      return;
    }
    try {
      const out = exportSnapshot(doc, format);
      res.setHeader("content-type", out.contentType);
      res.setHeader("content-disposition", `attachment; filename="${out.filename}"`);
      res.send(out.body);
    } catch (e) {
      res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  return r;
}
