/**
 * How much work a scenario adds to its bounty.
 *
 * Every scenario carries a weight, the drafting model's judgement made in
 * the same call that wrote the scenario. A judgement, not a fact: it is
 * made without the repository. What makes it usable is that it is cheap
 * (the model has just written the scenario) and reviewable (the reason
 * sits beside the scenario in the Scenarios tab).
 *
 * **This file is the rubric, and it is meant to be edited.** The draft
 * prompt reads `SCENARIO_WEIGHT_DEFINITIONS`, so a change to what a weight
 * covers reaches the model with no change elsewhere. A weight's `id` is
 * stored on every scenario, so renaming one orphans the scenarios that
 * carry it; `label` and `covers` are free to change. The points a weight
 * is worth are the step's to decide, and a board can override them
 * (`pricing/step`).
 */

import type { Scenario, SpecDraft } from "./spec.js";

export interface ScenarioWeightDefinition {
  /** Stable, stored. */
  readonly id: string;
  /** What a person sees on the badge. */
  readonly label: string;
  /** What makes a scenario this weight, for the model and for the reader. */
  readonly covers: string;
  /**
   * Whether a scenario of this weight becomes an acceptance test of its
   * own, which the rubric counts (`rubric.ts`). A covered scenario is one
   * more assertion inside a test another scenario already needs.
   */
  readonly ownTest: boolean;
}

/**
 * Lightest first, which is the order a reader compares them in.
 *
 * `covered` is the weight that adds nothing: behaviour the other
 * scenarios' code already has, proven by one more assertion in a test
 * they already need. It exists so a small bounty can stay small: without
 * it every scenario the draft wrote to be exhaustive cost at least a
 * point and a test, and a four-scenario spec could never be XS.
 */
export const SCENARIO_WEIGHT_DEFINITIONS = [
  {
    id: "covered",
    label: "Covered",
    covers:
      "no code of its own: behaviour the other scenarios' code already has, checked by one more assertion in a test they already need",
    ownTest: false,
  },
  {
    id: "light",
    label: "Light",
    covers:
      "a small change inside code the other scenarios already exercise: a copy change, a guard clause, a default",
    ownTest: true,
  },
  {
    id: "moderate",
    label: "Moderate",
    covers:
      "its own branch or state: a new validation, a new error path, a new query",
    ownTest: true,
  },
  {
    id: "heavy",
    label: "Heavy",
    covers:
      "its own mechanism: a new integration, a job, a migration, a concurrency or recovery path that needs infrastructure to test",
    ownTest: true,
  },
] as const satisfies readonly ScenarioWeightDefinition[];

export type ScenarioWeight = (typeof SCENARIO_WEIGHT_DEFINITIONS)[number]["id"];

/** The weight ids alone, lightest first, as a tuple a schema can take. */
export const SCENARIO_WEIGHTS = SCENARIO_WEIGHT_DEFINITIONS.map(
  ({ id }) => id,
) as unknown as readonly [ScenarioWeight, ...ScenarioWeight[]];

/** How long a weight's reason may be: one short phrase. */
export const WEIGHT_REASON_CHARS = 120;

/**
 * Whether a scenario of this weight is a test of its own. A scenario with
 * no weight, or with one this registry no longer has, is counted as
 * moderate elsewhere, and so has one.
 */
export function hasOwnTest(weight: string | undefined): boolean {
  return (
    SCENARIO_WEIGHT_DEFINITIONS.find(({ id }) => id === weight)?.ownTest ?? true
  );
}

/**
 * What each weight counts for, by default. With the step's default of four
 * points a half size, a heavy scenario is a half step on its own, two
 * moderate ones are, and four light ones are. A covered scenario moves
 * nothing.
 */
export const WEIGHT_POINTS: Readonly<Record<ScenarioWeight, number>> = {
  covered: 0,
  light: 1,
  moderate: 2,
  heavy: 4,
};

/**
 * The points these scenarios add up to, or null when any of them has no
 * weight: a spec drafted before weights existed (`draft-v1`) cannot be
 * counted, and counting it as zero would make every scenario a later
 * revision added look like growth.
 *
 * A weight this registry no longer has counts as unweighed, for the same
 * reason a retired kind is left out of `countScenarios`.
 */
export function pointsOfScenarios(
  scenarios: readonly Scenario[],
  points: Readonly<Record<ScenarioWeight, number>> = WEIGHT_POINTS,
): number | null {
  let total = 0;
  for (const { weight } of scenarios) {
    if (weight === undefined || !Object.hasOwn(points, weight)) return null;
    total += points[weight];
  }
  return total;
}

/**
 * Points for every weight this registry has: `WEIGHT_POINTS` under a
 * stored table, which may predate a weight. A step or an assessment stored
 * before `covered` existed names three weights; a spec revised since may
 * carry the fourth, and it counts for its default rather than making the
 * spec unweighed.
 */
export function withDefaultWeights(
  points: Readonly<Partial<Record<ScenarioWeight, number>>> | undefined,
): Readonly<Record<ScenarioWeight, number>> {
  return { ...WEIGHT_POINTS, ...points };
}

/** The points a whole spec adds up to; see `pointsOfScenarios`. */
export function pointsOf(
  draft: SpecDraft,
  points: Readonly<Record<ScenarioWeight, number>> = WEIGHT_POINTS,
): number | null {
  return pointsOfScenarios(draft.scenarios, points);
}
