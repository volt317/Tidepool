// web/src/App.jsx — Tidepool distro survey console.
//
// Reads the service API. Three layers of the UI mirror the three layers of
// the data: distro (tabs + per-source health), the comprehensive package
// table (per-pocket version columns, drift and advisory signals), and the
// package drawer (every index source, joined advisories, and on-demand
// upstream enrichment — each record with its own status and endpoint).

import { useState, useEffect, useCallback, useMemo, useRef } from "react";

const C = {
  abyss: "#0B1E24",
  pool: "#122E37",
  poolEdge: "#1C4350",
  shallows: "#0F262E",
  foam: "#E9F2EF",
  mist: "#9DB8B4",
  tide: "#53D6C0",
  urchin: "#EF7A6D",
  sand: "#E3C98F",
  kelp: "#3A6B60",
};
const display = { fontFamily: "'Space Grotesk', system-ui, sans-serif" };
const mono = { fontFamily: "'IBM Plex Mono', ui-monospace, monospace" };

const api = async (path, opts) => {
  const res = await fetch(`/api${path}`, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

const fmtDate = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
};

// ------------------------------------------------------------- primitives

function Mark({ status, title }) {
  const base = {
    width: 9,
    height: 9,
    borderRadius: 2,
    display: "inline-block",
    transform: "rotate(45deg)",
    border: `1.5px solid ${C.kelp}`,
    flex: "none",
  };
  const style =
    status === "ok"
      ? { ...base, borderColor: C.tide, background: C.tide }
      : status === "syncing" || status === "loading"
        ? { ...base, borderColor: C.tide, animation: "tp-pulse 1.1s ease-in-out infinite" }
        : status === "error"
          ? {
              ...base,
              borderColor: C.urchin,
              background: `repeating-linear-gradient(45deg, ${C.urchin}, ${C.urchin} 2px, transparent 2px, transparent 4px)`,
            }
          : status === "empty"
            ? { ...base, borderColor: C.mist }
            : base;
  return <span style={style} title={title} />;
}

function Chip({ color, children }) {
  return (
    <span
      style={{
        ...mono,
        fontSize: 11,
        color,
        border: `1px solid ${color}44`,
        borderRadius: 4,
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Endpoint({ url }) {
  if (!url) return null;
  return (
    <div style={{ ...mono, fontSize: 10, color: C.kelp, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={url}>
      ⌖ {url}
    </div>
  );
}

// ---------------------------------------------------------- source health

function SourceHealth({ sources }) {
  const [open, setOpen] = useState(false);
  if (!sources?.length) return null;
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 8 }}
        aria-expanded={open}
        title="Per-source status — click for details"
      >
        {sources.map((s) => (
          <Mark key={s.id} status={s.status} title={`${s.label}: ${s.status}${s.error ? " — " + s.error : ""}`} />
        ))}
        <span style={{ ...mono, fontSize: 11, color: C.mist }}>{open ? "hide sources ▾" : "sources ▸"}</span>
      </button>
      {open && (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10, marginTop: 10 }}>
          {sources.map((s) => (
            <div key={s.id} style={{ background: C.shallows, border: `1px solid ${C.poolEdge}`, borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ ...mono, fontSize: 11, color: C.mist, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.label}</span>
                <span style={{ ...mono, fontSize: 11, color: s.status === "ok" ? C.tide : s.status === "error" ? C.urchin : C.mist }}>
                  {s.status}
                  {s.verified === true ? " · digest-verified" : ""}
                </span>
              </div>
              <div style={{ fontSize: 12, color: C.mist, marginTop: 4 }}>
                {s.error ? s.error : s.note ? s.note : `${s.packageCount ?? s.advisoryCount ?? 0} records`}
              </div>
              {(s.urls || []).slice(0, 2).map((u) => (
                <Endpoint key={u} url={u} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- pkg drawer

function EnrichPanel({ record }) {
  const tone = record.status === "ok" ? C.tide : record.status === "error" ? C.urchin : C.mist;
  return (
    <div style={{ background: C.shallows, border: `1px solid ${C.poolEdge}`, borderRadius: 6, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ ...mono, fontSize: 11, color: C.mist, textTransform: "uppercase", letterSpacing: "0.06em" }}>{record.label}</span>
        <span style={{ ...mono, fontSize: 11, color: tone }}>
          {record.status === "ok" && record.count != null ? `${record.count}${record.more ? "+" : ""} advisories` : record.status}
        </span>
      </div>
      {record.error && <div style={{ fontSize: 12, color: C.urchin, marginTop: 4 }}>{record.error}</div>}
      {record.note && <div style={{ fontSize: 12, color: C.mist, marginTop: 4 }}>{record.note}</div>}
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 5 }}>
        {(record.items || []).map((it, i) => (
          <li key={i} style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            {"id" in it && (
              <a href={it.url} target="_blank" rel="noreferrer" style={{ ...mono, color: C.urchin, textDecoration: "none", borderBottom: `1px dotted ${C.kelp}` }}>
                {it.id}
              </a>
            )}
            {"tag" in it && (
              <a href={it.url} target="_blank" rel="noreferrer" style={{ ...mono, color: C.tide, textDecoration: "none", borderBottom: `1px dotted ${C.kelp}` }}>
                {it.tag}
              </a>
            )}
            {"cycle" in it && (
              <a href={it.url} target="_blank" rel="noreferrer" style={{ ...mono, color: it.eolPassed ? C.sand : C.tide, textDecoration: "none", borderBottom: `1px dotted ${C.kelp}` }}>
                {it.cycle} → {it.latest}
              </a>
            )}
            <span style={{ color: C.mist }}>
              {it.summary || it.name || ""}
              {it.severity ? ` · ${it.severity}` : ""}
              {it.fixedIn ? ` · fixed in ${it.fixedIn}` : ""}
              {it.published ? ` · ${fmtDate(it.published)}` : ""}
              {"eol" in it ? (it.eol === false ? " · no EOL set" : it.eolPassed ? ` · EOL ${it.eol} (passed)` : ` · EOL ${it.eol}`) : ""}
              {it.lts ? " · LTS" : ""}
              {it.prerelease ? " · prerelease" : ""}
            </span>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 8 }}>
        <Endpoint url={record.url} />
      </div>
    </div>
  );
}

function PackageDrawer({ distro, name, onClose }) {
  const [detail, setDetail] = useState(null);
  const [enrich, setEnrich] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setEnrich(null);
    setErr(null);
    api(`/distros/${distro}/packages/${encodeURIComponent(name)}`).then(({ status, body }) => {
      if (!live) return;
      if (status !== 200) return setErr(body.error || `HTTP ${status}`);
      setDetail(body);
      api(`/distros/${distro}/packages/${encodeURIComponent(name)}/enrich`).then(({ status: s2, body: b2 }) => {
        if (!live) return;
        setEnrich(s2 === 200 ? b2 : { records: [], error: b2.error || `HTTP ${s2}` });
      });
    });
    return () => {
      live = false;
    };
  }, [distro, name]);

  return (
    <div
      role="dialog"
      aria-label={`Package ${name}`}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(560px, 94vw)",
        background: C.pool,
        borderLeft: `1px solid ${C.poolEdge}`,
        boxShadow: "-18px 0 40px rgba(0,0,0,.45)",
        overflowY: "auto",
        padding: 20,
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ ...display, fontSize: 22, fontWeight: 700, margin: 0, color: C.foam }}>{name}</h2>
        <button onClick={onClose} style={{ ...mono, background: "transparent", border: `1px solid ${C.poolEdge}`, color: C.mist, borderRadius: 5, padding: "4px 10px", cursor: "pointer" }}>
          close ✕
        </button>
      </div>

      {err && <div style={{ color: C.urchin, marginTop: 12, fontSize: 13 }}>{err}</div>}
      {!detail && !err && <div style={{ ...mono, color: C.mist, marginTop: 12, fontSize: 12 }}>reading index…</div>}

      {detail && (
        <>
          <div style={{ fontSize: 13, color: C.mist, marginTop: 6 }}>
            {detail.package.description || ""}
            {detail.package.homepage && (
              <>
                {" · "}
                <a href={detail.package.homepage} target="_blank" rel="noreferrer" style={{ color: C.tide }}>
                  homepage
                </a>
              </>
            )}
          </div>
          <div style={{ ...mono, fontSize: 11.5, color: C.mist, marginTop: 4 }}>
            source pkg <span style={{ color: C.foam }}>{detail.package.source}</span>
            {detail.package.section ? ` · ${detail.package.section}` : ""} · {detail.package.arch}
          </div>

          {/* index sources: one row per pocket/repo */}
          <h3 style={{ ...mono, fontSize: 11, color: C.mist, textTransform: "uppercase", letterSpacing: "0.07em", margin: "18px 0 8px" }}>
            index sources
          </h3>
          <div style={{ background: C.shallows, border: `1px solid ${C.poolEdge}`, borderRadius: 6 }}>
            {detail.pocketOrder.map((p, i) => {
              const v = detail.package.versions[p];
              const isCurrent = v && v === detail.summary.current;
              return (
                <div
                  key={p}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    borderTop: i ? `1px solid ${C.poolEdge}` : "none",
                  }}
                >
                  <span style={{ ...mono, fontSize: 12, color: C.mist }}>{p}</span>
                  <span style={{ ...mono, fontSize: 12, color: v ? (isCurrent ? C.tide : C.foam) : C.kelp }}>
                    {v || "not present"}
                    {isCurrent && detail.summary.drift ? "  ← current" : ""}
                  </span>
                </div>
              );
            })}
          </div>

          {/* joined advisory feed */}
          <h3 style={{ ...mono, fontSize: 11, color: C.mist, textTransform: "uppercase", letterSpacing: "0.07em", margin: "18px 0 8px" }}>
            distro advisories (joined feed)
          </h3>
          {detail.advisories.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.mist }}>None joined from the configured feed window.</div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
              {detail.advisories.map((a, i) => (
                <li key={i} style={{ fontSize: 12.5, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                  <a href={a.url} target="_blank" rel="noreferrer" style={{ ...mono, color: C.urchin, textDecoration: "none", borderBottom: `1px dotted ${C.kelp}` }}>
                    {a.id}
                  </a>
                  <span style={{ color: C.mist }}>
                    {a.title || ""}
                    {a.severity ? ` · ${a.severity}` : ""}
                    {a.fixedIn ? ` · fixed in ${a.fixedIn}` : ""}
                    {a.published ? ` · ${fmtDate(a.published)}` : ""}
                    {(a.cves || []).length ? ` · ${a.cves.join(", ")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* on-demand enrichment */}
          <h3 style={{ ...mono, fontSize: 11, color: C.mist, textTransform: "uppercase", letterSpacing: "0.07em", margin: "18px 0 8px" }}>
            upstream enrichment (on demand)
          </h3>
          {!enrich && <div style={{ ...mono, fontSize: 12, color: C.mist }}>querying OSV / lifecycle / releases…</div>}
          {enrich && enrich.records.length === 0 && (
            <div style={{ fontSize: 12.5, color: C.mist }}>
              {enrich.error || "No enrichment sources apply — add a packageHints entry in tidepool.config.json to map this package upstream."}
            </div>
          )}
          {enrich && (
            <div style={{ display: "grid", gap: 10 }}>
              {enrich.records.map((r) => (
                <EnrichPanel key={r.id + r.label} record={r} />
              ))}
              {enrich.cached && <div style={{ ...mono, fontSize: 10, color: C.kelp }}>served from enrichment cache</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- app

export default function App() {
  const [distros, setDistros] = useState([]);
  const [active, setActive] = useState(null);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState({ advisories: false, drift: false });
  const [page, setPage] = useState(1);
  const [table, setTable] = useState({ total: 0, items: [], pocketOrder: [] });
  const [tableState, setTableState] = useState("idle"); // idle|loading|syncing|error
  const [tableErr, setTableErr] = useState(null);
  const [openPkg, setOpenPkg] = useState(null);
  const pollRef = useRef(null);
  const per = 50;

  const loadDistros = useCallback(async () => {
    const { body } = await api("/distros");
    setDistros(body.distros || []);
    return body.distros || [];
  }, []);

  useEffect(() => {
    loadDistros().then((ds) => {
      if (ds.length && !active) setActive(ds[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTable = useCallback(async () => {
    if (!active) return;
    setTableState("loading");
    setTableErr(null);
    const params = new URLSearchParams({ q, page: String(page), per: String(per) });
    if (filters.advisories) params.set("advisories", "1");
    if (filters.drift) params.set("drift", "1");
    const { status, body } = await api(`/distros/${active}/packages?${params}`);
    if (status === 202) {
      setTableState("syncing");
      loadDistros();
      clearTimeout(pollRef.current);
      pollRef.current = setTimeout(loadTable, 2500);
      return;
    }
    if (status !== 200) {
      setTableState("error");
      setTableErr(body.error || `HTTP ${status}`);
      loadDistros();
      return;
    }
    setTable(body);
    setTableState("idle");
    loadDistros();
  }, [active, q, page, filters, loadDistros]);

  useEffect(() => {
    loadTable();
    return () => clearTimeout(pollRef.current);
  }, [loadTable]);

  useEffect(() => setPage(1), [q, active, filters]);

  const current = useMemo(() => distros.find((d) => d.id === active), [distros, active]);
  const pages = Math.max(1, Math.ceil(table.total / per));

  const forceSync = async () => {
    if (!active) return;
    await api(`/distros/${active}/sync`, { method: "POST" });
    setTableState("syncing");
    clearTimeout(pollRef.current);
    pollRef.current = setTimeout(loadTable, 2500);
  };

  return (
    <div style={{ background: C.abyss, minHeight: "100vh", color: C.foam }}>
      <style>{`
        @keyframes tp-pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
        @keyframes tp-sweep { from { transform: translateX(-100%) } to { transform: translateX(100vw) } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important } }
        a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid ${C.tide}; outline-offset: 2px; }
        input::placeholder { color: ${C.kelp}; }
        table { border-collapse: collapse; width: 100%; }
        tbody tr:hover { background: ${C.shallows}; }
      `}</style>

      <div style={{ height: 3, background: `linear-gradient(90deg, transparent, ${C.tide}, ${C.sand}, transparent)`, opacity: 0.7, position: "relative", overflow: "hidden" }}>
        {(tableState === "syncing" || tableState === "loading") && (
          <div style={{ position: "absolute", inset: 0, width: "30%", background: `linear-gradient(90deg, transparent, ${C.foam}, transparent)`, animation: "tp-sweep 1.6s linear infinite" }} />
        )}
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 60px" }}>
        <header>
          <h1 style={{ ...display, fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
            Tidepool <span style={{ color: C.tide }}>·</span> distro survey
          </h1>
          <p style={{ color: C.mist, fontSize: 13.5, margin: "6px 0 0", maxWidth: 640 }}>
            The full package list of each distro, drawn from its own index sources and advisory feeds — every source
            fetched, verified, and parsed on its own; every fact traceable to the endpoint that said it.
          </p>
        </header>

        {/* distro tabs */}
        <nav style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 20 }} aria-label="Distributions">
          {distros.map((d) => (
            <button
              key={d.id}
              onClick={() => setActive(d.id)}
              style={{
                ...mono,
                fontSize: 12.5,
                padding: "7px 14px",
                borderRadius: 6,
                cursor: "pointer",
                border: `1px solid ${d.id === active ? C.tide : C.poolEdge}`,
                background: d.id === active ? C.pool : "transparent",
                color: d.id === active ? C.foam : C.mist,
              }}
            >
              {d.label}
              {d.packageCount ? <span style={{ color: C.tide }}> · {d.packageCount.toLocaleString()}</span> : ""}
              {d.status === "error" ? <span style={{ color: C.urchin }}> · error</span> : ""}
            </button>
          ))}
        </nav>

        {/* distro status strip */}
        {current && (
          <div style={{ background: C.pool, border: `1px solid ${C.poolEdge}`, borderRadius: 8, padding: 14, marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <span style={{ ...mono, fontSize: 12, color: C.mist }}>
                  {current.status === "ready"
                    ? `${current.packageCount.toLocaleString()} packages · synced ${fmtDate(current.finishedAt)} ${new Date(current.finishedAt).toLocaleTimeString()}`
                    : current.status}
                </span>
                <SourceHealth sources={current.sources} />
              </div>
              <button
                onClick={forceSync}
                style={{ ...mono, fontSize: 12, fontWeight: 600, color: C.abyss, background: C.tide, border: "none", borderRadius: 5, padding: "7px 16px", cursor: "pointer" }}
              >
                re-sync
              </button>
            </div>
            {current.error && <div style={{ color: C.urchin, fontSize: 12.5, marginTop: 8 }}>{current.error}</div>}
          </div>
        )}

        {/* search + filters */}
        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter by package or source name…"
            aria-label="Filter packages"
            style={{ ...mono, fontSize: 13, flex: "1 1 260px", background: C.shallows, border: `1px solid ${C.poolEdge}`, borderRadius: 6, color: C.foam, padding: "9px 12px", outline: "none" }}
          />
          {[
            ["advisories", "with advisories"],
            ["drift", "with version drift"],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilters((f) => ({ ...f, [k]: !f[k] }))}
              aria-pressed={filters[k]}
              style={{
                ...mono,
                fontSize: 12,
                padding: "8px 12px",
                borderRadius: 6,
                cursor: "pointer",
                border: `1px solid ${filters[k] ? (k === "advisories" ? C.urchin : C.sand) : C.poolEdge}`,
                color: filters[k] ? (k === "advisories" ? C.urchin : C.sand) : C.mist,
                background: "transparent",
              }}
            >
              {label}
            </button>
          ))}
          <span style={{ ...mono, fontSize: 12, color: C.mist }}>
            {tableState === "syncing" ? "index syncing…" : `${table.total.toLocaleString()} matching`}
          </span>
        </div>

        {/* table */}
        {tableErr && <div style={{ color: C.urchin, marginTop: 14, fontSize: 13 }}>{tableErr}</div>}
        <div style={{ background: C.pool, border: `1px solid ${C.poolEdge}`, borderRadius: 8, marginTop: 14, overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                {["package", ...table.pocketOrder, "signals"].map((h) => (
                  <th
                    key={h}
                    style={{ ...mono, fontSize: 10.5, color: C.mist, textTransform: "uppercase", letterSpacing: "0.07em", textAlign: "left", padding: "10px 14px", borderBottom: `1px solid ${C.poolEdge}` }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.items.map((it) => (
                <tr key={it.name} onClick={() => setOpenPkg(it.name)} style={{ cursor: "pointer" }}>
                  <td style={{ padding: "8px 14px", borderBottom: `1px solid ${C.poolEdge}55` }}>
                    <div style={{ ...mono, fontSize: 13, color: C.foam }}>{it.name}</div>
                    {it.source !== it.name && <div style={{ ...mono, fontSize: 10.5, color: C.kelp }}>src {it.source}</div>}
                  </td>
                  {table.pocketOrder.map((p) => {
                    const v = it.versions[p];
                    const isCurrent = v && v === it.current && it.drift;
                    return (
                      <td key={p} style={{ ...mono, fontSize: 12, padding: "8px 14px", borderBottom: `1px solid ${C.poolEdge}55`, color: v ? (isCurrent ? C.tide : C.foam) : C.kelp, whiteSpace: "nowrap" }}>
                        {v || "·"}
                      </td>
                    );
                  })}
                  <td style={{ padding: "8px 14px", borderBottom: `1px solid ${C.poolEdge}55` }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {it.advisoryCount > 0 && <Chip color={C.urchin}>{it.advisoryCount} advisories</Chip>}
                      {it.drift && <Chip color={C.sand}>drift</Chip>}
                    </div>
                  </td>
                </tr>
              ))}
              {table.items.length === 0 && tableState === "idle" && (
                <tr>
                  <td colSpan={2 + table.pocketOrder.length} style={{ padding: 18, color: C.mist, fontSize: 13 }}>
                    Nothing matches. Clear the filter, or re-sync if this distro has never synced.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* pagination */}
        {pages > 1 && (
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              style={{ ...mono, fontSize: 12, padding: "6px 12px", borderRadius: 5, background: "transparent", border: `1px solid ${C.poolEdge}`, color: page <= 1 ? C.kelp : C.foam, cursor: page <= 1 ? "default" : "pointer" }}
            >
              ← prev
            </button>
            <span style={{ ...mono, fontSize: 12, color: C.mist }}>
              page {page} / {pages.toLocaleString()}
            </span>
            <button
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              style={{ ...mono, fontSize: 12, padding: "6px 12px", borderRadius: 5, background: "transparent", border: `1px solid ${C.poolEdge}`, color: page >= pages ? C.kelp : C.foam, cursor: page >= pages ? "default" : "pointer" }}
            >
              next →
            </button>
          </div>
        )}

        <footer style={{ borderTop: `1px solid ${C.poolEdge}`, marginTop: 40, paddingTop: 16, fontSize: 12.5, color: C.mist, lineHeight: 1.7 }}>
          Index sources, advisory feeds, page depth, and upstream hints are all declared in <span style={{ ...mono }}>tidepool.config.json</span> — edit and{" "}
          <span style={{ ...mono }}>POST /api/reload</span>. A failing source shows as a hatched marker with its error and endpoint; Tidepool never blends sources or hides a gap.
        </footer>
      </div>

      {openPkg && <PackageDrawer distro={active} name={openPkg} onClose={() => setOpenPkg(null)} />}
    </div>
  );
}
