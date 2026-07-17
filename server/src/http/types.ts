// server/src/http/types.ts — the HTTP contract the rest of the server codes
// against. Every member here exists because a call site uses it; nothing
// speculative. (This directory replaces the express + express-rate-limit
// dependency closure — 69 packages — with ~300 audited local lines.)
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Request extends IncomingMessage {
  params: Record<string, string>;
  query: Record<string, string>;
  path: string;
  // matches the prior framework's typing so control-route call sites are
  // unchanged; the admission gate and schema checks own body validation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
  header(name: string): string | undefined;
}

export interface Response extends ServerResponse {
  status(code: number): Response;
  json(body: unknown): void;
  send(body: string | Buffer): void;
  sendFile(absPath: string): void;
}

export type NextFunction = (err?: unknown) => void;
export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
