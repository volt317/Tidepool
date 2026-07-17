// server/src/http/body.ts — JSON body reading with a hard byte cap.
// UTF-8 only; wrong content-type or malformed JSON is the client's 4xx.
import type { Handler } from "./types.js";

export function json(opts: { limit?: number } = {}): Handler {
  const limit = opts.limit ?? 262_144; // 256kb
  return (req, res, next) => {
    if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return next();
    const ct = String(req.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { aborted = true; res.status(413).json({ error: "payload too large" }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      if (size === 0) { req.body = undefined; return next(); }
      if (!ct.startsWith("application/json")) { res.status(415).json({ error: "content-type must be application/json" }); return; }
      try { req.body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } 
      catch { res.status(400).json({ error: "malformed JSON body" }); return; }
      next();
    });
    req.on("error", () => { /* connection went away; nothing to answer */ });
  };
}
