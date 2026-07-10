// server/src/index.ts
//
// The Tidepool service: reads tidepool.config.json, orchestrates per-distro
// syncs (comprehensive package lists from each distro's own index sources,
// advisory feeds joined on top), caches results on disk, and exposes the API
// the frontend consumes. With TIDEPOOL_SERVE_STATIC=1 it also serves the
// built frontend. Run from the repository root (or set TIDEPOOL_ROOT).

import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  DistroConfig,
  DistroStatusBody,
  JoinedAdvisory,
  PackageRow,
  PackageSummary,
  SourceRecord,
  TidepoolConfig,
} from "../../shared/types.js";
import { debCompare, DiskCache } from "./lib/util.js";
import { syncAptIndex, type IndexResult } from "./sources/apt.js";
import {
  fetchAlpineSecdb,
  fetchArchAvg,
  syncApkIndex,
  syncArchIndex,
  type AdvisoryJoin,
} from "./sources/apk_arch.js";
import { eolForSlug, fetchUbuntuNotices, githubReleases, osvForPackage } from "./sources/advisories.js";

const ROOT = resolve(process.env.TIDEPOOL_ROOT || process.cwd());

// ------------------------------------------------------------------ config

function loadConfig(): TidepoolConfig {
  return JSON.parse(readFileSync(join(ROOT, "tidepool.config.json"), "utf8")) as TidepoolConfig;
}
let config = loadConfig();

const makeCache = () => new DiskCache(join(ROOT, config.server.cacheDir ?? ".cache"));
let disk = makeCache();

const indexTtl = () => (config.server.indexTtlHours ?? 6) * 3600 * 1000;
const advisoryTtl = () => (config.server.advisoryTtlHours ?? 2) * 3600 * 1000;
const githubToken = () => process.env.TIDEPOOL_GITHUB_TOKEN || config.enrichment?.githubToken || "";

// ------------------------------------------------------------ distro state

interface DistroState {
  status: "idle" | "syncing" | "ready" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  sources: SourceRecord[];
  packages: PackageRow[];
  advisoriesByPackage: Record<string, JoinedAdvisory[]>;
  error: string | null;
}

const state = new Map<string, DistroState>();

const distroCfg = (id: string): DistroConfig | undefined =>
  (config.distros ?? []).find((d) => d.id === id && d.enabled !== false);

const blankState = (): DistroState => ({
  status: "idle",
  startedAt: null,
  finishedAt: null,
  sources: [],
  packages: [],
  advisoriesByPackage: {},
  error: null,
});

async function syncIndex(d: DistroConfig): Promise<IndexResult> {
  if (d.family === "apt") return syncAptIndex(d);
  if (d.family === "apk") return syncApkIndex(d);
  if (d.family === "arch") return syncArchIndex(d);
  throw new Error(`unknown distro family: ${(d as DistroConfig).family}`);
}

async function syncAdvisories(d: DistroConfig): Promise<AdvisoryJoin> {
  const kind = d.advisories?.kind;
  if (kind === "ubuntu-notices" && d.advisories) return fetchUbuntuNotices(d.advisories);
  if (kind === "alpine-secdb" && d.advisories) return fetchAlpineSecdb(d.advisories);
  if (kind === "arch-avg" && d.advisories) return fetchArchAvg(d.advisories);
  return {
    source: {
      id: "advisories:on-demand",
      kind: kind ?? "none",
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

interface IndexCachePayload {
  sources: SourceRecord[];
  packages: PackageRow[];
}
interface AdvisoryCachePayload {
  source: SourceRecord;
  byPackage: Record<string, JoinedAdvisory[]>;
}

async function syncDistro(id: string, opts: { force?: boolean } = {}): Promise<DistroState> {
  const d = distroCfg(id);
  if (!d) throw new Error(`unknown or disabled distro: ${id}`);

  const st = state.get(id) ?? blankState();
  if (st.status === "syncing") return st;
  state.set(id, st);

  if (!opts.force) {
    const cached = disk.get<IndexCachePayload>(`index-${id}`, indexTtl());
    const cachedAdv = disk.get<AdvisoryCachePayload>(`advisories-${id}`, advisoryTtl());
    if (cached && cachedAdv) {
      st.packages = cached.data.packages;
      st.sources = [...cached.data.sources, cachedAdv.data.source];
      st.advisoriesByPackage = cachedAdv.data.byPackage;
      st.status = "ready";
      st.finishedAt = cached.savedAt;
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
    disk.set<IndexCachePayload>(`index-${id}`, { sources: index.sources, packages: index.packages });
    disk.set<AdvisoryCachePayload>(`advisories-${id}`, { source: adv.source, byPackage: adv.byPackage });
  } catch (e) {
    st.status = "error";
    st.error = String(e instanceof Error ? e.message : e);
    st.finishedAt = Date.now();
  }
  return st;
}

async function ensureSynced(id: string): Promise<DistroState> {
  const st = state.get(id);
  if (st && (st.status === "ready" || st.status === "syncing")) return st;
  return syncDistro(id);
}

// --------------------------------------------------------------- summaries

function pocketOrder(d: DistroConfig): string[] {
  if (d.family === "apt") return (d.index as { pockets: { id: string }[] }).pockets.map((p) => p.id);
  if (d.family === "apk") return (d.index as { repos: string[] }).repos;
  if (d.family === "arch") return (d.index as { repos: string[] }).repos.map((r) => r.toLowerCase());
  return [];
}

function hasDrift(row: PackageRow, order: string[]): boolean {
  const present = order.filter((k) => row.versions[k]);
  if (present.length < 2) return false;
  const base = row.versions[present[0]];
  return present.some((k) => row.versions[k] !== base);
}

function packageSummary(
  row: PackageRow,
  order: string[],
  advisories: Record<string, JoinedAdvisory[]>
): PackageSummary {
  const adv = advisories[row.name] ?? advisories[row.source] ?? [];
  let current: string | null = null;
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
    drift: hasDrift(row, order),
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
  disk = makeCache();
  state.clear();
  res.json({ ok: true, note: "config reloaded; distro state cleared" });
});

app.get("/api/distros", (_req, res) => {
  const out: DistroStatusBody[] = [];
  for (const d of config.distros ?? []) {
    if (d.enabled === false) continue;
    const st = state.get(d.id);
    out.push({
      id: d.id,
      label: d.label,
      family: d.family,
      osvEcosystem: d.osvEcosystem ?? null,
      pocketOrder: pocketOrder(d),
      status: st?.status ?? "idle",
      startedAt: st?.startedAt ?? null,
      finishedAt: st?.finishedAt ?? null,
      packageCount: st?.packages.length ?? 0,
      error: st?.error ?? null,
      sources: st?.sources ?? [],
    });
  }
  res.json({ distros: out });
});

app.post("/api/distros/:id/sync", (req, res) => {
  if (!distroCfg(req.params.id)) {
    res.status(400).json({ error: `unknown or disabled distro: ${req.params.id}` });
    return;
  }
  void syncDistro(req.params.id, { force: true }).catch(() => {
    /* state carries the error; nothing to do here */
  });
  res.status(202).json({ started: true });
});

app.get("/api/distros/:id/packages", async (req, res) => {
  try {
    const d = distroCfg(req.params.id);
    if (!d) {
      res.status(404).json({ error: "unknown distro" });
      return;
    }
    const st = await ensureSynced(d.id);
    if (st.status === "syncing") {
      res.status(202).json({ syncing: true });
      return;
    }
    if (st.status === "error") {
      res.status(502).json({ error: st.error, sources: st.sources });
      return;
    }

    const order = pocketOrder(d);
    const q = String(req.query.q ?? "").toLowerCase();
    const per = Math.min(parseInt(String(req.query.per), 10) || 50, 500);
    const page = Math.max(parseInt(String(req.query.page), 10) || 1, 1);

    let rows = st.packages;
    if (q)
      rows = rows.filter(
        (r) => r.name.toLowerCase().includes(q) || r.source.toLowerCase().includes(q)
      );
    let summaries = rows.map((r) => packageSummary(r, order, st.advisoriesByPackage));
    if (req.query.advisories === "1") summaries = summaries.filter((s) => s.advisoryCount > 0);
    if (req.query.drift === "1") summaries = summaries.filter((s) => s.drift);

    res.json({
      total: summaries.length,
      page,
      per,
      pocketOrder: order,
      items: summaries.slice((page - 1) * per, page * per),
    });
  } catch (e) {
    res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

app.get("/api/distros/:id/packages/:name", async (req, res) => {
  try {
    const d = distroCfg(req.params.id);
    if (!d) {
      res.status(404).json({ error: "unknown distro" });
      return;
    }
    const st = await ensureSynced(d.id);
    if (st.status !== "ready") {
      res.status(202).json({ syncing: true });
      return;
    }
    const row = st.packages.find((p) => p.name === req.params.name);
    if (!row) {
      res.status(404).json({ error: "package not in this distro's index" });
      return;
    }
    const order = pocketOrder(d);
    res.json({
      distro: d.id,
      package: row,
      pocketOrder: order,
      summary: packageSummary(row, order, st.advisoriesByPackage),
      advisories: st.advisoriesByPackage[row.name] ?? st.advisoriesByPackage[row.source] ?? [],
      hints: config.packageHints?.[row.source] ?? config.packageHints?.[row.name] ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

app.get("/api/distros/:id/packages/:name/enrich", async (req, res) => {
  try {
    const d = distroCfg(req.params.id);
    if (!d) {
      res.status(404).json({ error: "unknown distro" });
      return;
    }
    const st = await ensureSynced(d.id);
    if (st.status !== "ready") {
      res.status(202).json({ syncing: true });
      return;
    }
    const row = st.packages.find((p) => p.name === req.params.name);
    if (!row) {
      res.status(404).json({ error: "package not in this distro's index" });
      return;
    }

    const cacheKey = `enrich-${d.id}-${row.name}`;
    interface EnrichPayload {
      package: string;
      records: Awaited<ReturnType<typeof osvForPackage>>[];
    }
    const cached = disk.get<EnrichPayload>(cacheKey, advisoryTtl());
    if (cached) {
      res.json({ ...cached.data, cached: true });
      return;
    }

    const hints = config.packageHints?.[row.source] ?? config.packageHints?.[row.name] ?? {};
    const en = config.enrichment ?? {};
    const tasks: Promise<Awaited<ReturnType<typeof osvForPackage>>>[] = [];
    if (en.osv !== false && d.osvEcosystem) tasks.push(osvForPackage(row.source || row.name, d.osvEcosystem));
    if (en.endoflife !== false && hints.eol) tasks.push(eolForSlug(hints.eol));
    if (en.github !== false && hints.github) tasks.push(githubReleases(hints.github, githubToken()));

    const records = await Promise.all(tasks);
    const payload: EnrichPayload = { package: row.name, records };
    // cache only if something succeeded — a transient outage must not be
    // pinned for the full advisory TTL
    if (records.some((r) => r.status !== "error")) disk.set(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
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

const port = config.server.port ?? 8747;
app.listen(port, () => {
  console.log(`tidepool service listening on :${port} (root: ${ROOT})`);
  console.log(
    `distros: ${(config.distros ?? [])
      .filter((d) => d.enabled !== false)
      .map((d) => d.id)
      .join(", ")}`
  );
});
