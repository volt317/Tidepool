// server/src/cli/admin.ts
//
// The ADMINISTRATIVE CONTROL BOUNDARY: a local CLI over the collector's
// Unix control socket.
//
//   local CLI → admin Unix socket → collector
//
// This is the intended path for manual synchronization, snapshot creation,
// publication, and bounded enrichment — deliberately NOT the local-network
// API (which answers 405 for all of these). Reaching this tool requires
// filesystem access to the control socket, which per-service mounts and
// socket mode 0660 scope to the appliance owner.
//
// Usage:
//   tsx server/src/cli/admin.ts health
//   tsx server/src/cli/admin.ts sync <domain> <unit>
//   tsx server/src/cli/admin.ts sync-all
//   tsx server/src/cli/admin.ts snapshot [stage] [windowHours]
//   tsx server/src/cli/admin.ts publish
//   tsx server/src/cli/admin.ts enrich <domain> <unit> <package>
//   tsx server/src/cli/admin.ts enrich-changed [windowHours] [limit]
//   tsp server/src/cli/admin.ts maintenance
//
// Socket resolution: TIDEPOOL_CONTROL_SOCKET, else <dataDir>/run/….

import { loadConfig, resolveRuntimeDirs, socketPaths } from "../services/bootstrap.js";
import { udsRequest } from "../services/ipc.js";

function usage(): never {
  console.error(
    [
      "usage: admin <command> [...args]",
      "  health                                collector health + last publication",
      "  sync <domain> <unit>                  collect one configured unit",
      "  sync-all                              collect every configured unit",
      "  snapshot [stage] [windowHours]        create a snapshot (default interpretive, 168h)",
      "  publish                               publish a fresh read replica",
      "  enrich <domain> <unit> <package>      bounded enrichment of a known entity (recorded)",
      "  enrich-changed [windowHours] [limit]  policy enrichment of recently changed packages",
      "  maintenance                           checkpoint + vacuum + verify",
    ].join("\n")
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) usage();

  const { config, errors } = loadConfig();
  if (!config) {
    console.error("tidepool.config.json failed validation:", errors);
    process.exit(1);
  }
  const socket = socketPaths(resolveRuntimeDirs(config).runDir).control;

  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const r = await udsRequest(socket, method, path, body, { caller: `admin-cli:${process.env.USER ?? "?"}`, timeoutMs: 300_000 });
    console.log(JSON.stringify(r.body, null, 2));
    if (r.status >= 400) process.exit(1);
  };

  switch (cmd) {
    case "health":
      return call("GET", "/healthz");
    case "sync": {
      const [domain, unit] = args;
      if (!domain || !unit) usage();
      return call("POST", `/internal/domains/${encodeURIComponent(domain)}/units/${encodeURIComponent(unit)}/sync`);
    }
    case "sync-all":
      return call("POST", "/internal/control/sync-all");
    case "snapshot":
      return call("POST", "/internal/snapshots", {
        stage: args[0] ?? "interpretive",
        windowHours: args[1] ? Number(args[1]) : 168,
      });
    case "publish":
      return call("POST", "/internal/control/publish");
    case "enrich": {
      const [domain, unit, name] = args;
      if (!domain || !unit || !name) usage();
      return call("POST", "/internal/control/enrich", { domain, unit, package: name });
    }
    case "enrich-changed":
      return call("POST", "/internal/control/enrich-changed", {
        windowHours: args[0] ? Number(args[0]) : 24,
        limit: args[1] ? Number(args[1]) : 25,
      });
    case "maintenance":
      return call("POST", "/internal/control/maintenance");
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  console.error("is the collector running and the control socket reachable?");
  process.exit(1);
});
