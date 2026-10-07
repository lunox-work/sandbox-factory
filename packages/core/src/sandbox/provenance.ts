/**
 * A sandbox version's private provenance: what it was cut from, how every
 * dependency is satisfied, which paths a contribution may touch, and what
 * must hold before the version can freeze.
 *
 * The slice manifest and boundary contract are the inputs; this module
 * reads them and never the source. Hashes are computed by callers that
 * have a hash function (core has none); here the rules say what each hash
 * must cover.
 */

import type { SliceManifest, BoundaryContract } from "../slice/manifest.js";
import type { AliasRule } from "./aliases.js";
import type { VersionFixtures } from "./fixtures.js";

export const SANDBOX_STATUSES = ["draft", "published", "closed"] as const;
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

/**
 * Whether a sandbox's publication stands at `now`. A publication is made
 * until a date, and lapses at it: past it the sandbox reads as no longer
 * published, though its row still says it was. A publication with no date
 * stands until it is taken down.
 */
export function isPublicationLive(
  sandbox: {
    readonly status: SandboxStatus;
    readonly expiresAt?: string | null;
  },
  now: Date = new Date(),
): boolean {
  if (sandbox.status !== "published") return false;
  const expiresAt = sandbox.expiresAt ?? null;
  return expiresAt === null || Date.parse(expiresAt) > now.getTime();
}

export const DEPENDENCY_RESOLUTIONS = [
  "included-code",
  "runtime-mock",
  "approved-package",
  "unresolved",
] as const;
export type DependencyResolution = (typeof DEPENDENCY_RESOLUTIONS)[number];

/**
 * A version or range the registry answers: semver, a range of them, or a
 * dist-tag. No protocol (`git+https:`, `file:`, `npm:`) and no path or
 * `owner/repo` shorthand, which is what a `:` or a `/` would make it.
 */
const REGISTRY_RANGE = /^[0-9A-Za-z.\-+^~<>=|* ]+$/;

export interface ResolvedDependency {
  /** A package name, or a repository path for a cut module. */
  readonly name: string;
  readonly kind: "package" | "module";
  readonly version: string | null;
  readonly resolution: DependencyResolution;
  readonly detail: string;
}

/** What the owner may decide per dependency; the rest is derived. */
export type DependencyChoice = "runtime-mock" | "approved-package";

export interface ProvenanceBlocker {
  readonly code:
    | "slice_not_ready"
    | "dependency_unresolved"
    | "partial_signature_coverage"
    | "alias_rules_invalid"
    | "operation_unapproved";
  readonly detail: string;
}

/**
 * The classification a sandbox gives every path. Copied source keeps its
 * structure; generated files live apart from it and are never editable.
 */
export const PATH_CLASSES = [
  "source",
  "stub",
  "mock",
  "test-public",
  "test-private",
  "config",
  "descriptor",
  "harness",
] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

export interface ScopeRecord {
  /** Repository paths a contribution may edit, sorted. */
  readonly editablePaths: readonly string[];
  /** Repository paths whose content is generated, sorted, never editable. */
  readonly generatedPaths: readonly string[];
  readonly permittedOperations: readonly (
    "edit" | "add" | "delete" | "rename"
  )[];
  readonly dependencies: readonly ResolvedDependency[];
  readonly blockers: readonly ProvenanceBlocker[];
}

export interface ScopeInput {
  readonly manifest: SliceManifest;
  readonly contract: BoundaryContract;
  /** Owner choices by package name; unspecified names take the default. */
  readonly choices?: Readonly<Record<string, DependencyChoice>>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Resolves every dependency of the slice. Cut modules with full declaration
 * coverage become runtime mocks generated from their declarations; service
 * packages the externals pass named default to runtime mocks; every other
 * pinned package is approved for installation; an unpinned package
 * blocks unless it is mocked, by default or by choice. Dynamic and unresolved imports are blockers the
 * slice already carries, and they stay blockers here.
 */
/** Choices naming a package the slice does not require: a typo, never applied. */
export function unknownDependencyChoices(
  manifest: Pick<SliceManifest, "requiredBuildInputs">,
  choices: Readonly<Record<string, DependencyChoice>>,
): string[] {
  const required = new Set(
    manifest.requiredBuildInputs.packages.map((item) => item.name),
  );
  return Object.keys(choices)
    .filter((name) => !required.has(name))
    .sort();
}

export function resolveScope(input: ScopeInput): ScopeRecord {
  const { manifest, contract } = input;
  const choices = input.choices ?? {};
  const blockers: ProvenanceBlocker[] = [];
  if (!manifest.meta.ready)
    blockers.push({
      code: "slice_not_ready",
      detail: `The slice reports ${manifest.blockers.length} blocker(s) and ${manifest.meta.stubCoverage} coverage.`,
    });
  if (contract.stubCoverage !== "full")
    blockers.push({
      code: "partial_signature_coverage",
      detail: `Declaration coverage is ${contract.stubCoverage}; every cut symbol needs a declaration before it can be mocked.`,
    });
  const services = new Set(
    manifest.externals.packages.map((item) => packageNameOf(item.specifier)),
  );
  const dependencies: ResolvedDependency[] = [];
  for (const item of manifest.requiredBuildInputs.packages) {
    const resolution: DependencyResolution =
      choices[item.name] ??
      (services.has(item.name) ? "runtime-mock" : "approved-package");
    // A mock needs no version; only an install does.
    if (item.version === null && resolution === "approved-package") {
      dependencies.push({
        name: item.name,
        kind: "package",
        version: null,
        resolution: "unresolved",
        detail: "No package.json pins a version.",
      });
      blockers.push({
        code: "dependency_unresolved",
        detail: `${item.name} has no pinned version.`,
      });
      continue;
    }
    // Only what the registry resolves is installed. The version is the
    // repository's own text, and npm also takes a git URL, a tarball URL,
    // `file:` or `link:` to a path outside the job, or an alias to another
    // package, each fetched or linked by the install.
    if (
      item.version !== null &&
      resolution === "approved-package" &&
      !REGISTRY_RANGE.test(item.version)
    ) {
      dependencies.push({
        name: item.name,
        kind: "package",
        version: item.version,
        resolution: "unresolved",
        detail: "Not a registry version: a URL, a path or an alias.",
      });
      blockers.push({
        code: "dependency_unresolved",
        detail: `${item.name} is pinned to ${item.version}, which is not a registry version.`,
      });
      continue;
    }
    dependencies.push({
      name: item.name,
      kind: "package",
      version: item.version,
      resolution,
      detail:
        resolution === "runtime-mock"
          ? "Replaced by a generated recording mock package."
          : `Installed at the version ${item.declaredIn ?? "the source"} pins.`,
    });
  }
  for (const module of contract.outbound) {
    const complete = module.symbols.every(
      (symbol) => symbol.declaration !== null,
    );
    dependencies.push({
      name: module.module,
      kind: "module",
      version: null,
      resolution: complete ? "runtime-mock" : "unresolved",
      detail: complete
        ? `Generated from its declaration stub${module.stubPath === null ? "" : ` (${module.stubPath})`}.`
        : "One or more symbols have no declaration.",
    });
    if (!complete)
      blockers.push({
        code: "dependency_unresolved",
        detail: `${module.module} cannot be mocked without declarations.`,
      });
  }
  for (const blocker of manifest.blockers)
    if (
      blocker.code === "dynamic_dependency" ||
      blocker.code === "unresolved_import"
    )
      blockers.push({
        code: "dependency_unresolved",
        detail: `${blocker.file ?? ""}: ${blocker.detail}`,
      });
  dependencies.sort((a, b) =>
    compare(`${a.kind}:${a.name}`, `${b.kind}:${b.name}`),
  );
  return {
    editablePaths: manifest.included.map((file) => file.path).sort(compare),
    generatedPaths: manifest.synthetic.map((file) => file.path).sort(compare),
    permittedOperations: ["edit"],
    dependencies,
    blockers,
  };
}

export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") && parts.length > 1
    ? `${parts[0]}/${parts[1]}`
    : (parts[0] ?? specifier);
}

/**
 * Where a version's code came from: a slice of the sandbox's repository,
 * or a starter an agent wrote from the bounty's text when it has none.
 */
export type VersionOrigin = "slice" | "starter";

/**
 * What `sandbox_version_source` records, as the stores and the worker see
 * it. Hashes name immutable private artifacts; the rules below say what
 * each covers. A sliced version names its snapshot, slice run, manifest and
 * contract and no starter; a generated one the reverse.
 */
export interface VersionSourceRecord {
  readonly sandboxVersionId: string;
  readonly origin: VersionOrigin;
  readonly sourceSnapshotId: string | null;
  readonly sliceRunId: string | null;
  readonly manifestSha256: string | null;
  /** The run that wrote a generated version's starter, and builds it. */
  readonly starterRunId: string | null;
  /** The `starter_set` artifact's hash; null until the run is committed. */
  readonly starterSha256: string | null;
  readonly transformConfigSha256: string;
  readonly approvedTaskSha256: string;
  readonly aliasRules: readonly AliasRule[];
  readonly contractSha256: string | null;
  readonly harnessSha256: string | null;
  readonly toolchainDigest: string | null;
  readonly buildRunId: string | null;
  readonly roundTripRunId: string | null;
  readonly disclosureRunId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
}

/**
 * The transform configuration a version freezes: the ordered alias rules,
 * the dependency choices, the hidden tests and the fixtures, and for a
 * generated version the starter it builds. Its canonical form is what
 * `transformConfigSha256` hashes, so a changed rule is a changed version.
 * A sliced version's form has no `starterSha256` key at all, so its hash
 * is what it was before starters existed.
 */
export interface TransformConfig {
  readonly schemaVersion: 2;
  readonly aliasRules: readonly AliasRule[];
  readonly dependencyChoices: Readonly<Record<string, DependencyChoice>>;
  readonly acceptanceTests: readonly AcceptanceTest[];
  readonly fixtures: VersionFixtures | null;
  readonly starterSha256?: string;
}

/** What `transformConfigSha256` hashes, once made canonical. */
export function transformConfigOf(input: {
  readonly aliasRules: readonly AliasRule[];
  readonly dependencyChoices: Readonly<Record<string, DependencyChoice>>;
  readonly acceptanceTests: readonly AcceptanceTest[];
  readonly fixtures?: VersionFixtures | null;
  readonly starterSha256?: string | null;
}): TransformConfig {
  return {
    schemaVersion: 2,
    aliasRules: input.aliasRules,
    dependencyChoices: input.dependencyChoices,
    acceptanceTests: input.acceptanceTests,
    fixtures: input.fixtures ?? null,
    ...(input.starterSha256 == null
      ? {}
      : { starterSha256: input.starterSha256 }),
  };
}

/** An owner-authored hidden test, private to the version. */
export interface AcceptanceTest {
  /** Under `tests/private/`, `.test.ts`. */
  readonly path: string;
  readonly text: string;
  /** Whether it is expected to pass on the unfixed baseline. */
  readonly expectedBaseline: "pass" | "fail";
}

/**
 * Whether a draft may freeze. 5A records the rule; 5D supplies the round
 * trip and disclosure runs and is its first caller. Evidence that names a different manifest or
 * transform than the record is invalid, because inputs changed after it.
 */
export function freezeReadiness(
  source: VersionSourceRecord,
  evidence: {
    readonly buildManifestSha256: string | null;
    readonly buildTransformSha256: string | null;
    readonly buildApprovedTaskSha256: string | null;
    readonly baselineOk: boolean;
    readonly roundTripOk: boolean;
    readonly disclosureBlocking: number | null;
  },
): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (source.buildRunId === null) reasons.push("No build run is recorded.");
  else {
    if (evidence.buildManifestSha256 !== source.manifestSha256)
      reasons.push("The build evidence names a different slice manifest.");
    if (evidence.buildTransformSha256 !== source.transformConfigSha256)
      reasons.push("The build evidence names a different transform.");
    if (evidence.buildApprovedTaskSha256 !== source.approvedTaskSha256)
      reasons.push("The build evidence names a different approved task.");
    if (!evidence.baselineOk) reasons.push("The baseline check did not pass.");
  }
  if (source.harnessSha256 === null)
    reasons.push("No harness hash is recorded.");
  if (source.toolchainDigest === null)
    reasons.push("No toolchain digest is recorded.");
  if (source.roundTripRunId === null || !evidence.roundTripOk)
    reasons.push("The no-change round trip has not passed.");
  if (source.disclosureRunId === null)
    reasons.push("No disclosure scan is recorded.");
  else if ((evidence.disclosureBlocking ?? 1) > 0)
    reasons.push("The disclosure scan has blocking findings.");
  if (source.approvedBy === null || source.approvedAt === null)
    reasons.push("The exact candidate has not been approved.");
  return { ready: reasons.length === 0, reasons };
}

/**
 * What replaying a version needs, and the one answer when it cannot be
 * had. A replay fetches the recorded commit; it never substitutes a
 * branch head.
 */
export type ReplayResult =
  | {
      readonly ok: true;
      readonly sourceSnapshotId: string;
      readonly sourceCommitSha: string;
      readonly sliceRunId: string;
      readonly manifestSha256: string;
      readonly transformConfigSha256: string;
      readonly approvedTaskSha256: string;
      readonly aliasRules: readonly AliasRule[];
    }
  | {
      readonly ok: false;
      readonly reason: "source_unavailable";
      readonly detail: string;
    };

export function replayOf(
  source: VersionSourceRecord,
  snapshot: { readonly commitSha: string; readonly repoGone: boolean } | null,
  sliceRun: {
    readonly status: string;
    readonly artifactsPresent: boolean;
  } | null,
): ReplayResult {
  if (
    source.sourceSnapshotId === null ||
    source.sliceRunId === null ||
    source.manifestSha256 === null
  )
    return {
      ok: false,
      reason: "source_unavailable",
      detail:
        "The version was generated, not sliced; it has no source to replay.",
    };
  if (snapshot === null)
    return {
      ok: false,
      reason: "source_unavailable",
      detail: "The source snapshot no longer exists.",
    };
  if (snapshot.repoGone)
    return {
      ok: false,
      reason: "source_unavailable",
      detail: "The source repository is no longer reachable.",
    };
  if (
    sliceRun === null ||
    sliceRun.status !== "succeeded" ||
    !sliceRun.artifactsPresent
  )
    return {
      ok: false,
      reason: "source_unavailable",
      detail: "The slice run's artifacts are not retained.",
    };
  return {
    ok: true,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceCommitSha: snapshot.commitSha,
    sliceRunId: source.sliceRunId,
    manifestSha256: source.manifestSha256,
    transformConfigSha256: source.transformConfigSha256,
    approvedTaskSha256: source.approvedTaskSha256,
    aliasRules: source.aliasRules,
  };
}
