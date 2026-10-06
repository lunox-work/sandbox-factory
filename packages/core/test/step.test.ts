import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_STEP_SETTINGS,
  halfStepsUp,
  nextHalfStep,
  pointsOf,
  pointsOfScenarios,
  rebaseStep,
  resetStep,
  resolveStepSettings,
  SCENARIO_WEIGHT_DEFINITIONS,
  SCENARIO_WEIGHTS,
  STEP_VERSION,
  stepUp,
  WEIGHT_POINTS,
  type Scenario,
  type ScenarioWeight,
  type SpecDraft,
  type StepSettings,
  type WholeComplexity,
} from "../src/index.js";

function scenario(
  id: string,
  weight: ScenarioWeight | undefined,
  overrides: Partial<Scenario> = {},
): Scenario {
  return {
    id,
    kind: "happy",
    title: `Scenario ${id}`,
    steps: [{ keyword: "Then", text: "it works" }],
    origin: "draft",
    ...(weight === undefined ? {} : { weight }),
    ...overrides,
  };
}

function spec(...scenarios: Scenario[]): SpecDraft {
  return {
    feature: "Invitations",
    background: [],
    scenarios,
    openQuestions: [],
    assumptions: [],
  };
}

/** The sized draft every case below grows from: 1 + 2 = 3 points. */
const sized = spec(scenario("s1", "light"), scenario("s2", "moderate"));

/** The sized draft with these scenarios added, as an expansion would. */
function grown(...weights: ScenarioWeight[]): SpecDraft {
  return spec(
    ...sized.scenarios,
    ...weights.map((weight, index) =>
      scenario(`s${index + 3}`, weight, {
        title: `Added ${index + 1}`,
        origin: "expansion",
      }),
    ),
  );
}

test("the weights are one registry, lightest first, with a rubric the prompt can read", () => {
  assert.deepEqual(SCENARIO_WEIGHTS, ["light", "moderate", "heavy"]);
  for (const { id, label, covers } of SCENARIO_WEIGHT_DEFINITIONS) {
    assert.match(id, /^[a-z]+$/);
    assert.notEqual(label, "");
    assert.notEqual(covers, "");
  }
  assert.deepEqual(WEIGHT_POINTS, { light: 1, moderate: 2, heavy: 4 });
});

test("a spec's points are its weights summed, and null when one is missing", () => {
  assert.equal(pointsOf(sized), 3);
  assert.equal(pointsOf(spec()), 0);
  assert.equal(pointsOf(sized, { light: 5, moderate: 0, heavy: 1 }), 5);
  // Drafted before weights: not countable, rather than counted as nothing.
  assert.equal(pointsOf(spec(scenario("s1", undefined))), null);
  assert.equal(
    pointsOfScenarios([scenario("s1", "heavy"), scenario("s2", undefined)]),
    null,
  );
  // A weight the rubric has since dropped is unweighed too.
  assert.equal(
    pointsOf(
      spec(scenario("s1", "light"), {
        ...scenario("s2", "light"),
        weight: "retired" as ScenarioWeight,
      }),
    ),
    null,
  );
});

test("the half-size order moves up and stops at XL", () => {
  assert.equal(halfStepsUp("S", 0), "S");
  assert.equal(halfStepsUp("S", 1), "S+");
  assert.equal(halfStepsUp("S", 2), "M");
  assert.equal(halfStepsUp("XS", 8), "XL");
  assert.equal(halfStepsUp("L", 5), "XL");
  assert.equal(halfStepsUp("M", -2), "M");
  assert.equal(nextHalfStep("S+"), "M");
  assert.equal(nextHalfStep("L+"), "XL");
  assert.equal(nextHalfStep("XL"), null);
});

/**
 * The step eval: (base, sized revision, current revision, settings) →
 * size, half steps and points to the next one. Each row is a case the
 * plan names; the defaults are four points a half step.
 */
const table: readonly {
  readonly name: string;
  readonly base: WholeComplexity;
  readonly current: SpecDraft;
  readonly settings?: StepSettings;
  readonly complexity: string;
  readonly steps: number;
  readonly addedPoints: number;
  readonly nextStepIn: number | null;
}[] = [
  {
    name: "a fresh draft is a step of zero",
    base: "S",
    current: sized,
    complexity: "S",
    steps: 0,
    addedPoints: 0,
    nextStepIn: 4,
  },
  {
    name: "light weight short of a half step names what is still needed",
    base: "S",
    current: grown("light", "light", "light"),
    complexity: "S",
    steps: 0,
    addedPoints: 3,
    nextStepIn: 1,
  },
  {
    name: "one heavy scenario is a half step",
    base: "S",
    current: grown("heavy"),
    complexity: "S+",
    steps: 1,
    addedPoints: 4,
    nextStepIn: 4,
  },
  {
    name: "two moderate scenarios are a half step",
    base: "M",
    current: grown("moderate", "moderate"),
    complexity: "M+",
    steps: 1,
    addedPoints: 4,
    nextStepIn: 4,
  },
  {
    name: "four light scenarios are a half step",
    base: "XS",
    current: grown("light", "light", "light", "light"),
    complexity: "XS+",
    steps: 1,
    addedPoints: 4,
    nextStepIn: 4,
  },
  {
    name: "a heavy and a light: one half step, three points to the next",
    base: "S",
    current: grown("heavy", "light"),
    complexity: "S+",
    steps: 1,
    addedPoints: 5,
    nextStepIn: 3,
  },
  {
    name: "two half steps make a whole size",
    base: "S",
    current: grown("heavy", "heavy"),
    complexity: "M",
    steps: 2,
    addedPoints: 8,
    nextStepIn: 4,
  },
  {
    name: "the XL cap stops the climb and there is no next step",
    base: "L",
    current: grown("heavy", "heavy", "heavy", "heavy"),
    complexity: "XL",
    steps: 2,
    addedPoints: 16,
    nextStepIn: null,
  },
  {
    name: "landing exactly on XL has no next step either",
    base: "L",
    current: grown("heavy", "heavy"),
    complexity: "XL",
    steps: 2,
    addedPoints: 8,
    nextStepIn: null,
  },
  {
    name: "a base already at XL cannot move",
    base: "XL",
    current: grown("heavy"),
    complexity: "XL",
    steps: 0,
    addedPoints: 4,
    nextStepIn: null,
  },
  {
    name: "a trim of a draft scenario does not go below the base",
    base: "M",
    current: spec(scenario("s1", "light")),
    complexity: "M",
    steps: 0,
    addedPoints: 0,
    nextStepIn: 4,
  },
  {
    name: "a swap of equal weight moves nothing",
    base: "M",
    current: spec(
      scenario("s1", "light"),
      scenario("s3", "moderate", { title: "Something else" }),
    ),
    complexity: "M",
    steps: 0,
    addedPoints: 0,
    nextStepIn: 4,
  },
  {
    name: "a rewrite from light to heavy counts the growth",
    base: "S",
    current: spec(scenario("s1", "heavy"), scenario("s2", "moderate")),
    complexity: "S",
    steps: 0,
    addedPoints: 3,
    nextStepIn: 1,
  },
  {
    name: "a board's settings change the arithmetic",
    base: "S",
    current: grown("light", "light"),
    settings: resolveStepSettings({
      pointsPerStep: 2,
      weightPoints: { light: 1 },
    }),
    complexity: "S+",
    steps: 1,
    addedPoints: 2,
    nextStepIn: 2,
  },
];

for (const row of table) {
  test(`step: ${row.name}`, () => {
    const result = stepUp(row.base, sized, row.current, row.settings);
    assert.ok(result !== null);
    assert.equal(result.base, row.base);
    assert.equal(result.complexity, row.complexity);
    assert.equal(result.steps, row.steps);
    assert.equal(result.addedPoints, row.addedPoints);
    assert.equal(result.nextStepIn, row.nextStepIn);
    assert.equal(result.stepVersion, STEP_VERSION);
    assert.deepEqual(result.settings, row.settings ?? DEFAULT_STEP_SETTINGS);
  });
}

test("the step lists the scenarios behind the points, by title and kind", () => {
  const result = stepUp("S", sized, grown("heavy", "light"));
  assert.deepEqual(result?.added, [
    { id: "s3", kind: "happy", title: "Added 1", weight: "heavy" },
    { id: "s4", kind: "happy", title: "Added 2", weight: "light" },
  ]);
  // The same title under the same kind is the same scenario, whatever its
  // id, spacing or case: a revision renumbers, and a rewrite is not new.
  const renumbered = stepUp(
    "S",
    sized,
    spec(
      scenario("s9", "light", { title: "  scenario   S1 " }),
      scenario("s2", "moderate", { kind: "boundary" }),
    ),
  );
  assert.deepEqual(
    renumbered?.added.map(({ id }) => id),
    ["s2"],
  );
});

test("the step lists the scenarios trimmed since sizing", () => {
  const trimmed = stepUp("S", sized, spec(scenario("s2", "moderate")));
  assert.deepEqual(trimmed?.removed, [
    { id: "s1", kind: "happy", title: "Scenario s1", weight: "light" },
  ]);
  assert.deepEqual(trimmed?.added, []);
  assert.deepEqual(stepUp("S", sized, sized)?.removed, []);
});

test("a revision drafted before weights has no step", () => {
  const weightless = spec(scenario("s1", undefined), scenario("s2", undefined));
  assert.equal(stepUp("S", weightless, weightless), null);
  assert.equal(stepUp("S", sized, weightless), null);
  assert.equal(stepUp("S", weightless, grown("heavy")), null);
});

test("a resize rebases the step: the added weight stays, the base moves", () => {
  const step = stepUp("S", sized, grown("heavy", "light"));
  assert.ok(step !== null);
  const rebased = rebaseStep(step, "L");
  assert.equal(rebased.base, "L");
  assert.equal(rebased.complexity, "L+");
  assert.equal(rebased.addedPoints, 5);
  assert.deepEqual(rebased.added, step.added);
  assert.equal(rebased.nextStepIn, 3);
  assert.equal(rebaseStep(step, "XL").nextStepIn, null);
  // Counted with the settings it was computed with, not today's defaults.
  const coarse = stepUp(
    "S",
    sized,
    grown("heavy"),
    resolveStepSettings({ pointsPerStep: 8 }),
  );
  assert.ok(coarse !== null);
  assert.equal(rebaseStep(coarse, "M").complexity, "M");
  assert.equal(rebaseStep(coarse, "M").nextStepIn, 4);
});

test("a resize resets the step: the size chosen is the size, counted from its revision", () => {
  const coarse = resolveStepSettings({ pointsPerStep: 8 });
  const step = stepUp("S", sized, grown("heavy", "light"), coarse);
  assert.ok(step !== null);
  const reset = resetStep(step, "M", 3);
  assert.equal(reset.base, "M");
  assert.equal(reset.complexity, "M");
  assert.equal(reset.steps, 0);
  assert.equal(reset.addedPoints, 0);
  assert.deepEqual(reset.added, []);
  assert.deepEqual(reset.removed, []);
  assert.equal(reset.baseRevision, 3);
  // Kept with the settings it was computed with.
  assert.deepEqual(reset.settings, coarse);
  assert.equal(reset.nextStepIn, 8);
  assert.equal(resetStep(step, "XL", 3).nextStepIn, null);
});

test("a board's step settings lie over the defaults, and nonsense is ignored", () => {
  assert.deepEqual(resolveStepSettings(), DEFAULT_STEP_SETTINGS);
  assert.deepEqual(
    resolveStepSettings({
      pointsPerStep: 6,
      weightPoints: { heavy: 5, light: 0 },
    }),
    { pointsPerStep: 6, weightPoints: { light: 0, moderate: 2, heavy: 5 } },
  );
  for (const pointsPerStep of [0, -1, 1.5, 1_001, Number.NaN, null]) {
    assert.equal(
      resolveStepSettings({ pointsPerStep }).pointsPerStep,
      DEFAULT_STEP_SETTINGS.pointsPerStep,
    );
  }
  const weightPoints = Object.create({ heavy: 9 }) as Record<string, number>;
  weightPoints["moderate"] = -1;
  weightPoints["retired"] = 3;
  assert.deepEqual(
    resolveStepSettings({ weightPoints }).weightPoints,
    WEIGHT_POINTS,
  );
});
