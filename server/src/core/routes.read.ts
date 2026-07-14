// server/src/core/routes.read.ts
//
// The READ surface: every handler here answers exclusively from process
// memory, the disk cache, the SQLite corpus, or the snapshot directory.
// None of these handlers may cause upstream collection or corpus mutation.
//
// REFACTOR NOTE (deployment split): these handlers were MOVED VERBATIM from
// routes.ts so the API service can run with no network egress and a
// query-only database connection. Handlers that trigger collection or write
// the corpus were moved to routes.control.ts (hosted by the collector).
// routes.ts still composes both routers, preserving the original
// single-process surface for development and tests.

import { Router } from "express";
import type { Aggregator } from "./aggregator.js";
import { exportSnapshot, type ExportFormat, type SnapshotStore } from "./snapshot.js";

const DIGEST_PARAM = /^([0-9a-f]{64})$/;
const FORMATS: ExportFormat[] = ["json", "ndjson", "md", "html", "sqlite", "bundle"];

export function buildReadRouter(agg: Aggregator, snapshots: SnapshotStore): Router {
  const r = Router();

  r.get("/domains", (_req, res) => {
    res.json({ domains: agg.domains() });
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
  // (reads only — snapshot CREATION writes manifest rows and therefore
  //  lives on the control router, inside the single-writer process)

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
