# ADR 0009 — Strict local HTTP admission and self-managed TLS

Date: 2026-07-15
Status: accepted

## Context

The proxy (ADR 0008) was a ~150-line blind TCP→UDS forwarder: it moved
bytes and set a couple of headers. For a LAN-facing appliance that is too
permissive — it accepts any method, any path, any body, any framing, and
speaks plaintext. The appliance needs a protocol admission layer that
decides, for a connection that has *already reached* the listener, whether
it is a valid Tidepool request — without duplicating or claiming to replace
packet-level controls (firewall, network namespaces, AppArmor), which
remain the source of truth for reachability.

## Decision

The proxy becomes a deny-by-default HTTPS admission gate owning exactly one
layer: protocol admission.

- **Versioned route manifest** (`shared/httpPolicy.ts`): the complete
  appliance HTTP surface as data — method, normalized path shape, typed
  identifier params, declared query parameters, body policy, cache policy.
  The proxy and the tests compile against the same object, so surface and
  tests cannot drift. Anything absent is 404; a listed path with another
  method is 405; mutation verbs never appear (administration stays on the
  control socket).
- **Pure admission engine** (`services/httpAdmission.ts`): framing checks
  that fail closed before routing (duplicate `Host`/`Content-Length`,
  `CL`+`TE`, folding, control chars, bad header names), single canonical
  path normalization (reject `..`, encoded traversal, NUL, backslash,
  malformed `%`), route/param/query validation. Returns decisions, never
  throws — malformed input is data to reject with a stable code.
- **Independent API semantics**: the API rejects every non-GET/HEAD itself,
  not merely because the manifest omits mutation (defense in depth,
  acceptance criterion 12), and trusts forwarding headers only when the
  proxy's over-UDS marker is present.
- **Self-managed TLS** (`services/tls.ts`, `cli/tls.ts`): an openssl-backed
  local CA issues short-lived server certs with SANs from validated config.
  The CA private key stays host-side under `tls/ca/` (0600) and is never
  mounted into the proxy — only `tls/server/` is. `tls verify` and
  `boundaries-verify.sh` both assert that absence. Modes: local-CA
  (default), self-signed, provided, disabled.
- **Response hardening**: strict CSP (`default-src 'none'`, no inline),
  nosniff, frame-deny, COOP/CORP same-origin, no `Server`/`X-Powered-By`,
  per-artifact caching, CORS off by default, structured non-disclosing
  error bodies.
- **Config**: a validated `http` block (listener, allowlist, tls, auth,
  limits) with safe floors/ceilings on every limit; unknown keys rejected.
- **CI**: `http-security.yml` generates a temp CA, runs the admission
  matrix, security headers, TLS version policy, raw-socket framing tests,
  and CA-key confinement.

## Consequences

- The proxy's mount set grows by exactly one read-only subtree
  (`tls/server/`); its AppArmor profile denies `tls/ca/**` by name.
- Development mode keeps plaintext-on-loopback and the mutation routes, and
  warns that appliance HTTP guarantees are not active; standalone and
  appliance modes share the manifest.
- Honest boundary: the proxy holds a network namespace with outbound routes
  (rootless has no inbound-only mode), so "no egress" for it remains a
  code + nftables property, not a container flag — unchanged from ADR 0008
  and restated here. The HTTP layer makes no packet-level claim at all.
