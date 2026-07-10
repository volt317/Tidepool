// server/index.js
//
// The Tidepool service: reads tidepool.config.json, orchestrates per-distro
// syncs (comprehensive package lists from each distro's own index sources,
// advisory feeds joined on top), caches results on disk, and exposes the API
// the frontend consumes. In production (TIDEPOOL_SERVE_STATIC=1) it also
// serves the built frontend, so the whole service is one process.
//
// API
//   GET  /api/config                              sanitized config
//   GET  /api/distros                             distro list + sync/source status
//   POST /api/distros/:id/sync                    force re-sync (ignores cache)
//   GET  /api/distros/:id/packages?q=&page=&per=  comprehensive list, searchable
//   GET  /api/distros/:id/packages/:name          one package, all index sources
//   GET  /api/distros/:id/packages/:name/enrich   on-demand OSV / EOL / GitHub
//   POST /api/reload                              re-read tidepool.config.json

import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DiskCache, debCompare } from "./lib/util.js";
import { syncAptIndex } from "./sources/apt.js";
import { syncApkIndex, syncArchIndex, fetchAlpineSecdb, fetchArchAvg } from "./sources/apk_arch.js";
import { fetchUbuntuNotices, osvForPackage, eolForSlug, githubReleases } from "./sources/advisories.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ------------------------------------------------------------------ config

function loadConfig() {
  const raw = readFileSync(join(ROOT, "tidepool.config.json"), "utf8");
  return JSON.parse(raw);
}
let config = loadConfig();

const cache = () => new DiskCache(join(ROOT, config.server.cacheDir || ".cache"));
let disk = cache();

const indexTtl = () => (config.server.indexTtlHours ?? 6) * 3600 * 1000;
const advisoryTtl = () => (config.server.advisoryTtlHours ?? 2) * 3600 * 1000;
const githubToken = () => process.env.TIDEPOOL_GITHUB_TOKEN || config.enrichment?.githubToken || "";

// ------------------------------------------------------------ distro state

// distroId -> { status, startedAt, finishedAt, sources[], packages[],
//               advisoriesByPackage{}, error }
const state = new Map();

function distroCfg(id) {
  return (config.distros || []).find((d) => d.id === id && d.enabled !== false);
}

function blankState() {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    sources: [],
    packages: [],
    advisoriesByPackage: {},
    error: null,
  };
}

async function syncIndex(d) {
  if (d.family === "apt") return syncAptIndex(d);
  if (d.family === "apk") return syncApkIndex(d);
  if (d.family === "arch") return syncArchIndex(d);
  throw new Error(`unknown distro family: ${d.family}`);
}

async function syncAdvisories(d) {
  const kind = d.advisories?.kind;
  if (kind === "ubuntu-notices") return fetchUbuntuNotices(d.advisories);
  if (kind === "alpine-secdb") return fetchAlpineSecdb(d.advisories);
  if (kind === "arch-avg") return fetchArchAvg(d.advisories);
  // osv-on-demand (or none): no bulk feed; drill-in enrichment covers it
  return {
    source: {
      id: "advisories:on-demand",
      kind: kind || "none",
      label: kind === "osv-on-demand" ? `OSV on demand (${d.osvEcosystem})` : "no bulk advisory feed",
      urls: [],
      status: "ok",
      note:
        kind === "osv-on-demand"
          ? "No bulk feed configured; advisories are fetched per package from OSV when opened."
          : "No advisory feed configured for this distro.",
      advisoryCount: 0,
    },
    byPackage: {},
  };
}

/** Full sync for one distro: index sources + advisory feed, cached to disk. */
async function syncDistro(id, { force = false } = {}) {
  const d = distroCfg(id);
  if (!d) throw new Error(`unknown or disabled distro: ${id}`);

  const st = state.get(id) || blankState();
  if (st.status === "syncing") return st; // one sync at a time per distro
  state.set(id, st);

  if (!force) {
    const cached = disk.get(`index-${id}`, indexTtl());
    const cachedAdv = disk.get(`advisories-${id}`, advisoryTtl());
    if (cached && cachedAdv) {
      Object.assign(st, cached.data, {
        status: "ready",
        finishedAt: cached.savedAt,
        advisoriesByPackage: cachedAdv.data.byPackage,
      });
      st.sources = [...cached.data.sources, cachedAdv.data.source];
      return st;
    }
  }

  st.status = "syncing";
  st.startedAt = Date.now();
  st.error = null;
  try {
    const [index, adv] = await Promise.all([syncIndex(d), syncAdvisories(d)]);
    st.packages = index.packages;
    st.sources = [...index.sources, adv.source];
    st.advisoriesByPackage = adv.byPackage;
    st.status = index.sources.some((s) => s.status === "ok") ? "ready" : "error";
    if (st.status === "error") st.error = "no index source succeeded — see per-source errors";
    st.finishedAt = Date.now();
    disk.set(`index-${id}`, { sources: index.sources, packages: index.packages });
    disk.set(`advisories-${id}`, { source: adv.source, byPackage: adv.byPackage });
  } catch (e) {
    st.status = "error";
    st.error = String(e.message || e);
    st.finishedAt = Date.now();
  }
  return st;
}

async function ensureSynced(id) {
  const st = state.get(id);
  if (st && (st.status === "ready" || st.status === "syncing")) return st;
  return syncDistro(id);
}

// --------------------------------------------------------------- summaries

function pocketOrder(d) {
  if (d.family === "apt") return (d.index.pockets || []).map((p) => p.id);
  if (d.family === "apk") return d.index.repos || [];
  if (d.family === "arch") return (d.index.repos || []).map((r) => r.toLowerCase());
  return [];
}

/** Version drift: does any later source ship a different version than base? */
function drift(row, order) {
  const present = order.filter((k) => row.versions[k]);
  if (present.length < 2) return false;
  const base = row.versions[present[0]];
  return present.some((k) => row.versions[k] !== base);
}

function packageSummary(row, order, advisories, family) {
  const adv = advisories[row.name] || advisories[row.source] || [];
  // "current" = greatest version across sources (dpkg comparison for apt;
  // apk/arch versions are close enough to dpkg rules for ordering display)
  let current = null;
  for (const k of order) {
    const v = row.versions[k];
    if (v && (current === null || debCompare(v, current) > 0)) current = v;
  }
  return {
    name: row.name,
    source: row.source,
    component: row.component,
    section: row.section,
    description: row.description,
    versions: row.versions,
    current,
    drift: drift(row, order),
    advisoryCount: adv.length,
  };
}

// --------------------------------------------------------------------- app

const app = express();
app.use(express.json());

app.get("/api/config", (_req, res) => {
  const { server, distros, packageHints, enrichment } = config;
  res.json({
    server: { ...server },
    distros: distros.map((d) => ({ ...d })),
    packageHints,
    enrichment: { ...enrichment, githubToken: enrichment?.githubToken ? "(set)" : "" },
  });
});

app.post("/api/reload", (_req, res) => {
  config = loadConfig();
  disk = cache();
  state.clear();
  res.json({ ok: true, note: "config reloaded; distro state cleared" });
});

app.get("/api/distros", async (_req, res) => {
  const out = [];
  for (const d of config.distros || []) {
    if (d.enabled === false) continue;
    const st = state.get(d.id);
    out.push({
      id: d.id,
      label: d.label,
      family: d.family,
      osvEcosystem: d.osvEcosystem || null,
      pocketOrder: pocketOrder(d),
      status: st?.status || "idle",
      startedAt: st?.startedAt || null,
      finishedAt: st?.finishedAt || null,
      packageCount: st?.packages?.length || 0,
      error: st?.error || null,
      sources: st?.sources || [],
    });
  }
  res.json({ distros: out });
});

app.post("/api/distros/:id/sync", async (req, res) => {
  try {
    // fire and return; the frontend polls /api/distros
    syncDistro(req.params.id, { force: true });
    res.status(202).json({ started: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get("/api/distros/:id/packages", async (req, res) => {
  try {
    const d = distroCfg(req.params.id);
    if (!d) return res.status(404).json({ error: "unknown distro" });
    const st = await ensureSynced(d.id);
    if (st.status === "syncing") return res.status(202).json({ syncing: true });
    if (st.status === "error") return res.status(502).json({ error: st.error, sources: st.sources });

    const order = pocketOrder(d);
    const q = (req.query.q || "").toString().toLowerCase();
    const onlyAdvisories = req.query.advisories === "1";
    const onlyDrift = req.query.drift === "1";
    const per = Math.min(parseInt(req.query.per, 10) || 50, 500);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    let rows = st.packages;
    if (q)
      rows = rows.filter(
        (r) => r.name.toLowerCase().includes(q) || (r.source || "").toLowerCase().includes(q)
      );
    let summaries = rows.map((r) => packageSummary(r, order, st.advisoriesByPackage, d.family));
    if (onlyAdvisories) summaries = summaries.filter((s) => s.advisoryCount > 0);
    if (onlyDrift) summaries = summaries.filter((s) => s.drift);

    const total = summaries.length;
    const items = summaries.slice((page - 1) * per, page * per);
    res.json({ total, page, per, pocketOrder: order, items });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/distros/:id/packages/:name", async (req, res) => {
  try {
    const d = distroCfg(req.params.id);
    if (!d) return res.status(404).json({ error: "unknown distro" });
    const st = await ensureSynced(d.id);
    if (st.status !== "ready") return res.status(202).json({ syncing: true });
    const row = st.packages.find((p) => p.name === req.params.name);
    if (!row) return res.status(404).json({ error: "package not in this distro's index" });
    const order = pocketOrder(d);
    const advisories =
      st.advisoriesByPackage[row.name] || st.advisoriesByPackage[row.source] || [];
    res.json({
      distro: d.id,
      package: row,
      pocketOrder: order,
      summary: packageSummary(row, order, st.advisoriesByPackage, d.family),
      advisories,
      hints: (config.packageHints || {})[row.source] || (config.packageHints || {})[row.name] || null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/distros/:id/packages/:name/enrich", async (req, res) => {
  try {
    const d = distroCfg(req.params.id);
    if (!d) return res.status(404).json({ error: "unknown distro" });
    const st = await ensureSynced(d.id);
    if (st.status !== "ready") return res.status(202).json({ syncing: true });
    const row = st.packages.find((p) => p.name === req.params.name);
    if (!row) return res.status(404).json({ error: "package not in this distro's index" });

    const cacheKey = `enrich-${d.id}-${row.name}`;
    const cached = disk.get(cacheKey, advisoryTtl());
    if (cached) return res.json({ ...cached.data, cached: true });

    const hints =
      (config.packageHints || {})[row.source] || (config.packageHints || {})[row.name] || {};
    const en = config.enrichment || {};
    const tasks = [];
    if (en.osv !== false && d.osvEcosystem)
      tasks.push(osvForPackage(row.source || row.name, d.osvEcosystem));
    if (en.endoflife !== false && (hints.eol || null))
      tasks.push(eolForSlug(hints.eol));
    if (en.github !== false && hints.github)
      tasks.push(githubReleases(hints.github, githubToken()));

    const records = await Promise.all(tasks);
    const payload = { package: row.name, records };
    // cache only if something succeeded — a transient outage must not be
    // pinned for the full advisory TTL
    if (records.some((r) => r.status !== "error")) disk.set(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ------------------------------------------------------------------ static

if (process.env.TIDEPOOL_SERVE_STATIC === "1") {
  const dist = join(ROOT, "web", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
  } else {
    console.warn("TIDEPOOL_SERVE_STATIC=1 but web/dist is missing — run `npm run build` first.");
  }
}

const port = config.server.port || 8747;
app.listen(port, () => {
  console.log(`tidepool service listening on :${port}`);
  console.log(`distros: ${(config.distros || []).filter((d) => d.enabled !== false).map((d) => d.id).join(", ")}`);
});
