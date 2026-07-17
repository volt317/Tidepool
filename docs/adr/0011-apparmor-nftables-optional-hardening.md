# ADR 0011 — AppArmor and nftables demoted from required layers to optional hardening

Date: 2026-07-16
Status: accepted

## Context

The rootless quadlet units shipped with
`PodmanArgs=--security-opt apparmor=tidepool-<service>`, the enforcement
table claimed AppArmor-backed guarantees, and the install's printed root
steps treated profile loading and the nftables ruleset as part of the
standard path. First deployment on real hardware falsified the AppArmor
half: podman refuses custom AppArmor profiles for rootless containers on
every version to date. The check is the first line of
`ApparmorVerifier.IsSupported()` in containers/common (verified in
v0.57.4 — vendored by podman 4.9.3 — v0.58.0, v0.60.0, and `main`):

```go
if a.impl.UnshareIsRootless() {
    return errors.New("AppAmor is not supported on rootless containers")
}
```

`setupApparmor` then reports the misleading error *"apparmor profile
specified, but Apparmor is not enabled on this system"*. The kernel is not
the constraint: unprivileged processes may legally enter a pre-loaded
profile (asymmetric by design — loading policy needs CAP_MAC_ADMIN;
volunteering for confinement does not; `aa-exec -p tidepool-api` on a
host with the profiles loaded demonstrates enforcement without privilege).
The refusal is a userspace policy in podman that conflates
generate-and-load (genuinely impossible rootless) with apply-pre-loaded
(legal). Docker shares the same gap.

CI never caught this because `ci-topology.sh` added the security-opt only
after an *unprivileged* read of `/sys/kernel/security/apparmor/profiles`,
which typically fails — so CI silently ran unconfined and stayed green.
A second, independent failure: the units hard-coded the opt while the
topology made it conditional, so the confined configuration was first
exercised on an operator's machine.

nftables is different: the layer works (root loads it; podman is never
involved), but as shipped it is operationally hazardous — it confines the
*entire uid*, and the default placeholder uid is 1000, i.e. a login
account. Its value genuinely requires the dedicated-user deployment.

## Decision

1. The rootless deployment makes no AppArmor-backed claims. The
   `--security-opt apparmor=` args are removed from the unit templates,
   `ci-topology.sh`, and `verify-corpus.sh` (where a loaded profile would
   have *failed* the verification container on exactly the machines that
   applied the hardening).
2. Both layers move to a documented **Optional hardening** section in
   `deploy/README.md` that states what each uniquely provides, why it is
   absent from the default path, and how to apply it when circumstances
   allow (AppArmor: rootful podman, or unverified outside-in confinement
   via systemd `AppArmorProfile=`/`aa-exec` wrappers; nftables: dedicated
   user account, then load).
3. The enforcement table is rewritten to claim only what binds in the
   default deployment, and explicitly names the two claims it no longer
   makes: exec restriction ("only node executes" — AppArmor was the sole
   layer) and collector egress narrowing (nftables was the sole layer).
4. Profiles, the nftables template, render support, and parse checks
   (`verify-render.sh`) remain in-tree so the artifacts cannot rot.
   `verify-apparmor.sh` becomes a standalone hardened-install check;
   `boundaries-verify.sh` asserts the exec boundary only when a container
   is actually confined, and attributes dual-layer boundaries to the
   layer that still enforces them.

## Consequences

* The project's own rule — no claim stronger than its enforcement — is
  restored. The cost is stated plainly: in the default deployment a
  compromised service can execute a shell inside its (mount-restricted,
  network-less, keep-id) container, and collector egress is unfiltered
  unless the operator applies the nftables layer.
* Every remaining guarantee in the table is enforced by mechanisms that
  demonstrably bind under rootless podman: namespace absence, the mount
  matrix, read-only intent at the DB layer, the HTTP admission gate, and
  unit-level facts verified by the deployment checks.
* If podman gains rootless support for pre-loaded profiles (the kernel
  capability exists; Landlock and AppArmor policy namespaces both signal
  the direction), reinstating the layer is a template change plus
  reverting item 1 — and this ADR is where that decision gets reargued.
