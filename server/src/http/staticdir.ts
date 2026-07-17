// server/src/http/staticdir.ts — serve the built frontend from one
// directory, and nothing else. Path safety is resolve-then-prefix-check;
// the adversarial cases are covered in the binder tests and the
// http-security CI job.
import { createReadStream, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Handler, Response } from "./types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function sendFileFrom(rootDir: string, relPath: string, req: { method?: string }, res: Response): boolean {
  const root = resolve(rootDir);
  const target = resolve(join(root, relPath));
  if (target !== root && !target.startsWith(root + sep)) { res.status(403).json({ error: "forbidden" }); return true; }
  let st;
  try { st = statSync(target); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = target.slice(target.lastIndexOf("."));
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  res.setHeader("Content-Length", st.size);
  res.setHeader("Cache-Control", relPath.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.method === "HEAD") { res.end(); return true; }
  createReadStream(target).pipe(res);
  return true;
}

export function staticDir(rootDir: string): Handler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const rel = decodeURIComponent(req.path.replace(/^\/+/, ""));
    if (rel.includes("\0")) { res.status(400).json({ error: "bad path" }); return; }
    if (!sendFileFrom(rootDir, rel === "" ? "index.html" : rel, req, res)) next();
  };
}
