// server/src/http/respond.ts — response helpers attached per-request.
// HEAD suppresses bodies but keeps headers/lengths (derived from GET
// handling in the router, matching prior framework behavior).
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { sendFileFrom } from "./staticdir.js";
import type { Request, Response } from "./types.js";

export function decorateResponse(req: Request, res: Response): void {
  const isHead = req.method === "HEAD";
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => {
    const text = JSON.stringify(body);
    const buf = Buffer.from(text, "utf8");
    // weak ETag → conditional GET keeps working for polling clients
    const etag = 'W/"' + createHash("sha256").update(buf).digest("hex").slice(0, 27) + '"';
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) { res.statusCode = 304; res.end(); return; }
    if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", buf.byteLength);
    res.end(isHead ? undefined : buf);
  };
  res.sendFile = (absPath: string) => {
    // single-file variant of the static server: same MIME map, same
    // HEAD handling; the path is code-chosen, not client-chosen
    if (!sendFileFrom(dirname(absPath), basename(absPath), req, res)) {
      res.status(404).json({ error: "not found" });
    }
  };
  res.send = (body: string | Buffer) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    if (!res.hasHeader("Content-Type")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", buf.byteLength);
    res.end(isHead ? undefined : buf);
  };
}
