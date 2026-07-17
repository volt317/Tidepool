// server/src/core/routes.ts
//
// The HTTP surface over the contained aggregation core. Domain-symmetric by
// construction: every route is /api/domains/:domain/units/:unit/…, and the
// handlers know nothing about apt pockets or registry surfaces.
//
// REFACTOR NOTE (deployment split): the handlers that used to live in this
// file were MOVED, unchanged, into two routers so that the containerized
// deployment can host them in separate, differently-privileged services:
//
//   routes.read.ts     GETs only — memory / disk cache / SQLite / snapshots.
//                      Hosted by the API service (no network egress,
//                      query-only database connection).
//   routes.control.ts  sync, enrich, snapshot creation — network egress and
//                      writes through the single SQLite writer connection.
//                      Hosted by the collector service (pod-internal only).
//
// buildRouter() composes both, so the single-process development mode
// (server/src/index.ts) and the existing tests see the identical surface
// they always did.

import { Router } from "../http/index.js";
import type { Aggregator } from "./aggregator.js";
import type { SnapshotStore } from "./snapshot.js";
import { buildReadRouter } from "./routes.read.js";
import { buildControlRouter } from "./routes.control.js";

export function buildRouter(agg: Aggregator, snapshots: SnapshotStore): Router {
  const r = Router();
  // control first: its POST /snapshots and sync/enrich routes must win over
  // (i.e. be reachable alongside) the read router's GET routes; the two sets
  // are method/path-disjoint, so order only matters for clarity.
  r.use(buildControlRouter(agg, snapshots));
  r.use(buildReadRouter(agg, snapshots));
  return r;
}
