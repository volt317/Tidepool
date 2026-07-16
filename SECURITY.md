# Security Policy

## Supported versions

Tidepool is pre-1.0. Only the tip of `main` is supported; there are no
backported fixes. Deployments should track tagged releases and update by
rebuilding images (`deploy/README.md`, "Updating").

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/volt317/Tidepool/security/advisories/new)
rather than a public issue — particularly anything touching:

* the corpus write path or observation immutability (a way to rewrite or
  erase recorded evidence is the most severe class of issue for this
  project);
* the appliance isolation boundaries (collector-only egress, read-only API,
  the Unix control socket, AppArmor/nftables enforcement);
* signature/digest verification of upstream sources (a way to make an
  unverified source report `signature+digest`);
* snapshot digest integrity (two different corpora yielding one digest, or
  one corpus yielding two).

Include the commit you tested, a reproduction, and which stated guarantee
(see `docs/OVERVIEW.md` §3 and the enforcement table in `deploy/README.md`)
you believe is violated. Claims are scoped to what those documents state is
enforced — standalone `npm start` mode deliberately provides no isolation
guarantees.

Expect an acknowledgment within a week. Coordinated disclosure is
appreciated; a fix and advisory will credit the reporter unless anonymity
is requested.
