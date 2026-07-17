# ADR 0011 — Host-level MAC and firewall integrations removed

Date: 2026-07-16
Status: accepted (supersedes the shipped-but-inapplicable layers)

This is the single remaining record of two enforcement layers this project
once shipped, so their removal cannot be mistaken for their never having
been considered.

**A per-service MAC layer (AppArmor)** was removed because rootless podman
categorically refuses custom profiles — verified in containers/common
v0.57.4 (vendored by podman 4.9.3) through `main`: `IsSupported()` returns
an error on `IsRootless()` before consulting the kernel, and the runtime
reports the misleading error "Apparmor is not enabled on this system".
The kernel permits unprivileged entry into pre-loaded profiles; the
refusal is userspace policy (Docker shares it). The shipped units could
therefore never start on a host that loaded the profiles, and CI's
conditional silently omitted the flags, so the confined configuration was
never exercised anywhere.

**A host firewall ruleset (nftables)** was removed from the project's
scope because rootless container egress is user-level traffic: the rules
necessarily confine the entire uid, which is an operator/host decision
(dedicated account, site-specific resolvers and subnets), not something a
repository can ship safely as a default.

What the removal costs, stated plainly: the deployment does not restrict
which programs execute inside a container beyond the mount matrix and
image contents, and collector egress is unfiltered at the host. What
remains enforced: namespace absence (`Network=none`), the per-service
mount matrix, keep-id, read-only intent at the DB layer, the HTTP
admission gate, and image discipline.

## Consequences

The role these layers played should be re-filled by *self-service*
primitives that bind under rootless podman without anyone's permission:
capability drop + NoNewPrivileges, read-only root filesystems with
noexec/nosuid/nodev writable mounts, seccomp, and the Node permission
model. Those are unit- and process-level changes, verifiable by
`boundaries-verify.sh`, and are tracked as the hardening roadmap.
