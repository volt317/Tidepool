// server/src/http/query.ts — flat query parsing. Every call site reads
// simple scalar params; nested/bracket syntax is deliberately unsupported.
export function parseQuery(url: string): { path: string; query: Record<string, string> } {
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  const query: Record<string, string> = {};
  if (q !== -1) {
    for (const [k, v] of new URLSearchParams(url.slice(q + 1))) query[k] = v;
  }
  return { path, query };
}
