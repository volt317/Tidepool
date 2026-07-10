// server/src/core/routes.ts
//
// The HTTP surface over the contained aggregation core. Domain-symmetric by
// construction: every route is /api/domains/:domain/units/:unit/…, and the
// handlers know nothing about apt pockets or registry surfaces.

import { Router } from "express";
import type { Aggregator } from "./aggregator.js";

export function buildRouter(agg: Aggregator): Router {
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

  return r;
}
