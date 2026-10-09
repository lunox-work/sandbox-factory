/**
 * The pricing rubric: a bounty's size scored from what can be counted.
 *
 * Three dimensions, each a sum of points from named factors, and every
 * factor read from one piece of evidence a reviewer can check:
 *
 * | Dimension  | Evidence                                                |
 * | ---------- | ------------------------------------------------------- |
 * | Scenarios  | The spec: each scenario's weight, its open questions    |
 * | Test cases | The spec: one test per scenario, one check per outcome  |
 * | Code       | A complexity profile per repository the work touches    |
 *
 * The total falls in one band, and the band is the size the rate card
 * prices. Nothing here is money: dollars still enter only through the card.
 *
 * Test cases are counted from the spec because the spec is all there is when
 * a bounty is priced: the sandbox's tests are written from the approved spec,
 * after the price, and each scenario becomes one of them
 * (`sandbox/project.ts`'s `specTests`). Its outcome steps, `Then` and the
 * `And`/`But` that follow it, are what that test has to check.
 *
 * The code is what makes the rubric whole. Without a measured profile (no
 * repository, or one still being measured) the rubric has no size of its
 * own and the model's size stands; the scenarios and test cases are still
 * scored, so the reviewer sees what the size will be built from. A bounty
 * may touch several of the workspace's repositories: each is profiled, the
 * code is scored over all of them together, and every repository beyond the
 * first adds the integration across them.
 *
 * **This file is the rubric, and it is meant to be edited.** The points and
 * bands are at the top, the rules a reader sees are written from them, and
 * `RUBRIC_VERSION` is stored with every assessment: bump it when what a
 * stored assessment's numbers mean changes. Pure and deterministic, so a
 * stored assessment can be recomputed and compared.
 */

import type { PricedComplexity } from "../sizing.js";
import type { StubCoverage } from "../slice/manifest.js";
import type { ComplexityProfile } from "./profile.js";
import type { Scenario, SpecDraft } from "./spec.js";
import {
  SCENARIO_WEIGHT_DEFINITIONS,
  WEIGHT_POINTS,
  type ScenarioWeight,
} from "./weight.js";

/**
 * Stored with every assessment. `rubric-v2` scores the code over every
 * repository the work touches, and adds the integration across them.
 */
export const RUBRIC_VERSION = "rubric-v2";

/** What each factor adds. Scenario weights are the step's (`weight.ts`). */
export const RUBRIC_POINTS = {
  /** Per open question: an answer the contributor has to guess. */
  openQuestion: 1,
  /** Per test case: every scenario is one test. */
  testCase: 1,
  /** Per outcome a test checks beyond its first. */
  extraCheck: 1,
  /**
   * Per touched module beyond the first in its repository: the first in
   * each further repository is the integration `extraRepository` charges.
   */
  extraModule: 3,
  /** Per touched repository beyond the first: the integration across them. */
  extraRepository: 4,
  /** Per external service the sandbox mocks. */
  service: 2,
  /** Per cut module the scope agent judged safe to mock. */
  seam: 1,
  /** Per touched module with no test file. */
  untestedModule: 2,
  /** When a touched module holds schema migrations. */
  migrations: 4,
  /** Per slice blocker. */
  blocker: 2,
  /** By how much of the cut-away code the slice's stubs keep. */
  stubs: { full: 0, partial: 1, "names-only": 2 } satisfies Record<
    StubCoverage,
    number
  >,
  /** When the repository has an analogous pattern to follow: a discount. */
  pattern: -2,
} as const;

/**
 * The slice's size, in KB of code to read, as points: under the first
 * ceiling scores its points, and so on; past the last scores `beyond`.
 */
export const CONTEXT_BANDS = {
  bands: [
    { underKb: 16, points: 0 },
    { underKb: 48, points: 1 },
    { underKb: 128, points: 2 },
    { underKb: 320, points: 4 },
  ],
  beyond: 6,
} as const;

/**
 * Where each size starts, in total points, smallest first. A size runs up
 * to one point below the next one's start; XL has no ceiling.
 */
export const RUBRIC_BANDS: readonly {
  readonly size: PricedComplexity;
  readonly from: number;
}[] = [
  { size: "XS", from: 0 },
  { size: "XS+", from: 4 },
  { size: "S", from: 7 },
  { size: "S+", from: 11 },
  { size: "M", from: 15 },
  { size: "M+", from: 21 },
  { size: "L", from: 28 },
  { size: "L+", from: 37 },
  { size: "XL", from: 48 },
];

export const RUBRIC_DIMENSIONS = [
  {
    id: "scenarios",
    label: "Scenarios",
    covers:
      "What the bounty must do, scenario by scenario, and what it leaves unsaid.",
  },
  {
    id: "tests",
    label: "Test cases",
    covers:
      "What has to be proven: each scenario is a test, each outcome a check.",
  },
  {
    id: "code",
    label: "Code",
    covers:
      "Where the change lands, measured from the code graph of each repository it touches.",
  },
] as const;
export type RubricDimensionId = (typeof RUBRIC_DIMENSIONS)[number]["id"];

/** One rule of the rubric, for a reader: what it counts and why. */
export interface RubricRule {
  readonly id: string;
  readonly dimension: RubricDimensionId;
  readonly label: string;
  /** How it scores, in points. */
  readonly scoring: string;
  readonly why: string;
}

const signed = (points: number) => (points > 0 ? `+${points}` : `${points}`);

function contextScoring(): string {
  const parts = CONTEXT_BANDS.bands.map(
    ({ underKb, points }) => `under ${underKb} KB ${points}`,
  );
  const last = CONTEXT_BANDS.bands.at(-1)?.underKb ?? 0;
  return `${parts.join(", ")}, ${last} KB or more ${CONTEXT_BANDS.beyond}`;
}

/**
 * Every rule the rubric applies, written from the numbers above, so a
 * changed number is a changed explanation with no edit here.
 */
export function rubricRules(
  weightPoints: Readonly<Record<ScenarioWeight, number>> = WEIGHT_POINTS,
): readonly RubricRule[] {
  const P = RUBRIC_POINTS;
  return [
    ...SCENARIO_WEIGHT_DEFINITIONS.map(({ id, label, covers }): RubricRule => ({
      id: `weight-${id}`,
      dimension: "scenarios",
      label: `${label} scenario`,
      scoring: `${weightPoints[id]} each`,
      why: covers,
    })),
    {
      id: "open-questions",
      dimension: "scenarios",
      label: "Open question",
      scoring: `${P.openQuestion} each`,
      why: "Something the bounty does not say: the contributor must guess, and a wrong guess is rework.",
    },
    {
      id: "test-cases",
      dimension: "tests",
      label: "Test case",
      scoring: `${P.testCase} each`,
      why: "Every scenario becomes one acceptance test the work must pass.",
    },
    {
      id: "extra-checks",
      dimension: "tests",
      label: "Additional check",
      scoring: `${P.extraCheck} per outcome beyond a test's first`,
      why: "Each Then, And or But after it is one more thing the test asserts.",
    },
    {
      id: "context",
      dimension: "code",
      label: "Code to read",
      scoring: contextScoring(),
      why: "The slice is the context an agent must hold; more of it is more to get wrong.",
    },
    {
      id: "repositories",
      dimension: "code",
      label: "Repositories touched",
      scoring: `${P.extraRepository} per repository beyond the first`,
      why: "Each repository is built, tested and shipped on its own, and the change has to agree across them.",
    },
    {
      id: "modules",
      dimension: "code",
      label: "Modules touched",
      scoring: `${P.extraModule} per module beyond the first in its repository`,
      why: "Changes across module boundaries are the strongest predictor of an agent failing.",
    },
    {
      id: "services",
      dimension: "code",
      label: "External services",
      scoring: `${P.service} each`,
      why: "Each one is mocked in the sandbox, a place it can differ from production.",
    },
    {
      id: "seams",
      dimension: "code",
      label: "Mocked seams",
      scoring: `${P.seam} each`,
      why: "Code cut from the slice and stood in for: one more contract to respect blind.",
    },
    {
      id: "untested",
      dimension: "code",
      label: "Untested modules",
      scoring: `${P.untestedModule} per touched module with no tests`,
      why: "No guard rails where the change lands, so the harness has to be built too.",
    },
    {
      id: "migrations",
      dimension: "code",
      label: "Schema migrations",
      scoring: `${signed(P.migrations)} when a touched module holds them`,
      why: "A schema change has to be right the first time and be reversible.",
    },
    {
      id: "stubs",
      dimension: "code",
      label: "Stub coverage",
      scoring: `full ${P.stubs.full}, partial ${P.stubs.partial}, names only ${P.stubs["names-only"]}`,
      why: "Thinner stubs mean less of the surrounding code can be read or run.",
    },
    {
      id: "blockers",
      dimension: "code",
      label: "Slice blockers",
      scoring: `${P.blocker} each`,
      why: "Something the slice could not cut cleanly, which the contributor works around.",
    },
    {
      id: "pattern",
      dimension: "code",
      label: "Analogous pattern",
      scoring: `${signed(P.pattern)} when one exists`,
      why: "Following working code in a repository it touches is cheaper than inventing it.",
    },
  ];
}

/**
 * Whether the code has been measured, and if not, why:
 *
 * - `measured`: a profile is ready, and the rubric has a size;
 * - `pending`: a profile has been asked for and is still being measured;
 * - `unavailable`: no repository, or profiling is not configured;
 * - `failed`: the profile failed, and a re-analysis asks again.
 */
export const RUBRIC_CODE_STATUSES = [
  "measured",
  "pending",
  "unavailable",
  "failed",
] as const;
export type RubricCodeStatus = (typeof RUBRIC_CODE_STATUSES)[number];

/** The dimension ids alone, in order, as a tuple a schema can take. */
export const RUBRIC_DIMENSION_IDS = RUBRIC_DIMENSIONS.map(
  ({ id }) => id,
) as unknown as readonly [RubricDimensionId, ...RubricDimensionId[]];

/** One repository the work touches, and its code as profiled. */
export interface MeasuredRepository {
  /** What a reviewer knows it by: its full name. */
  readonly repository: string;
  readonly profile: ComplexityProfile;
}

export type RubricCode =
  | {
      readonly status: "measured";
      /** Every repository the work touches, at least one. */
      readonly profiles: readonly MeasuredRepository[];
      /** The spec revision the profiles were measured for. */
      readonly specRevision: number;
    }
  | { readonly status: Exclude<RubricCodeStatus, "measured"> };

export interface RubricInput {
  readonly spec: Pick<SpecDraft, "scenarios" | "openQuestions">;
  readonly code: RubricCode;
  /** What each weight counts for: the step's settings, a board's overrides. */
  readonly weightPoints?: Readonly<Record<ScenarioWeight, number>>;
}

export interface RubricFactor {
  /**
   * The rule it applies, as `rubricRules` names it; `unweighed` applies the
   * moderate weight's to scenarios drafted before weights.
   */
  readonly id: string;
  readonly label: string;
  /** What was counted, for a reader. */
  readonly evidence: string;
  readonly points: number;
}

export interface RubricDimension {
  readonly id: RubricDimensionId;
  readonly label: string;
  /** The factors summed, never below zero. Zero while unmeasured. */
  readonly points: number;
  /** False for the code while it has no profile. */
  readonly measured: boolean;
  readonly factors: readonly RubricFactor[];
}

export interface RubricAssessment {
  readonly version: typeof RUBRIC_VERSION;
  /** Scenarios, test cases and code, in that order. */
  readonly dimensions: readonly RubricDimension[];
  /** The measured dimensions' points. */
  readonly points: number;
  readonly counts: {
    readonly scenarios: number;
    readonly testCases: number;
    readonly checks: number;
  };
  readonly code: {
    readonly status: RubricCodeStatus;
    /** The spec revision the profile was measured for, when it was. */
    readonly specRevision: number | null;
  };
  /** The band the points fall in; null until the code is measured. */
  readonly size: PricedComplexity | null;
  /** Points still to add for the next band; null at XL or without a size. */
  readonly nextSizeIn: number | null;
  /** The weights it was scored with, so it reads the same later. */
  readonly weightPoints: Readonly<Record<ScenarioWeight, number>>;
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The outcome steps of a scenario: each `Then`, and `And`/`But` after one. */
export function checksOf(scenario: Pick<Scenario, "steps">): number {
  let outcome = false;
  let checks = 0;
  for (const { keyword } of scenario.steps) {
    if (keyword === "Then") outcome = true;
    else if (keyword === "Given" || keyword === "When") outcome = false;
    if (outcome) checks += 1;
  }
  return checks;
}

/** The size a number of points falls in. */
export function rubricSize(points: number): PricedComplexity {
  let size: PricedComplexity = "XS";
  for (const band of RUBRIC_BANDS) if (points >= band.from) size = band.size;
  return size;
}

/** A size's points, from and to inclusive; `to` is null for XL. */
export function rubricBand(size: PricedComplexity): {
  readonly from: number;
  readonly to: number | null;
} {
  const index = RUBRIC_BANDS.findIndex((band) => band.size === size);
  const next = RUBRIC_BANDS[index + 1];
  return {
    from: RUBRIC_BANDS[index]?.from ?? 0,
    to: next === undefined ? null : next.from - 1,
  };
}

function dimension(
  id: RubricDimensionId,
  factors: readonly RubricFactor[],
  measured = true,
): RubricDimension {
  const label =
    RUBRIC_DIMENSIONS.find((candidate) => candidate.id === id)?.label ?? id;
  const sum = factors.reduce((total, factor) => total + factor.points, 0);
  return {
    id,
    label,
    points: measured ? Math.max(0, sum) : 0,
    measured,
    factors,
  };
}

function scenarioFactors(
  scenarios: readonly Scenario[],
  openQuestions: number,
  weightPoints: Readonly<Record<ScenarioWeight, number>>,
): RubricFactor[] {
  const counts = new Map<ScenarioWeight, number>();
  let unweighed = 0;
  for (const { weight } of scenarios) {
    if (weight === undefined || !Object.hasOwn(weightPoints, weight))
      unweighed += 1;
    else counts.set(weight, (counts.get(weight) ?? 0) + 1);
  }
  const factors: RubricFactor[] = SCENARIO_WEIGHT_DEFINITIONS.map(
    ({ id, label }) => {
      const count = counts.get(id) ?? 0;
      return {
        id: `weight-${id}`,
        label: `${label} scenarios`,
        evidence: `${count} × ${weightPoints[id]}`,
        points: count * weightPoints[id],
      };
    },
  );
  // A spec drafted before weights still counts, as the middle weight: a
  // scenario is never free, and guessing it heavy would be the poster's win.
  if (unweighed > 0)
    factors.push({
      id: "unweighed",
      label: "Unweighed scenarios",
      evidence: `${unweighed} × ${weightPoints.moderate}, counted as moderate`,
      points: unweighed * weightPoints.moderate,
    });
  factors.push({
    id: "open-questions",
    label: "Open questions",
    evidence: openQuestions === 0 ? "None" : plural(openQuestions, "question"),
    points: openQuestions * RUBRIC_POINTS.openQuestion,
  });
  return factors;
}

function contextPoints(bytes: number): number {
  const kb = bytes / 1024;
  for (const band of CONTEXT_BANDS.bands)
    if (kb < band.underKb) return band.points;
  return CONTEXT_BANDS.beyond;
}

const kilobytes = (bytes: number) =>
  `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;

const named = (names: readonly string[]) =>
  names.length === 0 ? "" : `: ${names.join(", ")}`;

const STUBS: Record<StubCoverage, string> = {
  full: "Full",
  partial: "Partial",
  "names-only": "Names only",
};

const STUB_ORDER: readonly StubCoverage[] = ["full", "partial", "names-only"];

/**
 * The code as one change: every repository's profile taken together, its
 * modules named by repository when there are several, its counts summed,
 * and its stubs as thin as the thinnest.
 */
function combined(measured: readonly MeasuredRepository[]) {
  const several = measured.length > 1;
  const qualify = (repository: string, names: readonly string[]) =>
    several ? names.map((name) => `${repository}:${name}`) : [...names];
  const each = <T>(read: (entry: MeasuredRepository) => T): T[] =>
    measured.map(read);
  const sum = (values: readonly number[]) =>
    values.reduce((total, value) => total + value, 0);
  const pattern = measured.find(({ profile }) => profile.pattern !== null);
  return {
    repositories: each(({ repository }) => repository),
    files: sum(each(({ profile }) => profile.slice.files)),
    bytes: sum(each(({ profile }) => profile.slice.bytes)),
    touchedModules: measured.flatMap(({ repository, profile }) =>
      qualify(repository, profile.touchedModules),
    ),
    // Each repository's modules beyond its first: crossing into another
    // repository is charged once, as that repository.
    extraModules: sum(
      each(({ profile }) => Math.max(0, profile.touchedModules.length - 1)),
    ),
    services: [
      ...new Set(measured.flatMap(({ profile }) => profile.externals.services)),
    ].sort(),
    seams: sum(each(({ profile }) => profile.externals.seams)),
    untestedModules: measured.flatMap(({ repository, profile }) =>
      qualify(repository, profile.tests.untestedModules),
    ),
    migrations: measured.some(
      ({ profile }) => profile.nonFunctional.migrations,
    ),
    stubCoverage:
      STUB_ORDER[
        Math.max(
          ...each(({ profile }) =>
            STUB_ORDER.indexOf(profile.slice.stubCoverage),
          ),
        )
      ] ?? "full",
    blockers: sum(each(({ profile }) => profile.slice.blockers)),
    pattern:
      pattern?.profile.pattern == null
        ? null
        : several
          ? `${pattern.repository}:${pattern.profile.pattern.path}`
          : pattern.profile.pattern.path,
  };
}

function codeFactors(measured: readonly MeasuredRepository[]): RubricFactor[] {
  const P = RUBRIC_POINTS;
  const code = combined(measured);
  return [
    {
      id: "context",
      label: "Code to read",
      evidence: `${plural(code.files, "file")}, ${kilobytes(code.bytes)}`,
      points: contextPoints(code.bytes),
    },
    {
      id: "repositories",
      label: "Repositories touched",
      evidence: `${code.repositories.length}${named(code.repositories)}`,
      points: Math.max(0, code.repositories.length - 1) * P.extraRepository,
    },
    {
      id: "modules",
      label: "Modules touched",
      evidence: `${code.touchedModules.length}${named(code.touchedModules)}`,
      points: code.extraModules * P.extraModule,
    },
    {
      id: "services",
      label: "External services",
      evidence:
        code.services.length === 0
          ? "None"
          : `${code.services.length}${named(code.services)}`,
      points: code.services.length * P.service,
    },
    {
      id: "seams",
      label: "Mocked seams",
      evidence: code.seams === 0 ? "None" : plural(code.seams, "seam"),
      points: code.seams * P.seam,
    },
    {
      id: "untested",
      label: "Untested modules",
      evidence:
        code.untestedModules.length === 0
          ? "None"
          : `${code.untestedModules.length}${named(code.untestedModules)}`,
      points: code.untestedModules.length * P.untestedModule,
    },
    {
      id: "migrations",
      label: "Schema migrations",
      evidence: code.migrations ? "In a touched module" : "None",
      points: code.migrations ? P.migrations : 0,
    },
    {
      id: "stubs",
      label: "Stub coverage",
      evidence: STUBS[code.stubCoverage],
      points: P.stubs[code.stubCoverage],
    },
    {
      id: "blockers",
      label: "Slice blockers",
      evidence: code.blockers === 0 ? "None" : plural(code.blockers, "blocker"),
      points: code.blockers * P.blocker,
    },
    {
      id: "pattern",
      label: "Analogous pattern",
      evidence: code.pattern ?? "None found",
      points: code.pattern === null ? 0 : P.pattern,
    },
  ];
}

export function assessRubric(input: RubricInput): RubricAssessment {
  const weightPoints = input.weightPoints ?? WEIGHT_POINTS;
  const { scenarios } = input.spec;
  const checks = scenarios.reduce((sum, item) => sum + checksOf(item), 0);
  const extraChecks = scenarios.reduce(
    (sum, item) => sum + Math.max(0, checksOf(item) - 1),
    0,
  );

  // Measured code is at least one repository's; none is no code to score.
  const code: RubricCode =
    input.code.status === "measured" && input.code.profiles.length === 0
      ? { status: "unavailable" }
      : input.code;
  const measured = code.status === "measured";
  const dimensions = [
    dimension(
      "scenarios",
      scenarioFactors(scenarios, input.spec.openQuestions.length, weightPoints),
    ),
    dimension("tests", [
      {
        id: "test-cases",
        label: "Test cases",
        evidence: `${plural(scenarios.length, "scenario")}, one test each`,
        points: scenarios.length * RUBRIC_POINTS.testCase,
      },
      {
        id: "extra-checks",
        label: "Additional checks",
        evidence: `${plural(checks, "outcome")} checked in all`,
        points: extraChecks * RUBRIC_POINTS.extraCheck,
      },
    ]),
    code.status === "measured"
      ? dimension("code", codeFactors(code.profiles))
      : dimension("code", [], false),
  ];
  const points = dimensions.reduce((sum, { points }) => sum + points, 0);
  const size = measured ? rubricSize(points) : null;
  const next =
    size === null
      ? undefined
      : RUBRIC_BANDS[RUBRIC_BANDS.findIndex((band) => band.size === size) + 1];
  return {
    version: RUBRIC_VERSION,
    dimensions,
    points,
    counts: {
      scenarios: scenarios.length,
      testCases: scenarios.length,
      checks,
    },
    code: {
      status: code.status,
      specRevision: code.status === "measured" ? code.specRevision : null,
    },
    size,
    nextSizeIn: next === undefined ? null : next.from - points,
    weightPoints: { ...weightPoints },
  };
}

/** Why an assessment has no size of its own, by its code's status. */
const UNSIZED: Record<RubricCodeStatus, string> = {
  measured: "",
  pending:
    "The code is still being measured, so the size is the model's until it is.",
  unavailable:
    "The code is not measured: the work touches no repository that can be, so the size is the model's.",
  failed:
    "The code could not be measured, so the size is the model's. Re-analyze to try again.",
};

/**
 * The assessment in a sentence or two, for a reader: where the points came
 * from and what band they fall in.
 */
export function describeRubric(assessment: RubricAssessment): string {
  const parts = assessment.dimensions
    .filter(({ measured }) => measured)
    .map(({ label, points }) => `${points} from ${label.toLowerCase()}`);
  const total = `${plural(assessment.points, "point")}: ${parts.join(", ")}.`;
  if (assessment.size === null)
    return `${total} ${UNSIZED[assessment.code.status]}`;
  const band = rubricBand(assessment.size);
  const range =
    band.to === null ? `${band.from} or more` : `${band.from} to ${band.to}`;
  const next =
    assessment.nextSizeIn === null
      ? ""
      : ` ${plural(assessment.nextSizeIn, "more point")} would make it ${rubricSize(assessment.points + assessment.nextSizeIn)}.`;
  return `${total} ${range} points is ${assessment.size}.${next}`;
}
