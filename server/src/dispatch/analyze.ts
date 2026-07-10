// server/src/dispatch/analyze.ts
//
// The project-evaluation boundary. This module consumes a Tidepool truth
// snapshot and one or more filesystem paths; it never collects upstream data
// and is deliberately not embedded in any collector. Class-specific analyzers
// decide relevance — the aggregator is never asked to pre-filter its inflow.
//
// v1 analyzer coverage (honest scope):
//   rust-workspace   Cargo.toml + Cargo.lock          → crates-io units
//   node-project     package.json + package-lock.json → npm units
//   python-project   requirements.txt / pyproject     → pypi units
//   c-cpp-project    vcpkg.json / conanfile.txt       → vcpkg / conan units
//   linux-package    debian/control                   → apt distro units
//   container-image  Dockerfile FROM lines            → mapped distro units
//   kernel-module    Kbuild / obj-m Makefile          → detected; findings
//                                                       limited to distro kernel entities
//   mixed-monorepo   ≥2 classes across subdirectories
// Anything else classifies as `unrecognized` and yields an explicit
// insufficient-evidence finding rather than silence.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  DispatchArtifact,
  DispatchFinding,
  ProjectClass,
  ProjectDependency,
  ProjectProfile,
  SnapshotDoc,
  SnapshotEntity,
} from "../../../shared/types.js";
import { debCompare, sha256hex } from "../lib/util.js";
import { digestOf } from "../core/inflow.js";

export const ANALYZER_VERSIONS: Record<string, string> = {
  classifier: "1",
  fingerprint: "1",
  "rust-workspace": "1",
  "node-project": "1",
  "python-project": "1",
  "c-cpp-project": "1",
  "linux-package": "1",
  "container-image": "1",
  "kernel-module": "1",
  dispatch: "1",
};

// ------------------------------------------------------------ classification

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);

interface Detection {
  cls: ProjectClass;
  languages: string[];
  buildSystems: string[];
  manifests: string[];
  deps: ProjectDependency[];
  baseImages: string[];
}

function detectRust(dir: string): Detection | null {
  const toml = read(join(dir, "Cargo.toml"));
  if (!toml) return null;
  const manifests = ["Cargo.toml"];
  const deps: ProjectDependency[] = [];
  // Cargo.lock gives exact versions; Cargo.toml gives names when no lock
  const lock = read(join(dir, "Cargo.lock"));
  if (lock) {
    manifests.push("Cargo.lock");
    for (const block of lock.split("[[package]]").slice(1)) {
      const name = /name\s*=\s*"([^"]+)"/.exec(block)?.[1];
      const version = /version\s*=\s*"([^"]+)"/.exec(block)?.[1];
      if (name && version) deps.push({ ecosystem: "crates-io", name, version, origin: "Cargo.lock" });
    }
  } else {
    const depSection = /\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(toml)?.[1] ?? "";
    for (const m of depSection.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) {
      deps.push({ ecosystem: "crates-io", name: m[1], version: null, origin: "Cargo.toml" });
    }
  }
  return {
    cls: "rust-workspace",
    languages: ["rust"],
    buildSystems: ["cargo"],
    manifests,
    deps,
    baseImages: [],
  };
}

function detectNode(dir: string): Detection | null {
  const pkg = read(join(dir, "package.json"));
  if (!pkg) return null;
  const manifests = ["package.json"];
  const deps: ProjectDependency[] = [];
  const lock = read(join(dir, "package-lock.json"));
  if (lock) {
    manifests.push("package-lock.json");
    try {
      const parsed = JSON.parse(lock) as { packages?: Record<string, { version?: string }> };
      for (const [path, info] of Object.entries(parsed.packages ?? {})) {
        const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
        if (m && info.version) deps.push({ ecosystem: "npm", name: m[1], version: info.version, origin: "package-lock.json" });
      }
    } catch {
      /* malformed lock: fall through to manifest deps */
    }
  }
  if (deps.length === 0) {
    try {
      const parsed = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const [name, range] of Object.entries({ ...parsed.dependencies, ...parsed.devDependencies })) {
        deps.push({ ecosystem: "npm", name, version: /^\d/.test(range) ? range : null, origin: "package.json" });
      }
    } catch {
      /* unparseable manifest handled by empty deps */
    }
  }
  return { cls: "node-project", languages: ["javascript"], buildSystems: ["npm"], manifests, deps, baseImages: [] };
}

function detectPython(dir: string): Detection | null {
  const req = read(join(dir, "requirements.txt"));
  const pyproject = read(join(dir, "pyproject.toml"));
  if (!req && !pyproject) return null;
  const manifests: string[] = [];
  const deps: ProjectDependency[] = [];
  if (req) {
    manifests.push("requirements.txt");
    for (const line of req.split("\n")) {
      const m = /^\s*([A-Za-z0-9._-]+)\s*(?:==\s*([A-Za-z0-9.]+))?/.exec(line.split("#")[0]);
      if (m?.[1]) deps.push({ ecosystem: "pypi", name: m[1].toLowerCase(), version: m[2] ?? null, origin: "requirements.txt" });
    }
  }
  if (pyproject) {
    manifests.push("pyproject.toml");
    const depBlock = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(pyproject)?.[1] ?? "";
    for (const m of depBlock.matchAll(/"([A-Za-z0-9._-]+)\s*(?:==\s*([A-Za-z0-9.]+))?[^"]*"/g)) {
      deps.push({ ecosystem: "pypi", name: m[1].toLowerCase(), version: m[2] ?? null, origin: "pyproject.toml" });
    }
  }
  return { cls: "python-project", languages: ["python"], buildSystems: ["pip"], manifests, deps, baseImages: [] };
}

function detectCpp(dir: string): Detection | null {
  const vcpkg = read(join(dir, "vcpkg.json"));
  const conan = read(join(dir, "conanfile.txt"));
  const cmake = existsSync(join(dir, "CMakeLists.txt"));
  if (!vcpkg && !conan && !cmake) return null;
  const manifests: string[] = [];
  const deps: ProjectDependency[] = [];
  if (vcpkg) {
    manifests.push("vcpkg.json");
    try {
      const parsed = JSON.parse(vcpkg) as { dependencies?: (string | { name: string })[] };
      for (const d of parsed.dependencies ?? []) {
        const name = typeof d === "string" ? d : d.name;
        deps.push({ ecosystem: "vcpkg", name, version: null, origin: "vcpkg.json" });
      }
    } catch {
      /* malformed manifest tolerated */
    }
  }
  if (conan) {
    manifests.push("conanfile.txt");
    const reqBlock = /\[requires\]([\s\S]*?)(\n\[|$)/.exec(conan)?.[1] ?? "";
    for (const line of reqBlock.split("\n")) {
      const m = /^\s*([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/.exec(line);
      if (m) deps.push({ ecosystem: "conan", name: m[1], version: m[2], origin: "conanfile.txt" });
    }
  }
  if (cmake) manifests.push("CMakeLists.txt");
  return {
    cls: "c-cpp-project",
    languages: ["c", "c++"],
    buildSystems: cmake ? ["cmake"] : [],
    manifests,
    deps,
    baseImages: [],
  };
}

function detectDeb(dir: string): Detection | null {
  const control = read(join(dir, "debian", "control"));
  if (!control) return null;
  const deps: ProjectDependency[] = [];
  const bd = /Build-Depends:\s*([\s\S]*?)(\n\S|$)/.exec(control)?.[1] ?? "";
  for (const part of bd.split(",")) {
    const m = /^\s*([a-z0-9.+-]+)/.exec(part.trim());
    if (m) deps.push({ ecosystem: "apt", name: m[1], version: null, origin: "debian/control Build-Depends" });
  }
  return {
    cls: "linux-package",
    languages: [],
    buildSystems: ["debhelper"],
    manifests: ["debian/control"],
    deps,
    baseImages: [],
  };
}

const BASE_IMAGE_UNITS: [RegExp, string][] = [
  [/^ubuntu:(24\.04|noble)/, "ubuntu-noble"],
  [/^debian:(12|bookworm)/, "debian-bookworm"],
  [/^alpine:3\.20/, "alpine-3.20"],
  [/^archlinux/, "arch"],
];

function detectContainer(dir: string): Detection | null {
  const docker = read(join(dir, "Dockerfile")) ?? read(join(dir, "Containerfile"));
  if (!docker) return null;
  const baseImages: string[] = [];
  for (const m of docker.matchAll(/^FROM\s+([^\s]+)/gim)) {
    if (!m[1].startsWith("scratch")) baseImages.push(m[1].toLowerCase());
  }
  return {
    cls: "container-image",
    languages: [],
    buildSystems: ["docker"],
    manifests: ["Dockerfile"],
    deps: [],
    baseImages,
  };
}

function detectKernelModule(dir: string): Detection | null {
  const kbuild = read(join(dir, "Kbuild")) ?? read(join(dir, "Makefile"));
  if (!kbuild || !/obj-m\s*[+:]?=/.test(kbuild)) return null;
  return {
    cls: "kernel-module",
    languages: ["c"],
    buildSystems: ["kbuild"],
    manifests: [existsSync(join(dir, "Kbuild")) ? "Kbuild" : "Makefile"],
    deps: [{ ecosystem: "apt", name: "linux-libc-dev", version: null, origin: "kbuild toolchain requirement" }],
    baseImages: [],
  };
}

const DETECTORS = [detectRust, detectNode, detectPython, detectCpp, detectDeb, detectContainer, detectKernelModule];

export function classifyPath(path: string): ProjectProfile {
  const dir = resolve(path);
  let detections = DETECTORS.map((d) => d(dir)).filter((x): x is Detection => !!x);

  // monorepo scan: one level of subdirectories when the root is ambiguous
  const subDetections: Detection[] = [];
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const entry of readdirSync(dir).slice(0, 200)) {
      const sub = join(dir, entry);
      try {
        if (!statSync(sub).isDirectory() || entry.startsWith(".") || entry === "node_modules") continue;
      } catch {
        continue;
      }
      for (const d of DETECTORS) {
        const hit = d(sub);
        if (hit) subDetections.push({ ...hit, manifests: hit.manifests.map((m) => `${entry}/${m}`) });
      }
    }
  }
  const classes = new Set(detections.map((d) => d.cls));
  for (const d of subDetections) classes.add(d.cls);
  if (classes.size >= 2 && subDetections.length > 0) {
    detections = [...detections, ...subDetections];
    classes.add("mixed-monorepo");
  } else if (detections.length === 0 && subDetections.length > 0) {
    detections = subDetections;
  }

  const manifests = [...new Set(detections.flatMap((d) => d.manifests))].sort();
  const fingerprint = sha256hex(
    Buffer.from(
      manifests
        .map((m) => {
          const body = read(join(dir, m)) ?? "";
          return `${m}\u0000${sha256hex(Buffer.from(body))}`;
        })
        .join("\n")
    )
  );

  return {
    path: dir,
    classes: detections.length ? [...new Set(detections.map((d) => d.cls)), ...(classes.has("mixed-monorepo") ? ["mixed-monorepo" as ProjectClass] : [])].filter((v, i, a) => a.indexOf(v) === i) : ["unrecognized"],
    languages: [...new Set(detections.flatMap((d) => d.languages))],
    buildSystems: [...new Set(detections.flatMap((d) => d.buildSystems))],
    manifests,
    dependencies: dedupeDeps(detections.flatMap((d) => d.deps)),
    baseImages: [...new Set(detections.flatMap((d) => d.baseImages))].map((image) => ({
      image,
      unit: BASE_IMAGE_UNITS.find(([re]) => re.test(image))?.[1] ?? null,
    })),
    fingerprint,
  };
}

function dedupeDeps(deps: ProjectDependency[]): ProjectDependency[] {
  const seen = new Map<string, ProjectDependency>();
  for (const d of deps) {
    const k = `${d.ecosystem}\u0000${d.name}`;
    const prior = seen.get(k);
    if (!prior || (!prior.version && d.version)) seen.set(k, d);
  }
  return [...seen.values()].sort((a, b) => (a.ecosystem + a.name).localeCompare(b.ecosystem + b.name));
}

// ------------------------------------------------------------------ findings

/** Which snapshot units serve which local ecosystems. */
function unitsFor(ecosystem: string, snapshot: SnapshotDoc): string[] {
  const kinds: Record<string, (u: string) => boolean> = {
    "crates-io": (u) => u.includes("crates-io"),
    npm: (u) => u.endsWith("/npm"),
    pypi: (u) => u.endsWith("/pypi"),
    vcpkg: (u) => u.endsWith("/vcpkg"),
    conan: (u) => u.endsWith("/conan"),
    apt: (u) => u.startsWith("distro/"),
  };
  const match = kinds[ecosystem];
  return match ? snapshot.scope.units.filter(match) : [];
}

const entityKey = (e: SnapshotEntity) => `${e.domain}/${e.unit}/${e.name}`;

export function analyzeAgainstSnapshot(profiles: ProjectProfile[], snapshot: SnapshotDoc): DispatchArtifact {
  const findings: DispatchFinding[] = [];
  const ambiguities: string[] = [];
  const entityIndex = new Map<string, SnapshotEntity[]>();
  for (const e of snapshot.entities) {
    entityIndex.set(`${e.unit}\u0000${e.name}`, [...(entityIndex.get(`${e.unit}\u0000${e.name}`) ?? []), e]);
  }
  const changesByPkg = new Map<string, typeof snapshot.changes>();
  for (const c of snapshot.changes) {
    if (!c.package) continue;
    const k = `${c.unit}\u0000${c.package}`;
    changesByPkg.set(k, [...(changesByPkg.get(k) ?? []), c]);
  }

  for (const profile of profiles) {
    if (profile.classes.includes("unrecognized")) {
      findings.push({
        path: profile.path,
        kind: "insufficient-evidence",
        subject: profile.path,
        summary: "No supported project class detected at this path; no analyzer applies.",
        confidence: 0.9,
        confidenceBasis: "classifier found none of the supported markers",
        evidence: { snapshotEntities: [], changes: [], localOrigins: [] },
        recommendedAction: "verify the path, or extend the classifier for this project type",
      });
      continue;
    }

    let anyRelevant = false;
    for (const dep of profile.dependencies) {
      const units = unitsFor(dep.ecosystem, snapshot);
      if (units.length === 0) {
        findings.push({
          path: profile.path,
          kind: "insufficient-evidence",
          subject: `${dep.ecosystem}/${dep.name}`,
          summary: `Local dependency ${dep.name} (${dep.ecosystem}) has no matching unit in the snapshot scope.`,
          confidence: 0.8,
          confidenceBasis: "snapshot scope declares its units; this ecosystem is not among them",
          evidence: { snapshotEntities: [], changes: [], localOrigins: [dep.origin] },
          recommendedAction: `add a ${dep.ecosystem} unit (or widen its scope) in tidepool.config.json and re-snapshot`,
        });
        continue;
      }
      for (const unitPath of units) {
        const unit = unitPath.split("/")[1];
        const entities = entityIndex.get(`${unit}\u0000${dep.name}`) ?? [];
        if (entities.length === 0) {
          findings.push({
            path: profile.path,
            kind: "insufficient-evidence",
            subject: `${unitPath}/${dep.name}`,
            summary: `${dep.name} is not within the snapshot's ${unitPath} scope — bounded truth, not proof of absence.`,
            confidence: 0.7,
            confidenceBasis: "snapshot entities are bounded by configured scopes",
            evidence: { snapshotEntities: [], changes: [], localOrigins: [dep.origin] },
            recommendedAction: `add ${dep.name} to the ${unit} unit's scope to bring it under observation`,
          });
          continue;
        }
        anyRelevant = true;
        for (const ent of entities) {
          const pkgChanges = changesByPkg.get(`${unit}\u0000${dep.name}`) ?? [];
          const advisoryChanges = pkgChanges.filter((c) => c.kind.startsWith("advisory-"));
          const versionMoves = pkgChanges.filter((c) => c.kind === "version-moved");

          if (advisoryChanges.length > 0 || ent.advisoryCount > 0) {
            findings.push({
              path: profile.path,
              kind: "security-review-required",
              subject: entityKey(ent),
              summary: `${dep.name}: ${ent.advisoryCount} joined advisories${advisoryChanges.length ? `, ${advisoryChanges.length} advisory event(s) in the window` : ""}; local ${dep.version ?? "(unpinned)"} vs upstream ${ent.current ?? "?"}.`,
              confidence: 0.8,
              confidenceBasis: "advisory join / advisory change records on the exact package name",
              evidence: {
                snapshotEntities: [entityKey(ent)],
                changes: advisoryChanges.map((c) => c.id),
                localOrigins: [dep.origin],
              },
              recommendedAction: "review the advisories against the locally locked version",
            });
          }

          if (dep.version && ent.current) {
            const cmp = debCompare(dep.version, ent.current);
            if (cmp < 0) {
              findings.push({
                path: profile.path,
                kind: "dependency-update-available",
                subject: entityKey(ent),
                summary: `${dep.name}: local ${dep.version} < upstream ${ent.current} (${unitPath}).`,
                confidence: 0.9,
                confidenceBasis: "dpkg-semantic comparison of locked version vs snapshot current",
                evidence: {
                  snapshotEntities: [entityKey(ent)],
                  changes: versionMoves.map((c) => c.id),
                  localOrigins: [dep.origin],
                },
                recommendedAction: `update ${dep.name} to ${ent.current} and re-lock`,
              });
            } else if (versionMoves.length > 0) {
              findings.push({
                path: profile.path,
                kind: "informational-upstream-change",
                subject: entityKey(ent),
                summary: `${dep.name} moved upstream during the window but local ${dep.version} already satisfies current ${ent.current}.`,
                confidence: 0.85,
                confidenceBasis: "version movement in window with local >= current",
                evidence: { snapshotEntities: [entityKey(ent)], changes: versionMoves.map((c) => c.id), localOrigins: [dep.origin] },
                recommendedAction: "none required",
              });
            }
          } else if (!dep.version) {
            ambiguities.push(`${profile.path}: ${dep.name} (${dep.ecosystem}) is unpinned locally — update posture cannot be evaluated`);
          }
        }
      }
    }

    // container base images → distro units
    for (const base of profile.baseImages) {
      if (!base.unit) {
        ambiguities.push(`${profile.path}: base image ${base.image} maps to no configured distro unit`);
        continue;
      }
      const unitPath = `distro/${base.unit}`;
      if (!snapshot.scope.units.includes(unitPath)) continue;
      anyRelevant = true;
      const secMoves = snapshot.changes.filter(
        (c) => c.unit === base.unit && c.kind === "version-moved" && c.sourceId.includes("security")
      );
      if (secMoves.length > 0) {
        findings.push({
          path: profile.path,
          kind: "rebuild-recommended",
          subject: unitPath,
          summary: `Base image ${base.image}: ${secMoves.length} security-pocket version movement(s) in the window.`,
          confidence: 0.6,
          confidenceBasis:
            "security-pocket movements in the base distro; the image's installed package set is not known to the analyzer",
          evidence: { snapshotEntities: [], changes: secMoves.slice(0, 50).map((c) => c.id), localOrigins: ["Dockerfile"] },
          recommendedAction: "rebuild the image to pick up base security updates, then retest",
        });
      }
    }

    if (!anyRelevant && !profile.classes.includes("unrecognized")) {
      findings.push({
        path: profile.path,
        kind: "no-relevant-upstream-change",
        subject: profile.path,
        summary: "No snapshot entity or change intersects this project's extracted dependencies.",
        confidence: 0.7,
        confidenceBasis: "exhaustive match of extracted dependencies against snapshot scope",
        evidence: { snapshotEntities: [], changes: [], localOrigins: profile.manifests },
        recommendedAction: "none; widen unit scopes if coverage is intended",
      });
    }
  }

  // shared exposure across targets
  const sharedExposure: DispatchArtifact["sharedExposure"] = [];
  const depPaths = new Map<string, Set<string>>();
  for (const p of profiles) {
    for (const d of p.dependencies) {
      const k = `${d.ecosystem}\u0000${d.name}`;
      depPaths.set(k, (depPaths.get(k) ?? new Set()).add(p.path));
    }
  }
  for (const [k, paths] of depPaths) {
    if (paths.size < 2) continue;
    const [ecosystem, name] = k.split("\u0000");
    const flagged = findings.some((f) => f.subject.endsWith(`/${name}`) && f.kind !== "no-relevant-upstream-change");
    sharedExposure.push({
      ecosystem,
      name,
      paths: [...paths].sort(),
      rationale: flagged
        ? `shared dependency with active findings — remediate once, apply everywhere`
        : `shared dependency; coordinated update possible`,
    });
  }

  const artifact: DispatchArtifact = {
    schema: "tidepool-dispatch-v1",
    createdAt: Date.now(),
    snapshotDigest: snapshot.digest ?? "",
    snapshotWindow: snapshot.window,
    targets: profiles,
    findings,
    sharedExposure,
    ambiguities: [...new Set(ambiguities)],
    analyzerVersions: ANALYZER_VERSIONS,
  };
  artifact.digest = digestOf(artifact);
  return artifact;
}
