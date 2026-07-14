// server/src/services/ipc.ts
//
// The control-plane transport: JSON-over-HTTP on UNIX DOMAIN SOCKETS.
// Deployment-evolution addition — the collector's control surface moved off
// TCP entirely; consumers (scheduler, admin CLI, verification tooling) dial
// the socket path, which filesystem permissions and per-service mount
// namespaces scope far more narrowly than a port ever could.
//
// The protocol is deliberately narrow: fixed operation paths, small JSON
// bodies, bounded response size, request IDs for attribution. Arbitrary
// URLs, shell arguments, and filesystem paths are not part of any request
// shape, and the collector validates every referenced unit/package against
// its loaded configuration before acting.

import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface IpcResponse {
  status: number;
  body: unknown;
  requestId: string;
}

export function udsRequest(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; caller?: string } = {}
): Promise<IpcResponse> {
  const requestId = randomUUID();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          "x-caller": opts.caller ?? "unknown",
          ...(payload ? { "content-length": String(payload.length) } : {}),
        },
        timeout: opts.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("control response exceeded size bound"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* non-JSON error bodies stay as text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, requestId });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("control request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
