// server/src/http/index.ts — the router/app core plus a drop-in default
// export matching the framework surface this codebase actually used:
// express() / express.json / express.static / express.Router. Import-line
// compatibility was the design goal: route files change one line.
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decorateResponse } from "./respond.js";
import { parseQuery } from "./query.js";
import { json } from "./body.js";
import { staticDir, sendFileFrom } from "./staticdir.js";
import type { Handler, NextFunction, Request, Response } from "./types.js";
export type { Handler, NextFunction, Request, Response } from "./types.js";
export { rateLimit } from "./ratelimit.js";

type Layer = { method: string | null; pattern: string | RegExp | null; prefix: boolean; handlers: Handler[] };

/** Match "/domains/:domain/units/:unit" style patterns segment-wise. */
function matchPattern(pattern: string, path: string, prefix: boolean): Record<string, string> | null {
  const ps = pattern.split("/").filter(Boolean);
  const xs = path.split("/").filter(Boolean);
  if (prefix ? xs.length < ps.length : xs.length !== ps.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    else if (ps[i] !== xs[i]) return null;
  }
  return params;
}

export interface Router extends Handler {
  get(pattern: string | RegExp, ...h: Handler[]): void;
  post(pattern: string | RegExp, ...h: Handler[]): void;
  use(patternOrHandler: string | Handler, ...h: Handler[]): void;
}

export function Router(): Router {
  const layers: Layer[] = [];
  const dispatch = ((req: Request, res: Response, done: NextFunction) => {
    const method = req.method === "HEAD" ? "GET" : req.method; // HEAD derives from GET
    let i = 0;
    const savedPath = req.path;
    const setPath = (p: string) => { try { req.path = p; } catch { /* foreign req with getter-only path */ } };
    const step: NextFunction = (err?: unknown) => {
      setPath(savedPath);
      if (err) return done(err);
      const layer = layers[i++];
      if (!layer) return done();
      if (layer.method && layer.method !== method) return step();
      let params: Record<string, string> | null = {};
      if (layer.pattern instanceof RegExp) {
        if (!layer.pattern.test(req.path)) return step();
      } else if (layer.pattern !== null) {
        params = matchPattern(layer.pattern, req.path, layer.prefix);
        if (!params) return step();
        if (layer.prefix) {
          const consumed = layer.pattern.split("/").filter(Boolean).length;
          setPath("/" + req.path.split("/").filter(Boolean).slice(consumed).join("/"));
        }
      }
      req.params = { ...req.params, ...params };
      let j = 0;
      const runHandler: NextFunction = (herr?: unknown) => {
        if (herr) return done(herr);
        const h = layer.handlers[j++];
        if (!h) return step();
        try {
          const out = h(req, res, runHandler);
          if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(done);
        } catch (e) { done(e); }
      };
      runHandler();
    };
    step();
  }) as Router;
  dispatch.get = (pattern, ...h) => layers.push({ method: "GET", pattern, prefix: false, handlers: h });
  dispatch.post = (pattern, ...h) => layers.push({ method: "POST", pattern, prefix: false, handlers: h });
  dispatch.use = (a, ...h) => {
    if (typeof a === "string" || a instanceof RegExp) layers.push({ method: null, pattern: a as string, prefix: true, handlers: h });
    else layers.push({ method: null, pattern: null, prefix: false, handlers: [a as Handler, ...h] });
  };
  return dispatch;
}

export interface App extends Router {
  disable(_flag: string): void;
  listen(...args: unknown[]): Server;
}

function createApp(): App {
  const router = Router() as App;
  const requestListener = (rawReq: IncomingMessage, rawRes: ServerResponse) => {
    const req = rawReq as Request;
    const res = rawRes as Response;
    const { path, query } = parseQuery(req.url ?? "/");
    req.path = path;
    req.query = query;
    req.params = {};
    req.header = (name: string) => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    decorateResponse(req, res);
    router(req, res, (err?: unknown) => {
      if (res.writableEnded) return;
      if (err) { res.status(500).json({ error: "internal error" }); return; }
      res.status(404).json({ error: "not found" });
    });
  };
  router.disable = () => { /* x-powered-by never sent in the first place */ };
  router.listen = (...args: unknown[]) =>
    (createServer(requestListener) as Server & { listen: (...a: unknown[]) => Server }).listen(...args);
  return router;
}

export { json, staticDir, sendFileFrom };
const expressCompat = Object.assign(createApp, { json, static: staticDir, Router });
export default expressCompat;
