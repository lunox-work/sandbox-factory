import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessRubric,
  checksOf,
  COMPLEXITY_PROFILE_VERSION,
  CONTEXT_BANDS,
  describeRubric,
  PRICED_BOUNTY_COMPLEXITIES,
  RUBRIC_BANDS,
  RUBRIC_DIMENSIONS,
  RUBRIC_VERSION,
  rubricBand,
  rubricRules,
  rubricSize,
  type ComplexityProfile,
  type Scenario,
  type ScenarioStep,
  type SpecDraft,
} from "../src/index.js";

const step = (keyword: ScenarioStep["keyword"]): ScenarioStep => ({
  keyword,
  text: "a step",
});

function scenario(
  id: string,
  weight: Scenario["weight"],
  keywords: ScenarioStep["keyword"][],
): Scenario {
  return {
    id,
    kind: "happy",
    title: id,
    steps: keywords.map(step),
    origin: "draft",
    ...(weight === undefined ? {} : { weight }),
  };
}

/** The worked example's spec: three scenarios, five outcomes between them. */
const spec: SpecDraft = {
  feature: "Interview invitation delivery",
  background: ["a recruiter has scheduled an interview"],
  scenarios: [
    scenario("s1", "moderate", ["When", "Then", "And"]),
    scenario("s2", "heavy", ["Given", "When", "Then"]),
    scenario("s3", "moderate", ["When", "Then", "And"]),
  ],
  openQuestions: [],
  assumptions: ["Retries key on an idempotency token per interview."],
};

/** The worked example's code: two modules, one mock, a pattern to copy. */
const profile: ComplexityProfile = {
  version: COMPLEXITY_PROFILE_VERSION,
  slice: {
    files: 9,
    bytes: 53_000,
    modules: ["src/db", "src/mailer", "src/scheduler"],
    stubCoverage: "full",
    blockers: 0,
    ready: true,
  },
  touchedModules: ["src/mailer", "src/scheduler"],
  externals: { services: ["email"], environment: 2, seams: 1 },
  spec: {
    scenarios: 3,
    kinds: {
      happy: 2,
      boundary: 0,
      unhappy: 0,
      recovery: 1,
      permission: 0,
      concurrency: 0,
      "non-functional": 0,
    },
    openQuestions: 0,
    assumptions: 1,
  },
  tests: { files: 1, untestedModules: [] },
  pattern: { path: "src/mailer/offer.ts", reason: "retries idempotently" },
  nonFunctional: { scenarios: 0, migrations: false, ci: true },
  risks: [],
};

const measured = { status: "measured", profile, specRevision: 1 } as const;

const points = (
  assessment: ReturnType<typeof assessRubric>,
  dimension: string,
  factor: string,
) =>
  assessment.dimensions
    .find(({ id }) => id === dimension)
    ?.factors.find(({ id }) => id === factor)?.points;

test("the worked example scores 19 points, which is M", () => {
  const assessment = assessRubric({ spec, code: measured });
  assert.equal(assessment.version, RUBRIC_VERSION);
  assert.deepEqual(
    assessment.dimensions.map(({ id, points, measured }) => [
      id,
      points,
      measured,
    ]),
    [
      ["scenarios", 8, true],
      ["tests", 5, true],
      ["code", 6, true],
    ],
  );
  assert.equal(assessment.points, 19);
  assert.equal(assessment.size, "M");
  assert.equal(assessment.nextSizeIn, 2);
  assert.deepEqual(assessment.counts, {
    scenarios: 3,
    testCases: 3,
    checks: 5,
  });
  assert.deepEqual(assessment.code, { status: "measured", specRevision: 1 });
  assert.deepEqual(assessment.weightPoints, {
    light: 1,
    moderate: 2,
    heavy: 4,
  });
  assert.equal(
    describeRubric(assessment),
    "19 points: 8 from scenarios, 5 from test cases, 6 from code. 15 to 20 points is M. 2 more points would make it M+.",
  );
});

test("every code factor names its evidence and scores by its rule", () => {
  const assessment = assessRubric({ spec, code: measured });
  const code = assessment.dimensions.find(({ id }) => id === "code");
  assert.deepEqual(
    code?.factors.map(({ id, evidence, points }) => [id, evidence, points]),
    [
      ["context", "9 files, 52 KB", 2],
      ["modules", "2: src/mailer, src/scheduler", 3],
      ["services", "1: email", 2],
      ["seams", "1 seam", 1],
      ["untested", "None", 0],
      ["migrations", "None", 0],
      ["stubs", "Full", 0],
      ["blockers", "None", 0],
      ["pattern", "src/mailer/offer.ts", -2],
    ],
  );

  const heavy = assessRubric({
    spec,
    code: {
      status: "measured",
      specRevision: 2,
      profile: {
        ...profile,
        slice: {
          ...profile.slice,
          bytes: 400 * 1024,
          stubCoverage: "names-only",
          blockers: 2,
        },
        touchedModules: ["a", "b", "c"],
        externals: { services: [], environment: 0, seams: 0 },
        tests: { files: 0, untestedModules: ["a", "b"] },
        pattern: null,
        nonFunctional: { scenarios: 0, migrations: true, ci: false },
      },
    },
  });
  const factors = heavy.dimensions.find(({ id }) => id === "code")?.factors;
  assert.deepEqual(
    factors?.map(({ id, evidence, points }) => [id, evidence, points]),
    [
      ["context", "9 files, 400 KB", CONTEXT_BANDS.beyond],
      ["modules", "3: a, b, c", 6],
      ["services", "None", 0],
      ["seams", "None", 0],
      ["untested", "2: a, b", 4],
      ["migrations", "In a touched module", 4],
      ["stubs", "Names only", 2],
      ["blockers", "2 blockers", 4],
      ["pattern", "None found", 0],
    ],
  );
  assert.equal(heavy.code.specRevision, 2);
});

test("the slice's size scores by the context bands", () => {
  const sized = (bytes: number) =>
    points(
      assessRubric({
        spec,
        code: {
          ...measured,
          profile: { ...profile, slice: { ...profile.slice, bytes } },
        },
      }),
      "code",
      "context",
    );
  assert.equal(sized(0), 0);
  assert.equal(sized(16 * 1024 - 1), 0);
  assert.equal(sized(16 * 1024), 1);
  assert.equal(sized(48 * 1024), 2);
  assert.equal(sized(128 * 1024), 4);
  assert.equal(sized(320 * 1024), 6);
});

test("a discount can empty the code dimension but not take it below zero", () => {
  const small = assessRubric({
    spec,
    code: {
      ...measured,
      profile: {
        ...profile,
        slice: { ...profile.slice, bytes: 1_000 },
        touchedModules: ["src/mailer"],
        externals: { services: [], environment: 0, seams: 0 },
      },
    },
  });
  const code = small.dimensions.find(({ id }) => id === "code");
  assert.equal(points(small, "code", "pattern"), -2);
  assert.equal(code?.points, 0);
  assert.equal(small.points, 13);
});

test("without measured code the rubric scores the spec but has no size", () => {
  for (const status of ["pending", "unavailable", "failed"] as const) {
    const assessment = assessRubric({ spec, code: { status } });
    const code = assessment.dimensions.find(({ id }) => id === "code");
    assert.deepEqual(code, {
      id: "code",
      label: "Code",
      points: 0,
      measured: false,
      factors: [],
    });
    assert.equal(assessment.points, 13);
    assert.equal(assessment.size, null);
    assert.equal(assessment.nextSizeIn, null);
    assert.deepEqual(assessment.code, { status, specRevision: null });
    assert.match(
      describeRubric(assessment),
      /^13 points: 8 from scenarios, 5 from test cases\. /,
    );
    assert.match(describeRubric(assessment), /the model's/);
  }
});

test("scenarios score by weight, unweighed ones as moderate, and open questions add", () => {
  const assessment = assessRubric({
    spec: {
      scenarios: [
        scenario("s1", "light", ["Then"]),
        scenario("s2", undefined, ["Then"]),
        scenario("s3", undefined, ["Then"]),
      ],
      openQuestions: ["Which timezone?", "Who is copied?"],
    },
    code: { status: "pending" },
    weightPoints: { light: 3, moderate: 5, heavy: 0 },
  });
  const scenarios = assessment.dimensions.find(({ id }) => id === "scenarios");
  assert.deepEqual(
    scenarios?.factors.map(({ id, evidence, points }) => [
      id,
      evidence,
      points,
    ]),
    [
      ["weight-light", "1 × 3", 3],
      ["weight-moderate", "0 × 5", 0],
      ["weight-heavy", "0 × 0", 0],
      ["unweighed", "2 × 5, counted as moderate", 10],
      ["open-questions", "2 questions", 2],
    ],
  );
  assert.equal(scenarios?.points, 15);
  assert.deepEqual(assessment.weightPoints, {
    light: 3,
    moderate: 5,
    heavy: 0,
  });

  const one = assessRubric({
    spec: { scenarios: [], openQuestions: ["Why?"] },
    code: { status: "pending" },
  });
  assert.equal(points(one, "scenarios", "open-questions"), 1);
  assert.equal(
    one.dimensions.find(({ id }) => id === "scenarios")?.factors.at(-1)
      ?.evidence,
    "1 question",
  );
});

test("a test case is one per scenario, and its checks are its outcome steps", () => {
  assert.equal(checksOf({ steps: [] }), 0);
  assert.equal(
    checksOf({ steps: ["Given", "When"].map((k) => step(k as "Given")) }),
    0,
  );
  assert.equal(
    checksOf({ steps: [step("Given"), step("And"), step("When")] }),
    0,
  );
  assert.equal(
    checksOf({ steps: [step("When"), step("Then"), step("And"), step("But")] }),
    3,
  );
  // An outcome ends at the next action: a second When starts again.
  assert.equal(
    checksOf({
      steps: [
        step("When"),
        step("Then"),
        step("When"),
        step("And"),
        step("Then"),
      ],
    }),
    2,
  );

  const assessment = assessRubric({
    spec: {
      scenarios: [
        scenario("s1", "light", ["Given", "When"]),
        scenario("s2", "light", ["Then", "And", "And"]),
      ],
      openQuestions: [],
    },
    code: { status: "unavailable" },
  });
  const tests = assessment.dimensions.find(({ id }) => id === "tests");
  assert.deepEqual(
    tests?.factors.map(({ id, evidence, points }) => [id, evidence, points]),
    [
      ["test-cases", "2 scenarios, one test each", 2],
      ["extra-checks", "3 outcomes checked in all", 2],
    ],
  );
  assert.deepEqual(assessment.counts, {
    scenarios: 2,
    testCases: 2,
    checks: 3,
  });
  const single = assessRubric({
    spec: { scenarios: [scenario("s1", "light", ["Then"])], openQuestions: [] },
    code: { status: "unavailable" },
  });
  assert.equal(
    single.dimensions.find(({ id }) => id === "tests")?.factors[0]?.evidence,
    "1 scenario, one test each",
  );
  assert.match(
    describeRubric(single),
    /^2 points: 1 from scenarios, 1 from test cases\. /,
  );
});

test("the bands cover every priced size in order, and each size has its range", () => {
  assert.deepEqual(
    RUBRIC_BANDS.map(({ size }) => size),
    [...PRICED_BOUNTY_COMPLEXITIES],
  );
  for (let index = 1; index < RUBRIC_BANDS.length; index += 1)
    assert.ok(
      (RUBRIC_BANDS[index]?.from ?? 0) > (RUBRIC_BANDS[index - 1]?.from ?? 0),
    );
  assert.equal(rubricSize(0), "XS");
  assert.equal(rubricSize(3), "XS");
  assert.equal(rubricSize(4), "XS+");
  assert.equal(rubricSize(20), "M");
  assert.equal(rubricSize(21), "M+");
  assert.equal(rubricSize(500), "XL");
  assert.deepEqual(rubricBand("XS"), { from: 0, to: 3 });
  assert.deepEqual(rubricBand("M"), { from: 15, to: 20 });
  assert.deepEqual(rubricBand("XL"), { from: 48, to: null });
});

test("at XL there is no next size, and the sentence says so", () => {
  const big = assessRubric({
    spec: {
      scenarios: Array.from({ length: 12 }, (_, index) =>
        scenario(`s${index}`, "heavy", ["Then"]),
      ),
      openQuestions: [],
    },
    code: measured,
  });
  assert.equal(big.size, "XL");
  assert.equal(big.nextSizeIn, null);
  assert.match(describeRubric(big), /48 or more points is XL\.$/);
});

test("the rules name every factor an assessment can carry, written from the numbers", () => {
  const rules = rubricRules();
  const ids = new Set(rules.map(({ id }) => id));
  const assessment = assessRubric({ spec, code: measured });
  for (const { factors } of assessment.dimensions)
    for (const factor of factors) assert.ok(ids.has(factor.id), factor.id);
  for (const rule of rules) {
    assert.ok(RUBRIC_DIMENSIONS.some(({ id }) => id === rule.dimension));
    assert.notEqual(rule.scoring, "");
    assert.notEqual(rule.why, "");
  }
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  assert.equal(byId.get("weight-heavy")?.scoring, "4 each");
  assert.equal(
    rubricRules({ light: 1, moderate: 2, heavy: 9 })[2]?.scoring,
    "9 each",
  );
  assert.equal(byId.get("pattern")?.scoring, "-2 when one exists");
  assert.equal(
    byId.get("migrations")?.scoring,
    "+4 when a touched module holds them",
  );
  assert.equal(
    byId.get("context")?.scoring,
    "under 16 KB 0, under 48 KB 1, under 128 KB 2, under 320 KB 4, 320 KB or more 6",
  );
});
