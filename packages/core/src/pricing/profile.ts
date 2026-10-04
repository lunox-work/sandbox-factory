/**
 * A bounty's complexity profile: the measurable features a price will point
 * back to.
 *
 * Nothing here is a price, a size or a multiplier. It is the evidence those
 * are later drawn from, and each feature is taken from the source least easy
 * to push around: the code graph (the scope agent's entry points and the
 * slice cut from them) and the repository's file list before the bounty's
 * prose. A poster can rewrite a description; they cannot rewrite which
 * modules the change lands in.
 *
 * | Feature           | Source                                           |
 * | ----------------- | ------------------------------------------------ |
 * | Bounty type       | The bounty, as written here or in Jira           |
 * | Slice size        | The slice: included files, bytes, their modules  |
 * | Touched modules   | The scope agent's entry points, by `modulesFor`  |
 * | Externals         | The slice's services and environment; its seams  |
 * | Spec clarity      | The spec draft's open questions and assumptions  |
 * | Tests on the path | The file list's test files in the touched modules |
 * | Analogous pattern | The scope agent, checked to name a file          |
 * | Non-functional    | Spec scenarios, migrations, CI configuration     |
 *
 * Pure and deterministic: the same inputs give the same profile, so a stored
 * one can be recomputed and compared.
 */

import type { TreeFacts } from "../repo/tree.js";
import { modulesFor } from "../repo/tree.js";
import type { StubCoverage } from "../slice/manifest.js";
import type { ScopePattern, ScopeSubmission } from "../slice/scope.js";
import { SCENARIO_KINDS } from "./spec.js";
import type { ScenarioKind, SpecDraft } from "./spec.js";

/** Bumped when what a stored profile's fields mean changes. */
export const COMPLEXITY_PROFILE_VERSION = "profile-v1";

/**
 * Where a proposal's profile stands. `queued` waits for room under the
 * organization's analysis cap; `scoping` and `slicing` wait for their runs;
 * `ready` and `failed` are final for that spec revision.
 */
export const PROFILE_STATUSES = [
  "queued",
  "scoping",
  "slicing",
  "ready",
  "failed",
] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

/**
 * Why a profile failed. A run's own error code, when a run is what failed,
 * is kept beside it.
 */
export const PROFILE_ERROR_CODES = [
  /** The snapshot, its graph, or the spec revision is no longer there. */
  "source_unavailable",
  "scope_failed",
  "slice_failed",
  /** A run succeeded but its recorded output could not be read. */
  "output_invalid",
] as const;
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number];

/** Whether an infrastructure directory `TreeFacts` lists holds CI configuration. */
const isCiDirectory = (directory: string) =>
  directory === ".github/workflows" ||
  directory === ".circleci" ||
  directory.endsWith("/.circleci");

/** What the bounty says about itself, whether written here or in Jira. */
export interface ProfileBounty {
  readonly issueType: string;
  /** The bounty's priority name, or null when it has none. */
  readonly priority: string | null;
}

export interface ComplexityProfile {
  readonly version: typeof COMPLEXITY_PROFILE_VERSION;
  readonly bounty: ProfileBounty;
  /** The measured slice: the context an agent has to read. */
  readonly slice: {
    readonly files: number;
    readonly bytes: number;
    /** The modules the included files sit in, sorted. */
    readonly modules: readonly string[];
    readonly stubCoverage: StubCoverage;
    readonly blockers: number;
    /** Whether the slice may advance to a sandbox. */
    readonly ready: boolean;
  };
  /** The modules the scope agent's entry points fall in: where the change lands. */
  readonly touchedModules: readonly string[];
  /** What the sandbox mocks rather than runs. */
  readonly externals: {
    /** Services the slice's packages reach (`email`, `postgres`), sorted, unique. */
    readonly services: readonly string[];
    /** Environment variables the slice reads. */
    readonly environment: number;
    /** Cut modules the scope agent judged safe to mock. */
    readonly seams: number;
  };
  readonly spec: {
    readonly scenarios: number;
    /** Scenario counts by kind, every kind present, zero included. */
    readonly kinds: Readonly<Record<ScenarioKind, number>>;
    readonly openQuestions: number;
    readonly assumptions: number;
  };
  /** Guard rails already in place where the change lands. */
  readonly tests: {
    /** Test files in the touched modules. */
    readonly files: number;
    /** Touched modules with no test file at all, sorted. */
    readonly untestedModules: readonly string[];
  };
  /** Existing code in the repository the change can follow, or null. */
  readonly pattern: ScopePattern | null;
  readonly nonFunctional: {
    /** Scenarios of the `non-functional` kind. */
    readonly scenarios: number;
    /** A touched module holds schema migrations. */
    readonly migrations: boolean;
    /** The repository runs continuous integration. */
    readonly ci: boolean;
  };
  /** What the scope agent could not avoid, in its own words. */
  readonly risks: readonly string[];
}

/** The slice's bounded summary, as its boundary-contract artifact records it. */
export interface ProfileSlice {
  readonly stubCoverage: StubCoverage;
  readonly ready: boolean;
  readonly counts: {
    readonly includedFiles: number;
    readonly includedBytes: number;
    readonly blockers: number;
  };
  readonly included: readonly string[];
  readonly externals: {
    readonly packages: readonly { readonly service: string }[];
    readonly environment: readonly string[];
  };
}

export interface ProfileInput {
  readonly bounty: ProfileBounty;
  readonly spec: Pick<SpecDraft, "scenarios" | "openQuestions" | "assumptions">;
  readonly facts: Pick<
    TreeFacts,
    "modules" | "migrationDirectories" | "infraDirectories"
  >;
  readonly scope: Pick<ScopeSubmission, "entryPoints" | "seams" | "risks"> & {
    readonly pattern?: ScopePattern | null | undefined;
  };
  readonly slice: ProfileSlice;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildComplexityProfile(input: ProfileInput): ComplexityProfile {
  const { facts, scope, slice, spec } = input;
  const touchedModules = modulesFor(
    facts,
    scope.entryPoints.map((entry) => entry.path),
  );
  const touched = new Set(touchedModules);
  const touchedFacts = facts.modules.filter((module) =>
    touched.has(module.path),
  );

  const kinds = Object.fromEntries(
    SCENARIO_KINDS.map((kind) => [kind, 0]),
  ) as Record<ScenarioKind, number>;
  for (const scenario of spec.scenarios) kinds[scenario.kind] += 1;

  return {
    version: COMPLEXITY_PROFILE_VERSION,
    bounty: input.bounty,
    slice: {
      files: slice.counts.includedFiles,
      bytes: slice.counts.includedBytes,
      modules: modulesFor(facts, slice.included),
      stubCoverage: slice.stubCoverage,
      blockers: slice.counts.blockers,
      ready: slice.ready,
    },
    touchedModules,
    externals: {
      services: [
        ...new Set(slice.externals.packages.map(({ service }) => service)),
      ].sort(compare),
      environment: slice.externals.environment.length,
      seams: scope.seams.length,
    },
    spec: {
      scenarios: spec.scenarios.length,
      kinds,
      openQuestions: spec.openQuestions.length,
      assumptions: spec.assumptions.length,
    },
    tests: {
      files: touchedFacts.reduce((sum, module) => sum + module.testFiles, 0),
      untestedModules: touchedFacts
        .filter((module) => module.testFiles === 0)
        .map((module) => module.path),
    },
    pattern: scope.pattern ?? null,
    nonFunctional: {
      scenarios: kinds["non-functional"],
      migrations: modulesFor(facts, facts.migrationDirectories).some((module) =>
        touched.has(module),
      ),
      ci: facts.infraDirectories.some(isCiDirectory),
    },
    risks: [...scope.risks],
  };
}
