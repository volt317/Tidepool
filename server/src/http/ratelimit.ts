// server/src/http/ratelimit.ts — fixed-window limiter, per remote address
// (or "local" over the Unix socket, where the proxy admission gate is the
// real front door). Emits draft standard RateLimit-* headers as before.
import type { Handler } from "./types.js";

// standardHeaders/legacyHeaders accepted for call-site compatibility:
// standard headers are always emitted, legacy ones never were kept.
export function rateLimit(opts: { windowMs: number; limit: number; standardHeaders?: boolean; legacyHeaders?: boolean }): Handler {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.max(opts.windowMs, 30_000)).unref();
  return (req, res, next) => {
    const key = req.socket.remoteAddress ?? "local";
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) { e = { n: 0, reset: now + opts.windowMs }; hits.set(key, e); }
    e.n += 1;
    const remaining = Math.max(0, opts.limit - e.n);
    res.setHeader("RateLimit-Limit", opts.limit);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", Math.ceil((e.reset - now) / 1000));
    if (e.n > opts.limit) { res.status(429).json({ error: "rate limit exceeded" }); return; }
    next();
  };
}
export default rateLimit;
